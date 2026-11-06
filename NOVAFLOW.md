# NovaFlow 开发与维护

本仓库名为 **NovaFlow**，产品名称为 **NovaFlow**，基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 及继承的桌面分支开发。原 Git 历史、MIT 许可证和第三方声明均保留；Logo 使用已选定的黑灰交扣图形。

## 当前定制

应用名称、原生菜单、账号页、首页、提示文案、内部模块与打包程序统一为 NovaFlow。桌面、侧栏、首页、浏览器与安装器图标从 `design/brand/novaflow-symbol-transparent.png` 生成；可运行 `node customizations/novaflow/prepare-logo.mjs` 后重新执行桌面文档中的 Linux 和托盘渲染命令。新安装默认使用 `~/.novaflow` 与 Electron 的 `novaflow` 用户数据目录；已有安装继续读取原目录与设置文件，不搬移、改写或清除账号和会话。旧会话的模型路由通过兼容层调用，新选择保存为 NovaFlow 路由。原 DeepSeek Harness 的 `~/.dsh` 和系统中的 `dsh` 命令不需要修改。与旧版共用数据时，切换前先退出另一份应用。

源码的更新检查和打包更新配置指向自建更新源 `https://updates.lanjiaotrade.com/`（静态 HTTPS 目录，发布工作流通过受限 rsync 账号上传）。GitHub Releases 继续作为源码与安装包归档，但应用不再从 GitHub 检查更新。发布工作流、更新解析器与安装器统一使用 `v*` 标签和 `novaflow-*` 文件名，应用标识为 `com.novaflow.desktop`。

## 开发

需要 Node.js `^22.19.0` 或 `>=24`、pnpm（版本见 `package.json`），macOS 原生构建还需要兼容的 Xcode Command Line Tools。

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run dev:desktop
```

`dev:desktop` 会准备开发运行时并启动独立开发实例。已有构建时可以运行 `pnpm run start:desktop`。首次运行时按桌面开发指南准备运行时依赖，完整说明见 [桌面应用文档](apps/desktop/README.zh.md) 和 [开发指南](docs/development.zh.md)。

本机 Command Line Tools 默认 SDK 与链接器不兼容时，可仅对本次命令指定已安装的兼容 SDK，不修改系统设置：

```sh
SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk pnpm run build
```

## 代码入口

| 路径 | 用途 |
|---|---|
| `apps/desktop/src` | 桌面窗口、菜单、账号和更新 |
| `apps/desktop/src/novaflow` | 服务器地址、授权、模型目录、请求代理 |
| `apps/desktop-host/src/novaflow.ts` | 模型协议适配 |
| `apps/desktop/scripts/electron-builder-config.mjs` | 应用名称与打包配置 |
| `packages/client/ui-brand-official` | 首页与账号入口品牌界面 |
| `packages/llm/llm-pi-ai` | 自定义模型提供方能力 |
| `customizations/novaflow/rebrand-installed.py` | 最初本地安装包品牌修改的可复现工具 |

## 自有中转站

账号页面支持切换 `/api/user/self/groups` 返回的具体可用分组，显示各组倍率与说明；切换后重读模型目录。选择保存在账号的加密会话记录中，刷新和重启后恢复，不修改服务器上的账号所属组。主进程在 `/pg/chat/completions` 请求中加入选中的 `group`，仍拒绝调用方传入路由覆盖。站点登录模式不提供自定义 Auto 顺序或跨组重试。

默认服务为 `https://api.lanjiaotrade.com`。点击“登录 NovaFlow → 登录并使用模型”，在隔离的登录窗口完成站点原有的账号验证后，应用自动加载该账号当前分组可用的模型；尚未选过模型时自动选择第一个可用模型。账号模式复用站点的登录会话和 `/pg/chat/completions`，无需创建、复制或填写 API Key。当前账号模式支持 Chat Completions 的流式对话和工具调用。

登录窗口直接使用站点的登录页面，保留站点自己的密码加密和多因素验证流程。主进程仅接收第一方 HttpOnly 刷新 Cookie，使用系统加密存储保存在独立的 `new-api-account` 目录；不保存密码、短期访问 Token 或管理 API Key。重启时自动恢复会话，退出登录时撤销本次站点会话。旧桌面授权目录保持独立，旧协议实现仍保留在源码中。模型目录和账户余额只向应用界面公开必要信息，模型请求通过受限的本地代理进入站点。

桌面端仅通过 NovaFlow 账号接入模型，不提供手动 API Key、自定义提供方或“设置 → 模型”入口。旧的手动提供方配置不再启用；升级后从账号模型目录重新选择模型。DeepSeek 账号和遥测继续关闭，现有 DSH 应用与系统 `dsh` 命令不变。

中转站必须有可用上游渠道和账户额度。账号模式只展示站点明确声明支持 Chat Completions 且该账号分组允许的模型；缺少容量元数据时使用可调整的保守默认值（上下文 65536、输出 8192），已知模型优先使用适配器目录中的容量。账号模式不显示不存在的设备独立额度。

## Git 与发布

`origin` 指向本仓库；已有的 `upstream` 保留继承来源。同步上游时先在独立分支合并、检查品牌改动并运行相关验证。正式发布使用本仓库的 NovaFlow 工作流；GitHub Actions 的签名证书和发布密钥需要在本仓库配置，未从上游复制。

```sh
git fetch upstream --tags
git switch -c codex/sync-upstream
```

不提交 `.env`、密钥、账号数据、`node_modules`、本地应用包或构建缓存。版权与依赖声明见 [LICENSE](LICENSE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
