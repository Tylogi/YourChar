# Conversation Sleep Lifecycle

## 目标

长角色会话不再在较短上下文时静默、频繁压缩。系统把一次较大的上下文整理包装成角色自然的“困倦、休息、醒来”过程，同时保持工具安全、角色连续性和可调试性。

## 状态机

会话元数据在 `conversations.json` 中持久化以下状态：

- `awake`：正常对话。
- `tired`：可见对话历史估算超过 32k token。系统只在安全的日常交流节点提示一次困倦，不打断工具调用或现实操作。
- `sleeping`：用户明确同意休息或道晚安后，角色先用完整上下文回复，随后建立压缩 checkpoint。
- 下一条用户消息在最新的 volatile turn context 中收到 `waking` 指令；角色自然恢复交流，成功回复后回到 `awake`。

系统不凭空声称现实时间已经过去。真实时间仍只来自每轮最新的 runtime envelope。

## Token 与压缩策略

疲倦阈值只计算会话历史：用户可见文本、角色可见回复、必要工具结果和已有压缩摘要。以下内容不计入疲倦阈值：

- stable system prompt、SOUL、用户画像和工具 schema；
- 每轮 volatile turn context；
- assistant 私有 thinking；
- UI/运行状态事件。

默认阈值：

- 32k：进入 `tired`；
- 60k：在没有副作用的完整回复后强制休息，避免无限拖延；
- 约 98k：在默认 131k 窗口下的 Pi 自动压缩硬兜底；实际保留量按模型窗口和最大输出动态计算；
- 最多 4,096 Pi 估算 token：保留近期窗口；小窗口模型按约 10% 缩小，但不少于 1,024。Pi 使用 chars/4 估算，针对中文约对应更大的实际字符区间。

32k 和 60k 是软生命周期阈值，测试运行时可注入更小阈值；生产默认值不由模型提示词控制。

## KV-cache 与上下文放置

SOUL、固定系统规则和权限保持在稳定 system prefix。`tired`、`sleep_transition`、`waking` 只进入当前轮的 volatile `RP_AGENT_TURN_CONTEXT`，旧 volatile snapshot 会在 provider hook 中移除，因此不会逐轮累积。

Pi 的 compaction summary 会作为 system 之后的第一条 conversation `user` 消息发送。一次压缩会使摘要之后的会话 KV prefix 失效，这是不可避免的；模型相对阈值、滞回和最小增长量共同限制重写频率。

checkpoint 是确定性的非可信历史数据，只保留最近最多 18 条用户/角色可见文本。它不包含 thinking、工具结果、运行事件，也不复制 SOUL、画像或长期记忆。当前 SOUL、已确认记忆、关系状态和场景始终优先。

## 历史清理与失败恢复

provider context 发送前执行以下清理，但不改写会话文件和 Debug trace：

- 删除历史 assistant thinking block；
- 删除 `rp-agent/system_event`；
- 删除无有效内容的 failed/aborted assistant message；
- 对旧版本产生的“同一句用户消息 -> 可重试失败 -> 同一句用户消息”链，只保留后一次用户消息。

手动重试会先 branch 到失败用户消息之前，再重新发送一次原消息。失败草稿、失败事件和重复用户消息不会留在新的 active branch。

MLX 交互模型缺少 thinking 时最多再生成两次。达到上限后保留最后一份可见且通过输出安全检查的回复，不再用“未生成有效私有思考”让整轮失败。thinking 仍保存在会话与 trace 供 Debug 查看，但不会重复占用后续模型上下文。

## 安全与可观察性

完成副作用的轮次不会触发休息压缩。若休息压缩失败，正常角色回复仍保持 `completed`，会话留在 `tired`，并记录失败 action，下一轮可重试。

`GET /api/v1/sessions` 返回 `sleepState` 和 `sleepCheckpointAt`。会话列表对 `tired` 显示“有些困了”，对 `sleeping` 显示“休息中”和 moon 图标。状态转换记录：

- `conversation_sleep_checkpoint`
- `conversation_wake`

压缩本身继续通过 Pi 的 `compaction_start`、`compaction_end` 和 context economics 中的 `context_compacted` 观察。

## M12 模型预算与主动整理

生产实现按当前角色绑定的模型配置计算有效预算：模型上下文窗口减去最大输出预留、8% 安全余量（2,048 至 16,384）和当前 canonical provider input，得到可展示的上下文余量。未配置窗口时明确使用 131,072 的默认假设。

- 聊天页在窄屏显示剩余百分比、宽屏显示 token 余量与百分比，点击后查看构成并可手动整理。
- 有 provider usage 时标记为实测，否则明确标记为估算，不能把纯会话历史量冒充完整上下文使用量。
- canonical input 达到可用输入的 80% 时，在无流式输出、无工具副作用、无待合并私聊消息的安全回合边界计划压缩；75% 和 90% 分别作为 UI warning/critical 分级。
- 预计下一请求达到 critical 区间时，在调用模型前执行紧急压缩；整理后固定提示词和工具仍接近窗口则拒绝请求并提示调整配置。
- 主动压缩前先结算记忆、画像观察、承诺与场景状态；压缩失败时保留原分支和已经完成的回复。
- 使用滞回和最小增长间隔避免在阈值附近反复压缩；32k/60k 继续作为大上下文模型的体验上限，小窗口模型会更早触发。

接口：

- `GET /api/v1/sessions/{id}/context-budget`
- `POST /api/v1/sessions/{id}/compact`

手动与自动整理都拒绝流式生成或仍有私聊 Inbox 消息的会话。只有真正需要 checkpoint 的轮次才等待 Memory Coordinator 和 Post-turn Coordinator drain；普通轮次继续后台异步处理。
