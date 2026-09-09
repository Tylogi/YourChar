# 微信与飞书 IM 通道

YourChar 可以把本人的微信 AI 助手单聊和飞书 / Lark Personal Agent 单聊接入
一个指定角色。两个平台分别选择角色，扫码账号也分别保存。当前实现面向单机、单主人，
不是多人机器人托管服务。

## 使用方法

1. 打开 **设置 → IM 通道**。
2. 在微信或飞书卡片的“对话角色”中选择角色，旁边会显示该角色的头像。角色路由只影响
   之后收到的新消息；切换角色不会搬迁、合并或重写旧角色的历史。
3. 飞书用户先选择飞书中国大陆或 Lark 国际版，然后点击“扫码绑定”。微信直接点击
   “扫码绑定”。
4. 使用本人手机扫码并按平台提示确认。微信在部分绑定流程中还会要求提交手机端显示的
   一次性配对码。
5. 解绑会停止平台收发，并清除该平台保存在本机的连接凭据；之后需要重新扫码。

微信的“正在输入”开关只影响之后进入的新微信消息。关闭它不会禁用消息回复，也不会
影响飞书。

微信和飞书卡片各有“接收日程提醒”开关，默认开启。新建提醒默认同时进入站内通知和
已开启、已绑定的 IM 通道，普通提醒和重要提醒遵循同一规则，角色不能自行关闭通道。
绑定后需由本人先发送一条私聊以确认投递目标；未绑定的通道不会凭空产生发送目标。
关闭开关会停止该通道尚未发出的提醒，不影响聊天、站内或另一通道；重新开启不会补发
已停止或已触发的旧提醒，已在途的平台发送无法撤回。

日程编辑器可为单个提醒选择“跟随 IM 设置”或“为本提醒单独选择”（例如仅站内），
单独选择仍受 IM 总开关约束。旧日程保留原渠道，可在编辑器主动改为跟随设置。
世界主动消息和普通 Web 聊天不会因此自动广播到 IM。详见 [提醒投递](reminder-delivery.md)。

页面与其他设置共用灰阶配色、系统字体及明暗主题。连接状态以文字和小圆点区分，
“仅本人私聊 · 私密模式不互通”可展开查看完整隐私说明；扫码区域在夜间模式下仍保持
白底，便于手机识别。手机端通道卡片按单列排列，通知开关支持键盘操作。

## 隔离和产品边界

IM 是固定的 **普通模式 transport**：

- 平台事件不能选择 `conversationSpace`、session ID 或 Workspace 路径；
- IM 永远不会打开、读取或写入私密对话、私密记忆、私密 Workspace 或 private-only
  Agent Skill；
- 只接受扫码得到的本人稳定身份发来的 direct message，群聊和其他发送者会被拒绝；
- 每个平台只路由到一个角色的 canonical normal SMS 会话；
- 微信与飞书分别保存角色路由。一个平台触发的回复只返回原平台，不会广播到另一个
  平台，也不会把本地 Web 回复自动同步出去。

因此，外部消息会与所选角色的本地普通历史、普通记忆和普通 Workspace 连续。平台服务
本身也会保存或处理已经传输的内容。需要不向平台传输的内容应留在 YourChar 私密模式。
如果需要多人或群聊，必须先增加按外部用户/会话隔离的 session、memory 和 Workspace，
不能复用当前单主人绑定。

## 连接器和可靠性

默认 Channel Runtime 与 YourChar 同进程运行：

- 飞书通过官方 `@larksuiteoapi/node-sdk` 创建 Personal Agent，并使用官方长连接；
- 微信通过腾讯微信 AI 助手连接器完成扫码、长轮询和消息收发；
- 平台事件先进入本地 durable spool，再进入 Core；模型回复进入 SQLite outbox，网络重试
  不会重新运行模型或重复追加 transcript；
- event ID 和 payload digest 共同去重。同一 ID 携带不同内容会作为冲突拒绝；
- 绑定 generation、connection、owner 和角色路由在处理时共同校验，旧授权不能向新绑定
  投递。

默认连接方式不需要把 YourChar 的 HTTP 服务暴露到公网。主服务没有通用 HTTP 登录认证，
仍必须只监听 loopback；不要把 `/api/*` 整体反向代理到公网。

当前正式支持的是同进程的 bundled/local Channel Runtime。`external` runtime 只保留给同机、
loopback 上的实验性适配器，不属于受支持的远程部署拓扑；不要为它开放或反向代理 YourChar
的主 HTTP API。若未来需要远程 Gateway，应另行提供仅暴露窄 ingress/outbox 端点的 TLS/mTLS
边界，并验证解绑时的 ingress、generation 与在途发送栅栏。

## 图片和文件

连接器只根据已验证平台事件中的媒体 ID 下载附件，不会自动抓取正文 URL。入站附件写入
普通 Workspace 的 `uploads/im/<provider>/`，使用不可预测文件名、`0600` 权限、大小/
数量限制、内容类型与哈希校验。平台下载凭据和临时 URL 不会作为附件元数据保存。

这些文件属于普通 Workspace：普通模式 Agent 可能读取它们，运维备份也会包含它们；
它们绝不会写入 `workspace-secret`。来自平台的文档、图片文字和链接始终是不可信输入，
不能修改系统策略或取得管理权限。

## 本机状态、密钥与导出

Channel Runtime 在状态目录下使用：

```text
<YOURCHAR_STATE_DIR>/im-runtime/credentials.json
<YOURCHAR_STATE_DIR>/im-runtime/spool.json
```

`<YOURCHAR_STATE_DIR>` defaults to `.yourchar`. The legacy
`RP_AGENT_STATE_DIR` alias is used only when `YOURCHAR_STATE_DIR` is unset.

目录权限为 `0700`，文件以原子方式写入并设为 `0600`。`credentials.json` 可能包含飞书
App Secret、微信 channel token 和刷新凭据；`spool.json` 可能包含尚未提交的消息正文与
投递回执。设置 API 只返回连接状态和经过限制的显示名称，不返回 account ID、owner ID、
token 或 secret。普通/私密 JSON 数据导出也不包含原始连接凭据。

`0600` 不是静态加密：能够读取运行 YourChar 的 OS 账号或状态目录的进程仍能读取凭据。
运维备份会复制完整 `im-runtime`，并在 manifest 中以
`containsImCredentials`/`credentials.imRuntimeCredentialsPresent` 标记凭据文件是否存在；
备份必须加密或保存在受保护位置。

## 本地管理 API

设置页使用以下 loopback API：

```text
GET    /api/v1/im/channels
PATCH  /api/v1/im/channels/{feishu|wechat}
GET    /api/v1/im/settings
PATCH  /api/v1/im/settings
POST   /api/v1/im/bindings/{feishu|wechat}/qr
GET    /api/v1/im/binding-sessions/{sessionId}
POST   /api/v1/im/binding-sessions/{sessionId}/verify
POST   /api/v1/im/binding-sessions/{sessionId}/cancel
DELETE /api/v1/im/bindings/{feishu|wechat}
```

角色路由 PATCH body 为 `{ "characterId": "..." }`；传 `null` 会停止该通道接收新消息。
所有 POST/PATCH/DELETE 都受本地 control-plane 的精确 Host、same-origin、JSON Content-Type
和 HttpOnly capability cookie 保护。通过 Lazycat 使用时，只信任其已登录 ingress 注入的
固定 HTTPS/ingress/user headers；这不是通用反向代理支持，不能把 `/api/*` 暴露到未认证代理。
二维码状态 GET 不返回平台密钥。
