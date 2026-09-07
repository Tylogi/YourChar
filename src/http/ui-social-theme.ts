/**
 * The approved avatar-led social theme. Keep this visual layer separate from
 * the application's existing layout, data bindings, and calendar behavior.
 * Reference: docs/ui-social-modern.html and docs/ui-social-assets/DESIGN.md.
 */
export const socialThemeCss = `
    :root {
      --bg: #f5f5f5;
      --panel: #ffffff;
      --list: #f7f7f7;
      --rail: #ededed;
      --line: #e3e3e3;
      --text: #1a1a1a;
      --muted: #707070;
      --sub: #616161;
      --hover: #ebebeb;
      --selected: #e6e6e6;
      --primary: #1a1a1a;
      --primary-strong: #333333;
      --primary-ink: #ffffff;
      --green-ink: #262626;
      --user: #242424;
      --user-ink: #f7f7f7;
      --assistant: #ffffff;
      --tool: #f7f7f7;
      --event: #ffffff;
      --danger: #c84040;
      --warning: #8b6416;
      --status-ok: #26834c;
      --danger-surface: #fff1f0;
      --warning-surface: #fff8e8;
      --shadow: none;
      --font-ui: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Noto Emoji";
    }
    body { font-family: var(--font-ui); font-size: 14px; line-height: 1.5; -webkit-font-smoothing: antialiased; }
    h1, h2, h3, h4, strong { font-weight: 600; }
    svg.lucide { stroke-width: 1.75; }
    :is(button, input, select, textarea, summary):focus-visible {
      outline: 2px solid var(--green-ink);
      outline-offset: 3px;
    }
    input, select, textarea { border-radius: 6px; }
    input[type="checkbox"], input[type="radio"] { accent-color: var(--green-ink); }
    .toggle { color: var(--sub); font-size: 13px; }
    .toggle input { border-color: #bdbdbd; background: var(--line); }
    .toggle input:checked { border-color: var(--green-ink); background: var(--green-ink); }
    input::placeholder, textarea::placeholder { color: var(--muted); opacity: 1; }
    button:disabled { cursor: not-allowed; }
    .muted { color: var(--muted); }

    /* Neutral application chrome; color belongs to people and useful states. */
    .header-left { background: var(--rail); border-right: 1px solid var(--line); gap: 24px; }
    .header-left h1, .brand-name { color: var(--sub); }
    .brand-mark { background: var(--selected); color: var(--text); box-shadow: none; font-weight: 500; overflow: hidden; }
    .brand-name { font-size: 11px; font-weight: 500; }
    .nav-segmented { gap: 10px; }
    .nav-segmented button { color: var(--sub); font-size: 11px; border-radius: 8px; }
    .nav-segmented button:hover { background: var(--hover); color: var(--text); }
    .nav-segmented button.active { background: var(--panel); color: var(--green-ink); }
    .nav-segmented button.active svg { color: var(--green-ink); stroke-width: 2.1; }
    .header-right { background: var(--bg); border-color: var(--line); }
    .conversation-title-line strong { color: var(--text); font-size: 17px; font-weight: 600; }
    .conversation-mode-badge, .conversation-heading .conversation-scene { color: var(--sub); font-size: 12px; }
    .conversation-mode-badge::before { background: var(--status-ok); }
    .conversation-header-avatar { flex-basis: 40px; width: 40px; height: 40px; border-radius: 8px; background: var(--selected); color: var(--sub); border: 0; }
    button.conversation-header-avatar:not(:disabled):hover { box-shadow: none; }
    .conversation-header-actions > .icon-button, .mobile-session-actions > .icon-button { background: transparent; border-color: transparent; color: var(--sub); }
    .context-budget-button .context-budget-ring { display: block; width: 18px; height: 18px; flex: 0 0 auto; transform: rotate(-90deg); }
    .context-budget-ring-track { stroke: var(--line); }
    .context-budget-ring-value { stroke: var(--sub); transition: stroke-dasharray 180ms ease, stroke 180ms ease; }
    .context-budget-button[data-level="warning"] .context-budget-ring-value { stroke: var(--warning); }
    .context-budget-button[data-level="critical"] .context-budget-ring-value { stroke: var(--danger); }
    @media (prefers-reduced-motion: reduce) { .context-budget-ring-value { transition: none; } }
    footer { background: var(--list) !important; border-top-color: var(--line) !important; }
    footer .status { color: var(--sub); }

    .primary { background: var(--primary); color: var(--primary-ink); border-color: transparent; font-size: 14px; font-weight: 500; box-shadow: none; }
    .primary:hover:not(:disabled) { background: var(--primary-strong); }
    .primary:disabled { background: var(--selected); color: var(--sub); opacity: 1; }
    .secondary { background: var(--panel); border-color: var(--line); color: var(--sub); font-size: 13px; box-shadow: none; }
    .secondary:hover:not(:disabled) { background: var(--hover); border-color: #cccccc; color: var(--text); }
    .segmented:not(.nav-segmented) { padding: 3px; gap: 3px; border: 0; background: var(--hover); border-radius: 8px; }
    .segmented:not(.nav-segmented) button { min-width: 0; border-radius: 5px; color: var(--sub); font-size: 13px; }
    .segmented:not(.nav-segmented) button.active { background: var(--panel); color: var(--text); font-weight: 600; box-shadow: 0 1px 2px #0000000a; }
    .text-button { color: var(--green-ink); }
    .session-actions-menu { border-radius: 8px; border-color: var(--line); box-shadow: 0 8px 24px #00000014; }
    .session-actions-menu button { font-size: 13px; border-radius: 5px; }

    /* Preserve world/role grouping and batch selection, but make avatars legible. */
    .conversation-sidebar { background: var(--list); border-color: var(--line); }
    .conversation-list-head { min-height: 66px; height: 66px; padding-inline: 20px 12px; border-bottom: 0; }
    .conversation-list-head strong { font-size: 22px; font-weight: 600; }
    .conversation-list-head .icon-button { background: transparent; border-color: transparent; }
    .conversation-list { padding: 0 10px 14px; }
    .conversation-group { border: 0; margin-bottom: 14px; }
    .conversation-group-head { grid-template-columns: 22px minmax(0, 1fr) 16px; height: 56px; padding: 8px 10px; gap: 8px; background: transparent; }
    button.conversation-group-head:hover { background: var(--hover); border-radius: 6px; }
    .conversation-group-head > .conversation-group-avatar { width: 22px; height: 22px; background: transparent; color: var(--sub); }
    .conversation-group-head > .conversation-group-avatar svg { width: 18px; height: 18px; }
    .conversation-group-head.batch { grid-template-columns: 18px 22px minmax(0, 1fr); }
    .conversation-group-copy strong { color: var(--sub); font-size: 12px; font-weight: 500; }
    .conversation-group-copy span { color: var(--muted); font-size: 11px; }
    .conversation-group-copy .conversation-unread { color: #fff; }
    .conversation-item { min-height: 78px; padding: 13px 10px; margin-bottom: 3px; gap: 12px; grid-template-columns: 46px minmax(0, 1fr); border: 0; border-radius: 7px; }
    .conversation-item.batch { padding-left: 10px; grid-template-columns: 18px 46px minmax(0, 1fr); }
    .conversation-item:hover { background: var(--hover); }
    .conversation-item.active { background: var(--selected); }
    .conversation-item .conversation-group-avatar { width: 46px; height: 46px; border-radius: 8px; font-weight: 500; }
    .conversation-item .group-avatar-cluster { width: 46px; height: 46px; border-radius: 8px; }
    .conversation-line { gap: 6px; }
    .conversation-line strong { font-size: 16px; font-weight: 500; }
    .conversation-item.active .conversation-line strong { font-weight: 600; }
    .conversation-copy { gap: 6px; }
    .conversation-preview { color: var(--sub); font-size: 13px; line-height: 1.5; }
    .conversation-time { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
    .conversation-item.active .conversation-time { color: var(--sub); }
    .conversation-unread { min-width: 18px; font-size: 11px; font-weight: 500; background: var(--danger); }
    .conversation-group-avatar, .character-card-avatar, .avatar-preview, .character-profile-avatar { background: var(--selected); color: var(--sub); }
    .group-avatar-cluster { background: #e0e0e0; }
    .group-avatar-cluster > span, .character-channel-avatar > span { background: var(--selected); color: var(--sub); }
    .conversation-item.character-channel-item { margin-left: 14px; width: calc(100% - 14px); min-height: 64px; grid-template-columns: 36px minmax(0, 1fr); background: transparent; border-left: 1px solid var(--line); }
    .conversation-item.character-channel-item:hover { background: var(--hover); }
    .conversation-item.character-channel-item .conversation-line strong { font-size: 13px; }
    .character-channel-avatar { width: 36px; height: 36px; }
    .character-channel-avatar > span { width: 24px; height: 24px; border-color: var(--list); }

    /* Dialogue remains dialogue: real portraits, readable type and compact turns. */
    .chat, .chat-thread { background: var(--bg); }
    .messages { gap: 22px; padding: 26px clamp(22px, 3.3vw, 48px) 28px; }
    .message-row { width: min(100%, 1000px); gap: 12px; }
    .message-avatar { flex-basis: 38px; width: 38px; height: 38px; border-radius: 8px; border: 0; background: var(--selected); color: var(--sub); box-shadow: none; font-weight: 500; overflow: hidden; }
    .message-row.user .message-avatar, .message-row.tool .message-avatar { background: var(--selected); color: var(--sub); }
    .character-profile-trigger:hover { box-shadow: none; }
    .character-profile-trigger:focus-visible, #conversationHeaderAvatar:focus-visible { outline: 2px solid var(--green-ink); outline-offset: 3px; box-shadow: none; }
    .message-stack { max-width: min(760px, calc(100% - 50px)); }
    .meta { font-size: 12px; line-height: 1.4; color: var(--muted); margin: 0 1px 7px; }
    .message-bubble-content { gap: 8px; }
    .bubble { font-size: 16px; line-height: 1.65; padding: 10px 14px; border-radius: 4px 8px 8px 8px; box-shadow: none; }
    .bubble.user { background: var(--user); color: var(--user-ink); border-radius: 8px 4px 8px 8px; }
    .bubble.assistant::before, .bubble.user::before { display: none; }
    .bubble.media-only { padding: 0; background: transparent; }
    .message-action { color: var(--sub); }
    .message-action:hover { background: var(--hover); color: var(--text); }
    .system-event, .interaction-event { color: var(--sub); }
    .interaction-event::before, .interaction-event::after { background: var(--line); }
    .interaction-event-actions button, .character-collaboration-link { color: var(--sub); background: var(--panel); border-color: var(--line); }
    .interaction-event-actions button.primary { color: var(--green-ink); border-color: var(--line); background: var(--panel); }
    .character-collaboration-card { background: var(--panel); border-color: var(--line); color: var(--text); border-radius: 8px; box-shadow: none; }
    .character-collaboration-objective { font-size: 12px; color: var(--sub); }
    /* World narration has its own renderer: reset the global header chrome here. */
    .world-scene-turn { width: min(100%, 1000px); padding: 18px 20px 22px; gap: 18px; background: var(--panel); border: 0; border-radius: 10px; box-shadow: none; }
    .world-scene-head { display: flex; flex-direction: row; flex-wrap: wrap; align-items: center; padding: 0; gap: 12px; border: 0; background: transparent; }
    .world-scene-head-copy { flex: 1 1 120px; gap: 4px; }
    .world-scene-head-copy strong { color: var(--text); font-size: 14px; font-weight: 600; }
    .world-scene-head-copy span { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
    .world-scene-participants { max-width: 100%; flex-wrap: wrap; gap: 6px; }
    .world-scene-participants .world-scene-mini-avatar + .world-scene-mini-avatar { margin-left: 0; }
    .world-scene-mini-avatar { width: 32px; height: 32px; border: 0; border-radius: 8px; background: var(--selected); color: var(--sub); font-size: 12px; font-weight: 500; }
    .world-scene-copy { padding: 0; }
    .world-scene-fragment { gap: 10px; }
    .world-scene-fragment + .world-scene-fragment { margin-top: 22px; }
    .world-scene-identity { min-width: 0; display: flex; align-items: center; gap: 10px; }
    .world-scene-identity .message-avatar { flex-basis: 32px; width: 32px; height: 32px; }
    .world-scene-speaker { color: var(--text); font-size: 13px; font-weight: 500; }
    .world-scene-text { color: var(--text); font-family: var(--font-ui); font-size: 16px; line-height: 1.85; overflow-wrap: anywhere; }
    .world-scene-fragment.director .world-scene-speaker { color: var(--muted); font-size: 12px; }
    .message-row.world-narration .bubble.assistant { background: var(--list); color: var(--sub); }

    /* Character-to-character scenes use the same paper and type as world turns. */
    .character-channel-dialog { border-color: var(--line); border-radius: 10px; box-shadow: 0 16px 48px #00000024; }
    .character-channel-participants { background: var(--panel); border-color: var(--line); }
    .character-channel-participants strong { font-size: 14px; font-weight: 500; }
    .character-channel-participants span:last-child { font-size: 12px; }
    .character-channel-messages { background: var(--bg); }
    .character-channel-episode.focused { background: var(--hover); box-shadow: 0 0 0 2px var(--line); }
    .character-channel-episode-head { width: min(100%, 590px); padding: 0 0 12px; gap: 8px; border: 0; border-radius: 0; background: transparent; color: var(--text); }
    .character-channel-episode-head strong { font-size: 14px; font-weight: 500; }
    .character-channel-episode-kind { background: var(--selected); color: var(--sub); font-size: 11px; font-weight: 500; }
    .character-channel-episode-status, .character-channel-episode-objective { color: var(--sub); font-size: 12px; line-height: 1.6; }
    .character-interaction-scene { padding: 20px; border: 0; border-radius: 10px; background: var(--panel); box-shadow: none; }
    .character-interaction-prose { color: var(--text); font-family: var(--font-ui); font-size: 16px; line-height: 1.85; letter-spacing: normal; overflow-wrap: anywhere; }
    .character-interaction-prose p { text-indent: 0; }
    .character-interaction-notes, .character-interaction-audit { border-color: var(--line); background: var(--panel); border-radius: 8px; }
    .character-interaction-notes > summary, .character-interaction-audit > summary { color: var(--sub); font-size: 13px; font-weight: 500; padding: 12px; }
    .character-interaction-reflection { border-left-color: var(--line); background: var(--list); color: var(--sub); font-size: 13px; }
    .character-interaction-reflection strong { color: var(--text); }
    .character-channel-message-avatar { border-radius: 8px; background: var(--selected); color: var(--sub); font-size: 13px; font-weight: 500; }
    .character-channel-message-meta { color: var(--muted); font-size: 12px; }
    .character-channel-message-bubble { background: var(--panel); border-radius: 4px 8px 8px 8px; font-size: 15px; line-height: 1.65; }
    .character-channel-system { background: var(--hover); color: var(--sub); font-size: 12px; }
    .character-collaboration-status { background: var(--list); color: var(--green-ink); font-size: 12px; font-weight: 500; border-radius: 5px; }
    .character-collaboration-status.queued, .character-collaboration-status.running,
    .character-collaboration-status.declined, .character-collaboration-status.cancelled { background: var(--hover); color: var(--sub); }
    .character-collaboration-status.failed { background: #fff1f0; color: var(--danger); }
    .markdown-body :is(h1, h2, h3, h4) { color: var(--text); font-weight: 600; }
    .markdown-body a { color: var(--green-ink); }
    .message-file-copy strong { font-size: 13px; font-weight: 500; }
    .message-file-copy small { font-size: 11px; }

    .composer { background: var(--panel); border-top-color: var(--line); gap: 8px; }
    .composer textarea { font-size: 16px; line-height: 1.6; color: var(--text); }
    .composer .secondary { background: transparent; border-color: transparent; color: var(--sub); }
    .composer .secondary:hover:not(:disabled) { background: var(--hover); }
    .composer .primary { background: var(--primary); color: var(--primary-ink); font-size: 14px; font-weight: 500; }
    .composer .primary:hover:not(:disabled) { background: var(--primary-strong); }
    .composer .primary:disabled { background: var(--selected); color: var(--sub); opacity: 1; }
    .emoji-category-button.active { background: var(--selected); color: var(--green-ink); }

    /* Apply the same material language to supporting workspaces and profiles. */
    .history-load-row { display: flex; justify-content: center; padding: 4px 0; }
    .history-load-row button { font-size: 12px; min-height: 32px; }
    .history-position-bar { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 12px; color: var(--sub); }
    .history-position-bar[hidden] { display: none; }
    .history-position-bar button { font-size: 13px; padding: 4px 0; }
    .history-focus { outline: 2px solid var(--green-ink); outline-offset: 5px; border-radius: 8px; scroll-margin-block: 30px; }
    .history-search-dialog { width: min(600px, calc(100vw - 28px)); max-height: min(760px, calc(100dvh - 28px)); border-color: var(--line); border-radius: 10px; }
    .history-search-dialog[open] { display: flex; flex-direction: column; }
    .history-search-dialog .schedule-editor-head { flex: 0 0 auto; min-width: 0; }
    .history-search-dialog h3 { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .history-search-form { display: flex; gap: 10px; padding: 16px 18px 0; }
    .history-search-form input { flex: 1; width: 0; min-width: 0; font-family: var(--font-ui); font-size: 16px; }
    .history-search-form button { flex: 0 0 auto; width: auto; }
    #historySearchStatus { margin: 12px 18px; font-size: 12px; }
    .history-search-results { min-height: 0; overflow: auto; padding: 0 12px; overscroll-behavior: contain; }
    .history-search-result { display: block; width: 100%; padding: 14px 8px; border: 0; border-bottom: 1px solid var(--line); background: transparent; text-align: left; color: var(--text); }
    .history-search-result:hover { background: var(--list); }
    .history-search-result > span { color: var(--muted); font-size: 12px; }
    .history-search-result p { margin: 8px 0 0; font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; }
    .history-search-result mark { background: var(--selected); color: var(--text); border-radius: 2px; }
    #historySearchMoreBtn { flex: 0 0 auto; margin: 12px 18px 16px; }
    .settings-page { background: var(--bg); }
    .settings-shell, .management-panel, .calendar-panel, .schedule-agenda, .task-panel { border-color: var(--line); border-radius: 8px; box-shadow: none; }
    .schedule-title-group h2, .character-head h2, .management-head h2, .settings-shell h2 { font-size: 22px; font-weight: 600; }
    .character-card { border-color: var(--line); border-radius: 8px; box-shadow: none; }
    .character-card:hover { border-color: #bdbdbd; }
    .character-card.active { border-color: var(--green-ink); box-shadow: inset 0 0 0 1px var(--green-ink); }
    .character-card-avatar { border-radius: 8px; }
    .character-card-copy strong { font-size: 16px; font-weight: 500; }
    .character-card-copy span { font-size: 13px; color: var(--sub); line-height: 1.5; }
    .world-card-grid { grid-template-columns: minmax(0, 1fr); gap: 22px; }
    #deleteCharacterBtn { margin-left: auto; background: transparent; border-color: var(--line); color: var(--danger); }
    #deleteCharacterBtn:hover:not(:disabled) { background: var(--danger-surface); }
    .world-map-card {
      container-type: inline-size; width: 100%; min-width: 0; padding: 22px; display: flex; flex-direction: column;
      align-items: stretch; gap: 18px; border: 1px solid var(--line); border-radius: 14px;
      background: var(--panel); color: var(--text); text-align: left;
    }
    .world-map-card-head { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 14px; }
    .world-map-title { min-width: 0; display: grid; gap: 5px; }
    .world-map-title > strong { overflow-wrap: anywhere; color: var(--text); font-size: 21px; font-weight: 600; }
    .world-map-title > span:last-child { color: var(--muted); font-size: 12px; }
    .world-map-kicker { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 11px; }
    .world-map-kicker svg { width: 13px; height: 13px; }
    .world-map-card-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 14px; }
    .world-card .world-map-avatar { width: 36px; height: 36px; flex: 0 0 36px; padding: 0; border-radius: 8px; }
    .world-map-stage {
      position: relative; isolation: isolate; min-width: 0; overflow: hidden; border-radius: 12px;
      background-color: var(--list); background-image: radial-gradient(var(--line) .75px, transparent .75px); background-size: 18px 18px;
    }
    .world-map-caption { position: absolute; top: 16px; left: 18px; display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 11px; }
    .world-map-caption svg { width: 13px; height: 13px; }
    .world-map-terrain { position: absolute; inset: 0; width: 100%; height: 100%; z-index: -1; pointer-events: none; }
    .world-map-terrain path { fill: none; stroke: var(--panel); stroke-width: 15; }
    .world-map-terrain ellipse { fill: none; stroke: var(--line); stroke-width: 1; stroke-dasharray: 3 7; opacity: .65; }
    .world-map-locations { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); align-items: start; gap: 18px 24px; padding: 48px 30px 38px; }
    .single-place .world-map-locations { grid-template-columns: minmax(0, 1fr); }
    .world-map-place {
      min-width: 0; min-height: 218px; padding-top: 20px; display: flex; flex-direction: column;
      align-items: center; gap: 12px; color: var(--text);
    }
    .world-map-place:nth-child(3n + 2) { padding-top: 70px; }
    .world-map-place:nth-child(3n) { padding-top: 36px; }
    .world-map-place-trigger {
      max-width: 100%; padding: 9px 13px; display: grid; gap: 5px; border: 1px solid var(--line); border-radius: 10px;
      background: var(--panel); color: var(--text); cursor: pointer; box-shadow: 0 2px 5px #00000006;
    }
    .world-map-place-trigger:hover { border-color: var(--sub); }
    .world-map-place.selected .world-map-place-trigger { border-color: var(--green-ink); box-shadow: 0 0 0 1px var(--green-ink); }
    .world-map-place-head { min-width: 0; display: flex; align-items: center; justify-content: center; gap: 6px; }
    .world-map-place-head > strong { min-width: 0; overflow-wrap: anywhere; font-size: 13px; font-weight: 500; }
    .world-map-place-head > svg { width: 15px; height: 15px; flex: 0 0 auto; color: var(--sub); }
    .world-map-place-caption { display: flex; justify-content: center; align-items: center; flex-wrap: wrap; gap: 4px; color: var(--muted); font-size: 11px; }
    .world-map-place.has-event.active .world-map-place-caption { color: var(--status-ok); }
    .world-map-place.has-event.planned .world-map-place-caption { color: var(--warning); }
    .world-map-event-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
    .world-map-landmark { width: 64px; height: 69px; display: grid; place-items: center; color: var(--muted); }
    .world-map-landmark svg { width: 32px; height: 32px; stroke-width: 1.1; }
    .world-map-anchor { position: relative; width: 8px; height: 8px; border: 2px solid var(--panel); border-radius: 50%; background: var(--muted); box-shadow: 0 0 0 1px var(--line); }
    .world-map-anchor::before { content: ""; position: absolute; left: 1px; bottom: 8px; height: 8px; border-left: 1px solid var(--line); }
    .world-map-place.has-event.active .world-map-anchor { background: var(--status-ok); }
    .world-map-residents { min-width: 0; width: 100%; display: flex; justify-content: center; flex-wrap: wrap; gap: 8px; }
    .world-map-person {
      min-width: 0; width: 58px; padding: 3px 2px; display: flex; flex-direction: column; align-items: center;
      gap: 6px; border: 0; border-radius: 10px; background: transparent; color: var(--text); cursor: pointer;
    }
    .world-map-person:hover { background: var(--hover); }
    .world-map-person-avatar {
      position: relative; flex: 0 0 auto; width: 44px; height: 44px; display: grid; place-items: center;
      border: 3px solid var(--panel); border-radius: 13px; background: var(--selected); color: var(--sub);
      font-size: 16px; font-weight: 500; box-shadow: 0 3px 8px #00000012;
    }
    .world-map-person-avatar img { width: 100%; height: 100%; object-fit: cover; border-radius: 9px; }
    .world-map-person-copy { min-width: 0; max-width: 100%; display: grid; gap: 3px; }
    .world-map-person-copy > strong,
    .world-map-person-copy > small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .world-map-person-copy > strong { color: var(--text); font-size: 12px; font-weight: 500; }
    .world-map-person-copy > small { display: none; color: var(--muted); font-size: 12px; }
    .world-map-status-dot { position: absolute; right: -4px; bottom: -3px; width: 10px; height: 10px; border: 2px solid var(--panel); border-radius: 50%; background: var(--status-ok); }
    .world-map-person.availability-busy .world-map-status-dot { background: var(--text); }
    .world-map-person.availability-resting .world-map-status-dot { background: var(--muted); }
    .world-map-person.availability-traveling .world-map-status-dot { background: var(--warning); }
    .world-map-offsite-list { display: grid; gap: 12px; }
    .world-map-offsite { min-width: 0; display: flex; align-items: center; gap: 18px; }
    .world-map-offsite-label { display: flex; flex: 0 0 80px; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
    .world-map-offsite-label svg { width: 14px; height: 14px; }
    .world-map-offsite-people, .world-map-detail-people { min-width: 0; flex: 1; display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 8px; }
    .world-map-person.detail { width: 100%; flex-direction: row; padding: 6px; gap: 10px; text-align: left; }
    .world-map-person.detail .world-map-person-avatar { width: 36px; height: 36px; border-width: 0; border-radius: 9px; box-shadow: none; }
    .world-map-person.detail .world-map-person-copy > small { display: block; white-space: normal; overflow-wrap: anywhere; }
    .world-map-detail { padding: 16px; border: 1px solid var(--line); border-radius: 10px; background: var(--list); }
    .world-map-detail-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .world-map-detail-head > strong { overflow-wrap: anywhere; font-size: 14px; }
    .world-map-detail p { margin: 8px 0 12px; color: var(--sub); font-size: 13px; line-height: 1.7; overflow-wrap: anywhere; }
    .world-map-empty {
      grid-column: 1 / -1; min-height: 170px; display: grid; place-content: center;
      justify-items: center; gap: 8px; color: var(--muted); text-align: center;
    }
    .world-map-empty svg { width: 32px; height: 32px; margin-bottom: 4px; stroke-width: 1.25; }
    .world-map-empty strong { color: var(--sub); font-size: 14px; font-weight: 500; }
    .world-map-empty small { font-size: 12px; }
    .world-map-card-foot { min-width: 0; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; padding-top: 14px; border-top: 1px solid var(--line); }
    .world-card-event { min-width: 0; display: flex; align-items: center; gap: 6px; color: var(--status-ok) !important; font-size: 12px; overflow-wrap: anywhere; }
    .world-card-event.planned { color: var(--warning) !important; }
    .world-card-event.quiet { color: var(--muted) !important; }
    .world-card-event svg { width: 12px; height: 12px; flex: 0 0 auto; }
    .world-map-hint { color: var(--muted); font-size: 11px; }
    @container (max-width: 680px) {
      .world-map-locations { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 10px; padding: 44px 10px 26px; }
      .world-map-place { min-height: 185px; }
      .world-map-place:nth-child(n) { padding-top: 15px; }
      .world-map-place:nth-child(2n) { padding-top: 45px; }
      .world-map-card-actions .world-map-avatar { display: none; }
      .world-map-person { width: 50px; }
      .world-map-residents { gap: 3px; }
      .world-map-place-trigger { padding: 8px; }
      .world-map-offsite { gap: 10px; }
      .world-map-offsite-label { flex-basis: 74px; }
      .world-map-offsite-people { grid-template-columns: minmax(0, 1fr); }
    }
    .character-profile-identity { background: var(--list); }
    .character-profile-avatar { border-radius: 12px; box-shadow: none; }
    .character-profile-name h3 { font-size: 22px; font-weight: 600; }
    .character-profile-soul .markdown-body { color: var(--text); font-size: 15px; line-height: 1.8; }
    .character-profile-tabs { margin: 16px 22px 0; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .character-diary-panel { min-width: 0; padding: 20px 22px 28px; }
    .character-diary-panel[hidden] { display: none; }
    .character-diary-heading { display: flex; align-items: center; gap: 12px; justify-content: space-between; margin-bottom: 16px; }
    .character-diary-heading .muted, #characterDiaryStatus, .diary-settings p { font-size: 12px; line-height: 1.6; }
    .diary-settings { padding: 12px; background: var(--list); border: 1px solid var(--line); border-radius: 8px; }
    .diary-settings summary, .diary-memory summary { cursor: pointer; color: var(--sub); font-size: 13px; }
    .diary-settings[open] summary { margin-bottom: 14px; }
    .diary-settings .settings-field { margin-top: 14px; }
    .diary-settings textarea { width: 100%; min-width: 0; font-family: var(--font-ui); font-size: 14px; }
    .diary-settings select { width: 100%; min-width: 0; max-width: 100%; font-family: var(--font-ui); }
    .diary-relationship { padding: 12px 0; display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; border-bottom: 1px solid var(--line); }
    .diary-relationship span, .diary-relationship small { color: var(--sub); font-size: 12px; }
    .diary-entry { padding: 22px 0; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
    .diary-entry header { display: grid; gap: 6px; }
    .diary-entry header strong { font-size: 16px; }
    .diary-entry header small { color: var(--muted); font-size: 12px; }
    .diary-prose { font-size: 15px; line-height: 1.9; margin: 18px 0; }
    .diary-memory { background: var(--list); padding: 12px; border-radius: 8px; font-size: 13px; }
    .diary-memory li { margin-block: 8px; }
    .diary-memory li > span { color: var(--sub); font-size: 12px; }
    .diary-entry-actions { margin-top: 14px; display: flex; justify-content: flex-end; }
    .character-profile-dialog, .schedule-editor-dialog, .new-conversation-dialog, .archived-dialog, .session-action-dialog { border-color: var(--line); border-radius: 10px; box-shadow: 0 16px 48px #00000024; }
    .settings-field > label, .schedule-form label, .avatar-hint { font-size: 13px; color: var(--sub); }
    .settings-field > .muted, .settings-actions > .muted { font-size: 12px; }

    /* Meeting details and nested settings share the same neutral components. */
    .scene-info-content { padding-block: 12px; }
    .scene-info-content dl { margin: 0; }
    .scene-info-row { padding-block: 14px; border-bottom-color: var(--line); font-size: 14px; line-height: 1.65; }
    .scene-info-row dt { color: var(--sub); font-size: 13px; }
    .scene-info-actions { border-top-color: var(--line); }
    .scene-editor-form label, .world-capability-options label { color: var(--sub); font-size: 13px; }
    .settings-field > span:not(.muted), .im-channel-field > span { color: var(--sub); font-size: 13px; }
    .meeting-preset-import, .meeting-preset-compatibility, .subagent-settings-runtime {
      background: var(--list); border-color: var(--line); border-radius: 8px; color: var(--sub);
    }
    .meeting-preset-heading p, .meeting-preset-empty { font-size: 13px; line-height: 1.65; }
    .meeting-preset-import-summary span, .meeting-preset-compatibility,
    .meeting-preset-editor-head > .muted, .meeting-preset-prompt-head > .muted,
    .character-preset-hint { font-size: 12px; line-height: 1.6; }
    .meeting-preset-compatibility strong, .okf-preview-summary strong { color: var(--text); }
    .meeting-preset-import-grid label, .meeting-preset-parameters-field,
    .meeting-preset-prompt-editor label { color: var(--sub); font-size: 13px; }
    .meeting-preset-prompt-row > summary { gap: 10px; padding-block: 12px; }
    .meeting-preset-prompt-row > summary strong { font-size: 14px; font-weight: 500; }
    .meeting-preset-prompt-role, .meeting-preset-prompt-kind {
      background: var(--list); border-color: var(--line); color: var(--sub); border-radius: 5px; font-size: 12px;
    }
    .meeting-preset-prompt-editor textarea, .system-prompt-editor, .system-prompt-details pre {
      font-family: var(--font-ui); font-size: 14px; line-height: 1.65;
    }
    /* JSON model parameters, paths and diagnostic code keep their monospace face. */
    .meeting-preset-parameters { font-size: 13px; }
    .system-prompt-details summary { color: var(--sub); font-size: 13px; font-weight: 500; }
    .system-prompt-details pre { background: var(--list); color: var(--text); }
    .okf-version { background: var(--list); color: var(--sub); border-color: var(--line); font: 12px/1.4 var(--font-ui); }
    .okf-export-options .checkbox-row, .okf-preview-summary { color: var(--sub); font-size: 13px; }
    .okf-preview-summary { flex-wrap: wrap; padding-block: 10px; }
    .okf-document-row { font-size: 13px; padding-block: 12px; }
    .okf-document-copy span, .okf-document-status { font-size: 12px; }
    .okf-document-row.ready > svg { color: var(--green-ink); }
    .okf-document-row.reserved > svg { color: var(--muted); }
    .vault-history-entry { border: 1px solid var(--line); background: var(--list); border-radius: 8px; }
    .subagent-settings-head p, .subagent-settings-note, .subagent-settings-field small,
    .subagent-settings-runtime, .subagent-settings-state { font-size: 12px; line-height: 1.6; }
    .subagent-settings-field { color: var(--sub); font-size: 13px; }
    .capability-copy span, .capability-level, .capability-evidence,
    .capability-notes, .capability-bindings summary { color: var(--sub); font-size: 12px; }
    .capability-bindings { border-color: var(--line); }
    .capability-module-option { background: var(--panel); border-color: var(--line); color: var(--sub); font-size: 13px; }
    .capability-module-option.recommended { background: var(--list); border-color: var(--line); }
    .capability-module-option small { font-size: 12px; }
    .capability-module-option small.on { color: var(--green-ink); }
    .capability-row:not(.enabled) .capability-responsibility button.active { background: var(--selected); color: var(--sub); }
    .im-channel-card.connected { border-color: var(--line); box-shadow: none; }
    .im-channel-title small, .im-channel-description, .im-channel-status { font-size: 12px; }
    .im-channel-meta { color: var(--sub); font-size: 12px; }
    .im-channel-status.connected { background: var(--list); color: var(--green-ink); }
    .im-typing-setting { background: var(--list); border-color: var(--line); color: var(--sub); font-size: 12px; }

    /* The full 7-column month view, agenda and task list remain functional. */
    .schedule-shell { max-width: 1180px; }
    .schedule-owner-head { padding-bottom: 20px; border-bottom-color: var(--line); }
    .schedule-head.schedule-navigation { margin-bottom: 16px; }
    .schedule-scope-summary, .schedule-character-field { font-size: 13px; color: var(--sub); }
    .schedule-month-label { font-family: var(--font-ui); font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .calendar-panel { overflow: hidden; }
    .calendar-weekdays { background: var(--list); border-color: var(--line); }
    .calendar-weekdays span { padding: 12px 4px; font-size: 12px; color: var(--sub); }
    .calendar-grid { grid-template-columns: repeat(7, minmax(0, 1fr)); }
    .calendar-day { min-height: 100px; border-color: var(--line); background: var(--panel); }
    .calendar-day.outside { background: var(--list); color: var(--muted); }
    .calendar-day:hover { background: var(--list); }
    .calendar-day.selected { background: var(--selected); box-shadow: inset 0 0 0 2px var(--green-ink); }
    .calendar-day:focus-visible { outline: 2px solid var(--green-ink); outline-offset: -3px; z-index: 1; }
    .calendar-day-number { width: 26px; height: 26px; font-size: 13px; font-variant-numeric: tabular-nums; }
    .calendar-day.today .calendar-day-number { background: var(--primary); color: var(--primary-ink); font-weight: 600; }
    .calendar-event { background: var(--list); color: var(--text); border-left: 2px solid var(--green-ink); border-radius: 3px; font-size: 11px; line-height: 1.5; }
    .calendar-event.event { background: var(--list); color: var(--text); border-left-color: #737373; }
    .calendar-event.reminder { background: var(--list); color: var(--green-ink); }
    .calendar-event.delivered, .calendar-event.completed { background: var(--hover); color: var(--sub); border-left-color: #8c8c8c; }
    .calendar-event.failed { background: #fff1f0; color: var(--danger); border-left-color: var(--danger); }
    .calendar-more { font-size: 11px; }
    .schedule-title, .task-copy strong { font-size: 14px; font-weight: 500; }
    .schedule-meta { font-size: 13px; }
    .schedule-status-badge { font-size: 11px; background: var(--hover); color: var(--sub); }
    .schedule-status-badge.scheduled { background: var(--list); color: var(--green-ink); }
    .schedule-editor-scope, .task-copy span { font-size: 12px; }
    .task-panel-head, .schedule-agenda-head { border-color: var(--line); }
    .task-item.completed .task-copy strong { color: var(--muted); }

    @media (min-width: 901px) {
      .app { grid-template-columns: 72px minmax(0, 1fr); }
      .header-left { width: 72px; padding: 24px 10px 14px; }
      .header-left h1, .nav-segmented, .nav-segmented button { width: 51px; }
      .chat-workspace { grid-template-columns: 298px minmax(0, 1fr); }
    }
    @media (min-width: 901px) and (max-width: 1100px) {
      .chat-workspace { grid-template-columns: 270px minmax(0, 1fr); }
      .messages { padding-inline: 22px; }
      .schedule-dashboard { grid-template-columns: minmax(0, 1fr) 280px; gap: 12px; }
    }
    @media (max-width: 900px) {
      .header-left { border-right: 0; background: var(--panel); gap: 0; }
      .nav-segmented { gap: 0; }
      .nav-segmented button { border-radius: 0; font-size: 11px; }
      .nav-segmented button.active, .nav-segmented button:hover { background: transparent; }
      .conversation-title-line strong { font-size: 16px; }
      .conversation-mode-badge, .conversation-heading .conversation-scene { font-size: 11px; }
      .conversation-header-avatar { flex-basis: 36px; width: 36px; height: 36px; }
      .conversation-list-head { padding-inline: 20px 14px; }
      .conversation-item { min-height: 84px; grid-template-columns: 50px minmax(0, 1fr); padding: 14px 12px; }
      .conversation-item.batch { grid-template-columns: 18px 50px minmax(0, 1fr); }
      .conversation-item .conversation-group-avatar, .conversation-item .group-avatar-cluster { width: 50px; height: 50px; }
      .conversation-line strong { font-size: 17px; }
      .messages { padding: 22px 14px 24px; gap: 22px; }
      .message-row { gap: 10px; }
      .message-avatar { flex-basis: 36px; width: 36px; height: 36px; }
      .message-stack { max-width: calc(100% - 46px); }
      .bubble { font-size: 16px; padding: 10px 13px; }
      .world-scene-turn { padding: 16px 14px 18px; }
      .world-scene-copy { padding: 0; }
      .world-scene-text { font-size: 16px; }
      .character-interaction-scene { padding: 18px 16px; }
      .composer textarea { font-size: 16px; }
      .character-profile-tabs { margin-inline: 18px; }
      .character-diary-panel { padding-inline: 18px; }
      .diary-settings textarea { font-size: 16px; }
      .meeting-preset-prompt-editor textarea, .system-prompt-editor, .meeting-preset-parameters { font-size: 16px; }
      .schedule-title-group h2 { font-size: 24px; }
      .schedule-view-tabs { margin-bottom: 14px; }
      .calendar-day { min-height: 78px; padding: 5px 3px; }
      .calendar-event { font-size: 11px; padding-inline: 3px; }
      .calendar-weekdays span { padding-block: 10px; }
      .schedule-month-label { padding-inline: 4px; font-size: 14px; }
      .schedule-owner-head { padding-bottom: 14px; }
    }
    @media (max-width: 600px) {
      .world-card-grid { grid-template-columns: minmax(0, 1fr); }
      .world-map-card { padding: 14px; gap: 14px; }
      .world-map-title > strong { font-size: 19px; }
      .world-map-manage { padding-inline: 8px; }
      .character-channel-episode-head { grid-template-columns: auto minmax(0, 1fr); }
      .character-channel-episode-status { grid-column: 1 / -1; }
      .settings-tabs { grid-template-columns: repeat(4, minmax(0, 1fr)); }
      .settings-tabs button { white-space: nowrap; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; }
    }
`;
