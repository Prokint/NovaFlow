# dsh-plugin-taobao-ego

淘宝/千牛商品上架（**ego 浏览器版**）的 DSH 插件：注册技能 `taobao-ego-listing` + 工具 `tb_ego_*`。

**只填空与自检，绝不点「提交宝贝信息」，默认不存草稿。**

## 装什么

| 组件 | 说明 |
|---|---|
| 技能 `taobao-ego-listing` | 硬门禁（1–20）、流程表、排错表、实战记录（正文见 `skill/SKILL.md`；完整交接见 `skill/HANDOVER.md`） |
| `tb_ego_env` | 自检：ego 浏览器 / Python(openpyxl) / 可连的 space / 输出目录 |
| `tb_ego_spaces` | 列出 ego space（一店一个；**ego 重启后 id 会变**） |
| `tb_ego_probe_shop` | 只读探测某 space 当前页面（是否发布页 / catId / 空图片槽 / 区块是否在） |
| `tb_ego_run_listing` | 跑上架编排：只填空 + 核对清单，返回 REPORT（每步耗时 / 资产自检 / 失败项） |

## 安装

```powershell
powershell -ExecutionPolicy Bypass -File <本插件目录>\install.ps1
```

也可以手动装（等价）：

```powershell
# 1) 把插件目录（解压后的 package/）放到任意位置，例如 ~/.dsh/plugins-src/dsh-plugin-taobao-ego
# 2) 跑其中的 install.ps1（它会复制到 profile 的 node_modules 并给 package.json / cordis.patch.yml 打补丁）
```

装完**重启 DeepSeek Harness**。重启后应能看到技能 `taobao-ego-listing` 与 `tb_ego_*` 工具。

> ⚠️ **写 profile 配置的硬规则（2026-11-16 事故后补）**
> `~/.dsh/profiles/desktop/package.json` 与 `cordis.patch.yml` 是 **JSON / YAML**，**绝对不能带 UTF-8 BOM**：
> DSH 启动时 `readProfileManifest` 直接 `JSON.parse()` 读它，BOM（`EF BB BF`）会被当成非法 token →
> host 进程 fatal、壳进程弹崩溃窗（`Unexpected token '﻿'`）。
> PowerShell 5.1 的 `Set-Content -Encoding UTF8` / `Out-File -Encoding utf8` **会加 BOM**；
> 本仓库的 `install.ps1` 已改用 `[System.Text.UTF8Encoding]::new($false)` 写、并在写后 `Assert-NoBom` + `JSON.parse` 复验。
> **改 profile 的 JSON 时：用 Node 写，或 PowerShell 的 `UTF8Encoding($false)`；不要用 `-Encoding UTF8`。**

## 配置（`cordis.patch.yml` 里 `id: taobao-ego-listing` 的 `config`）

| 键 | 默认 | 作用 |
|---|---|---|
| `egoBrowser` | 自动探测 `~/.local/share/ego/active_version_dir/ego-browser.exe` | ego 可执行文件 |
| `workDir` | 插件包 `scripts/` | 执行层脚本目录 |
| `outputRoot` | `~/.dsh/taobao-ego/output` | product.json / SKU 模板下载 / 图片落地 |
| `pythonPath` | 自动探测（**优先 DSH 自带那份**） | 读 Excel 用（需 openpyxl） |
| `logFile` | 系统临时目录 | debug 日志 |
| `timeoutMs` | `1800000` | 单次 ego 调用超时 |
| `verbose` | `false` | 打印调试细节 |

环境变量（可选）：`TB_EGO_BROWSER` / `TB_WORK_DIR` / `TB_OUTPUT_ROOT` / `TB_PYTHON` / `TB_EGO_LOG` / `TB_EGO_DEBUG=1`。

## 怎么用（交给模型）

1. 先 `tb_ego_env`：缺什么就告诉用户（缺 ego / 缺 Python / 没登录），**不要硬跑**；
2. 问清：店铺(space) / 素材包(`product` 或 `pack`) / 类目(`catid` + `cat`) / 是否存草稿；
3. `tb_ego_run_listing({ space, product|pack, catid, cat, saveDraft:false })`；
4. 看 `report`：`failed: []` 且 `步骤[].摘要.未通过` 为 `[]` 才算过；把「会上传 / 跳过 / 暂不支持」如实汇报；
5. **不要点提交**（插件也没有提交能力，`submitAllowed` 恒为 false）。

## 没有素材包时（只有图片 + 口头参数）

上架必须有：**类目 / 标题 / 价格·库存·SKU / 至少 1 张 1:1 主图**。没有素材包时按两步走：

1. `tb_ego_category_profile({ space, catid, cat })` —— 只读抓该类目发布页：
   属性名 / 是否必填 / 控件类型 / 下拉可选值 / 图片与视频的页面原文要求 / 官方 SKU 模板是否已下载。
   不给 `catid+cat` 就复用当前已打开的发布页（最省事）。拿到清单后把「必填项 + 可选值」告诉用户。
2. `tb_ego_build_product({ listingPath | listing, out })` —— 手工造数据：
   吃一份极简 `listing.json`，生成 `product.json` + `img/{1x1,3x4,detail,spec,white,video}`；
   缺字段会列在「缺什么」，不会编造。生成后直接交给 `tb_ego_run_listing`。

`listing.json` 形状（能少写就少写）：

```json
{
  "id": "T00016",
  "title": "商品标题（≤30 汉字）",
  "cat": "居家布艺 > 地毯",
  "catid": "50000582",
  "brand": "无品牌",
  "attributes": { "货号": "XXX-50cm", "风格": "简约现代" },
  "colors": ["米白"],
  "styles": ["50x100cm"],
  "listPrice": 19.9,
  "skus": [{ "color": "米白", "style": "50x100cm", "price": 19.9, "stock": 100, "code": "XXX-米白-1米" }],
  "images": {
    "main": "D:/pics/main",
    "threeToFour": "D:/pics/3x4",
    "detail": "D:/pics/detail",
    "white": "D:/pics/white",
    "video": "D:/v.mp4",
    "spec": { "米白": "D:/pics/spec/white.jpg" }
  }
}
```

> 规则：一口价必须等于某个有库存 SKU 的价格（不在集合里时会自动取最高价并提示）；
> 图片目录缺哪类就自动跳过对应步骤（3:4 / 白底 / 视频都是可选的）；
> **一张 1:1 主图都没有就是上不了**（平台必填），工具会直接把它列进「缺什么」。

## 素材包

支持两种入口：

- `product`：已生成的 `product.json`（`img/{1x1,3x4,detail,spec,white,video}` 同级目录）
- `pack`：素材包根目录（含 `商品信息.xlsx` 与 `淘宝/<商品号>/`），自动跑 `tb_build.py` + `tb_prep_assets.cjs`

**标准素材包长什么样、怎么生成、怎么校验** → 见 [`skill/references/pack-spec.md`](skill/references/pack-spec.md)（别的 agent 照那一份就能独立产包）。

三条最容易翻车的规矩：

- `SKU模板/` 必须是**本类目官方模板**（列名各类目不同，如 `窗帘尺寸+加工方式` / `地毯尺寸` / `尺寸`），不许自己造表头、不许跨类目借模板
- SKU 矩阵 = **颜色 × 第二维 全组合**，不许缺、不许重复
- 上传前自动跑 `check_sku_template.py`：规格列没有值就**不上传**（否则平台报「未检测到有效销售规格」）

**给什么上什么**：素材包有 3:4 / 白底 / 视频 就传，没有就跳过；给了但本插件还没做的（如 `SKU搜索主图`）会明确报「暂不支持」，绝不静默丢。

## 排障

- `TB_EGO_DEBUG=1` 后重启 → 日志在 `%TEMP%\taobao-ego-plugin.log`
- 工具返回里 `raw` 字段是原始输出（JSON 没解析出来时看它）
- space 里若没登录淘宝 → 让用户自己在 ego 里登录，插件不代登录
- 其他坑位见 `skill/HANDOVER.md` 第六节
