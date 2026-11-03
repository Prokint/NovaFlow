---
kind: upgrade-guide
description: NovaFlow 桌面模型接入需要登录账号，不再使用手动配置的 API Key。
---

# NovaFlow 仅通过账号接入模型

[English](guide.md) | 中文

## 变更

NovaFlow 桌面端不再启用手动模型提供方及其 API Key 设置页和菜单入口。此变更影响此前选择 `NovaFlow API` 提供方的桌面用户。模型接入改由登录的 NovaFlow 账号提供。独立 DSH CLI 保持不变。

## 迁移

1. 打开 NovaFlow 账号页，登录所选服务器。
2. 刷新分组与模型，在对话中选择账号授权的模型。已保存的手动默认选择会迁移到可用账号路线，或在模型加载前显示未选择占位。
3. 确认模型菜单列出账号模型，设置不再提供手动提供方编辑器。桌面 profile 不使用已有手动凭据，会话记录保留。
