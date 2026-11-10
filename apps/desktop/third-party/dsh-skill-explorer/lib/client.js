window.__ModuleLoader__.load({
	id: "dsh-skill-explorer",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/api.ts
		/**
		* Skill center API client (browser half). Talks to the host route family over
		* same-origin fetch; the host enforces the trust fence on its side.
		*/
		/**
		* Route paths mirrored from the host (src/routes.ts ROUTES).
		*
		* DOCUMENT-RELATIVE on purpose (no leading slash): the harness serves the GUI
		* with `<base href="./">`, so a sub-path deployment (`/dsh/dsh/`) is the
		* entry directory. A root-absolute `/api/...` escapes that prefix and the
		* request never reaches the plugin's route (issue #1707); the official client
		* posts its own routes the same way (`api/session.list`).
		*/
		const API = {
			list: "api/dsh-skill-explorer/list",
			read: "api/dsh-skill-explorer/read",
			setEnabled: "api/dsh-skill-explorer/set-enabled",
			setProviderEnabled: "api/dsh-skill-explorer/set-provider-enabled",
			create: "api/dsh-skill-explorer/create",
			update: "api/dsh-skill-explorer/update",
			delete: "api/dsh-skill-explorer/delete",
			import: "api/dsh-skill-explorer/import"
		};
		/** One thrown API error with the host-provided message. */
		var ApiError = class extends Error {};
		/** Skill center API client. */
		var SkillApi = class {
			/** Fetch the grouped skill list. */
			async list(cwd) {
				const url = typeof cwd === "string" && cwd.trim() !== "" ? `${API.list}?cwd=${encodeURIComponent(cwd)}` : API.list;
				return this.request(url);
			}
			/** Enable or disable a skill (rewrites disable-model-invocation). */
			async setEnabled(name, path, enabled) {
				return this.request(API.setEnabled, {
					method: "POST",
					body: {
						name,
						path,
						enabled
					}
				});
			}
			/**
			* Switch a plugin-provided skill off/on in this panel.
			*
			* There is no path to certify: the row's file belongs to the provider and
			* sits outside the roots this panel scans, so the host records the
			* (provider, name) pair in the panel's own store instead of rewriting a
			* SKILL.md the panel does not own. The host answers with the stored state;
			* the invocable view itself comes from the next list call.
			*/
			async setProviderEnabled(name, provider, enabled) {
				return this.request(API.setProviderEnabled, {
					method: "POST",
					body: {
						name,
						provider,
						enabled
					}
				});
			}
			/** Create a skill file under the user or project root. */
			async create(payload) {
				return this.request(API.create, {
					method: "POST",
					body: payload
				});
			}
			/** One skill's editable fields and body, resolved from the panel's path. */
			async read(name, path) {
				return this.request(`${API.read}?name=${encodeURIComponent(name)}&path=${encodeURIComponent(path)}`);
			}
			/** Rewrite an existing skill file in place (name and location unchanged). */
			async update(payload) {
				return this.request(API.update, {
					method: "POST",
					body: payload
				});
			}
			/**
			* Batch-create skills from a host directory or a .zip archive.
			*
			* The directory form names a path on the host (the route is loopback-only,
			* so the browser and the host are the same machine by construction); the
			* archive form carries the bytes the browser read, base64-encoded, so the
			* user can pick a file through the ordinary file dialog. Both only ever
			* create new files under the chosen root; a name that already resolves at
			* the same or a stronger source comes back skipped with its reason.
			*/
			async importSkills(payload) {
				return this.request(API.import, {
					method: "POST",
					body: payload
				});
			}
			/** Delete a skill (moves it into .trash). */
			async remove(name, path) {
				return this.request(API.delete, {
					method: "POST",
					body: {
						name,
						path
					}
				});
			}
			async request(path, options = {}) {
				const headers = options.body === void 0 ? new Headers() : new Headers({ "content-type": "application/json" });
				const response = await fetch(path, {
					method: options.method ?? "GET",
					headers,
					body: options.body === void 0 ? void 0 : JSON.stringify(options.body)
				});
				let body;
				try {
					body = await response.json();
				} catch {
					body = void 0;
				}
				if (!response.ok) throw new ApiError(typeof body === "object" && body !== null && typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
				return body;
			}
		};
		//#endregion
		//#region src/client/panel/controller.ts
		/** Stable id shared by the sidebar panel row and the main-slot page. */
		const SKILL_EXPLORER_PANEL_ID = "skill-explorer";
		/** The panel state owner the sidebar row and the view both read. */
		var PanelController = class {
			deps;
			panelOpen = false;
			activeTab = "skills";
			editing;
			template;
			listeners = /* @__PURE__ */ new Set();
			/** Cached so getSnapshot stays referentially stable between changes. */
			snapshot = {
				panelOpen: false,
				activeTab: "skills",
				editing: void 0,
				template: void 0
			};
			constructor(deps = {}) {
				this.deps = deps;
			}
			getSnapshot() {
				return this.snapshot;
			}
			subscribe(fn) {
				this.listeners.add(fn);
				return () => {
					this.listeners.delete(fn);
				};
			}
			/**
			* Show the panel. The layout owns which panel the column renders, so the
			* state flip and the selection travel together; the selection is requested
			* after the snapshot flips, so a subscriber never observes "open" while the
			* shell still shows the conversation.
			*/
			open() {
				if (this.panelOpen) return;
				this.panelOpen = true;
				this.commit();
				this.selectPanel(SKILL_EXPLORER_PANEL_ID);
			}
			/** Return the column to the conversation, asking the layout explicitly. */
			close() {
				if (!this.panelOpen) return;
				this.panelOpen = false;
				this.commit();
				this.selectPanel(null);
			}
			toggle() {
				if (this.panelOpen) this.close();
				else this.open();
			}
			/**
			* Reflect a selection made outside this controller (the user clicked another
			* sidebar row, or the layout dropped the panel id), keeping `panelOpen`
			* aligned with what the column actually shows.
			* @param panelId - the layout's current panel id, or null for the conversation.
			*/
			syncPanelSelection(panelId) {
				const open = panelId === SKILL_EXPLORER_PANEL_ID;
				if (open === this.panelOpen) return;
				this.panelOpen = open;
				this.commit();
			}
			/** Switch tabs without touching the editor target. */
			setActiveTab(tab) {
				if (this.activeTab === tab) return;
				this.activeTab = tab;
				this.commit();
			}
			/** Open the editor for one row; the edit tab appears while it is set. */
			openEditor(skill) {
				this.editing = skill;
				this.activeTab = "edit";
				this.commit();
			}
			/** Leave the editor; the list remounts and refetches the saved copy. */
			closeEditor() {
				this.editing = void 0;
				this.activeTab = "skills";
				this.commit();
			}
			/**
			* Open the create tab prefilled from an existing skill. Leaving the editor
			* target alone keeps a half-finished edit reachable from its own tab.
			*/
			openCreateFromTemplate(draft) {
				this.template = draft;
				this.activeTab = "create";
				this.commit();
			}
			/**
			* Drop the pending template, so a later visit to the create tab starts from
			* a blank form. Called when the template has been used or dismissed.
			*/
			clearTemplate() {
				if (this.template === void 0) return;
				this.template = void 0;
				this.commit();
			}
			commit() {
				this.snapshot = {
					panelOpen: this.panelOpen,
					activeTab: this.activeTab,
					editing: this.editing,
					template: this.template
				};
				for (const fn of [...this.listeners]) fn();
			}
			/** Ask the layout to select a panel; a shell without the face is a no-op. */
			selectPanel(panelId) {
				try {
					this.deps.panel?.select(panelId);
				} catch {}
			}
		};
		//#endregion
		//#region src/client/locales.ts
		/**
		* skill-explorer surface copy: zh is the key source, en mirrors every key.
		*/
		const zh = {
			"entry.label": "技能中心",
			"entry.tooltip": "技能中心：浏览与管理已加载的 skill",
			"panel.title": "技能中心",
			"dialog.close": "关闭",
			"tab.list": "技能",
			"tab.create": "创建",
			"tab.import": "导入",
			"tab.edit": "编辑技能",
			"group.bundled": "系统内置",
			"group.project-dsh": "项目技能（.dsh/skills）",
			"group.project-agents": "项目技能（.agents/skills）",
			"group.custom": "自定义目录",
			"group.user-dsh": "用户技能（~/.dsh/skills）",
			"group.user-agents": "用户技能（~/.agents/skills）",
			"group.runtime": "运行时注册",
			"groupHint.bundled": "DSH 内置与插件随附的全局技能",
			"groupHint.project-dsh": "存放于项目目录，作用于所在项目",
			"groupHint.project-agents": "存放于项目目录，作用于对应项目",
			"groupHint.custom": "customSkillDirs 自定义配置目录",
			"groupHint.user-dsh": "全局技能（~/.dsh/skills），本机所有项目共享",
			"groupHint.user-agents": "全局技能（~/.agents/skills），本机所有项目共享",
			"groupHint.runtime": "插件运行时代码内嵌注册",
			"list.loading": "加载中…",
			"list.loadFailed": "加载失败：{error}",
			"list.empty": "当前没有已加载的 skill。",
			"list.count": "{count} 个",
			"list.when": "适用：{when}",
			"list.invokable": "可调用：{marks}",
			"list.invokableTooltip": "模型可自动调用该技能；手动 /skill 指令不受影响",
			"list.linked": "软链接",
			"list.noFile": "无本地文件",
			"list.noFileTooltip": "该技能由插件在运行时注册或随包提供，没有 SKILL.md 文件",
			"list.noFileHint": "该技能没有本地 SKILL.md 文件，无法在此启用/禁用、编辑或删除。",
			"list.providerFile": "由插件提供",
			"list.providerFileTooltip": "该技能的文件由插件 provider 提供，未落在本面板扫描的技能根目录下",
			"list.providerFileHint": "该技能由插件提供、确有 SKILL.md 文件，但不在本面板扫描的技能根目录下，因此无法在此编辑或删除；开关只改变本面板的可调用视图，不会改变模型实际加载的技能。",
			"list.mark.model": "模型",
			"list.mark.user": "用户",
			"provider.filesystem": "文件系统",
			"provider.tooltip": "技能来源：{provider}",
			"list.enabled": "已启用：模型可调用（点击禁用）",
			"list.disabled": "已禁用：模型不可调用（点击启用）",
			"list.toggleFailed": "操作失败：{error}",
			"list.delete": "删除",
			"list.deleteConfirm": "删除技能「{name}」？将移入 .trash。",
			"list.deleteFailed": "删除失败：{error}",
			"list.edit": "编辑",
			"list.duplicate": "复制为模板",
			"list.duplicateFailed": "复制失败：{error}",
			"create.root": "创建位置",
			"create.root.user": "用户技能（~/.dsh/skills，所有项目可用）",
			"create.root.project": "项目技能（当前项目 .dsh/skills）",
			"create.name": "技能名（kebab-case，与文件目录同名）",
			"create.namePlaceholder": "如 my-workflow",
			"create.description": "描述（模型判断触发条件的依据）",
			"create.whenToUse": "适用场景（可选）",
			"create.content": "指令内容（SKILL.md 正文，Markdown）",
			"create.submit": "创建技能",
			"create.empty": "技能名/描述/内容不能为空",
			"create.created": "已创建：{path}",
			"create.failed": "创建失败：{error}",
			"create.note": "创建后立即生效（skill-filesystem 会热扫描）。内容会作为指令注入模型上下文——不要写入敏感信息。",
			"create.template": "来自模板「{name}」：改好名称与字段后再创建。",
			"create.templateClear": "清除模板",
			"edit.name": "技能名（不可修改）",
			"edit.loading": "正在读取技能内容…",
			"edit.loadFailed": "读取失败：{error}",
			"edit.submit": "保存修改",
			"edit.back": "返回列表",
			"edit.failed": "保存失败：{error}",
			"edit.note": "只改描述、适用场景与正文：技能名、位置和启用状态保持不变。保存后立即生效（skill-filesystem 会热扫描）。",
			"filter.workspaceLabel": "工作区",
			"filter.workspaceAll": "全部工作区",
			"filter.workspaceCurrent": "当前工作区 ({name})",
			"filter.searchLabel": "搜索",
			"filter.searchPlaceholder": "按名称或描述筛选",
			"filter.empty": "没有匹配「{query}」的技能",
			"filter.emptyWorkspace": "当前筛选下没有技能。",
			"filter.toggle": "筛选",
			"filter.sourceLabel": "来源",
			"filter.statusLabel": "状态",
			"filter.status.all": "全部",
			"filter.status.enabled": "已启用",
			"filter.status.disabled": "已禁用",
			"filter.markLabel": "标记",
			"filter.mark.provider-file": "由插件提供",
			"filter.mark.no-file": "无本地文件",
			"filter.mark.linked": "软链接",
			"filter.clear": "清除筛选",
			"import.open": "导入",
			"import.root": "导入到",
			"import.source": "导入来源",
			"import.source.directory": "本地目录",
			"import.source.archive": ".zip 压缩包",
			"import.directoryLabel": "目录路径（本机绝对路径）",
			"import.directoryPlaceholder": "包含 <名称>/SKILL.md 的目录",
			"import.archiveLabel": "选择 .zip 文件",
			"import.submit": "开始导入",
			"import.summary": "已导入 {imported} 个，跳过 {skipped} 个。",
			"import.imported": "已导入",
			"import.reason.unknown": "已跳过",
			"import.reason.invalid-frontmatter": "frontmatter 缺少名称或描述",
			"import.reason.invalid-name": "名称不符合 kebab-case 规则",
			"import.reason.too-large": "内容超过 64KB",
			"import.reason.duplicate": "同一来源中重名",
			"import.reason.exists": "该位置已有同名技能",
			"import.reason.shadowed": "已被更高优先级的来源覆盖",
			"import.failed": "导入失败：{error}",
			"import.directoryRequired": "请填写要导入的目录",
			"import.archiveRequired": "请选择 .zip 文件",
			"import.archiveTooLarge": "压缩包不能超过 {size}",
			"import.note": "导入只新建文件，不会覆盖已有技能。同名冲突按官方来源优先级（项目 100 → 内置 600）裁决：优先级更高的同名技能不会被替换，对应条目显示为跳过。目录导入只读取一层（<名称>/SKILL.md 或 <名称>.md），软链接与点目录会被忽略。",
			"workspace.isolated": "工作区隔离",
			"workspace.isolatedHint": "该技能属于工作区「{workspace}」，在当前会话上下文隔离不生效",
			"refresh": "刷新"
		};
		const en = {
			"entry.label": "Skill Center",
			"entry.tooltip": "Skill center: browse and manage loaded skills",
			"panel.title": "Skill Center",
			"dialog.close": "Close",
			"tab.list": "Skills",
			"tab.create": "Create",
			"tab.import": "Import",
			"tab.edit": "Edit skill",
			"group.bundled": "System bundled",
			"group.project-dsh": "Project skills (.dsh/skills)",
			"group.project-agents": "Project skills (.agents/skills)",
			"group.custom": "Custom directories",
			"group.user-dsh": "User skills (~/.dsh/skills)",
			"group.user-agents": "User skills (~/.agents/skills)",
			"group.runtime": "Runtime registered",
			"groupHint.bundled": "Global skills shipped with DSH and its plugins",
			"groupHint.project-dsh": "Located in the project directory, scoped to its workspace",
			"groupHint.project-agents": "Located in the project directory, scoped to its workspace",
			"groupHint.custom": "customSkillDirs config",
			"groupHint.user-dsh": "Global skills (~/.dsh/skills), shared across all projects",
			"groupHint.user-agents": "Global skills (~/.agents/skills), shared across all projects",
			"groupHint.runtime": "Skills registered at runtime by plugins",
			"list.loading": "Loading…",
			"list.loadFailed": "Failed to load: {error}",
			"list.empty": "No skills loaded yet.",
			"list.count": "{count}",
			"list.when": "When: {when}",
			"list.invokable": "Invokable: {marks}",
			"list.invokableTooltip": "The model can invoke this skill automatically; manual /skill commands remain available",
			"list.linked": "symlinked",
			"list.noFile": "No local file",
			"list.noFileTooltip": "This skill is registered at runtime or shipped by a plugin, so it has no SKILL.md file",
			"list.noFileHint": "This skill has no local SKILL.md file, so it cannot be enabled/disabled, edited, or deleted here.",
			"list.providerFile": "Provided by plugin",
			"list.providerFileTooltip": "This skill has a file supplied by its plugin provider, outside the skill roots this panel scans",
			"list.providerFileHint": "This skill is supplied by a plugin and does have a SKILL.md file, but it sits outside the skill roots this panel scans, so it cannot be edited or deleted here. Its switch only changes what this panel considers invocable; the model still loads the skill.",
			"list.mark.model": "model",
			"list.mark.user": "user",
			"provider.filesystem": "Filesystem",
			"provider.tooltip": "Skill source: {provider}",
			"list.enabled": "Enabled: invokable by the model (click to disable)",
			"list.disabled": "Disabled: not invokable by the model (click to enable)",
			"list.toggleFailed": "Operation failed: {error}",
			"list.delete": "Delete",
			"list.deleteConfirm": "Delete skill \"{name}\"? It moves into .trash.",
			"list.deleteFailed": "Delete failed: {error}",
			"list.edit": "Edit",
			"list.duplicate": "Duplicate as template",
			"list.duplicateFailed": "Duplicate failed: {error}",
			"create.root": "Location",
			"create.root.user": "User skills (~/.dsh/skills, available to all projects)",
			"create.root.project": "Project skills (current project .dsh/skills)",
			"create.name": "Skill name (kebab-case, same as the directory name)",
			"create.namePlaceholder": "e.g. my-workflow",
			"create.description": "Description (how the model decides when to trigger)",
			"create.whenToUse": "When to use (optional)",
			"create.content": "Instructions (SKILL.md body, Markdown)",
			"create.submit": "Create skill",
			"create.empty": "Skill name/description/content must not be empty",
			"create.created": "Created: {path}",
			"create.failed": "Create failed: {error}",
			"create.note": "The skill takes effect immediately (skill-filesystem hot-scans). Its content is injected into the model context as instructions — do not put sensitive information in it.",
			"create.template": "Copied from the template \"{name}\": adjust the name and fields before creating.",
			"create.templateClear": "Clear template",
			"edit.name": "Skill name (fixed)",
			"edit.loading": "Loading the skill…",
			"edit.loadFailed": "Failed to load: {error}",
			"edit.submit": "Save changes",
			"edit.back": "Back to list",
			"edit.failed": "Save failed: {error}",
			"edit.note": "Only the description, when-to-use, and body change: the name, location, and enabled state stay as they are. The edit takes effect immediately (skill-filesystem hot-scans).",
			"filter.workspaceLabel": "Workspace",
			"filter.workspaceAll": "All workspaces",
			"filter.workspaceCurrent": "Current workspace ({name})",
			"filter.searchLabel": "Search",
			"filter.searchPlaceholder": "Filter by name or description",
			"filter.empty": "No skills match \"{query}\"",
			"filter.emptyWorkspace": "No skills under the current filter.",
			"filter.toggle": "Filters",
			"filter.sourceLabel": "Source",
			"filter.statusLabel": "Status",
			"filter.status.all": "All",
			"filter.status.enabled": "Enabled",
			"filter.status.disabled": "Disabled",
			"filter.markLabel": "Marks",
			"filter.mark.provider-file": "Provided by plugin",
			"filter.mark.no-file": "No local file",
			"filter.mark.linked": "Symlinked",
			"filter.clear": "Clear filters",
			"import.open": "Import",
			"import.root": "Import into",
			"import.source": "Import source",
			"import.source.directory": "Local directory",
			"import.source.archive": ".zip archive",
			"import.directoryLabel": "Directory path (absolute, on this machine)",
			"import.directoryPlaceholder": "A directory holding <name>/SKILL.md",
			"import.archiveLabel": "Choose a .zip file",
			"import.submit": "Import skills",
			"import.summary": "Imported {imported}, skipped {skipped}.",
			"import.imported": "Imported",
			"import.reason.unknown": "Skipped",
			"import.reason.invalid-frontmatter": "Frontmatter lacks a name or description",
			"import.reason.invalid-name": "Name is not kebab-case",
			"import.reason.too-large": "Content exceeds 64KB",
			"import.reason.duplicate": "Duplicate name in the same source",
			"import.reason.exists": "A skill with this name already lives there",
			"import.reason.shadowed": "A stronger source already provides this name",
			"import.failed": "Import failed: {error}",
			"import.directoryRequired": "Enter the directory to import",
			"import.archiveRequired": "Choose a .zip file",
			"import.archiveTooLarge": "The archive must not exceed {size}",
			"import.note": "Import only creates files; it never overwrites an existing skill. A same-name conflict resolves by the official source rank (project 100 → bundled 600): a stronger same-name skill is left alone and the candidate is listed as skipped. A directory import reads one level (<name>/SKILL.md or <name>.md); symlinks and dot entries are ignored.",
			"workspace.isolated": "Workspace isolated",
			"workspace.isolatedHint": "This skill belongs to workspace \"{workspace}\" and is isolated from the current session context",
			"refresh": "Refresh"
		};
		//#endregion
		//#region src/client/panel-helpers.ts
		/**
		* Shared panel helpers: the active-dictionary pick (document-language based)
		* and the tiny {name} interpolator. All copy stays in locales.ts.
		*/
		/** Active dictionary, picked by the document language at call time. */
		function dictionary() {
			return (typeof document !== "undefined" ? document.documentElement.lang : "zh").toLowerCase().startsWith("en") ? { ...en } : { ...zh };
		}
		/**
		* SDK translate seat wired by the browser apply() once ctx.locale is bound
		* (setRuntimeTranslate): reads the ACTIVE locale at call time, so plain-DOM
		* surfaces follow a runtime language switch. The document-language pick stays
		* as the unwired fallback (locale service absent, module-scope early callers).
		*/
		let runtimeT;
		/** Wire the SDK translate seat; pass undefined to restore the document-language pick. */
		function setRuntimeTranslate(t) {
			runtimeT = t;
		}
		/** Translate a key with optional {name} template params (current language). */
		function tt(key, values) {
			if (runtimeT !== void 0) return runtimeT(key, values);
			let text = dictionary()[key] ?? key;
			if (values !== void 0) for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, String(value));
			return text;
		}
		//#endregion
		//#region \0dsh-css:src/client/panel/panel.module.css.mjs
		const css = ".jbF1yq_view{height:100%;min-height:0;overflow:hidden}.jbF1yq_panel{background:var(--dsw-alias-bg-base);min-width:0;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);flex-direction:column;gap:10px;padding:14px 16px 16px;display:flex}.jbF1yq_panelHeader{flex:none;align-items:center;gap:10px;display:flex}.jbF1yq_panelTitle{color:var(--dsw-alias-label-primary);white-space:nowrap;flex:1;margin:0;font-size:16px;font-weight:700}.jbF1yq_tabBar{border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;gap:2px;display:flex}.jbF1yq_tab{color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;background:0 0;border:none;border-bottom:2px solid #0000;border-radius:6px 6px 0 0;padding:7px 14px;font-size:13px}.jbF1yq_tab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}.jbF1yq_tab[data-active]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-state-business-primary);font-weight:600}.jbF1yq_panelContent{flex-direction:column;flex:1;min-height:0;display:flex;overflow:hidden}.jbF1yq_fillBody{flex-direction:column;flex:1;gap:10px;min-height:0;display:flex;overflow:hidden}.jbF1yq_tabBody{flex-direction:column;flex:1;gap:10px;min-height:0;display:flex;overflow-y:auto}.jbF1yq_toolbar{flex-wrap:wrap;flex:none;align-items:center;gap:8px;display:flex}.jbF1yq_search{min-width:120px;color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;outline:none;flex:0 260px;padding:6px 10px;font-size:13px}.jbF1yq_search::placeholder{color:var(--dsw-alias-label-tertiary)}.jbF1yq_select{color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;outline:none;padding:6px 8px;font-size:13px}.jbF1yq_toolbarSpacer{flex:1}.jbF1yq_checkboxLabel{color:var(--dsw-alias-label-secondary);cursor:pointer;align-items:center;gap:6px;font-size:12px;display:inline-flex}.jbF1yq_facetBar{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;flex-direction:column;flex:none;gap:6px;padding:8px 10px;display:flex}.jbF1yq_facetRow{flex-wrap:wrap;align-items:center;gap:6px;display:flex}.jbF1yq_facetLabel{min-width:34px;color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600}.jbF1yq_facetChip{color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2);cursor:pointer;white-space:nowrap;background:0 0;border-radius:999px;align-items:center;gap:5px;padding:2px 9px;font-size:11.5px;line-height:1.7;display:inline-flex}.jbF1yq_facetChip:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}.jbF1yq_facetChip[data-active]{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover)}.jbF1yq_facetCount{color:var(--dsw-alias-label-tertiary);font-size:10.5px}.jbF1yq_facetChip[data-active] .jbF1yq_facetCount{color:var(--dsw-alias-state-business-primary)}.jbF1yq_ghostButton[data-active]{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}.jbF1yq_ghostButton{color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);cursor:pointer;white-space:nowrap;background:0 0;border-radius:8px;padding:5px 12px;font-size:12px}.jbF1yq_ghostButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.jbF1yq_ghostButton:disabled{opacity:.45;cursor:default}.jbF1yq_formActions{align-items:center;gap:8px;display:flex}.jbF1yq_primaryButton{color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-button-primary-fill);cursor:pointer;white-space:nowrap;border:none;border-radius:8px;align-self:flex-start;padding:6px 14px;font-size:13px;font-weight:600}.jbF1yq_primaryButton:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}.jbF1yq_primaryButton:disabled{opacity:.5;cursor:default}.jbF1yq_linkButton{color:var(--dsw-alias-state-business-primary);cursor:pointer;white-space:nowrap;background:0 0;border:none;padding:0;font-size:12px}.jbF1yq_linkButton:hover:not(:disabled){text-decoration:underline}.jbF1yq_linkButton:disabled{opacity:.45;cursor:default}.jbF1yq_linkButton[data-danger]{color:var(--dsw-alias-state-error-primary)}.jbF1yq_banner{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;border-radius:8px;padding:8px 12px;font-size:12.5px;line-height:1.5}.jbF1yq_banner[data-kind=ok]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}.jbF1yq_banner[data-kind=error]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}.jbF1yq_empty{text-align:center;color:var(--dsw-alias-label-tertiary);padding:28px 12px;font-size:12.5px}.jbF1yq_list{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;flex-direction:column;flex:1;gap:14px;min-height:0;padding:8px 12px 10px;display:flex;overflow-y:auto}.jbF1yq_group{flex-direction:column;gap:6px;display:flex}.jbF1yq_groupToggle{width:100%;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left;background:0 0;border:none;border-radius:6px;align-items:center;gap:6px;padding:4px 2px;font-size:13px;font-weight:600;display:flex}.jbF1yq_groupToggle:hover{background:var(--dsw-alias-interactive-bg-hover)}.jbF1yq_groupCaret{border-bottom:1.5px solid;border-right:1.5px solid;flex:none;width:6px;height:6px;transition:transform .15s;transform:rotate(-45deg)}.jbF1yq_groupToggle[aria-expanded=true] .jbF1yq_groupCaret{transform:rotate(45deg)}.jbF1yq_groupTitleText{font-weight:600}.jbF1yq_count{color:var(--dsw-alias-label-secondary);margin-left:6px;font-weight:400}.jbF1yq_groupHint{color:var(--dsw-alias-label-secondary);margin:0;font-size:11px}.jbF1yq_skillGrid{grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;padding:4px 0 8px;display:grid}.jbF1yq_skillCard{background:var(--dsw-alias-interactive-bg-hover);border:1px solid #0000;border-radius:12px;flex-direction:column;gap:8px;min-width:0;padding:12px 14px;transition:border-color .15s,background .15s;display:flex}.jbF1yq_skillCard:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base)}.jbF1yq_cardHead{align-items:flex-start;gap:10px;display:flex}.jbF1yq_skillAvatar{border-radius:9px;flex:none;justify-content:center;align-items:center;width:32px;height:32px;font-size:14px;font-weight:600;line-height:1;display:flex}.jbF1yq_cardIdentity{flex-direction:column;gap:2px;min-width:0;display:flex}.jbF1yq_cardMeta{color:var(--dsw-alias-label-secondary);white-space:nowrap;text-overflow:ellipsis;font-size:11px;overflow:hidden}.jbF1yq_cardControls{flex:none;align-items:center;gap:6px;margin-left:auto;display:flex}.jbF1yq_cardControls .jbF1yq_switch{margin-left:0}.jbF1yq_cardTags{flex-wrap:wrap;gap:6px;display:flex}.jbF1yq_cardActions{border-top:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap;gap:10px;margin-top:auto;padding-top:6px;display:flex}.jbF1yq_skillName{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;font-family:var(--ds-font-family-code)}.jbF1yq_badge{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap;border-radius:999px;padding:1px 8px;font-size:11px;line-height:1.6;display:inline-block}.jbF1yq_badgeWorkspace{color:var(--dsw-alias-label-secondary)}.jbF1yq_badgeInvokable{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}.jbF1yq_badgeIsolated,.jbF1yq_badgeDisabled{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}.jbF1yq_skillIsolated{opacity:.76}.jbF1yq_skillIsolated:hover{opacity:.98}.jbF1yq_switch{cursor:pointer;background:0 0;border:none;border-radius:99px;align-items:center;margin-left:auto;padding:2px;display:inline-flex}.jbF1yq_switch:disabled{opacity:.45;cursor:default}.jbF1yq_switchTrack{background:var(--dsw-alias-border-l2);border-radius:99px;flex:none;width:30px;height:16px;transition:background .18s;position:relative}.jbF1yq_switchThumb{background:var(--dsw-alias-bg-base);border-radius:50%;width:12px;height:12px;transition:left .18s;position:absolute;top:2px;left:2px}.jbF1yq_switch[aria-checked=true] .jbF1yq_switchTrack{background:var(--dsw-alias-state-success-primary)}.jbF1yq_switch[aria-checked=true] .jbF1yq_switchThumb{left:16px}.jbF1yq_deleteButton{margin-left:4px}.jbF1yq_skillDesc{color:var(--dsw-alias-label-primary);-webkit-line-clamp:3;-webkit-box-orient:vertical;margin:0;font-size:12px;line-height:1.5;display:-webkit-box;overflow:hidden}.jbF1yq_skillWhen{color:var(--dsw-alias-label-secondary);margin:4px 0 0;font-size:11px}.jbF1yq_skillPath{color:var(--dsw-alias-label-tertiary);font-size:10px;font-family:var(--ds-font-family-code);word-break:break-all;margin:6px 0 0}.jbF1yq_form{flex-direction:column;gap:10px;max-width:640px;display:flex}.jbF1yq_field{flex-direction:column;gap:5px;display:flex}.jbF1yq_fieldLabel{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600}.jbF1yq_fieldGroup{border:none;flex-direction:column;gap:5px;margin:0;padding:0;display:flex}.jbF1yq_radioRow{flex-wrap:wrap;align-items:center;gap:14px;display:flex}.jbF1yq_outcomeList{flex-direction:column;gap:4px;max-height:260px;margin:8px 0 0;padding:0;list-style:none;display:flex;overflow-y:auto}.jbF1yq_outcomeItem{flex-wrap:wrap;align-items:baseline;gap:8px;font-size:12px;display:flex}.jbF1yq_outcomeName{font-family:var(--ds-font-family-code);color:var(--dsw-alias-label-primary);font-weight:600}.jbF1yq_outcomeReason{color:var(--dsw-alias-label-secondary);font-size:11.5px}.jbF1yq_outcomeItem[data-status=skipped] .jbF1yq_outcomeReason{color:var(--dsw-alias-state-warn-primary)}.jbF1yq_bannerAction{margin-left:8px}.jbF1yq_input{color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major);border:1px solid var(--dsw-alias-border-l2);resize:vertical;border-radius:8px;outline:none;padding:7px 10px;font-family:inherit;font-size:13px}.jbF1yq_input:focus{border-color:var(--dsw-alias-state-business-primary)}.jbF1yq_input::placeholder{color:var(--dsw-alias-label-tertiary)}.jbF1yq_input:disabled{opacity:.55}.jbF1yq_textarea{min-height:140px;font-family:var(--ds-font-family-code)}.jbF1yq_note{color:var(--dsw-alias-label-tertiary);margin:0;font-size:11px;line-height:1.7}.jbF1yq_dialogOverlay{z-index:60;background:color-mix(in srgb, var(--dsw-alias-label-primary) 28%, transparent);justify-content:center;align-items:flex-start;padding:8vh 24px 24px;display:flex;position:fixed;inset:0}.jbF1yq_dialogPanel{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);width:100%;max-width:560px;max-height:82vh;box-shadow:0 18px 48px color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent);border-radius:14px;flex-direction:column;display:flex;overflow:hidden}.jbF1yq_dialogPanel[data-size=wide]{max-width:720px}.jbF1yq_dialogHead{border-bottom:1px solid var(--dsw-alias-border-l1);align-items:center;gap:12px;padding:14px 18px;display:flex}.jbF1yq_dialogTitle{color:var(--dsw-alias-label-primary);margin:0;font-size:14px;font-weight:600}.jbF1yq_dialogClose{color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:6px;margin-left:auto;padding:2px 6px;font-size:18px;line-height:1}.jbF1yq_dialogClose:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}.jbF1yq_dialogBody{padding:16px 18px 18px;overflow:auto}";
		const tagId = "dsh-skill-explorer/src/client/panel/panel.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-skill-explorer";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var panel_module_css_default = {
			"badge": "jbF1yq_badge",
			"badgeDisabled": "jbF1yq_badgeDisabled",
			"badgeInvokable": "jbF1yq_badgeInvokable",
			"badgeIsolated": "jbF1yq_badgeIsolated",
			"badgeWorkspace": "jbF1yq_badgeWorkspace",
			"banner": "jbF1yq_banner",
			"bannerAction": "jbF1yq_bannerAction",
			"cardActions": "jbF1yq_cardActions",
			"cardControls": "jbF1yq_cardControls",
			"cardHead": "jbF1yq_cardHead",
			"cardIdentity": "jbF1yq_cardIdentity",
			"cardMeta": "jbF1yq_cardMeta",
			"cardTags": "jbF1yq_cardTags",
			"checkboxLabel": "jbF1yq_checkboxLabel",
			"count": "jbF1yq_count",
			"deleteButton": "jbF1yq_deleteButton",
			"dialogBody": "jbF1yq_dialogBody",
			"dialogClose": "jbF1yq_dialogClose",
			"dialogHead": "jbF1yq_dialogHead",
			"dialogOverlay": "jbF1yq_dialogOverlay",
			"dialogPanel": "jbF1yq_dialogPanel",
			"dialogTitle": "jbF1yq_dialogTitle",
			"empty": "jbF1yq_empty",
			"facetBar": "jbF1yq_facetBar",
			"facetChip": "jbF1yq_facetChip",
			"facetCount": "jbF1yq_facetCount",
			"facetLabel": "jbF1yq_facetLabel",
			"facetRow": "jbF1yq_facetRow",
			"field": "jbF1yq_field",
			"fieldGroup": "jbF1yq_fieldGroup",
			"fieldLabel": "jbF1yq_fieldLabel",
			"fillBody": "jbF1yq_fillBody",
			"form": "jbF1yq_form",
			"formActions": "jbF1yq_formActions",
			"ghostButton": "jbF1yq_ghostButton",
			"group": "jbF1yq_group",
			"groupCaret": "jbF1yq_groupCaret",
			"groupHint": "jbF1yq_groupHint",
			"groupTitleText": "jbF1yq_groupTitleText",
			"groupToggle": "jbF1yq_groupToggle",
			"input": "jbF1yq_input",
			"linkButton": "jbF1yq_linkButton",
			"list": "jbF1yq_list",
			"note": "jbF1yq_note",
			"outcomeItem": "jbF1yq_outcomeItem",
			"outcomeList": "jbF1yq_outcomeList",
			"outcomeName": "jbF1yq_outcomeName",
			"outcomeReason": "jbF1yq_outcomeReason",
			"panel": "jbF1yq_panel",
			"panelContent": "jbF1yq_panelContent",
			"panelHeader": "jbF1yq_panelHeader",
			"panelTitle": "jbF1yq_panelTitle",
			"primaryButton": "jbF1yq_primaryButton",
			"radioRow": "jbF1yq_radioRow",
			"search": "jbF1yq_search",
			"select": "jbF1yq_select",
			"skillAvatar": "jbF1yq_skillAvatar",
			"skillCard": "jbF1yq_skillCard",
			"skillDesc": "jbF1yq_skillDesc",
			"skillGrid": "jbF1yq_skillGrid",
			"skillIsolated": "jbF1yq_skillIsolated",
			"skillName": "jbF1yq_skillName",
			"skillPath": "jbF1yq_skillPath",
			"skillWhen": "jbF1yq_skillWhen",
			"switch": "jbF1yq_switch",
			"switchThumb": "jbF1yq_switchThumb",
			"switchTrack": "jbF1yq_switchTrack",
			"tab": "jbF1yq_tab",
			"tabBar": "jbF1yq_tabBar",
			"tabBody": "jbF1yq_tabBody",
			"textarea": "jbF1yq_textarea",
			"toolbar": "jbF1yq_toolbar",
			"toolbarSpacer": "jbF1yq_toolbarSpacer",
			"view": "jbF1yq_view"
		};
		//#endregion
		//#region src/client/panel/CreateTab.tsx
		/**
		* Create tab: the new-skill form (user or project root).
		*
		* The host's create route needs the workspace the panel is showing, which the
		* list payload carries. The inactive tab unmounts, so a user who opens this
		* tab first has no cwd: the first submit resolves it with one list call and
		* reuses it afterwards.
		*
		* A row's "duplicate as template" action leaves a draft in the controller and
		* opens this tab; the draft is read once at mount (the tab remounts on every
		* visit, so a later duplicate hands the next visit a fresh one) and dropped
		* from the controller once the skill is created or the draft is dismissed.
		*/
		/** The create tab body. */
		function CreateTab({ api, controller }) {
			const [template, setTemplate] = (0, react.useState)(() => controller.getSnapshot().template);
			const [root, setRoot] = (0, react.useState)("user");
			const [name, setName] = (0, react.useState)(template?.name ?? "");
			const [description, setDescription] = (0, react.useState)(template?.description ?? "");
			const [whenToUse, setWhenToUse] = (0, react.useState)(template?.whenToUse ?? "");
			const [content, setContent] = (0, react.useState)(template?.content ?? "");
			const [cwd, setCwd] = (0, react.useState)(void 0);
			const [busy, setBusy] = (0, react.useState)(false);
			const [feedback, setFeedback] = (0, react.useState)(void 0);
			/** Blank the form and drop the pending draft, so the next visit starts fresh. */
			const reset = () => {
				setName("");
				setDescription("");
				setWhenToUse("");
				setContent("");
				setTemplate(void 0);
				controller.clearTemplate();
			};
			const submit = async (event) => {
				event.preventDefault();
				if (name.trim() === "" || description.trim() === "" || content.trim() === "") {
					setFeedback({
						text: tt("create.empty"),
						kind: "error"
					});
					return;
				}
				setBusy(true);
				try {
					const workspace = cwd ?? (await api.list()).cwd;
					setCwd(workspace);
					const result = await api.create({
						root,
						name: name.trim(),
						description: description.trim(),
						whenToUse: whenToUse.trim() || void 0,
						content,
						cwd: workspace
					});
					setFeedback({
						text: tt("create.created", { path: result.path }),
						kind: "ok"
					});
					reset();
				} catch (err) {
					setFeedback({
						text: tt("create.failed", { error: err instanceof Error ? err.message : String(err) }),
						kind: "error"
					});
				} finally {
					setBusy(false);
				}
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: panel_module_css_default.tabBody,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
					className: panel_module_css_default.form,
					onSubmit: (event) => {
						submit(event);
					},
					children: [
						template !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: panel_module_css_default.banner,
							"data-dsh-part": "template-banner",
							children: [tt("create.template", { name: template.from }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: `${panel_module_css_default.linkButton} ${panel_module_css_default.bannerAction}`,
								onClick: reset,
								children: tt("create.templateClear")
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: panel_module_css_default.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: panel_module_css_default.fieldLabel,
								children: tt("create.root")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								className: panel_module_css_default.select,
								value: root,
								onChange: (event) => {
									setRoot(event.target.value);
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "user",
									children: tt("create.root.user")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "project",
									children: tt("create.root.project")
								})]
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: panel_module_css_default.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: panel_module_css_default.fieldLabel,
								children: tt("create.name")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: panel_module_css_default.input,
								value: name,
								placeholder: tt("create.namePlaceholder"),
								onChange: (event) => {
									setName(event.target.value);
								}
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: panel_module_css_default.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: panel_module_css_default.fieldLabel,
								children: tt("create.description")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: panel_module_css_default.input,
								value: description,
								onChange: (event) => {
									setDescription(event.target.value);
								}
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: panel_module_css_default.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: panel_module_css_default.fieldLabel,
								children: tt("create.whenToUse")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: panel_module_css_default.input,
								value: whenToUse,
								onChange: (event) => {
									setWhenToUse(event.target.value);
								}
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: panel_module_css_default.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: panel_module_css_default.fieldLabel,
								children: tt("create.content")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
								className: `${panel_module_css_default.input} ${panel_module_css_default.textarea}`,
								value: content,
								onChange: (event) => {
									setContent(event.target.value);
								}
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "submit",
							className: panel_module_css_default.primaryButton,
							disabled: busy,
							children: tt("create.submit")
						}),
						feedback !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: panel_module_css_default.banner,
							"data-kind": feedback.kind,
							children: feedback.text
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: panel_module_css_default.note,
							children: tt("create.note")
						})
					]
				})
			});
		}
		//#endregion
		//#region src/client/panel/Dialog.tsx
		/**
		* Modal shell for the create, import and edit forms.
		*
		* The panel owns one page (the skill list); the forms open over it instead of
		* switching the center column, so leaving the panel no longer has to remember a
		* tab. Escape and a backdrop press both close, and the close button carries the
		* localized label.
		*/
		/** @returns the overlay dialog. */
		function Dialog({ title, onClose, children, size = "normal" }) {
			(0, react.useEffect)(() => {
				const onKeyDown = (event) => {
					if (event.key === "Escape") onClose();
				};
				document.addEventListener("keydown", onKeyDown, true);
				return () => {
					document.removeEventListener("keydown", onKeyDown, true);
				};
			}, [onClose]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: panel_module_css_default.dialogOverlay,
				"data-dsh-part": "dialog",
				onMouseDown: (event) => {
					if (event.target === event.currentTarget) onClose();
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: panel_module_css_default.dialogPanel,
					"data-size": size,
					role: "dialog",
					"aria-modal": "true",
					"aria-label": title,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: panel_module_css_default.dialogHead,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							className: panel_module_css_default.dialogTitle,
							children: title
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: panel_module_css_default.dialogClose,
							"aria-label": tt("dialog.close"),
							onClick: onClose,
							children: "×"
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: panel_module_css_default.dialogBody,
						children
					})]
				})
			});
		}
		//#endregion
		//#region src/client/panel/EditTab.tsx
		/**
		* Edit tab: the in-place editor for one skill.
		*
		* The list carries metadata only, so the host re-reads the file before the form
		* is shown and writes it back on save; the name and the location are fixed, and
		* the enabled state keeps its own control on the row.
		*/
		/** The edit tab body. */
		function EditTab({ api, skill, onDone, onCancel }) {
			const skillPath = skill.path ?? "";
			const [description, setDescription] = (0, react.useState)("");
			const [whenToUse, setWhenToUse] = (0, react.useState)("");
			const [content, setContent] = (0, react.useState)("");
			const [loading, setLoading] = (0, react.useState)(true);
			const [busy, setBusy] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(void 0);
			(0, react.useEffect)(() => {
				let cancelled = false;
				const load = async () => {
					try {
						const current = await api.read(skill.name, skillPath);
						if (cancelled) return;
						setDescription(current.description);
						setWhenToUse(current.whenToUse ?? "");
						setContent(current.content);
						setError(void 0);
					} catch (err) {
						if (cancelled) return;
						setError(tt("edit.loadFailed", { error: err instanceof Error ? err.message : String(err) }));
					} finally {
						if (!cancelled) setLoading(false);
					}
				};
				load();
				return () => {
					cancelled = true;
				};
			}, [
				api,
				skill.name,
				skillPath
			]);
			const submit = async (event) => {
				event.preventDefault();
				if (description.trim() === "" || content.trim() === "") {
					setError(tt("create.empty"));
					return;
				}
				setBusy(true);
				setError(void 0);
				try {
					await api.update({
						name: skill.name,
						path: skillPath,
						description: description.trim(),
						whenToUse: whenToUse.trim() || void 0,
						content
					});
					onDone();
				} catch (err) {
					setError(tt("edit.failed", { error: err instanceof Error ? err.message : String(err) }));
				} finally {
					setBusy(false);
				}
			};
			if (loading) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: panel_module_css_default.tabBody,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: panel_module_css_default.empty,
					children: tt("edit.loading")
				})
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: panel_module_css_default.tabBody,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
					className: panel_module_css_default.form,
					onSubmit: (event) => {
						submit(event);
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: panel_module_css_default.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: panel_module_css_default.fieldLabel,
								children: tt("edit.name")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: panel_module_css_default.input,
								value: skill.name,
								readOnly: true
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: panel_module_css_default.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: panel_module_css_default.fieldLabel,
								children: tt("create.description")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: panel_module_css_default.input,
								value: description,
								onChange: (event) => {
									setDescription(event.target.value);
								}
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: panel_module_css_default.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: panel_module_css_default.fieldLabel,
								children: tt("create.whenToUse")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: panel_module_css_default.input,
								value: whenToUse,
								onChange: (event) => {
									setWhenToUse(event.target.value);
								}
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: panel_module_css_default.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: panel_module_css_default.fieldLabel,
								children: tt("create.content")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
								className: `${panel_module_css_default.input} ${panel_module_css_default.textarea}`,
								value: content,
								onChange: (event) => {
									setContent(event.target.value);
								}
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: panel_module_css_default.formActions,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: panel_module_css_default.ghostButton,
								disabled: busy,
								onClick: onCancel,
								children: tt("edit.back")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "submit",
								className: panel_module_css_default.primaryButton,
								disabled: busy,
								children: tt("edit.submit")
							})]
						}),
						error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: panel_module_css_default.banner,
							"data-kind": "error",
							children: error
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: panel_module_css_default.note,
							children: tt("edit.note")
						})
					]
				})
			});
		}
		//#endregion
		//#region src/client/import-source.ts
		/**
		* Import-source helpers (browser half): turn a file the user picked into the
		* base64 string the host route carries.
		*
		* The archive travels as base64 inside the JSON body rather than as a
		* multipart upload because the route family's shared body reader is JSON-only;
		* the cap here matches the host's own archive limit, so an oversized file is
		* refused before a multi-megabyte request is built.
		*/
		/**
		* The largest archive the import route accepts. Mirrors IMPORT_LIMITS in the
		* host half (src/import.ts): the browser refuses the file early instead of
		* streaming something the host would reject after reading it.
		*/
		const MAX_IMPORT_ARCHIVE_BYTES = 4 * 1024 * 1024;
		/** Chunk size for the fromCharCode conversion (well under the argument cap). */
		const BASE64_CHUNK = 32768;
		/**
		* Encode bytes as base64, in chunks.
		*
		* `String.fromCharCode(...bytes)` on a multi-megabyte array overflows the
		* argument list and throws, so the conversion walks the buffer in bounded
		* chunks before handing the binary string to btoa.
		* @param bytes - the raw archive bytes.
		* @returns the base64 encoding.
		*/
		function bytesToBase64(bytes) {
			let binary = "";
			for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK));
			return btoa(binary);
		}
		//#endregion
		//#region src/client/panel/ImportTab.tsx
		/**
		* Import tab: batch-create skills from a local directory or a .zip archive.
		*
		* Both forms end at the same host route. The directory form names a path on
		* the host, which is meaningful because the route is loopback-only (browser and
		* host are the same machine by construction); the archive form carries the
		* bytes the browser read, so the user picks the file through the ordinary file
		* dialog. Nothing is overwritten: every outcome the host reports says either
		* that one SKILL.md was created or why that candidate was skipped.
		*
		* The tab unmounts whenever another tab or panel takes the center column, so
		* the workspace it needs is resolved with one list call on the first import
		* (the same lazy pattern the create tab uses) instead of being held here.
		*/
		/** Human-readable size, for the archive cap message. */
		function megabytes(bytes) {
			return `${Math.round(bytes / (1024 * 1024))}MB`;
		}
		/** Localized skip reason with a fallback for an outcome that carries none. */
		function reasonLabel(outcome) {
			if (outcome.status === "imported") return tt("import.imported");
			const reason = outcome.reason;
			return reason === void 0 ? tt("import.reason.unknown") : tt(`import.reason.${reason}`);
		}
		/** The import tab body. */
		function ImportTab({ api }) {
			const [root, setRoot] = (0, react.useState)("user");
			const [mode, setMode] = (0, react.useState)("directory");
			const [dir, setDir] = (0, react.useState)("");
			const [archive, setArchive] = (0, react.useState)(void 0);
			const [cwd, setCwd] = (0, react.useState)(void 0);
			const [busy, setBusy] = (0, react.useState)(false);
			const [report, setReport] = (0, react.useState)(void 0);
			const [error, setError] = (0, react.useState)(void 0);
			const busyRef = (0, react.useRef)(false);
			const chooseArchive = async (event) => {
				const file = event.target.files?.[0];
				setReport(void 0);
				if (file === void 0) {
					setArchive(void 0);
					return;
				}
				if (file.size > 4194304) {
					setArchive(void 0);
					setError(tt("import.archiveTooLarge", { size: megabytes(MAX_IMPORT_ARCHIVE_BYTES) }));
					return;
				}
				setError(void 0);
				try {
					setArchive({
						name: file.name,
						data: bytesToBase64(new Uint8Array(await file.arrayBuffer()))
					});
				} catch (err) {
					setArchive(void 0);
					setError(tt("import.failed", { error: err instanceof Error ? err.message : String(err) }));
				}
			};
			const submit = async (event) => {
				event.preventDefault();
				if (busyRef.current) return;
				let source;
				if (mode === "directory") {
					if (dir.trim() === "") {
						setError(tt("import.directoryRequired"));
						return;
					}
					source = {
						kind: "directory",
						path: dir.trim()
					};
				} else {
					if (archive === void 0) {
						setError(tt("import.archiveRequired"));
						return;
					}
					source = {
						kind: "archive",
						data: archive.data
					};
				}
				busyRef.current = true;
				setBusy(true);
				setError(void 0);
				setReport(void 0);
				try {
					const workspace = cwd ?? (await api.list()).cwd;
					setCwd(workspace);
					setReport(await api.importSkills({
						root,
						cwd: workspace,
						source
					}));
				} catch (err) {
					setError(tt("import.failed", { error: err instanceof Error ? err.message : String(err) }));
				} finally {
					busyRef.current = false;
					setBusy(false);
				}
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: panel_module_css_default.tabBody,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
					className: panel_module_css_default.form,
					onSubmit: (event) => {
						submit(event);
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: panel_module_css_default.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: panel_module_css_default.fieldLabel,
								children: tt("import.root")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								className: panel_module_css_default.select,
								value: root,
								onChange: (event) => {
									setRoot(event.target.value);
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "user",
									children: tt("create.root.user")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "project",
									children: tt("create.root.project")
								})]
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("fieldset", {
							className: panel_module_css_default.fieldGroup,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("legend", {
								className: panel_module_css_default.fieldLabel,
								children: tt("import.source")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: panel_module_css_default.radioRow,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: panel_module_css_default.checkboxLabel,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "radio",
										name: "import-mode",
										checked: mode === "directory",
										onChange: () => {
											setMode("directory");
										}
									}), tt("import.source.directory")]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: panel_module_css_default.checkboxLabel,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "radio",
										name: "import-mode",
										checked: mode === "archive",
										onChange: () => {
											setMode("archive");
										}
									}), tt("import.source.archive")]
								})]
							})]
						}),
						mode === "directory" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: panel_module_css_default.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: panel_module_css_default.fieldLabel,
								children: tt("import.directoryLabel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: panel_module_css_default.input,
								value: dir,
								spellCheck: false,
								placeholder: tt("import.directoryPlaceholder"),
								onChange: (event) => {
									setDir(event.target.value);
								}
							})]
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: panel_module_css_default.field,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: panel_module_css_default.fieldLabel,
									children: tt("import.archiveLabel")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "file",
									accept: ".zip,application/zip",
									"aria-label": tt("import.archiveLabel"),
									onChange: (event) => {
										chooseArchive(event);
									}
								}),
								archive !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: panel_module_css_default.note,
									children: archive.name
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "submit",
							className: panel_module_css_default.primaryButton,
							disabled: busy,
							children: tt("import.submit")
						}),
						error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: panel_module_css_default.banner,
							"data-kind": "error",
							children: error
						}),
						report !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							"data-dsh-part": "import-report",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: panel_module_css_default.banner,
								"data-kind": report.imported > 0 ? "ok" : void 0,
								children: tt("import.summary", {
									imported: report.imported,
									skipped: report.skipped
								})
							}), report.outcomes.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
								className: panel_module_css_default.outcomeList,
								children: report.outcomes.map((outcome) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
									className: panel_module_css_default.outcomeItem,
									"data-status": outcome.status,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: panel_module_css_default.outcomeName,
											children: outcome.name
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: panel_module_css_default.outcomeReason,
											children: reasonLabel(outcome)
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: panel_module_css_default.skillPath,
											children: outcome.origin
										})
									]
								}, outcome.origin))
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: panel_module_css_default.note,
							children: tt("import.note")
						})
					]
				})
			});
		}
		//#endregion
		//#region src/client/panel-prefs.ts
		/** The localStorage key holding the whole preference document. */
		const LIST_VIEW_STORAGE_KEY = "dsh-skill-explorer:list-view:v1";
		/**
		* Source groups opened on first use. These are the roots the user is actively
		* working with (project and user skills); the global and machine-level
		* sources — system bundled, custom directories, runtime registrations — start
		* collapsed so a wide catalog does not paint every row at once.
		*/
		const DEFAULT_EXPANDED_LEVELS = [
			"project-dsh",
			"project-agents",
			"user-dsh",
			"user-agents"
		];
		/** Bounds on the persisted document, so a hostile or buggy write stays small. */
		const MAX_LIST_ENTRIES = 64;
		const MAX_STORAGE_BYTES = 8 * 1024;
		const STATUSES = [
			"all",
			"enabled",
			"disabled"
		];
		const MARKS = [
			"linked",
			"provider-file",
			"no-file"
		];
		/** The preferences a browser with no stored document uses. */
		function defaultListPrefs() {
			return {
				levels: [],
				status: "all",
				marks: [],
				collapsed: {}
			};
		}
		/** Read a bounded string array, dropping anything that is not a string. */
		function stringList(value, allowed) {
			if (!Array.isArray(value)) return [];
			const out = [];
			for (const entry of value) {
				if (typeof entry !== "string" || entry === "") continue;
				if (allowed !== void 0 && !allowed.includes(entry)) continue;
				if (out.includes(entry)) continue;
				out.push(entry);
				if (out.length >= MAX_LIST_ENTRIES) break;
			}
			return out;
		}
		/** Read the collapse map, keeping boolean decisions only. */
		function collapseMap(value) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
			const out = {};
			let kept = 0;
			for (const [key, decision] of Object.entries(value)) {
				if (typeof decision !== "boolean" || key === "") continue;
				out[key] = decision;
				kept += 1;
				if (kept >= MAX_LIST_ENTRIES) break;
			}
			return out;
		}
		/**
		* Read the stored preferences, falling back to the defaults for a missing,
		* unreadable, oversized or malformed document. Every field is validated on its
		* own, so one bad field never discards the rest of the user's view.
		* @param storage - storage to read, or undefined when none is available.
		* @returns the preferences the tab should start from.
		*/
		function loadListPrefs(storage) {
			const defaults = defaultListPrefs();
			if (storage === void 0) return defaults;
			let raw;
			try {
				raw = storage.getItem(LIST_VIEW_STORAGE_KEY);
			} catch {
				return defaults;
			}
			if (raw === null || raw === "" || raw.length > MAX_STORAGE_BYTES) return defaults;
			let parsed;
			try {
				parsed = JSON.parse(raw);
			} catch {
				return defaults;
			}
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return defaults;
			const document = parsed;
			const status = document.status;
			return {
				levels: stringList(document.levels),
				status: typeof status === "string" && STATUSES.includes(status) ? status : defaults.status,
				marks: stringList(document.marks, MARKS),
				collapsed: collapseMap(document.collapsed)
			};
		}
		/**
		* Persist the preferences. A browser that refuses storage (private mode, a
		* sandboxed frame, a full quota) is not an error: the view still works for
		* this page load, it just does not survive a refresh.
		* @param storage - storage to write, or undefined when none is available.
		* @param prefs - the preferences to store.
		* @returns whether the document was persisted.
		*/
		function saveListPrefs(storage, prefs) {
			if (storage === void 0) return false;
			try {
				storage.setItem(LIST_VIEW_STORAGE_KEY, JSON.stringify(prefs));
				return true;
			} catch {
				return false;
			}
		}
		/**
		* Whether a source group is open, given the user's recorded decisions.
		* @param key - the group's source key.
		* @param collapsed - recorded per-group decisions.
		* @returns whether the group's rows are visible.
		*/
		function isGroupExpanded(key, collapsed) {
			const recorded = collapsed[key];
			return recorded === void 0 ? DEFAULT_EXPANDED_LEVELS.includes(key) : !recorded;
		}
		/**
		* Flip one group's collapse decision, recording it explicitly so the choice
		* survives a remount and later default changes cannot silently reopen it.
		* @param key - the group's source key.
		* @param collapsed - current recorded decisions.
		* @returns a new decision map with this group flipped.
		*/
		function toggleGroupCollapsed(key, collapsed) {
			return {
				...collapsed,
				[key]: isGroupExpanded(key, collapsed)
			};
		}
		//#endregion
		//#region src/client/skill-filter.ts
		/**
		* Match rank of one skill against a lowercased needle: 0 when the name hits,
		* 1 when only the description hits, undefined when neither does. An empty
		* needle matches everything at rank 0.
		*/
		function matchRank(skill, needle) {
			if (needle === "") return 0;
			if (skill.name.toLowerCase().includes(needle)) return 0;
			if (skill.description.toLowerCase().includes(needle)) return 1;
		}
		/**
		* The marks a row carries. "Provided by plugin" and "No local file" are the
		* two halves of one classification (a file the panel cannot write versus no
		* file at all), so at most one of them ever applies; a symlinked skill is a
		* separate fact and can carry either.
		* @param skill - the row's entry.
		* @returns every mark that applies to the row.
		*/
		function marksOf(skill) {
			const marks = [];
			if (skill.fileState === "provider-file") marks.push("provider-file");
			else if (skill.fileState === "virtual") marks.push("no-file");
			if (skill.linked === true) marks.push("linked");
			return marks;
		}
		/**
		* Whether a skill survives the mark facet. An empty selection keeps every row;
		* a non-empty one keeps a row carrying ANY selected mark, the same union
		* semantics the source facet uses, so ticking two boxes widens the result
		* instead of emptying it.
		*/
		function inMarks(skill, marks) {
			if (marks === void 0 || marks.length === 0) return true;
			const carried = marksOf(skill);
			return marks.some((mark) => carried.includes(mark));
		}
		/**
		* Whether a skill survives the enabled/disabled facet. This reads the model's
		* automatic-invocation state (the same value the row's switch shows), not the
		* user-invocable policy, so "disabled" means exactly what the switch reads.
		*/
		function inStatus(skill, status) {
			if (status === void 0 || status === "all") return true;
			return status === "enabled" ? skill.modelInvocable : !skill.modelInvocable;
		}
		/**
		* Whether a skill survives the workspace axis. Skills without a workspace
		* root are global and stay visible in every selection; that is the pre-search
		* behavior and the search must not change it.
		*/
		function inWorkspace(skill, workspace) {
			if (workspace === "all") return true;
			return skill.workspaceRoot === void 0 || skill.workspaceRoot === workspace;
		}
		/**
		* Apply every axis to a payload's groups: the source facet drops whole groups,
		* then the workspace, status, mark and query axes narrow each one (name hits
		* ranked before description hits, stable within a rank). Empty groups are
		* dropped so the caller renders only what has content.
		* @param groups - host payload groups in host order.
		* @param filter - workspace + query + optional source / status / mark facets.
		* @returns the visible groups; the input is never mutated.
		*/
		function selectGroups(groups, filter) {
			const needle = filter.query.trim().toLowerCase();
			const levels = filter.levels ?? [];
			return groups.filter((group) => levels.length === 0 || levels.includes(group.key)).map((group) => {
				const ranked = group.skills.filter((skill) => inWorkspace(skill, filter.workspace) && inStatus(skill, filter.status) && inMarks(skill, filter.marks)).map((skill) => ({
					skill,
					rank: matchRank(skill, needle)
				})).filter((row) => row.rank !== void 0);
				if (needle !== "") ranked.sort((left, right) => left.rank - right.rank);
				return {
					...group,
					skills: ranked.map((row) => row.skill)
				};
			}).filter((group) => group.skills.length > 0);
		}
		//#endregion
		//#region src/client/panel/SkillsTab.tsx
		/**
		* Skills tab: the grouped skill list with the search / facet / workspace
		* toolbar, collapsible source groups, and the per-row enable switch, edit,
		* duplicate and delete actions.
		*
		* The host route family is the only data source; a failed refresh keeps the
		* previous payload visible with an inline error. Which facets are applied and
		* which source groups are open are view preferences, not payload state: they
		* are persisted in localStorage (panel-prefs.ts), because the layout unmounts
		* this page whenever another panel takes the center column.
		*/
		/** The mark facets, in the order the filter bar lists them. */
		const MARK_FACETS = [
			"provider-file",
			"no-file",
			"linked"
		];
		/** The enabled/disabled facets, in the order the filter bar lists them. */
		const STATUS_FACETS = [
			"all",
			"enabled",
			"disabled"
		];
		/** Localized provider label with fallback to the raw provider id. */
		function providerLabel(provider) {
			const key = `provider.${provider}`;
			return key in zh ? tt(key) : provider;
		}
		/** Localized source-group title, falling back to the host's own copy. */
		function groupTitle(group) {
			const key = `group.${group.key}`;
			return key in zh ? tt(key) : group.title;
		}
		/** Localized source-group hint, falling back to the host's own copy. */
		function groupHintOf(group) {
			const key = `groupHint.${group.key}`;
			return key in zh ? tt(key) : group.hint;
		}
		/** The browser's localStorage, or undefined when this context refuses it. */
		function listStorage() {
			try {
				return typeof localStorage === "undefined" ? void 0 : localStorage;
			} catch {
				return;
			}
		}
		/** Whether any facet narrows the list (the source/status/mark facets only). */
		function hasActiveFacets(prefs) {
			return prefs.levels.length > 0 || prefs.status !== "all" || prefs.marks.length > 0;
		}
		/** How many facet selections are active, for the toolbar badge. */
		function activeFacetCount(prefs) {
			return prefs.levels.length + (prefs.status === "all" ? 0 : 1) + prefs.marks.length;
		}
		/** The name a duplicate starts from; the user can change it before creating. */
		function duplicateSkillName(name) {
			return `${name}-copy`;
		}
		/**
		* Whether this row carries an enable switch.
		*
		* A row with a writable path switches by rewriting its own SKILL.md
		* frontmatter. A plugin-provided file (issue #1854) has no such path, so its
		* switch is recorded in the panel's own store; a truly fileless registration
		* has nothing to switch and still shows none.
		* @param skill - the row's entry.
		* @returns whether the row offers the switch.
		*/
		function canToggle(skill) {
			return skill.path !== void 0 || skill.fileState === "provider-file";
		}
		/**
		* The local-file badge for a row that the write routes cannot serve.
		*
		* A skill with a plugin-supplied file and a skill with no file at all are
		* different facts (issue #1842): the first is "Provided by plugin", only the
		* second is "No local file". Both are pathless, so neither offers file
		* controls.
		* @param skill - the row's entry.
		* @returns the badge copy and its tooltip.
		*/
		function localFileBadge(skill) {
			return skill.fileState === "provider-file" ? {
				label: tt("list.providerFile"),
				tooltip: tt("list.providerFileTooltip")
			} : {
				label: tt("list.noFile"),
				tooltip: tt("list.noFileTooltip")
			};
		}
		/** The explanation shown under a row the write routes cannot serve. */
		function localFileHint(skill) {
			return skill.fileState === "provider-file" ? tt("list.providerFileHint") : tt("list.noFileHint");
		}
		/** Marks shown next to a skill (model/user invocable). */
		function invokableMarks(skill) {
			const marks = [];
			if (skill.modelInvocable) marks.push(tt("list.mark.model"));
			if (skill.userInvocable) marks.push(tt("list.mark.user"));
			return marks.join(" / ");
		}
		/** Deterministic avatar tint so one skill keeps its color between visits and themes. */
		function avatarTint(name) {
			let hue = 0;
			for (const char of name) hue = (hue * 31 + (char.codePointAt(0) ?? 0)) % 360;
			return {
				background: `color-mix(in srgb, hsl(${hue} 70% 50%) 22%, transparent)`,
				color: `hsl(${hue} 62% 46%)`
			};
		}
		/** The avatar label: the first visible character of the skill name. */
		function avatarText(name) {
			return Array.from(name.trim())[0]?.toUpperCase() ?? "?";
		}
		/** One skill card: identity, badges, enable switch, edit, duplicate and delete actions. */
		function SkillRow({ skill, sourceLabel, api, onChanged, onEdit, onDuplicate }) {
			const [busy, setBusy] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(void 0);
			const busyRef = (0, react.useRef)(false);
			const toggle = async () => {
				if (busyRef.current || !canToggle(skill)) return;
				busyRef.current = true;
				setBusy(true);
				setError(void 0);
				try {
					if (skill.path !== void 0) await api.setEnabled(skill.name, skill.path, !skill.modelInvocable);
					else await api.setProviderEnabled(skill.name, skill.provider, !skill.modelInvocable);
					onChanged();
				} catch (err) {
					setError(tt("list.toggleFailed", { error: err instanceof Error ? err.message : String(err) }));
				} finally {
					busyRef.current = false;
					setBusy(false);
				}
			};
			const remove = async () => {
				const path = skill.path;
				if (path === void 0) return;
				if (!window.confirm(tt("list.deleteConfirm", { name: skill.name }))) return;
				if (busyRef.current) return;
				busyRef.current = true;
				setBusy(true);
				setError(void 0);
				try {
					await api.remove(skill.name, path);
					onChanged();
				} catch (err) {
					setError(tt("list.deleteFailed", { error: err instanceof Error ? err.message : String(err) }));
				} finally {
					busyRef.current = false;
					setBusy(false);
				}
			};
			/**
			* Copy this skill's fields into the create form as a starting point. The
			* read route resolves the row's own path through a fresh scan, so the draft
			* can only ever come from a skill the panel is showing.
			*/
			const duplicate = async () => {
				const path = skill.path;
				if (path === void 0 || busyRef.current) return;
				busyRef.current = true;
				setBusy(true);
				setError(void 0);
				try {
					const source = await api.read(skill.name, path);
					onDuplicate({
						from: skill.name,
						name: duplicateSkillName(skill.name),
						description: source.description,
						...source.whenToUse === void 0 ? {} : { whenToUse: source.whenToUse },
						content: source.content
					});
				} catch (err) {
					setError(tt("list.duplicateFailed", { error: err instanceof Error ? err.message : String(err) }));
				} finally {
					busyRef.current = false;
					setBusy(false);
				}
			};
			const isIsolated = skill.isActiveWorkspace === false;
			const fileBadge = skill.path === void 0 ? localFileBadge(skill) : void 0;
			const canCopy = skill.path !== void 0;
			const stateBadge = !skill.modelInvocable && canToggle(skill) ? {
				label: tt("list.disabled"),
				tone: panel_module_css_default.badgeDisabled,
				tooltip: tt("list.disabled")
			} : fileBadge === void 0 ? void 0 : {
				label: fileBadge.label,
				tone: "",
				tooltip: fileBadge.tooltip
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
				className: `${panel_module_css_default.skillCard}${isIsolated ? ` ${panel_module_css_default.skillIsolated}` : ""}`,
				"data-dsh-part": "skill-row",
				title: skill.path,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: panel_module_css_default.cardHead,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: panel_module_css_default.skillAvatar,
								style: avatarTint(skill.name),
								"aria-hidden": "true",
								children: avatarText(skill.name)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: panel_module_css_default.cardIdentity,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: panel_module_css_default.skillName,
									children: skill.name
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: panel_module_css_default.cardMeta,
									children: sourceLabel
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: panel_module_css_default.cardControls,
								children: [stateBadge !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: `${panel_module_css_default.badge} ${stateBadge.tone}`,
									title: stateBadge.tooltip,
									children: stateBadge.label
								}), canToggle(skill) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: panel_module_css_default.switch,
									role: "switch",
									"aria-checked": skill.modelInvocable,
									"aria-label": skill.modelInvocable ? tt("list.enabled") : tt("list.disabled"),
									title: skill.modelInvocable ? tt("list.enabled") : tt("list.disabled"),
									disabled: busy,
									onClick: () => {
										toggle();
									},
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: panel_module_css_default.switchTrack,
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: panel_module_css_default.switchThumb })
									})
								})]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: panel_module_css_default.skillDesc,
						children: skill.description
					}),
					skill.whenToUse !== void 0 && skill.whenToUse !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: panel_module_css_default.skillWhen,
						children: tt("list.when", { when: skill.whenToUse })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: panel_module_css_default.cardTags,
						children: [
							skill.workspaceName !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: `${panel_module_css_default.badge} ${panel_module_css_default.badgeWorkspace}`,
								children: skill.workspaceName
							}),
							isIsolated && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: `${panel_module_css_default.badge} ${panel_module_css_default.badgeIsolated}`,
								title: tt("workspace.isolatedHint", { workspace: skill.workspaceName ?? "" }),
								children: tt("workspace.isolated")
							}),
							skill.provider !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: panel_module_css_default.badge,
								title: tt("provider.tooltip", { provider: providerLabel(skill.provider) }),
								children: providerLabel(skill.provider)
							}),
							skill.linked === true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: panel_module_css_default.badge,
								children: tt("list.linked")
							}),
							(skill.modelInvocable || skill.userInvocable) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: `${panel_module_css_default.badge} ${panel_module_css_default.badgeInvokable}`,
								title: tt("list.invokableTooltip"),
								children: tt("list.invokable", { marks: invokableMarks(skill) })
							})
						]
					}),
					skill.path === void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: panel_module_css_default.skillWhen,
						children: localFileHint(skill)
					}),
					error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: panel_module_css_default.banner,
						"data-kind": "error",
						children: error
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: panel_module_css_default.cardActions,
						children: [
							canCopy && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: panel_module_css_default.linkButton,
								disabled: busy,
								onClick: () => {
									duplicate();
								},
								children: tt("list.duplicate")
							}),
							skill.path !== void 0 && skill.linked !== true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: panel_module_css_default.linkButton,
								disabled: busy,
								onClick: () => {
									onEdit(skill);
								},
								children: tt("list.edit")
							}),
							skill.path !== void 0 && skill.linked !== true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: `${panel_module_css_default.linkButton} ${panel_module_css_default.deleteButton}`,
								"data-danger": "",
								disabled: busy,
								onClick: () => {
									remove();
								},
								children: tt("list.delete")
							})
						]
					})
				]
			});
		}
		/** The skills tab body. */
		function SkillsTab({ api, onCreate, onEdit, onImport, onDuplicate }) {
			const [payload, setPayload] = (0, react.useState)(void 0);
			const [selectedWorkspace, setSelectedWorkspace] = (0, react.useState)("all");
			const [query, setQuery] = (0, react.useState)("");
			const [prefs, setPrefs] = (0, react.useState)(() => loadListPrefs(listStorage()));
			const [filtersOpen, setFiltersOpen] = (0, react.useState)(() => hasActiveFacets(loadListPrefs(listStorage())));
			const [error, setError] = (0, react.useState)(void 0);
			const [loading, setLoading] = (0, react.useState)(true);
			const loadSeq = (0, react.useRef)(0);
			const load = async () => {
				const seq = ++loadSeq.current;
				setLoading(true);
				try {
					const next = await api.list();
					if (seq !== loadSeq.current) return;
					setPayload(next);
					setError(void 0);
				} catch (err) {
					if (seq !== loadSeq.current) return;
					setError(tt("list.loadFailed", { error: err instanceof Error ? err.message : String(err) }));
				} finally {
					if (seq === loadSeq.current) setLoading(false);
				}
			};
			(0, react.useEffect)(() => {
				load();
			}, [api]);
			(0, react.useEffect)(() => {
				saveListPrefs(listStorage(), prefs);
			}, [prefs]);
			(0, react.useEffect)(() => {
				if (payload === void 0) return;
				const present = new Set(payload.groups.map((group) => group.key));
				if (prefs.levels.every((level) => present.has(level))) return;
				setPrefs((current) => ({
					...current,
					levels: current.levels.filter((level) => present.has(level))
				}));
			}, [payload, prefs.levels]);
			const toggleLevel = (key) => {
				setPrefs((current) => ({
					...current,
					levels: current.levels.includes(key) ? current.levels.filter((level) => level !== key) : [...current.levels, key]
				}));
			};
			const toggleMark = (mark) => {
				setPrefs((current) => ({
					...current,
					marks: current.marks.includes(mark) ? current.marks.filter((entry) => entry !== mark) : [...current.marks, mark]
				}));
			};
			const clearFacets = () => {
				setPrefs((current) => ({
					...current,
					levels: [],
					status: "all",
					marks: []
				}));
			};
			const toggleGroup = (key) => {
				setPrefs((current) => ({
					...current,
					collapsed: toggleGroupCollapsed(key, current.collapsed)
				}));
			};
			const refreshButton = loading ? void 0 : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: panel_module_css_default.ghostButton,
				onClick: () => {
					load();
				},
				children: tt("refresh")
			});
			if (payload === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: panel_module_css_default.fillBody,
				children: loading ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: panel_module_css_default.empty,
					children: tt("list.loading")
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: panel_module_css_default.empty,
					children: error
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: panel_module_css_default.toolbar,
					children: refreshButton
				})] })
			});
			const filter = {
				workspace: selectedWorkspace,
				query,
				levels: prefs.levels,
				status: prefs.status,
				marks: prefs.marks
			};
			const visibleGroups = selectGroups(payload.groups, filter);
			const visibleCount = visibleGroups.reduce((total, group) => total + group.skills.length, 0);
			const facetsActive = hasActiveFacets(prefs);
			const narrowed = query.trim() !== "" || selectedWorkspace !== "all" || facetsActive;
			const emptyText = query.trim() !== "" ? tt("filter.empty", { query: query.trim() }) : narrowed ? tt("filter.emptyWorkspace") : tt("list.empty");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: panel_module_css_default.fillBody,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: panel_module_css_default.toolbar,
						"data-dsh-part": "filter-bar",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: panel_module_css_default.search,
								type: "search",
								value: query,
								spellCheck: false,
								"aria-label": tt("filter.searchLabel"),
								placeholder: tt("filter.searchPlaceholder"),
								onChange: (event) => {
									setQuery(event.target.value);
								},
								onKeyDown: (event) => {
									if (event.key === "Escape" && query !== "") setQuery("");
								}
							}),
							payload.workspaces !== void 0 && payload.workspaces.length > 1 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								className: panel_module_css_default.select,
								value: selectedWorkspace,
								"aria-label": tt("filter.workspaceLabel"),
								onChange: (event) => {
									setSelectedWorkspace(event.target.value);
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "all",
									children: tt("filter.workspaceAll")
								}), payload.workspaces.map((ws) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: ws.root,
									children: ws.active ? tt("filter.workspaceCurrent", { name: ws.name }) : ws.name
								}, ws.root))]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: panel_module_css_default.ghostButton,
								"aria-expanded": filtersOpen,
								"data-active": facetsActive ? "" : void 0,
								onClick: () => {
									setFiltersOpen((open) => !open);
								},
								children: [tt("filter.toggle"), facetsActive ? ` (${activeFacetCount(prefs)})` : ""]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: panel_module_css_default.primaryButton,
								onClick: onCreate,
								children: tt("tab.create")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: panel_module_css_default.ghostButton,
								onClick: onImport,
								children: tt("import.open")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: panel_module_css_default.toolbarSpacer }),
							refreshButton
						]
					}),
					filtersOpen && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: panel_module_css_default.facetBar,
						"data-dsh-part": "facet-bar",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: panel_module_css_default.facetRow,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: panel_module_css_default.facetLabel,
									children: tt("filter.sourceLabel")
								}), payload.groups.map((group) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									className: panel_module_css_default.facetChip,
									"aria-pressed": prefs.levels.includes(group.key),
									"data-active": prefs.levels.includes(group.key) ? "" : void 0,
									onClick: () => {
										toggleLevel(group.key);
									},
									children: [groupTitle(group), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: panel_module_css_default.facetCount,
										children: group.skills.length
									})]
								}, group.key))]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: panel_module_css_default.facetRow,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: panel_module_css_default.facetLabel,
									children: tt("filter.statusLabel")
								}), STATUS_FACETS.map((status) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: panel_module_css_default.facetChip,
									"aria-pressed": prefs.status === status,
									"data-active": prefs.status === status ? "" : void 0,
									onClick: () => {
										setPrefs((current) => ({
											...current,
											status
										}));
									},
									children: tt(`filter.status.${status}`)
								}, status))]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: panel_module_css_default.facetRow,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: panel_module_css_default.facetLabel,
										children: tt("filter.markLabel")
									}),
									MARK_FACETS.map((mark) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: panel_module_css_default.facetChip,
										"aria-pressed": prefs.marks.includes(mark),
										"data-active": prefs.marks.includes(mark) ? "" : void 0,
										onClick: () => {
											toggleMark(mark);
										},
										children: tt(`filter.mark.${mark}`)
									}, mark)),
									facetsActive && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: panel_module_css_default.linkButton,
										onClick: clearFacets,
										children: tt("filter.clear")
									})
								]
							})
						]
					}),
					error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: panel_module_css_default.banner,
						"data-kind": "error",
						children: error
					}),
					visibleCount === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: panel_module_css_default.empty,
						children: emptyText
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: panel_module_css_default.list,
						children: visibleGroups.map((group) => {
							const expanded = isGroupExpanded(group.key, prefs.collapsed);
							const hint = groupHintOf(group);
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
								className: panel_module_css_default.group,
								"data-collapsed": expanded ? void 0 : "",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										className: panel_module_css_default.groupToggle,
										"aria-expanded": expanded,
										"data-dsh-part": "group-toggle",
										onClick: () => {
											toggleGroup(group.key);
										},
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: panel_module_css_default.groupCaret,
												"aria-hidden": "true"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: panel_module_css_default.groupTitleText,
												children: groupTitle(group)
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: panel_module_css_default.count,
												children: tt("list.count", { count: String(group.skills.length) })
											})
										]
									}),
									expanded && hint !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: panel_module_css_default.groupHint,
										children: hint
									}),
									expanded && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: panel_module_css_default.skillGrid,
										children: group.skills.map((skill) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SkillRow, {
											skill,
											sourceLabel: groupTitle(group),
											api,
											onChanged: () => {
												load();
											},
											onEdit,
											onDuplicate
										}, skill.name))
									})
								]
							}, group.key);
						})
					})
				]
			});
		}
		//#endregion
		//#region src/client/panel/SkillPanel.tsx
		/**
		* The skill center panel shell: a title header, the skill list, and the one
		* modal dialog the current form needs.
		*
		* The dialog mode and the editor target live in the controller, not in
		* component state: the layout mounts this page only while the panel is
		* selected, so local state would drop an open dialog on every panel switch.
		* The list stays mounted under a dialog and refetches through a key bump when
		* the dialog closes.
		*
		* The create and import buttons in the list toolbar open their dialog; a row's
		* edit button opens the editor dialog, and a row's "duplicate as template"
		* action opens the create dialog with a draft through the controller.
		*/
		/** The skill center panel. */
		function SkillPanel({ controller, api }) {
			const { activeTab, editing } = (0, react.useSyncExternalStore)((listener) => controller.subscribe(listener), () => controller.getSnapshot());
			const [listEpoch, setListEpoch] = (0, react.useState)(0);
			const closeDialog = () => {
				if (editing !== void 0) controller.closeEditor();
				else controller.setActiveTab("skills");
				setListEpoch((epoch) => epoch + 1);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: panel_module_css_default.panel,
				"data-dsh-plugin": "skill-explorer",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: panel_module_css_default.panelHeader,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
							className: panel_module_css_default.panelTitle,
							children: tt("panel.title")
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: panel_module_css_default.panelContent,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SkillsTab, {
							api,
							onCreate: () => {
								controller.setActiveTab("create");
							},
							onImport: () => {
								controller.setActiveTab("import");
							},
							onEdit: (skill) => {
								controller.openEditor(skill);
							},
							onDuplicate: (draft) => {
								controller.openCreateFromTemplate(draft);
							}
						}, listEpoch)
					}),
					activeTab === "create" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Dialog, {
						title: tt("tab.create"),
						onClose: closeDialog,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CreateTab, {
							api,
							controller
						})
					}),
					activeTab === "import" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Dialog, {
						title: tt("tab.import"),
						onClose: closeDialog,
						size: "wide",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ImportTab, { api })
					}),
					activeTab === "edit" && editing !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Dialog, {
						title: tt("tab.edit"),
						onClose: closeDialog,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EditTab, {
							api,
							skill: editing,
							onDone: closeDialog,
							onCancel: closeDialog
						})
					})
				]
			});
		}
		//#endregion
		//#region src/client/native-panel.tsx
		/** Row order among the shell's global panel rows (Plugins 0, Schedule 10, board 20). */
		const PANEL_ORDER = 30;
		/**
		* The sidebar row glyph the shell asks for at its own size and active state.
		* The shell owns the button, label, tooltip and rail geometry; this component
		* draws only the glyph, like every other panel row.
		*
		* The glyph carries `data-dsh-panel-entry` because it is the only DOM this
		* panel's own code owns inside that shell-owned row: the L2 contract (skins)
		* resolves which row belongs to which plugin through it, since the shell
		* stamps no per-entry hook of its own (see contracts/semantic-attrs-v1.md).
		* @param props - the shell's icon share: square edge and selection state.
		* @returns the decorative skill-center glyph.
		*/
		function SkillExplorerPanelIcon({ size }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				"data-dsh-panel-entry": SKILL_EXPLORER_PANEL_ID,
				viewBox: "0 0 16 16",
				width: size,
				height: size,
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "1.3",
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M8 3.2C6.6 2 4.5 2 3 2v10.5c1.5 0 3.6 0 5 1.3 1.4-1.3 3.5-1.3 5-1.3V2c-1.5 0-3.6 0-5 1.2z" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M8 3.2v10.6" })]
			});
		}
		/**
		* The main-slot page. The layout mounts it only while this panel is selected,
		* so the conversation keeps the center column untouched the rest of the time;
		* the wrapper carries the pinned `data-dsh-skill-explorer-view` semantic
		* anchor (L2 contract, skins) the takeover container used to own.
		* @param props - the framework main-slot share plus this entry's injected face.
		* @returns the skill center page.
		*/
		function SkillExplorerPanelPage({ controller, api }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: panel_module_css_default.view,
				"data-dsh-skill-explorer-view": "",
				"data-dsh-plugin": "skill-explorer",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SkillPanel, {
					controller,
					api
				})
			});
		}
		/**
		* Register the skill center's sidebar row and center-column page.
		*
		* Both seats are declared by shell plugins this package does not depend on at
		* runtime, so each registration is wrapped in `ctx.slots.inject`: the callback
		* runs only after the owning entry declares the seat, and a shell that never
		* declares it leaves the panel simply absent instead of failing boot.
		* @param ctx - client root context (services: slots).
		* @param controller - the controller the page and the row drive.
		* @param api - the skill center API client the page operates through.
		* @returns disposer releasing both registrations.
		*/
		function registerSkillExplorerPanel(ctx, controller, api) {
			const slots = ctx.slots;
			const disposers = [];
			disposers.push(slots.inject("sidebar.panellist", () => slots.register({
				name: "sidebar.panellist",
				id: SKILL_EXPLORER_PANEL_ID,
				order: PANEL_ORDER,
				label: () => tt("entry.label")
			}, SkillExplorerPanelIcon)));
			disposers.push(slots.inject("main", () => slots.register({
				name: "main",
				key: SKILL_EXPLORER_PANEL_ID,
				inject: () => ({
					controller,
					api
				})
			}, SkillExplorerPanelPage)));
			return () => {
				for (const dispose of disposers.splice(0)) dispose();
			};
		}
		//#endregion
		//#region src/client/index.ts
		/** Locale namespace this plugin owns. */
		const NS = "dsh-skill-explorer";
		/** Required services (fiber inject waiting — the runtime must be up first). */
		const inject = [
			"slots",
			"locale",
			"layout"
		];
		/**
		* Mount the skill center surfaces.
		* @param ctx - client root context (locale service).
		*/
		function apply(ctx) {
			ctx.effect(() => {
				try {
					return ctx.locale.register(NS, {
						zh,
						en
					});
				} catch {
					return () => {};
				}
			}, "skill-explorer: dictionaries");
			try {
				setRuntimeTranslate(ctx.locale.bind(NS));
			} catch {}
			const api = new SkillApi();
			const controller = new PanelController({ panel: { select: (panelId) => {
				(ctx.get?.("layout"))?.selectPanel?.(panelId);
			} } });
			const disposers = [];
			try {
				disposers.push(registerSkillExplorerPanel(ctx, controller, api));
				const layoutFace = ctx.get?.("layout");
				if (layoutFace?.panelInfo !== void 0) {
					const sync = () => {
						const active = layoutFace.panelInfo.getSnapshot().activePanelId;
						controller.syncPanelSelection(active === "skill-explorer" ? SKILL_EXPLORER_PANEL_ID : null);
					};
					sync();
					disposers.push(layoutFace.panelInfo.subscribe(sync));
				}
			} catch (error) {
				console.warn("[skill-explorer] panel registration failed:", error);
			}
			ctx.effect(() => () => {
				for (const dispose of disposers.splice(0)) dispose();
			}, "skill-explorer: ui mounts");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map