# dsh-plugin-pdd-ego

English | [中文](README.zh.md)

A DeepSeek Harness plugin that brings **ego-based Pinduoduo listing** into DSH. The execution layer (`cli-ego` / `pdd_flow_ego` / `run_listing_ego` / `tools`) **ships inside the package under `scripts/`** and no longer depends on an external working directory.

- Registers the **runtime skill** `pdd-ego-listing` (`ctx.inject(['skills'])` → `skills.register`, with the package `skill/` directory as its resource base).
- Registers **nine tools** (`ctx.inject(['tools'])` → `tools.register`):
  `pdd_ego_spaces` / `pdd_ego_freight_templates` / `pdd_ego_set_freight_template` /
  `pdd_ego_probe_shop` / `pdd_ego_run_listing` / `pdd_ego_build_product` / `pdd_ego_xlsx_to_product` / `pdd_ego_read_excel` / `pdd_ego_env`
- **Never submits a listing by default**: it only fills the form and runs the 34 checks; submission requires both `allowSubmit` and `submitAfterPass` to be explicitly enabled.

## Layout

```
lib/index.mjs           Plugin entry: resolves paths, registers the skill and tools
lib/paths.mjs           Path discovery (config > environment > probe)
skill/SKILL.md          Runtime skill body
scripts/cli-ego.mjs     ego command entry (spaces / freight / current / run / probe)
scripts/pdd_flow_ego.mjs  Execution layer (runs inside ego-browser)
scripts/run_listing_ego.mjs  Listing orchestration
scripts/tools/          build_product.py / read_excel.py / xlsx_to_product.py / config.json
scripts/ASK-BEFORE-LISTING.md  Pre-listing question checklist
scripts/run-config.example.json  Listing parameter template
```

## Path resolution (no hard-coded paths)

| Dependency | Config field | Environment variable | Default behavior |
|---|---|---|---|
| ego-browser.exe | `egoBrowser` | `PDD_EGO_BROWSER` | Probes `~/.local/share/ego/active_version_dir` (including version subdirectories) → `~/.local/bin` → PATH |
| Python (with openpyxl) | `pythonPath` | `PDD_PYTHON` | Verifies each candidate interpreter and prefers one that can `import openpyxl` |
| Execution directory | `workDir` | `PDD_WORK_DIR` | The package `scripts/` directory |
| Log | `logFile` | `PDD_EGO_LOG` | System temporary directory (the package may be installed read-only) |
| Per-call timeout | `timeoutMs` | — | 900000 ms |
| Submission switch | `allowSubmit` | — | `false` |

Configuration lives in the profile `cordis.patch.yml`; every field is optional:

```yaml
- id: pdd-ego-listing
  config:
    verbose: false
    allowSubmit: false
    # egoBrowser: "C:/Users/<you>/.local/share/ego/active_version_dir/ego-browser.exe"
    # pythonPath: "C:/Users/<you>/AppData/Local/Programs/Python/Python311/python.exe"
```

## Installation

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
# then restart DeepSeek Harness
```

`install.ps1` does three things:
1. Copies `lib/`, `skill/`, and `scripts/` into the plugin directory and the current profile's `node_modules/dsh-plugin-pdd-ego`.
2. Adds a `file:` dependency and a `dsh.profile.bundles` entry to the profile `package.json`.
3. Adds a `- insert: {id: pdd-ego-listing, name: dsh-plugin-pdd-ego}` fallback row to the profile `cordis.patch.yml`.

## Tools

| Tool | Purpose |
|---|---|
| `pdd_ego_spaces` | Lists shop spaces (which spaceId maps to which shop) |
| `pdd_ego_freight_templates` | Lists the freight templates the shop's publishing page actually offers (`current:true` only reads the current value) |
| `pdd_ego_set_freight_template` | Selects a freight template and reads it back (never creates a template) |
| `pdd_ego_probe_shop` | Read-only probe of the current page state |
| `pdd_ego_run_listing` | Runs the listing flow from `run-config.json`; accepts `configPath`/`space`/`product`/`freightTemplate`/`saveDraft`/`submitAfterPass` |
| `pdd_ego_build_product` | `listing.json` plus an asset directory → `product.json` |
| `pdd_ego_xlsx_to_product` | Whole-package Excel → `work/listing.json` and `work/product.json`; attributes come from the Excel product columns by default and `attrsFrom` only overrides same-name keys |
| `pdd_ego_read_excel` | Shop-perspective Excel → structured SKU JSON |
| `pdd_ego_env` | Self-check of prerequisites (ego browser, Python with openpyxl, reachable spaces) |

## Ask before listing

See `scripts/ASK-BEFORE-LISTING.md`: shop / material package / **freight template** / whether to save a draft / whether submission is allowed.
With `freightTemplate:"__ASK__"` the flow lists the shop's templates and stops before filling SKUs or saving a draft.

## Troubleshooting

| Symptom | Cause / correct approach |
|---|---|
| `MODULE imported` but no `apply called` | Keep side effects such as `createRequire(import.meta.url)` and `child_process` imports out of the module top level; load them lazily inside `apply`. Only the minimal skeleton (imports, constants, `name`, `apply`, `default`) mounts reliably |
| `parameters.type must be a value schema object` | Tool `parameters` use the **DSL**: `{ space: { type:'integer', required:true, description:'...' } }`, not JSON Schema |
| `schema.type must be string/number/...` | `output.schema` is **JSON Schema** and needs a valid `type` |
| `schema.additionalProperties must be explicitly true or false` | Write `output.schema` as `{ type:'object', properties:{}, additionalProperties:true }` |
| Skill is missing | File-based skills also live under `~/.agents/skills/` and `~/.dsh/skills/` as a fallback; reload the page |
| A tool reports “ego-browser not found” | When ego is not in a default location, set `egoBrowser` or `PDD_EGO_BROWSER` |
| `read_excel` raises `ModuleNotFoundError: openpyxl` | The interpreter behind `pythonPath` lacks openpyxl; the plugin falls back to one that has it, otherwise set it explicitly |

To open the plugin debug log, set `PDD_EGO_DEBUG=1` and restart; the log defaults to `pdd-ego-plugin.log` in the system temporary directory (`PDD_EGO_LOG` overrides it).

## Uninstall

Delete the current profile's `node_modules/dsh-plugin-pdd-ego` and remove `pdd-ego-listing` from the profile `package.json` `bundles` and `cordis.patch.yml`, then restart.
