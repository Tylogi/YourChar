<div align="center">
  <h1>YourChar</h1>
  <p>
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/readme-assets/tylogi-ai-lab-lockup-dark.svg">
      <img src="docs/readme-assets/tylogi-ai-lab-lockup-light.svg" alt="Tylogi AI Lab" width="280">
    </picture>
  </p>
  <p>
    <strong>Your AI Character, Living With You.</strong><br>
    有记忆、有关系、会生活的 AI 角色。
  </p>
  <p>AI companions with lasting memory, shared worlds, and tools for everyday life.</p>
  <p>
    <a href="#quick-start">Quick start</a> ·
    <a href="#try-it">Try it</a> ·
    <a href="docs/README.md">Documentation</a> ·
    <a href="CONTRIBUTING.md">Contribute</a>
  </p>
  <p>English · <a href="README.zh-CN.md">简体中文</a></p>
</div>

YourChar is a self-hosted, open-source app for creating AI characters with their own
personalities, memories, relationships, and daily activities. Chat with a
character, build a world together, or ask for help with a real task—all from
the same conversation.

<p align="center">
  <a href="docs/readme-assets/chat-and-reminders.png">
    <img src="docs/readme-assets/chat-and-reminders.png" alt="A YourChar conversation where a character creates a real reminder" width="760">
  </a><br>
  <sub>A conversation that leads to a real reminder. Screenshots show the Chinese interface.</sub>
</p>

## What makes YourChar different

- **Characters who remember.** Give each character a Markdown `SOUL.md`
  defining their identity and voice. Long-term memories keep their sources, and
  conversation checkpoints help continuity survive long chats and restarts.
- **A shared world with daily life.** Characters can inhabit places, make
  plans, talk to one another, and write diaries from their experiences.
  Relationships develop from recorded interactions. You choose whether to
  enable autonomous activities and proactive messages.
- **Practical help with a familiar personality.** Set real reminders, work on
  files, read documents, or delegate a task. Tools and background work follow
  the permissions you enable; character schedules and world events stay
  separate from your real calendar.
- **Your choice of model and data.** Use a local model endpoint or a supported
  hosted provider. Conversations and memory live in your state directory,
  with export, backup, and separate private-conversation controls.

## Quick start

Requires **Node.js 22.19.0 or newer** and npm. Linux is the target for the full
feature set: sandboxed shell and document conversion use Bubblewrap, and
incognito snapshots require a verified `tmpfs` filesystem.

### 1. Start the app

Clone or download this repository, open a terminal in its root, and run:

```bash
npm ci
npm run dev
```

Open **[http://127.0.0.1:8765](http://127.0.0.1:8765)**.
The app builds automatically and stores state in `.yourchar/` by default.

### 2. Connect a model

In **Settings → Models（设置 → 模型）**, select a Provider, enter its model
and endpoint/credential settings, enable the profile, and save. Use
**Test connection（测试连接）**, then set the profile as the system default.

Supported transports are OpenAI-compatible Chat Completions for local or
compatible endpoints, plus native OpenAI Responses, Anthropic Messages, and
Google Generative AI. A model that supports tool calls is needed for Agent
actions. [Provider setup and profile details →](docs/model-provider-adapters.md)

### 3. Create your first character

Open **Characters → New character（角色 → 新建角色）**, give the character
a name, and edit its `SOUL.md` identity and voice. Start a private chat.
The character inherits the default model unless you assign another profile.

For a world to explore together, create a World Card and add characters and
places. The **Creator Assistant（管理 → 创作助手）** can help draft character
and world settings for you to review.

<details>
<summary>Optional: document tools and a persistent service</summary>

PDF/Office conversion additionally needs `uv`, Python 3.11+, and
`/usr/bin/bwrap`. After installing those prerequisites:

```bash
npm run setup:markitdown
```

This creates `services/markitdown/.venv`. Basic chat does not require the
document worker. Enable Workspace access and other tools in Agent management
when you want to use them.

Keep YourChar running for reminders and background activities.
See [Operations](docs/operations.md) for the Linux user service, backups, and
upgrading an existing installation.

</details>

## Try it

Start in a character's normal conversation. Enable the relevant capability
before trying an optional tool.

| Try this | What to look for |
| --- | --- |
| “Remember that I prefer a short checklist when planning my day.” | Inspect the saved entry in Memory, then refer to it in a later conversation. |
| “Remind me in ten minutes to take a break.” | A real schedule entry and an in-app reminder while YourChar is running. |
| Give two characters a world with a café and a library; enable their autonomous life settings. | Activity plans, changing locations, conversations, and diaries as experiences settle. |
| With Workspace write access enabled: “Save our plan as `weekend.md` and share it with me.” | An actual file in the Workspace and an attachment in the reply. |

## A look inside

<table>
  <tr>
    <td width="50%">
      <a href="docs/readme-assets/characters-and-world.png"><img src="docs/readme-assets/characters-and-world.png" alt="Character cards and a shared world map with current locations" width="100%"></a><br>
      <strong>Characters and shared worlds</strong><br>
      <sub>Build identities, places, and a history that grows through interaction.</sub>
    </td>
    <td width="50%">
      <a href="docs/readme-assets/character-schedule.png"><img src="docs/readme-assets/character-schedule.png" alt="A character calendar with completed daily activities" width="100%"></a><br>
      <strong>Life between conversations</strong><br>
      <sub>Follow a character's own plans, activities, and daily rhythm.</sub>
    </td>
  </tr>
</table>

<details>
<summary>Explore the Agent Workspace</summary>

[![YourChar Workspace with files created by a character](docs/readme-assets/agent-workspace.png)](docs/readme-assets/agent-workspace.png)

Browse, upload, preview, download, and share files. Workspace, shell, network,
and repository access have separate permission controls.
[Workspace guide →](docs/workspace-capabilities.md)

</details>

## Built for developers, too

YourChar builds on the original `@earendil-works/pi-coding-agent` session
runtime, with TypeScript, SQLite, and a Markdown Memory Vault.

- **Extend capabilities:** register trusted packages with explicit tools,
  settings, context contributions, and cleanup.
- **Run longer tasks:** durable subagents, background shell jobs, goals, and
  workflows have budgets, cancellation, and recovery policies.
- **Integrate without the UI:** an authenticated loopback API, TypeScript SDK,
  and optional ACP bridge expose the same runtime.
- **Inspect behavior:** provider traces, typed events, replay, checkpoints,
  and isolated evaluation tools make changes testable.

The [runtime modernization plan](docs/agent-runtime-modernization-plan.md)
records the completed milestones. Its **2026-09-15** release gate passed
**799 tests**, browser workflows, and the sensitive-information scan.
See [Contributing](CONTRIBUTING.md) for the code map and checks for new changes.

## Data and privacy

YourChar runs as a single-user, loopback-only service. Its state lives locally;
a hosted model or enabled external integration still receives the data required
for its requests. Private mode separates a character's durable conversations
and memories; incognito discards its local temporary conversation when closed.
Neither mode encrypts the state directory or controls a provider's retention.

See [Private mode](docs/private-mode.md), [Incognito](docs/incognito-mode.md),
and [Backup and restore](docs/operations.md) for the exact boundaries.

## Explore the docs

| I want to… | Start here |
| --- | --- |
| Set up models, run the service, or upgrade | [Providers](docs/model-provider-adapters.md) · [Operations](docs/operations.md) |
| Create characters and build their lives | [SOUL.md](docs/character-soul.md) · [Worlds](docs/world-conversation-mode.md) · [Diaries](docs/character-diaries.md) |
| Add tools or connect messaging apps | [Agent modules and Skills](docs/agent-modules-and-user-profile.md) · [WeChat / Feishu](docs/im-channels.md) |
| Automate or extend the runtime | [Headless API / SDK](docs/headless-api.md) · [ACP](docs/acp-bridge.md) · [Runtime events](docs/runtime-events.md) |
| Find configuration, API routes, or implementation details | [Runtime reference](docs/runtime-reference.md) · [Full documentation index](docs/README.md) |

## Help shape YourChar

Try it with your preferred model, share a reproducible bug, improve the
onboarding or translations, or contribute a focused capability.
[The contribution guide](CONTRIBUTING.md) covers where to start, how to test,
and what makes a useful issue or pull request.

## License and acknowledgements

YourChar is licensed under the [MIT License](LICENSE).
Third-party dependencies and assets retain their respective licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
