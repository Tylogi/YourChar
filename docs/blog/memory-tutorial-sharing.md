# 记忆系统教程：分享文案与发布说明

这份文档供维护者发布教程时使用。正文与实现保留在 YourChar 主仓库；
社区帖子负责介绍问题并引导阅读，不另建只有文章副本的仓库。

**发布状态：这些是待发布文案，不代表已经在任何外部平台发布。**
下方 `main` 原文链接应在相关改动合并并推送到 GitHub 后使用。
审核分支上的内容时，请先阅读[中文版](building-reliable-agent-memory.md)或
[英文版](building-reliable-agent-memory.en.md)。

## 原文与项目入口

合并发布后，分享时优先指向对应语言的文章；项目链接作为第二入口。
当前使用 GitHub 的文章页面独立阅读，不依赖另一个文档站。

- 中文原文：<https://github.com/Tylogi/YourChar/blob/main/docs/blog/building-reliable-agent-memory.md>
- English article: <https://github.com/Tylogi/YourChar/blob/main/docs/blog/building-reliable-agent-memory.en.md>
- 项目与安装：<https://github.com/Tylogi/YourChar>
- 实验直达：在对应文章地址后添加 `#hands-on-lab`。

署名统一使用 **Tylogi AI Lab**。中文标题为「如何构建可靠的 Agent 记忆系统」，
英文标题为「Building a reliable agent memory system」，副标题说明是 YourChar 的工程实践。
让读者先看到自己要解决的问题，再认识实现这些设计的项目。

## 中文社区长帖

**标题：如何构建可靠的 Agent 记忆系统：从原话证据到崩溃恢复**

让 AI 记住「我不吃香菜」很容易演示。真正麻烦的是下一步：用户改口后，
旧记忆还会不会进入模型上下文？角色扮演里的设定会不会混进现实画像？
后台任务重试或一次多文件写入被中断后，数据还能不能对得上？

我们在开源项目 YourChar 中实现了一套长期记忆的数据路径，把其中的设计写成了教程：

- 从用户原话核对证据，让模型候选与程序确认分开。
- 明确记忆的范围和生命周期，处理纠错、遗忘以及上下文中的旧版本。
- 用 Markdown 保存权威记忆，用 SQLite / FTS 构建查询投影。
- 用操作日志、快照校验和写入者租约处理崩溃与并发写入。
- 用可解释的检索分数和 token 预算决定这轮应当注入什么。

文章附有无需模型 API Key 的本地实验：在独立会话里检查实际发给模型的请求，
验证召回、纠错和遗忘。实验使用脚本模型，验证工程行为，不替代真实模型的提取效果评测。

也把边界写清楚了：当前自动召回是词法检索，候选池有上限；记忆遗忘是软删除，
不等于清除原始聊天、备份或模型服务商已收到的数据。

如果你正在做个人助手或长期运行的 Agent，希望这些设计和失败案例能提供参考。
欢迎带着可以复现的问题来讨论。

原文：[如何构建可靠的 Agent 记忆系统](https://github.com/Tylogi/YourChar/blob/main/docs/blog/building-reliable-agent-memory.md)

实现与安装：[YourChar](https://github.com/Tylogi/YourChar) · Tylogi AI Lab

## 中文简短分享

写了一篇 Agent 记忆系统的工程教程：从原话证据、纠错与遗忘，讲到旧上下文失效和崩溃恢复。
基于 YourChar 的实际实现，附无需模型 API Key 的本地验证实验，也说明了软删除和词法召回的边界。

[阅读全文](https://github.com/Tylogi/YourChar/blob/main/docs/blog/building-reliable-agent-memory.md) · [开源实现](https://github.com/Tylogi/YourChar)

## English community post

**Title: Building reliable agent memory: evidence, correction, and crash recovery**

Remembering “I don't eat cilantro” makes a useful demo. What happens when the
user changes their mind, asks the agent to forget, or a write stops halfway through?

We wrote a hands-on tutorial based on the memory implementation in YourChar,
our open-source AI character app. The design patterns also apply to personal
assistants and long-running agents. It covers:

- Checking source quotes and separating model proposals from confirmation.
- Scoping memories and removing stale injected versions after correction or forgetting.
- Using Markdown as authoritative memory, with SQLite / FTS query projections.
- Recovering interrupted writes with a journal, verified snapshots, and writer leases.
- Selecting context with explainable retrieval scores and token budgets.

The local lab needs no model API key. It uses a scripted model and inspects
outgoing requests to test cross-session recall, correction, and forgetting.
That verifies application behavior, not real-model extraction accuracy.

We also document the limits: lexical retrieval, a bounded candidate pool, and
soft deletion that does not erase original chats, backups, or provider-held data.
Reproducible failures and implementation feedback are welcome.

[Read the tutorial](https://github.com/Tylogi/YourChar/blob/main/docs/blog/building-reliable-agent-memory.en.md) · [Source and setup](https://github.com/Tylogi/YourChar)

— Tylogi AI Lab

## Short English post

How should agent memory handle a changed preference, forgetting, or an interrupted
write? Our YourChar engineering tutorial covers evidence, lifecycle rules,
context invalidation, and recovery—with a no-API-key lab and explicit limitations.

[Read the article](https://github.com/Tylogi/YourChar/blob/main/docs/blog/building-reliable-agent-memory.en.md) · [Explore YourChar](https://github.com/Tylogi/YourChar)

## 发布前检查

- 确认中英文正文、README 入口及实验已经合并并推送到 GitHub `main`；上述原文链接能打开。
- 从文章复制实验命令执行，检查召回、纠错和遗忘三个阶段的断言；不要用个人聊天记录或 API Key 做分享素材。
- 检查所选平台对 Markdown、Mermaid 和代码块的渲染。如果转载全文，保留署名、原文链接和实现基线，把相对源码链接改为对应 GitHub 地址。
- 保留软删除、隐私范围、候选池上限和脚本模型的说明；不把测试通过写成模型准确率或未经对比的领先结论。
- 发布账号和平台由维护者确认；按社区规则调整篇幅，明确自己与项目的关系。
- 如需配图，优先展示数据路径或合成实验，不使用含私人聊天和真实日程的截图。

发布后记录帖子地址和读者反馈。正文修正先回到仓库，再同步已发布的副本。
后续若建立独立文档站，应从这两份 Markdown 生成页面，并维护源码链接与实验锚点，
避免再维护一套容易与实现脱节的正文。
