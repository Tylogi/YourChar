# YourChar documentation

[English project overview](../README.md) · [中文介绍](../README.zh-CN.md) · [Contributing](../CONTRIBUTING.md)

Start with the [quick start](../README.md#quick-start) to run the app and create
a character. This index groups the detailed guides by what you want to do.
Some feature guides are currently written in Chinese.

## Engineering articles

- **Building a reliable agent memory system** — [English](blog/building-reliable-agent-memory.en.md) · [简体中文](blog/building-reliable-agent-memory.md): evidence-backed capture, correction and forgetting, retrieval budgets, and crash recovery in YourChar. Includes a runnable lab that needs no model API key.

For contributors: [sharing copy and publication notes](blog/memory-tutorial-sharing.md).

## Install and operate

- [Model providers](model-provider-adapters.md): profiles, native transports, credential management, and routing.
- [Operations](operations.md): the Linux user service, state migration, backups, restore, and diagnostics.
- [LLM usage and cost](llm-usage-cost.md): the token ledger, per-provider aggregation, price overrides, and the monthly budget.
- [Runtime reference](runtime-reference.md): environment variables, HTTP routes, capability inventory, and compatibility history.
- [WeChat and Feishu/Lark](im-channels.md): single-owner channels, character routing, and reminder delivery.
- [Private mode](private-mode.md) and [Incognito](incognito-mode.md): durable partitions and disposable conversations.

## Characters and shared worlds

- [Character SOUL.md](character-soul.md): identity, voice, and editable Markdown.
- [Creator Assistant](creator-assistant.md): drafting and reviewing characters, worlds, and places.
- [World conversations](world-conversation-mode.md) and [World autonomy](world-autonomy.md): narrative timelines and daily activities.
- [Character diaries](character-diaries.md): experiences, diaries, and character-to-character relationships.
- [Character life](character-life.md): ongoing requests, wishes, background activity, and departures.
- [Relationship and affect](relationship-affect.md): the character's relationship with the user.
- [Meeting interaction](interaction-state.md): planned meetings, co-presence, and departures.
- [Character collaboration](character-organization-v2.md): owned workflows, Skills, and scoped collaboration.
- [Chat history](chat-history.md), [Appearance](appearance.md), and [Conversation sleep](conversation-sleep-lifecycle.md): the everyday conversation experience.

## Memory and reminders

- [Memory retrieval and context budgets](memory-architecture-r4.md): retrieval, resident context, and token accounting.
- [Memory durability](memory-architecture-r5.md): the Markdown Vault, recovery, leases, and backup verification.
- [Memory capture](memory-architecture-r3.md) and [Daily-chat capture](memory-daily-capture.md): evidence, review, and memory lifecycle.
- [OKF memory exchange](okf-memory-compatibility.md): import/export boundaries and supported archive content.
- [Reminder delivery](reminder-delivery.md) and [Reminder lifecycle](reminder-lifecycle.md): timing, retries, channels, and acknowledgement.

## Tools and extensions

- [Agent modules and Skills](agent-modules-and-user-profile.md): discovery, switches, profiles, and package lifecycle.
- [MCP integration](mcp-agent-modules.md): reusable tools and proactive-event integration.
- [Workspace and shell](workspace-capabilities.md): files, sandboxing, permissions, and document conversion.
- [Git repositories](git-repository-mcp.md): repository access, credentials, commits, and push controls.
- [Web Reader](web-reader-mcp.md) and [Tavily Search](tavily-search-mcp.md): fetching public pages and live search.
- [Vision](vision-mcp.md) and [MinerU](mineru-mcp.md): image understanding and richer document parsing.
- [Subagents](subagent-delegation.md): delegation, continuation, grants, and recovery.
- [LSP code navigation](lsp-navigation.md): optional code intelligence and its same-model evaluation.

## APIs, architecture, and evaluation

- [Headless API and TypeScript SDK](headless-api.md): authentication, streaming, jobs, goals, workflows, and cancellation.
- [ACP bridge](acp-bridge.md): stdio interoperability through the SDK.
- [Runtime events](runtime-events.md): projection capture, versioning, replay, checkpoints, and integrity.
- [Development specification](development-spec.md) and [Completed modernization plan](agent-runtime-modernization-plan.md): architecture and milestone evidence.
- [Release gate](release-gate.md): deterministic checks and optional real-model evaluation.
- [Task Bench](task-bench.md) and [Model adaptation evaluation](model-adaptation-evaluation.md): isolated trials and report interpretation.
- [Background thinking](background-thinking-policy.md) and [Post-turn Coordinator](post-turn-coordinator.md): background model behavior and consumers.

## Historical design notes

These documents retain earlier decisions and migration context. Use the guides
above for current behavior.

- [Memory R1](memory-architecture-r1.md) and [Memory R2](memory-architecture-r2.md).
- [Legacy group chat](group-chat-multi-model.md).
- [Experience coherence](experience-coherence-m12.md).
- [Five-round product review](five-round-product-review.md).
