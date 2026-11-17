# HANDOVER · 淘宝/千牛上架（ego 版）

> 2026-11-13 状态：**真机全绿**（space 4 / PE木纹 / catId 201802801）。
> 本目录是原 Playwright 版 `taobao-product-listing` 的 **ego 版**：判据、门禁、流程 1:1 保留，只换了执行底座。

## 零、一页速览（2026-11-16）

**两条输入路径，一个执行内核**

```
路径 A：素材包 商品信息.xlsx + 淘宝/<商品号>/图片
        → tb_build.py（Excel→product.json） + tb_prep_assets.js（图→img/）
路径 B：listing.json（极简：标题/价格/库存/规格/图片目录）
        → tb_ego_build_product（→ product.json + img/{1x1,3x4,detail,spec,white,video}）
        ▼
   tb_ego_run_listing（只填空 + 核对清单；绝不提交、默认不存草稿）
```

**上架前**：`tb_ego_env`（ego/Python(DSH 自带)/space）→ `tb_ego_spaces`（**ego 重启后 id 会变**）→
`tb_ego_category_profile`（抓该类目「必填属性 + 可选值 + 图片视频要求 + 模板状态」）。
表单数据（标题/价格/库存/规格/图片）**页面不会给**，必须用户给或素材包里有。

**步骤（`buildSteps()`，素材缺哪类就自动不排那一步）**

`1 入口/类目/品牌 → 1b 清弹窗 → 2 标题/属性/货号 → 3 官方 SKU 模板导入 + 一口价 → 3d 清导入弹窗 →
4 1:1 主图 → 4c 3:4 主图 → 5.1/5.2 详情图(≤20/批) → 5g 白底图 → 5e 商品视频 → 6/7/8 规格图 → 8b 品牌收尾 → 9 核对清单`

**SKU 导入表的来源顺序（关键）**

1. `__TB_CFG.skuTemplate` 显式路径 →
2. product 同目录 `sku_import_官方模板.xlsx` →
3. product.json 的 `sku_import` →
4. **`_downloads/SKU模板_<catId>_*.xlsx`（同类目缓存 → 不重复下载）** →
5. 都没有 → `downloadTemplate()` 下载**官方模板**（CDP 定下载目录 + 页面钩子抓 OSS 签名直链 + 30s 轮询 + 重试）→
6. 下载失败 → 按 product.json 生成兜底表（**打警告**，列名可能与官方不完全一致）。

拿到官方模板后**必须**把 product.json 的行写进官方表头（`fill_sku_template.py`：颜色→颜色分类、
款式→第二个规格列（如 地毯尺寸）、其余同名列如 厚度/宽度/长度/底背材质 从 skus/attributes 自动填），
再导入；否则导的是空表。
⚠️ 官方模板内容其实是 **xlsx**、但平台给的文件名常是 `.xls` → 下载后按文件头自动纠正后缀，否则 openpyxl 拒读。

**素材包「给什么上什么」**：会上传（有）/ 跳过（没给）/ 暂不支持（给了但没做，如 SKU搜索主图）——都要如实报。

**红线**：不点「提交宝贝信息」；`saveDraft` 默认 false；不代登录；不拿别的类目/别的商品数据顶替。

## 零之二、标准素材包（2026-11-16 定稿）

**只产一份**，这份既是「用户填的表」也是「pack 模式的输入」：

```
<素材包>\
├─ 商品信息.xlsx      4 sheet：怎么填 / 类目要求 / 基本信息 / 属性（亮黄=必填由用户填、浅绿=已预填）
├─ SKU模板\          该类目官方 SKU 模板（**SKU 数据就填在这里**，已预填可改；SKU 导入必填）
└─ 淘宝\<商品号>\     1比1主图 / 3比4主图 / 宝贝详情 / 规格图片 / 白底图 / 商品视频（用户丢图）
```

生成 → 用户填（商品信息.xlsx 填基础/属性，SKU 填在 SKU模板/ 里）→ `tb_ego_run_listing({ pack })` 自动识别并转换（`listing_xlsx_to_json.py --sku-template` + `build_pack.py --audience tb`）。

**★ 完整规范 = `references/pack-spec.md`**（目录结构 / 4 sheet 逐列语义 / 官方模板规则 /
SKU 矩阵 / 六个图片目录 / 生成命令 / 消费链路 / 校验点 / 常见报错 / 红线 / 交付自检清单）。
**别的 agent 要独立产包，只看这一份就够了** —— 下面只留最关键的几条：

| 铁律 | 说明 |
|---|---|
| 一个类目一份官方模板 | 模板列名各类目完全不同（地毯=`地毯尺寸` / 椅垫=`尺寸` / 窗帘=`窗帘尺寸+加工方式`）；**禁止硬编码第二维列名、禁止跨类目借模板** |
| SKU 矩阵必须完整 | 行数 = 颜色种数 × 第二维种数，**不许缺、不许重复**（窗帘 2 色 × 2 尺寸 = 4 行） |
| 写模板前先清旧行 | 追加 → 行数翻倍 + 混入 `米白-` 脏值 → 规格列命中率跌破 80% → 被清理 → 平台报「未检测到有效销售规格」（2026-11-16 实测事故，已修） |
| 上传前必须自检 | `check_sku_template.py`：规格列无值 / 价格空 / 组合重复 → **不上传**，返回 `sku_template_invalid` |
| 给什么上什么 | 素材没有的目录整步跳过；技能没有的能力明说「暂不支持」；不裁不补不改名 |

## 一、这是什么

把素材包（`商品信息.xlsx` 的「淘宝」sheet + `淘宝\<商品号>\` 素材目录）填进淘宝发布页：

- **只填空 + 读回核对**，绝不点「提交宝贝信息」；
- 收尾默认**不点保存草稿**（`saveDraft:false`；要存草稿再显式打开）；
- 一店 = 一个千牛账号 = 一个 **ego space**（不再有 Chrome 调试端口）。

入口固定走「搜索发品」`item.upload.taobao.com/sell/ai/category.htm`，**禁止以图发品**（会把主图自动铺进详情图）。

## 二、目录

| 路径 | 作用 |
|---|---|
| `SKILL.md` | 门禁 + 硬规则（原 Playwright 版的规则原样保留，顶部补了 ego 版说明） |
| `HANDOVER.md` | 本文件：环境、运行方式、步骤表、坑位、排错 |
| `lib/tb_ego.mjs` | 共享执行库：连 space、条件轮询、按文本点击、**CDP 子 frame 执行**（`frameEval` / `frameEvalShim`）、上传 |
| `scripts/run_listing_tb.mjs` | 编排层（1:1 复刻原 `run_listing.ps1` 步骤表） |
| `scripts/tb_enter_form.mjs` | 入口段（类目级联/品牌/进表单），同时导出 `enterForm(page, opts)` |
| `scripts/tb_fill_basic.mjs` | 标题、货号、属性（`sell-field-p-<id>`）、品牌 |
| `scripts/tb_import_sku.mjs` · `sku_table.mjs` · `tb_download_template.mjs` | 官方模板导入、SKU 虚拟滚动读表、模板下载 |
| `scripts/tb_upload_main.mjs` · `tb_upload_detail.mjs` | 1:1 主图（≤5）、详情图（每批 ≤20） |
| `scripts/tb_spec_add_image.mjs` · `tb_fill_spec_images.mjs` | 规格图开槽 + 逐格填充 + src 核对 |
| `scripts/tb_checklist.mjs` · `tb_save_draft.mjs` · `tb_panel.mjs` | 提交前核对、保存草稿、关素材面板 |
| `scripts/tb_build.py` · `tb_prep_assets.js` | 数据管道（素材包 → product.json / SKU 导入表 / img） |
| `scripts/run_tb.mjs` | 命令行入口：读 `run-config.json` → 起 ego 跑完整编排 |
| `run-config.example.json` | 上架参数模板 |
| `run-config.example.json` | **运行配置模板**：复制成 `run-config.json` 再改 `space/catid/cat/product`（键表见第四节） |
| `references/` | 原版 playbook / 现场记录 / ops-notes（DOM 侦察记录，仍有参考价值） |
| `output/<商品号>/` | 数据管道产物（`product.json`、`sku_import_官方模板.xlsx`、`img/{1x1,detail,spec}`） |

## 三、前置

1. **ego-browser**：默认探测 `~/.local/share/ego/active_version_dir/ego-browser.exe`（可用 `__TB_CFG.egoBrowser` 指定）。
2. **千牛登录**：在目标 space 里由**用户自己**登录（本技能不代登录）。
3. **Python（可选，自动用 DSH 自带的）**：只有 `pack`（素材包一键生成）模式需要；`product` 已就绪时不需要。
   技能会自动发现 `~/.dsh/dsh-runtimes/*/dependencies/python/python.exe`（与 `/office-xlsx` 用的是同一份，自带 openpyxl + Pillow）
   → **装了 DSH 的用户不需要另装 Python**；找不到时再回退系统 `py` / `python` / `python3`。
   3:4 裁剪（Pillow）仅在 `crop34:true` 时才做，默认 **false**（素材包有 3x4 才传，没有就跳过）。
4. **space**：由 `run-config.json` 的 `space` 指定（一店一个 space id）。**ego 重启后 id 会变** → 每次开跑先 `pdd_ego_spaces` 核对 id 与店铺；多店时问清这次发哪几家，不猜。

ego 的「space 控制权」规则：agent 与用户会互相 handoff。遇到
`Control of this task space is with the user` 时**必须停**，等用户在 ego 界面交还后再
`takeOverTaskSpace(spaceId)` 继续；不要自己抢。

## 四、怎么跑

### 方式 A：一条命令（推荐）

```powershell
# 1) 复制样例、按这次的商品改 space / catid / cat / product（或给 pack）
copy run-config.example.json run-config.json

# 2) 正式跑（默认**不存草稿、不提交**）
node scripts/run_tb.mjs --config run-config.json

# 3) 只做数据准备 + 打印计划，不碰页面
node scripts/run_tb.mjs --config run-config.json --dry
```

退出码取最后一行的 `REPORT`（`ok:true → 0`）。ego 子进程经常以 1 退出但 `ok:true` → **以 REPORT 为准**。

### 方式 B：直接起 ego（等价，调试用）

```powershell
ego-browser nodejs -e "await import('file:///<插件目录>/scripts/run_listing_tb.mjs').then(m=>m.runListing({space:6,catid:'201802801',cat:'家装主材 > 墙纸/墙布 > 自贴墙纸/自粘墙纸',product:'<插件目录>/output/MZBW-01/product.json',saveDraft:false}))"
```

> ego 子进程**不继承自定义环境变量** → 所有参数走 `globalThis.__TB_CFG`（`runListing(input)` 的入参也会合并进去）。

### 常用 `__TB_CFG` 键（与 `run-config.example.json` 一致）

| 键 | 默认 | 说明 |
|---|---|---|
| `space` | —（必填） | ego space id（一店一个）。**ego 重启后 id 会变**，每次先用 `pdd_ego_spaces` 核对 |
| `catid` / `cat` | —（必填） | 类目 id + 完整路径（`>` 分隔，级联树按逐级点） |
| `brand` | `无品牌` | 品牌（该店已申请的才可用） |
| `product` | — | `product.json` 绝对路径（数据已就绪时用这个） |
| `pack` | — | 或给素材包根目录（含 `商品信息.xlsx` + `淘宝/<商品号>/`，自动跑 `tb_build.py` + `tb_prep_assets.js`） |
| `skuTemplate` | `product` 同目录 `sku_import_官方模板.xlsx` | 官方 SKU 模板；都没有会自动下载该类目模板 |
| `python` / `node` | 自动探测 | `python` 需能 `import openpyxl`；**优先 DSH 自带那份**（`~/.dsh/dsh-runtimes/*/dependencies/python`） |
| `mainLimit` / `detailBatch` | `5` / `20` | 1:1 主图上限（平台硬上限 5）/ 详情每批张数 |
| `upload34` | **true** | 3:4 主图：**素材包有 `img/3x4` 才传，没有就跳过**（不自动裁） |
| `crop34` | **false** | 3:4 缺图时是否按 1:1 中心裁（默认不裁） |
| `uploadWhite` | **true** | 白底图（`img/white`，1 张）；没有就跳过 |
| `uploadVideo` | **true** | 商品视频（`img/video` 里第一个）；没有就跳过。也可用 `videoFile` 指定单个文件 |
| `uploadSettleMs` | `5000` | 图片传完后**等多久再点「完成」**（<2000 时列表常常只显示第一张） |
| `recheckAttrs` | **false** | 3c 复核属性（开了会把多选标签重复填，别开） |
| `saveDraft` | **false** | 收尾是否保存草稿（红线：绝不点「提交宝贝信息」） |
| `reloadFirst` | `false` | `true` = 先 reload 发布页，清掉上一轮残留表单/弹窗（建议 true） |
| `dryRun` | `false` | `true` = 只打印计划，不动页面 |
| `forceEntry` | `false` | `true` = 强制重走「搜索发品」入口（默认已在目标 catId 页就复用） |
| `listPrice` | `0`（用 product.json 的 `list_price`） | 一口价覆盖；**必须等于某个有库存 SKU 的价格** |
| `sizeSort` | `source` | 规格排序：`source` 照素材顺序 / `natural` 自然序 |
| `debug` | `false` | `1`/`true` = 打印调试细节 |

> 配置白名单在 `scripts/run_tb.mjs` 的 `CFG_KEYS`：**新增键要同时加进白名单**，否则会被过滤掉。

## 四点五、素材包资产自检（「给什么上什么」）

开工前先按 `img/` 目录和视频数出一份报告：

- **会上传**：素材包里实际有的（1:1 / 3:4 / 详情 / 规格图 / 白底图 / 视频）
- **跳过**：素材包没给的（对应步骤自动不排，例如没规格图就不做 6/7/8）
- **暂不支持**：技能暂时没有对应功能的（如 `SKU搜索主图`、多个视频/多张白底图、未知素材目录）→ **明确告诉用户，请人工处理**

## 五、步骤表（`buildSteps()` 实际顺序；素材包缺什么就自动不排那一步）

| # | 步骤 | 关键判据 |
|---|---|---|
| 1 | entry/cat/brand | 已在目标 catId 表单页则复用；否则走「搜索发品」级联 → 品牌 → 进 publish |
| 1b | clear dialogs | 清残留遮罩 |
| 2 | title/attrs/code | 标题 ≤60 字符、属性按 `sell-field-p-<id>`、货号 |
| 3 | sku/listprice | **模板自检+清理** → 官方模板上传 → AI 识别 → 在当前规格后添加 → 扫表对账；一口价必须 ∈ 有库存 SKU 价 |
| 3c | recheck attrs | **默认关闭**（`recheckAttrs:true` 才开）：规格导入后再跑 fillBasic 会把属性再点一遍，多选标签会重复 |
| 3d | close import modal | 导入弹窗残留会挡住后面所有图片点击（新增） |
| 4a/4b | close panel | 图片空间残留面板必须先关 |
| 4 | main images（≤5） | 按文件名认卡片 → 点图 → 空槽数 −1 |
| 4c/4d | 3:4 images（≤5） | 3:4 区块内**从左往右**；每张填完挪开鼠标 + Esc（清「裁剪/替换/删除」上下文菜单）；区块用「从1:1主图裁剪」所在行容器圈定 |
| 5.1 | detail images（每批 ≤20） | 上传 → 自动全选 → 点「确定(N)」；N 为权威判据 |
| 5c/5d | close panel / dialogs | |
| **5g** | white bg（1 张） | 白底图区块（「白底图」→「家装家居卖点头图」之间）传 800×800 白底图；`uploadWhite` 开关 |
| **5e** | video（1 个） | 上传 → 关「发布成功」弹窗（每次重读坐标并核实关闭）→ ego 选择器选卡片 → 「确认上传 ( N )」→ 切「图文描述」核实缩略图真的出现 |
| 6 | spec add-image | 勾「添加图片」开槽（新 UI 是文字/开关，不是 checkbox） |
| 7 | spec images | 逐格填 + src 不重复核对（`dupSrc`/`串位`） |
| 8 | spec confirm | 点「确认创建」 |
| **8b** | brand commit | SKU 导入会重渲染属性区、品牌可能弹回旧值 → 核对前再提交一次（新增） |
| 9 | checklist | 13 项核对（类目/标题/品牌/货号/一口价/总库存/SKU 行数/规格区/主图空槽/详情 img/页面报错…） |
| 10 | save draft | 默认跳过（`saveDraft:false`） |

## 六、关键坑位（改代码前必读）

1. **图片空间 iframe 是跨域的**（`market.m.taobao.com/app/crs-qn/sucai-selector-ng/...`）
   → `page.evaluate()` 拿不到 `iframe.contentDocument`（实测 `hasDoc:false`）。
   解决：`page.cdp()` 走 **CDP 子 frame 执行**，等价原版 `frame.evaluate`：
   ```
   Page.getFrameTree → 找到 sucai-selector-ng 的 frameId
   Page.createIsolatedWorld → executionContextId
   Runtime.evaluate(contextId) → 在子 frame 里跑原来的 DOM/坐标逻辑
   ```
   - `lib.frameEval(page, needle, fn, arg)`：直接给子 frame 写新逻辑；
   - `lib.frameEvalShim(page, needle, fn, arg)`：给「已按 page.evaluate 写好（内部自己找 iframe 再读 contentDocument）」的模块用 ——
     在子 frame 里把 `document.querySelectorAll('iframe')` 临时替换成「contentDocument=document 的假 iframe」，原代码不用改业务流程；
   - 所有点击仍是**真实鼠标**：`page.mouse.click(iframe.left + x, iframe.top + y)`。
   - iframe 会被重建 → 每次重新解析；context 失效时 `frameEval` 会自动重建隔离世界并重试一次。
2. **面板出现 ≠ 就绪；「本地上传」还可能落在窗口外**：
   - iframe 刚出现时还没渲染「本地上传」→ 先轮询到按钮存在；同时等 iframe **几何稳定**
     （面板是滑入/缩放动画，动画途中算出来的坐标点下去必定落空）。
   - **ego 窗口 <1200px 时，900px 宽的图片空间面板右半截会被窗口切掉**，「本地上传」落到窗口外
     （`elementFromPoint` 直接返回 `null`）→ 坐标点击永远无效、`text=本地上传` 也时灵时不灵。
     此时改走 **focus + Enter**：`frameEval` 里 `btn.focus()` → `page.keyboard.press('Enter')`
     （可信用户激活，按钮在屏幕外也生效，实测这是窄窗口下唯一能弹文件选择框的路径）。
     `run_listing_tb` 开跑时会读窗口宽度，<1200 直接告警。
   - **传完别立马点「完成」**：立刻点的话图片空间列表里常常只显示第一张 →
     **等 5 秒再点**（`__TB_CFG.uploadSettleMs`，默认 5000；用户实测结论 2026-11-14）。
3. **详情图要排除主图面板**：按 `name !== mainImagesGroup` 取最后一个 frame；否则详情步会挂到主图面板上（底部没有「确定」）。
4. **品牌**：弹层自带搜索框 → 写「无品牌」后选项过滤成 `["无品牌","无品牌/无注册商标"]` → **真实鼠标点**；
   往显示框 `insertText` 无效（blur 弹回旧品牌）。淘宝实际存的是「无品牌/无注册商标」，核对按包含关系。
5. **规格图文件名**：长中文名（带 `【】`）在卡片里匹配不上 → 搜索后取**视口内第一张 ≥50px 图**；
   点**右上角小框**（`right-9 / top+9`）；同一张图给下一个值要「先取消再选中」；实增不足必须报，不许假绿。
6. **「添加图片」**：新版是文字/开关，不是 `.next-checkbox` → 按 label 就近找勾选/开关（`label_near` / `drawer_fallback`）；
   读回勾选态允许从「勾选维度」里颜色分类行兜底。
7. **SKU 表**：新版空表单**不渲染** SKU 表（`no_table`）→ 先走模板导入，导入成功后规格与表才出现。
   模板必须是**单列规格**（只留 `颜色分类 / 价格 / 库存 / 商家编码`）；多留列（图案/材质/工艺/标题）会被 AI 识别成额外维度。
8. **一口价**：必须等于某个有库存 SKU 的价格；总库存按 SKU 汇总核对。
9. **提交红线**：永远不点「提交宝贝信息」；`saveDraft` 默认关。
10. **ego 子进程不能捕获 stdout**：`execFileSync(..., { stdio: 'pipe' })` 会报 `Unknown encoding: buffer`
    → 一律用 `stdio:'ignore'` / `stdio:'inherit'`，靠退出码判断。
11. **SKU 模板自检**：`scripts/sanitize_sku_template.py` 按 product.json 的 colors/styles 判定哪些是规格列，
    把 图案/材质/面层工艺/标题 等带值的非规格列清空（不清空会被 AI 识别成额外销售属性）。
    编排层 step 3 自动跑（先 `--check`，退出码 1 才真正的清理）。
12. **视频确认**：确认上传用 ego 选择器（坐标会飘），点完必须切到「图文描述」页看**视频缩略图**是否出现；
    上传后的「发布成功」弹窗先点「完成」，且每次点都重新读 iframe 位置。
13. **核对扫表超时**：第 9 步若因页面忙 `page.evaluate timed out` → 标注「未复核」，以第 3 步导入后的 99/99 对账为准。
14. **图片上下文菜单**：1:1/3:4 鼠标停在图上会弹「裁剪/替换/删除/AI作图」，点空槽/卡片会点到它。
    但 **「检测菜单是否消失」不能放热路径**：这页上判据会误判成「一直有菜单」，
    实测每张图白等 6.5s（第 2 张起每张都卡）。
    现在的做法：热路径只「挪鼠标到 (1250,60) + Esc」（约 80ms）；
    真正会不会点到菜单上，靠点前的命中校验兜住（见 15），只有点失败时才做完整菜单清理。
15. **点卡片必须「重新定位 + 卡片名校验」**：图片空间列表会随缩略图逐个加载而**重排**，
    上次算好的坐标会偏 → 每次点前重新 `findCard`，再用 `panelCall('hit', {x,y,name})`
    确认命中点的**卡片名就是这张图**，并在主文档确认最顶层是面板 iframe（不是悬浮菜单/透明遮罩）。
    注意：窗口外的点 `elementFromPoint` 返回 `null`，那是「点不到」，不是「可点」。
16. **一次把整批图传进去、再逐个点卡片**（2026-11-14 用户指正）：只开一次面板、只弹一次文件选择框，
    传完 → 等 5 秒 → 点「完成」→ 等「本次所有文件名都在列表里且缩略图加载完」→ 逐个点。
    3:4 / 白底区传完会**自动应用**占掉若干槽（`autoApplied`）→ 收工按「起始空槽 − 终态空槽」对账，
    别把「自动应用」的那几张算成失败（否则会出现「终态空槽 0 但报 not_all_slots_filled」）。

17. **规格图只提速「搜索 + 点图」**（2026-11-14，用户要求：上传时间不动）：
    - 搜索原固定等 3s → 改成检测「文件名命中卡片」或「列表被过滤到少数几张」就立刻走 → **0.26~0.6s/张**；
    - 点图前先等「小框坐标稳定」（选完右侧规格值后左侧列表会重排，用旧坐标点下去会落空 → 以前每张都补点）；
    - 点完用「面板已填 +1」确认（成功时 200ms 内就 +1；1.2s 没 +1 才补点一次）；
    - 实测 DT（9 色，每色 1 个值）：整步 **92.4s → 37.2s**，9/9 一次命中、唯一 src 9、串位 []；
    - 实测 PE（4 色 × 4 款，每色 4 个值 → 走「一张图给多个规格值」路径）：整步 **115.2s → 53.8s**，16/16；
      该路径的规律是「第 1 个值点 1 次、之后每个值**连点两次**（先取消再选中）」→ 现在直接连点，不再中间白等 1.2s；
    - 超长中文文件名在卡片里会被截断 → 搜索就绪判据不成立，最多等 2.5s 就用「视口内第一张」兜底（原 6s）。
    - 上传（②b ~11s）、打开填充面板（5s）、收尾核对（约 10s）**没动**。
    - 教训：那个图片小框是 `<LABEL>` 包着图片，里面**没有可读的 checked** → 别拿「勾选态」当判据。

18. **PNG 素材会被淘宝转成 JPG**（2026-11-14 猫抓布包实测）：文件名 `1比1主图_01.png` 上传后，
    图片空间卡片显示成 `1比1主图_01.jpg 1024x1024` → 只按原始文件名匹配会**永远找不到卡片**，
    表现为「一直在滚列表、一次都不点」（每次重试又从头滚一遍，100s+ 全花在滚动上）。
    现在 `cardAliases()` 会依次用「全名 / 去扩展名 / 换扩展名」认卡片，命中校验（`hit`）也走同一套别名；
    `findCard` 同一个名字**只盲滚一遍**、步数封顶 40 步。
19. **商品视频这条有三个独立坑**（2026-11-14 猫抓布包才暴露，DT 包当时碰巧没踩到）：
    ① 切「图文描述」页：`page.click('text=图文描述')` 会「点了但没反应」→ 改 `switchToTab()`（按坐标点 + 回读「商品视频」区块真出现）；
    ② 「确认上传」按钮：ego 的 `role=button[name*=确认上传]` 打进去**不生效**（面板不关、表单 0 个视频）；
       坐标点击在部分状态下也会落空 → 稳定生效的是**在 frame 内直接 `btn.click()`**（本轮实测 100% 生效）；
    ③ 点完别立刻点遮罩外——会把确认请求点断；先等「面板自己关 或 表单出现缩略图」最多 12s。
    另：`formVideoCount` 读回要同时数 `img/video` 缩略图与「上传视频」空槽（原实现只数 img 且区块标题
    会被左侧「填写助手」同名标题抢走 → 要用左边距取表单区那个）。

20. **别用 PowerShell 5.1 `-Encoding UTF8` 改 profile 的 JSON**（2026-11-16 真机事故）：
    `~/.dsh/profiles/desktop/package.json` 被写进 UTF-8 **BOM** 后，DSH 启动时 `readProfileManifest` 的
    `JSON.parse()` 把 `\uFEFF` 当非法 token → `Unexpected token '﻿'` → host 进程 fatal + 壳进程弹崩溃窗，
    **每次启动都崩**。`cordis.patch.yml` 同批被写 BOM（YAML 容忍所以没炸，但也要剥掉）。
    写这类文件一律：Node 写，或 `[System.Text.UTF8Encoding]::new($false)`；写完用严格 `JSON.parse` 复验。
    （本仓库 `install.ps1` 已内置 `Write-TextNoBom` + `Assert-NoBom` + `JSON.parse` 复验。）

21. **cli-ego 里必须先 `globalThis.__TB_NO_MAIN = true` 再 import `run_listing_tb.mjs`**
    （2026-11-16 真机踩到）：那个模块末尾有「CLI 直跑」入口，import 时没设开关会**自己跑一遍**，
    我们再调 `runListing()` 就是第二遍 → 第二遍里图片槽位已被占满，`4 / 4c / 5g` 全报 `not_enough_slots`，
    而日志里看起来「上一遍明明全绿」。判据：日志里 `== 淘宝 ego 版上架编排 ==` 出现**两次**就是它。
22. **工具返回值必须是 lossless JSON**：`tb_ego_run_listing` 之前返回体里带了
    `raw: report ? undefined : text`，`undefined` 让 DSH 判定「工具返回非法 JSON」(`value is not lossless JSON`)，
    模型只看到这个错、拿不到 REPORT。现在改成「只有没解析出 REPORT 时才放 `raw` 字段」。
    （这类改动在 `lib/index.mjs`，**要重启 DSH 才生效**；`scripts/` 下的改动每次调用都重新读，重启不需要。）

23. **`tb_ego_run_listing` 的参数要显式写在 props 里**（2026-11-16 真机踩到）：
    `defineTool` 的 `parameters` 只按 `props` 生成，工具只透传 props 里声明过的键。
    之前 `reloadFirst` / `skuTemplate` / `upload34` / `uploadSettleMs` 等没声明 → 传了也不生效，
    结果页面里残留上一轮的图 → `起始空槽 0` → 图片步全报 `not_enough_slots`。
    现在 props 补齐，且 `reloadFirst` **默认 true**（开跑先重载发布页）。
    ⚠️ props 改动在 `lib/index.mjs` → **要重启 DSH** 才生效。

### 没有素材包时的两条命令（2026-11-16 新增）

用户只给「图片 + 口头参数」时，别硬造数据，按这两步：

1. `tb_ego_category_profile({ space, catid, cat })` —— **只读**抓该类目发布页：
   属性名 / 必填标记 / 控件类型 / 当前值 / **下拉可选值**（自动展开再收，长列表会滚 `.options-content`）、
   1:1/3:4/白底/视频 的页面原文要求、官方 SKU 模板是否已下载。
   不给 `catid+cat` 就复用当前已打开的发布页；给了就走「搜索发品→级联选类目」。
   ⚠️ 抓的是「**这个类目必须填什么、每个能选什么**」；标题文案/价格/库存/编码/图片**页面上没有**，仍要用户给。
2. `tb_ego_build_product({ listingPath | listing, out })` —— **不碰浏览器**，
   把极简 `listing.json` 拼成 `product.json` + `img/{1x1,3x4,detail,spec,white,video}`；
   一口价不在 SKU 价格集合里会自动取最高价并提示；缺字段列进「缺什么」，绝不编造。

24. **SKU 必须给「颜色 × 款式」全矩阵**（2026-11-16 真机）：官方模板里只填「对角线」两行时，
    平台 AI 识别会按矩阵**补出 4 行**，其中两行价格/库存为空 → 对账「多 2 行」判失败。
    `listing_xlsx_to_json.py` 现在会算全组合并明确报 `SKU 缺组合 N 个…`，别等导入后才发现。
25. **「给用户填的素材包」识别**：`商品信息.xlsx` 是「基本信息 + 属性」且**没有「淘宝」sheet**（SKU 在 `SKU模板/` 里）。
    以前把「有 SKU sheet」当判据，SKU 移走后认不出 → 直接把 4-sheet 表喂 tb_build → `no_淘宝_sheet` 失败。
26. **pack 模式读表的坑**：`tb_prep_assets.js` 在插件里是 ESM（`package.json type:module`）→ 已改名 **`.cjs`**；
    它原来只拷 1:1/3:4/详情/规格 → 现在**白底图/商品视频也拷**；目标目录改成 `product.json 同目录的 img/`。
    另外「规格图片」给的是**目录**时，`build_pack.py` 会按「颜色里的中文片段」建 `spec_images`，否则规格图步报 `no_file`。
27. **SKU 模板优先级**：`<包>/SKU模板/*.xlsx` > `_downloads` 缓存 > 现下载 > 本地兜底生成。
    官方模板内容其实是 xlsx 但文件名常是 `.xls` → 落盘时按文件头纠正后缀，否则 openpyxl 拒读。

## 七、数据准备（pack 模式）

```powershell
$env:TB_XLSX = "<素材包>\商品信息.xlsx"
$env:TB_TEMPLATE = "C:\...\SKU模板_<catId>_*.xls"     # 可选：官方模板（按类目）
python scripts/tb_build.py --product-id <商品号> --out output/<商品号>
node scripts/tb_prep_assets.js --pack "<素材包>" --product output/<商品号>/product.json
```

产物：`product.json`、`sku_import_官方模板.xlsx`、`img/{1x1,detail,spec}`。

## 八、验证记录

### 2026-11-16 第五个类目 0→1：成品窗帘（catId 50024945，三级叶子，space 5「<你的店铺>」）

素材包 `<工作目录>\_stage\packs\CURTAIN-01`（4-sheet 用户版：2 色 × 2 尺寸 = 4 SKU，图 5/5/26/9/1/1）。

```
1 entry/cat/brand  reuse
2 title/attrs      33s
3 sku/listprice    49s → skuCount 4 | 一口价 89 | 总库存 2000
4 main images(5)   11s  → 5/5
4c 3:4 images(5)   12s  → 5/5
5.1/5.2 detail     59s + 30s → 20 + 6
5g white bg        11s → 1/1
5e video           19s → 确认上传(1)
6/7/8 spec images  8s + 30s + 8s → 2/2，唯一 src 2，串位 []
9 checklist        11s → 未通过 []，无此字段 [货号]
failed: []
```

★ 规格区读回 `SKU模式 · 【颜色分类、窗帘尺寸+加工方式】多层展示` —— 证明**类目专属第二维**（
`窗帘尺寸+加工方式`）被正确识别，不再被硬编码成「款式/地毯尺寸」。

**这一轮修掉的真实事故（平台报「未检测到有效销售规格，请检查文件格式与内容后重新上传！」）**

| 环节 | 原来错在哪 | 现在怎么做 |
|---|---|---|
| `tb_build.py --from-template` | `r0 = wst.max_row + 1` **追加**写，复跑/素材包自带已填模板时行数翻倍；把 `color-style` 硬拼进 颜色分类（style 空时留下 `米白-`） | 写前 `delete_rows(2, max_row-1)`（幂等）；有第二维列就只写颜色本身 |
| 第二维列识别 | `STYLE_KEYS` 精确匹配（款式/地毯尺寸/尺寸/尺码/规格/三维尺寸）→ `窗帘尺寸+加工方式` 与 `款式分类` 都认不出 → 猜成第一个列 `成品宽度`，尺寸整列丢 | 先认 **R4 元数据**（`parentKey=sku` 且 key 不含 `skuParam_`），再用 `dim_name`（来自素材包真实维度名）逐字/包含匹配，最后才退关键词 |
| `build_pack.py`（转内部格式） | 第二维取「模板里第一个不像数值属性的列」→ 窗帘取成 `成品宽度`，值还写 `sku.style`（空） | ① SKU 行里同名维度键有值 → 用该列；② 写值时 `sku.get(dim2) or sku.get("style")` |
| `sanitize_sku_template.py` | 只用 `product.colors/styles` 判规格列；`styles` 为空 + 有 `米白-` 脏值 → 命中率 4/8 → **把颜色列和尺寸列整列清空** | 把 sku 行的类目专属维度值也收进「规格值」；`--spec-cols` 可强制指定；★ 安全闸：清完没有任何规格列有值 → **拒绝执行**（退出码 3） |
| 上传前 | 没有闸门，直接把空规格表传上去，白跑一整轮 | 新增 `check_sku_template.py`：规格列必须有值 / 价格不能空 / 无重复组合 → 不过返回 `sku_template_invalid` 并逐条说明 |
| 核对清单 | 素材包给了 `货号`，但窗帘类目发布页**根本没有这个字段** → 天天假失败 | 新增「无此字段」判定：页面上没有该字段 → 记入 `无此字段`、不算失败，并在日志提示 |

**未保存草稿、未提交**。

### 2026-11-16 第七个类目 0→1：卫浴地垫（catId **50025801**，`家庭/个人清洁工具>>卫浴/置物用具>>地垫`）

**这是第一个「单层规格」类目**，挖出 3 个真 bug（都已修）。

```
1 入口 reuse（类目页需 品牌=无品牌 + 型号占位）│ 2 标题属性 15s │ 3 SKU+一口价 48s → skuCount 2 / 29.9 / 总库存 1600
4 1:1 5/5 (21s) │ 4c 3:4 5/5 (12s) │ 5.1+5.2 详情 20+6 │ 5g 白底 1/1 │ 5e 视频 确认上传(1)
6/7/8 规格图 2/2 唯一src2 串位[] │ 9 核对清单 → 未通过 []
failed: []
```

该类目官方模板表头：`尺寸（长×宽） | 颜色分类 | 价格 | 数量 | 商家编码 | 商品条形码 | 厚度`
页面规格区读回：`SKU模式 · 【颜色分类】单层展示`

| 环节 | 现象 | 根因 / 修法 |
|---|---|---|
| 入口（类目页必填「型号」） | 「确认，下一步」一直灰 → 直连 `publish.htm?catId=` 空页 | 类目页除了品牌还有「型号」这类必填（`name="p-20000~1"`，**没有** `sell-field-p-*` 容器）。新增占位填写：真实鼠标点输入 → Ctrl+A → 打字 → **Tab** → **点空白处 (1250,60)** → 读回；占位清单 `占位填写` 带回报告，提示「拿到素材包后请用户确认」。★ 只 set 合成事件没用，React 要真 blur |
| 规格维度 | 平台只建出 1 层（颜色），4 行矩阵塌成 2 行，对账 缺4多2 | 模板列 ≠ 规格维度：`尺寸（长×宽）/厚度` 是**每个 SKU 的属性列**。现在 `tb_category_profile` 读页面 `SKU模式 · 【…】` → `规格维度`，写进素材包「基本信息」，`listing_xlsx_to_json` / `build_pack` / `tb_build` 全链路遵守（single_dim 不再补默认「款式」） |
| SKU 属性列丢失 | 模板里 `尺寸（长×宽）/厚度` 整列空 | tb 表把单层类目的「每个 SKU 属性列」按 `parentKey=skuProp` 带上，写官方模板时按行取 `props[h]` |
| 对账 key | 期望 `米白-` vs 页面 `米白` | 单层时 style 为空 → key 拼成纯颜色（`tb_import_sku`） |
| 类目搜索 | 点候选不跳转；不在入口页时静默不导航 | `goto` 选项写错（`timeoutMs`→`timeout`）；候选改成点内部 `<a>`/最深同名节点 + 合成点击兜底 |
| 白底图（偶发一次） | `slot_not_filled`，空槽 1→1 | 同参数重跑即成功，未复现；暂记为偶发（面板状态残留） |

**未保存草稿、未提交**。当前页面填的是 `型号=通用款`（占位值），**需用户确认/改成真实型号**。

### 2026-11-17 验收（第二次）：一次性桌布 50022531 —— 发现「内联销售属性」这种 UI 形态

类目 `餐饮具>>一次性餐桌用品>>一次性桌布`（catId **50022531**，必填只有「材质」一项）。
模板表头 `颜色 | 尺寸 | 价格 | 数量 | 商家编码 | 商品条形码 | 厚度 | 包装数量`。

**结果：SKU/标题/属性/主图/详情/一口价/总库存 全绿，但 规格图 3 步不支持**（`failed: 6,7,8` + 清单「规格区」）。

现场读回（关键）：

```
销售信息 tab 里是**内联销售属性**：`销售属性 颜色(2) 添加图片 排序 删除 尺寸 …`
顶部文案是「**销售规格**」（不是 `SKU模式 · 【…】`）
没有任何「编辑规格」/「按规格单独设置」抽屉入口 → specAddImage 报 no_drawer
```

本轮已顺带修掉 3 处「按文案猜」的硬编码（对已支持的类目都更稳）：

| 位置 | 修法 |
|---|---|
| `tb_spec_add_image` / `tb_fill_spec_images` | 切抽屉前先确保在**销售信息 tab**（详情图那步会把页面停在图文描述）；抽屉入口按顺序试 **「编辑规格」→「按规格单独设置」** |
| `tb_checklist` | `规格区` 正则兼容 **「销售规格」**（原来只认 `SKU模式`），否则该类目永远判「规格区 null」 |

**结论（2026-11-17 当日已补上支持，见下节）**：`销售信息` 用**内联销售属性**（无编辑规格抽屉）的类目，
规格图现在**可以自动填充**；注意实现细节与「绝对不能重复点」的铁律（下一节）。

### 2026-11-17 验收：文化墙贴 0→1（第三个「颜色列名不同」的坑）

**类目** 家居饰品>>贴饰>>文化墙贴（catId **201884208**），**必填属性 0 个**（全选填，是个边界案例）。
模板表头：`颜色 | 尺寸/加工方式 | 价格 | 数量 | 商家编码 | 商品条形码 | 尺寸长宽 | 片数 | 特殊尺寸描述`
→ 规格维度 = **颜色 × 尺寸/加工方式**（注意颜色列叫「颜色」，不是「颜色分类」）

最终结果：`failed: []`，`skuCount 4 / 一口价 39.9 / 总库存 1600`，1:1 5/5、详情 19、规格图 2/2、3:4/白底/视频跳过、清单 `未通过 []`。

**同一类目连踩 3 处「硬编码 颜色分类」**（都已修，改成别名 `颜色分类|颜色|色`）：

| 位置 | 症状 | 修法 |
|---|---|---|
| `tb_build.py` 写官方模板 | **上传表的颜色列是空的** → 自检判「重复组合」→ 我们的闸拒绝上传（平台也会报未检测到规格） | 解析颜色列名（`COLOR_COLS` 别名），用它写值 |
| `tb_spec_add_image.mjs` `drawerState` | 找不到颜色行 → 勾选框点不动（`add_image_not_checked`） | 行匹配改别名正则 |
| `tb_spec_add_image.mjs` `pickCheckbox` 回退 | `rowEl` 为空 → 直接 `no_row`、什么都不点 | 回退行也改别名；并加「文字控件」兜底（点「添加图片」文字本身）；成功判据放宽为**规格图位数 > 0 也算勾上**（新版 UI 的 `input.checked` 读不回来） |

### 2026-11-17 追加：「内联销售属性」形态的规格图已支持（0.1.15）

该类目页面上直接是 `销售属性 颜色(2) ☑添加图片 排序 删除`，**没有编辑规格抽屉**，也没有「确认创建」按钮。
现在的处理：

| 环节 | 做法 |
|---|---|
| 进规格图前 | 先确保在「销售信息」tab（详情图那步会把页面停在「图文描述」）；抽屉入口按顺序试「编辑规格」→「按规格单独设置」 |
| 开图位 | 内联勾选框**读不到 `input.checked`** → 改为**看效果**：页面上 `[class*=option-image]` 的可见图位数 > 0 就视为已开启 |
| 填图 | 图位按**页面级**统计（不再只在抽屉里找），走同一套「批量填充规格主图」面板 |
| 确认 | 内联没有「确认创建」按钮 → 页面已有**带图**图位就算完成，不再点不存在的按钮 |
| 清单 | 「规格区」判据兼容 `销售模式/SKU模式/【…】展示/销售规格 *`（这类目文案就是「销售规格」） |

⚠️ **踩过的坑（用户现场指出）**：勾选态读不到时我“保守补点一次”，结果把已经开着的「添加图片」**点成了关闭**，
平台弹出「取消颜色规格图上传入口，会导致已上传的颜色图丢失」。
**铁律：内联形态下只要页面已有图位，绝不点「添加图片」；重试最多一次、且只在明确读到 `false` 时。**

实测结果（一次性桌布 50022531）：`failed: []`，`skuCount 4 / 5.9 / 4000`，1:1 5/5、详情 19/19、
规格图 2/2（唯一 src 2、串位 []），清单 `未通过 []`。

### 2026-11-17 规格图映射的硬要求：颜色值必须与文件名里的颜色字样一致

现代装饰画 50021907 验收时第 7 步报 `spec_file_missing`：listing 颜色写「原木色」，而素材里规格图只有
`白色 / 米黄色 / 浅粉色 / 浅蓝色` → 挑不到图。**这是设计行为（挑不到就如实失败，不瞎配）**，
把颜色或文件名对齐后重跑即全绿。

规则写进 `pack-spec.md` §4bis：SKU 颜色值必须与规格图文件名中的颜色字样逐字一致；
建议命名 `<商品号>规格图-<序号>-<颜色>.jpg`。

### 2026-11-17 架构修正：内联形态必须**独立分支**，抽屉逻辑一行不动（用户口径）

第一次给「内联销售属性」加支持时，我把新判断（“页面已有图位就跳过点击添加图片”）**写进了公共路径**，
结果把原本好用的**抽屉形态**带坏：收纳箱 50002711 出现「添加图片没勾上 → 确认创建空点 → 点到取消 →
平台弹『您本次执行的操作未提交生效，确认退出?』」。

**最终做法（0.1.16）**：

- `tb_spec_add_image.mjs`：先 `isInlineMode(page)` 探测（无可见抽屉 + 有 `[class*=option-image]` 图位或内联勾选框）；
  **命中就走独立函数 `specAddImageInline()`**，未命中则**完全走原来的抽屉流程**（勾添加图片 → 确认创建）。
- 内联分支要点：页面已有图位 → 视为已开启（**绝不重复点**，点了会关掉并弹“会丢失已上传图”）；
  没有图位 → 点**勾选框方框**（不是文字）**只点一次**，然后轮询等图位；confirm 阶段有带图图位即算完成。
- `tb_fill_spec_images.mjs`：仅把「抽屉作用域」放宽为 `抽屉 || 页面`（抽屉存在时行为不变），
  让内联形态能在页面级图位上填充。

验证（同一版代码，两种形态各跑一次真机 0→1，均 `failed: []`）：

| 类目 | 形态 | 结果 |
|---|---|---|
| 收纳箱 50002711 | **抽屉** | 6 开图位 2 个 / 7 规格图 2/2 / 8 确认创建 ok / 清单 [] |
| 一次性桌布 50022531 | **内联** | 6 开图位 4 个（已有即视为开）/ 7 规格图 2/2 / 8 已有图即完成 / 清单 [] |

### 2026-11-17 追加：模板「下载两次/三次」的根因与去重

用户发现每个类目在 `_downloads/` 里都留了 **2~3 个同 catId 文件**。根因不是重复调用，而是**一次点击产生两份**：

- 插件自己：抓 OSS 直链 → `fetch` 字节 → 写 `SKU模板_<catId>_<Date.now()>.xlsx`
- Chrome：因为我们设了 `Browser.setDownloadBehavior` 指向同一目录，它**也会把同一份下下来**（`…<OSS 时间戳>.xls`）
- 「下载模版」第一次点常常不发请求 → 要重试 2 次 → 于是 3 次点击 = 3 份平台导出 + 各自落地副本

修法（`tb_download_template.mjs` 末尾 `⑥b`）：下载成功后，把**点击之后新产生**的其它 `*.xls / *.xlsx / *.crdownload` 删掉，只留最终采用的那一份；点击前就存在的缓存（`beforeMap`）不动。
（不能按 md5 去重：每次重试都是平台的一次**新导出**，内容/时间戳不同。）
实测：门帘类目重跑后目录里**正好 1 个文件**，其它 8 个类目缓存**一个没动**。

⚠️ 中间踩过一个事故：`snapshot()` 返回的是 `Map<dir, Map<file, "mtime:size">>`，我第一版按普通对象 `beforeMap[d][n]` 取 → 永远 undefined →
**把整个 `_downloads` 的旧缓存都当"新文件"删了**。已改成兼容 Map 的写法；被误删的模板从各素材包的 `SKU模板/` 里还原（8 个类目全部找回）。

### 2026-11-17「生成素材包」链路修稳（下载模板 / 预填 / 规格维度）

| 环节 | 现象 | 根因 | 修法 |
|---|---|---|---|
| 下载官方模板 | **第一次必失败**（`download_not_landed`），第二次（弹窗还开着）才成功 | 弹窗是「合成点击」打开的，紧接着算坐标点「下载模版」：命中校验能过，但按钮的点击 handler **还没挂上** → 点了不发请求 | ① 点击前重新定位 + `elementFromPoint` 命中校验；② 命中但没发请求时**最多重点 3 次**（实测第 2–3 次成功，日志标签 `③d`） |
| 下载模板 | 每次都要人工提醒才成 | `ensureBasicInfoTab` 只看 DOM **存在**、不看是否可见 → 页面停在「图文描述」时误判就绪 → 不切 tab → 点不到可见的「批量导入」 | 就绪判定改成**必须可见**（`getBoundingClientRect` 有宽高） |
| build_pack | 包里模板只有表头、SKU 没预填（看起来像「模板没下载到」） | 官方模板常是「`.xls` 名字、xlsx 内容」，openpyxl 见 `.xls` 直接拒读 → **静默降级成拷空模板** | ① 入口按文件头纠正后缀（`50 4B`→`.xlsx`）；② 预填后**自检**（表头外至少 1 行数据），失败打 `❌` 并在 JSON 里 `skuTemplatePrefilled:false`，不再静默 |
| 规格维度 | 新建商品读到 `null` | 页面只有在**建过 SKU 之后**销售信息里才出现 `SKU模式 · 【…】` | 页面优先 → 退回 listing 的 `dimensions`，并在「基本信息」说明里**标明来源**（"页面未读到，此为素材包声明值"） |

验证结果（家用脚垫 50000583，清空缓存后**首次**跑）：`② 打开批量导入 方式=synth` → `③c 命中:true` → `③d 第2/3次重试` → `网络钩子拿到 OSS 直链` → `直链拉取 4393 字节` → `⑥ 落盘 (.xlsx, 50 4B 03 04)`；
随后 `build_pack` 输出 `✓ 预填 / ✓ 自检 4 行`，`商品信息.xlsx` 的 `规格维度 = 颜色分类 × 尺寸`。


2026-11-16 第六个类目 0→1：入户地垫（catId 201829521，`居家布艺>>地垫(新)>>入户地垫`）

全程用插件工具（`tb_ego_env` → `tb_ego_category_profile(exportXlsx)` → `tb_ego_build_pack(audience:"user")` → `tb_ego_run_listing`），
素材包 `<工作目录>\_stage\packs\DI-01`（2 色 × 2 尺寸 = 4 SKU；图 5/5/26/9/1/1）。

```
1 entry/cat/brand  reuse │ 2 标题属性 29s │ 3 SKU+一口价 48s → skuCount 4 / 29.9 / 总库存 3200
4 1:1 11s → 5/5 │ 4c 3:4 11s → 5/5 │ 5.1+5.2 详情 54s+30s → 20+6 │ 5g 白底 10s → 1/1
5e 视频 19s → 确认上传(1) │ 6/7/8 规格图 8s+30s+8s → 2/2 唯一src2 串位[] │ 9 核对 11s → 未通过 []
failed: []   （规格区 = 【颜色分类、尺寸】）
```

该类目官方模板表头（第 4 种形态）：`厚度 | 颜色分类 | 尺寸 | 价格 | 数量 | 商家编码 | 商品条形码 | 底背材质`
→ 第二维 = **尺寸**（又验证了一次「列名按类目变、不能硬编码」）。

**这一轮修掉的 3 个真 bug**

| 位置 | 现象 | 根因 / 修法 |
|---|---|---|
| `tb_category_search.mjs` | 类目搜索永远 `no_input`（历史记录都在） | `page.goto(url, { timeoutMs })` —— ego 的 goto **只认 `timeout/waitUntil/referer`**，写错选项会 throw，再被 `.catch(()=>{})` 吞掉 → **静默不导航**。改成 `{ waitUntil:'domcontentloaded', timeout:60000 }` |
| `tb_download_template.mjs` | 「下载模版」偶发 `dialog_not_open`（刚进类目第一次必踩） | 下载按钮只在**基础信息** tab，而 `categoryProfile` 抓完媒体要求会停在「图文描述」；外面那次「点一下基础信息」在新页面 tab 栏还没渲染时点空 → 「批量导入」不在 DOM。新增 `ensureBasicInfoTab()`：探测是否已就绪（有「批量导入」/ `.sell-component-sku-excel-upload`），没就绪就真实鼠标点 tab 并**等导入区出现**（最多 3 轮），仍不行则明确返回 `basic_tab_not_ready` |
| `run_listing_tb.mjs` `findTemplate()` | 平台给的文件常是「`.xls` 名字、xlsx 内容」，被挑中后 openpyxl 拒读 → 填模板/自检静默失败 | 优先挑 `.xlsx`；只有 `.xls` 时按文件头（`50 4B`）纠正后缀再返回 |

**未保存草稿、未提交**。

2026-11-13（PE木纹，catId 201802801，space 4，`saveDraft:false`）：

```
steps: 1/1b/2/3/3c/3d/4a/4/4b/5.1/5c/5d/6/7/8/8b/9 全部 ok
3 sku: 16 行 / 一口价 32 / 总库存 1600000
4 主图: counted 5 / uploaded 5 / want 5（空槽 11→6）
5.1 详情: uploaded 19 / want 19 / 确定（19）
7 规格图: 16/16，唯一 src 4，串位 []
9 checklist: 未通过 []
failed: []
```

**未保存草稿、未提交**；日志：`<工作目录>\_stage\live-log20.txt`。

### 2026-11-14 第三个素材包：猫抓布墙贴（拼多多版素材包，需适配）

`<本机用户目录>\Desktop\猫抓布墙贴发布素材包\墙贴发布素材包` 是**拼多多版**（Excel 只有「拼多多」sheet + 选项_pdd），
没有淘宝的 `淘宝/` 目录 → 用适配脚本 `_stage\adapt_pdd_pack.py` 生成 `output/MZBW-01/product.json` + `img/{1x1,detail,spec,video}`
（1:1 取轮播图前 5、详情 12、预览图 3、视频 1；属性只喂淘宝这类目真有的）。

| 项 | 值 |
|---|---|
| 类目 | 家装主材 > 墙纸/墙布 > 自贴墙纸/自粘墙纸（`201802801`，与 PE 同） |
| SKU | 36（3 色 × 12 款），一口价 96（=最高价，属于有库存 SKU 价），总库存 359964 |
| 结果 | ✅ 全绿：1:1 5/5 (10.9s) · 详情 12/12 · 视频 1 (19.7s) · 规格图 36/36（唯一 src 3）· 清单 未通过 [] · `failed: []` |
| 资产自检 | 会上传 1:1 5 / 详情 12 / 规格 3 / 视频 1；跳过 3:4、白底（素材包没给） |
| 未适配属性 | 材质/特点/图案元素/墙贴样式/厚度/产地/底胶种类/中层厚度 → 淘宝这类目页面上没有，已在 product.json 的 `attributes_unsupported` 里留档，不硬塞 |

### 2026-11-14 第四个素材包：猫抓板（抖音版素材包，带 3:4 + 白底图）

`<本机用户目录>\Desktop\猫抓板发布素材包\抖音\祺讯 50cm宽猫抓布自粘加厚…`（抖音版：主图/主图3比4/白底图/详情图/规格图片/主图视频）。
用 `_stage\adapt_dy_pack.py` 生成 `output/MZDY-01/product.json` + `img/{1x1,3x4,white,detail,spec}` + SKU 导入表（模板沿用 catId 50003280 那份口径）。

| 项 | 值 |
|---|---|
| 类目 | 宠物/宠物食品及用品 > 猫/狗玩具 > 猫抓板（`50003280`） |
| SKU | 8（2 色 × 4 尺寸），一口价 79（=最高价，属于有库存 SKU 价） |
| 结果 | ✅ 全绿：1:1 5/5 (10.9s) · **3:4 5/5 (15.4s)** · 详情 7/7 (34.4s) · **白底 1/1 (10.4s)** · 规格图 8/8 (38.4s，唯一 src 2) · 清单 未通过 [] · `failed: []` |
| 资产自检 | 会上传 1:1 5 / 3:4 5 / 详情 7 / 规格 4 / 白底 1；跳过 商品视频（素材包没给） |
| 备注 | 这个包的 1:1 与 3:4 都是 **PNG** → 正好验证了第 18 条的「PNG 会被转成 JPG」修复（3:4 也一次过） |

### 2026-11-14 复验（改动后，2 个素材包，space 6「淘宝资产验证」）

| 素材包 | 类目 | SKU | 结果 |
|---|---|---|---|
| DT-雨棚消音垫 | 地毯 `50000582` | 99（颜色×地毯尺寸） | ✅ 全绿：1:1 5/5 (11.6s) · 3:4 5/5 (12.4s) · 详情 26 张 (52+30s) · 白底 1/1 (10.9s) · 视频 1 (19.8s) · 规格图 9/9 (37.2s) · 清单 未通过 [] · `failed: []` |
| PE木纹自粘墙纸 | 自贴墙纸 `201802801` | 16（4色×4款） | ✅ 全绿：1:1 5/5 (10.5s) · 详情 19/19 (49.9s) · 规格图 16/16 (53.8s) · 清单 未通过 [] · `failed: []`；资产自检正确跳过 3:4/白底/视频（素材包没给），并明确报「SKU 搜索主图 暂不支持」 |

### 验证矩阵（2026-11-13，5 个素材包，全部真机跑完）

| 素材包 | 类目 | SKU | 结果 |
|---|---|---|---|
| PE木纹（Desktop\PE木纹淘宝素材包） | 自贴墙纸 `201802801` | 16（4色×4款） | ✅ 全绿（主图 5/5、详情 19/19、规格图 16/16、清单 13/13） |
| MZB-001（旧技能 output） | 猫抓板 `50003280` | 54 | ✅ 全绿 |
| DT-雨棚消音垫（旧技能 output） | 地毯 `50000582` | **99（两层规格：颜色 × 地毯尺寸）** | ✅ 全绿（主图 5/5、详情 20/20、规格图 6/6、清单全过） |
| MZB-003（旧技能 output） | 猫抓板 `50003280` | 48（6色） | ✅ 全绿 |
| PE-001（旧技能 output） | 自贴墙纸 `201802801` | 16 | ✅ 全绿（**首跑失败**：模板 图案/材质/面层工艺 列带值 → AI 识别成 4 个尺寸；加了模板自检后自动清理 → 全绿） |

> 模板被清理过的文件会留 `.bak-<时间戳>` 备份（这次 PE-001 的原模板备份在
> `<本机用户目录>\taobao-product-listing\output\PE-001\sku_import_官方模板.xlsx.bak-*`）。

## 九、排错（常见 why）

| why | 含义 / 处理 |
|---|---|
| `no_frame` | 图片空间面板没开（先点空槽/图位，等 iframe） |
| `no_content_document` | 走了 `page.evaluate` 读跨域 iframe → 改用 `frameEval`/`frameEvalShim` |
| `panel_not_opened` | 面板没出现：确认点击坐标在视口内、无残留遮罩（先跑 3d/4a 清场） |
| `panel_not_ready` | 面板在但没渲染出「确定(N)」/上传入口：等就绪或换选择器兜底 |
| `template_download_failed` | 官方模板没下到：给 `skuTemplate` 或手动放 `output/_downloads` |
| `no_table` | 空表单无 SKU 表：先模板导入（本版已自动处理） |
| `add_image_not_checked` | 「添加图片」没勾上（新 UI）：走 label/抽屉兜底 |
| `option_not_found` | 属性值不在本类目可选值：必填判失败、选填跳警告（不许静默换近义值） |
| `near_expected_rows_no_auto_append` | SKU 行数接近但不等：**绝不自动追加**（「在当前规格后添加」会累加） |
| `Control of this task space is with the user` | 控制权在用户：停，等用户交还后 `takeOverTaskSpace(spaceId)` |

## 十、红线

- 不点「提交宝贝信息」；默认不存草稿。
- 不代登录、不改价、不新建运费/规格模板。
- 失败即停，不绕过判据；对不上就报出来。
