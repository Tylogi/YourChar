# Conversation Sleep Lifecycle

## 目标

长角色会话不再在较短上下文时静默、频繁压缩。系统把一次较大的上下文整理包装成角色自然的“困倦、休息、醒来”过程，同时保持工具安全、角色连续性和可调试性。

## 状态机

会话元数据在 `conversations.json` 中持久化以下状态：

- `awake`：正常对话。
- `tired`：当前模型的 canonical Provider 输入达到计划整理阈值。系统只在安全的日常交流节点提示一次困倦，不打断工具调用或现实操作。
- `sleeping`：角色自然表达困倦或用户明确同意休息后，系统在首个无副作用、无待合并消息的安全回合边界建立压缩 checkpoint，并持久化一个待投递的醒来通知。
- checkpoint 成功后，角色会在原会话中另外发出一条简短、符合角色的“我醒了”主动消息。消息持久化并记为未读后，状态回到 `awake`。
- 若用户在后台通知发出前先来了新消息，该用户回合会收到 `waking` 指令并自然恢复交流；待投递通知同时取消，不会再补发第二条醒来消息。

系统不凭空声称现实时间已经过去。真实时间仍只来自每轮最新的 runtime envelope。

## Checkpoint 后的主动醒来消息

醒来消息是会话生命周期的一部分，不是世界自主规划候选。它仅由 `conversation_sleep` 原因的成功 checkpoint 触发；`budget_planned`、紧急窗口保护和手动整理都不发送醒来消息。它也不受角色的世界主动消息开关、频率、每日上限、静默时段或 topic 反馈政策影响，不创建 `proactive_messages` 记录。

后台作业与前台用户回合使用同一个 session execution queue。若私聊 Inbox 正在合并或生成，醒来作业会等待该会话空闲，不会插入正在处理的消息中间。默认使用角色当前绑定的模型进行一次有界的后台编写，只读当前空间中的角色、持久连续性与最近对话，不暴露工具，不允许实世界变更。提示要求只通知用户角色已经醒来，不回答旧请求，不暴露 token、压缩或 checkpoint，也不根据 checkpoint 猜测已经过了几分钟、几小时或一晚。

该消息只投递到触发 checkpoint 的原始 YourChar 站内会话和未读列表：普通会话仍在 normal 空间，持久私密会话仍在同一角色的 secret 分区。它不通过桌面通知 sink、提醒 outbox、微信或飞书 IM 发送；即使该角色已绑定外部 IM，也只能在 YourChar 内看到这条醒来消息。

## Token 与压缩策略

疲倦与整理统一使用实际发送给当前模型的 canonical Provider 输入预算。Provider 返回 usage 时优先使用包含缓存读写的实测输入；没有实测值时才使用与 Provider 请求形态一致的本地估算。持久 transcript 中已被 Provider 裁剪的历史工具输出不再单独触发困倦。

默认阈值按模型窗口动态计算：

- 计划整理：`min(128 Ki token, 可用输入上限的 90%)`；
- UI warning：约为计划整理阈值的 85%；
- 紧急保护：可用输入上限的 95%，预计下一请求越过该阈值时在调用模型前整理；
- 可用输入上限已经扣除最大输出和 8% 安全保留（安全保留限制在 2,048 至 16,384 token）；
- 最多 4,096 Pi 估算 token：保留近期窗口；小窗口模型按约 10% 缩小，但不少于 1,024。Pi 使用 chars/4 估算，针对中文约对应更大的实际字符区间。

因此，未配置窗口时采用 131,072 的默认假设，计划整理点约为 105k 输入；配置为 262,144 的模型约在 128 Ki 输入时整理，并保留约 128 Ki 的总窗口余量。测试运行时仍可注入较小的绝对阈值，但生产不再使用固定 32k/60k 门槛。

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

完成副作用的轮次不会立即触发休息压缩。系统会持久记录待整理状态，在下一个无副作用、无待合并消息的安全边界自动执行；已经说过困倦的角色不会因此逐轮重复提醒。若休息压缩失败，正常角色回复仍保持 `completed`，会话留在 `tired`，并记录失败 action，下一轮按原原因重试。

成功的休息 checkpoint 会为当前代次创建一个稳定的醒来通知 ID，并把待投递状态与失败次数写入会话元数据。服务重启后会恢复未完成作业。每条可见 assistant 消息后面都有一条携带同一 ID 的隐藏 `rp-agent/conversation_wake` marker；若进程在消息落盘后、元数据确认前中断，恢复流程只根据 marker 补做确认，不重复显示消息或增加第二次未读。

可注入编写器的短暂失败会保留同一待投递 ID 并进行有界延迟重试，达到上限后改用确定性文本。默认模型未配置、超时、返回空内容或暴露内部机制时，则直接使用一条有界的确定性“我醒了”文本完成站内投递。会话被归档、所有者或空间与作业不再匹配，或用户回合已经自然唤醒角色时，待投递作业会取消。

`GET /api/v1/sessions` 返回 `sleepState` 和 `sleepCheckpointAt`。会话列表对 `tired` 显示“有些困了”，对 `sleeping` 显示“休息中”和 moon 图标。状态转换记录：

- `conversation_sleep_checkpoint`
- `conversation_wake`
- `conversation_wake_notification`

压缩本身继续通过 Pi 的 `compaction_start`、`compaction_end` 和 context economics 中的 `context_compacted` 观察。

## M12 模型预算与主动整理

生产实现按当前角色绑定的模型配置计算有效预算：模型上下文窗口减去最大输出预留、8% 安全余量（2,048 至 16,384）和当前 canonical Provider 输入，得到可展示的上下文余量。Provider 实测输入必须包含互斥的未缓存输入、缓存读取和缓存写入（`input + cacheRead + cacheWrite`），不能把计费增量单独当作上下文总量。未配置窗口时明确使用 131,072 的默认假设。

- 聊天页在窄屏显示剩余百分比、宽屏显示 token 余量与百分比，点击后查看构成并可手动整理。
- 有 provider usage 时标记为实测，否则明确标记为估算，不能把纯会话历史量冒充完整上下文使用量。
- canonical input 达到 `min(128 Ki token, 可用输入的 90%)` 时，在无流式输出、无工具副作用、无待合并私聊消息的安全回合边界计划压缩；warning 与 critical 分别依据计划阈值和真实窗口压力计算。
- 预计下一请求达到 critical 区间时，在调用模型前执行紧急压缩；整理后固定提示词和工具仍接近窗口则拒绝请求并提示调整配置。
- 主动压缩前先结算记忆、画像观察、承诺与场景状态；压缩失败时保留原分支和已经完成的回复。
- 使用滞回和最小增长间隔避免在阈值附近反复压缩；大窗口模型最多保留约 128 Ki canonical 输入后计划整理，小窗口模型按自身安全预算更早触发。

接口：

- `GET /api/v1/sessions/{id}/context-budget`
- `POST /api/v1/sessions/{id}/compact`

手动与自动整理都拒绝流式生成或仍有私聊 Inbox 消息的会话。只有真正需要 checkpoint 的轮次才等待 Memory Coordinator 和 Post-turn Coordinator drain；普通轮次继续后台异步处理。
