import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { inflateRawSync } from "node:zlib";
//#region src/loopback.ts
/** IPv4 127/8 predicate (four decimal octets, first == 127). */
function isIPv4Loopback(v4) {
	const parts = v4.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
/** Whether a socket remote address names the loopback range (127/8, ::1, IPv4-mapped). */
function isLoopbackAddress(address) {
	if (address === void 0) return false;
	const normalized = address.toLowerCase();
	if (normalized === "::1") return true;
	if (normalized.startsWith("::ffff:")) return isIPv4Loopback(normalized.slice(7));
	return isIPv4Loopback(normalized);
}
/** Whether a normalized URL hostname names the loopback authority (localhost, [::1], 127/8). */
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	return isIPv4Loopback(hostname);
}
/**
* Whether a reverse proxy stood between the client and this host: the request
* carries CF-Connecting-IP or X-Forwarded-For. Either header is stamped by a
* hop that forwards traffic, so the request did not originate on this machine.
* @param request - node HTTP request.
* @returns true when a forwarding header is present.
*/
function isProxiedRequest(request) {
	return request.headers["cf-connecting-ip"] !== void 0 || request.headers["x-forwarded-for"] !== void 0;
}
/**
* Request-level trust fence: a loopback socket address AND a loopback Host
* header, plus browser same-origin markers. The socket address is
* authoritative for a direct connection; a request that carries a forwarding
* header is refused outright, because a proxy in front of the host makes both
* the socket address and the Host header describe the proxy rather than the
* client. X-Forwarded-For is therefore never evidence *for* loopback.
*/
function isLoopbackRequest(request) {
	if (!isLoopbackAddress(request.socket.remoteAddress)) return false;
	if (isProxiedRequest(request)) return false;
	const host = request.headers.host;
	if (typeof host !== "string") return false;
	let hostUrl;
	try {
		hostUrl = new URL("http://" + host);
	} catch {
		return false;
	}
	if (!isLoopbackHostname(hostUrl.hostname)) return false;
	if (request.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = request.headers.origin;
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
//#endregion
//#region src/pair-access.ts
/**
* Whether this request may enter the plugin's host routes.
* @param ctx - host context; may expose remoteWebUiPairing.
* @param request - the incoming HTTP request.
* @returns true for loopback, or a live paired-device cookie.
*/
function isPairedOrLoopbackAllowed(ctx, request) {
	if (isLoopbackRequest(request)) return true;
	return lookupPairing(ctx)?.isPairedDevice(request) === true;
}
/**
* The pairing service, or undefined when this composition does not expose it.
*
* Two lookups exist because the fence is shared with test harnesses that hand
* over a bare object: a real cordis context resolves services through `get`, a
* harness may carry the property directly. `get(name, false)` is the
* non-strict form, so an unloaded service answers undefined rather than
* throwing. Reading an un-injected service as a PROPERTY throws instead
* (`cannot get property "remoteWebUiPairing" without inject`); a trust fence
* must answer "not paired" in that case, never leak the error into the route
* handler, where the host web server turns it into an empty-body 400 (#1942).
*/
function lookupPairing(ctx) {
	if (typeof ctx.get === "function") {
		const viaGet = ctx.get("remoteWebUiPairing", false);
		return isPairingAccess(viaGet) ? viaGet : void 0;
	}
	try {
		const viaProperty = ctx.remoteWebUiPairing;
		return isPairingAccess(viaProperty) ? viaProperty : void 0;
	} catch {
		return;
	}
}
function isPairingAccess(value) {
	return value !== void 0 && value !== null && typeof value.isPairedDevice === "function";
}
//#endregion
//#region src/access.ts
/**
* Resolve the optional host `connection` service without requiring injection.
* @param ctx - host context that may expose `connection`.
* @returns the service when present and shaped, or undefined.
*/
function resolveConnection(ctx) {
	try {
		const candidate = typeof ctx.get === "function" ? ctx.get("connection", false) ?? ctx.get("connection") : ctx.connection;
		return candidate !== void 0 && candidate !== null && typeof candidate.requestRejection === "function" ? candidate : void 0;
	} catch {
		return;
	}
}
/**
* Whether this request may enter any /api/dsh-skill-explorer route.
* @param ctx - host context; may expose remoteWebUiPairing or connection.
* @param request - the incoming HTTP request.
* @returns true for loopback, a live paired-device cookie, or an admitted host connection.
*/
function isSkillExplorerAllowed(ctx, request) {
	const connection = resolveConnection(ctx);
	if (connection !== void 0 && connection.requestRejection?.(request) === void 0) return true;
	return isPairedOrLoopbackAllowed(ctx, request);
}
//#endregion
//#region src/frontmatter.ts
/**
* SKILL.md frontmatter lightweight parsing and rewriting (zero dependency).
*
* Ported from the local plugin family's shared implementation; the official
* dsh-skill-filesystem provider parses frontmatter with its own stack, so
* this module keeps a stable export surface for unit tests to lock behavior.
*/
/** Parse a YAML boolean (true/false/yes/no/on/off/1/0, case-insensitive); undefined when not boolean. */
function parseYamlBool(value) {
	const text = String(value).toLowerCase();
	if ([
		"true",
		"yes",
		"on",
		"1"
	].includes(text)) return true;
	if ([
		"false",
		"no",
		"off",
		"0"
	].includes(text)) return false;
}
/** Strip single or double quotes around a scalar value. */
function unquote(value) {
	if (value.length >= 2 && (value.startsWith("\"") && value.endsWith("\"") || value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
	return value;
}
/**
* Parse scalar fields from the leading frontmatter block (lightweight, zero
* dependency). Supports name/description/whenToUse (including | / > block
* scalars), the input nested block (hint / recordInput) and the
* disable-model-invocation / user-invocable booleans.
* @param content - raw SKILL.md content.
* @returns parsed fields (empty object when no frontmatter).
*/
function parseFrontmatter(content) {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
	if (match === null) return {};
	const out = {};
	const lines = match[1].split(/\r?\n/);
	for (let i = 0; i < lines.length; i += 1) {
		const kv = /^([a-zA-Z][\w-]*):\s*(.*)$/.exec(lines[i]);
		if (kv === null) continue;
		const key = kv[1];
		const rest = kv[2].trim();
		if (key === "input" && rest === "") {
			const nested = {};
			for (let j = i + 1; j < lines.length; j += 1) {
				const line = lines[j];
				const sub = /^\s+([a-zA-Z][\w-]*):\s*(.*)$/.exec(line);
				if (sub === null) {
					if (line.trim() === "") continue;
					break;
				}
				const subKey = sub[1];
				const subValue = sub[2].trim();
				if (subKey === "hint") nested.hint = unquote(subValue);
				else if (subKey === "recordInput") nested.recordInput = parseYamlBool(subValue);
			}
			if (nested.hint !== void 0) out.hint = nested.hint;
			if (nested.recordInput !== void 0) out.recordInput = nested.recordInput;
			continue;
		}
		if (rest === "") continue;
		if (/^[|>][-+]?$/.test(rest)) {
			const collected = [];
			for (let j = i + 1; j < lines.length; j += 1) {
				const line = lines[j];
				if (line === "" || /^\s/.test(line)) collected.push(line.trim());
				else break;
			}
			const text = collected.join(" ").trim();
			if (key === "name") out.name = text || void 0;
			else if (key === "description") out.description = text || void 0;
			else if (key === "whenToUse") out.whenToUse = text || void 0;
			continue;
		}
		if (key === "name") out.name = unquote(rest);
		else if (key === "description") out.description = unquote(rest);
		else if (key === "whenToUse") out.whenToUse = unquote(rest);
		else if (key === "disable-model-invocation") out.disableModelInvocation = parseYamlBool(rest);
		else if (key === "user-invocable") out.userInvocable = parseYamlBool(rest);
		else if (key === "recordInput") out.recordInput = parseYamlBool(rest);
	}
	return out;
}
/**
* The body after the leading frontmatter block, verbatim.
* @param content - raw SKILL.md content.
* @returns the content after the closing fence (the whole input when absent).
*/
function stripFrontmatter(content) {
	const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(content);
	return match === null ? content : content.slice(match[0].length);
}
/**
* Rewrite one boolean frontmatter field (appends when absent), atomically.
* Preserves every other line and the body verbatim.
* @param file - absolute SKILL.md path.
* @param field - frontmatter field name (e.g. disable-model-invocation).
* @param value - target boolean value.
* @returns the parsed frontmatter of the rewritten content.
*/
function setFrontmatterField(file, field, value) {
	const content = readFileSync(file, "utf8");
	const match = /^---\r?\n([\s\S]*?)\r?\n---([\s\S]*)$/.exec(content);
	if (match === null) throw new Error(`setFrontmatterField: ${file} has no frontmatter`);
	const blockLines = match[1].split(/\r?\n/);
	const linePattern = new RegExp(`^${field}:`);
	let replaced = false;
	const next = blockLines.map((line) => {
		if (linePattern.test(line)) {
			replaced = true;
			return `${field}: ${value}`;
		}
		return line;
	});
	if (!replaced) next.push(`${field}: ${value}`);
	const rewritten = `---\n${next.join("\n")}\n---${match[2]}`;
	const tmp = `${file}.${Date.now().toString(36)}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		writeFileSync(tmp, rewritten, {
			encoding: "utf8",
			flag: "wx"
		});
		renameSync(tmp, file);
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch {}
		throw error;
	}
	return parseFrontmatter(rewritten);
}
//#endregion
//#region src/collect.ts
/**
* Skill collection: filesystem scanning (primary) plus registry supplement.
*
* The web profile mounts the skill-filesystem provider only at the agent
* preset scope layer, so the host plane cannot read project/user skills from
* ctx.skills — the list route scans the official root conventions itself and
* merges registry entries (bundled / runtime) by name. Because that scan is
* what supplies an editable path, the custom roots the provider was actually
* configured with are read back off the live loader rows
* (customSkillDirsFromLoader) and scanned alongside this plugin's own
* customSkillDirs; otherwise the registry's custom-source entries would be
* listed with no path and no way to manage them.
*/
/** Source levels produced by filesystem scanning (registry sources map to the same set). */
const SOURCE_GROUPS = [
	{
		key: "bundled",
		title: "System bundled",
		hint: "Global skills shipped with DSH and its plugins"
	},
	{
		key: "project-dsh",
		title: "Project skills (.dsh/skills)",
		hint: "Located in the project directory, scoped to its workspace"
	},
	{
		key: "project-agents",
		title: "Project skills (.agents/skills)",
		hint: "Located in the project directory, scoped to its workspace"
	},
	{
		key: "custom",
		title: "Custom directories",
		hint: "customSkillDirs config"
	},
	{
		key: "user-dsh",
		title: "User skills (~/.dsh/skills)",
		hint: "Global skills shared by all projects on this machine"
	},
	{
		key: "user-agents",
		title: "User skills (~/.agents/skills)",
		hint: "Global skills shared by all projects on this machine"
	},
	{
		key: "runtime",
		title: "Runtime registered",
		hint: "Skills registered at runtime by plugins"
	}
];
/** Registry source -> display level mapping (unlisted sources fall into "other"). */
const REGISTRY_SOURCE_LEVEL = new Map(SOURCE_GROUPS.map((group) => [group.key, group.key]));
/**
* The official skill-name grammar.
*
* One definition serves both this scan and the write routes, so a name the
* panel accepts is one the official registry loads: lowercase alphanumeric
* segments joined by single hyphens, never a leading, trailing or doubled
* hyphen. Mirrors isSkillName in @deepseek-ai/dsh-skill.
*/
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/**
* Whether a string is a skill name the official registry accepts.
* @param name - candidate skill name.
* @returns whether it matches the official skill-name grammar.
*/
function isSkillName(name) {
	return SKILL_NAME_PATTERN.test(name);
}
/**
* Official precedence rank per source (lower wins): the values
* @deepseek-ai/dsh-skill-filesystem assigns its roots plus the registry's
* runtime rank. A duplicate name resolves by this rank across every source the
* panel shows, so the entry it displays is the one the model receives. Note
* runtime (250) sits between the project roots and the custom root, not last.
*/
const SKILL_SOURCE_RANK = /* @__PURE__ */ new Map([
	["project-dsh", 100],
	["project-agents", 200],
	["runtime", 250],
	["custom", 300],
	["user-dsh", 400],
	["user-agents", 500],
	["bundled", 600]
]);
/** Unknown or foreign sources rank below every known source. */
const UNKNOWN_SOURCE_RANK = 999;
/**
* Precedence rank of a display level (see SKILL_SOURCE_RANK).
* @param level - a source level key or an other:<source> bucket.
* @returns the rank; unknown levels rank last.
*/
function rankOf(level) {
	return SKILL_SOURCE_RANK.get(level) ?? UNKNOWN_SOURCE_RANK;
}
/** Find the nearest ancestor directory containing .git (cwd itself when none). */
function findProjectRoot(cwd) {
	let current = cwd;
	for (;;) {
		if (existsSync(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return cwd;
		current = parent;
	}
}
/**
* Normalize a custom-root list: drop blanks, resolve each entry to an absolute
* path, and de-duplicate.
*
* Two sources can name the same root — the plugin's own `customSkillDirs` and
* the live `skill-filesystem` row config — and the official provider resolves
* every configured root with `resolve()` before scanning it. Matching that
* here keeps the scanned identity equal to the path the write routes later
* re-resolve, so a toggle or delete addresses the file the panel displayed.
* @param dirs - configured custom skill roots (possibly empty or duplicated).
* @returns absolute, de-duplicated, non-empty roots in first-seen order.
*/
function normalizeSkillRoots(dirs) {
	const seen = /* @__PURE__ */ new Set();
	const roots = [];
	for (const dir of dirs) {
		if (typeof dir !== "string" || dir.trim() === "") continue;
		const root = resolve(dir);
		if (seen.has(root)) continue;
		seen.add(root);
		roots.push(root);
	}
	return roots;
}
/** The `skill-filesystem` loader row's module specifier. */
const SKILL_FILESYSTEM_ROW = "@deepseek-ai/dsh-skill-filesystem";
/** Whether a loader row is the official filesystem skill provider. */
function isSkillFilesystemRow(entry) {
	const name = entry.options?.name;
	if (typeof name !== "string") return false;
	return name === SKILL_FILESYSTEM_ROW || name.endsWith("/dsh-skill-filesystem");
}
/** Read one customSkillDirs field off a resolved config object. */
function customSkillDirsOf(config) {
	if (typeof config !== "object" || config === null || Array.isArray(config)) return [];
	const value = config.customSkillDirs;
	if (!Array.isArray(value)) return [];
	return value.filter((dir) => typeof dir === "string");
}
/**
* Collect the custom skill roots every live `skill-filesystem` loader row
* declares.
*
* The official documentation mounts the provider as a profile row and puts
* `customSkillDirs` on that row, not on this plugin. Without reading those
* rows the panel shows the row's skills in the "Custom directories" group
* (the registry reports their `source` as `custom`) while owning no scanned
* path for them, so every row-level control answers 404. Both the row's raw
* `options.config` and the resolved `fiber.config` are read: the loader
* interpolates `!!js` expressions into the latter, and the shipped preset
* row uses one for its bundled skills directory.
* @param entries - live loader entries (any iterable).
* @returns the declared custom roots, unnormalized.
*/
function customSkillDirsFromLoader(entries) {
	if (entries === void 0) return [];
	const dirs = [];
	try {
		for (const entry of entries) {
			if (!isSkillFilesystemRow(entry)) continue;
			dirs.push(...customSkillDirsOf(entry.options?.config));
			dirs.push(...customSkillDirsOf(entry.fiber?.config));
		}
	} catch {
		return dirs;
	}
	return dirs;
}
/**
* Scan one skill root (one level: <name>/SKILL.md or <name>.md).
* Async IO via fs/promises so multiple roots can be scanned in parallel.
*/
async function scanSkillRoot(root, level, into, workspaceInfo, skipSystem = false) {
	if (!existsSync(root)) return;
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const name = entry.name;
		if (skipSystem && name === ".system") continue;
		let file;
		let linked = false;
		if (entry.isDirectory()) file = join(root, name, "SKILL.md");
		else if (entry.isFile() && name.endsWith(".md")) file = join(root, name);
		else if (entry.isSymbolicLink()) {
			linked = true;
			let linkedFile;
			try {
				const target = await stat(join(root, name));
				if (target.isDirectory()) linkedFile = join(root, name, "SKILL.md");
				else if (target.isFile() && name.endsWith(".md")) linkedFile = join(root, name);
				else continue;
			} catch {
				continue;
			}
			file = linkedFile;
		} else continue;
		if (!existsSync(file)) continue;
		let content;
		try {
			content = await readFile(file, "utf8");
		} catch {
			continue;
		}
		const parsed = parseFrontmatter(content);
		if (parsed.name === void 0 || parsed.name === "") continue;
		if (parsed.description === void 0 || parsed.description === "") continue;
		if (!isSkillName(parsed.name)) continue;
		const priority = rankOf(level);
		const existing = into.get(parsed.name);
		if (existing !== void 0) {
			const existingPriority = rankOf(existing.level);
			if (existingPriority < priority) continue;
			if (existingPriority === priority && existing.isActiveWorkspace && !workspaceInfo?.active) continue;
		}
		into.set(parsed.name, {
			name: parsed.name,
			description: parsed.description,
			whenToUse: parsed.whenToUse,
			provider: "filesystem",
			level,
			path: file,
			fileState: "editable",
			linked,
			modelInvocable: parsed.disableModelInvocation !== true,
			userInvocable: parsed.userInvocable !== false,
			workspaceRoot: workspaceInfo?.root,
			workspaceName: workspaceInfo?.name,
			isActiveWorkspace: workspaceInfo?.active
		});
	}
}
/** Serialize one registry entry into the panel payload (keeps the source for grouping). */
function serializeRegistry(skill) {
	const providerPath = typeof skill.path === "string" && skill.path.trim() !== "" ? skill.path : void 0;
	return {
		name: skill.name,
		description: skill.description,
		whenToUse: skill.whenToUse,
		provider: skill.provider,
		level: REGISTRY_SOURCE_LEVEL.get(skill.source) ?? `other:${skill.source}`,
		path: void 0,
		fileState: providerPath === void 0 ? "virtual" : "provider-file",
		modelInvocable: skill.invocation?.modelInvocable ?? true,
		userInvocable: skill.invocation?.userInvocable ?? true
	};
}
/**
* Apply the panel's provider-skill switches to a finished collection.
*
* Only a `provider-file` row can carry such a switch: an `editable` row's
* switch rewrites the SKILL.md frontmatter (and is therefore already reflected
* by the scan), and a `virtual` row has no file at all, so both are left
* exactly as the scan and registry reported them. Like the frontmatter field
* the local switch rewrites, this clears `modelInvocable` only — the provider's
* own `userInvocable` policy is not the model's automatic-call decision and
* stays as registered.
*
* It is deliberately the LAST step of the collection: the registry merge can
* replace a scanned entry with the registry's own (pathless) one, so applying
* the store earlier would let merge order decide whether a row is switchable.
* @param skills - collected entries, mutated in place as the merge does.
* @param disabled - identities the panel switched off.
*/
function applyProviderToggles(skills, disabled) {
	if (disabled.length === 0) return;
	const keys = new Set(disabled.map((identity) => JSON.stringify([identity.provider, identity.name])));
	for (const skill of skills) {
		if (skill.fileState !== "provider-file") continue;
		if (!keys.has(JSON.stringify([skill.provider ?? "", skill.name]))) continue;
		skill.modelInvocable = false;
	}
}
/** Group by level, ordered by SOURCE_GROUPS then leftovers, sorted by name inside each group. */
function buildPayload(skills, complete, cwd, projectRoots) {
	const byLevel = /* @__PURE__ */ new Map();
	for (const skill of skills) {
		const list = byLevel.get(skill.level) ?? [];
		list.push(skill);
		byLevel.set(skill.level, list);
	}
	const known = new Set(SOURCE_GROUPS.map((group) => group.key));
	const groups = SOURCE_GROUPS.map((group) => ({
		key: group.key,
		title: group.title,
		hint: group.hint,
		skills: (byLevel.get(group.key) ?? []).sort((a, b) => a.name.localeCompare(b.name))
	})).filter((group) => group.skills.length > 0);
	const leftovers = [...byLevel.entries()].filter(([key]) => !known.has(key)).map(([key, list]) => ({
		key,
		title: key.startsWith("other:") ? `Other (${key.slice(6)})` : `Other (${key})`,
		hint: "",
		skills: list.sort((a, b) => a.name.localeCompare(b.name))
	}));
	const activeRoot = findProjectRoot(cwd);
	const workspaces = [...new Set(projectRoots.length > 0 ? [activeRoot, ...projectRoots] : [activeRoot])].map((root) => ({
		root,
		name: basename(root) || root,
		active: root === activeRoot || root === cwd
	}));
	return {
		cwd,
		projectRoots,
		complete,
		groups: [...groups, ...leftovers],
		workspaces
	};
}
/**
* Collect grouped skills: filesystem scanning plus registry supplement.
*
* Both halves apply the official acceptance rules: a scanned file must declare
* name and description and the name must be a valid skill name (see
* scanSkillRoot), and a duplicate name resolves by the official source rank
* across the scan and the registry, so the entry shown is the one the model
* receives. The registry additionally contributes bundled and runtime entries
* of its own, and fills whenToUse / invocation flags on a same-rank peer.
* @param options - collection options.
* @returns skills and whether the registry snapshot was complete.
*/
async function collectSkills(options) {
	const { cwd, customSkillDirs, dshHome, agentsHome, registry } = options;
	const byName = /* @__PURE__ */ new Map();
	const activeProjectRoot = findProjectRoot(cwd);
	const roots = new Set(options.projectRoots !== void 0 && options.projectRoots.length > 0 ? [activeProjectRoot, ...options.projectRoots] : [activeProjectRoot]);
	const scanTasks = [];
	for (const root of roots) {
		const isActive = root === activeProjectRoot || root === cwd;
		const wsInfo = {
			root,
			name: basename(root) || root,
			active: isActive
		};
		scanTasks.push(scanSkillRoot(join(root, ".dsh", "skills"), "project-dsh", byName, wsInfo));
		scanTasks.push(scanSkillRoot(join(root, ".agents", "skills"), "project-agents", byName, wsInfo));
	}
	for (const dir of normalizeSkillRoots(customSkillDirs ?? [])) scanTasks.push(scanSkillRoot(dir, "custom", byName));
	scanTasks.push(scanSkillRoot(join(dshHome, "skills"), "user-dsh", byName, void 0, true));
	scanTasks.push(scanSkillRoot(join(agentsHome, "skills"), "user-agents", byName));
	await Promise.all(scanTasks);
	const snapshotCwds = /* @__PURE__ */ new Set([cwd, ...roots]);
	let complete = true;
	for (const snapshotCwd of snapshotCwds) try {
		const snapshot = await registry.snapshot({ cwd: snapshotCwd });
		if (snapshot.complete !== true) complete = false;
		for (const skill of snapshot.skills) {
			const existing = byName.get(skill.name);
			const serialized = serializeRegistry(skill);
			if (existing === void 0) {
				byName.set(skill.name, serialized);
				continue;
			}
			if (rankOf(serialized.level) < rankOf(existing.level)) {
				byName.set(skill.name, serialized);
				continue;
			}
			if (rankOf(serialized.level) > rankOf(existing.level)) continue;
			if (serialized.whenToUse !== void 0) existing.whenToUse = serialized.whenToUse;
			if (serialized.provider !== void 0) existing.provider = serialized.provider;
			if (skill.invocation?.modelInvocable !== void 0) existing.modelInvocable = skill.invocation.modelInvocable;
			if (skill.invocation?.userInvocable !== void 0) existing.userInvocable = skill.invocation.userInvocable;
		}
	} catch {
		complete = false;
	}
	applyProviderToggles(byName.values(), options.providerDisabledSkills ?? []);
	return {
		skills: [...byName.values()],
		complete
	};
}
/** Single-quote a YAML scalar (doubling embedded quotes); keeps the frontmatter parseable for values containing colons. */
function yamlQuote(value) {
	return `'${value.replace(/'/g, "''")}'`;
}
/** Build the new skill file content (create route). */
function buildSkillContent(name, description, whenToUse, content, disabled) {
	const lines = [
		"---",
		`name: ${name}`,
		`description: ${yamlQuote(description.replace(/[\r\n]/gu, " "))}`
	];
	if (typeof whenToUse === "string" && whenToUse.trim() !== "") lines.push(`whenToUse: ${yamlQuote(whenToUse.replace(/[\r\n]/gu, " "))}`);
	if (disabled === true) lines.push("disable-model-invocation: true");
	lines.push("---", "", content.trim(), "");
	return lines.join("\n");
}
/** Create a skill file (mkdir -p + write). Returns the absolute target path. */
async function writeSkillFile(baseDir, name, description, whenToUse, content) {
	const targetDir = join(baseDir, name);
	const target = join(targetDir, "SKILL.md");
	if (existsSync(target)) throw new Error(`skill ${name} already exists at ${target}`);
	await mkdir(targetDir, { recursive: true });
	await writeFile(target, buildSkillContent(name, description.trim(), whenToUse, content, false), "utf8");
	return target;
}
/**
* Overwrite an existing skill file in place (edit route). The caller has
* already resolved the path through a fresh scan, and the enabled state is
* carried over so an edit never silently re-enables a disabled skill.
*/
async function overwriteSkillFile(path, name, description, whenToUse, content, disabled) {
	await writeFile(path, buildSkillContent(name, description.trim(), whenToUse, content, disabled), "utf8");
	return path;
}
/** Move a skill file into its .trash sibling directory (recoverable delete). */
async function trashSkillFile(path) {
	const trashDir = join(dirname(path), ".trash");
	await mkdir(trashDir, { recursive: true });
	const trashTarget = join(trashDir, `${Date.now()}-SKILL.md`);
	await rename(path, trashTarget);
	return trashTarget;
}
/** User skill root convention. */
function userSkillRoot(dshHome) {
	return join(dshHome, "skills");
}
/** Project skill root convention (project root + .dsh/skills). */
function projectSkillRoot(projectRoot) {
	return `${projectRoot}${sep}.dsh${sep}skills`;
}
//#endregion
//#region src/http.ts
/** Default body cap for readJsonBody: 64 KiB. */
const DEFAULT_JSON_BODY_MAX_BYTES = 64 * 1024;
/** Family-default JSON response headers; callers may append or override. */
const JSON_HEADERS = {
	"content-type": "application/json; charset=utf-8",
	"referrer-policy": "no-referrer"
};
/**
* Lenient bounded body reader: parse a request body as JSON, or null on an
* empty body, invalid JSON, or a body past maxBytes (default 64 KiB).
* Overflow destroys the request instead of draining the remainder (no drain
* call, matching the current repo-wide behavior); callers must not keep
* reading the request afterwards. With objectOnly, non-JSON-object payloads
* also yield null.
*/
async function readJsonBody(req, opts = {}) {
	const maxBytes = opts.maxBytes ?? DEFAULT_JSON_BODY_MAX_BYTES;
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		size += buffer.length;
		if (size > maxBytes) {
			req.destroy();
			return null;
		}
		chunks.push(buffer);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text === "") return null;
	try {
		const parsed = JSON.parse(text);
		if (opts.objectOnly && !isJsonObject(parsed)) return null;
		return parsed;
	} catch {
		return null;
	}
}
/** Whether a value is a JSON object: typeof object, not null, not an array. */
function isJsonObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
* Write one JSON response. Default headers are the family defaults
* (content-type and referrer-policy); caller headers are appended or
* override them.
*/
function writeJson(res, status, body, headers = {}) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		...JSON_HEADERS,
		...headers
	});
	res.end(payload);
}
//#endregion
//#region src/import.ts
/**
* Skill import: batch-create SKILL.md files from a local directory or a .zip
* archive.
*
* Import is a *creation* surface, not a write-to-a-path one. The existing
* write routes stay exactly as they were — every one of them still only
* mutates a path a fresh scan resolved for the name the panel displayed — so
* the security model they implement is unchanged. This module's own boundary
* is narrower than it first looks:
*
* - the only files it ever reads are `<dir>/<name>/SKILL.md`,
*   `<dir>/<name>.md` (one level, the same convention the panel's scan uses)
*   or the archive the browser posted;
* - the only files it ever writes are `<skill root>/<name>/SKILL.md` under the
*   documented user/project root, and only when that file does not exist yet;
* - symbolic links in the source are skipped rather than followed, so an
*   import cannot be pointed at content through a planted link;
* - a candidate the official provider would not load (no name/description
*   frontmatter, a name outside the official grammar) is skipped, so the
*   panel never creates a skill the model cannot receive.
*
* Collisions resolve by the official source rank (the same table the list
* route uses): importing into a root that is *weaker* than an existing
* same-name skill would produce a file the model never receives, so that
* candidate is reported as shadowed instead of written.
*/
/** Hard bounds on one import, so a hostile archive cannot exhaust the host. */
const IMPORT_LIMITS = {
	/** Largest archive the route accepts (a base64 body is larger on the wire). */
	archiveBytes: 4 * 1024 * 1024,
	/** Most entries one archive may carry. */
	entries: 512,
	/** Largest one imported SKILL.md (the same cap the create/edit routes use). */
	skillBytes: 64 * 1024,
	/** Largest total uncompressed skill text one import may produce. */
	totalBytes: 4 * 1024 * 1024
};
/**
* A failure caused by what the request supplied (a malformed archive, an
* unreadable source directory), never by the host. The route maps it to 400 so
* the user reads an actionable message instead of a generic server error.
*/
var ImportRequestError = class extends Error {};
const EOCD_SIGNATURE = 101010256;
const CENTRAL_SIGNATURE = 33639248;
const LOCAL_SIGNATURE = 67324752;
/** The zip64 escape value in a 32-bit size/offset field. */
const ZIP64_MARKER = 4294967295;
const EOCD_SIZE = 22;
const MAX_COMMENT = 65535;
/** The central-directory file name of a skill instruction file. */
const SKILL_FILE = "skill.md";
/** Find the end-of-central-directory record, scanning back over the comment. */
function findEndOfCentralDirectory(archive) {
	const last = archive.length - EOCD_SIZE;
	if (last < 0) return -1;
	const first = Math.max(0, last - MAX_COMMENT);
	for (let offset = last; offset >= first; offset -= 1) if (archive.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
	return -1;
}
/**
* Normalize one archive entry path and reject anything that could escape a
* directory: absolute paths, drive letters and `..` segments. The import never
* joins an entry path onto a filesystem path, but a reported origin must not
* read like a path outside the archive either.
*/
function safeEntryPath(name) {
	const normalized = name.replace(/\\/gu, "/");
	if (normalized === "" || normalized.startsWith("/")) return void 0;
	if (/^[A-Za-z]:/u.test(normalized)) return void 0;
	if (normalized.split("/").some((segment) => segment === "..")) return void 0;
	return normalized;
}
/**
* Decode a zip archive into its file entries (stored and deflate methods).
*
* Only what a skills archive uses is supported; zip64, encrypted entries and
* unknown compression methods are rejected with a message naming the problem,
* so an unsupported archive fails loudly instead of importing half of itself.
* @param archive - the raw archive bytes.
* @returns every file entry, directories excluded.
* @throws when the archive is malformed or uses an unsupported feature.
*/
function readZipEntries(archive) {
	if (archive.length < EOCD_SIZE) throw new ImportRequestError("not a zip archive: too short");
	const eocd = findEndOfCentralDirectory(archive);
	if (eocd < 0) throw new ImportRequestError("not a zip archive: no end-of-central-directory record");
	const total = archive.readUInt16LE(eocd + 10);
	const directorySize = archive.readUInt32LE(eocd + 12);
	const directoryOffset = archive.readUInt32LE(eocd + 16);
	if (total === 65535 || directoryOffset === ZIP64_MARKER || directorySize === ZIP64_MARKER) throw new ImportRequestError("unsupported zip archive: zip64 is not supported");
	if (total > IMPORT_LIMITS.entries) throw new ImportRequestError(`archive has more than ${IMPORT_LIMITS.entries} entries`);
	const directoryEnd = directoryOffset + directorySize;
	if (directoryOffset > archive.length || directoryEnd > archive.length) throw new ImportRequestError("corrupt zip archive: central directory is out of range");
	const entries = [];
	let totalBytes = 0;
	let cursor = directoryOffset;
	for (let index = 0; index < total; index += 1) {
		if (cursor + 46 > directoryEnd || archive.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw new ImportRequestError("corrupt zip archive: bad central directory entry");
		const flags = archive.readUInt16LE(cursor + 8);
		const method = archive.readUInt16LE(cursor + 10);
		const compressedSize = archive.readUInt32LE(cursor + 20);
		const uncompressedSize = archive.readUInt32LE(cursor + 24);
		const nameLength = archive.readUInt16LE(cursor + 28);
		const extraLength = archive.readUInt16LE(cursor + 30);
		const commentLength = archive.readUInt16LE(cursor + 32);
		const localOffset = archive.readUInt32LE(cursor + 42);
		const nameStart = cursor + 46;
		const nameEnd = nameStart + nameLength;
		if (nameEnd > directoryEnd) throw new ImportRequestError("corrupt zip archive: truncated entry name");
		const rawName = archive.toString("utf8", nameStart, nameEnd);
		cursor = nameEnd + extraLength + commentLength;
		if (compressedSize === ZIP64_MARKER || uncompressedSize === ZIP64_MARKER || localOffset === ZIP64_MARKER) throw new ImportRequestError("unsupported zip archive: zip64 is not supported");
		if (rawName.endsWith("/")) continue;
		if ((flags & 1) !== 0) throw new ImportRequestError(`unsupported zip entry (encrypted): ${rawName}`);
		if (method !== 0 && method !== 8) throw new ImportRequestError(`unsupported zip entry (compression method ${method}): ${rawName}`);
		if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) throw new ImportRequestError(`corrupt zip archive: bad local header for ${rawName}`);
		const localNameLength = archive.readUInt16LE(localOffset + 26);
		const localExtraLength = archive.readUInt16LE(localOffset + 28);
		const dataStart = localOffset + 30 + localNameLength + localExtraLength;
		const dataEnd = dataStart + compressedSize;
		if (dataEnd > archive.length) throw new ImportRequestError(`corrupt zip archive: truncated data for ${rawName}`);
		const compressed = archive.subarray(dataStart, dataEnd);
		let data;
		if (method === 0) data = Buffer.from(compressed);
		else try {
			data = inflateRawSync(compressed);
		} catch {
			throw new ImportRequestError(`corrupt zip archive: cannot inflate ${rawName}`);
		}
		if (data.length > uncompressedSize) throw new ImportRequestError(`corrupt zip archive: ${rawName} inflates past its declared size`);
		totalBytes += data.length;
		if (totalBytes > IMPORT_LIMITS.totalBytes) throw new ImportRequestError(`archive expands past the ${IMPORT_LIMITS.totalBytes} byte import limit`);
		const safe = safeEntryPath(rawName);
		if (safe === void 0) continue;
		entries.push({
			path: safe,
			data
		});
	}
	return entries;
}
/**
* Pull the SKILL.md candidates out of decoded archive entries. Nested layouts
* (`<skill>/SKILL.md` at any depth, so a zipped folder of skills works) are
* accepted; every other file in the archive is ignored rather than reported,
* because an archive routinely carries READMEs and assets beside the skills.
* @param entries - decoded archive entries.
* @returns one candidate per SKILL.md, in archive order.
*/
function candidatesFromArchive(entries) {
	const candidates = [];
	for (const entry of entries) {
		if (basename(entry.path).toLowerCase() !== SKILL_FILE) continue;
		candidates.push({
			origin: entry.path,
			content: entry.data.toString("utf8")
		});
	}
	return candidates;
}
/**
* Read the candidates of one host directory, one level deep: a skill
* directory (`<name>/SKILL.md`) or a flattened `<name>.md`, the same two
* shapes the panel's own scan accepts. Dot entries and symbolic links are
* skipped — a link would let an import copy content the user did not point at,
* and the panel's linked-skill rules have no meaning for a copy.
* @param dir - absolute source directory.
* @returns the candidates found, in directory order.
* @throws when the path is not a readable directory.
*/
async function candidatesFromDirectory(dir) {
	let info;
	try {
		info = await lstat(dir);
	} catch {
		throw new ImportRequestError(`import source is not a readable directory: ${dir}`);
	}
	if (!info.isDirectory()) throw new ImportRequestError(`import source is not a directory: ${dir}`);
	const entries = await readdir(dir, { withFileTypes: true });
	const candidates = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) {
			const file = join(dir, entry.name, "SKILL.md");
			if (!existsSync(file)) continue;
			candidates.push({
				origin: file,
				content: await readFile(file, "utf8")
			});
			continue;
		}
		if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
		const file = join(dir, entry.name);
		candidates.push({
			origin: file,
			content: await readFile(file, "utf8")
		});
	}
	return candidates;
}
/**
* Validate one raw candidate the way the official provider accepts a skill:
* the frontmatter must declare a non-empty description and a name inside the
* official grammar. The skill's identity is the *frontmatter* name — that is
* the name the registry loads and the model receives, so the imported
* directory is named after it rather than after the source folder.
* @param raw - the candidate text and where it came from.
* @returns the validated candidate, or the reason it cannot be imported.
*/
function parseCandidate(raw) {
	if (Buffer.byteLength(raw.content, "utf8") > IMPORT_LIMITS.skillBytes) return {
		name: basename(dirname(raw.origin)),
		reason: "too-large"
	};
	const frontmatter = parseFrontmatter(raw.content);
	const declared = frontmatter.name ?? "";
	const name = declared === "" ? basename(dirname(raw.origin)) : declared;
	if (declared === "" || frontmatter.description === void 0 || frontmatter.description === "") return {
		name,
		reason: "invalid-frontmatter"
	};
	if (!isSkillName(declared)) return {
		name,
		reason: "invalid-name"
	};
	return {
		name: declared,
		candidate: {
			name: declared,
			content: raw.content,
			origin: raw.origin
		}
	};
}
/**
* Decide every candidate's fate before writing anything, so a conflict or a
* duplicate cannot leave a half-applied import behind.
*
* Conflicts use the official source rank: a same-name skill at a *stronger*
* source outranks the target root and the imported file would never be the
* one the model receives (skipped as shadowed); a same-name skill at the
* *same* source means the name is already taken in that root (skipped as
* existing); a weaker source is shadowed by the import, so it is written.
* @param candidates - validated candidates in source order.
* @param existing - the skills a fresh collection just found.
* @param targetLevel - the source level the import writes into.
* @returns one plan item per candidate, in source order.
*/
function planImport(candidates, existing, targetLevel) {
	const targetRank = rankOf(targetLevel);
	const byName = new Map(existing.map((skill) => [skill.name, skill]));
	const seen = /* @__PURE__ */ new Set();
	const plan = [];
	for (const candidate of candidates) {
		if (seen.has(candidate.name)) {
			plan.push({
				candidate,
				decision: "skip",
				reason: "duplicate"
			});
			continue;
		}
		seen.add(candidate.name);
		const current = byName.get(candidate.name);
		if (current !== void 0) {
			const currentRank = rankOf(current.level);
			if (currentRank < targetRank) {
				plan.push({
					candidate,
					decision: "skip",
					reason: "shadowed"
				});
				continue;
			}
			if (currentRank === targetRank) {
				plan.push({
					candidate,
					decision: "skip",
					reason: "exists"
				});
				continue;
			}
		}
		plan.push({
			candidate,
			decision: "import"
		});
	}
	return plan;
}
/**
* Write the planned candidates into one skill root. Every write is a new file:
* an existing SKILL.md is never overwritten, and a failure after the first
* file leaves the earlier imports in place (each one is individually valid and
* the panel simply lists them — the report says which succeeded).
* @param plan - the plan from planImport.
* @param baseDir - the target skill root.
* @returns one outcome per plan item, in plan order.
*/
async function executeImport(plan, baseDir) {
	const outcomes = [];
	for (const item of plan) {
		const { candidate } = item;
		if (item.decision === "skip") {
			outcomes.push({
				name: candidate.name,
				origin: candidate.origin,
				status: "skipped",
				reason: item.reason
			});
			continue;
		}
		const targetDir = join(baseDir, candidate.name);
		const target = join(targetDir, "SKILL.md");
		if (existsSync(target)) {
			outcomes.push({
				name: candidate.name,
				origin: candidate.origin,
				status: "skipped",
				reason: "exists"
			});
			continue;
		}
		await mkdir(targetDir, { recursive: true });
		await writeFile(target, candidate.content, {
			encoding: "utf8",
			flag: "wx"
		});
		outcomes.push({
			name: candidate.name,
			origin: candidate.origin,
			status: "imported",
			path: target
		});
	}
	return outcomes;
}
/**
* Run one import: extract, validate, plan, then write.
* @param request - the resolved target root, source and current catalog.
* @returns per-candidate outcomes plus the counts.
*/
async function importSkills(request) {
	const parsed = (request.source.kind === "archive" ? candidatesFromArchive(readZipEntries(request.source.data)) : await candidatesFromDirectory(request.source.path)).map((item) => ({
		item,
		result: parseCandidate(item)
	}));
	const executed = await executeImport(planImport(parsed.flatMap((entry) => entry.result.candidate === void 0 ? [] : [entry.result.candidate]), request.existing, request.targetLevel), request.baseDir);
	const outcomes = [];
	let cursor = 0;
	for (const entry of parsed) {
		if (entry.result.candidate === void 0) {
			outcomes.push({
				name: entry.result.name,
				origin: entry.item.origin,
				status: "skipped",
				reason: entry.result.reason
			});
			continue;
		}
		const outcome = executed[cursor];
		cursor += 1;
		if (outcome !== void 0) outcomes.push(outcome);
	}
	return {
		level: request.targetLevel,
		outcomes,
		imported: outcomes.filter((outcome) => outcome.status === "imported").length,
		skipped: outcomes.filter((outcome) => outcome.status === "skipped").length
	};
}
//#endregion
//#region src/provider-toggles.ts
/**
* The panel's own "switched off" set for plugin-provided skills.
*
* A skill whose instruction file comes from a plugin provider — the registry
* reports `SkillSummary.path`, but the file sits outside every skill root this
* panel scans — has no writable path, so the SKILL.md frontmatter switch the
* other rows use cannot address it (and offering that switch would only produce
* a 404). This store is the plugin's own answer: one small JSON document under
* `$DSH_HOME/dsh-skill-explorer/` listing the provider-backed skills the user
* switched off in the panel, keyed by the stable pair (provider, skill name).
*
* It is a PANEL-LOCAL decision: the host registry still loads the skill, so the
* panel copy and the README say so plainly instead of pretending the model
* stopped receiving it. What the store does change is this panel's invocable
* view (see applyProviderToggles in collect.ts), which is the scope the issue
* accepts.
*
* Writes are atomic (unique temp file, fsync, rename), so an interrupted write
* can never leave a half-written document behind.
*/
/**
* Bound on the stored set. The panel only ever offers a switch for a skill it
* lists, so a healthy installation holds a handful of records; the cap keeps a
* corrupt or hand-edited document from growing without limit.
*/
const MAX_DISABLED = 512;
/**
* Bound on one provider id. Cordis provider ids are short module or plugin
* names; a longer value is not a provider id this store will record.
*/
const MAX_PROVIDER_LENGTH = 200;
/** Per-process counter so two concurrent writes never share a temp file name. */
let tempSeq = 0;
/** Store file location: $DSH_HOME/dsh-skill-explorer/provider-toggles.json. */
function providerToggleFile(dshHome) {
	return join(dshHome, "dsh-skill-explorer", "provider-toggles.json");
}
/** The document a panel that has never been switched off reads as. */
function emptyProviderToggles() {
	return {
		version: 1,
		disabled: []
	};
}
/**
* Normalize a submitted identity, or reject it.
*
* The name must satisfy the official skill grammar (the same one the scan and
* the file write routes apply), and the provider must be a short id: both are
* written into the store verbatim, so an unbounded or ungrammatical value would
* be a record no row could ever match.
* @param name - candidate skill name from the panel.
* @param provider - candidate provider id (optional).
* @returns the normalized identity, or undefined when it is not storable.
*/
function providerSkillIdentity(name, provider) {
	if (!isSkillName(name)) return void 0;
	const id = typeof provider === "string" ? provider.trim() : "";
	if (id.length > MAX_PROVIDER_LENGTH) return void 0;
	return {
		name,
		provider: id
	};
}
/** Map key for one identity; JSON keeps the pair unambiguous for any provider id. */
function keyOf(identity) {
	return JSON.stringify([identity.provider, identity.name]);
}
/**
* Total order over identities (plain comparison, never locale-dependent), so
* the stored document reads like the skill list: by name, then by provider.
*/
function compareIdentities(left, right) {
	if (left.name !== right.name) return left.name < right.name ? -1 : 1;
	if (left.provider !== right.provider) return left.provider < right.provider ? -1 : 1;
	return 0;
}
/**
* Tolerant deserialize: a missing, corrupt, or foreign document reads as "no
* skill switched off", which is the state a fresh install is in. Records that
* no row could match (an ungrammatical name, an over-long provider id, a
* duplicate) are dropped rather than carried forward.
* @param raw - file text.
* @returns the usable records, de-duplicated, bounded and sorted.
*/
function deserializeProviderToggles(raw) {
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return emptyProviderToggles();
	}
	if (typeof parsed !== "object" || parsed === null) return emptyProviderToggles();
	const doc = parsed;
	if (doc.version !== 1 || !Array.isArray(doc.disabled)) return emptyProviderToggles();
	const seen = /* @__PURE__ */ new Set();
	const disabled = [];
	for (const value of doc.disabled) {
		if (typeof value !== "object" || value === null) continue;
		const entry = value;
		if (typeof entry.name !== "string" || typeof entry.provider !== "string") continue;
		const identity = providerSkillIdentity(entry.name, entry.provider);
		if (identity === void 0) continue;
		const key = keyOf(identity);
		if (seen.has(key)) continue;
		seen.add(key);
		disabled.push(identity);
		if (disabled.length >= MAX_DISABLED) break;
	}
	return {
		version: 1,
		disabled: disabled.sort(compareIdentities)
	};
}
/** Serialize the document in the shape deserializeProviderToggles accepts. */
function serializeProviderToggles(doc) {
	return JSON.stringify({
		version: 1,
		disabled: doc.disabled
	}, null, 1);
}
/**
* Read the store for a panel request.
*
* An unreadable file degrades to the empty document on purpose: the panel then
* shows every provider skill as enabled, which is the state before the user
* ever used the switch, instead of failing the whole list route.
* @param dshHome - the DSH home root.
* @returns the records the panel currently honors.
*/
async function readProviderToggles(dshHome) {
	try {
		return deserializeProviderToggles(await readFile(providerToggleFile(dshHome), "utf8"));
	} catch {
		return emptyProviderToggles();
	}
}
/** Atomic JSON write: unique temp file, fsync, rename. */
async function writeJsonAtomic(path, value) {
	await mkdir(dirname(path), { recursive: true });
	tempSeq += 1;
	const temp = `${path}.${process.pid}.${tempSeq}.tmp`;
	try {
		const handle = await open(temp, "w");
		try {
			await handle.writeFile(value, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temp, path);
	} catch (error) {
		await unlink(temp).catch(() => {});
		throw error;
	}
}
/**
* Record (or clear) the panel-local switch for one provider-backed skill.
*
* Both directions are idempotent: switching the same skill off twice keeps one
* record instead of stacking duplicates, and switching on a skill that is not
* stored leaves the file untouched. A no-op write is skipped so an unchanged
* panel never rewrites the document.
* @param dshHome - the DSH home root.
* @param identity - the normalized provider-backed skill identity.
* @param enabled - true to enable (drop the record), false to disable.
* @returns the document as it stands after the call.
*/
async function setProviderSkillEnabled(dshHome, identity, enabled) {
	const doc = await readProviderToggles(dshHome);
	if (doc.disabled.some((entry) => keyOf(entry) === keyOf(identity)) === !enabled) return doc;
	const next = {
		version: 1,
		disabled: (enabled ? doc.disabled.filter((entry) => keyOf(entry) !== keyOf(identity)) : [...doc.disabled, identity]).sort(compareIdentities)
	};
	await writeJsonAtomic(providerToggleFile(dshHome), serializeProviderToggles(next));
	return next;
}
//#endregion
//#region src/routes.ts
/**
* The /api/dsh-skill-explorer route family: list (grouped by source), read
* (one skill's editable fields and body), set enabled (rewrites SKILL.md
* frontmatter), set provider enabled (records a panel-local switch for a
* plugin-provided skill, which has no writable path), create, update (rewrites
* an existing SKILL.md in place), delete (move to .trash), import (batch-create
* skills from a directory or a .zip archive) and health. Every route carries
* the shared trust fence (loopback by default; a live
* paired-device cookie is an extra allow
* path when remote-web-ui is loaded) plus browser same-origin markers — the
* write routes touch real skill files, so unpaired LAN clients must not reach
* them, and read/update only touch paths a fresh scan resolves. Import is the
* one creation surface that reads a source outside the skill roots (see
* import.ts): it writes only new files under the chosen root and never
* mutates an existing one.
*/
/** Route paths (client bundle mirrors these literals; tests assert both sides). */
const ROUTES = {
	list: "/api/dsh-skill-explorer/list",
	read: "/api/dsh-skill-explorer/read",
	setEnabled: "/api/dsh-skill-explorer/set-enabled",
	setProviderEnabled: "/api/dsh-skill-explorer/set-provider-enabled",
	create: "/api/dsh-skill-explorer/create",
	update: "/api/dsh-skill-explorer/update",
	delete: "/api/dsh-skill-explorer/delete",
	import: "/api/dsh-skill-explorer/import",
	health: "/api/dsh-skill-explorer/health"
};
/** Largest import request body: the archive cap plus base64 expansion and JSON. */
const IMPORT_BODY_MAX_BYTES = Math.ceil(IMPORT_LIMITS.archiveBytes / 3) * 4 + 64 * 1024;
/** Base64 payload guard: rejects a body that is not a base64 string at all. */
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u;
/** URL query helper (first value, decoded). */
function queryParam(url, name) {
	const value = url.searchParams.get(name);
	return value === null ? void 0 : value;
}
/** Default process cwd fallback (overridable in tests). */
const DEFAULT_CWD = () => process.cwd();
/**
* Narrow the request's import source.
*
* The body carries either a host directory the user typed or an archive the
* browser read and base64-encoded; anything else is a client-shape error, and
* returning the message here keeps the route's error branch a single
* condition.
* @param source - the raw `source` field.
* @returns the resolved source, or a message describing what is wrong.
*/
function resolveImportSource(source) {
	if (typeof source !== "object" || source === null || Array.isArray(source)) return "source must be { kind: \"directory\", path } or { kind: \"archive\", data }";
	const record = source;
	if (record.kind === "directory") {
		const path = record.path;
		if (typeof path !== "string" || path.trim() === "") return "source.path is required for a directory import";
		return {
			kind: "directory",
			path: path.trim()
		};
	}
	if (record.kind === "archive") {
		const data = record.data;
		if (typeof data !== "string" || data === "") return "source.data is required for an archive import";
		if (!BASE64_PATTERN.test(data)) return "source.data must be a base64 string";
		const decoded = Buffer.from(data, "base64");
		if (decoded.length === 0) return "source.data decoded to an empty archive";
		if (decoded.length > IMPORT_LIMITS.archiveBytes) return `archive exceeds the ${IMPORT_LIMITS.archiveBytes} byte import limit`;
		return {
			kind: "archive",
			data: decoded
		};
	}
	return "source.kind must be \"directory\" or \"archive\"";
}
/**
* Build every /api/dsh-skill-explorer route (exact paths).
* @param ctx - host context; may expose remoteWebUiPairing.
* @param deps - dshHome/agentsHome/registry/sessions.
* @returns the route list for ctx.webServer.register.
*/
function makeRoutes(ctx, deps) {
	const { dshHome, agentsHome, registry, activeSessionCwds, logger } = deps;
	/** Resolve the configured custom roots (degraded to [] when the resolver throws). */
	const resolveCustomSkillDirs = () => {
		try {
			const dirs = typeof deps.customSkillDirs === "function" ? deps.customSkillDirs() : deps.customSkillDirs;
			return Array.isArray(dirs) ? dirs : [];
		} catch {
			return [];
		}
	};
	/** Guard helper: fence + method check. */
	const guard = (req, res, method) => {
		if (!isSkillExplorerAllowed(ctx, req)) {
			writeJson(res, 403, { error: "forbidden: loopback-only" });
			return false;
		}
		if (req.method !== method) {
			writeJson(res, 405, { error: `method not allowed: ${req.method}` });
			return false;
		}
		return true;
	};
	/** Active session cwd list (degraded to [] when sessions throw). */
	const safeSessionCwds = () => {
		try {
			return activeSessionCwds();
		} catch {
			return [];
		}
	};
	/** Active session project roots (degraded to [] when sessions throw). */
	const sessionProjectRoots = () => {
		try {
			return safeSessionCwds().map((sessionCwd) => findProjectRoot(sessionCwd));
		} catch {
			return [];
		}
	};
	/**
	* Collect options shared by list/set-enabled/set-provider-enabled/delete/
	* health handlers.
	*
	* The panel's provider-skill switches are read per request (not captured at
	* mount) so a toggle the user just made is honored by the very next list,
	* and a restart picks the stored set back up.
	*/
	const collectOptions = async (cwd) => ({
		cwd,
		projectRoots: sessionProjectRoots(),
		customSkillDirs: resolveCustomSkillDirs(),
		dshHome,
		agentsHome,
		registry,
		providerDisabledSkills: (await readProviderToggles(dshHome)).disabled
	});
	/**
	* The workspace the panel is showing, resolved exactly like the list route:
	* an explicit override, then the active session workspace, then the process
	* cwd. The write routes used the process cwd alone, so on a host whose cwd
	* is the DSH install directory they scanned a different project root than
	* the list route had just served and reported 409 for a skill the panel was
	* displaying.
	*/
	const panelCwd = (override) => (override !== void 0 && override.trim() !== "" ? override : void 0) ?? safeSessionCwds()[0] ?? DEFAULT_CWD();
	/** Find a skill by name from a fresh collection pass (trusts scanned paths only). */
	const findSkill = async (name, cwd) => {
		const { skills } = await collectSkills(await collectOptions(cwd));
		return skills.find((candidate) => candidate.name === name);
	};
	/**
	* Find a currently listed plugin-provided skill by its stable identity.
	*
	* The write route for the panel-local switch has no path to certify, so it
	* uses the identity the panel displayed: a fresh collection must resolve the
	* same (provider, name) pair to a `provider-file` row. Anything else — an
	* editable row (its own switch rewrites the file), a virtual row (no file),
	* or a skill the panel never listed — is not a target.
	*/
	const findProviderSkill = async (identity, cwd) => {
		const { skills } = await collectSkills(await collectOptions(cwd));
		return skills.find((candidate) => candidate.fileState === "provider-file" && candidate.name === identity.name && (candidate.provider ?? "") === identity.provider);
	};
	/** Resolve the exact file the panel showed, rejecting stale same-name fallbacks. */
	const resolveScannedSkill = async (name, expectedPath, cwd, res) => {
		const skill = await findSkill(name, cwd);
		if (skill?.path === void 0) {
			writeJson(res, 404, { error: `skill ${name} has no editable file` });
			return;
		}
		if (skill.path !== expectedPath) {
			writeJson(res, 409, { error: `skill ${name} changed since the panel loaded; refresh and retry` });
			return;
		}
		return skill;
	};
	return [
		{
			kind: "exact",
			path: ROUTES.list,
			handler: async (req, res) => {
				if (!guard(req, res, "GET")) return;
				try {
					const url = new URL(req.url ?? "/", "http://x");
					const cwd = panelCwd(queryParam(url, "cwd"));
					const projectRoots = sessionProjectRoots();
					const { skills, complete } = await collectSkills(await collectOptions(cwd));
					writeJson(res, 200, buildPayload(skills, complete, cwd, [...new Set(projectRoots)]));
				} catch (error) {
					logger.warn(error);
					writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
				}
			}
		},
		{
			kind: "exact",
			path: ROUTES.read,
			handler: async (req, res) => {
				if (!guard(req, res, "GET")) return;
				try {
					const url = new URL(req.url ?? "/", "http://x");
					const name = queryParam(url, "name");
					const path = queryParam(url, "path");
					if (name === void 0 || !isSkillName(name) || path === void 0 || path.trim() === "") {
						writeJson(res, 400, { error: "expected ?name=<kebab-case>&path=<absolute SKILL.md>" });
						return;
					}
					const skill = await resolveScannedSkill(name, path, panelCwd(), res);
					if (skill === void 0) return;
					const raw = readFileSync(skill.path, "utf8");
					const frontmatter = parseFrontmatter(raw);
					writeJson(res, 200, {
						name,
						path: skill.path,
						description: frontmatter.description ?? skill.description,
						...frontmatter.whenToUse === void 0 ? {} : { whenToUse: frontmatter.whenToUse },
						content: stripFrontmatter(raw).trim()
					});
				} catch (error) {
					logger.warn(error);
					writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
				}
			}
		},
		{
			kind: "exact",
			path: ROUTES.setEnabled,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				try {
					const body = await readJsonBody(req, {
						maxBytes: 128 * 1024,
						objectOnly: true
					});
					if (body === null) {
						writeJson(res, 400, { error: "invalid JSON body" });
						return;
					}
					const { name, path, enabled } = body;
					if (typeof name !== "string" || !isSkillName(name) || typeof path !== "string" || path.trim() === "" || typeof enabled !== "boolean") {
						writeJson(res, 400, { error: "expected { name, path, enabled }" });
						return;
					}
					const skill = await resolveScannedSkill(name, path, panelCwd(), res);
					if (skill === void 0) return;
					const frontmatter = setFrontmatterField(skill.path, "disable-model-invocation", enabled ? false : true);
					writeJson(res, 200, {
						name,
						enabled: frontmatter.disableModelInvocation !== true,
						modelInvocable: frontmatter.disableModelInvocation !== true,
						path: skill.path
					});
				} catch (error) {
					logger.warn(error);
					writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
				}
			}
		},
		{
			kind: "exact",
			path: ROUTES.setProviderEnabled,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				try {
					const body = await readJsonBody(req, {
						maxBytes: 8 * 1024,
						objectOnly: true
					});
					if (body === null) {
						writeJson(res, 400, { error: "invalid JSON body" });
						return;
					}
					const { name, provider, enabled } = body;
					if (typeof name !== "string" || typeof enabled !== "boolean" || provider !== void 0 && typeof provider !== "string") {
						writeJson(res, 400, { error: "expected { name, provider, enabled }" });
						return;
					}
					const identity = providerSkillIdentity(name, provider);
					if (identity === void 0) {
						writeJson(res, 400, { error: "name must be kebab-case (lowercase letters/digits first) and provider a short provider id" });
						return;
					}
					if (enabled) {
						await setProviderSkillEnabled(dshHome, identity, true);
						writeJson(res, 200, {
							ok: true,
							name: identity.name,
							provider: identity.provider,
							disabled: false
						});
						return;
					}
					if (await findProviderSkill(identity, panelCwd()) === void 0) {
						writeJson(res, 404, { error: `skill ${identity.name} is not a plugin-provided skill with a local file` });
						return;
					}
					await setProviderSkillEnabled(dshHome, identity, false);
					writeJson(res, 200, {
						ok: true,
						name: identity.name,
						provider: identity.provider,
						disabled: true
					});
				} catch (error) {
					logger.warn(error);
					writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
				}
			}
		},
		{
			kind: "exact",
			path: ROUTES.create,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				try {
					const body = await readJsonBody(req, {
						maxBytes: 128 * 1024,
						objectOnly: true
					});
					if (body === null) {
						writeJson(res, 400, { error: "invalid JSON body" });
						return;
					}
					const { root, name, description, whenToUse, content, cwd } = body;
					if (root !== "user" && root !== "project") {
						writeJson(res, 400, { error: "root must be user (~/.dsh/skills) or project (project .dsh/skills)" });
						return;
					}
					if (typeof cwd !== "string" || cwd.trim() === "") {
						writeJson(res, 400, { error: "cwd is required (the workspace shown by the panel)" });
						return;
					}
					if (typeof name !== "string" || !isSkillName(name)) {
						writeJson(res, 400, { error: "name must be kebab-case (lowercase letters/digits first)" });
						return;
					}
					if (typeof description !== "string" || description.trim() === "") {
						writeJson(res, 400, { error: "description is required" });
						return;
					}
					if (typeof content !== "string" || content.trim() === "") {
						writeJson(res, 400, { error: "content is required" });
						return;
					}
					if (Buffer.byteLength(content, "utf8") > 64 * 1024) {
						writeJson(res, 400, { error: "content exceeds 64KB limit" });
						return;
					}
					writeJson(res, 200, {
						ok: true,
						name,
						path: await writeSkillFile(root === "user" ? userSkillRoot(dshHome) : projectSkillRoot(findProjectRoot(cwd)), name, description, typeof whenToUse === "string" ? whenToUse : void 0, content)
					});
				} catch (error) {
					if (error instanceof Error && /already exists/.test(error.message)) {
						writeJson(res, 409, { error: error.message });
						return;
					}
					logger.warn(error);
					writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
				}
			}
		},
		{
			kind: "exact",
			path: ROUTES.import,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				try {
					const body = await readJsonBody(req, {
						maxBytes: IMPORT_BODY_MAX_BYTES,
						objectOnly: true
					});
					if (body === null) {
						writeJson(res, 400, { error: `invalid JSON body (or larger than ${IMPORT_BODY_MAX_BYTES} bytes)` });
						return;
					}
					const { root, cwd, source } = body;
					if (root !== "user" && root !== "project") {
						writeJson(res, 400, { error: "root must be user (~/.dsh/skills) or project (project .dsh/skills)" });
						return;
					}
					if (typeof cwd !== "string" || cwd.trim() === "") {
						writeJson(res, 400, { error: "cwd is required (the workspace shown by the panel)" });
						return;
					}
					const resolved = resolveImportSource(source);
					if (typeof resolved === "string") {
						writeJson(res, 400, { error: resolved });
						return;
					}
					const workspace = panelCwd(cwd);
					const targetLevel = root === "user" ? "user-dsh" : "project-dsh";
					const baseDir = root === "user" ? userSkillRoot(dshHome) : projectSkillRoot(findProjectRoot(cwd));
					const { skills } = await collectSkills(await collectOptions(workspace));
					writeJson(res, 200, {
						ok: true,
						...await importSkills({
							baseDir,
							targetLevel,
							source: resolved,
							existing: skills
						})
					});
				} catch (error) {
					if (error instanceof ImportRequestError) {
						writeJson(res, 400, { error: error.message });
						return;
					}
					logger.warn(error);
					writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
				}
			}
		},
		{
			kind: "exact",
			path: ROUTES.update,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				try {
					const body = await readJsonBody(req, {
						maxBytes: 128 * 1024,
						objectOnly: true
					});
					if (body === null) {
						writeJson(res, 400, { error: "invalid JSON body" });
						return;
					}
					const { name, path, description, whenToUse, content } = body;
					if (typeof name !== "string" || !isSkillName(name) || typeof path !== "string" || path.trim() === "") {
						writeJson(res, 400, { error: "expected { name, path, description, content }" });
						return;
					}
					if (typeof description !== "string" || description.trim() === "") {
						writeJson(res, 400, { error: "description is required" });
						return;
					}
					if (typeof content !== "string" || content.trim() === "") {
						writeJson(res, 400, { error: "content is required" });
						return;
					}
					if (Buffer.byteLength(content, "utf8") > 64 * 1024) {
						writeJson(res, 400, { error: "content exceeds 64KB limit" });
						return;
					}
					const skill = await resolveScannedSkill(name, path, panelCwd(), res);
					if (skill === void 0) return;
					if (skill.linked === true) {
						writeJson(res, 400, { error: `skill ${name} is a linked skill and cannot be edited` });
						return;
					}
					const disabled = parseFrontmatter(readFileSync(skill.path, "utf8")).disableModelInvocation === true;
					writeJson(res, 200, {
						ok: true,
						name,
						path: await overwriteSkillFile(skill.path, name, description.trim(), typeof whenToUse === "string" ? whenToUse : void 0, content, disabled),
						disabled
					});
				} catch (error) {
					logger.warn(error);
					writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
				}
			}
		},
		{
			kind: "exact",
			path: ROUTES.delete,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				try {
					const body = await readJsonBody(req, {
						maxBytes: 128 * 1024,
						objectOnly: true
					});
					if (body === null) {
						writeJson(res, 400, { error: "invalid JSON body" });
						return;
					}
					const { name, path } = body;
					if (typeof name !== "string" || !isSkillName(name) || typeof path !== "string" || path.trim() === "") {
						writeJson(res, 400, { error: "expected { name, path }" });
						return;
					}
					const skill = await resolveScannedSkill(name, path, panelCwd(), res);
					if (skill === void 0) return;
					if (skill.linked === true) {
						writeJson(res, 400, { error: `skill ${name} is a linked skill and cannot be deleted` });
						return;
					}
					writeJson(res, 200, {
						ok: true,
						name,
						moved: await trashSkillFile(skill.path)
					});
				} catch (error) {
					logger.warn(error);
					writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
				}
			}
		},
		{
			kind: "exact",
			path: ROUTES.health,
			handler: async (req, res) => {
				if (!guard(req, res, "GET")) return;
				try {
					const { skills } = await collectSkills(await collectOptions(panelCwd()));
					writeJson(res, 200, {
						ok: true,
						plugin: "skill-explorer",
						skills: skills.length
					});
				} catch (error) {
					logger.warn(error);
					writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
				}
			}
		}
	];
}
//#endregion
//#region src/mount-once.ts
/**
* Host single-instance guard shared by the plugin family. The family bundle
* (dsh-web-all / dsh-skins) namespaces every child row id (web-ui-*), so
* the loader accepts a standalone install of the same package side by side;
* without this guard the second instance would still re-register the same
* webserver routes, tools, settings namespaces, and system-prompt sections
* and fail the boot. mountOnce makes a mount of an already-mounted package a
* no-op for as long as the first instance lives (the browser half is already
* deduped by package name in the client module host).
*
* A no-op is only safe while the holder is ALIVE. The holder can be disposed
* long after the refused mount ran its course: the Host reloads a profile by
* creating the new loader entries before the old ones are torn down (a
* plugin-manager enable/disable/install write, a settings-driven row reload,
* HMR), so the new aggregate shell entry mounts its family plugin while the
* previous entry still owns the name. Dropping that refused mount lost the
* plugin for good - the previous entry then disposed its own mount, releasing
* the name with nobody left to take it, and the family row stayed listed as
* active while its host routes 404ed (the task-board panel showed
* "board.hostError.notMounted", no degraded record appeared, and only a Host
* restart recovered it).
*
* The refused mount is therefore QUEUED, not dropped, and replayed the moment
* the holder releases the name - if the waiting fiber is still alive then. The
* single-instance guarantee is unchanged: exactly one mount is live per
* package name, and the replay re-enters the guard so a later mount still
* dedupes against it.
*
* The registry rides a global symbol so two module instances of the same
* package (npm copy vs repository link) still share one verdict. That symbol
* is a CROSS-REPOSITORY contract, not this file's private state: the four
* satellite packages (dsh-skins / dsh-pet / dsh-presets /
* dsh-community-plugins) are separate repositories carrying their own copy of
* this guard, rebuilt on their own schedule, so the value under `MOUNTED`
* must keep the shape every published copy reads (a `Set` of package names
* with `has`/`add`/`delete`). The wait queues this guard added therefore live
* under their own additive key, and the registry reads back a `Set` even when
* some other build left a different value there. Changing `MOUNTED`'s shape
* in place broke that contract once: a satellite's legacy copy created a
* `Set`, the family's new copy read it as a `Map`, and every family row
* mounted after it failed with "claims.get is not a function".
*
* cordis `ctx.effect` runs its callback immediately and treats the callback's
* return value as the fiber disposer, so the unmarker is returned, not run.
*/
/** Published cross-repository contract: package names currently mounted. */
const MOUNTED = Symbol.for("dsh-web.mounted-plugins");
/** Additive key this guard owns: refused mounts waiting for the name. */
const WAITERS = Symbol.for("dsh-web.mounted-plugins.waiters");
/**
* The shared name registry, always a `Set` whatever another build stored here:
* a foreign value (an interim shape, a hand-written global) must not take every
* family plugin down with it.
* @returns the process-wide set of mounted package names.
*/
function mountedSet() {
	const registry = globalThis;
	const existing = registry[MOUNTED];
	if (existing instanceof Set) return existing;
	const created = /* @__PURE__ */ new Set();
	registry[MOUNTED] = created;
	return created;
}
/** Queue per package name for mounts refused while a holder was alive. */
function mountWaiters() {
	const registry = globalThis;
	return registry[WAITERS] ??= /* @__PURE__ */ new Map();
}
/**
* Wrap a cordis plugin apply so the package runs at most once per process.
* The first mount registers normally and releases the name when its fiber
* disposes; a mount refused while that name is held waits for the release and
* then runs, unless its own fiber disposes first.
* @param packageName - npm package identity shared by every install source.
* @param fn - the original plugin apply.
* @returns an apply of the same shape.
*/
function mountOnce(packageName, fn) {
	const mount = (...args) => {
		const mounted = mountedSet();
		const ctx = args[0];
		if (mounted.has(packageName)) {
			const waiters = mountWaiters();
			const queue = waiters.get(packageName) ?? [];
			let alive = true;
			const pending = { run: () => {
				if (alive) mount(...args);
			} };
			ctx?.effect?.(() => () => {
				alive = false;
				const index = queue.indexOf(pending);
				if (index >= 0) queue.splice(index, 1);
			});
			queue.push(pending);
			waiters.set(packageName, queue);
			return;
		}
		mounted.add(packageName);
		ctx?.effect?.(() => () => {
			mounted.delete(packageName);
			const waiters = mountWaiters();
			const queue = waiters.get(packageName);
			if (queue === void 0) return;
			waiters.delete(packageName);
			for (const waiter of queue.splice(0)) queueMicrotask(() => {
				waiter.run();
			});
		});
		return fn(...args);
	};
	return mount;
}
//#endregion
//#region src/index.ts
/**
* skill-explorer — host half. Serves the skill center data source: the
* /api/dsh-skill-explorer route family (list grouped by source, set enabled,
* create, delete, health) over the shared trust fence (loopback by default;
* a live paired-device cookie is an extra allow path). The browser half
* (./client) renders the skill center panel.
*
* Ported from the local dsh-skill-explorer plugin; everything rides official
* NPM SDK packages — no dsh source changes.
*/
/** Stable cordis plugin name. */
const name = "skill-explorer";
/** Services required before the skill center routes can mount. */
const inject = [
	"webServer",
	"skills",
	"sessions"
];
/**
* Mount the skill center routes (trust fence looks up remoteWebUiPairing on ctx).
* @param ctx - host plugin context carrying webServer/skills/sessions.
* @param config - resolved plugin config.
*/
function applyImpl(ctx, config) {
	if (config?.enabled === false) return;
	const skillCtx = ctx;
	const dshHome = config?.dshHome ?? process.env.DSH_HOME ?? homedir() + sep + ".dsh";
	const agentsHome = config?.agentsHome ?? process.env.DSH_AGENTS_HOME ?? homedir() + sep + ".agents";
	/**
	* Every custom skill root the panel should scan: this plugin's own config
	* plus whatever the live `skill-filesystem` rows declare. The official
	* documented placement is the provider row (a profile patch), not this
	* plugin, so reading only `config.customSkillDirs` left those skills
	* listed with no editable path — the "Custom directories" group rendered
	* without controls and every write route answered 404.
	*/
	const customSkillDirs = () => {
		const own = Array.isArray(config?.customSkillDirs) ? config.customSkillDirs : [];
		let fromRows = [];
		try {
			const loader = ctx.get("loader", false);
			if (typeof loader?.entries === "function") fromRows = customSkillDirsFromLoader(loader.entries());
		} catch {
			fromRows = [];
		}
		return normalizeSkillRoots([...own, ...fromRows]);
	};
	/** Active session workspace cwds (degraded to [] when the registry is unavailable). */
	const activeSessionCwds = () => {
		try {
			const sessions = skillCtx.sessions;
			if (typeof sessions?.list !== "function") return [];
			return sessions.list().map((session) => session.header?.cwd).filter((cwd) => typeof cwd === "string" && cwd !== "");
		} catch {
			return [];
		}
	};
	const routes = makeRoutes(ctx, {
		dshHome,
		agentsHome,
		customSkillDirs,
		registry: skillCtx.skills,
		activeSessionCwds,
		logger: { warn: (error) => ctx.logger.warn(error) }
	});
	ctx.effect(() => {
		const disposers = routes.map((route) => ctx.webServer.register(route));
		return () => {
			for (const dispose of disposers) dispose();
		};
	}, "skill-explorer: routes");
}
/**
* Single-instance guard shared by the plugin family: the aggregate bundle
* (dsh-web-all) and a standalone install of this package can coexist in
* one profile, so the second host apply must be a no-op instead of
* re-registering the same routes and failing the boot.
*/
const apply = mountOnce("dsh-skill-explorer", applyImpl);
//#endregion
export { ROUTES, apply, inject, name };
