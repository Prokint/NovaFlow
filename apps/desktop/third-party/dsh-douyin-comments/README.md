# dsh-douyin-comments

DeepSeek Harness（Cordis）工具插件：**采集抖音视频的公开评论**，注册一个工具 `douyin_comments`；并内置**评论词云分析台**（交互词云 + 评论表 + AI 解读，原 `dsh-comment-viewer` 插件已合并进来），采集完成后在**同一个面板**里自动切到词云。
（插件版本 0.9.22；**v0.5.15 起插件 / 内置扩展「抖音评论采集器」/ MCP `douyin-collector-mcp` 三件套统一编号**，同为 `0.5.65`。）

**0.9.26 变更**（2026-11-12）：**未开通/到期改成整页拦截**——此前未激活只是隐藏「采集」tab、评论词云仍可用；现在点「抖音评论」直接是授权页：标题（未开通 / 已到期）、到期时间、套餐与价格、「开通/续费订阅」按钮（跳购买页）、「我已有激活码」展开输入框（就地激活，成功后自动进入面板）。词云与采集入口都不再出现。

**0.9.25 变更**（2026-11-12）：**修多账号导出记录串号**——分析台和面板的「导出记录」除了本账号目录，还会把机器级 `~/.dsh/douyin-collector/out` 当可读根，导致 A 账号采集的文件出现在 B 账号的列表里。现在 NovaFlow（`DSH_NOVAFLOW_DESKTOP=1`）只读本账号 `$DSH_HOME/douyin-collector/out`、`last-out.json` 记录的目录和显式 `DSH_COMMENT_VIEWER_DIRS`；独立运行/旧版行为不变。

**0.9.24 变更**（2026-11-12）：**修激活失败时的报错**——`douyin_entitlement` 的错误分支只返回了 `ok/message`，但工具输出结构把 `activated/expiresAt/remainingDays/devices/deviceLimit/purchaseUrl/machineId` 都声明为必填，框架于是先报「输出字段不完整」，真正的失败原因（如激活码无效、设备超限）反而看不到。现在失败分支补齐全部字段并按错误码输出原因。

**0.9.23 变更**（2026-11-12）：**面板控制台补上订阅闸门**——此前只有工具入口（`douyin_comments`）在采集前校验授权，网页面板的「开始采集」走 `console.mjs` 的 `startJob` 没校验，未激活账号可以绕过面板直接采集。现在 `startJob` 同样要求已激活（未配置 relay 的独立运行模式不受影响）。

**0.9.22 变更**（2026-11-10）：**修 NovaFlow 内置包缺文件的问题**——`package.json` 的 `files` 白名单一直没加 `entitlement.mjs`，pnpm 按白名单打包 file: 依赖时把它漏掉了，导致 CI 出来的安装包里插件一 import 就崩（授权/采集都不可用）。
- 修法：`dsh-douyin-comments/package.json` 的 `files` 加入 `entitlement.mjs`；插件版本升到 0.9.22。
- 自检新增 `pkg-files-entitlement`，以后白名单再漏文件会被 341 项自检抓到。
- 说明：只改打包白名单，插件运行逻辑不变。

**0.9.21 变更**（2026-11-09，进行中）：**接入 NovaFlow 收费授权（v3.1 设计）**——采集不再只靠本地安装，改为「激活码 + 设备绑定 + 每次运行向服务端换运行凭据」。
- 服务端（新目录 `novaflow-collect/`，Node 24 + 内置 `node:sqlite`，无第三方依赖）：注册码/权益/设备/material/nonce 六张表；`POST /v1/activate`（Bearer 令牌 + code + machineId）、`GET|POST /v1/status`、`POST /v1/keys/issue`（签发 material + lease）、`POST /v1/devices/remove`；规则：一码绑一个 Now API `user_id`、同用户最多 **2 台设备**、有效期从激活时算起、nonce 防重放、按用户/IP 限流、版本白名单、material 版本可轮换（`cli.mjs material set/retire`）；`test/smoke.mjs` **17/17** 通过；本地已实跑 `material current` / `codes create`。
- 插件侧：新增 `entitlement.mjs`（`entitlementEnabled()` 只在配置了 `NOVAFLOW_RELAY_URL` 或 `NOVAFLOW_COLLECT_BASE` 时启用，独立运行/开发模式行为不变；`status/activate/removeDevice/issueKey`；relay 模式走 `/novaflow/collect/*` 并带 `x-novaflow-capability`）；`collector.mjs` 的 `keyMaterial()` 优先用服务端签发的 material（仅内存、不落盘），其次 `DYC_MATERIAL`、最后内置常量；`build-encrypted.mjs` 支持 `DYC_MATERIAL=<64hex>` 轮换；`index.js` 每次采集前校验订阅 + 强制换 key，新增 `douyin_entitlement` 工具（查询状态 / 用激活码激活）；词云面板新增 `/api/entitlement`、`/activate`、`/remove` 接口；`client/client.js` 在收费模式下隐藏「采集」tab、只留评论词云 + 订阅状态条。
- 安全契约：服务端只存 64 hex material，客户端自行拼 `|dyc.v1` 再派生密钥；上线前必须 `node cli.mjs material set --version v1 --material <插件构建用的 64hex>`，否则 `core.enc` 解不开。
- 本地联调（relay 模拟）：`NOVAFLOW_RELAY_URL=http://127.0.0.1:8900` + 桩 relay 注入令牌 → `status`（未激活）→ `activate('NOVA-DY-…')`（30 天）→ `status`（已激活/1 台设备）→ `issueKey`（material 与插件内置 64hex 一致、lease 正常）→ `collector.mjs` 用服务端 material 成功解密加载。
- 待办：M3 NovaFlow 主进程 relay 桥接（需要 NovaFlow 源码仓库，本机只有 `novaflow-asar` 构建产物）、zpay 购买页、面板文案、部署文档与正式域名（`collect.lanjiaotrade.com`）。

**0.9.20 变更**（2026-11-09）：**评论表的「收藏」星标挪到最右侧独立一列**——用户反馈星标挤在用户列（昵称/抖音号下面），要和用户信息分开。
- 改法：`viewer/index.html` 表头新增 `<th class="col-star">收藏</th>`（放在「情感」之后）；`viewer/app.js` 把 `fav-star` 按钮从 `userCell` 移出，作为 `starBtn` 放进每行最后的 `<td class="cell-star">`；`viewer/styles.css` 新增 `.col-star`（48px）、表头/单元格居中、`td.cell-star .fav-star { margin-left: 0; }`。
- 自检 **345/345**（新增 `table-star-col`）；本次只改前端，刷新词云页即可。

**0.9.19 变更**（2026-11-09）：**「负评 Top3」改成「评价 Top3」**——用户反馈按点赞排出的负评 Top3 其实是高赞玩梗/感动类评论（`第一波生气纯是因为弹幕多说了一个敢[捂脸]`、`这波贪了，应该留到除夕夜看的[流泪]`、`独生子看哭了[流泪]`）。词典打分对这类「表面负词、实际正向」的评论仍会误判，所以这个榜单不再按情感筛。
- 改法（`viewer/app.js`）：`negTop` → `topComments`（只过滤有文字的评论，按 `digg` 降序取前 3），标题「评价 TopN（按点赞）」；每行 tooltip 显示「按点赞排序的 TopN 条评价 · 情感倾向：正向/中性/负向（词典打分 x）」；点击提示里仍标出该条的情感倾向。
- 情感统计条（正向/中性/负向占比）保留不变，本版只改这个榜单的口径。
- 自检 **344/344**（`sentiment-v2` 断言改为 `const topComments = list` / `评价 Top${topComments.length}（按点赞）`）；本次只改前端，重新加载导出并刷新词云页即可。

**0.9.18 变更**（2026-11-09）：**修「链接后面粘着分享口令时识别不出来」**——用户粘贴 `<video 链接>,6.61 c@N.JI 04/24 …` 这类文本，链接正则把逗号后的口令也吞进 URL（`https://www.douyin.com/video/7705265840823941352,6.61`），`new URL()` 之后拿不到 videoId，整条就「不识别」。
- 修法（`src-core/collector.src.mjs`）：`extractDouyinLink` / `splitDouyinInput` 的链接正则排除 `， , ; ； 、 |`（口令里的逗号在这里截断），并新增 `trimLinkTail()` 统一清掉粘在尾部的标点；`resolveDouyinVideoInput` 再加一层兜底——URL 解析不出 id 时直接从文本里捞 `/(video|note)/<id>`、`modal_id=<id>`。
- 实测（用户原文）：`splitDouyinInput` → 两条干净链接；`resolveDouyinVideoInputs` → 2 条标准作品页（第二条 `v.douyin.com/7OHhOJSCEK0` Node 跟跳解析成 `https://www.douyin.com/video/7705767138686513382`）；真机两链接采集两条都成功（147 + 143 = 290 条评论，29s，合并 CSV 290 行）。
- 自检 **344/344**（`multi-link-core` 增加 `trimLinkTail` / 分隔符断言）；`core.enc` 已重建（`250e8103…`），扩展未改（仍 0.5.65）。

**0.9.17 变更**（2026-11-09）：**修「多条链接和自动识别打架」**——控制台已经把「多条链接」解析成 `urls` 数组，但 `index.js` 注册控制台时自带的 `collect` 分发只认 `keyword` / 单视频，`urls` 数组会退化成「单视频模式但 url 为空」，表现就是自动识别成功却启动失败（用户反馈「他现在会和自动识别撞」）。
- 修法：`index.js` 里的控制台 `collect` 也按 `opts.urls.length > 1` 分发到 `collectDouyinLinks`，与 `console.mjs` 的默认分发保持一致；单条链接仍然走 `collectDouyinComments`。
- 自检 **344/344**（`multi-link-wiring` 增加 index.js 控制台分发断言）。本次只改 `index.js` / 文档，无需重建 `core.enc` 与扩展。

**0.9.16 变更**（2026-11-09）：**支持一次粘多条链接（逗号 / 空格 / 换行分隔），逐条采集后合并成一份 CSV/JSON**（用户 m04964：`多条链接中间可以用,或者空格隔开`）。
- 核心（`src-core/collector.src.mjs`，`resolveDouyinVideoInput` 之后）：
  - `splitDouyinInput(text)`：先从文本里抠出所有 `douyin.com` / `iesdouyin.com` 链接（分享文案里的链接会被抽出来）；文本里没有 http 链接时按 `空格 , ， ; ； 、 |` 拆 token（支持直接粘一串纯 id）。
  - `resolveDouyinVideoInputs(text, opts)`：逐条走 `resolveDouyinVideoInput`（直链/短链/分享文案都行），按 url / videoId 去重，返回 `{ ok, targets, errors, count }`。
  - `collectDouyinLinks(o)`：**没有搜索阶段**，直接逐条复用单视频采集（`collectDouyinComments`，沿用 v0.9.3 的中档回复参数与「视频之间 3~8s 随机停顿」），每条采完读分片 JSON 合并；产物 `douyin-links-<N>-<时间戳>.csv/json` + `douyin-videos-links-<时间戳>.csv`，JSON 里带 `links / videoCount / commentCount / videos / comments`（每条评论有 `video_index`、`video_id`、`video_title`、`video_url`、`video_kind`）。
- 接线：`index.js` 的 `url` 参数先 `resolveDouyinVideoInputs`，>1 条时走 `collectDouyinLinks`（日志「识别到 N 条链接：逐条采集后合并成一份 CSV/JSON」）；`console.mjs` 的 `normalizeInput` 接受 `urls` 数组、`/api/resolve` 返回 `{count, urls, targets}`、`POST /api/jobs` 自动拆成 `body.urls`；采集页链接框粘贴多链接时只 toast「识别到 N 条链接，将逐条采集」保留原文，placeholder 改为「粘贴链接或分享文案（多条用逗号/空格隔开）」；词云分析台的文件过滤正则加入 `links`（`douyin-links-*.json` 可被列表/加载/删除）。
- 真机验证（`_probe/e2e-links.mjs`，两条链接用空格分隔）：日志「识别到 2 条视频」→ 逐条采集、视频之间停顿 8s → 两条都 `成功`（105 + 145 = 250 条评论，24s），合并成 `douyin-links-2-2026-11-09T07-29-17.csv`（250 行）+ `douyin-videos-links-2026-11-09T07-29-17.csv`（2 行）；已采过的视频会提示「没有本轮新数据」并按 0 条入库，不影响合并导出。
- 自检 **344/344**（新增 `multi-link-core`、`multi-link-wiring` 两项断言）；`core.enc` 已重建（`63fedb3e…`），扩展未改（仍 0.5.65）。

**0.9.15 变更**（2026-11-09）：**采集核心也兜底解析分享文案**（用户报「采集未成功：扩展面板没出现」，实际是旧进程把整段分享文案当 URL，`page.goto` 报 `Cannot navigate to invalid URL`，等了 30s 才误报成扩展没生效）。
- `src-core/collector.src.mjs` 的 `collectDouyinComments` 入口新增兜底：`url` 不以 `http(s)://` 开头时，先走 `resolveDouyinVideoInput` 提取/跟跳，得到标准作品页再打开；解析不出直接抛「视频链接无效：没认出抖音链接（请粘贴视频页链接或完整分享文案）」，不再把分享文案交给 `page.goto`。
- 这样无论从工具参数、控制台、还是 MCP 直接调 collector，粘分享文案都不会再出现「扩展面板没出现」这种误导性报错。
- 自检 **342/342**（新增 `collector-share-url` 断言）；`core.enc` 已重建，扩展未改（仍 0.5.65）。

**0.9.14 变更**（2026-11-09）：**视频链接框支持整段分享文案 / 短链自动提取；采集页的说明文字精简**（用户 m04678 要求「这个介绍去掉，提示也不要这么具体，还有那个链接，搞成能识别分享链接，自动提取的」）。
- `app/index.html`：视频链接 placeholder 改为「粘贴视频链接或分享文案」（不再放完整示例 URL 占位）；关键词标签从「关键词搜索（v0.9.0：填了就走「按关键词搜视频 → 采前 N 条视频的评论」，此时视频链接不用填）」改成简洁的「关键词搜索」，placeholder 改「输入关键词」。
- 新增核心函数（`src-core/collector.src.mjs`，`douyinTargetFromUrl` 之后）：
  - `extractDouyinLink(text)`：从任意文本里提取第一个 `douyin.com` / `iesdouyin.com` 链接；
  - `resolveDouyinVideoInput(text, opts)`：直链/纯 id 直接标准化成 `https://www.douyin.com/<video|note>/<id>`（`source=direct`）；短链（如 `v.douyin.com/xxx`）先用 Node `fetch` 跟跳、从落地 URL 或 HTML 的 `aweme_id` / `modal_id` 里取 id（`source=share` / `share-html`）；Node 抓不到时**不阻断**，原样返回链接（`source=link-pending`），交给浏览器打开后由页面自己跳到 `/video/<id>`，扩展照样能认出 videoId。
  - `POST /api/resolve`：控制台粘贴即解析（失败 400「没识别到视频链接」）；`POST /api/jobs` 在入队前也用同一解析器把 `body.url` 换成标准作品页。
  - `app/app.js`：链接框在 **paste / blur / Enter** 时自动调用 `/api/resolve` 回填标准链接（成功 toast「已识别视频 &lt;id&gt;」），失败只 toast 提示、不丢原文。
  - `index.js`：工具调用（`url` 参数）同样先走 `resolveDouyinVideoInput`，日志里会打「分享链接已还原成作品页」。
- 实测（`_probe/check-resolve.mjs`）：直链 video / 直链 note / 纯数字 id / 整段分享文案 / `iesdouyin.com` 分享链接全部正确标准化；真实短链 `https://v.douyin.com/iRNBho6u/` 用 Node fetch 跟跳解析出 `https://www.douyin.com/video/7298145681699622182`；无链接文本报「没找到抖音链接（粘贴视频页链接或完整分享文案）」。
- 自检 **341/341**（新增 `share-link-resolve-core`、`console-share-url` 两项断言）；`core.enc` 已重建（`71bb44ef…`），扩展未改（仍 0.5.65）。

**0.9.13 变更**（2026-11-09）：**修「负评 Top3 里其实不是负评」（情感词典假阳性，用户 m04584 反馈）**。
- 假阳性来源（用真实导出 `_probe/out-keyword-overlay2/…` 复现）：①`[抠鼻]` 被复制 9 次，旧版每次计 `-1.2` 合计 `-10.8`，把「你的作品非常优秀，你是最棒的」判成负评；②`Intl.Segmenter` 把「谢贵师传喜讯」切成 `谢|贵|师`，单字「贵」计 `-1` 造出假负评；③「不要制冰 求推荐」里「不要」跨空格否定到下一子句的「推荐」，把需求贴翻成负向。
- 修法（`viewer/app.js` 的 `sentimentOf`）：①表情**按去重后的种类**计分（±0.6/种）并封顶 ±1.2；②按标点/空白切子句，否定词只在子句内生效；③新增整词短语表 `SENT_PHRASE_NEG`（不好用/差评/太贵/有点贵/一般般/踩雷/退货…）先扫描并删除命中片段，避免分词碎片重复计分；④单字弱负向词（贵/差/弱/水/坑/卡…）只有紧邻程度词/否定词或后接「了/啊/死/得/多/些」时才计分；⑤新增 `SENT_REQUEST_RE`，「求推荐/求链接/怎么买」里的「推荐/安利」不计正向。
- 负评行现在可在悬停时看到 `词典打分 X，命中 N 个负向特征`（标题改为「负评 TopN（按点赞 · 词典打分）」），方便人工复核。
- 实测：同一份导出负评从 2 条降到 1 条（剩下的「昨晚上拍那个视频找到很多人的反对，现在我删了。[流泪]」确属负向语境）；15 条单元样例全对（太贵了/有点贵/不贵/差评/不好用/一般般/很好/求推荐/垃圾别买…），脚本 `_probe/check-sent.mjs`。
- 自检 **339/339**（新增 `sentiment-v2` 断言）。

**0.9.11 / 0.9.12 变更**（2026-11-09）：**评论表后半段短列统一居中，用户列也纵向居中**（用户截图要求「居中一下后面的日期点赞等」「用户这一栏也上下居中一下」）。
- `viewer/index.html`：表头这 5 列本来就带 `col-*` 类；`viewer/styles.css` 新增 `thead th.col-num / .col-ip / .col-time / .col-level / .col-sent { text-align: center; }`，表体用 `tbody td:nth-child(n + 3):nth-child(-n + 8)` 把「点赞 / 回复 / 属地 / 时间 / 层级 / 情感」六列统一 `text-align: center; vertical-align: middle;`（长评论行里数字和日期不再贴顶）。
- 数字列（点赞 / 回复、时间）额外加 `font-variant-numeric: tabular-nums`，等宽数字对齐更整齐；评论内容保持左对齐。
- 0.9.12：`tbody td:nth-child(2) { vertical-align: middle; }`，用户列（头像 + 昵称 + 抖音号 + ☆）整体垂直居中，长评论行里不再贴顶。
- 自检仍 **339/339**；无头 Chromium 实测表头/单元格 `textAlign=center`、`verticalAlign=middle`（截图 `_probe/table-align.png`）。
- 顺带把词云页底部 `#uiVer` 更新到当前版本（此前一直停在 `v0.9.0`）。

**0.9.10 变更**（2026-11-09）：**采集页去掉高级参数展示 + 去掉深/浅主题切换（固定白色主题）**。
- 用户要求（附采集页截图）：「这一部分都不要展示了，默认这些参数就行，以及那个主题也去掉，保留白色主题」。
- 采集页（`app/`）不再展示这些高级参数，一律走后端默认值：目标条数（`max`=80000）、顶层路数（`lanes`=3）、总超时（30 分钟 / 关键词模式 4 小时）、等扫码（`waitLoginSec`=180）、补采二级回复（默认开）、先清空旧数据（默认关）、同时导出词云 HTML（默认关）。`app/index.html` 删掉这两行 field-row；`app/app.js` 的 `startCollection` 不再读取/下发这些字段，`loadConfig` 也不再回填。
- 主题：控制台（`app/index.html`）与评论分析台（`viewer/index.html`）都删掉右上角深/浅切换按钮，两页在启动时固定 `data-theme="light"`（白色主题），`theme-color` 统一改为浅色 `#f5f6f8`；`app.js`/`viewer/app.js` 里的 `themeBoot`/`themeButton` 逻辑移除（CSS 里的深色 tokens 保留但不再启用，便于以后恢复）。
- 自检：插件 0.9.10（扩展/MCP 仍 0.5.65）；`verify-tool.mjs` 新增 v0.9.10 断言（采集页不含上述 7 个 id、app.js 不读这些字段、控制台与词云页都固定 light、无 `btnTheme`、README），全绿 **338/338**。
- 注：只改了 `app/`、`viewer/` 前端（不涉及 `src-core/` 与 `extension/`）→ 无需 `build-encrypted` / `sync-extension`；同步安装副本并退出重开 DSH 生效。
- **0.9.10 修订（同日）**：修两个浅色主题下的样式回归（用户 m03861 附图）——①右上角按钮 hover 变「黑块」：`viewer/styles.css` 的 `.btn:hover` 硬编码了深色 `#17171a`，浅色主题下配深色字就看不见字，新增 `[data-theme="light"] .btn/…primary/…ghost:hover` 覆盖（hover 改为浅灰底 + 深色字，主按钮 hover 用深蓝底 + 白字）；②「地域分布」每行右侧 `102 条 · 80 人` 溢出行框/卡片：根因是 `viewer/styles.css` 旧 `.region-num` 带 `width: 52px` 固定宽（比实际文字 58~64px 窄），改为 `width: auto`，同时把地域网格列宽从 `minmax(272px,1fr)` 提到 `minmax(300px,1fr)`、地域名列 52→48px、行加 `overflow: hidden` 兜底。已用无头 Chromium 实测：hover 后按钮背景 `rgb(247,249,251)`、文字 `rgb(18,22,29)` 正常可见；12 个地域行右侧均比行框内收 9px，面板无横向溢出（`scrollWidth == clientWidth`）。
- **0.9.10 修订（第二次）**：「按地域分组看客户 / 已收藏客户」弹层里那一排地域 chip 改成**下拉框**（用户 m03971 附图）。`viewer/index.html` 把 `<div id="groupChips" class="group-chips">` 换成 `.group-filter` 里的 `<select id="groupRegionSel" class="select small">`；`viewer/app.js` 的 `renderGrouped()` 两种模式（正常分组 / `__fav__` 收藏客户）都改为填充 `<option>` 并回选当前地域，`#groupChips` 的点击监听换成 `#groupRegionSel` 的 `change` 监听；样式新增 `.group-filter`（下拉最小宽 240px）。原先 chips 用的 `.group-chips` CSS 保留但已无引用。
- **0.9.10 修订（第三次）**：词云页用户头像改为**优先显示抖音真实头像**（用户 m04046 附图问「这些用户头像能拿到吗」）。抖音评论接口的 `comment.user` 本来就带 `avatar_thumb/avatar_medium/avatar_larger`（`url_list[0]` 是 p3-pc.douyinpic.com 的头像 jpg），导出 JSON 里一直存着、只是分析台没读。现在 `viewer/app.js` 的 `normalizeUser()` 增加 `avatar: pickAvatarUrl(u)`（依次取 thumb/medium/larger/168x168/avatar），渲染用 `avatarHtml(user)` 输出 `<img class="av-img" referrerpolicy="no-referrer" onerror="this.remove()">` 盖在「首字 + 淡色底」占位上；加载失败 / 老数据 / 收藏列表没有头像时自动退回首字。评论表、按地域分组弹层、收藏客户弹层三处都生效。`viewer/styles.css` 加 `.avatar .av-img`（绝对定位铺满、`object-fit: cover`、圆形）。注意头像链接是抖音 CDN 直链（个别过期会 404，有首字兜底），导出 CSV 列结构没动。`verify-tool.mjs` 新增 `viewer-avatar` 断言，全绿 **338/338**；无头 Chromium 实测按真实头像渲染：评论表 50/50 行带头像、分组弹层 139 个头像中 25 个成功加载（其余在截图等待时间内未下完，失败会退回首字）。
- **0.9.10 修订（第四次）**：**收藏客户列表也补上真实头像**（用户先反馈「收藏客户那里也没头像」→ 词云页弹层修好后又发采集页截图说「还是没头像」，说明两处都要修）。
  - 词云页（`viewer/app.js`）：加 `uid/secUid → 头像` 内存索引（`normalizeUser()` 登记、`avatarOf(rec)` 查），收藏时 `favPayload()` 把 `avatar` 存进 `favorites.json`，老收藏用 `backfillFavoriteAvatars()` 从当前导出补；「已收藏客户」弹层渲染 `avatar: avatarOf(f)`。
  - 采集页（`app/app.js` + `app/styles.css`）：`renderFavorites()` 的行加 `<img class="fav-avatar-img" referrerpolicy="no-referrer">` 盖在首字占位上，加载失败自动移除露首字；`.fav-avatar` 改相对定位 + 圆形裁剪。采集页本身拿不到评论数据，头像由服务端补。
  - 服务端（`viewer.mjs`）：新增 `userAvatarUrl(raw)`（取 thumb/medium/larger 的 `url_list[0]`）、`avatarIndexFromExports(wanted)`（从最近导出 JSON 建索引：最多扫 40 个文件、80MB 以上跳过、凑齐 `wanted` 就提前停、结果缓存 60s）、`enrichFavoriteAvatars(store)`（给缺头像的收藏补上并写回 `favorites.json`）；`/api/favorites` 的 GET 与 POST 都会先补一次，所以老收藏一打开采集页就有头像（不依赖先开词云页）。
  - 实测：3 条不带头像的老收藏 → 词云弹层 3/3 真实头像加载成功；采集页用 1 条无头像收藏 + 真实 CDN 链接 → `rows=1, imgs=1, loaded=1, broken=0`（截图 `_probe/fav-console-avatar.png`）。`verify-tool.mjs` **338/338** 全绿（新增 `favorites-avatar-server`、`fav-avatar-app` 两项断言）。

**0.9.9 变更**（2026-11-09）：**采集结束后自动关闭浏览器窗口，不再把窗口留在屏幕上**。
- 背景（用户 m03610，问「现在采集完不会自动关闭浏览器吗」）：0.9.7 起「静默风控」收工时为了让人工介入保留了窗口，但静默风控其实**不需要人工介入**（页面没有验证 UI）→ 窗口白白留开，还容易在下一轮采集时撞 profile 占用（就是 0.9.8 那个 `Failed to launch` 的来源）。
- 修复（`src-core/collector.src.mjs`）：`risk-silent` 收工分支不再 `keepForLogin = true`，照常走 `shutdownDouyinBrowser()` 关窗口（已采数据在扩展存储里，重跑仍可断点续采、只交付新增部分）。
- **仍会保留窗口的只有三种情况**：①真·人机验证（页面上确实出现验证浮层，`endedBy=verify-wait`，需要你在窗口里过验证）；②没登录（需要你扫码，`phase=need-login`）；③显式 `keep=true`（调试用，采完不关）。
- 关键词模式说明：任务执行**期间**每个视频采完窗口会保持打开（内部 `keep:true`，避免反复重开浏览器触发风控），整个任务结束/取消/出错时统一关闭。
- 自检：插件 0.9.9（扩展/MCP 仍 0.5.65）；`verify-tool.mjs` 新增 v0.9.9 断言（risk-silent 分支不含 `keepForLogin = true`、日志含「浏览器窗口会自动关闭」、README），全绿 **332/332**。
- 注：只改了 `src-core/collector.src.mjs` → 需要 `node build-encrypted.mjs`（扩展未变，无需 sync-extension），同步安装副本并退出重开 DSH 生效。

**0.9.8 变更**（2026-11-09）：**修复「采集未成功：browserType.launchPersistentContext: Failed to launch the browser process … 已在运行的浏览器会话中打开」**。
- 背景（用户报错）：启动采集直接失败，Chromium 一启动就退出；原因是浏览器 profile（`~/.dsh/douyin-collector/profiles/acc_…`）被**上一轮残留的浏览器窗口**占着 —— 同一个 profile 不能再开第二个进程。
- 为什么旧版没接管下来：`attachRunningBrowser()` 只认「URL 以 `https://www.douyin.com/` 开头的 page」，残留窗口当时停在扩展页/空白页（或结果页外的页面）→ 误判「没有旧窗口」→ 直接去 launch → profile 被锁 → 失败。
- 修复（`src-core/collector.src.mjs`）：
  - `attachRunningBrowser(chromium, log, { extId, profile })` 识别条件放宽：**端口上有浏览器（`/json/version` 有响应）且目标里带我们的扩展页（`chrome-extension://<extId>/…`）、或有抖音页**就接管；没有 page 时用 `ctx.newPage()` 补一个；并用上次启动记录里的 `profile` 校验「这个窗口是不是这次的 profile」，不是就不接管。
  - 新增 `killStaleProfileBrowsers(profile, log)`：只杀「命令行里带同一个 `--user-data-dir=<profile>`」的 `chrome.exe` 进程，顺手删 `SingletonLock/SingletonCookie/SingletonSocket`（非 Windows 平台只提示手动清理）。
  - 新增 `launchPersistentContextWithRecover(chromium, profile, options, log)`：launch 报错且像是 profile 被占用（`Failed to launch the browser process` / `已在运行的浏览器会话中打开` / `already in use` / `SingletonLock`）时，**自动清理残留进程、等 1.5s 再重试一次**；仍失败给出明确提示（手动关窗口或 `DOUYIN_PROFILE` 换目录）。采集与搜索两个启动入口都改用它。
- 自检/版本：插件 0.9.8（扩展/MCP 仍 0.5.65）；`verify-tool.mjs` 新增 v0.9.8 一组断言（接管指纹、`/json/version` + profile 校验、清理 helper、两个入口都走 recover 版 launch、README），全绿 **330/330**。
- 注：改了 `src-core/collector.src.mjs` → 需要 `node build-encrypted.mjs`（扩展未变，无需 sync-extension），并同步安装副本、退出重开 DSH。

**0.9.7 变更**（2026-11-09）：**区分「真·人机验证」与「服务端静默风控」——不再把静默风控说成「撞人机验证」并反复点「开始采集」刷屏**。
- 背景（用户 m03295，附日志截图）：「他老说撞风控，其实没撞」。日志里连续三组 `撞到人机验证（风控）：扩展已停下…最多等 900s` → `页面上已看不到验证浮层，点「开始采集」继续（第 1 次）` → `已恢复采集（phase=replies）`，但浏览器页面上根本没有验证浮层。
- 根因：扩展 `hook.js:74` 只要响应头带 `x-vc-bdturing-parameters` / `bdturing-verify` 就报 `VERIFY_REQUIRED`（**服务端静默风控，没有验证 UI**）；旧版 `content.js` 把它当成「真验证」永久 `setPhase('paused', '服务端要求完成验证（风控）…')`；采集器 `VERIFY_PAUSE_RE` 匹配到这句文案 → `waitOutVerification()` 一直等一个不存在的浮层 → 每 ~20s 点一次「开始采集」→ 扩展立刻又被拒 → 日志无限刷「撞到人机验证」。
- 扩展做法（`D:\dycopy\douyin-collector\content.js`）：新增 `captchaOverlayVisible()`（title / 正文前 1600 字 / `#captcha_container`、`.captcha_verify_container`、`.vc-captcha`、`[class*="captcha_verify"]`、`iframe[src*="/verify"]` 可见才判定为真有验证浮层）；新增 `silentVerifyHits`（补采）/ `silentVerifyTop`（顶层列表）计数：页面没有验证浮层时不再永久停下，而是**降速到单路 + 冷却 20 秒自动重试一波，最多 2 次**，仍被拒才如实 `setPhase('paused', '服务端静默风控（VERIFY_REQUIRED，页面没有验证浮层，不是人机验证）…')`；文案里明确写「不是人机验证」。
- 采集器做法（`src-core/collector.src.mjs`）：`waitOutVerification()` 先 `verifyOverlayPresent()` 判断页面到底有没有浮层；**没有浮层 = 静默风控**：不去等验证、不按 20s 节奏点「开始采集」刷屏，改为退避（10s/20s/30s）最多试 3 次「开始采集」，仍不行就收工并如实记日志；主轮询新增早退：状态文案含「静默风控 / 不是人机验证」时直接 `endedBy='risk-silent'` 收工（窗口保留、已采数据落盘、稍后重跑可断点续采）。
- 自检/版本：插件 0.9.7、扩展 0.5.65、MCP 0.5.65（三处一致）；`verify-tool.mjs` 新增 v0.9.7 一组断言（扩展有 `captchaOverlayVisible` / `silentVerifyHits`+`silentVerifyTop` / 文案「不是人机验证」；采集器有 `risk-silent` 早退、`sawOverlay` 判断、3 次退避），全绿 **325/325**。
- 注：扩展与采集器都改了 → 需要 `node sync-extension.mjs` + `node build-encrypted.mjs`，并同步安装副本、退出重开 DSH。

**0.9.6 变更**（2026-11-09）：**扩展全程「自然巡航」——边采集边滚评论区，让页面自己持续发签名请求（把团队 `clicker3` 的「滚动解风控」思路做成扩展内的正确落地版）**。
- 背景（用户 m03064）：不能等「卡住」再滚 —— 等卡住时通常已经触发人机验证，再补救没用；要自始至终在后台同路跑。
- 关键实测（`_probe/probe-natural-nudge.mjs`，搜索结果浮层；扩展只能发合成事件）：只改 `scrollTop` → 评论不加载、0 请求；**合成 `WheelEvent` 派发到 `comment-list`（`bubbles:true`）** → items 11→45、scrollHeight 1680→6934，页面自己发出 3 条带 `a_bogus` 的 `comment/list` 请求；合成点击「展开N条回复」无效（真鼠标才行），所以不依赖它。
- 做法（`D:\dycopy\douyin-collector\content.js`）：新增 `startCruise()/cruiseTick()/stopCruise()`：`setPhase` 在 `collecting/replies/waiting-sign` 三个阶段自动挂上；每 `cruiseMs`（默认 2600 + 0~900ms 随机）交替在 `comment-list` 上「滚到底 / 回拉一屏」（用 `persistScroll` 的合成 wheel）；评论区没开时最多点 2 次入口打开；**每个 tick 校验 `videoId` 与 `pageViewId()`，一变立刻停**（防止在结果页把下一条视频滚出来导致切条/落错桶）；`CRUISE_MAX=800` 次上限；`dts_settings`（或面板用户设置）可 `naturalCruise: 0` 关闭、`cruiseMs` 调间隔。
- 为什么更轻：评论是页面自己滚出来的，签名请求也由页面自己发，扩展只是顺手收「顺路数据」，不用在卡住时集中重放。
- 自检/版本：扩展 0.5.64（扩展源 / MCP / 安装副本三处一致），插件 0.9.6；`verify-tool.mjs` 新增 v0.9.6 一组断言（含扩展与安装后 content.js 都带巡航函数），全绿 **318/318**。
- 真机验证（2026-11-09）：关键词 E2E 仍 `deepLinkFallback=0 overlayOpened=2`（247 条、64s）；旁路读扩展 `status.autoOpenLog` 观测到 `cruise#1…#16`，全程 `videoId=7694662199454196721` 不变、可见评论 122→291，收工 `cruise-stop:phase:done`；巡航日志只进 `autoOpenLog` 诊断轨迹，不再往采集日志里刷屏。
- 注：本轮改的是扩展 `douyin-collector/content.js` → 需要 `node sync-extension.mjs` + `node build-encrypted.mjs`。

**0.9.5 变更**（2026-11-07）：**关键词采集不再走 `/video/<id>` 深链（卡片找不到先重建搜索结果页）+ 防连播只关一次**。
- 背景（用户反馈）：①「自动连播关闭一次就行了，每次采集前关闭，我看日志一直输出关闭」——0.9.4 每 5 秒巡检一次会反复刷屏，也反复点开关；②「为什么现在还是深链」——真实日志里第 1 条视频报 `搜索结果页里没找到这条视频的卡片（id），兜底打开详情页`，直接 `page.goto('https://www.douyin.com/video/<id>')` 走了深链。
- 做法：①删掉每 5 秒巡检（`pinTicks` / `pinVideoNotAdvance('巡检')`），只在每条视频点「开始采集」前调一次 `pinVideoNotAdvance('开始前')`；②新增 `rebuildSearchResultsPage(page, { searchKeyword, general, log, aborted })`：卡片找不到时重新走「抖音首页搜索框 → 搜索结果页 → 视频 tab」，重建后再找卡片；`openSearchOverlayVideo` 新增 `searchKeyword/general` 入参，卡片找不到、或退不回搜索页时都先重建结果页，**只有重建也失败才兜底详情页**；③`collectDouyinComments` 新增 `searchKeyword/searchGeneral` 透传，`collectDouyinKeyword` 每条视频传入同一关键词。
- 为什么会缺卡片：关键词采集会「接上上一次留下的浏览器窗口（CDP :9510）」复采，那个窗口可能停在一份过期/别的搜索结果页上，本次搜到的视频卡片不在当前网格里；直接跳详情页是最稳但也最容易触发风控的兜底，改成先重建搜索页。
- 自检：`verify-tool.mjs` 新增 v0.9.5 一组断言（版本 0.9.5、无 `pinTicks`/无巡检、`rebuildSearchResultsPage` 存在、浮层函数签名带 `searchKeyword`、卡片缺失先重建、关键词透传、README）。
- 0.9.5 修订（真机 E2E 后补的根因）：**Chrome 用持久化 profile 启动时会把上次的标签页恢复出来**，`ctx.pages()[0]` 有时是恢复出来的旧标签（停在旧搜索页/旧 `?modal_id=`），于是 `collectDouyinComments` 拿错页面 → 误判「当前浮层是别的视频」→ 下滑/Esc/goBack 全无效 → 重建结果页时又撞验证码 → 最后只能兜底走 `/video` 深链。修法：`collectDouyinComments` 在关键词模式下从 `ctx.pages()` 里挑出「本次关键词的搜索页」标签（日志「切到本次的搜索结果页标签（不是恢复出来的旧标签）」）；`openSearchOverlayVideo` 发现当前不在搜索页时也先重建结果页，不在错误页面上瞎找卡片。真机 E2E（关键词「咖啡」2 条视频、`max=40`、`replies=false`）：**`deepLinkFallback=0 pinBefore=2 pinPatrol=0 overlayOpened=2`**，全程停在 `?modal_id=` 浮层，222 条评论、58s。
- 注：本轮改了 `src-core/collector.src.mjs`，需要重跑 `node build-encrypted.mjs` 重建 `core.enc`；扩展当时未变（0.9.5 时仍 0.5.63，0.9.6 起升到 0.5.64）。
- 0.9.5 另一个修复（用户反馈「关键词采集好像只会导出最后一条视频」）：分析台（`viewer.mjs` 的 `/api/list` / `/api/latest`）只认 `douyin-comments-*.json` 分片，**看不到 `douyin-keyword-*.json` 合并文件** → 采集完成后自动打开的「最新一份」永远是最后一条视频的分片。现在：①列表/最新一份都认 `douyin-(comments|keyword)-*.json`，合并文件按 `commentCount` 读条数、标题显示「关键词「kw」· 本次全部视频」；②`viewer/app.js` 载入合并 JSON 时按每条评论的 `video_id/video_title` 登记全部视频；③批量删除也允许删 `douyin-keyword-*`。实测 `/api/latest` 现在返回 `douyin-keyword-猫咪-…json`（count=1157、标题「关键词「猫咪」· 本次全部视频」），而不是最后那条 42 条的分片。

**0.9.4 变更**（2026-11-07）：**采集期间关掉「自动连播」—— 视频播完不再自动滑到下一条**。
- 背景：抖音播放器开着「自动连播」时，视频一播完就会滑到下一条视频。搜索结果页浮层采集长视频时如果碰上这个，页面会自己切走，正在采的评论会落进下一条的桶里（0.9.3 实验里 A 配置丢的第 1 条就是这个现象）。
- 做法：新增 `pinVideoNotAdvance()`（`collectDouyinComments` 内，`settle` 之前）：
  1. 页面内把可见 `video` 元素的 `loop` 置 `true` —— loop 时不会触发 `ended`，播放器就拿不到「播完了」的信号，不会自动切下一条（不暂停视频，不影响页面正常显示和评论加载）；
  2. 顺手找页面上的「自动连播」开关（文本 `自动连播/连播/自动播放` 旁边 `aria-checked=true` 或 `input[type=checkbox]:checked`），开着就点掉；找不到不报错，只靠 `loop` 兜底。
  3. 调用时机（0.9.5 起）：**只在每条视频点「开始采集」之前一次**（日志「防连播（开始前）：N 个视频 loop=true…」），不再每 5 秒巡检。
- 效果：即使开着自动连播，采集过程中页面也不会因为视频播完而换条；采集完成/暂停后 loop 会随页面恢复正常（`loop` 只是运行期临时设置，不改账号设置）。
- 自检：`verify-tool.mjs` 新增 v0.9.4 一组断言（`pinVideoNotAdvance` 函数、`loop = true`、自动连播开关检测、开始前调用一次、README）。
- **注意**：本轮改了 `src-core/collector.src.mjs`，已跑 `node build-encrypted.mjs` 重建 `core.enc`（sha256=`ccba3cab…`；扩展未变，仍 0.5.63，不需要 sync-extension）；自检 `verify-tool.mjs` **302/302**、`verify-encrypted.mjs` 全部通过；真机 E2E：关键词「夕阳」2 条视频（复采老视频，扩展桶里已有数据 → 本轮判「没有新数据」属正常）、关键词「钓鱼」1 条新视频 → **113 条评论、23s**，日志确认「防连播（开始前）：N 个视频 loop=true，已点掉「自动连播」开关」。安装副本已同步到 `desktop` / `web` 两个 profile（version=0.9.4、core.enc 同 hash），**需退出重开 DSH 生效**。
**0.9.3 变更**（2026-11-07）：**风控节奏参数实测与收敛 —— 视频间随机停顿 + 关键词模式稳健二级回复档 + 搜索翻页放慢**。
- 背景：用户要求「除 max 外，lanes / replies / replyLanes / replyGlobalGapMs / replyWarmupSec / replyThrottleSec / timeoutMs / clearBefore / verifyWaitSec / videoCount 都试一遍，找最优档位」。做了真机 benchmark（`D:\dycopy\_probe\risk-bench.mjs`，指标 = 面板「风控 N 次」差值、`phase=paused` 次数、撞验证次数、总条数、总耗时、每条视频是否 `phase=done`）。
- **实测结论（2026-11-07，登录态正常、视频模式、综合排序、每条视频 max 不设限）**：
  | 配置 | 关键词/视频 | 参数 | 条数 | 耗时 | 风控差值 | 完整性 |
  | --- | --- | --- | --- | --- | --- | --- |
  | A 默认 | citywalk / 2 条 | lanes=3，其余默认（二级回复 4 路/250ms/预热 10s/限流 120s） | 558 | 163s | 0 | ❌ 第 1 条（27s 视频、1.4 万评论目标）只采到 3490 条后中断，数据落进了下一条的桶 |
  | B 很保守 | 露营 / 2 条 | lanes=1、replyLanes=2、gap 1200、warmup 60、throttle 600 | 2010 | 512s | 0 | ⚠ 2 条都在 120s 无新增后 stall，1 条判「没采全」 |
  | C 中档 | 公园 / 2 条 | lanes=2、replyLanes=2、gap 800、warmup 30、throttle 300 | 1637 | 618s | 0 | ✅ 2 条都 phase=done |
  | A2 复测 | citywalk / 2 条 | lanes=3，其余默认 | 553（新采 59+494） | 120s | 0 | ✅ 2 条都 phase=done（首条是 212s 视频） |
- **解读**：这三组体量下**风控事件全部为 0**（面板计数没有增加、没有撞验证）——也就是说「放慢」在这些数据量上并没有换来控制风险，纯粹变慢；真正的差别是**二级回复爆发时的稳定性**（默认 4 路 + 250ms 全局间隔在大评论量视频上更容易被限流/中途换条），以及**搜索首条不稳定**（同一关键词两次跑，结果页第一条会变，实验要按实际采到的视频解读）。
- 因此 0.9.3 落地的改动都很小、只针对「节奏」与「稳定性」：
  1. **视频之间随机停顿 3~8s**（`collectDouyinKeyword` 循环里，第 2 条起；`phase=video-gap` 会推给前端），避免「上一条刚收工→下一条立刻打接口」的机器人节奏。
  2. **关键词模式的二级回复参数默认改成 C 档**（`replyLanes=2`、`replyGlobalGapMs=800`、`replyWarmupSec=30`、`replyThrottleSec=300`）；显式传参会覆盖（单视频模式默认不变）。
  3. **搜索翻页最小间隔 900ms → 1500ms**（`SEARCH_PAGE_GAP_MS`，另加 0~500ms 抖动）。
- 参数建议（不改默认、按需传）：第一次跑某个关键词/大批量时用 `lanes=2`、`videoCount=3~5`、先 `replies=false` 跑一遍再开 `replies=true` 补采；`clearBefore` 保持 `false`（开清空会触发刷新页面自愈，浮层会丢）；`verifyWaitSec` 保持 ≥900；`max` 本次实验全程未动。
- 已知遗留（**未修**）：搜索结果页浮层采集时，极少数情况下页面会自己滑到下一条视频（A 的第 1 条就是这样丢的；离线探针 `probe-loop2.mjs` 复现不出，怀疑与「等签名时扩展的合成 wheel / 面板开合」在特定页面状态下触发 swiper 有关）。目前采集器会**检测到换条并报「没有本轮新数据：页面已切换到别的视频…」**（不会把旧数据当新数据交给你），但那条视频的数据会留在错误 videoId 的桶里，重跑时计数会被污染。
- **注意**：本轮改了 `src-core/collector.src.mjs`，已跑 `node build-encrypted.mjs` 重建 `core.enc`（sha256=`9b47d13f…`；`extension.enc` 未变，扩展仍 0.5.63，不需要 sync-extension）；自检 `verify-tool.mjs` **298/298**、`verify-encrypted.mjs` / `verify-merged.mjs`(28) / `verify-console.mjs` / `verify-client.mjs` 全过；真机 E2E（关键词「夕阳」+ 2 条视频 + 视频间停顿 4s）→ 110 条评论、64s、全程浮层采集。安装副本已同步到 `desktop` / `web` 两个 profile（version=0.9.3、core.enc 同 hash），**需退出重开 DSH 生效**。

- 自检：`verify-tool.mjs` 新增 v0.9.3 一组断言（版本 0.9.3、视频间停顿、关键词二级回复默认档、搜索翻页 1500）；重新跑全量自检后仍全绿。

**0.9.2 变更**（2026-11-07）：**关键词模式不再走深链 —— 在搜索结果页里点开卡片、在浮层里采，采完下滑下一条**。
- 背景：0.9.0/0.9.1 对每条视频是 `page.goto('https://www.douyin.com/video/<id>')`。用户的实际操作是「搜出来 → 点开第一个 → 采集 → 往下滑就是第二条」，希望照着页面的自然路径来，不要一条条跳 `/video/<id>` 深链（也少一点「像脚本」的特征）。
- 做法：新增 `openSearchOverlayVideo()`（`src-core/collector.src.mjs`，在 `pageTrappedByCaptcha` 之后）——采集每条视频前先确认当前浮层：
  - 浮层已经是目标视频（`modal_id` 相同）→ 直接采；
  - 浮层开着别的视频 → `page.mouse.wheel(0, 1000)` **下滑找目标**（用户说的「下滑下一条」就是这一步；实测下滑 1 次就到第二条）；
  - 下滑没找到 → `Escape` 关浮层，若落到详情页就 `page.goBack()` 退回搜索页，然后在结果网格里按 `a[href*="/video/<id>"]`（图文用 `/note/`）找卡片；
  - **点卡片先用页面内的 `a.click()`**：面板抽屉会挡住左边第一列卡片，Playwright 的 `force:true` 点击在被遮挡时**不报错但什么也没发生**（实测踩到的坑），脚本点击绕过命中测试、稳定能打开浮层；脚本点击没开才退回 Playwright 真实点击；
  - 全部失败才兜底 `page.goto(fallbackUrl)`（正常路径不会走到）。
- 两个配套修正：①浮层切换视频后，扩展可能还停在上一集的 `videoId`/`phase=paused` —— 采集器现在最多等 12s 让它认到目标 `videoId`，再最多等 15s 等它把状态复位成 `idle`（否则点「开始采集」等于「接着上一集采」，新视频的评论不进库）；②「开始前已有多少条」的 bucket 读取改成**优先用目标 awemeId**，不再用面板里可能过期的 `videoId`（否则会把上一集的计数当成这一集的起点，重复交付旧评论）。
- 真机 E2E：关键词「夕阳」+ 综合排序 + 2 条视频 → **276 条评论、46s**，日志确认第 1 条是「脚本点击搜索结果卡片（绕开面板遮挡）→ 已点开目标视频浮层」，第 2 条是「下滑第 1 次就到了目标视频」，全程页面停在 `/jingxuan/search/<kw>?modal_id=…`，**没有访问 `/video/<id>`**。
- 自检：`verify-tool.mjs` 新增 v0.9.2 一组断言（浮层点开函数、脚本点击优先、下滑找目标、`goBack` 退回、`overlayAwemeId` 透传、bucket 用目标 id）。
- **注意**：本轮改了 `src-core/collector.src.mjs`，**已跑 `node build-encrypted.mjs` 重建 `core.enc`**（sha256=`0e566ab7…`；`extension.enc` 未变，扩展仍 0.5.63、**不需要 sync-extension**）；安装副本已同步到 `C:\Users\mo\.dsh\profiles\desktop` 与 `web` 两个 profile，**需退出重开 DSH 生效**。

**0.9.1 变更**（2026-11-07）：**撞到人机验证不再直接失败 —— 暂停等你手动过验证，通过后自动继续采**。
- 背景：抖音服务端风控会回 `x-vc-bdturing-parameters` / `bdturing-verify` 响应头，扩展识别成 `VERIFY_REQUIRED` 后立刻把状态置为 `paused`（不重试、不加重风控）。以前采集器看到 paused 就收工，使用者只能自己过完验证再手动重跑；现在多了一步「等人」。
- **单视频模式**：轮询到 `paused` 且面板文案命中「要求完成验证 / 人机验证 / 安全验证 / 验证码 / VERIFY_REQUIRED」时，采集器进入等待流程 —— 每 2.5 秒轮询一次扩展状态和页面上的验证浮层（看 `#captcha_container`、`.captcha_verify_container`、`iframe[src*="/verify"]` 等，也看标题/正文里的「验证码中间页 / 请完成下列验证 / 拖动滑块完成拼图」）；确认浮层消失（连续两次看不到）且你已经在窗口里过完验证后，**自动点扩展面板上的「开始采集」断点续采**；又撞验证就回到等待。最多等 `verifyWaitSec`（默认 900 = 15 分钟，工具参数/插件设置都能改，0 = 不等）。
- **关键词模式**：搜索阶段（首页搜索框被拦成「验证码中间页」、抓签名接口时被拦、翻页途中被拦）同样进入「等验证」；验证通过后自动重新打开首页搜索 / 继续等页面发请求 / 重试当前翻页，**不是整轮失败**。某条视频等到超时（`endedBy=verify-wait`）就停下后续视频、把窗口留给你，过完验证再调用一次会从断点续采（已采数据已落盘）。
- **不改扩展**：等待完全是在采集器侧做（读扩展状态 + 点面板「开始采集」+ 看页面浮层），扩展仍然「只报 VERIFY_REQUIRED、不破解、不重试」。
- 自检：`verify-tool.mjs` 新增 v0.9.1 一组断言（`DEFAULTS.verifyWaitSec`、等待/浮层检测/自动续采逻辑、关键词侧等待、`endedBy`、index.js 与 console.mjs 参数透传）。
- **注意**：本轮改了 `src-core/collector.src.mjs`（+ `index.js` / `console.mjs`），**已跑 `node build-encrypted.mjs` 重建 `core.enc`**（sha256=`1b47c432…`；`extension.enc` 未变，扩展仍 0.5.63，**不需要 sync-extension**）；安装副本已同步到 `C:\Users\mo\.dsh\profiles\desktop` 与 `web` 两个 profile 的 `node_modules/dsh-douyin-comments`（version=0.9.1、core.enc 同 hash），**需退出重开 DSH 生效**（插件的 ESM 模块与工具 schema 都是进程启动时载入的，只 disable/enable 不够）。真机 E2E（关键词「咖啡」→ 1 条视频 46 条评论，25s）通过。

**0.9.0 变更**（2026-11-07）：**按关键词搜索视频 → 采前 N 条视频的评论**（工具 `douyin_comments` 新增 `keyword` 模式，控制台同步支持）。
- **用法**：`douyin_comments` 现在 `url` 与 `keyword` 二选一（都填走 keyword）。填 `keyword` 时先按关键词搜索视频，再对前 `videoCount` 条逐个跑原来的评论采集，最后合并成一份 CSV/JSON。新增参数：`keyword`、`videoCount`（1~100，默认 10；**每条视频的评论上限仍是 `max`，默认 80000 = 全部**）、`sortType`（综合排序 / 最新发布 / 最多点赞）、`publishTime`（不限 / 一天内 / 一周内 / 半年内）、`duration`（不限 / 1分钟以下 / 1-5分钟 / 5分钟以上）、`contentType`（不限 / 视频 / 图文）。关键词模式下 `timeoutMs` 的含义变成**整个任务的预算**（默认 4 小时，`keywordTimeoutMs`），单条视频仍按 `DEFAULTS.timeoutMs`（30 分钟）封顶。
- **筛选值以服务端为准**（实测 2026-11-07 抖音网页版下发的 `global_doodle_config.filter_settings`）：`sort_type` 综合排序=0、**最新发布=2**、**最多点赞=1**；`publish_time` 不限=0、一天内=1、一周内=7、半年内=180；`filter_duration` 不限=""、1分钟以下=`0-1`、1-5分钟=`1-5`、5分钟以上=`5-10000`；搜索范围（没做 UI）`search_range` 不限=0、关注的人=3、最近看过=1、还未看过=2。
- **「内容形式」网页版没有原生筛选项**：当前 PC 网页搜索只有上面 4 行「排序依据 / 发布时间 / 视频时长 / 搜索范围」，没有用户截图里的「内容形式（视频/图文）」。所以这里不是筛选参数，而是**两条搜索通道**：`视频` 走视频 tab 的 `/aweme/v1/web/search/item/`；`图文` 走综合 tab 的 `/aweme/v1/web/general/search/`，再把返回里 `aweme_type === 68` 的图文帖挑出来（`不限` 用视频 tab，不额外挑图文）。
- **怎么做的不碰签名**：**先打开抖音首页**（`https://www.douyin.com/`），在首页搜索框里输入关键词回车 → 落到搜索结果页（图片/视频都落在 `/search/` 下）；视频模式再点一下「视频」tab，页面就会发出 `/aweme/v1/web/search/item/` 的**签名请求**。**不直接打开 `https://www.douyin.com/search/<kw>?type=video` 深链**——实测那样会被风控拦成「验证码中间页」（标题就是「验证码中间页」、页面正文为空、一个搜索请求都不发），而走首页搜索框是正常用户路径、不触发验证码。拿到页面自己发出的那条带 `a_bogus` 的 URL 后，在页面里 `fetch(credentials:'include')` **重放它**，只改 `offset` / `count` / `sort_type` / `publish_time` / `filter_duration`，并把 `is_filter_search` 置为 `1`（**不改就会完全不生效**，这是实测踩到的坑）。综合 tab 的响应是 `<十六进制长度> <JSON>` 的分块流，重放时把 path 从 `/general/search/stream/` 换成 `/general/search/single/` 就拿到普通 JSON。和评论翻页一样：**只复用页面给的签名，不计算、不逆向、不伪造**。
- **采集阶段**：搜索那一步用 `keep:true` 保留浏览器窗口，接着对每条视频（视频页 `/video/<id>`、图文帖 `/note/<id>`）依次调用原采集流程，窗口复用不重开（每条结束不关窗口、下一条直接导航）；全部结束再关窗口（`need-login` / `keepOpen` 时保留）。需要登录态：搜索页未登录会弹「登录后即可搜索更多精彩视频」，登录闸门与原来一致（可用 shop-accounts 账号），`waitLoginSec` 内可扫码。
- **产物**（都在输出目录，控制台「导出记录」可见）：
  - `douyin-keyword-<关键词 slug>-<时间戳>.csv`：合并评论表，前 10 列是视频信息（`video_index, video_id, video_kind, video_title, video_url, video_author, video_digg_count, video_comment_count, video_duration_ms, video_publish`），后面 19 列与原评论 CSV 完全同序。
  - `douyin-keyword-<关键词 slug>-<时间戳>.json`：`{keyword, filters, filterValues, videoCount, commentCount, collectedAt, durationSec, outDir, logPath, videos[每条 ok/collected/phase/note/error/csvPath/jsonPath], comments[带 text_clean 与视频归属]}`。
  - `douyin-videos-<关键词 slug>-<时间戳>.csv`：视频清单（序号 / ID / 类型 / 标题 / 链接 / 作者 / 点赞 / 评论数 / 时长 / 发布时间 / 采集状态 / 条数 / 备注 / 分片 CSV / 分片 JSON）。
  - 每条视频自己的 `douyin-comments-<id>-<时间戳>.csv/json` 仍然照旧落盘。
- **控制台**：采集页视频链接下方新增「关键词搜索」输入，填了会展开两行筛选（视频条数 + 排序 / 发布时间 / 时长 / 内容形式），「总超时」标签变成「整个任务预算（分钟）」；结果区显示「关键词「…」：采了 N 条视频，共 M 条评论」+ 视频逐条摘要 + 「下载视频清单 CSV」；进度条按 `videoIndex / videoTotal` 走。
- **图文帖支持**：内置扩展升到 0.5.63，`extractVideoId()` / `pageKey()` / `pageViewId()` 认 `/note/<id>`，`pageKind()` 把 `/note/` 当详情页（评论区常驻）。实测图文帖（如 4 图帖）评论能采，走的是同一个 `/aweme/v1/web/comment/list/`，但**比视频更容易撞风控停顿**（暂停后按原逻辑会等验证）。
- 自检：`verify-tool.mjs` **277/277**（新增 13 项：搜索接口签名重放、搜首页搜索框进（不直开 `/search/` 深链）、筛选字典、`/note/` 与目标 URL、合并 CSV/视频清单、加载器透传、工具/控制台/前端入口、扩展 `/note/` 源+安装后、扩展版本）；`verify-encrypted.mjs`、`verify-merged.mjs`（28）、`verify-console.mjs`、`verify-client.mjs` 全过；`node --check` 全过；真机 E2E 两种通道都跑通（视频：关键词「咖啡」+最新发布+一周内+1-5分钟 → 2 条视频 202 条评论，34s；图文：关键词「咖啡」+综合排序 → 2 条图文帖 204 条评论，44s）。
- **注意**：本轮改了 `src-core/` 和扩展源码（`../douyin-collector/content.js`），**已跑 `node sync-extension.mjs` + `node build-encrypted.mjs` 重建 `core.enc` / `extension.enc`**（core.enc sha256=`5d7f1e3c…`、extension.enc v0.5.63）；安装副本已同步到 `C:\Users\mo\.dsh\profiles\desktop` 与 `web` 两个 profile 的 `node_modules/dsh-douyin-comments`（version=0.9.0、core.enc 同 hash），**需退出重开 DSH 生效**。

**0.8.6 变更**（2026-11-06）：**修「筛选框会变大变小」**——采集页「收藏客户」工具条在筛选时会跳动。
- 原因：`#favCount` 计数胶囊原本放在工具条里、宽度随文字变（`4 位` → `2 / 4 位` 宽了约 17px），而工具条是 `flex-wrap: wrap`；总宽度一变就整行换行，搜索框的宽度随之在 181px / 242px 之间来回跳，工具条高度也在 32px / 66px 之间跳。
- 改法：把计数胶囊移到卡片标题行（`<h2>收藏客户</h2>` 右边，`.fav-title` 里），工具条里只剩「搜索框（flex）+ 属地 118px 固定宽」，并改成 `flex-wrap: nowrap` ⇒ 筛选前后搜索框宽度、工具条高度恒定。词云页各筛选下拉本来就是 `width: 100%`，实测（1180/860/430 三档、切换视频/排序/收藏弹层）宽度均不变，未受影响。
- 自检：`verify-tool` 263/263、`verify-merged` 28/28、`verify-client` / `verify-encrypted` / `verify-console` / `verify-shop-accounts` 全过、`node --check` 全过；playwright 实测收藏 4 位客户时：筛选前 `search=180.95 / toolbarH=32`，选「四川」后 `search=180.95 / toolbarH=32`（改前是 242 / 66），计数文字变长不再挤动布局。
- **注意**：只改前端（`app/index.html`、`app/styles.css`、`package.json` 版本、README），`src-core/` 未动，**不需要重跑 `node build-encrypted.mjs`**；安装副本仍需手动同步后重启 DSH / NovaFlow 生效。

**0.8.5 变更**（2026-11-06）：**收藏客户可以按地域筛选**（采集页与词云页各一处）。
- 采集页「收藏客户」卡片：搜索框旁新增「属地」下拉 `#favRegion`，只列收藏客户里出现过的属地（按人数降序，标签带计数如 `四川（2）`）；与搜索框**组合生效**，计数胶囊显示「命中 / 总数 位」。导出 CSV 现在导出的是**当前筛选结果**（没有筛选时即全部），文件名不变。
- 词云页「收藏客户 N」弹层：顶部原来只有一个「已收藏客户」chip，现在改成「全部（N）+ 各地域（N）」chip 行，点 chip 只看该属地的收藏客户；`#groupSub` 显示 `命中 / 总数 位 · 属地`。
- 数据来源不变（仍是 `favorites.json` 里记的 `region`，即评论 `ip_label`；没有属地的记为「未知属地」）。
- 自检：`verify-tool` 263/263（新增「采集页收藏可按属地筛选」「词云弹层 chip 按属地筛选」两项）、`verify-merged` 28/28、`verify-client` / `verify-encrypted` / `verify-console` / `verify-shop-accounts` 全过、`node --check` 全过；playwright 用临时 `favorites.json`（4 位客户分布在四川/广东/未知）实测：采集页下拉 3 个属地项、选「四川」后列表剩 2 行且计数 `2 / 4 位`；词云弹层 chip 选「四川」后同样只剩 2 行。
- **注意**：只改前端（`app/`、`viewer/`、`package.json` 版本、README），`src-core/` 未动，**不需要重跑 `node build-encrypted.mjs`**；安装副本仍需手动同步后重启 DSH / NovaFlow 生效。

**0.8.4 变更**（2026-11-06）：**界面文案精简**——原来采集页 / 词云页有成段的说明文字、空态解释、逐行路径，看着占版面又杂乱。
- **规则**：正文只留一行短句；长解释、失败原因、完整路径一律挪到 `title` 悬浮提示（鼠标停上去才看到），不再铺在页面上。空态文案统一成「还没有数据 / 还没有导出文件 / 还没有收藏的客户」这类一句。
- **采集页**（`app/`）：删掉「开始后会在本机启动一个有头 Chromium…」整段说明（挪到 `#start` 按钮 `title`）、导出记录卡片说明、「数据文件路径」一行；`#outDir` 只显示 `…\最后两段`（完整路径进 `title`）；结果区不再逐行列出 CSV/JSON/词云路径（完整路径挂在三个下载链接的 `title` 上），只保留样本 / 运行日志 / 失败现场；shop-accounts 的提示与失败原因缩成一行（「这个抖店号还需要在 douyin.com 登录过」等），原始长文案进 `title`；收藏卡片那行说明直接删掉（收藏文件路径挂到搜索框 `title`）。`.hint` 字号收到 11.5px、上边距 8px，并删掉不再使用的 `.path-muted`。
- **词云页**（`viewer/`）：空态从「载入插件或扩展导出的 `douyin-comments-*.json` / `.csv`，也可以直接选整个导出目录…」缩成「打开导出的 `.json` / `.csv`」（完整说明进 `title`），「数据只在本机浏览器里处理，不上传任何服务器」缩成「本机处理，不上传服务器」。
- **自检**：`verify-tool` 261/261、`verify-merged` 28/28、`verify-client` / `verify-encrypted` / `verify-console` / `verify-shop-accounts` 全过、`node --check` 全过；playwright 截图核对深/浅 × 宽/窄确认版面干净、无 JS 报错。
- **注意**：只改前端（`app/`、`viewer/index.html`、`package.json` 版本、README），`src-core/` 未动，**不需要重跑 `node build-encrypted.mjs`**；安装副本仍需手动同步后重启 DSH / NovaFlow 生效。

**0.8.3 变更**（2026-11-06）：**采集页新增「收藏客户」卡片**——收藏不再只能在词云页里看。
- 数据同源：卡片读的是词云那侧的服务端接口 `/viewer/api/favorites`（文件 `$DSH_HOME/douyin-collector/favorites.json`，按账号隔离），所以两边永远一致；收藏动作仍然在「评论词云」评论表里点 ★ 完成，采集页负责**汇总 / 搜索 / 移除 / 导出**。
- 卡片内容：全部收藏客户按最近收藏时间倒序；每行是头像占位 + 昵称 + 抖音号/uid + 属地 + 「收藏于 时间」+ 标签/备注 + 「主页」链接（`https://www.douyin.com/user/<sec_uid>`，没有 sec_uid 时退回 uniqueId）+ 「移除」按钮。
- 工具条：搜索框（昵称 / 抖音号 / uid / 属地 / 标签 / 备注 全字段模糊匹配）+ 计数胶囊（`N 位`，搜索时显示 `命中 / 总数`）+「刷新」+「导出 CSV」（UTF-8 BOM，列：昵称, 抖音号, uid, sec_uid, 属地, 标签, 首次收藏, 最近收藏, 备注, 主页）。
- 空态文案会引导「去评论词云子页点 ☆ 收藏目标客户」；数据文件路径以等宽小字显示在说明下方。
- 自检：`verify-tool.mjs` **261/261**（新增 2 项「采集页有收藏客户卡片」「采集页通过 viewer/api 取收藏」）、`verify-merged` 28/28、`verify-client` / `verify-encrypted` / `verify-console` 全过、`node --check` 全过；playwright 截图核对深/浅 × 宽/窄四种状态（窄屏 430 下每行改为「上信息下按钮」两段式）。
- **注意**：只改前端（`app/index.html`、`app/app.js`、`app/styles.css`、`package.json`、`README.md`），`src-core/` 未动，**不需要重跑 `node build-encrypted.mjs`**；安装副本仍需手动同步后重启 DSH / NovaFlow 生效。

**0.8.2 变更**（2026-11-06）：**地域分布面板收窄 + 深浅主题改成可手动切换**。
- **地域分布**：原来 `.region-panel` 只有 `margin-top`、没有左右留白，整块面板横向拉满到屏幕边缘（看起来像溢出到屏幕外）。现在改成 `margin: 14px var(--pad-x) 0`，与 KPI / 词云 / 评论表同一条左右边界；内部 `.region-dist` 从「一条条拉满整宽」改成**紧凑多列网格** `repeat(auto-fill, minmax(272px, 1fr))`（1180 宽是 3 列、860 宽 2 列、≤700 单列），每行改成 `名称(52px) + 细进度条(6px, flex) + 数量` 的三段式，行高 31px，12 个地域在宽屏下只占 4 行，不再一条占满整屏。
- **深浅主题切换**：采集页（`app/`）和词云页（`viewer/`）顶栏都新增了一个太阳/月亮按钮 `#btnTheme`。优先级：**手动选择（`localStorage['dsh.douyin.theme']`）> `?theme=`（DSH 传进来的）> 系统偏好**；切换会同时更新 `data-theme` 与 `theme-color`，两页共用同一个 key，并通过 `storage` 事件互相同步；词云页里切换会重渲染表格/头像/地域，词云词色本身走 CSS 变量即时生效。按钮图标由 CSS（`[data-theme="light"] .theme-btn .t-sun { display:none }`）自动切换，不额外占 JS 状态。
- **自检**：`verify-tool` 仍 **259/259**、`verify-merged` 28/28、`verify-client` 全过、`verify-encrypted` 全过、`verify-shop-accounts` 22/22、`verify-console` 全过、`node --check` 全过；另用 playwright-core 实测：1180/860/430 三种宽度下 `#regionPanel` 与 `#kpis` / `.table-panel` 的 left/right 完全对齐（28/26/16px），`documentElement.scrollWidth == innerWidth`（无横向溢出）；深色下点主题按钮 → 变浅色且写盘 `light`，刷新页面（仍带 `?theme=dark`）保持 `light`。
- **注意**：本轮只改前端资源（`app/`、`viewer/`、`package.json` 版本），`src-core/` 未动，**不需要重跑 `node build-encrypted.mjs`**；安装副本仍需手动同步后重启 DSH / NovaFlow 生效。

**0.8.1 变更**（2026-11-06）：**统一「抖音评论」两页的视觉**——采集控制台（`app/`）与评论词云（`viewer/`）现在共用同一套 design tokens 和同一套控件规格，并完整支持**深色 / 浅色**两套主题（跟随 DSH；独立打开时跟随系统偏好）。
- **tokens**：`--bg/--surface/--surface-2/--surface-3`、`--line/--line-soft/--line-strong`、`--ink/--text/--muted/--meta`、`--accent(#e0a94a)/--accent-dim/--accent-soft/--accent-line/--on-ink`、语义色 `--pos/--neg/--info/--warn`、几何 `--r:10px / --r-ctl:7px / --r-pill:999px`。深色为默认 `:root`，浅色是 `[data-theme="light"]` 覆盖（浅色下强调色改 `#b45309`、`--on-ink` 改 `#fff`，主按钮仍是「反白实心」但不会变成白字压在浅底上）。
- **统一规则**：单一强调色只落在数据/选中态/链接/进度上；卡片圆角 10、控件 7、胶囊 999；无渐变、不堆阴影；控件统一 32px 高 + `1px var(--line)` 边框 + `3px var(--accent-soft)` 焦点环；数字一律等宽（`--mono` + `tabular-nums`）。采集页重写了 `app/styles.css`（顶栏、卡片、表单、统计四格用 inset 线切分、3px 实色进度条、日志面板、导出列表、toast）；词云页在 `viewer/styles.css` 里加了一段 v0.8.1 覆盖层（按钮/输入/表格线/徽章/头像/健康度/词云色阶/骨架屏/浮层滚动条全部 token 化，并修掉深色专用的 `rgba(255,255,255,*)`）。
- **浅色主题的真实问题修了两处**：① 词云词色原来是硬编码 `#c2c2c7 / #8e8e94`，在白底上几乎看不见 ⇒ 改成 `var(--cloud-mid) / var(--cloud-low)`（浅色下 `#5b6472 / #8b94a3`），强调词改 `var(--accent)`；② 头像底色原来是深色 hsl ⇒ 浅色下换淡底深字。
- **右侧面板 tab**：`client/client.js` 新增 `dshPalette(theme)` + `useDshTheme()`（`MutationObserver` 监听 `documentElement` 的 `data-theme/theme/class` + `matchMedia` + `window focus` 兜底），面板顶栏从「两个色块按钮」改为 surface 底 + 1px 下边框，tab 激活态是**2px 琥珀下划线 + ink 文字**，两个 iframe 背景统一取 `p.bg`，DSH 里切主题时面板即时跟着换。
- **自检**：`verify-tool.mjs` 从 257 增到 **259 项**（原「支持深色主题」断言改成双主题 token 断言 + 新增「两页共用 tokens」「面板 tab 色板 + 跟随主题」两项）；`verify-merged.mjs` 28/28、`verify-client.mjs` 全过、`verify-encrypted.mjs` 全过、`node --check` 全过；另外用 playwright-core 对 7 个页面状态（控制台/词云 × 深色/浅色 × 宽屏/窄屏 + 表格/地域/分组弹层）逐张截图核对了观感。
- **注意**：本轮只改前端资源（`app/`、`viewer/`、`client/client.js`、`package.json` 版本），`src-core/` 未动，**不需要重跑 `node build-encrypted.mjs`**；安装副本仍需手动同步后重启 DSH / NovaFlow 生效。

**0.8.0 变更**（2026-11-05）：**兼容 `dsh-plugin-shop-accounts`**——采集时可以直接选 shop-accounts 里某个已登录的抖音账号，**Chrome 与 ego 两种浏览器后端都支持**；选中的账号登录态复用给我们的采集浏览器，采集浏览器档案按账号隔离。
- **做法（cookie 桥接，不是复用窗口）**：shop-accounts 启动的浏览器**不会加载我们的采集扩展**（它的 `launchBrowser` 参数里没有 `--load-extension`），而 ego 的登录态是 Chromium 127+ App-Bound 加密、复制档案读不到 —— 所以只把那个账号的**登录 cookie**读出来，注入到我们自己的带扩展 Chromium。cookie 来源：Chrome 后端 → 该账号已在用（`runtime.json` 有端口）就直接走 CDP 读，没开就用同一档案起无头 Chrome 读完关掉；ego 后端 → ego 没开着走 `egoOfflineCookies`（同一 User Data 起无头实例读 `Profile N`），开着走 `egoProbe` 临时 TaskSpace。读 cookie 只读、不关闭用户正在用的窗口。
- **账号隔离**：采集 Chrome profile 从 `DEFAULTS.profile` 改成 `<home>/profiles/<账号 id 过滤后>`；启动状态（`launch-state`）里记 `account`，下次请求如果账号不一样就关掉旧窗口重开，避免两个账号的登录态串在一起。
- **用法**：工具参数新增 `account`（传账号 id / 名字 / 名字片段，如 `account:"抖店"`；不传=仍用本插件自己的登录态），返回里有 `account`；控制台页面新增「采集账号（shop-accounts）」下拉（记住上次选择）；新接口 `GET /plugins/dsh-douyin-comments/api/accounts` 返回可用账号（平台/卖家买家/后端/是否可读/ego 状态）。
- **覆盖检查（本机实测的重要边界）**：本机 `抖店`（抖音卖家）账号的 ego 档案里**只有抖店后台（jinritemai / bytedance）登录，一个 `douyin.com` 的 cookie 都没有** —— 这种账号拿来采抖音评论会被登录闸门拦下。插件现在会在读 cookie 后做覆盖度检查并直接给明确错误（`account_no_douyin_login`：列出现有 cookie 域，提示「请在 shop-accounts 里用该账号打开 https://www.douyin.com 登录，或改用抖音买家号」），而不是含糊地报「未登录」；控制台选中抖店卖家号时也会显示这条提示。ego 的 `pickCookie` 只保留部分字段，Chrome CDP 的 cookie 更全，两种来源都过 `cookiesForPlaywright` 归一（丢掉 size/priority/session、`sameSite` 归一到 `None/Strict/Lax`、`expires` 取整）。
- **自检**：新增 `verify-shop-accounts.mjs` 22 项（数据目录 / 插件根定位 / 清单只列抖音 / includeAll / resolve 按 id·名字·片段·空值 / 找不到与平台不符的中文报错 / cookie 域名表 / `cookiesForPlaywright` 过滤与归一 / 账号目录名过滤 / cookie 覆盖度分类）；`verify-merged.mjs` 增至 **28 项**（新增 `/api/accounts` 4 项：200、只列抖音、不列拼多多、字段齐全 + ego 状态）；`verify-encrypted.mjs`、`verify-tool.mjs`、`verify-client.mjs`、`node --check` 全过。
- **注意**：profile 里的 `file:` 依赖是**复制**不是软链（hoisted pnpm），改源码后要手动同步装好的 `node_modules/dsh-douyin-comments`（本次同步了 `C:\Users\mo\.dsh\profiles\desktop` 与 NovaFlow 的 `86aa8d…` profile），然后退出重开 DSH / NovaFlow 生效。

**0.7.0 变更**（2026-11-04）：面向 **NovaFlow**（二开的 DSH Desktop）适配，并加三块功能：**采集核心 AES 加密**、**评论按地域筛选 / 一键按地域区分客户**、**收藏目标客户（本机按账号隔离）**。
- **数据与账号隔离**：插件所有本机数据（Chrome profile、cookies、导出 JSON、`last-out.json`、收藏、解密缓存）都落在 `$DOUYIN_HOME`，未设置时取 `$DSH_HOME/douyin-collector`，再退回 `~/.dsh/douyin-collector`。NovaFlow / DSH Desktop 给 Host 子进程注入 `DSH_HOME=~/.novaflow/accounts/<账号 key>`（见 `F:\Software\Novaflow\resources\app.asar` 解出的 `lib/main.js` 15211-15213），所以**同一台电脑切 NovaFlow 账号即自动隔离**；独立 DSH 仍用 `~/.dsh`。
- **加密**：`collector.mjs` 现在是「加密加载器」，真实实现移到 `src-core/collector.src.mjs`，由 `build-encrypted.mjs` 压成 `core.enc`（**AES-256-GCM 认证加密**，密钥用 scrypt 从拆散/混淆的种子派生；载荷带 magic/版本/算法校验、GCM tag 校验与明文 sha256 校验，任何一步失败直接抛错）。运行期解密到 `<home>/runtime/<载荷哈希前16位>/collector.mjs` 再 `import`（按载荷哈希做缓存，换载荷自动失效并清理旧缓存）；内置扩展（`extension/`）同样加密进 `extension.enc`，解密密钥由加载器派生并通过 `globalThis` 传给核心模块、运行期物化到缓存目录后交给 Playwright 的 `--load-extension`。对 export 契约（`collectDouyinComments / DEFAULTS / resolveOutDir / sessionWorkspaceCwd`）零改动，`index.js`、`console.mjs`、词云服务端都不用知道加密存在。改了 `src-core/` 或 `extension/` 之后必须 `node build-encrypted.mjs` 重建。
- **地域筛选 / 一键区分地域客户**：词云分析台侧栏新增「属地」下拉（来自评论 `ip_label`，按省/地区），评论表可筛某地域；新增「地域分布」面板（前 12 地域条形 + 评论数/用户数），点条形 = 只看该地域。`[按地域分组看客户]` 打开分组弹层：按地域聚合用户（昵称、抖音号、uid、sec_uid、评论数、获赞、代表评论，按获赞降序，每区最多列 200 人），可 `[收藏本区全部]`；`[导出分组 CSV]` 导出「地域 | 昵称 | 抖音号 | uid | sec_uid | 评论数 | 获赞 | 最近评论时间 | 是否已收藏 | 代表评论」（UTF-8 BOM）。
- **收藏目标客户**：评论表每个用户旁有 ☆/★，分组弹层里也能收藏；侧栏有「只看已收藏客户」和「收藏客户 N」入口（弹层里看全部已收藏、可取消）。收藏存 `<home>/favorites.json`（`{version:1, users:{uid:{uid,secUid,nickname,uniqueId,region,profileUrl,tags,note,firstSavedAt,savedAt}}}`，原子写 tmp+rename），服务端接口 `GET/POST /plugins/dsh-douyin-comments/viewer/api/favorites`（GET 支持 `?uid=` 单查，POST 支持 `user` / `users[]` / `favorites[]` 批量 upsert + `note`）与 `POST …/api/favorites/remove`（`uid` 或 `uids[]`）；自包含词云 HTML（file://）里没有服务端，收藏按钮会提示「请在插件面板里打开」。
- **NovaFlow 额度（本轮未做扣费）**：NovaFlow 的账号额度是 New API 后端按**中继推理请求的 token** 扣（客户端只有 `GET /api/desktop/v1/balance` 等只读接口，没有任何本地扣费端点，实测 `/api/desktop/v1/*` 全部 404）。所以采集/分析这类纯本地动作**无法经由现有客户端接口扣额度**，本轮按用户决定先不扣，只做其余功能；后续要扣需要服务端新增计费端点（或走一次中继推理），属后端改动。
- **自检**：`verify-merged.mjs` 23 项（单 prefix / 路由 / 静态页 / 越界拒绝 / 无模型 409 / 收藏接口：空列表 / 单个 / 批量（含无 uid 失败）/ 单查 / 删除 / 批量删除 / 落盘路径在 `$DSH_HOME` 下），`verify-client.mjs` 24 项（单入口 + 面板两子页 + 采集完自动切词云），`verify-tool.mjs` **257/257**（v0.7.0 起源码护栏改读 `src-core/collector.src.mjs`，版本断言改成「扩展源 / 扩展安装后 / MCP 三处一致」——插件包版本独立），`verify-encrypted.mjs` 全部通过（载荷结构 / 逐字节还原 / 四主导出 / 运行期缓存 / 篡改检测 / 扩展解密安装与不重装）。`node --check` 全过。
- **打包**：`package.json` 的 `files` **不含** `src-core/` 与明文 `extension/`（只发 `core.enc` + `extension.enc`），避免打包把加密源码又带出去；本地开发目录仍保留它们，改完跑 `node build-encrypted.mjs` 重建。装好的插件包没有明文源，故也不能在包内重建。
- **安装**：NovaFlow 账号 profile（`~/.novaflow/accounts/<key>/profiles/desktop`）的依赖已改为 `file:D:/dycopy/dsh-douyin-comments` 并在该 profile 跑 `pnpm install`（hoisted，装进 `node_modules/dsh-douyin-comments`）；改完须退出并重开 NovaFlow 生效。

**0.6.0 变更**（2026-11-04）：**合并 `dsh-comment-viewer`（评论词云）到本插件，并且整合到同一个界面**——左侧只有一个入口「抖音评论」，点开是同一个面板，面板顶部两个小 tab「采集 / 评论词云」；采集完成后自动切到词云子页并展开面板。
- 界面：左侧单个入口「抖音评论」(order 23)；右侧栏 tab 类型 `id/kind = douyin-comments-console`（`keepMounted: true`）。不再有独立的「评论词云」入口/面板，采集页与词云页是同一面板的两个子页（两个 iframe 交替显示，状态都保留）。
- 服务端：词云服务端并入 `viewer.mjs`（`VIEWER_PREFIX = /plugins/dsh-douyin-comments/viewer`，静态页在包内 `viewer/`）；控制台与词云**共用一个 webServer prefix**（`/plugins/dsh-douyin-comments`），由 `index.js` 里的组合 handler 按路径分发（以 `VIEWER_PREFIX` 开头的走词云，其余走控制台），不依赖宿主对互含前缀的匹配优先级。
- 自动打开：新增 `GET /viewer/api/latest`（返回允许目录里 mtime 最新的 `douyin-comments-*.json`，与 `/api/list` 首项一致）；`client.js` 每 3 秒轮询它，发现最新导出换了文件 → `setPanelMode('viewer')` 切子页 + `bumpViewerGeneration()` 让词云 iframe 重载 + `ctx.sidebarRight.openTab('douyin-comments-console', {revealIfOpened:true})` 展开右侧栏；工具调用与控制台两条采集路径都会落盘，所以两条路径都能自动切换。
- 词云页：iframe 带 `?embed=1&latest=1&gen=<n>`，app 侧对 `latest=1` 做**一次性强制最新**（`localStorage['cw.latestGen']` 记住已强制过的 gen，不覆盖用户上次选的旧记录）；`aiApiPath()` 的挂载判断改成通用 ``/^\/plugins\/[^/]+\/(app|viewer)(\/|$)/``。
- 迁移：DSH desktop profile 的 `dsh.profile.bundles` 与 dependencies 里已移除 `dsh-comment-viewer`（同 id 的 tab 类型二次注册会抛错）；旧源码目录 `D:\dycopy\dsh-comment-viewer` 保留未删。
- 自检：`verify-merged.mjs`（单 prefix / 路由 / 静态页 / 越界拒绝 / 无模型 409 共 15 项）与 `verify-client.mjs`（单入口 + 面板两个子 tab + 采集完成自动切词云 + 卸载清理共 24 项），全部通过。

**0.5.62 变更**（2026-10-31）：合并 `feat/dsh-web-console` —— DSH Web 界面左侧「抖音采集」入口，点开是插件自带控制台（粘贴链接 → 开始/取消 → 看进度日志 → 下载 CSV/JSON/词云），采集仍跑在有头 Chromium 里。合并时修了 4 处：① 工具默认写会话工作区、控制台写全局目录导致「导出记录」看不到工具产物 ⇒ 工具每跑一次记 `last-out.json`，控制台据此收录；② 进度条原来用 `topSeen/max`（默认 80000）几乎恒为 0% ⇒ 改按页面回报的 `total` 计算，完成即 100%；③ 下载接口只放 `douyin-comments-*` / `douyin-wordcloud-*` 导出文件（其余 403）；④ 控制台支持深色主题（由 `client.js` 读 DSH 主题后经 `?theme=` 传入）。新增 `verify-console.mjs`（12 项）与 8 条契约断言。

**0.5.62 变更**（2026-10-27）：骨架屏按 taste 重做——词云 46 个「词块」螺旋分布、表格按真实列宽 12 行、KPI 条宽随机化、极淡扫光、加载中压暗侧栏与洞察区（`prefers-reduced-motion` 下静止）。

**0.5.60 变更**（2026-10-27）：AI 解读流式阶段只显示「正在生成… N 字」，不再把 JSON 原文当打字机效果展示（`.ai-streaming`/`.ai-spin`，结束后一次渲染）；纯前端改动，F5 即生效。

**0.5.59 变更**（2026-10-27）：修 AI 解读「模型没有返回内容」——DeepSeek 默认 reasoning effort = high，思考 token 走 `reasoning-delta` 不计正文，900 预算被吃光 ⇒ 0 字 `max-tokens`。现显式 `reasoningEffort: 'off'`、预算 1600、并支持一次加倍重试；debug 增 `reasonChars`。

**0.5.58 变更**（2026-10-27）：修 AI 解读「模型返回失败：aborted」——`req` 的 `close` 在请求体读完就会触发（Node 18+），误当客户端断连把模型请求掐断；改为监听响应 `close` + `!res.writableEnded` 判断，并加 6 条回归断言。

**0.5.57 变更**（2026-10-27）：修 AI 解读「点了没反应」——消息改用官方 `createUserMessage` 构造（裸字符串内容会被 runtime 判空），并显式透出 `finish.reason` 的错误；模型无输出时给出可读提示。

**0.5.56 变更**（2026-10-26）：**评论分析台接上 DSH 的 AI 解读**（不需额外配置）——洞察区右上「AI 解读」→ 前端生成 `cv-digest/1` 摘要（不含昵称/UID/cid/链接）→ `POST /plugins/dsh-comment-viewer/app/api/explain` → 用 `ctx.llm.stream` + `agentDefaultModel.currentSelection()` **复用 DSH 默认模型**，SSE 流式返回「整体结论 / 主要问题 / 建议 / 买家原话」；无模型时回 409 并显示「先在 DSH 设置里选一个默认模型」；独立网页 / 扩展内联云图页自动降级为复制摘要。顺带：识别店透视**平台默认评价**（占位文本不进词云/主题，情感按评价类型兜底）。自测：路由单测 13/13、分析台 UI 端到端 13/13、`verify-tool` 249/249。

**0.5.55 变更**（2026-10-26）：**评论分析台支持淘宝「店透视-评价分析」xlsx**（纯前端解析，零新增依赖）——拖入或选择 `.xlsx` 即可分析；自动识别店透视表头并把 `评价类型` / `SKU` / `晒图数` 保留在数据里；多份重复导出按 `旺旺号+时间+正文+SKU` 去重；「地域分布」为空、昵称不可跳主页（淘宝表没有 IP 与 sec_uid）。

**0.5.54 变更**（2026-10-24）：**隐私清理，无功能变化** —— README / PROTOCOL / 插件说明里引用的真实视频 ID、评论 ID 与真实关键词示例，统一换成 `76…`/`露营` 这类占位符；代码行为、文件格式、工具参数都没变。

**0.5.53 变更**（2026-10-23）：自选视频浮层去掉复选框——整行点击切换，选中只用 1px 琥珀描边 + 6% 淡底 + 标题提亮（`input` 视觉隐藏，保留状态与键盘可达）。

**0.5.53 变更**（2026-10-23）：自选视频浮层选中态按 taste 重做——1px 琥珀描边 + 6% 淡底（去掉 3px 亮条与大块琥珀底），
行高 44px、复选框 16px；探针 13/13。

**0.5.51 变更**（2026-10-23）：词云页洞察面板「主题聚类」与「地域分布」两卡等高（`syncInsightHeights()`），
主题多时在卡内滚动；手机单列不设上限。自测 63/63（查看器）、36/36（词云页）、242/242（verify）。

**0.5.50 变更**（2026-10-23）：评论分析台 v4.0 设备兼容性适配 + 视觉打磨——360~1920px 无横向溢出（390/768/1024/1440 实测 `scrollWidth==innerWidth`）、≤620px 评论表变卡片列表（td 带 `data-label`）、触屏热区 40px 且词云不放大、尊重 `prefers-reduced-motion`；间距/字号统一 `clamp()`、KPI 用 1px gap 画线、空表不再留 620px 空白。自测 61/61 + 34/34 + 242/242，taste-skill inspect 0 FAIL / 0 WARN。

**0.5.49 变更**（2026-10-23）：云图页首帧改成「正在载入词云…」纯内联占位，去掉点「导出词云」后约 0.1~0.3 秒的黑底三点闪现；读到数据后整页替换为分析台，并清掉占位样式避免影响词云排版。自测：`verify-tool.mjs` 242/242、云图探针 17/17。

**0.5.48 变更**（2026-10-23）：词云改打开**专用页 `cloud.html`**（不再先闪诊断页）；云图页新增 **「下载 HTML」** 按钮（需要文件时点一下，AI/MCP 的 `cloud` 命令照旧落盘）；侧栏筛选项改**内联样式**并给资源加 `?v=0.5.48`，彻底避免旧缓存导致的竖排/裁切；页脚显示版本号。自测：`verify-tool.mjs` 242/242、查看器 61/61、词云插件页 34/34、云图真机探针 17/17。

**0.5.47 变更**（2026-10-23）：修复词云页侧栏复选框文字在窄栏/旧缓存下**逐字竖排**——两处样式加「侧栏防御」（`.side-body` 不换行、子项整行、`.check` 不折行）；页面资源加 `?v=0.5.47` 版本号；`dsh-comment-viewer` 静态服务改 `Cache-Control: no-store`。自测：`verify-tool.mjs` 238/238、查看器 61/61、词云插件页 34/34。

**0.5.46 变更**（2026-10-23）：词云页新增**情感健康度评分**卡（0~100 分 + 五级评价 + 四项风险指标；熵权法 + TOPSIS，按天分桶加权，纯本地计算，命名用「情感」不用「舆情」）；面板「导出词云」**不再下载文件**，改为在**新标签页直接打开**（扩展页 `index.html?cloudview=1` + `chrome.storage.local` 传数据）；AI / MCP 的 `cloud` 命令仍落盘 `htmlPath`。自测 verify-tool 238/238、词云页真机 12/12。

**0.5.45 变更**（2026-10-23）：内置词云页升级为「分析台」——新增**洞察面板**（情感分布 / 评论趋势 / 地域分布 / 主题聚类 4 张卡）、**情感与主题两个筛选器**；KPI 6 → 8 格（正向 / 负向 / 主题数），评论表加「情感」列，导出 CSV 12 → 14 列（+情感 / 主题），导出 JSON 每条带 sentiment / sentimentScore / topic。词云页本身是 comment-viewer 的同源拷贝（sync-extension.mjs / _gen_viewer_assets.mjs 同步）。自测 verify-tool 237/237、查看器 61/61、词云页 34/34。

**0.5.44 变更**（2026-10-22）：「等签名」期间改成**持续助推**（用户 m00597：等太久要自己滚一滚）。签名过期进入 `waiting-sign` 后，扩展不再只点 3 次入口就干等，而是每 3 秒助推一次、最多 20 次（≈60s）：评论区开着就交替「滚到底 / 往上回拉一屏」，每第 3 次收起再点开；列表滚不动就收起再点开；评论区没开就直接点入口。拿到签名 / 暂停 / 换视频时 `setPhase` 立刻停掉。续采不必再点第二次「开始采集」。自测 verify-tool 236/236（新增 3 项助推结构校验）。

**0.5.43 变更**（2026-10-22）：导出范围默认**不预选**任何视频（`exportPick` 默认 `null`），面板显示「导出范围：未选中视频 ▾」；没选就点导出时提示「未选中视频：先点『导出范围』勾选要导出的视频（『全选』= 本地全部视频）」并自动打开浮层，不再走 `EMPTY_POOL`。自测 233/233 + 探针 22/19/13 全绿。

**0.5.42 变更**（2026-10-22）：词云页评论表新增 **「导出 CSV」/「导出 JSON」** 两个按钮（原来只有「导出筛选结果」）：CSV 12 列、第 1 行英文键 + 第 2 行中文说明；JSON 带 `exportedAt/count/filters/videos/comments`。都导当前筛选结果。自测 查看器 50/50、词云页 32/32、verify-tool 232/232。

**0.5.41 变更**（2026-10-22）：词云页关键词再升级（停用词扩到 ~1100、视频内 IDF 权重 + 泛词剔除、侧栏「加词 / 屏蔽」自定义词表并记忆），实测 1541 条评论关键词 986 → 710；查看器 50/50、词云页 31/31、verify-tool 231/231。

**0.5.40 变更**（2026-10-22）：词云页关键词新增**虚词过滤**（停用词扩充 + `FUNCTION_CHARS` 字符级启发式 + 「过滤虚词」开关），「这种 / 都是 / 我的 / 出来」不再进关键词榜；导出 CSV/JSON 与 MCP 接口无变化。

**0.5.39 变更**（2026-10-21）：随扩展的**选择浮层文案修正** —— 打开「导出范围」不再默认勾当前视频、顶部显示「还未选中视频」、底部按钮改「选中视频」（插件自身的 `cloud` 导出不受影响，它直接点「导出词云」）。

**0.5.38 变更**（2026-10-21）：新增 `cloud` 参数与 `htmlPath` 返回值 —— 采完顺手导出一份**自包含词云 HTML**（内联数据 + 内联样式脚本，双击即看、可发给别人、数据不出本机）；同时 Hub 增加 `cloud` 命令、MCP 增加 `ai_export_wordcloud`，三条路产出一致。自测：verify-tool 228/228；hub 真机探针 9/9；词云页 26/26；独立分析台 44/44。

**0.5.37 变更**（2026-10-21）：词云页两栏等高；内嵌页「管理记录」支持勾选多条导出批量删除（`POST /api/delete`，真删磁盘文件）；移除「找回已清空的」。自测：嵌入页 25/25。

**0.5.36 变更**：词云骨架屏改成 8 块大块（替代 18 条细碎小条）。

**0.5.35 修正**（2026-10-21）：词云页「清空」改成持久记忆——已清空的导出文件记在 `localStorage['cw.embed.v1']`，刷新页面/切会话后不会再被自动装回来；右上角多一个「找回已清空的 N」入口。自测：嵌入页 23/23。

**0.5.34 修正**（2026-10-21）：① 词云页空状态不再铺满整页、限制在词云面板内居中（`.cloud-panel{position:relative}`）；② 内嵌词云页点「清空」时把刚清空那条从右上角文件下拉里移除（其余保留、选择退回占位，磁盘文件不删）。自测：嵌入页 21/21、独立分析台 44/44。

**0.5.33 变更**（2026-10-21）：导出词云页（`app/`，随扩展内联）与 DSH 内嵌词云页同步改版——① 空/有数据布局恒定（右栏与评论表不再消失，切数据不重排）；② 加载时显示骨架屏（KPI / 词云 / 关键词 / 表格），解析完成后替换；③ 「清空」只清已载入数据，右上角文件下拉保留磁盘文件列表、选择退回「请选择要查看的导出文件…」。自测：嵌入页 21/21、独立分析台 44/44。

**0.5.33 变更**（2026-10-21）：导出词云页（`app/`，随扩展内联）与 DSH 内嵌词云页同步改版——① 空/有数据布局恒定（右栏与评论表不再消失，切数据不重排）；② 加载时显示骨架屏（KPI / 词云 / 关键词 / 表格），解析完成后替换；③ 「清空」只清已载入数据，右上角文件下拉保留磁盘文件列表、选择退回「请选择要查看的导出文件…」。自测：嵌入页 21/21、独立分析台 44/44。

**0.5.33 变更**（2026-10-21）：导出词云页（`app/`，随扩展内联）与 DSH 内嵌词云页同步改版——① 空/有数据布局恒定（右栏与评论表不再消失，切数据不重排）；② 加载时显示骨架屏（KPI / 词云 / 关键词 / 表格），解析完成后替换；③ 「清空」只清已载入数据，右上角文件下拉保留磁盘文件列表、选择退回「请选择要查看的导出文件…」。自测：嵌入页 21/21、独立分析台 44/44。

**0.5.33 变更**（2026-10-21）：导出词云页（`app/`，随扩展内联）与 DSH 内嵌词云页同步改版——① 空/有数据布局恒定（右栏与评论表不再消失，切数据不重排）；② 加载时显示骨架屏（KPI / 词云 / 关键词 / 表格），解析完成后替换；③ 「清空」只清已载入数据，右上角文件下拉保留磁盘文件列表、选择退回「请选择要查看的导出文件…」。自测：嵌入页 21/21、独立分析台 44/44。

**0.5.32 变更**（2026-10-21 客户「能看到有个词是悲伤，点进去就是[悲伤]」）：

- 词云分词前剥离抖音表情标签 `[憨笑]` / `[流泪]` / `[悲伤]`（`tokensOf()` 里 `/\[[^\[\]]{1,12}\]/g`），
  **纯表情评论不再贡献关键词**；扩展「导出词云」内联的分析台与 DSH 嵌入插件 `dsh-comment-viewer` 同步修复。
- **JSON 导出补上 `text_clean`**（与 CSV 的「文本(去表情话题)」同口径）：扩展 `background.js` 与插件 `collector.mjs` 两处 JSON 都写，
  分析台 / 词云直接用它分词，老文件缺字段时才现剥 `[表情]`。
- 回归：`node verify-tool.mjs` 223/223、`_test_wordcloud_plugin.mjs` 15/15、`_test_comment_viewer.mjs` 44/44。

**0.5.31 变更**（2026-10-21 客户「插件 UI 还能再美化吗」→ 看完预览图「采集中是绿的，就按这个改」）：

- 面板视觉改版 v3：**三组分栏**（采集 / 导出 / 清理）、**只留一个琥珀强调色**（`#e0a94a`）、
  **「开始采集」白底黑字反白**、状态点语义色（**采集中 = 绿** + 淡环）、次要信息压成一行小字、
  数字等宽、底部「数据只在本地处理 + 版本号」。
- 去掉 5 处渐变与 16 处发光阴影；字号收敛到 14 / 12.5 / 11 三档；圆角 6 / 10 两档。
- **交互与契约零变化**：按钮 `data-dts-act` 一个没改、面板仍 310px / 14px、设置浮层仍撑高 430px、自选浮层逻辑不变。
- 自选浮层选中态从蓝改成琥珀（`rgba(224,169,74,.14)` + 左侧 3px 实条），更贴合新的单一强调色。
- 自测 `verify-tool.mjs` 222/222；真机探针 6 组全绿（设置浮层 / 自选选中态 13/13 / 自选导出 20/20 / 全部清空 19/19 / 标题 8/8 / 词云导出 16/16）。
- 生效方式：重装扩展 zip 或重启 `dsh web`（Chrome 会缓存扩展背景脚本，装完要刷新抖音页）。

上一条 **0.5.30 变更**（2026-10-21 用户「把原来的插件的导出风控日志换成导出词云，将采集的数据一键导出到词云」）：
面板原来的「导出风控日志」按钮换成「**导出词云**」——点一下就把「导出范围 ▾」选中的视频评论打包成**一个自包含 HTML**
（词云页的 html/css/js 全内联、数据进 `window.__CW_BOOT__`）。下载后**双击即交互词云**：悬停看词的评论、点词看全部、
点评论跳用户主页、按视频/一级评论/有主页筛选、导出筛选结果；文件可以直接微信/邮件发给别人，对方不用装扩展、不用起服务、数据不出本机。
风控观测（请求次数 / 最近放行时间）仍在面板显示，只是不再导出日志。实测：`162 条 · 1 个视频 · 237 KB`，
`file://` 打开后词云 73 词、评论 162 条、无 JS 报错（`_probe_cloud_0530.mjs` 16/16）。扩展文件数仍是 8 个
（词云页源码以生成块内联进 `background.js`：`devkit/_gen_viewer_assets.mjs` 灌入，改完词云页要重跑生成脚本 + `sync-extension.mjs`）。
上一条 **0.5.29 变更**（2026-10-20 客户「那加这个兜底」）：CSV 的 `user_unique_id`（抖音号）为空时
**改填数字短号**（`u.unique_id || u.short_id`），不新增列（单视频仍 19 列 / 多条 20 列），
中文说明行标签改为 `抖音号(空则填数字短号)`。JSON / AI 返回里的原始字段不动。自测 **217/217**。

**0.5.28 变更**（2026-10-20 客户「这个短 id 是什么，不要了」）：CSV **删掉 `user_short_id` 列**——
「短 ID」就是账号页上的**数字抖音号**，和 `user_unique_id`（自定义抖音号，可空）高度重复。
单视频 **19 列**、多条视频 **20 列**；保留 `user_sec_uid`（加密 ID，`https://www.douyin.com/user/<sec_uid>` 即主页）
与 `user_unique_id`（抖音号）。JSON / AI 返回里的 `user.short_id` 不动。自测 **216/216**。

**0.5.27 新增**（2026-10-20 客户「列头都是英文，客户看不懂，能不能加行中文解释」）：

1. 导出的 CSV **第 2 行是中文列名说明**（第 1 行英文键不动 ⇒ 机器解析、AI 读取、历史脚本口径都不变）：
   首列写成 `# 评论ID`，`#` 开头就是「说明行」标记；解析时跳过首列以 `#` 开头的行，数据行数 = 总行数 − 2。
2. `collector.mjs` 导出 `CSV_COL_LABELS` / `csvLabelRow(cols)`，扩展 `background.js` 里有**逐字相同**的标签表；
   `verify-tool.mjs` 新增两条断言（说明行插入位置 + 两边标签表同源、21 个键）。单视频 20 列、多条视频 21 列
   都自动带上说明行（末列说明是 `视频ID(多视频导出)`）。JSON 不变。
3. 自测 **216/216**；下游 `douyin-analysis` 的 CSV 导入已同步跳过 `#` 说明行。真机导出的 CSV 见「输出格式」。

**0.5.26 变更**（2026-10-20 用户「能不打开其他的浏览器就获得标题吗」）：

1. 不再打开任何页面/标签页去补作品标题。实测不开页面拿不到（视频页是空壳 HTML、老分享接口 `11110`、
   `aweme/detail` 无签名 403），所以把 v0.5.24 的补齐链路（`dts-fix-titles` 消息、`readTitleFromVideoPage`、
   `fixVideoTitles`、浮层打开时自动补）整套删掉。
2. 抓不到标题的条目在浮层里显示「视频 <末 8 位>」，下一行仍有「ID … · 采集 …」，旧数据同样适用。
3. 自测 **214/214**、真机 **8/8**（`_probe_titles_0526.mjs`：显示「视频 96371819」；打开浮层前后窗口数/标签页数不变；
   测完还原原标题不写坏数据）。

**0.5.25 变更**（2026-10-20 用户「这个按键不要了」）：

1. 去掉自选导出浮层里的「读取真实标题」按钮（v0.5.24 加的手动补标题入口）及其 `.dts-btn-wide` 样式。
2. 自动补全保留：打开浮层发现通用页名（「抖音精选电脑版」等）时仍会自动开隐藏标签页读详情页标题并写回。
   自测 **215/215**、真机 **6/6**（日志 `devkit/_probe-titles-0525.txt`）。
   （**v0.5.26 起连自动补也删掉了**，见上方 0.5.26 变更。）

**0.5.24 新增**（2026-10-20 用户「很难区分啊，能不能把这个变成视频的标题」）：

1. 自选导出浮层每行显示**作品标题**：以前取的是采集时的 `document.title`，在推荐/精选网格页只能是
   「抖音精选电脑版」这类通用页名，多条重名认不出。现在后台会开隐藏标签页去
   `https://www.douyin.com/video/<id>` 读详情页标题补全（只改 `dts_videos[id].title`，不动评论数据）。
2. 每行标题下加小字 `ID <末 8 位> · 采集 <MM-DD HH:mm>`；标题仍是通用页名的先显示 `视频 <末 8 位>`；
   浮层打开时自动补一次（v0.5.25 起没有手动按钮；v0.5.26 起不再自动补）。自测 **214/214**、真机 **7/7**
   （日志 `devkit/_probe-titles-0524.txt`，截图 `devkit/_panel-0524-titles@2x.png`）。

**0.5.23 新增**（2026-10-20 用户「导出视频那里，选中没有提示」）：

1. 自选导出浮层的选中反馈加强：选中行**整行淡蓝底 + 左侧 3px 亮条**、标题加粗提亮、复选框 15→**17px**；
   顶部「已选 K 个（约 M 条）」变蓝加粗，确认按钮变成「导出选中的 K 个…」；点整行任意位置（含标题）都能勾选。
2. 纯 CSS + 一行 `classList.toggle('dts-has-sel', …)`，导出协议不变；自测 **212/212**、真机 **13/13**
   （日志 `devkit/_probe-picksel-0523.txt`，截图 `devkit/_panel-0523-picker-selected@2x.png`）。

**0.5.22 修复**（2026-10-20 用户「全部清空后，选择的导出的视频不会变，我要点进去才会变回来」）：

1. 「全部清空」成功后导出选择立刻复位（`exportPick = null` + `exportPickTouched = false`），
   面板按钮立刻回到「导出范围：本条视频 ▾」；单条「清空」也会把该视频从选择里剔掉、空了回默认。
2. 根因是两条清空路径都先 `setPhase()`（内部 `render()`）再改 `exportPick`，所以画的是旧选择，
   要等下一次刷新才更新；现在改成**先改选择再 `setPhase()`**。
3. 自测 211/211、真机 19/19（临时 profile + 种数据，不碰真实采集数据；日志 `devkit/_probe-clearall-0522.txt`）。

**0.5.21 新增**（2026-10-20 用户「那本条和全部那个就可以不要了」）：

1. **扩展面板「导出范围」只留一个入口**：删掉「本条视频 / 全部视频」两个按钮，只剩
   **「导出范围 ▾」**；默认不点也等于「本条视频」（默认值 = 当前视频），点开可勾任意几条
   （「全选」= 本地全部视频）。选 1 条 19 列、选 ≥2 条 20 列（末尾 `video_id`）。
2. 用户亲手改过选择后**不再自动跟随当前视频**；没选就点导出会自动打开浮层。
3. 工具参数与后台协议**不变**（`all` / `videoId` / `videoIds` 仍可用，只是面板不再发 `all:true`）；
   纯前端改动 + `sync-extension.mjs`，自测 210/210、真机探针 18/18
   （日志 `devkit/_probe-pick-0521.txt`）。

**0.5.20 新增**（2026-10-20 用户反馈「导出只能本条 / 全部，限制有点大」）：

1. **扩展面板「导出范围」新增「自选视频…」**：浮层里列出本地已存的每个视频（标题 + 条数），
   勾选任意几条 → 确定，再点「导出 CSV / 导出 JSON」就只导这几条。选 **1 条** 与「本条视频」同列数
   （19 列）；选 **多条** 与「全部视频」一致（20 列，末尾 `video_id`），文件名 `selected<N>`。
   本插件工具 `douyin_comments` 本身的导出仍是「只导本轮采到的评论」，不受影响。
2. MCP `ai_export` 新增 **`videoIds: [...]`** 参数（优先级 `all` > `videoIds` > `videoId`）；
   旧扩展会把这种请求当缺 `videoId` 并提示升级到 v0.5.20。
   三件套版本同步 `0.5.20`，自测 **209/209** 全绿（新增 7 条自选导出断言）。真机验证
   `_probe_pick_0520.mjs` **13/13 PASS**（日志 `devkit/_probe-pick-0520.txt`）：
   浮层列出本地 5 个视频 → 勾 2 个（109 + 1365 条）导出 `douyin-comments-selected2-<ts>.csv`
   **421676 B / 21 列 / 末列 `video_id` / 行数 1474 = 109+1365**，视频 id 正好那两个；改选 1 个
   导出 `douyin-comments-7600000000000000010-<ts>.csv` **20 列**。
   排查时踩到一个坑：Chrome 把扩展 background（MV3 SW）的编译脚本缓存在 profile 的
   `Default/Service Worker/ScriptCache`，**扩展文件换了、manifest 版本号也变了，浏览器里照跑旧
   background.js**；正式采集路径（`collectDouyinComments`）已按扩展 hash 自动清理，自己写的探针
   若直接 `launchPersistentContext` 必须先调 `clearStaleScriptCaches(profile)`。

**0.5.19 新增**（2026-10-20 客户反馈「字体太小了，插件框改大点，字体改大点」）：

1. **采集面板整体放大 ≈1.3 倍**：宽 236px → **310px**、基础字号 11px → **14px**、行高 1.45 → **1.5**，
   按钮 / 输入框 / 进度条 / 内边距 / 间距同比例放大；设置浮层撑高 322px → **430px**（放大后 6 行仍不滚动）。
   仍然是**单一档位**（没有「大/小」切换，`dts_panel_size` 存储键继续不读）。
2. 扩展侧纯 CSS 改动（`panel.css`），插件侧只需 `node sync-extension.mjs` 同步自带的 `extension/`；
   三件套版本同步到 `0.5.19`，自测 **202/202** 全绿（新增「宽 310 / 字号 14 / 撑高 430」断言）。
   真机实测（1440×900）：面板宽 310、基础字号 14px、按钮 16px、设置浮层 492px 高且**无滚动条**。

**0.5.18 新增**（用户 2026-10-20 问「为什么顶层评论采完、切二级回复时会等很久」）：

1. **二级回复「预热」可调、默认 30 秒 → 10 秒**：进补采前的静默是**故意的**（列表接口刚轰完就打回复接口
   会被服务端成片拒，HTTP 200 + 0 字节 body），但以前在扩展里写死 30 秒、面板和插件都改不了。
   现在新增设置 **`replyWarmupSec`**（默认 **10**，0~600，**0 = 不预热**），总是下发给扩展
   （`dts_settings.replyWarmupMs`，0 不会被当成「未指定」吞掉）；面板齿轮 ⚙ 同时多了「回复预热 s」一行，
   优先级仍是 **面板 > 插件 > 内置**，环境变量 `DOUYIN_REPLY_WARMUP_SEC` 也可覆盖。
2. 生效值写进 `dts_settings_effective.replyWarmupMs`，采集器日志与面板阶段文案都会写出「先预热 N 秒」；
   三件套版本同步到 `0.5.18`，自测 **201/201** 全绿（新增 5 条断言）。

**0.5.17 新增**（用户 2026-10-20 问「表格里 `user_uid` 是什么，不是抖音号、搜到也没用」）：

1. **CSV 末尾追加 3 列能用的用户标识**：`user_sec_uid`、`user_unique_id`、`user_short_id`
   （单视频 17 → **20 列**；「全部视频」18 → **21 列**，`video_id` 仍在最后一列）。
   原因：`user_uid` 是抖音**内部数字 ID**，既搜不到人、也拼不出主页；`unique_id` 才是账号页上的**抖音号**
   （用户没设自定义号时为空，此时用 `short_id` 补），`sec_uid` 可直接拼主页
   `https://www.douyin.com/user/<sec_uid>`。插件写盘与扩展面板导出**两处写入器同步追加**（同源契约不 drift）。
2. 前 17 列（老读者按位置读）**列序与含义完全不变**，仍是 append-only；三件套版本同步到 `0.5.17`，
   自测 196/196 全绿（新增 1 条「两处写入器都追加了这三列」的断言）。

**0.5.16 新增**（2026-10-08 代码审查发现的问题，**扩展三件套都有改动**）：

1. **扩展侧修 6 处数据正确性缺陷**（详见 `douyin-collector/README.md` 的 v0.5.16 条）：
   多路翻页「一路失败就跳过那一页」、检测到两路同页后仍丢页、并发落库互相覆盖、
   `clear_storage` 桥命令空参数会清空全部、页面自己的评论响应从未送达、扩展 ID 在 macOS/Linux 上算错。
   另有 1 处缓解（落库合批 + 桶内存副本，**仍是整桶写**）。
2. **插件侧**：`client/client.js` 的设置表单与宿主 `Config` 逐项对齐——`replyLanes` / `replyThrottleSec`
   的下限改回宿主的 1 / 10（旧版允许填 0，但宿主会拒绝或钳掉；内置限流等待是 120 秒不是 10 秒）、
   `lanes` 文案从「默认 4」改成「默认 3，错峰多路」，补上缺的 `replyGlobalGapMs` / `failSnapshot` /
   `keepSnapshots` 三个字段（布尔项新增 `def` 兜底显示，未存过值时按宿主默认值勾选）。
3. **自测 195/195 全绿**：版本一致性断言从「都等于 `0.5.15`」改成「**四处互相一致**」
   （插件 `package.json` / `extension/manifest.json` / 安装后的扩展 manifest / MCP `package.json`），
   以后每发一版不用再改测试，而且漏改一处也能测出来。

**0.5.15 新增**（用户 2026-10-07 说「同步一下版本号吧，有点乱」）：

1. **三件套从本版起同号**：扩展 `manifest.json` 从 `0.2.15` 改为 **`0.5.15`**、MCP `package.json` 与 `mcp.js` 的
   `VERSION` 从 `0.3.6` 改为 **`0.5.15`**、插件自身 `0.5.14` → **`0.5.15`**。发布附件名同步统一：
   `dsh-douyin-comments-0.5.15.tgz`、`douyin-collector-extension-v0.5.15.zip`、`douyin-collector-mcp-v0.5.15.zip`、
   整包 `dsh-douyin-comments-v0.5.15.zip`。
2. **功能一行没改**：采集逻辑、设置项（`max` / `lanes` / `failSnapshot` / `keepSnapshots` …）、返回值
   （`logPath` / `snapshotDir`）、`chrome.storage` 键、面板 UI、CSV/JSON 列都与 0.5.14 相同，只是版本号口径统一。
3. **历史编号对照**（changelog 里的旧编号 ↔ 发布版）：扩展 0.2.11 / 0.2.12 / 0.2.13 / 0.2.14 / 0.2.15 ↔ 发布
   v0.5.9 / v0.5.10 / v0.5.11 / v0.5.12 / v0.5.13（v0.5.14 沿用扩展 0.2.15）；MCP 0.3.2~0.3.6 ↔ v0.5.9~v0.5.13。
4. **自测**：`node verify-tool.mjs` **193/193 全绿**——新增 1 条「三件套版本统一」硬断言（插件 `package.json`、
   扩展 `manifest.json`、`douyin-mcp/package.json` 必须都是 `0.5.15`），两条扩展版本下限断言改成**语义比较**
   （不再写死数字），MCP `VERSION` 断言与 MCP `package.json` 对齐。

**0.5.14 新增**（用户 2026-10-07 说「做个失败快照和日志吧」；扩展与 MCP 本次**未改动**，仍是 0.2.15 / 0.3.6）：

1. **每次调用都写一份运行日志**：`~/.dsh/douyin-collector/logs/collect-<时间戳>-<pid>.log`，每行行首带相对时间
   `[+22.9s]`，记全过程（装扩展 / 锁 / 启动浏览器 / 面板校验 / 后台探针 / 登录闸门 / 清空 / 下发设置 /
   签名等待与 nudge / 轮询 / 收工原因 / 落盘）。返回值新增 `logPath`，成功路径的 render 也会打印它。
   日志只保留最新 **50** 份（`RUN_LOG_KEEP`，每次写日志前顺手清理旧文件）。
2. **失败或没采完时自动存「失败现场」**：目录 `~/.dsh/douyin-collector/failures/<时间戳>-<videoId>/`，四件套——
   `status.json`（`reason` / `at` / `pageUrl` / 收工原因 `endedBy` / 面板 `status` 快照 / 日志尾部 80 行）、
   `screenshot.png`、`page.html`、`run.log`。触发条件：总超时（`timeout`）、无进展（`stall`）、被取消（`abort`），
   以及**任何抛错**（含「启动阶段失败」与主流程异常）。返回值新增 `snapshotDir`，失败时路径也拼进 `error`。
   只保留最新 **20** 份（新设置 `keepSnapshots`）。
3. **两个新设置**：`failSnapshot`（默认 **true**，失败/没采完时是否存现场；工具参数可按次关掉）、
   `keepSnapshots`（默认 **20**，1~500）。采完且正常结束时 `snapshotDir` 是空串（不占空间）。
4. **抛错也带人话**：主流程抛错时若异常文本里出现 `Execution context was destroyed` / `Target closed`，
   会自动补一句「（页面在采集途中跳转或关闭了：视频可能已被删、需要重新登录，或浏览器窗口被手动操作过）」，
   并把 `logPath` + `snapshotDir` 一起放进错误信息。
5. **真机验收**（同一视频）：正常采完 `count=918 / 39.6s / phase=paused` ⇒ `snapshotDir=""`（不留现场）；
   强压 `timeoutMs=22000` ⇒ 日志「收工原因：timeout」+ 现场四件套 + `snapshotDir` 指向它；
   `failSnapshot=off` 同参数 ⇒ `snapshotDir=""`；无效视频 id 抛错 ⇒ 错误信息里带两个路径、现场四件套齐全。
6. **插件层端到端**（`pkgtest` profile 装 `dsh-douyin-comments-0.5.14.tgz` 后 headless 真采）：
   正常 `max=30` → **338 条 / 23s**，日志 `[+22.9s] 收工原因：done`；
   `timeoutMs=15000` → **207 条 / 15.7s** + 工具文本照常给出「⚠️ 本轮没采完…现场快照：…」与「运行日志：…」。
7. **自测**：`node verify-tool.mjs` **193/193 全绿**（0.5.13 为 172；新增 2f 段 21 条：设置项/参数/schema/描述、
   `hints()` 拼接、`createRunLog` 边跑边写盘与 `ring()`、`captureFailureSnapshot` 无页面只留 `status.json` /
   有页面四件套齐 / 目录名带 videoId / 自带 `run.log`、`pruneDir` 只留最新 N、日志封顶 50 份，以及 3 条源码护栏）。

**0.5.13 新增**（配套 MCP `douyin-mcp` 升到 **0.3.6**；修用户 2026-10-07 追问的「单路太慢」）：
老结论「多路并发会被服务端合并成同一页」只对了一半——**真凶是「同一签名 + ~200ms 内同时发」**，
错峰就没事。

1. **顶层列表改回「错峰多路」，`lanes` 重新生效**（扩展 0.2.15，即发布版 v0.5.13）：内置默认 **3 路**，路与路之间
   `sleep(LANE_STAGGER_MS = 200ms + 0~60ms 抖动)` 才发下一个（错峰在途，最后 `Promise.all` 收拢）；
   `lanes: 1` = 老的单路串行。旧版（0.2.12~0.2.14）固定单路是**矫枉过正**。
2. **单路礼貌间隔 400ms → 150ms**（`MIN_INTERVAL_MS`）：实测中位往返 344ms，那 400ms 里有一半是纯等。
3. **静默少采的兜底**：同一轮里一旦发现**两路返回逐条相同的页**（服务端又开始合并），当轮把路数降回 1，
   把原因写进 `dts_settings_effective.lanesNote` 并在面板提示；多路时「某路越界空页」不再算触底
   （`anyLaneHasMore`），`laneShort` 也把路数降回 1 ⇒ 靠近列表末端自然收回单路。**宁可慢，不再少采。**
4. **量化收益（真机，同一视频 `7600000000000000004`，先清空）**：
   - 复现：同一签名下**同时**发 4 个 cursor（0/50/100/150）Σ返回 200 条、**去重后只剩 56 条**，
     `c50/c100/c150` 逐条相同，而每路响应的 `next` 还是对的（50/100/150/200）⇒ 只有去重才看得出；
     错峰 200ms / 500ms 都是 **200/200 唯一**。
   - 扫完整个列表（21 页、Σ返回 1021 条）：单路 **15.79s / 唯一 907** vs 错峰 4 路 **7.72s / 唯一 912**
     ⇒ **2.04× 提速、数据一样多**。
   - 端到端（扩展 0.2.15 / 发布版 v0.5.13）：单路 `lanes=1` → **919 条 / 36.8s**；错峰 3 路 `lanes=3` → **919 条 / 29.5s**；
     错峰 3 路 + `max=30` → **421 条 = 一级 105 + 二级 316（38/38 线程）** / **24.3s** / `phase=done`。
5. **面板 / 设置文案**：齿轮里「并发路数（已停用）」→「**顶层并发路数**」（1~8，默认 3），摘要显示
   「顶层 3 路错峰（200ms）」；插件设置表单、工具参数说明、`ai_get_settings` 同步改口径。
6. **自测**：`node verify-tool.mjs` **172/172 全绿**（0.5.12 为 164；3a 段整段重写 + 3e 段新增对
   `mcp.js` 描述与 `VERSION` 的断言）。

**0.5.12 新增**（配套 MCP `douyin-mcp` 升到 **0.3.5**；修用户 2026-10-07 报的「限速是假限速，有时候我自己点就能拿到」）：

1. **回复被拒不再「一波判终局」**（扩展 0.2.14）：旧版撞一次 `EMPTY_BODY` 就按
   `REPLY_THROTTLE_MAX_WAIT_MS = 10 秒` 收尾，用户只能自己再点一次「开始采集」。现在单波最多撞 12 秒，
   只要还有线程没拉到就**自动停一会儿再来一波**（停顿 15 → 30 → 60 秒），总窗口默认 **120 秒**
   （面板「限流等待 s」/插件 `replyThrottleSec` 可调 10~600 秒，**设 10 = 老行为**）。
   插件侧默认值也从 10 改成 **120**（否则插件会把 10 秒下发下去、又变回老行为）。
2. **`replyGlobalGapMs = 0` 的语义修对了**：0 / 缺省 = **用扩展内置的 250ms**。扩展 ≤ 0.2.13 把 0 当
   「关闸门」，而设置页 / MCP / PROTOCOL 一直写「0 = 用内置」——`ai_set_settings {replyGlobalGapMs: 0}`
   会**静默关掉限速**，0.2.14 起不再是这个意思。
3. **面板红字不再假挂**：这一波里先撞了几次「服务端暂时不回数据」、后面某个线程又成功时，
   立刻清掉面板那行红字（旧版会一直挂着，看起来像「一直在限流」）。
4. **补采结束就置 `done`**：旧版补采完成后 phase 停在 `replies`，而收尾门槛是 `phase === 'collecting'`
   ⇒ 面板一直显示「补采二级回复」、DSH 采集器还要空等到「无进展」才收工（真机 y1 轮：`ok=true` 但
   `phase=waiting-sign`，白等 120 秒、整轮 8.5 分钟）。修完真机 z1 轮：**25 秒跑完、`phase=done`**。
5. **收尾文案如实报「本轮共等 N 秒、分 M 波重试」**，并写明服务端回的是 `HTTP 200 + 0 字节 body`
   （`EMPTY_BODY`）——不是本地请求没回来（那种情况是另一个错误码 `REPLAY_TIMEOUT`，五轮真机一次没出现）。
6. **自测**：`node verify-tool.mjs` **164/164 全绿**（0.5.11 为 153；新增 11 条断言盯着上面的语义）。

**0.5.11 新增**（配套 MCP `douyin-mcp` 升到 **0.3.4**；修用户 2026-10-07 报的两个严重缺陷）：

1. **`max`（目标条数）真正生效了，而且不再吞掉二级回复**。旧版（≤ 0.5.10）的 `max` 有两处错：
   ① 插件**从不把 `maxCount` 下发给扩展**（`collector.mjs` 只推 `{lanes}`），于是扩展按自己的默认
   （0 = 不限）把顶层列表**跑完整轮**；② 插件在扩展进入 `replies` 阶段后点「暂停」收工，
   于是**二级回复被拦腰截断**——实测 `max=100` 返回 **896 条 / 50.3s**、面板显示「已手动暂停」。
   现在插件把 `max` 作为 `maxCount` 下发（`if (max > 0) extSettings.maxCount = max;`），
   扩展 0.2.13 到量后**只停止顶层扫描、继续把二级回复补完**；判定用的是**一级去重计数**
   （新上报的 `topSeen`，旧扩展不报时自动退回 `unique` 兜底）。旧扩展（≤ 0.2.12）不认识 `maxCount`，
   插件会自检 `dts_settings_effective.maxCount` 是否真被接受，**没被接受才**退回旧行为（点「暂停」）
   并把原因写进日志——老扩展 + 新插件不会静默跑飞。
2. **回复请求加了跨线程全局限速 + 撞限流自动降路**（扩展 0.2.13）：新设置项 **`replyGlobalGapMs`**
   （0~2000，0 = 用扩展内置的 **250ms** ≈ ≤4 次/秒）。旧版 `replyLanes` 条线程各自「取到线程就发」，
   单页线程之间零间隔（总速率 ≈20 次/秒），同一条视频两轮能差到「0/46 线程」与「~139 条二级回复」；
   现在所有回复请求（含失败重试）都过全局闸门，撞限流还会把间隔翻倍（封顶 1000ms）并**降 1 路**。
   插件设置表单、`douyin_comments` 工具参数与返回日志都能看到这一项。
3. **自测**：`node verify-tool.mjs` **153/153 全绿**（0.5.10 为 141；新增 6 条断言盯着上面的语义）。
4. **配套 MCP 升到 0.3.4**：`max` / `replyLanes` / `replyGapMs` 的说明改写（`replyGapMs` 不再说
   「限速请调 `replyLanes`」），`SETTINGS_PROPS` / `SETTINGS_KEYS` 新增 `replyGlobalGapMs`。

**0.5.10 新增**（内置扩展升到 **0.2.12**：顶层列表**固定单路**、`lanes` 并发路数**已停用**；配套 MCP `douyin-mcp` 升到 **0.3.3**）：

1. **顶层列表扫描固定单路（重要）**：真机实测（2026-10-06，视频 `7600000000000000004`，服务端 `total=1709`）
   **多路并发会被服务端合并成同一响应**——同一个签名在同一时刻发 `cursor` / `cursor+50` / `+100` / `+150`
   四路时，其中三路拿到的是**同一页**（两两重合 50/50，而且这一页不在任何单路页里）：4 路 5 轮只拿到
   **492 条**一级评论、**且 0 个失败请求**（是静默少给，不是报错）；单路串行（每次用服务端返回的 `next`
   推进）18 步拿到 **714~744 条**唯一一级评论（再多轮补扫只再加 1 条）；同样 4 路但每路之间**错峰 200ms**
   就恢复正常（4 页 = 200 条唯一）。所以扩展 0.2.12 起**顶层列表固定单路**，`lanes` 设置**已停用**：
   仍可读写、仍会下发给扩展，但**不再影响采集**（仅保留兼容）。
2. **同一视频实测对比**：修复前（扩展 0.2.11，4 路）**768 条**（一级 586 / 二级 182）**20.1s** →
   修复后（扩展 0.2.12，单路）**945 条**（一级 753 / 二级 192）**70.4s**：一级 **+28%**、总条数 **+23%**，
   代价是单路更慢（同一视频 **20s → 70s**）。另外服务端列表本身也有上限：该视频 `cursor=850` 时只回 8 条
   且 `has_more=0`、`cursor≥900` 回字面量 `null`，列表接口最多只给约 **850 条**（`total` 差额是二级回复 +
   已删除/被过滤评论）。
3. **自测**：`node verify-tool.mjs` **141/141 全绿**。
4. **配套 MCP 升到 0.3.3**：`ai_set_settings` / 设置项里的 `lanes` 说明改成「已停用（扩展 0.2.12 起顶层
   列表固定单路，并发会被服务端合并成同一页，4 路少采约 30%）」；`ai_export` 的「需要扩展 ≥ 0.2.11」
   保留不变。

**0.5.9 新增**（Hub/MCP 也能一次导出「本地全部视频」；内置扩展升到 **0.2.11**，配套 MCP `douyin-mcp` 升到 **0.3.2**）：

1. **导出只有一份实现**：扩展把面板「导出 CSV / 导出 JSON」与 Hub(AI/MCP) 的 `export` 命令合并到
   `background.js` 的 `async function exportComments(opts)`，两条入口行为完全一致（以前是两份各写各的）。
2. **Hub/MCP 也能「全部视频」导出**：`export` / MCP `ai_export` 新增 `all:true`——不传 `videoId`
   也能把本地所有视频合成一份，每条评论标 `videoId`，CSV 末尾追加 `video_id` 列（前 17 列契约不变），
   文件名 `douyin-comments-all-<时间戳>.csv|json`；Hub 成功回包主体放 `result`，MCP 侧把它**拍平**
   给模型看（`scope / videoCount / count / topLevelCount / replyCount / format / filename / bytes / path`）。
3. **导出失败不再「成功」**：既没 `videoId` 又没 `all` → `MISSING_VIDEO_ID`（hint 提示可传 `all:true`）；
   本地确实没数据 → `EMPTY_POOL`——**不再下载一个只有表头的空 CSV**；面板失败提示带上后台给的 `hint`。
4. **MCP 0.3.2 补上并发与限流的实测口径**（写进 `ai_start_collect` / `ai_set_settings` 的参数描述）：
   `lanes` 只作用于拉评论列表这一段（**该设置自扩展 0.2.12 起已停用**），对二级回复阶段没有约束；`replyLanes` 实测（2026-10-06，RTT≈245ms）
   **每路恒定约 4 次/秒**，总速率 ≈ 路数 × 4 次/秒（2 路≈8/秒、4 路≈16/秒），4 路连跑两组后回复接口
   会限流（服务端回 **0 字节**、报 `EMPTY_BODY`），惩罚态可持续**数分钟**，**建议 1~2**；`replyGapMs`
   只在同一条评论的回复有多页时生效，**不能当限速用**，限速请调 `replyLanes`。
5. **自测**：`node verify-tool.mjs` **141/141 全绿**（含本版新增 2 条：Hub(AI/MCP) 的 `export` 也支持
   `all` 且成功放 `result` / 失败保持顶层 `error+hint`、导出失败口径统一 `MISSING_VIDEO_ID` /
   `EMPTY_POOL` 且不再下载只有表头的空 CSV）；同时 `node test-hub.js` exit 0、`node test-settings.js`
   15/15、`node test-mcp-handshake.js`（含新增 `hasExportAll` 断言）全部 PASS。
6. **真机端到端验收 14/14**（2026-10-06：真 Chromium 加载扩展 + 隔离桥端口 18777 + 真 MCP stdio 调用）：
   种 2 个视频共 5 条评论 → `ai_export{all:true,format:'csv'}` 得 `scope=all, videoCount=2, count=5,
   topLevelCount=4, replyCount=1`，CSV 表头末列 `video_id`、内容按视频分 v1=3 行 / v2=2 行；
   `ai_export{videoId:'v1',format:'json'}` 得 `scope=video, count=3`（含 1 条二级回复、无 `videos` 数组）；
   `ai_export{}` 在 MCP 层直接拒（没发桥命令）、`ai_export{videoId:'no-such-video'}` 回 `EMPTY_POOL`。

**0.5.8 修复**（用户报：「为什么全部清空没有用，本地已存还是在」。真机复现后确认是**面板显示/自检的 bug**，不是数据问题）：

1. **清空以前是「发出去就当成功」**：`sendClear` 不等后台回包。扩展后台没响应时（例如扩展刚在
   `edge://extensions` 重新加载、页面上还是旧的内容脚本上下文），面板照样显示「已清空」，
   但 `chrome.storage.local` 里一条都没动。
2. **真机复现（修复前必失败）**：清空其实已经生效（存储里桶和 `dts_videos` 都没了），但清空
   **之前**发出的 `dts-stats` 旧回包晚到，把「本地已存」又写成旧数字（`2 个视频 / 7 条`），
   最长要等 20 秒周期刷新才纠正 → 用户看到的就是「没有用，本地已存还是在」。**根因是在途旧回包的竞态**。

修法（都已在代码里，本版文档照此描述）：

- `sendClear(payload, onDone)`：**等后台回包**；失败分三类 `SEND_FAILED:` / `CLEAR_REJECTED:` /
  `SEND_THREW:`（含 `EXT_CONTEXT_LOST`）。
- 新增 `verifyCleared(vid, all, cb)`：**内容脚本直接读回 `chrome.storage.local` 自检**
  （`all=true` 查所有 `dts_c_*` 与 `dts_videos`；否则只查本条视频的桶与它在 `dts_videos` 里的记录）。
  后台回包 + 读回自检**都过**才改口说「已清空」，否则 `errText` 写明「没有生效」并提示：
  打开 `edge://extensions` 点「重新加载」，回到抖音页按 F5 刷新后再试。
- `refreshLocalStats` 加请求序号 `localStatsSeq`（`var seq = ++localStatsSeq;`，
  回包时 `if (seq !== localStatsSeq) return;`）：清空时 `localStatsSeq++` 把在途的旧统计回包作废。
- 新增常量 `COMMENT_KEY_PREFIX = 'dts_c_'`。单视频「清空」与「全部清空」两条路径都走自检。
- 语义不变：「清空」只清当前页面这条视频；「全部清空」仍是两步确认（第一次点击按钮变
  「确认全部清空？」，`CLEAR_ALL_CONFIRM_MS = 5000` 内再点一次才真清），后台 `dts-clear` 仍要求
  显式 `all:true`，空 videoId 绝不兜底成全清。
- **内置扩展升到 0.2.10**（插件 0.5.8 自带的那份）。
- **自测**：`node verify-tool.mjs` 全绿（当前版本 **193/193**；0.5.8 的清空自检 5 条断言之后，0.5.9 再 +2 条导出断言 → 137，
  0.5.10 顶层固定单路再 +4 条 → 141，**0.5.11 再 +6 条**（max 语义 / 补采在循环外 / 全局限速 / 撞限流降路 / `replyGlobalGapMs` 三端下发）→ 153，
  **0.5.12 再 +11 条**（分波停顿重试 + 单波预算 + `replyThrottleMaxWaitMs` 总窗口默认 120 秒 / `0 = 内置 250ms` / 暂态红字清空 / 补采收尾交回 `collecting`）→ 164，
  **0.5.13 再 +8 条**（错峰多路发送顺序 / `MAX_LANES=3` + `LANE_STAGGER_MS=200` + `MIN_INTERVAL_MS=150` / 合并检测降路 / `anyLaneHasMore` / 面板与摘要文案 / MCP `lanes` 描述与 `VERSION=0.3.6`）→ 172，
  **0.5.14 再 +21 条**（运行日志 + 失败现场快照：新增 2f 整段——设置项/参数/schema/描述、`hints()` 拼接、`createRunLog` 边跑边写盘与 `ring()`、日志封顶 50 份、`captureFailureSnapshot` 无页面只留 `status.json`／有页面四件套齐／目录名带 videoId／自带 `run.log`、`pruneDir` 只留最新 N、render 提示、3 条源码护栏）→ **193**，
  见上方「0.5.14 新增」与「0.5.13 新增」；更早一版 130/130。0.5.8 的这 5 条是：
  `sendClear` 等后台回包、清空后读回 storage 自检、失败文案带 `edge://extensions` 重新加载 + F5 指引、
  统计请求序号作废在途旧回包、失败文案必须走 `setPhase` 的 `err` 参数（否则会被随后清成空串、
  面板既不报成功也不报失败——这条是补跑真机失败路径时踩出来的）。
- **真机验收（两条路径，都是临时脚本 + 临时 profile，跑完已删）**：
  ① 正常清空 9/9：种两个视频的桶 → 面板先显示「本地已存 2 个视频 / 7 条」→ 点「清空」只清当前
  视频、其它视频保留、面板立刻变「1 个视频 / 4 条」→ 点「全部清空」（两步确认，首次点击按钮变
  「确认全部清空？」）→ 存储里 `dts_c_*` 与 `dts_videos` 全没了，且**面板「本地已存」立刻变成
  「暂无」**（修复前同一脚本 FAIL：存储清了但面板还显示 2 个视频 / 7 条）；
  ② 失败路径 8/8：把扩展复制一份、只让 `dts-clear` 回 `{ok:true}` 却什么都不清 → 面板**不谎报
  「已清空」**，而是显示「「清空」没有生效（…）」并给出 `edge://extensions` 重新加载 + F5 指引，
  存储一条没动。
- **配套 MCP `douyin-mcp` 没动，仍是 0.3.1**。

**0.5.7 新增**：

1. **修掉「换一条视频，上一条的数据就没了」的错觉**（用户报的原始问题，也是本版主题）：
   数据从来没丢 —— 评论一直**按视频分桶**存在浏览器本地（`chrome.storage.local` 里
   `dts_c_<videoId>`，一个视频一个桶），代码里除了面板那两个清空按钮（`dts-clear`）
   **没有任何删除路径**。真实例证：用户自己 Edge 的 `Profile 1` 里 6 个桶都在
   （624 / 1406 / 2142 / 2267 / 9446 / 27 条）。旧面板只是**口径**只认「当前这条视频」：
   滑到下一条点「开始采集」后 `savedCount`/`seen` 归零、面板显示 0，看起来像被清了。
   本版**不改任何数据路径**，只补「跨视频可见性」与「导出全部视频」。
2. **面板新增一行「本地已存」**：显示 `N 个视频 / M 条（本条 X 条）`。面板构建时读一次
   （后台 `dts-stats`），之后每 20 秒刷新一次；落库后与点「清空」后也会立刻刷新。
3. **「已采（去重）」补口径**：本轮还没落库、但本地已经有这条视频的数据时，显示
   `（本地已有 N 条）`，不再让人误以为本地是空的。
4. **面板新增一行「导出范围」两个互斥小按钮**：
   - **「本条视频」**（默认，等于旧行为，只导当前这条视频的评论），自动化挂点
     `data-dts-act="export-scope-video"`；
   - **「全部视频」**（把本地**所有**视频的评论合成一份导出），挂点
     `data-dts-act="export-scope-all"`；
   选中态是 CSS 类 `dts-on`，两个按钮互斥。
5. **「全部视频」导出**（`dts-export` 带 `all: true`）：
   - CSV **在末尾追加一列 `video_id`**（共 18 列）；**前 17 列的列序与含义完全不变**，
     老读者按位置读前 17 列仍然正确；
   - JSON 顶层加 `scope: "all"` 与 `videos: [{ videoId, title, count }]`（每条评论也带 `videoId`）；
   - 文件名 `douyin-comments-all-<时间戳>.csv|json`；单视频仍是
     `douyin-comments-<videoId>-<时间戳>.csv|json`。
6. **后台 `dts-stats` 新增 `totalAll` 与 `videoCount`**：`totalAll` 是跨视频总条数，用
   `dts_videos` 里维护的 `count` 元数据累加（**不遍历每个评论桶**），`videoCount` 是本地有几个视频。
7. **点「开始采集」时面板先写一行提示**：
   `本机已存：N 个视频 / M 条（含其它视频）；本条视频本地已有 X 条`，明确告诉用户旧数据还在。
8. **「清空」的语义再强调一次**：**「清空」= 只清当前页面这条视频**
   （`data-dts-act="clear-video"`，无危险样式）；**「全部清空」= 清所有视频**
   （`data-dts-act="clear-all"`，红色危险样式、两步确认、不可恢复）。
   换视频、清空某条视频**都不会**影响别的视频。
9. **内置扩展升到 0.2.9**（插件 0.5.7 自带的那份）。
10. **自测**：`node verify-tool.mjs` 全绿 **130/130**（上一版 121，本次新增 9 条断言：
    `dts-stats` 的 `totalAll`/`videoCount`、`dts-export` 的 `all:true` 分支、CSV 末尾 `video_id` 列、
    `all` 文件名、面板「本地已存」行与两个导出范围按钮、20 秒刷新、`all: exportAll` 传参、面板 CSS、
    AI 桥 `dts-ai-export` 也支持 `all:true`）；
    真机验收（临时脚本，跑完已删）**22/22 通过**：种两个视频的桶 → 换视频/没采过的视频时
    `totalAll` 仍是 5 且 `videoCount` 是 2；单视频 CSV 仍 17 列 4 行、无 `video_id`；
    「全部视频」CSV 18 列 6 行且两个 `video_id` 都在、一级 3 二级 2；「全部视频」JSON `scope=all`、
    `videos` 2 个、5 条评论每条带 `videoId`；面板真机页面显示「本地已存 2 个视频 / 5 条」；
    点「全部视频」后按钮选中态互斥、导出落盘文件内容正确；面板「清空」只作用于当前页面这条视频、
    两个种子桶一条没少；导出是只读的。
    配套 MCP `douyin-mcp` **没动，仍是 0.3.1**。

**0.5.6 新增**：

1. **面板「清空」拆成两个按键**：原来那一个「清空」现在是 `[清空] [全部清空]`。
   - **「清空」**（无危险样式，挂点 `data-dts-act="clear-video"`）：只清**当前视频链接**这一条的
     去重桶 `dts_c_<videoId>`，并从 `dts_videos` 里摘掉这一条；别的视频数据、面板设置
     `dts_user_settings` 都不动。护栏保留：页面没识别到 videoId 时**不发清空**，提示
     「未识别到视频 ID，无法清空；请先打开具体视频页/浮层」。
     提示文案：`已清空本视频的本地去重表与扩展存储；下次「开始采集」将从头重扫`。
   - **「全部清空」**（红色危险样式 `.dts-btn-danger`，挂点 `data-dts-act="clear-all"`）：
     **两步确认**——第一次点只「上膛」：按钮变成 `确认全部清空？` 并加 `.dts-armed` 红底强调，
     提示「再点一次「全部清空」确认：会清掉所有视频的评论与本地去重表（不可恢复），5 秒内有效」，
     **数据一条不动**；5 秒内第二次点才真清（清掉所有 `dts_c_*` 与 `dts_videos`，
     保留 `dts_user_settings`），提示「已清空全部视频的评论与本地去重表（共 N 个视频）；
     下次「开始采集」将从头重扫」；超过 5 秒按钮文案自动复原成「全部清空」。
     它**不受**「未识别到视频 ID」护栏限制（在任意页面都能全清）。
2. **内置扩展升到 0.2.8**（插件 0.5.6 自带的那份）：两个按钮都有 `data-dts-act` 挂点，
   采集器用 `[data-dts-act="clear-video"]` 点「清空」（老版本扩展没有挂点时才退回按文案
   `/^清空$/` 找按钮）；后台仍然要求 `msg.all === true` 才做「全部清空」，并保留 `NO_VIDEO_ID` 护栏。
3. **修掉采集器一个致命 bug：`page.evaluate` 传了多余参数**（真机 E2E 抓到）。
   Playwright 的 `page.evaluate(fn, arg)` 只有**一个**参数位（第二参是 options），而本版新写的
   `clickPanel(re, act)` 误写成 `page.evaluate((src, a) => {...}, re.source, act)` —— 于是只要
   `clearBefore: true` 就立刻抛
   `Too many arguments. If you need to pass more than 1 argument to the function wrap them in an object.`
   （离线断言、直接点按钮的真机测试都看不出来，只有真跑一轮采集才会崩）。现已改成把参数包成
   一个对象：`page.evaluate(({ src, a }) => {...}, { src: re.source, a: act || '' })`。
4. **自测**：`node verify-tool.mjs` 全绿 **121/121**（原 113 + 新增 8 条：两个按钮与 `data` 挂点、
   「全部清空」两步确认、全清不设 videoId 限制、采集器按挂点点「清空」、后台仍要求 `all===true`
   且保留 `NO_VIDEO_ID`、CSS 有危险样式与上膛样式、`page.evaluate` 最多只传 1 个参数（静态扫描）、
   `clickPanel` 把参数包成一个对象）；真机按钮验证 **18/18 全过**
   （面板两个按钮、单视频清空只清本条、第一次点全清只上膛不动数据、5 秒过期复原、第二次点真全清、
   设置保留；测试前后真实 profile 的存储键集合完全还原，脚本跑完即删）；真机端到端采集
   （`max=20`、`clearBefore=true`、`https://www.douyin.com/video/7600000000000000010`）交付 **196 条**，
   CSV 记录数 = JSON 条数 = 196，扩展 v0.2.8。
   配套 MCP `douyin-mcp` **没动，仍是 0.3.1**。

**0.5.5 新增**：

1. **内置扩展升级到 0.2.7，并修掉「脚本缓存清错地方」**（重要）：以前只清 `Default/Code Cache` 与
   `Default/Service Worker/ScriptCache`，会留下指向已删脚本的注册库 `Default/Service Worker/Database`，
   Chrome 因此起不来扩展后台 —— 面板照样注入，但页面每次 `sendMessage` 都回
   `Could not establish connection. Receiving end does not exist.`，表现就是「点清空没反应 /
   面板谎称已清空、评论一条不落库、最后交付 0 条」。真机对照实测：只清 ScriptCache 跑 2 轮
   （1 轮正常、1 轮扩展 SW 数=0 且探活失败）；改成清掉整个 `Default/Service Worker` 后 **2/2 正常**。
   现在清 `Default/Code Cache` + 整个 `Default/Service Worker`。
2. **采集器新增「扩展后台可达性」预检 + 自愈**：面板就绪后读页面自测的 `bgOk`/`bgErr`，命中
   `Receiving end does not exist|Extension context invalidated` 就 `page.reload()` 重试（最多 2 次），
   仍不通就把这次启动标脏（`~/.dsh/douyin-collector/extension.launched.json` 的 hash 置空，
   下次强制清缓存重开）并明确报错「扩展后台没有响应……本轮采到的评论不会落库」，**不再静默交付 0 条**。
3. **内容脚本主动探活**：新增 `probeBackground()`（发 `{type:'dts-ping'}`，启动 200ms 后一次、
   之后每 30 秒一次），状态镜像与面板文案新增 `bgOk`/`bgErr`/`bgCheckedAt`；扩展上下文中断时
   面板不再谎称「已清空」。
4. **后台新增零副作用探针 `dts-ping`**：只回 `{ok:true,pong:true,at}`；用 `dts-status` 探活会给
   `updateVideoMeta` 写一条 `videoId=undefined` 的脏记录。
5. **「交付 0 条」如实归因**：页面采到 N 条但扩展存储没增加时，明确报「落库失败（扩展后台不可达）」，
   不再把锅甩给「抖音限流 / 视频没有新评论」。
6. **清空没生效会明确报错**：`clearBefore` 时点「清空」两次仍不空 → 刷新页面重试 → 仍不空则报错
   （点了 3 次仍剩 N 条），不再当成功继续。
7. **配套 MCP `douyin-mcp` 0.3.1**：① `host` 支持 IPv6（拼 `http://[::1]:18765`；以前拼成
   `http://::1:18765` 会让每个请求 500 → 永远 `NO_HUB`）；② HTTP 头块被切开时不再把头行当 NDJSON
   吃掉（丢帧）；③ 无 `id` 的请求（`initialize`/`tools/list`/`ping`/`hub/health`）不再回无 `id` 的对象；
   ④ 清掉写死的 `D:\node-v22.23.1\node.exe`（`douyin-mcp.cmd`、`restart-hub.ps1` 改为
   `%DTS_NODE_EXE%` / PATH 兜底），`force-reload-checklist.ps1` 不再写死「扩展应当是 v0.2.1」；
   ⑤ `sync-extension.mjs` 同步后反向清理白名单外的旧文件，`verify-tool.mjs` 增加
   「插件自带 `extension/` 没有多余文件」硬校验。
8. **自测**：`verify-tool.mjs` 全绿 **113/113**（原 106 + 新增 7 条：`dts-ping` 零副作用、
   内容脚本探活+镜像、采集器 bgDead/自愈/标脏、清空 3 次报错、交付 0 条归因、
   `Config` 不直接链式 `.volatile()`、`loadSchema` 先取宿主副本）；
   MCP 三个冒烟（`test-hub.js`、`test-mcp-handshake.js`、`test-settings.js`）全过。
9. **全新 profile 里也能加载**（发布验收发现）：有些 profile 里 pnpm 会给插件装一份**旧版**
   `@deepseek-ai/schemastery`（实测 3.18.2，没有 `Schema.prototype.volatile`），`Config` 直接链式
   `.volatile()` 会抛 `TypeError: ...volatile is not a function` —— dsh 只打印
   「1 entry did not activate / failed to import」，**插件装了却没有 `douyin_comments` 工具**。
   现在 `loadSchema()` 先取宿主那份 schemastery（裸说明符放最后），字段一律走 `vol()` 兜底：
   旧版没有 `.volatile()` 时插件照常加载（只是那几个字段在设置表单里不能改），不会再整个 import 失败。

**0.5.4 新增**：

1. **内置扩展升级到 0.2.6**：AI 桥新增 `get_settings` / `set_settings` 两条命令，`start_collect`
   可带 `settings`（先写 `dts_settings` 再启动，回包带 `appliedSettings` / `settingsNote`），
   `status` 回包多了 `settings` 快照。配套 MCP `douyin-mcp` **0.3.0**
   新增 `ai_get_settings` / `ai_set_settings`，`ai_start_collect` 支持 `max` / `lanes` /
   `replyLanes` / `replyGapMs` / `replyWarmupMs` / `replyThrottleMaxWaitMs`。协议见 PROTOCOL §7.9。
2. **优先级没变**：`dts_user_settings`（面板齿轮）> `dts_settings`（AI/插件下发）> 内置常量 ——
   也就是人在面板里点过「保存」的项，AI 覆盖不了（想覆盖得用 `scope:"panel"` 或先 `clear:"user"`）。
3. 离线自测 **102/102**（多了 6 项桥命令断言 + 8 项「扩展更新后不跑旧脚本」断言 + 5 项「只从扩展自己的 SW/扩展页读写 storage」断言）；扩展与插件两处副本逐字节一致。
4. **修掉「扩展更新了、浏览器还在跑旧代码」**：Chrome 会把未打包扩展的脚本缓存在 profile 的
   `Default/Code Cache` 与 `Default/Service Worker/ScriptCache` 里，只换扩展文件不换这两处，
   新开的窗口仍执行上一次的 `background.js`（实测表现：manifest 已是 0.2.6，AI 桥却回
   `UNKNOWN_COMMAND:get_settings`）。现在插件把每次启动用的扩展 hash 记进
   `~/.dsh/douyin-collector/extension.launched.json`，下次启动发现扩展变了就
   （a）清掉这两个缓存目录、（b）把「接上一次留下的窗口」也关掉重开。

**0.5.3 新增**：

1. **面板设置入口改成标题栏齿轮 `⚙`**（扩展 0.2.5）：齿轮在「—」收起按钮**左边**，
   不再占第三行按钮位置；点开浮层第一项就是 **`max` 目标条数**，另有 并发路数 / 回复并发 /
   回复间隔 / 限流等待，当前生效值显示在浮层顶部「当前：并发 N 路 · 目标 M 条/不限（面板）」。
   存键与优先级不变（仍是 `dts_user_settings` > `dts_settings` > 内置）。
2. 浮层打开时面板自动撑高（`.dts-settings-open`，`min-height: 292px`），并修掉「当前：…」
   那一行被 flex 压成一条缝的样式 bug（子项 `flex: 0 0 auto`）。

**0.5.2 新增**：

1. **扩展面板自带「设置」按钮**（0.2.4）：面板第三行 `[设置]` + 一行摘要，点开可改
   目标条数 / 并发路数 / 回复并发 / 回复间隔 / 限流等待，存进扩展的
   `chrome.storage.local.dts_user_settings`。取值优先级 **面板设置 > 插件下发（`dts_settings`）> 内置默认**；
   面板里没填的字段继续用插件值。`startLoop()` 每轮开头读一次 ⇒ 保存后下一次「开始采集」生效。
2. **默认不再清空扩展旧数据**：保留断点续采进度，结束时按 `cid` 差集只交付本轮新采的评论；
   要清空（从头采）就传 `clearBefore=true` 或改设置里的 `clearBefore`。
3. **二级回复限速可调**：设置新增 `replyLanes`（1~8）、`replyThrottleSec`（10~600，只放宽）、
   `replyNoProgressSec`（60~7200）；修掉「一级采完、二级回复一条没补上」的几处成因
   （到量判定不再在 collecting 阶段就把扩展掐停；回复阶段的「无进展收工」单独计时）。
4. **兼容 macOS**：浏览器查找支持 `~/Library/Caches/ms-playwright`、
   `/Applications/Chromium.app`、`Google Chrome for Testing.app`、Homebrew/node 全局模块目录；
   品牌版 Chrome 137+ 会忽略 `--load-extension`，这时会打警告并提示换 Chromium（`npx playwright install chromium`）。
5. 目标条数 `max` 语义澄清：**只掐一级评论**，到量后二级回复仍会补完（与扩展面板的 `maxCount` 一致）。

**0.5.0 新增**：

1. **插件设置表单**：在 DSH 的「设置 → 插件 → dsh-douyin-comments」里直接改目标条数 `max`、并发路数 `lanes`、
   总超时 `timeoutMs`、等扫码 `waitLoginSec`，**改完立即生效**（不用重启、不用重装、也不用重装插件）。
   **（0.5.10~0.5.12 `lanes` 曾停用**：扩展 0.2.12 起顶层列表固定单路；**0.5.13 / 扩展 0.2.15 起重新生效**，
   默认 3 路错峰 200ms，见上方「0.5.13 新增」。）
   实现就是标准的 cordis `Config`（schemastery），字段都标了 `volatile`——DSH 只允许表单改 volatile 字段，
   好处正是「改完 live 生效」。工具参数仍然只覆盖当次调用，不改设置。
2. **目标条数默认 300 → 80000**：300 太小（一轮就顶到），默认值与扩展单视频评论池的防御上限
   （`extension/background.js` 的 `MAX_COMMENTS_PER_VIDEO = 80000`）对齐。
3. **总超时默认 240000 → 1800000（30 分钟）**：默认要能采到几万条。
4. **并发路数 `lanes` 可调**（1~8，默认 4 = 实测甜点）：一轮同时发几路分页请求。
   以前写死在扩展里（`content.js` 的 `MAX_LANES`），现在插件在点「开始采集」前把路数写进扩展的
   `chrome.storage.local.dts_settings`，扩展每轮都现读；返回值 `lanes` 是扩展写回的**实际**路数。
   **（0.5.10~0.5.12 该设置曾停用**：扩展 0.2.12 起顶层列表固定单路、`lanes` 仅保留兼容；
   **0.5.13 / 扩展 0.2.15 起重新生效**（默认 3、每路错峰 200ms）——原因见上方「0.5.13 新增」。）
   环境变量 `DOUYIN_MAX` / `DOUYIN_LANES` / `DOUYIN_TIMEOUT_MS` 也能给出厂值兜底（设置没声明时用），
   `DOUYIN_FAIL_SNAPSHOT=0` / `DOUYIN_KEEP_SNAPSHOTS=N` 可改失败快照的出厂默认。

**0.4.1 修了什么**（0.4.0 发出去踩的两个坑）：

1. **未登录不再硬采**：以前未登录也直接开始采集（登录探测只看 DOM，实测未登录时登录按钮/弹窗常常一个都探不到），
   匿名接口采到一半就被限流、数据残缺。现在以登录 cookie 为准，没登录就停下来等你扫码（默认 180s），
   等不到返回 `phase=need-login` 并把浏览器窗口留着，扫完再调一次即可。
2. **peerDependencies 不再卡死运行时**：`@deepseek-ai/dsh-tools` 从 `^0.1.5-rc.3` 改成 `>=0.1.5-rc.3`。
   旧范围遇到 0.2.x 运行时会被 DSH 判定不兼容，**静默跳过整个 bundle** → 工具永远不出现、重启无效。

特点：

- **自带 Chrome 扩展**（抖音评论采集器 v0.2.12）。第一次调用时会自动把扩展装进它启动的浏览器，
  不需要使用者手动「加载已解压的扩展程序」；扩展面板标题栏自带设置齿轮 `⚙`（0.2.5 起，在「—」左边）。
- **只交付本次新采的数据**：结束时按 `cid` 差集剔除旧数据，只交付本轮新增的；
  一条新数据都没有就返回失败并说明原因，绝不把上一轮残留当成本轮结果。
  （**默认不再清空**扩展里的旧数据，断点续采进度得以保留；要清空就传 `clearBefore=true`。）
- **轻量**：评论在浏览器侧采集落库，模型侧只看到工具返回值 + 最多 5 条样本，不往上下文里灌原始评论。
- 有头浏览器窗口（默认就能看见，方便扫码登录/观察进度）；调用被取消时自动点「暂停」并落盘已采到的部分。
- **没登录不会硬采**：未登录就先停下来，把登录二维码留在窗口里等使用者扫码（默认最多等 180 秒，
  `waitLoginSec` 可调）；等不到就返回 `phase=need-login` 并**保持窗口打开**，扫完再调用一次即可接着采
  （第二次会接上同一个浏览器窗口，不会去抢 profile 锁）。
  判据是**登录 cookie**（`sessionid` / `sessionid_ss` / `sid_tt`）：实测未登录时抖音页面上经常连登录按钮、
  登录弹窗都探不到，只看 DOM 会漏判 → 直接裸采 → 被限流 → 数据残缺。
  （以前默认 `waitLoginSec=0` 且只看 DOM，等于没登录也照采。）明知要裸采时用 `DOUYIN_ALLOW_ANONYMOUS=1`。

## DSH Web 控制台（交互式采集）

插件除了注册 `douyin_comments` 工具，还会在 **DSH Web 界面**左侧「全局面板」加一个 **抖音采集** 入口。
点开是插件自带的控制台（iframe），不需要单独开网页：

- **新建采集**：粘贴视频链接，调目标条数 / 顶层路数 / 超时 / 等扫码秒数，勾选是否补二级回复、先清空、同时导出词云；
- **开始 / 取消**：后台作业跑在 DSH 服务端，页面每 1 秒轮询状态；取消会走采集核心的 `AbortSignal`，落盘已采部分；
- **进度 / 日志**：阶段、已采 / 落库 / total、用时、运行日志尾部；未登录或触发验证时会提示「去本机 Chromium 窗口扫码/验证」；
- **结果**：完成后显示条数、CSV / JSON / 词云 HTML 下载链接，以及运行日志和失败现场路径；
- **导出记录**：列出输出目录里的 `douyin-comments-*` / `douyin-wordcloud-*` 文件，可直接下载。

接口（同源，调试用）：

```text
GET  /plugins/dsh-douyin-comments/app/           控制台页面
GET  /plugins/dsh-douyin-comments/api/config     默认设置 / 版本 / 输出目录
POST /plugins/dsh-douyin-comments/api/jobs       开始一次采集
GET  /plugins/dsh-douyin-comments/api/jobs/:id   任务状态 / 日志 / 结果
POST /plugins/dsh-douyin-comments/api/jobs/:id/cancel
GET  /plugins/dsh-douyin-comments/api/exports    已导出的文件
GET  /plugins/dsh-douyin-comments/api/download?path=...
```

合并进主线时（0.5.62）补的四处：**输出目录**统一（工具把 `outDir` 记进 `last-out.json`，控制台「导出记录」能列到工具采的文件）、**进度条**改按页面回报的 `total` 计算（`max` 默认 80000，旧算法几乎恒为 0%）、**下载**只允许导出文件、**主题**跟随 DSH 深浅色。

限制：只支持 DSH **Web** 界面；采集仍会打开一个**本机有头 Chromium**（扫码/风控验证必须在那个窗口完成），
DSH 页面不替代它；远程 DSH 上看不到本机浏览器窗口时，需要本机运行或后续加截图流。

## 面板（采集时那个悬浮面板）

面板尺寸固定一档：**宽 310px、基础字号 14px**（0.5.19 起放大；0.1.15~0.5.18 是 236px / 11px，
2026-10-20 客户反馈「字太小、框太小」），设置浮层撑到 430px 起（6 行不滚动）；
面板标题栏右侧是设置齿轮 `⚙`（0.2.5 起，在「—」收起按钮左边）；主体自上而下：

| 行 | 内容 |
| --- | --- |
| 状态 / 进度 | 阶段、进度条、「已采（去重）」——本轮还没落库但本地已有该视频数据时显示 `（本地已有 N 条）` |
| **本地已存**（0.5.7 新增） | `N 个视频 / M 条（本条 X 条）`：跨视频的本地总规模。面板构建时读一次（后台 `dts-stats`），之后每 20 秒刷新，落库后与点「清空」后立刻刷新 |
| 按钮 1 | `[开始采集]` `[暂停]` |
| 按钮 2 | `[导出 CSV]` `[导出 JSON]` |
| **导出范围**（0.5.7 新增） | `[本条视频]`（默认，等于旧行为）/ `[全部视频]`，两个互斥；自动化挂点 `data-dts-act="export-scope-video"` / `data-dts-act="export-scope-all"`，选中态 CSS 类 `dts-on` |
| 按钮 3 | `[清空]`（挂点 `clear-video`，**只清当前这条视频**）/ `[全部清空]`（挂点 `clear-all`，**清所有视频**、两步确认、不可恢复） |

点「开始采集」时面板会先写一行 `本机已存：N 个视频 / M 条（含其它视频）；本条视频本地已有 X 条`
——换视频不会丢数据，只是旧面板的计数/导出都只认当前这条视频。

## 安装

方式一：目录安装（本机开发/自己用）

```powershell
dsh plugin --profile web add file:dsh-douyin-comments
```

方式二：tarball 安装（把包发给别人时用）

```powershell
# 对方收到 dsh-douyin-comments-0.5.12.tgz 后：
dsh plugin --profile web add file:C:\path\to\dsh-douyin-comments-0.5.12.tgz
```

装完**不用重启**。桌面端（DSH Desktop）这类由启动器提供 `profileContext` 的宿主默认启用
`@deepseek-ai/dsh-hmr`（`root: []` 表示只监听 profile 配置、不监听源码模块），安装**新**插件会即时
重新组合并挂载，插件管理器把这种结果报成 `applied`。工具名是 `douyin_comments`
（不带 `mcp__` 前缀，这是原生插件而不是 MCP server）。

唯一要重启的情况是**覆盖安装同一个包**（0.5.9 → 0.5.10 这种换版本）：Node 的模块缓存里还是旧代码，
而 HMR 默认不监听源码模块，插件管理器会报 `restart-required`（界面提示「更改将在下次启动生效」），
这时候重启 DSH 才会用上新版本。没有 `profileContext` 的宿主（headless / SDK / ACP 组合包，HMR 被禁用）
一律是重启后生效。

更新插件代码后：

```powershell
Remove-Item ~/.dsh/profiles\web\node_modules\dsh-douyin-comments -Recurse -Force
dsh plugin --profile web add file:dsh-douyin-comments
# 覆盖安装同名包：重启 DSH 才会加载新版本代码
```

（`file:` 依赖是**真实拷贝**，不删旧拷贝时 pnpm 可能认为「已是最新」而不覆盖。）

> ⚠️ **装完、也重启了，`douyin_comments` 还是不出现？** 先看 `package.json` 的 `peerDependencies`。
> DSH 启动组装 profile 时会对每个 bundle 做兼容性检查：**只要带 `@deepseek-ai/dsh-` 前缀的 peer 不满足
> 当前运行时，整个 bundle 会被静默跳过**（只在 stderr 打一行 `skipping profile bundle ...`），
> 工具永远不出现，重启多少次都一样。而 DSH 那句兼容性提示又写着「retry the installation or restart dsh」，
> 特别容易把人带沟里 —— 2026-10-05 踩过：`@deepseek-ai/dsh-tools: ^0.1.5-rc.3`（= ≥0.1.5-rc.3 <0.2.0）
> 遇上 0.2.0-rc.2 的运行时（DSH Desktop 2.0.17 自带的就是它）。所以 dsh-* 的 peer 一律写宽范围
> （`>=0.1.5-rc.3`），`node verify-tool.mjs` 里有一项专门守这个。
> 确实要放行某个不匹配的版本：`dsh plugin --profile web allow-version <name@version> --dsh-version <exact> --accept-risk`。

> 🧩 **同一台机器装多个 profile（desktop + web）没问题，但只有一个浏览器**：浏览器 profile、扩展目录、
> 输出目录、CDP 端口（`~/.dsh/douyin-collector/*` 与 9510）在同一个 DSH_HOME 下是**共享**的。
> 所以两边都装可以，登录态也是共享的（任意一边扫一次码，另一边就不用再扫）；但同一时刻只允许一个采集在跑 ——
> 工具用 `~/.dsh/douyin-collector/collector.lock` 保证这点，第二个调用会直接报
> 「已经有一个采集在跑（pid …，profile …）」，不会去抢同一个浏览器窗口。
> 注意 `isConcurrencySafe=false` 只管得住单个宿主进程，跨 profile 靠的就是这个锁。

## 前置条件

| 项 | 说明 |
| --- | --- |
| Node.js | ≥ 22.19.0（插件与扩展驱动都在 Node 侧） |
| playwright-core | **已列为插件依赖**，`dsh plugin add` 时自动装进 profile（13 MB，不含浏览器）。也支持全局已装的副本，或用 `DOUYIN_PLAYWRIGHT` 指定模块目录 |
| 浏览器 | 优先 `%LOCALAPPDATA%\ms-playwright\chromium-*`（实测 1208 / 1228 可用，1228 = Chrome 149）；没有就用系统已装的 Chrome / Edge，或用 `DOUYIN_CHROME` 指定 |
| 抖音登录态 | 持久化 profile `~/.dsh/douyin-collector/chrome-profile`。判据是登录 cookie（`sessionid`/`sid_tt`）：**没有就视为未登录，不会开始采集**，会留出二维码默认等 180 秒（`waitLoginSec` 可调）；等不到返回 `phase=need-login`，浏览器窗口保持打开供扫码 |
| 网络 | 需要能访问 douyin.com |


环境变量覆盖：`DOUYIN_EXT_DIR`（扩展源目录）、`DOUYIN_COOKIES`（可选 cookies 文件）、
`DOUYIN_PROFILE`（Chrome profile）、`DOUYIN_CHROME`（chrome.exe 绝对路径）、`DOUYIN_OUT_DIR`（输出目录）、
`DOUYIN_CDP_PORT`（默认 9510）、`DOUYIN_WAIT_LOGIN_SEC`（默认 180）、`DOUYIN_ALLOW_ANONYMOUS=1`（未登录也照采，默认关）、
`DOUYIN_MAX` / `DOUYIN_LANES` / `DOUYIN_TIMEOUT_MS`（出厂默认值兜底，设置表单里改的优先）；
`DOUYIN_FAIL_SNAPSHOT=0`（等同把 `failSnapshot` 默认关掉）、`DOUYIN_KEEP_SNAPSHOTS=<N>`（失败现场保留份数，默认 20）。

## 插件设置（DSH「设置 → 插件 → dsh-douyin-comments」）

插件导出一个 cordis `Config`，DSH 的 `@deepseek-ai/dsh-settings` 会自动把它渲染成表单；保存走
`configEditor.edit()` 写进 profile patch（`<profile>/cordis.patch.yml`），**改完立即生效**。

| 设置项 | 默认 | 说明 |
| --- | --- | --- |
| `max` | 80000 | 目标条数（**一级评论**，按去重后的一级计数）：采到这么多就**停止顶层扫描**并落盘，**已采到的线程的二级回复仍会补完**（0.5.11 + 扩展 0.2.13 起真正如此；0.5.4~0.5.10 实际会连二级回复一起丢掉） |
| `lanes` | 3 | **顶层列表路数**（1~8，0.5.13 / 扩展 0.2.15 起生效）：默认 **3 路错峰**（每路错开 200ms），1 = 单路串行。一旦扩展发现两路拿到同一页（服务端合并并发请求）会当轮降回 1，并把原因写进 `dts_settings_effective.lanesNote`（0.5.10~0.5.12 该设置曾停用：顶层固定单路） |
| `timeoutMs` | 1800000 | 单次采集总超时（30 分钟）；到点也会把已采到的评论落盘 |
| `waitLoginSec` | 180 | 未登录时等你扫码的秒数；0 = 不等，直接返回 `need-login` |
| `clearBefore` | false | 是否先清空扩展里该视频的旧数据。**默认 false**：保留断点续采进度，结束时按 `cid` 差集只交付本轮新采的 |
| `replyLanes` | 4 | 二级回复的并发线程数 1~8；**撞限流时扩展会自动降 1 路**（下限 1），限流过去后重新开始一轮补采才恢复 |
| `replyGlobalGapMs` | 0 | 回复请求**跨线程的全局最小间隔** ms（0~2000）；**0 = 用扩展内置的 250ms**（≈ ≤4 次/秒）。设了就是硬下限，撞限流时扩展会在此基础上翻倍（封顶 1000ms） |
| `replyThrottleSec` | 120 | 撞上限流窗口时本轮**总共**最多等几秒（10~600）。扩展 0.2.14 起分波重试：单波最多 12 秒，波间停 15/30/60 秒再打一波，总等待封顶在这个值；**设 10 = 老行为**（十秒不行就收尾） |
| `replyNoProgressSec` | 900 | 回复阶段连续多久没新数据就收工（60~7200） |
| `replyWarmupSec` | 10 | **0.5.18 新增**：顶层采完后、开始补二级回复前**先静默几秒**（0~600，**0 = 不预热**）。刚扫完列表就打回复接口容易被服务端成片拒（HTTP 200 + 0 字节 body），停一下能显著减少失败；v0.5.17 及以前在扩展里写死 30 秒、改不了。面板「回复预热 s」优先级更高 |
| `failSnapshot` | true | **0.5.14 新增**：失败或没采完（超时/无进展/被取消）或抛错时，自动存一份现场到 `~/.dsh/douyin-collector/failures/<时间戳>-<videoId>/`（截图 + 页面 HTML + 状态 JSON + 日志副本）。正常采完不留；工具参数 `failSnapshot` 可按次覆盖 |
| `keepSnapshots` | 20 | **0.5.14 新增**：失败现场最多保留几份（1~500），超出的按目录名（时间戳）从旧到新删 |

细节：

- 字段都是 `volatile`：`execute()` **每次调用现读一遍**（volatile 值在 cordis 里是只有 `get` 的只读引用，
  缓存快照会读到旧值），所以改完下一次调用就生效。
- 工具参数（`max`/`lanes`/`timeoutMs`/`waitLoginSec`/`clearBefore`）**只覆盖当次调用**，不会改设置。
- 表单里改的路数由插件在点「开始采集」前写进扩展：`chrome.storage.local.dts_settings = {maxCount?, lanes, replyLanes?, replyGlobalGapMs?, replyThrottleMaxWaitMs?, replyWarmupMs}`；
  扩展每轮读它（读不到或越界就退回内置值），并把实际用的值写回 `dts_settings_effective`，插件据此回报返回值里的 `lanes`。
  **注意（0.5.18 起）**：`replyWarmupMs` **总是**下发（0 = 不预热），不能用「> 0 才发」的写法，否则「显式设 0」会被当未指定。
  **注意（0.5.11 起）**：`max` 会作为 `maxCount` 下发给扩展（0.5.10 及以前**从不下发**，所以旧版 `max` 完全不封一级）。
  写下去后插件会读回 `dts_settings_effective.maxCount` 自检：**旧扩展（≤ 0.2.12）不认识这个键**，
  自检不过才退回旧行为（进入回复阶段时点「暂停」）并把原因写进日志。
  **注意（0.5.13 起）**：`lanes` **重新生效**——扩展 0.2.15 起顶层列表按 `lanes` 路**错峰 200ms** 推进
  （默认 3；`lanes=1` = 老单路），返回值里的 `lanes` 是扩展**实际**用的路数（发现两路同页会自动降成 1，
  原因在 `dts_settings_effective.lanesNote`）。旧版（扩展 0.2.12~0.2.14）固定单路、返回值恒为 1，
  写进去的路数只在 `lanesWanted` 里回显——那种行为已作废。
  **注意**：扩展面板自己的设置（0.2.4 文字按钮 → 0.2.5 标题栏齿轮 `⚙`，存 `dts_user_settings`）
  优先级更高——面板里设过的字段会盖掉插件下发值。
- 加载不到 `@deepseek-ai/schemastery` 时（例如在一个残缺的 profile 里跑）插件照常工作，只是**没有这张表单**。

## 参数

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `url` | string | — | **必填**。`https://www.douyin.com/video/<id>`、带 `modal_id` 的浮层链接，或直接给 15~25 位 aweme id |
| `max` | integer | 设置里的值（出厂 80000） | 目标条数（一级评论，按去重后的一级计数），到量**只停止顶层扫描**、已采到线程的二级回复仍补完（实际条数通常多于 max） |
| `lanes` | integer | 设置里的值（出厂 3） | **顶层列表路数**（0.5.13 / 扩展 0.2.15 起生效）：默认 3 路、每路错开 200ms；`1` = 单路串行。扩展若发现两路拿到同一页会当轮降回 1（`dts_settings_effective.lanesNote` 说明原因）。旧版 0.5.10~0.5.12 该设置停用、采集固定单路 |
| `replies` | boolean | true | 是否补采二级回复；`false` 只采一级，更快 |
| `timeoutMs` | integer | 设置里的值（出厂 1800000） | 总超时；到点也会把已采到的评论落盘 |
| `waitLoginSec` | integer | 180 | 检测到未登录时等使用者扫码的秒数；**显式传 0 = 不等**（直接返回 `need-login` 并把窗口留着） |
| `clearBefore` | boolean | 设置里的值（出厂 false） | 是否先清空扩展里该视频的旧数据；默认 false = 保留断点续采，只交付本轮新采的 |
| `outDir` | string | **当前会话工作区**/`douyin-comments` | 输出目录。默认写进调用者自己的工作区，CSV/JSON 就在他的项目目录里；取不到会话工作区（非 agent 调用）时退回 `~/.dsh/douyin-collector/out` |
| `keepOpen` | boolean | false | 调试：采完不关窗口 |
| `failSnapshot` | boolean | 设置里的值（出厂 true） | **0.5.14 新增**：本次失败/没采完时是否存现场快照；**运行日志每次调用都会写**（不受它影响） |
| `cloud` | boolean | false | **0.5.38 新增**：采完顺手导出一份**自包含词云 HTML**（词云页 + 内联数据，双击即看、可发给别人）；路径见返回值 `htmlPath`。导出失败只写日志，不影响采集结果 |

## 返回值

`ok`、`error`、`videoId`、`title`、`count`、`csvPath`、`jsonPath`、`phase`、`lanes`、`note`、
`durationSec`、`extensionVersion`、`extensionInstalled`、`sample`（前 5 条预览）、
`logPath`（0.5.14 新增：本次运行日志文件）、`snapshotDir`（0.5.14 新增：失败现场目录，正常采完是空串）、
`htmlPath`（0.5.38 新增：`cloud:true` 时导出的词云 HTML 路径，没开或导出失败是空串）。

`csvPath` / `jsonPath` 默认指向**调用方自己会话的工作区**：`<workspace>\douyin-comments\douyin-comments-<videoId>-<时间>.{csv,json}`
（会话工作区取自 `exec.agent.session.header.cwd`；取不到才退回 `~/.dsh/douyin-collector/out`）。

- `ok=false` 时 `error` 是可操作的原因（例如「本轮从头到尾没拿到页面签名（<面板说明>）」），
  此时 `csvPath`/`jsonPath` 为空串，**不会写文件**。
- `extensionInstalled=true` 表示本次把扩展重新装进了浏览器（首次调用、或扩展版本变了）。
- `logPath`（0.5.14 起）：**每次调用都会写**的运行日志（`~/.dsh/douyin-collector/logs/collect-<时间戳>-<pid>.log`），
  行首是相对时间 `[+22.9s]`，含全过程与「收工原因：done / max-cap / top-done / stall / timeout / abort」。只保留最新 50 份。
- `snapshotDir`（0.5.14 起）：**失败或没采完时**才有值（超时 / 无进展 / 被取消 / 抛错），目录里是
  `status.json`（收工原因 `endedBy`、面板 `status` 快照、日志尾部 80 行）+ `screenshot.png` + `page.html` + `run.log`；
  正常采完是空串。保留份数由设置 `keepSnapshots`（默认 20）决定。抛错时这两个路径也会拼进 `error` 文本。

## 输出格式

- **CSV**（UTF-8 BOM，Excel 直接打开）19 列：`cid,create_time,create_time_str,text,text_clean,text_len,digg_count,reply_comment_total,ip_label,is_hot,is_folded,level,stick_position,user_nickname,user_uid,is_reply,parent_cid,user_sec_uid,user_unique_id`。
  文本里保留表情贴纸（如 `[比心]`）。
  - `user_uid` 是抖音**内部数字 ID**，搜不到人、也拼不出主页；要找这个评论者用
    `user_unique_id`（账号页上的**抖音号**；v0.5.29 起为空时改填数字短号，所以不会空。要定位到人/拼主页用 `user_sec_uid`），
    主页链接 = `https://www.douyin.com/user/<user_sec_uid>`。
- **CSV 第 2 行是中文列名说明**（v0.5.27）：第 1 行仍是英文键（机器/AI 口径不变），第 2 行是同一列序的中文标签，
  首列写成 `# 评论ID`。**解析时跳过首列以 `#` 开头的行**（数据行数 = 总行数 − 2）；多条视频（20 列）说明行末列是
  `视频ID(多视频导出)`，与 `video_id` 对齐。
- **JSON**：`{exportedAt, videoId, title, totalReported, count, topLevelCount, replyCount, note, freshOnly:true, extension{version,installed}, comments:[…]}`（`comments[].user` 本来就带 `sec_uid`/`unique_id`/`short_id`，JSON 不受 v0.5.27 影响）。
- 文件名：`douyin-comments-<videoId>-<时间戳>.csv/.json`。

上面是**插件自己写盘**的那份（一次调用只导当前这一个视频，列契约与扩展 `background.js` 同源）。
浏览器面板上的「**导出范围 → 全部视频**」（扩展 v0.2.9 的 `dts-export` 带 `all: true`）另外走一条路：

| | 单视频（默认「本条视频」） | 全部视频（v0.2.9 新增） |
| --- | --- | --- |
| CSV 列 | 19 列（同上，列序冻结；v0.5.17 起末尾多用户标识列、v0.5.28 起去掉 `user_short_id`） | **20 列：末尾追加 `video_id`**；前 19 列的顺序与含义完全不变，老读者按位置读前 17 列仍然正确 |
| JSON | `{exportedAt, videoId, title, count, …comments[]}` | 顶层多 `scope: "all"` 与 `videos: [{ videoId, title, count }]`；每条评论也带 `videoId` |
| 文件名 | `douyin-comments-<videoId>-<时间戳>.csv\|json` | `douyin-comments-all-<时间戳>.csv\|json` |

## 运行日志与失败现场（0.5.14 起）

排查「采不到 / 卡住 / 条数不对」时，**先看这两样，不要再让对方复述面板文字**：

| 位置 | 何时产生 | 里面有什么 |
| --- | --- | --- |
| `~/.dsh/douyin-collector/logs/collect-<时间戳>-<pid>.log` | **每次调用都写**（返回值 `logPath`） | 全过程逐行 + 相对时间戳；末尾一定有 `收工原因：<done\|max-cap\|top-done\|stall\|timeout\|abort>`（旧版没有这一行）；只保留最新 50 份 |
| `~/.dsh/douyin-collector/failures/<时间戳>-<videoId>/` | 仅当**失败或没采完**（超时 / 无进展 / 被取消 / 抛错），返回值 `snapshotDir` | `status.json`（`reason`、`endedBy`、`pageUrl`、面板 `status` 快照含 `phase`/`unique`/`savedCount`/`total`/`note`、日志尾部 80 行）、`screenshot.png`、`page.html`、`run.log`；只保留最新 `keepSnapshots`（默认 20）份 |

- 正常采完（`phase=done` 或到量 `paused`）**不写现场**，`snapshotDir` 是空串——不会越跑越占盘。
- 采集器抛错时错误文本形如 `…（运行日志：…；失败现场：…）`，插件 render 会把它们单列成行。
- 页面在采集途中跳转/关闭（`Execution context was destroyed` / `Target closed`）会补一句人话提示，方便判断是视频被删还是需要重新登录。
  实测过一种：视频播完/feed 自动前进到 `https://www.douyin.com/?recommend=1`（`status.json` 的 `pageUrl` 能看到）。
  **这时不需要改参数，重新调一次同一个工具即可**（新一轮会先清空、从头再采一遍；不会把中断那轮当成结果返回）。
- 想临时关掉：工具参数 `failSnapshot: false`，或插件设置里关；日志不受影响，照写。

## 数据新鲜度怎么保证

1. 打开页面、等面板就绪后，先读出扩展里该视频的 `cid` 快照；
2. 点面板「清空」，复查确实空了（真空了就把快照丢掉，只靠差集）；
3. 点「开始采集」，全程盯着 `hasSig`：**本轮一次都没拿到页面签名 ⇒ 直接判失败**，
   因为那意味着扩展根本没发出评论请求，storage 里的东西只可能是上一轮残留；
4. 采集结束后把 `chrome.storage.local` 里的评论全部读出，**过滤掉快照里的 `cid`**，只留下本次新增的；
5. 过滤后为 0 条 ⇒ 判定失败（`ok:false`），不写任何文件。

因此：**每轮导出的是「本轮从评论区开头重新抓到的 max 条左右」**，不是跨轮增量。
连续两轮采同一个视频会有重叠（正常，因为每轮都从头抓），但绝不会出现「本轮什么都没抓到却返回上一轮数据」。

面板里那句「还没拿到签名：没能自动找到评论入口」是**陈旧提示**，不要拿它判成败；
司机侧只看 `phase`/`hasSig`/`unique`。

## 自测

```powershell
cd dsh-douyin-comments
node verify-tool.mjs                                     # 离线：工具定义 + 自动装扩展（不开浏览器）
$env:DTS_MAX='60'; node verify-tool.mjs --live https://www.douyin.com/video/7600000000000000011
node _test_freshness.mjs https://www.douyin.com/video/7600000000000000010 60 300   # 两轮 + 文件自洽
node _test_nosig.mjs https://www.douyin.com/video/7600000000000000010              # 负向：没签名必须失败
node _demo_autoinstall.mjs https://www.douyin.com/video/7600000000000000010        # 删掉已装扩展，验证「从零自动装上」
node _probe_pick_0520.mjs https://www.douyin.com/video/7600000000000000010        # 面板「自选视频…」浮层 + 多选/单选导出（13 项）
```

实测记录（2026-10-20，v0.5.20 + 扩展 0.5.20，导出范围支持「自选视频…」）：

| 用例 | 结果 |
| --- | --- |
| 离线自检 `node verify-tool.mjs` | **209/209 全绿**（0.5.19 为 202；新增 7 条：background 的 `videoIds`/`multi`/`fileTag`/`scopeTag`/`EMPTY_POOL scope:'selected'`、content 的自选浮层与 `exportPick`、MCP `ai_export.videoIds`） |
| 真机浮层 + 多选/单选导出（`_probe_pick_0520.mjs`，日志 `devkit/_probe-pick-0520.txt`） | **13/13 PASS**：浮层列出本地 5 个视频；勾 2 个（109 + 1365 条）→ info「已选 2 个（约 1474 条）」、按钮「自选视频（2 条）」→ 导出 `douyin-comments-selected2-<ts>.csv` **421676 B、21 列、末列 `video_id`、行数 1474 = 109+1365、视频 id 正好是勾的那两个**；改选 1 个 → `douyin-comments-7600000000000000010-<ts>.csv` **20 列**（不加 `video_id`） |
| 探针注意（踩坑记录） | 探针直接 `launchPersistentContext` 时必须先调 `clearStaleScriptCaches(profile)`：Chrome 会缓存扩展 background（MV3 SW）的编译脚本，**扩展文件变了、manifest 版本号变了，浏览器里仍跑旧 background.js**（本次排查「导出没生效」就是它，正式路径 `collectDouyinComments` 已按扩展 hash 自动清理） |

实测记录（2026-10-07，v0.5.15 + 扩展 0.5.15，**纯版本号统一**）：

| 用例 | 结果 |
| --- | --- |
| 离线自检 `node verify-tool.mjs` | **193/193 全绿**（与 0.5.14 同为 193；其中版本相关断言已改：`三件套版本统一：插件 package.json / 扩展 manifest / MCP package.json 都是 0.5.15`、`MCP VERSION = 0.5.15（与 package.json 对齐；三件套统一编号）`，两条扩展版本下限断言改成 `verAtLeast()` 语义比较，不再写死数字） |
| 版本号一致性 | `douyin-collector/manifest.json` / `dsh-douyin-comments/extension/manifest.json` / `dsh-douyin-comments/package.json` / `douyin-mcp/package.json` / `douyin-mcp/mcp.js` 的 `VERSION` **全部 0.5.15**；打包物名同步为 `dsh-douyin-comments-0.5.15.tgz`、`douyin-collector-extension-v0.5.15.zip`、`douyin-collector-mcp-v0.5.15.zip`、`dsh-douyin-comments-v0.5.15.zip` |
| **打包验收（`pkgtest` profile 装 `dsh-douyin-comments-0.5.15.tgz` 后 headless 真采）** | **PASS**（2026-10-07）：`dsh plugin --profile pkgtest add file:release\dsh-douyin-comments-v0.5.15\dsh-douyin-comments-0.5.15.tgz` → pkgtest **0.5.14 → 0.5.15**、`--dump-config` 认到 `dsh-douyin-comments`；headless 真采视频 `7600000000000000010`（`max=30`、先清空）→ **`count=214` = 一级 104 + 二级 110（19/38 个线程、50 次回复请求）**、`phase=done`、**33.4s**、顶层列表 **3 路（错峰）**、**扩展自报 `0.5.15`**（`source:'插件自带（随包分发）'`）；运行日志 `~/.dsh/douyin-collector\logs\collect-2026-10-07T06-50-34-21460.log`（末行 `[+33.4s] 收工原因：done（phase=done，页面侧 214 条）`、`[+33.4s] 顶层列表实际路数：3（本次请求 3 路；错峰多路）`）、`snapshotDir=""`（本轮采完，不留现场）；CSV/JSON `douyin-comments\douyin-comments-7600000000000000010-2026-10-07T06-51-07.{csv,json}`（CSV 219 行）。note 摘要：「一级评论已到目标 30 条（去重后 104 条）…已采 214/1971 条；二级回复已补采 110 条（19/38 个线程，请求 50 次）。服务端始终没放行回复接口（列表接口正常：它回的是 HTTP 200 + 0 字节 body）…还剩 19 个线程没拉到」 |
| 与 v0.5.14 行为对照 | 功能无差异：一级到 30 条停顶层、二级续补、`logPath`/`snapshotDir` 字段、失败现场四件套、`logPath` 每次必写、`keepSnapshots` 封顶都在；本版只把三件套版本号统一成 `0.5.15` |

实测记录（2026-10-07，v0.5.14 + 扩展 0.2.15，扩展/MCP 本版未改动）：

| 用例 | 结果 |
| --- | --- |
| 离线自检 `node verify-tool.mjs` | **193/193 全绿**（0.5.13 为 172；新增 2f 段 21 条：`failSnapshot`/`keepSnapshots` 设置与出厂值、`readSettings` 现读（`vbox(0)` → 20）、参数与输出 schema（`logPath`/`snapshotDir` 必填）、工具描述、render 成功但没采完时指出现场、`hints()` 拼接与空串、`createRunLog` 落 `<home>/logs/collect-<ISO>-<pid>.log` 且边跑边写盘（行首 `[+12.3s]`）、`ring()` 只留最后若干行、`captureFailureSnapshot` 无页面时只留 `status.json`、有页面时四件套齐、目录名带 videoId、`pruneDir` 只留最新 N 且目录不存在不炸、**日志目录封顶 `RUN_LOG_KEEP`=50 份**、3 条源码护栏） |
| 运行日志（正常采完，`7600000000000000004`，`timeoutMs=60000`、`clearBefore=true`、`replies=false`） | **PASS**：`ok=true`、`count=918`、`phase=paused`、**39.6s**、`snapshotDir=""`（采完不留现场）；日志 `~/.dsh/douyin-collector/logs/collect-2026-10-07T06-27-30-18252.log` 末行 `[+39.4s] 收工原因：top-done（phase=paused，页面侧 918 条）` |
| 失败现场（强制超时，同视频 `timeoutMs=22000`） | **PASS**：日志「收工原因：timeout（phase=collecting，页面侧 918 条）」+ `📸 失败现场已存：…/failures/2026-10-07T06-28-36-7600000000000000004（status.json、screenshot.png、page.html、run.log）`；返回 `count=918`、`phase=collecting`、`durationSec=24.3`、`snapshotDir=<该目录>`；`status.json` 摘要 `{"reason":"采集未完成：timeout","endedBy":"timeout","videoId":"7600000000000000004","statusPhase":"collecting","statusUnique":918,"runLogTailLen":19}` |
| 开关对照（同视频 `timeoutMs=22000` + `failSnapshot=false`） | **PASS**：同样「收工原因：timeout（phase=replies，页面侧 919 条）」但 `snapshotDir=""`，快照目录数不变 ⇒ 开关有效 |
| 抛错路径（无效 id `1111111111111111111`，`timeoutMs=45000`） | **PASS**：错误文案 `page.evaluate: Execution context was destroyed, most likely because of a navigation（运行日志：…\logs\collect-2026-10-07T06-29-34-31532.log；失败现场：…\failures\2026-10-07T06-29-44-1111111111111111111）`，现场四件套齐全 ⇒ `catch` 分支也有现场 |
| 现场体积（超时那轮实测） | `page.html 1208843 B` / `screenshot.png 973074 B` / `status.json 2986 B` / `run.log 1469 B`（≈2.1 MB/份；`keepSnapshots` 默认 20 份上限约 40 MB，可自行调小） |
| **打包验收（`pkgtest` profile 装 `dsh-douyin-comments-0.5.14.tgz` 后 headless 双跑）** | **PASS**（2026-10-07）：`dsh plugin --profile pkgtest add file:release\dsh-douyin-comments-v0.5.14\dsh-douyin-comments-0.5.14.tgz` → pkgtest **0.5.13 → 0.5.14**、`--dump-config` 认到 `dsh-douyin-comments`。① 正常 `max=30`（视频 `7600000000000000010`）→ **338 条 / 23s**、顶层 3 路、扩展 0.2.15、日志 `[+22.9s] 收工原因：done（phase=done，页面侧 338 条）`；② `timeoutMs=15000` → **207 条 / 15.7s**，工具文本给出「⚠️ 本轮没采完（超时/无进展/被取消），现场快照：`~/.dsh/douyin-collector\failures\2026-10-07T06-32-44-7600000000000000010`」+「运行日志：`…\logs\collect-2026-10-07T06-32-29-31532.log`」，该现场四件套 `page.html 1208843 B / run.log 1469 B / screenshot.png 973074 B / status.json 2986 B`（`status.json` 里 `phase:"replies"`、`unique:218`、`savedCount:207`、`total:1971`、note「补采二级回复 20/38 个线程，已得 114 条（请求 23 次）」） |

实测记录（2026-10-07，v0.5.13 + 扩展 0.2.15）：

| 用例 | 结果 |
| --- | --- |
| 离线自检 `node verify-tool.mjs` | **172/172 全绿**（0.5.12 为 164；3a 段整段重写：错峰多路发送顺序（`sleep(LANE_STAGGER_MS + 随机 0~60ms)` 后 `reqs.push`）、`MAX_LANES=3` / `LANE_STAGGER_MS=200` / `LANES_HARD_MAX=8` / `MIN_INTERVAL_MS=150`、合并检测降路兜底（`mergedLanes` → `laneBudget = 1` + `lanesNote`）、`anyLaneHasMore` 修正 laneEnd、面板文案与摘要；3e 段新增 MCP `lanes` 描述 / `VERSION='0.3.6'` 断言） |
| 探针一：同一签名下 `replay()` 四组对照（视频 `7600000000000000004`） | **同时发 4 个 cursor（0/50/100/150）**：Σ返回 200、**去重后仅 56 条**、0 失败请求、572ms；`c50/c100/c150` 逐条相同（首条 `7600000000000000006`），而每路 `next` 仍正确（50/100/150/200）⇒ **静默少采**。**错峰 200ms**：200/200 唯一、1023ms；**错峰 500ms**：200/200、2041ms；**串行**：200/200、1479ms |
| 探针二：扫完整个顶层列表（21 页、Σ返回 1021 条、中位往返 344ms） | 单路（每页后 `sleep(400+抖动)`）**15.79s / 唯一 907**；错峰 4 路（`next` 入队 + 每路错开 200ms）**7.72s / 唯一 912** ⇒ **2.04× 提速、数据一样多** |
| **端到端：单路基线（`lanes=1, replies=false, clearBefore=true`）** | **PASS**：`ok=true`、`count=919`（一级，`has_more=0` 扫到底）、**36.8s**、`extLanes=1`、`phase=paused`，日志「顶层列表实际路数：1（本次请求 1 路；单路）」 |
| **端到端：错峰 3 路（`lanes=3, replies=false, clearBefore=true`）** | **PASS**：`ok=true`、`count=919`（与单路**一分不少**）、**29.5s**、`extLanes=3`、`phase=paused`、`lanesNote` 空（没触发降路），日志「顶层评论采完（919 条）」「顶层列表实际路数：3（本次请求 3 路；错峰多路）」 |
| **端到端：错峰 3 路 + 二级（`lanes=3, replies=true, max=30`）** | **PASS**：`ok=true`、`count=421` = **一级 105 + 二级 316（38/38 个线程、47 次回复请求）**、**24.3s**、`phase=done`；面板：「一级评论已到目标 30 条（去重后 105 条），已停止顶层扫描；has_more=0 结束，已采 421/2062 条；二级回复已补采 316 条（38/38 个线程，请求 47 次）」 |
| 生效值核对（`dts_settings_effective`，3 路运行中 CDP 读取） | `at / from:'plugin' / lanes:3 / lanesWanted:3 / lanesNote:'' / maxCount:80000 / replyGapMs:600 / replyGlobalGapMs:250 / replyLanes:4 / replyThrottleMaxWaitMs:120000 / replyWaveBudgetMs:12000 / replyParkPlanMs:'15000/30000/60000'` ⇒ 新路数与全部新键真的下发生效 |
| 已知抖动（不是本版问题） | 同参数一轮单路只交付 **55 条**、`phase=paused`，`note`「还没拿到签名：没能自动找到评论入口…」、日志「60s 没动静（phase=paused），收工」⇒ 页面没自动打开评论区导致签名抖动，重跑即正常（该轮不算基线） |
| **打包验收（`pkgtest` profile 装 `dsh-douyin-comments-0.5.13.tgz` 后 headless 实采）** | **PASS**（2026-10-07）：`dsh plugin --profile pkgtest add file:release\dsh-douyin-comments-v0.5.13\dsh-douyin-comments-0.5.13.tgz` → pkgtest **0.5.12 → 0.5.13**、`--dump-config` 认到 `dsh-douyin-comments`（id `douyin-comments`）；headless 真采视频 `7600000000000000010`（`max=30`、先清空）→ **`count=336` = 一级 104 + 二级 232（37/37 个线程、44 次回复请求）**、`phase=done`、**20.4s**、顶层列表 **3 路**、扩展自报 **0.2.15**（`source:'插件自带（随包分发）'`）。面板原文：「一级评论已到目标 30 条（去重后 104 条），已停止顶层扫描；has_more=0 结束，已采 336/1971 条；二级回复已补采 232 条（37/37 个线程，请求 44 次）。再点「开始采集」会从断点继续」。CSV/JSON：`douyin-comments\douyin-comments-7600000000000000010-2026-10-07T05-13-18.{csv,json}` |

实测记录（2026-10-07，v0.5.12 + 扩展 0.2.14）：

| 用例 | 结果 |
| --- | --- |
| 离线自检 `node verify-tool.mjs` | **164/164 全绿**（0.5.11 为 153；本次 +11 条：分波停顿重试循环、单波预算 `REPLY_WAVE_BUDGET_MS`、`replyThrottleMaxWaitMs` 总窗口默认 120 秒、`replyGlobalGapMs = 0` 就是内置 250ms、撞拒先落盘再停顿、暂态红字清空、补采收尾把阶段交回 `collecting`、`replyWaveBudgetMs`/`replyParkPlanMs` 三端下发） |
| 真机五轮（A/B/C/D/x1，视频 `7600000000000000004`，扩展 0.2.13 作对照） | 会话内重试**从不恢复**（A 108 秒 / C 125 秒 / D 跨 8.5 分钟 4 波，全是 `EMPTY_BODY`），而新会话或十几秒后的窗口 **23/23、28/28 全成**；主世界手动重放改写后的回复 URL 始终 `HTTP 200 / status_code:0 / 58276 字节 / 366~1666ms`；五轮里 `REPLAY_TIMEOUT` **一次都没出现** ⇒ 不是本地抢跑、也不是「一波就该放弃」 |
| **真机 z1（v0.5.12 + 扩展 0.2.14，`clearBefore=true`、`max=20`）** | **PASS**：`ok=true`、`count=334` = **一级 50 + 二级 284**、`phase=done`、**25 秒跑完**（对照 y1 轮同参数：`phase=waiting-sign`、白等 120 秒、整轮 8.5 分钟）。面板文案：「一级评论已到目标 20 条（去重后 50 条），已停止顶层扫描；has_more=0 结束，已采 334/2034 条；二级回复已补采 284 条（28/28 个线程，请求 37 次）。再点「开始采集」会从断点继续」。同轮对照实验：`reply-rewritten → 200 / 58276 字节 / 436ms`（列表重放 `200 / 21717 字节 / 1256ms`） |
| 生效值核对（`dts_settings_effective`） | `at / from:'plugin' / lanes:1 / lanesWanted:1 / maxCount:20 / replyGapMs:600 / replyGlobalGapMs:250 / replyLanes:4 / replyThrottleMaxWaitMs:120000 / replyWaveBudgetMs:12000 / replyParkPlanMs:'15000/30000/60000'` ⇒ 新常量与新键真的下发到扩展 |
| **打包验收（`pkgtest` profile 装 `dsh-douyin-comments-0.5.12.tgz` 后 headless 实采）** | **PASS**：`ok=true`、`count=264` = 一级 **50** + 二级 **214**（25/25 个线程、32 次回复请求）、`phase=done`、扩展自报 **0.2.14**（`extension.dir` = profile 里的 `node_modules\dsh-douyin-comments\extension`，`source:'插件自带（随包分发）'`）；对照 v0.5.11 同命令 `count=266` = 一级 50 + 二级 216（27/27）。CSV：`douyin-comments\douyin-comments-7600000000000000010-2026-10-07T03-57-39.csv` |

实测记录（2026-10-07，v0.5.11 + 扩展 0.2.13）：

| 用例 | 结果 |
| --- | --- |
| 离线自检 `node verify-tool.mjs` | **153/153 全绿**（0.5.10 为 141；本次 +6 条：`max` 口径改用 `topSeenCount`（一级去重）、到量只停顶层扫描、二级补采挪到循环外第二阶段、回复全局限速闸门 `replyGate()`、撞限流翻倍 + 降 1 路、`replyGlobalGapMs` 三端下发） |
| **真机 `max=100` 验收**（视频 `7600000000000000004`，`clearBefore=true`，扩展 0.2.13） | **PASS**：`count=403` = **一级 103 + 二级 300**、`phase=done`、**345.4s**（单路顶层扫描 + 38 个线程回复补采、86 次回复请求）。面板文案：「一级评论已到目标 100 条（去重后 103 条），已停止顶层扫描；二级回复已补采 300 条（38/38 个线程，请求 86 次）。再点「开始采集」会从断点继续」。对照旧行为（0.5.10 + 0.2.12，同样 `max=100`）：**896 条、二级回复 0 条**、面板「已手动暂停」 |
| **打包验收（全新 profile 从 tgz 装）** | **PASS**（2026-10-07）：`dsh plugin --profile pkgtest add file:release\dsh-douyin-comments-v0.5.11\dsh-douyin-comments-0.5.11.tgz` → pkgtest 0.5.5 → **0.5.11**、`--dump-config` 认到 `dsh-douyin-comments`（id `douyin-comments`）；headless 真采视频 `7600000000000000010`（`max=30`、先清空）→ `ok=true`、`count=266` = **一级 50 + 二级 216**、`phase=done`、扩展 `0.2.13`（`source: 插件自带（随包分发）`）。面板文案：「一级评论已到目标 30 条（去重后 50 条），已停止顶层扫描；has_more=0 结束，已采 266/1970 条；二级回复已补采 216 条（27/27 个线程，请求 46 次）。再点「开始采集」会从断点继续」——回复摘要只出现一次，`；；` 重复问题在打包前已修掉 |
| 同轮冒烟（MCP 侧） | `node test-settings.js` **15/15**（参数清单已含 `replyGlobalGapMs`）、`node test-hub.js` **exit 0**（version `0.3.4`）、`node test-mcp-handshake.js` **`ALL MCP HANDSHAKE: PASS`**（`hasMaxParam=true`、`hasExportAll=true`） |
| 排障记录（两次失败都不是本版缺陷） | ① 第一次真机 run 撞签名抖动：`phase=paused`、`note=还没拿到签名：没能自动找到评论入口…`、`count=2`（重跑即正常）；② 第二次没带 `clearBefore`：顶层那批 cid 还在上一轮的桶里，被新鲜度差集剔掉，只剩 292 条新二级回复，且顶层列表侧长退避使 unique 120s 无增长 → 采集器按 `phase=collecting` 的 stall 上限收工。带 `clearBefore=true` 重跑即得上表结果 |

实测记录（2026-10-06，v0.5.9 + v0.5.10）：

| 用例 | 结果 |
| --- | --- |
| 离线自检 `node verify-tool.mjs` | **141/141 全绿**（当时 0.5.9 版为 137，上一版 135；0.5.9 新增 2 条：Hub(AI/MCP) 的 `export` 命令也支持 `all`、成功放 `result` / 失败保持顶层 `error+hint`；导出失败口径统一 `MISSING_VIDEO_ID`（提示可传 all）/ `EMPTY_POOL`，不再下载只有表头的空 CSV。0.5.10 顶层固定单路再 +4 条 → 141） |
| 真机清空验收（正常路径） | **9/9 通过**：两个视频的桶 → 「清空」只清当前视频（其它保留）→「全部清空」两步确认 → 桶与 `dts_videos` 清空，面板「本地已存」立刻「暂无」 |
| 真机清空验收（失败路径） | **8/8 通过**：扩展副本里 `dts-clear` 只回 `{ok:true}` 却不执行 → 面板不谎报「已清空」，显示「「清空」没有生效（…）」+ `edge://extensions` 重新加载 + F5 指引，存储一条没动 |
| 真机清空自检验收（临时脚本 + 临时 profile，跑完已删） | **通过**：种两个视频的桶 → 面板先显示「本地已存 2 个视频 / 7 条」→ 点「全部清空」（两步确认）→ 存储里 `dts_c_*` 与 `dts_videos` 全没了，且面板「本地已存」**立刻**变成「暂无」；修复前同一脚本 FAIL（存储清了但面板仍显示 2 个视频 / 7 条） |
| **MCP 端到端导出验收**（真 Chromium 加载 `douyin-collector` 扩展 + 隔离桥端口 18777 + 真 MCP stdio 调用） | **14/14 PASS**：`initialize` 报 `serverInfo={name:'douyin-collector-mcp', version:'0.3.2'}`、`tools/list` 里 `ai_export` 有 `all` 且 `videoId` 不再 required；`ai_export{all:true,format:'csv'}` → `scope=all, videoCount=2, count=5, topLevelCount=4, replyCount=1`（文件名 `douyin-comments-all-2026-10-06T06-17-50.csv`，785 字节，表头末列 `video_id`，内容 v1=3 行 / v2=2 行）；`ai_export{videoId:'v1',format:'json'}` → `scope=video, count=3, videoCount=1, replyCount=1`（1893 字节，无 `videos` 数组）；`ai_export{}` 在 MCP 层直接拒（没发桥命令）、`ai_export{videoId:'no-such-video'}` 回 `EMPTY_POOL` |
| 冒烟 / 回归（同一轮） | `node test-hub.js` **exit 0**；`node test-settings.js` **15/15 exit 0**；`node test-mcp-handshake.js` **`ALL MCP HANDSHAKE: PASS` exit 0**（新增 `hasExportAll` 断言为 true） |
| **顶层列表固定单路实测**（0.5.10 / 扩展 0.2.12，同一视频 `7600000000000000004`） | **768 → 945**：修复前（0.2.11 / 4 路）**768 条**（一级 586 / 二级 182）**20.1s** → 修复后（0.2.12 / 单路）**945 条**（一级 753 / 二级 192）**70.4s**——一级 **+28%**、总条数 **+23%**，代价 20s → 70s。依据：4 路并发 5 轮只 **492 条**且 **0 个失败请求**（同签名同刻多路被服务端**合并成同一页**，两两重合 50/50）；单路串行 18 步 **714~744 条**；4 路**错峰 200ms** 恢复正常；该视频列表上限约 **850 条**（`cursor=850` 只回 8 条、`has_more=0`；`cursor≥900` 回 `null`） |

实测记录（2026-10-06，v0.5.7）：

| 用例 | 结果 |
| --- | --- |
| 离线自检 `node verify-tool.mjs` | **130/130 全绿**（上一版 121，本次新增 9 条断言：`dts-stats` 的 `totalAll`/`videoCount`、`dts-export` 的 `all:true` 分支、CSV 末尾 `video_id` 列、`all` 文件名、面板「本地已存」行与两个导出范围按钮、20 秒刷新、`all: exportAll` 传参、面板 CSS、AI 桥 `dts-ai-export` 的 `all:true`） |
| 真机验收（临时脚本，跑完已删；真机 Chromium + 真抖音视频页） | **22/22 通过**：种两个视频的桶 → 断言换视频/没采过的视频时 `totalAll` 仍是 5 且 `videoCount` 是 2；单视频 CSV 仍 17 列 4 行、无 `video_id`；「全部视频」CSV 18 列 6 行且两个 `video_id` 都在、一级 3 二级 2；「全部视频」JSON `scope=all`、`videos` 2 个、5 条评论每条带 `videoId`；面板真机页面显示「本地已存 2 个视频 / 5 条」；点「全部视频」后按钮选中态互斥、导出落盘文件内容正确；面板「清空」只作用于当前页面这条视频、两个种子桶一条没少；导出是只读的 |

实测记录（2026-10-05，v0.5.5 及更早，历史版本）：

| 用例 | 结果 |
| --- | --- |
| 离线自检 `node verify-tool.mjs` | **102/102**（含：设置表单 schema/volatile/toJSON 往返、readSettings 现读、扩展读 `dts_settings`、客户端半身注册两个 slot、面板齿轮入口与 `dts_user_settings` 优先级、浮层第一项是 `目标条数 max`、浮层撑高/不被压扁的样式、`maxCount` 到量自动收工、AI 桥 `get_settings`/`set_settings` 与 `appliedSettings` 透传、扩展 hash 一变就清 `Code Cache`/`ScriptCache` 并把旧窗口关掉重开、扩展 ID 推导与「只认 chrome-extension:// 的 SW」） |
| 真采 `_verify_live.txt`（视频 7600000000000000011） | 22/22，197 条 / 10.1s，CSV 行数 = count，带 BOM |
| 设置真生效（0.5.0 新增，4 例） | `lanes=2`→回报 2；`lanes=9`→钳到 8；设置里 `lanes=3`→回报 3；设置里 `lanes=99`→钳到 8。四例 `ok=true`，日志均见「已把并发路数 N 写进扩展设置」+「扩展实际并发路数：N」 |
| 二级回复真跑通（2026-10-05） | 视频 7666035829038501129（macOS 报告里 0/243 回复的那个）：**1403 条 = 一级 623 + 二级回复 780**，246/246 个线程、247 次回复请求、37.8s，`phase=done`；CSV 里 `is_reply=1` 共 780 行 |
| 扩展面板设置真机 E2E（0.5.2 起，0.5.3 改齿轮后重跑） | 齿轮按钮（`⚙`，在「—」左边）、面板内容区不再有设置按钮行、浮层 5 项且第一项是 `目标条数 max`、「当前：…」行没被压扁、保存按钮完整可见不用滚动、保存写进 `dts_user_settings`、摘要更新、7 条到量后自动收工——**16/16 全过**（脚本跑完已删） |
| MCP 设置链路真机 E2E（0.5.4 新增，扩展 v0.2.6） | MCP `initialize` 0.3.0 + `tools/list` 10 个 tool（含 `ai_get_settings`/`ai_set_settings`）、`ai_status` 带六项设置快照与优先级、`ai_set_settings{max:5,lanes:2,replyLanes:2,replyGapMs:700}` 写进 `dts_settings`（`max`→`maxCount`）、`ai_get_settings` 读回、`ai_start_collect{max:5,lanes:3}` 回包带 `appliedSettings` 且 `dts_settings_effective={maxCount:5,lanes:3}`、`ai_set_settings{scope:"panel"}` 写 `dts_user_settings`、再 start 后 `effective.from="panel"`（`lanes=2` 覆盖插件下发）、`clear:"all"` 清掉两个键、桥配置还原——**19/19 全过**（脚本跑完已删） |
| 两轮新鲜度 `_freshness3.txt` | 15/15，两轮各自清空后重抓，CSV=JSON=count，无重复 cid |
| 负向（假装拿不到签名）`_nosig.txt` | ok=false、count=0、不写文件 |
| 吞吐 | 约 30~70 条/秒（469 条 / 13.8s；1010 条 / 14.1s；8 路 405 条 / 9.8s） |

实测记录（2026-10-06，v0.5.6，历史版本）：

| 用例 | 结果 |
| --- | --- |
| 离线自检 `node verify-tool.mjs` | **121/121**（新增 8 条：两个清空按钮与 `data-dts-act` 挂点、全清两步确认、全清不设 videoId 限制、采集器按挂点点「清空」、后台仍要求 `msg.all===true` 且保留 `NO_VIDEO_ID`、CSS 有危险样式与上膛样式、`page.evaluate` 最多只传 1 个参数、`clickPanel` 把参数包成一个对象） |
| 真机面板按钮 E2E（新脚本，跑完即删） | **18/18 全过**：面板两个按钮、单视频清空只清本条、第一次点全清只上膛不动数据、5 秒过期复原、第二次点真全清、设置保留；测试前后真实 profile 的存储键集合完全还原 |
| 真机端到端采集（`max=20`、`clearBefore=true`、`https://www.douyin.com/video/7600000000000000010`） | 交付 **196 条**、`phase=paused`（到量落盘）、扩展 v0.2.8、CSV 记录数 = JSON 条数 = 196；**这一轮才暴露出并修掉 `page.evaluate` 多传参数的崩溃** |

## 运行时验证（真 DSH agent 调用，不是模拟）

上面那些是直接调 `collector.mjs` 的验收。要验证「装进 profile 后 agent 真的能调用」，用一次性 headless profile：

```powershell
# 1) 建一个只装 headless app + 本插件的临时 profile
mkdir ~/.dsh/profiles\hdcheck
@'
{
  "name": "dsh-profile-hdcheck",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } }
}
'@ | Set-Content ~/.dsh/profiles\hdcheck\package.json -Encoding utf8
dsh plugin --profile hdcheck add file:dsh-douyin-comments

# 2) 让 agent 自己调工具（会真开浏览器采一轮）
dsh --profile hdcheck headless '用 douyin_comments 工具采集 https://www.douyin.com/video/7600000000000000010 （max=30）。工具返回后只回复三行：ok=、count=、csvPath=。'
```

实测（`_headless3.txt`）：agent 自己决定调 `douyin_comments`，拿到 `ok=true count=99`，
csvPath `~/.dsh/douyin-collector\out\douyin-comments-7600000000000000010-2026-10-05T04-08-25.csv`，
并按要求的格式回复。验证完不想留着这个 profile，直接删 `~/.dsh/profiles\hdcheck` 即可。

（注意 `dsh --profile web headless "task"` **不行**：web app 不接受位置参数，会报 `too many arguments`。
headless 是另一个 app，必须有对应的 profile。）

## 扩展同步

同步开发目录里的扩展进插件：

```powershell
node sync-extension.mjs                    # 源目录默认 douyin-collector
node sync-extension.mjs D:\path\to\ext
```

## 打包 / 发布

**正式分发走 GitHub Releases**（仓库里不放二进制包，`release/` 只在本地做打包输出）：
<https://github.com/monagisa/douyin-ai-collector/releases> —— 当前版本 [v0.5.56](https://github.com/monagisa/douyin-ai-collector/releases/tag/v0.5.53)，
附件有 `dsh-douyin-comments-v0.5.54.zip`（整目录单文件）、`dsh-douyin-comments-0.5.54.tgz`、
`douyin-collector-extension-v0.5.54.zip`、`douyin-collector-mcp-v0.5.54.zip`、`USAGE-zh-CN.md`（中文说明，zip 里叫 `使用说明.md`）、`SHA256SUMS.txt`。
**v0.5.15 起三件套同号**（插件 = 扩展 = MCP = `0.5.54`）。
更早一版 [v0.5.44](https://github.com/monagisa/douyin-ai-collector/releases/tag/v0.5.44)（等签名期间持续助推）、
[v0.5.38](https://github.com/monagisa/douyin-ai-collector/releases/tag/v0.5.38)（词云导出打通 AI/MCP）。

本地发布物在 `release\dsh-douyin-comments-v0.5.54\`：

| 文件 | 说明 |
| --- | --- |
| `dsh-douyin-comments-0.5.54.tgz` | 插件本体，14 个文件（`index.js`/`collector.mjs`/`cordis.patch.yml`/`README.md`/`package.json` + `client/client.js` + `extension/` 8 个） |
| `douyin-collector-extension-v0.5.54.zip` | 单独的扩展 zip，顶层目录 `douyin-collector/`（8 个文件），供 `chrome://extensions` 手动「加载已解压的扩展程序」（**本版扩展代码与 manifest 版本号都变了 ⇒ 必须重新打包**，不能沿用旧 zip） |
| `使用说明.md` | 给收件人看的中文说明（安装/扫码/两处设置/参数/FAQ/macOS） |
| `SHA256SUMS.txt` | 三个文件的 SHA256 |

整包单文件 `dsh-douyin-comments-v0.5.54.zip`（把上面整目录打成一个单文件，方便直接发给人）**也放在同一个 `release\dsh-douyin-comments-v0.5.54\` 目录里**（v0.5.12 起改为随版本目录存放，不再放在 `release\` 根下）。

更早的草稿目录（`release\dsh-douyin-comments-v0.5.7\` 及以前）都保留作对照，不删。

重新打包：

## 与其他组件的关系

- 浏览器里跑的扩展本体在 `douyin-collector\`（权威开发目录，0.5.15）；插件里的 `extension/`
  由 `node sync-extension.mjs` 单向同步过去（同步后会反向清理白名单外的旧文件；别再手动复制）。
  插件每次启动都会把扩展 hash 记进 `~/.dsh/douyin-collector/extension.launched.json`，一变就清掉
  profile 里的旧脚本缓存再开浏览器。**注意清的范围**：要清 `Default/Code Cache` + **整个**
  `Default/Service Worker` 目录——只清 `Default/Service Worker/ScriptCache` 会留下
  `Default/Service Worker/Database` 里指向已删脚本的注册库，Chrome 起不来扩展后台：面板照样注入，
  但页面 `sendMessage` 一直回 `Could not establish connection. Receiving end does not exist.`，
  表现是「点清空没反应、面板谎称已清空、评论一条不落库、最后交付 0 条」。真机对照实测：
  只清 ScriptCache 跑 2 轮（1 轮正常、1 轮扩展 SW 数=0 且探活失败），清掉整个
  `Default/Service Worker` 后 **2/2 正常**。手工换扩展文件后若发现浏览器还在跑旧代码
  （AI 桥回 `UNKNOWN_COMMAND`），也是同一处缓存没清干净。
- 采集结果想接着做统计/情感/检索，用分析后端 `douyin-analysis\`：
  `python -m douyin_analysis ingest`（自动扫 `~/Downloads` 与 `~/.dsh/douyin-collector/out`），
  或让 agent 直接调 MCP 工具 `mcp__douyin__ingest_paths`。
- 老的 Node 控制面 `douyin-mcp\`（Hub + 扩展轮询）仍然可用，但**与本插件不要同时开浏览器扩展通道**：
  插件的扩展是它自己 `--load-extension` 起来的独立实例，和 `douyin-mcp` 的 Hub 不是同一条链路。
