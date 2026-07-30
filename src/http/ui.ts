export function renderAppHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
  <meta name="theme-color" content="#07c160" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="default" />
  <meta name="apple-mobile-web-app-title" content="RP Agent" />
  <title>RP Agent</title>
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="icon" type="image/png" sizes="32x32" href="/assets/icons/favicon-32.png" />
  <link rel="apple-touch-icon" sizes="180x180" href="/assets/icons/apple-touch-icon-180.png" />
  <link rel="stylesheet" href="/assets/noto-emoji/400.css" />
  <style>
    :root {
      color-scheme: light;
      --bg: #f2f2f2;
      --panel: #ffffff;
      --line: #dedede;
      --text: #191919;
      --muted: #7a7a7a;
      --primary: #07c160;
      --primary-strong: #06ad56;
      --user: #95ec69;
      --assistant: #ffffff;
      --tool: #fff8e6;
      --event: #eef8f1;
      --danger: #d54941;
      --rail: #2e3033;
      --shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
      --control-height: 36px;
      --control-radius: 6px;
      --control-icon-size: 16px;
      --app-height: 100dvh;
      --visual-viewport-top: 0px;
    }
    * { box-sizing: border-box; }
    html,
    body {
      height: 100%;
    }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Noto Emoji";
      letter-spacing: 0;
      overflow: hidden;
    }
    [hidden] { display: none !important; }
    .app {
      height: 100vh;
      height: 100dvh;
      height: var(--app-height, 100dvh);
      min-height: 0;
      display: grid;
      grid-template-rows: auto 1fr auto;
      overflow: hidden;
    }
    header {
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      padding: 12px 18px;
      display: flex;
      gap: 14px;
      align-items: center;
      justify-content: space-between;
    }
    h1 {
      margin: 0;
      font-size: 18px;
      font-weight: 700;
    }
    .header-left,
    .header-right,
    .controls {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .segmented {
      display: inline-grid;
      grid-template-columns: repeat(6, 1fr);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
      background: #eef1f6;
    }
    .segmented button {
      border: 0;
      background: transparent;
      padding: 8px 12px;
      min-width: 74px;
      cursor: pointer;
      font: inherit;
      color: var(--muted);
    }
    .segmented button.active {
      background: var(--primary);
      color: white;
    }
    select,
    input,
    textarea,
    button {
      font: inherit;
    }
    select,
    input,
    textarea {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: white;
      color: var(--text);
    }
    select,
    input {
      height: 38px;
      padding: 0 10px;
    }
    main {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 0;
      min-height: 0;
      overflow: hidden;
    }
    .chat { min-height: 0; overflow: hidden; }
    .chat-workspace {
      height: 100%;
      min-height: 0;
      display: grid;
      grid-template-columns: 276px minmax(0, 1fr);
    }
    .conversation-sidebar {
      min-width: 0;
      display: flex;
      flex-direction: column;
      border-right: 1px solid var(--line);
      background: #f7f7f7;
    }
    .conversation-list-head {
      height: 52px;
      padding: 0 12px 0 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #e4e4e4;
    }
    .conversation-list-head strong { font-size: 14px; }
    .conversation-list-head .icon-button { width: 30px; height: 30px; }
    .conversation-list { min-height: 0; overflow: auto; }
    .conversation-group { border-bottom: 1px solid #e5e5e5; }
    .conversation-group-head {
      min-width: 0;
      height: 52px;
      padding: 0 10px 0 12px;
      display: grid;
      grid-template-columns: 34px minmax(0, 1fr) 20px;
      gap: 9px;
      align-items: center;
      color: var(--text);
      background: #f3f3f3;
    }
    button.conversation-group-head {
      width: 100%;
      border: 0;
      border-radius: 0;
      text-align: left;
      cursor: pointer;
    }
    button.conversation-group-head:hover { background: #ebebeb; }
    .conversation-group-head.batch { grid-template-columns: 18px 34px minmax(0, 1fr); cursor: pointer; }
    .conversation-group-head input,
    .conversation-item input {
      width: 16px;
      height: 16px;
      margin: 0;
      padding: 0;
      accent-color: var(--primary);
    }
    .conversation-group-avatar {
      width: 34px;
      height: 34px;
      border-radius: 6px;
      display: grid;
      place-items: center;
      overflow: hidden;
      background: hsl(var(--avatar-hue, 145) 52% 46%);
      color: #ffffff;
      font-size: 12px;
      font-weight: 700;
    }
    .conversation-group-avatar img { width: 100%; height: 100%; object-fit: cover; }
    .conversation-group-copy { min-width: 0; display: grid; gap: 2px; }
    .conversation-group-title { min-width: 0; display: flex; align-items: center; gap: 6px; }
    .conversation-group-copy strong,
    .conversation-group-copy span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .conversation-group-copy .conversation-group-title { overflow: visible; color: var(--text); }
    .conversation-group-title strong { min-width: 0; }
    .conversation-group-title .conversation-unread { flex: 0 0 auto; overflow: visible; color: #fff; }
    .conversation-group-copy strong { font-size: 13px; font-weight: 680; }
    .conversation-group-copy span { color: var(--muted); font-size: 10px; }
    .conversation-group-chevron { width: 15px; height: 15px; color: #8c9297; transition: transform 160ms ease; }
    .conversation-group.collapsed .conversation-group-chevron { transform: rotate(-90deg); }
    .conversation-group-sessions[hidden] { display: none; }
    .conversation-item {
      width: 100%;
      min-width: 0;
      min-height: 58px;
      padding: 7px 10px 7px 18px;
      border: 0;
      border-bottom: 1px solid #ececec;
      border-radius: 0;
      background: transparent;
      color: var(--text);
      display: grid;
      grid-template-columns: 28px minmax(0, 1fr);
      gap: 8px;
      align-items: center;
      text-align: left;
      cursor: pointer;
    }
    .conversation-item.batch { grid-template-columns: 18px 28px minmax(0, 1fr); padding-left: 12px; }
    .conversation-item.batch-disabled { cursor: default; opacity: 0.62; }
    .conversation-item:hover { background: #ededed; }
    .conversation-item.active { background: #dedede; }
    .conversation-item > .conversation-group-avatar { width: 28px; height: 28px; }
    .conversation-item.character-channel-item {
      min-height: 52px;
      padding-left: 34px;
      background: #fafafa;
    }
    .conversation-item.character-channel-item:hover { background: #eeeeee; }
    .conversation-item.character-channel-item .conversation-line strong { font-size: 12px; }
    .character-channel-avatar {
      position: relative;
      width: 30px;
      height: 30px;
      flex: 0 0 auto;
    }
    .character-channel-avatar > span {
      position: absolute;
      width: 20px;
      height: 20px;
      border: 2px solid #fafafa;
      border-radius: 5px;
      display: grid;
      place-items: center;
      overflow: hidden;
      color: #fff;
      font-size: 8px;
      font-weight: 700;
    }
    .character-channel-avatar > span:first-child { top: 0; left: 0; z-index: 1; }
    .character-channel-avatar > span:last-child { right: 0; bottom: 0; }
    .character-channel-avatar img { width: 100%; height: 100%; object-fit: cover; }
    .conversation-mode-icon {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      background: #e5e8e6;
      color: #59615c;
    }
    .conversation-mode-icon.rp { background: #e8e3ee; color: #6d5a7b; }
    .conversation-mode-icon svg { width: 14px; height: 14px; }
    .conversation-copy { min-width: 0; display: grid; gap: 4px; }
    .conversation-line { min-width: 0; display: flex; align-items: center; gap: 8px; }
    .conversation-line > svg { width: 12px; height: 12px; flex: 0 0 auto; color: #69716c; }
    .conversation-line strong,
    .conversation-preview { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .conversation-line strong { font-size: 13px; font-weight: 650; }
    .conversation-time { margin-left: auto; color: #a0a0a0; font-size: 10px; white-space: nowrap; }
    .conversation-unread {
      min-width: 18px;
      height: 18px;
      padding: 0 5px;
      border-radius: 9px;
      background: #e64b45;
      color: #fff;
      display: inline-grid;
      place-items: center;
      font-size: 10px;
      font-weight: 700;
    }
    .conversation-preview { color: var(--muted); font-size: 11px; }
    .conversation-list-empty { padding: 24px 14px; color: var(--muted); font-size: 12px; text-align: center; }
    .conversation-batch-bar {
      flex: 0 0 auto;
      padding: 10px 12px 12px;
      border-top: 1px solid #dddddd;
      background: #ffffff;
      display: grid;
      gap: 9px;
    }
    .conversation-batch-bar[hidden] { display: none; }
    .conversation-batch-summary,
    .conversation-batch-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .conversation-batch-summary strong { font-size: 12px; }
    .conversation-batch-actions button { flex: 1 1 0; }
    .text-button {
      padding: 3px 0;
      border: 0;
      background: transparent;
      color: #168653;
      font-size: 12px;
      cursor: pointer;
    }
    .danger-button {
      width: auto;
      height: var(--control-height);
      min-height: var(--control-height);
      padding: 0 13px;
      border: 1px solid #e4b8b5;
      border-radius: var(--control-radius);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      background: #ffffff;
      color: var(--danger);
      cursor: pointer;
    }
    .danger-button svg { width: var(--control-icon-size); height: var(--control-icon-size); }
    .danger-button:hover:not(:disabled) { background: #fff5f4; border-color: #d9938e; }
    .conversation-batch-actions button:disabled { opacity: 0.45; cursor: not-allowed; }
    .group-avatar-cluster {
      width: 100%;
      height: 100%;
      padding: 2px;
      border-radius: inherit;
      overflow: hidden;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      grid-auto-rows: minmax(0, 1fr);
      gap: 1px;
      background: #d9dddb;
    }
    .group-avatar-cluster.members-1 { grid-template-columns: 1fr; }
    .group-avatar-cluster.members-2 { display: flex; align-items: center; }
    .group-avatar-cluster.members-2 > span { flex: 1 1 0; height: auto; aspect-ratio: 1; }
    .group-avatar-cluster.members-3,
    .group-avatar-cluster.members-4 {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      grid-template-rows: repeat(2, minmax(0, 1fr));
    }
    .group-avatar-cluster.members-3 > span:first-child {
      width: calc(50% - 0.5px);
      grid-column: 1 / -1;
      justify-self: center;
    }
    .group-avatar-cluster.members-5,
    .group-avatar-cluster.members-6,
    .group-avatar-cluster.members-7,
    .group-avatar-cluster.members-8,
    .group-avatar-cluster.members-9 { grid-template-rows: repeat(3, minmax(0, 1fr)); }
    .group-avatar-cluster > span {
      min-width: 0;
      min-height: 0;
      border-radius: 2px;
      overflow: hidden;
      display: grid;
      place-items: center;
      background: #edf3ef;
      color: #176b45;
      font-size: 8px;
      font-weight: 700;
    }
    .group-avatar-cluster img { width: 100%; height: 100%; object-fit: cover; }
    .group-avatar-cluster.compact { width: 28px; height: 28px; border-radius: 6px; }
    .conversation-header-avatar.group {
      width: 38px;
      flex-basis: 38px;
      overflow: hidden;
      background: #d9dddb;
    }
    .conversation-header-avatar.group > .group-avatar-cluster { width: 100%; height: 100%; }
    .chat-thread { min-width: 0; min-height: 0; display: grid; grid-template-rows: 1fr auto; overflow: hidden; }
    .conversation-list-toggle { display: none; }
    .settings-page {
      grid-column: 1 / -1;
      padding: 18px;
      overflow: auto;
      background: var(--bg);
    }
    .settings-shell {
      max-width: 860px;
      margin: 0 auto;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 18px;
    }
    .settings-shell h2 {
      margin: 0 0 14px;
      font-size: 18px;
    }
    .settings-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .settings-field {
      display: grid;
      gap: 6px;
    }
    .settings-field.full {
      grid-column: 1 / -1;
    }
    .checkbox-row.full {
      grid-column: 1 / -1;
    }
    .settings-field label,
    .checkbox-row {
      color: var(--muted);
      font-size: 13px;
    }
    .checkbox-row {
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .checkbox-row input {
      width: 16px;
      height: 16px;
    }
    .settings-actions {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
      margin-top: 16px;
    }
    .model-profile-bar {
      display: grid;
      grid-template-columns: minmax(180px, 1fr) auto auto auto;
      gap: 8px;
      align-items: center;
      margin-bottom: 16px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--line);
    }
    .model-profile-bar select { min-width: 0; width: 100%; }
    .new-conversation-kind { margin: 0; padding: 0; border: 0; }
    .new-conversation-kind legend { margin-bottom: 7px; color: var(--muted); font-size: 12px; }
    .group-conversation-fields { display: grid; gap: 12px; }
    .new-conversation-note {
      margin: 0;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.55;
    }
    .group-member-picker {
      max-height: 220px;
      overflow: auto;
      border-block: 1px solid var(--line);
    }
    .group-member-option {
      min-height: 46px;
      padding: 8px 2px;
      display: grid;
      grid-template-columns: 18px 32px minmax(0, 1fr);
      gap: 9px;
      align-items: center;
      border-bottom: 1px solid var(--line);
      cursor: pointer;
    }
    .group-member-option:last-child { border-bottom: 0; }
    .group-member-option input { width: 16px; height: 16px; }
    .group-member-option .conversation-group-avatar { width: 32px; height: 32px; }
    .vault-health-panel {
      height: min(164px, 28vh);
      min-height: 130px;
      margin-top: 14px;
      overflow: auto;
      border-block: 1px solid var(--line);
    }
    .vault-health-row {
      display: grid;
      grid-template-columns: minmax(120px, 0.8fr) minmax(0, 1.4fr);
      gap: 12px;
      padding: 9px 2px;
      border-bottom: 1px solid var(--line);
      font-size: 12px;
    }
    .vault-health-row:last-child { border-bottom: 0; }
    .vault-health-row span:first-child { color: var(--muted); }
    .vault-health-row code { overflow-wrap: anywhere; }
    .schedule-shell {
      max-width: 1180px;
      margin: 0 auto;
      display: grid;
      gap: 16px;
    }
    .schedule-owner-head {
      min-width: 0;
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }
    .schedule-title-group { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
    .schedule-title-group h2 { margin: 0; font-size: 18px; }
    .schedule-owner-tabs { grid-template-columns: repeat(2, minmax(116px, 1fr)); }
    .schedule-owner-tabs button { min-width: 116px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
    .schedule-owner-tabs svg { width: 15px; height: 15px; }
    .schedule-character-field { min-width: 220px; display: grid; grid-template-columns: auto minmax(160px, 1fr); gap: 8px; align-items: center; color: var(--muted); font-size: 12px; }
    .schedule-view-tabs { display: none; grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .schedule-navigation { min-height: 36px; }
    .schedule-scope-summary { color: var(--muted); font-size: 12px; }
    .schedule-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .schedule-head h2 { margin: 0; font-size: 18px; }
    .schedule-filters { grid-template-columns: repeat(3, 1fr); }
    .schedule-editor {
      background: var(--panel);
      border-bottom: 1px solid var(--line);
      padding: 16px 0;
    }
    .schedule-form {
      display: grid;
      grid-template-columns: repeat(12, minmax(0, 1fr));
      gap: 12px;
    }
    .schedule-title-field { grid-column: span 6; }
    .schedule-kind-field,
    .schedule-recurrence-field { grid-column: span 3; }
    .schedule-all-day { grid-column: span 2; }
    .schedule-start-field,
    .schedule-end-field { grid-column: span 5; }
    .schedule-editor.without-end .schedule-start-field { grid-column: span 10; }
    .schedule-form .full { grid-column: 1 / -1; }
    .schedule-form label {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 13px;
    }
    .schedule-form textarea { min-height: 72px; max-height: 120px; }
    .schedule-list {
      background: var(--panel);
      border-top: 1px solid var(--line);
    }
    .schedule-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 14px;
      align-items: center;
      padding: 14px 0;
      border-bottom: 1px solid var(--line);
    }
    .schedule-title { margin: 0 0 5px; font-size: 15px; }
    .schedule-meta { color: var(--muted); font-size: 13px; line-height: 1.5; }
    .schedule-actions { display: flex; gap: 7px; flex-wrap: wrap; justify-content: flex-end; }
    .schedule-actions button { height: 34px; }
    .schedule-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .schedule-toolbar .primary { width: auto; height: 34px; padding: 0 12px; display: inline-flex; align-items: center; gap: 6px; }
    .schedule-toolbar .primary svg { width: 16px; height: 16px; }
    .schedule-month-nav { display: grid; grid-template-columns: 34px minmax(118px, auto) 34px; align-items: center; }
    .schedule-month-nav button { width: 34px; height: 34px; padding: 0; }
    .schedule-month-label { padding: 0 10px; text-align: center; font-size: 14px; font-weight: 650; }
    .schedule-dashboard { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(300px, 0.8fr); gap: 16px; align-items: start; }
    .schedule-side { min-width: 0; display: grid; gap: 16px; align-content: start; }
    .calendar-panel,
    .task-panel,
    .schedule-agenda {
      min-width: 0;
      border: 1px solid #dfdfdf;
      border-radius: 6px;
      background: #ffffff;
      box-shadow: var(--shadow);
    }
    .calendar-weekdays,
    .calendar-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); }
    .calendar-weekdays { border-bottom: 1px solid #e5e5e5; }
    .calendar-weekdays span { padding: 9px 4px; color: var(--muted); font-size: 11px; text-align: center; }
    .calendar-day {
      position: relative;
      min-width: 0;
      min-height: 92px;
      padding: 7px;
      border: 0;
      border-right: 1px solid #ececec;
      border-bottom: 1px solid #ececec;
      border-radius: 0;
      background: #ffffff;
      color: var(--text);
      text-align: left;
      cursor: pointer;
      overflow: hidden;
    }
    .calendar-day:nth-child(7n) { border-right: 0; }
    .calendar-day.outside { background: #fafafa; color: #aaa; }
    .calendar-day.today .calendar-day-number { background: var(--primary); color: #fff; }
    .calendar-day.selected { background: #effaf3; box-shadow: inset 0 0 0 2px #65c98b; }
    .calendar-day-number { width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; font-size: 12px; }
    .calendar-events { display: grid; gap: 3px; margin-top: 5px; }
    .calendar-event {
      min-width: 0;
      padding: 2px 4px;
      border-radius: 3px;
      background: #e8f5ed;
      color: #25643b;
      font-size: 10px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .calendar-event.event { background: #e9f1ff; color: #315b9d; }
    .calendar-event.reminder { background: #fff3d8; color: #8a6300; }
    .calendar-event.delivered,
    .calendar-event.completed { background: #eeeeee; color: #777777; text-decoration: line-through; }
    .calendar-event.failed { background: #fff0ef; color: #a43b35; }
    .calendar-more { color: var(--muted); font-size: 9px; }
    .task-panel-head,
    .schedule-agenda-head { padding: 13px 14px; border-bottom: 1px solid #e7e7e7; display: grid; gap: 8px; }
    .task-panel-head h3,
    .schedule-agenda-head h3 { margin: 0; font-size: 15px; }
    .task-filters { grid-template-columns: repeat(3, 1fr); }
    .task-list { max-height: 280px; overflow: auto; }
    .task-item { display: grid; grid-template-columns: 24px minmax(0, 1fr) 28px; gap: 8px; align-items: start; padding: 11px 12px; border-bottom: 1px solid #ededed; }
    .task-check,
    .task-edit { width: 24px; height: 24px; padding: 0; border: 0; background: transparent; color: #717171; cursor: pointer; }
    .task-check svg,
    .task-edit svg { width: 17px; height: 17px; }
    .task-item.completed .task-copy strong { color: #969696; text-decoration: line-through; }
    .task-copy { min-width: 0; display: grid; gap: 3px; }
    .task-copy strong { font-size: 13px; overflow-wrap: anywhere; }
    .task-copy span { color: var(--muted); font-size: 11px; }
    .schedule-agenda .schedule-list { border-top: 0; }
    .schedule-agenda .schedule-row { padding-inline: 14px; }
    .schedule-side .schedule-list { max-height: 320px; overflow: auto; }
    .schedule-side .schedule-row { grid-template-columns: minmax(0, 1fr); gap: 10px; padding-block: 12px; }
    .schedule-side .schedule-actions { justify-content: flex-start; }
    .schedule-status-badge { display: inline-flex; align-items: center; margin-left: 5px; padding: 1px 5px; border-radius: 4px; background: #eeeeee; color: #717171; font-size: 10px; font-weight: 500; }
    .schedule-status-badge.scheduled { background: #e8f5ed; color: #25643b; }
    .schedule-status-badge.failed { background: #fff0ef; color: #a43b35; }
    .schedule-empty { padding: 24px 14px; color: var(--muted); font-size: 12px; text-align: center; }
    .schedule-editor-dialog {
      width: min(760px, calc(100vw - 28px));
      max-height: calc(100vh - 40px);
      padding: 0;
      border: 1px solid #d8d8d8;
      border-radius: 8px;
      background: #fff;
      color: var(--text);
      box-shadow: 0 12px 34px rgba(0, 0, 0, 0.2);
    }
    .schedule-editor-dialog::backdrop { background: rgba(0, 0, 0, 0.28); }
    .schedule-editor-head { min-height: 58px; padding: 8px 10px 8px 16px; border-bottom: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; }
    .schedule-editor-head h3 { margin: 0; font-size: 15px; }
    .schedule-editor-head > div:first-child { display: grid; gap: 3px; }
    .schedule-editor-scope { color: var(--muted); font-size: 11px; }
    .schedule-editor-dialog .schedule-editor { padding: 16px; border: 0; }
    .schedule-form .schedule-all-day { align-self: end; min-height: 38px; display: inline-flex; align-items: center; gap: 8px; }
    .character-shell {
      max-width: 1120px;
      margin: 0 auto;
      display: grid;
      gap: 18px;
    }
    .character-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .character-head h2,
    .workspace-section h3 { margin: 0; font-size: 18px; }
    .entity-library-section { display: grid; gap: 10px; }
    .entity-library-section + .entity-library-section { padding-top: 16px; border-top: 1px solid var(--line); }
    .entity-library-head { min-height: 36px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .entity-library-head h3 { margin: 0; font-size: 14px; }
    .entity-library-head p { margin: 2px 0 0; color: var(--muted); font-size: 11px; }
    .character-picker { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .character-picker select { min-width: 220px; }
    .character-card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; }
    .world-card-grid { grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); }
    .character-card {
      min-width: 0;
      min-height: 94px;
      padding: 12px;
      border: 1px solid #dedede;
      border-radius: 6px;
      background: #ffffff;
      color: var(--text);
      display: grid;
      grid-template-columns: 56px minmax(0, 1fr);
      gap: 11px;
      align-items: center;
      text-align: left;
      cursor: pointer;
      box-shadow: var(--shadow);
    }
    .character-card:hover { border-color: #9ecfb0; }
    .character-card.active { border-color: var(--primary); box-shadow: inset 0 0 0 1px var(--primary); }
    .character-card.new { border-style: dashed; box-shadow: none; color: var(--muted); }
    .character-card-avatar,
    .avatar-preview {
      overflow: hidden;
      border-radius: 7px;
      background: hsl(var(--avatar-hue, 145) 52% 46%);
      color: #fff;
      display: grid;
      place-items: center;
      font-weight: 700;
    }
    .character-card-avatar { width: 52px; height: 52px; font-size: 18px; }
    .character-card-avatar img,
    .avatar-preview img,
    .conversation-avatar img,
    .message-avatar img,
    .brand-mark img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .character-card-copy { min-width: 0; display: grid; gap: 5px; }
    .character-card-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
    .character-card-copy span { color: var(--muted); font-size: 11px; line-height: 1.4; }
    .world-card .character-card-avatar { padding: 2px; background: #d9dddb; }
    .world-card-event { color: #24744a !important; }
    .world-card-event.planned { color: #8a650f !important; }
    .character-list-empty {
      min-height: 190px;
      border: 1px dashed #d7d7d7;
      display: grid;
      place-content: center;
      justify-items: center;
      gap: 8px;
      color: var(--muted);
    }
    .character-list-empty svg { width: 28px; height: 28px; stroke-width: 1.5; }
    .character-list-empty strong { color: var(--text); font-size: 14px; }
    .character-editor-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
    .avatar-editor { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 12px; align-items: center; }
    .avatar-preview { width: 72px; height: 72px; font-size: 22px; }
    .avatar-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .avatar-actions button { height: 34px; }
    .avatar-hint { grid-column: 2; color: var(--muted); font-size: 11px; }
    .character-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .character-grid .full { grid-column: 1 / -1; }
    .character-grid label {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 13px;
    }
    .character-grid input,
    .character-grid select,
    .character-grid textarea { width: 100%; min-width: 0; }
    .workspace-section {
      background: var(--panel);
      border-top: 1px solid var(--line);
      padding: 16px 0 0;
    }
    .workspace-section h3 { font-size: 16px; margin-bottom: 12px; }
    .memory-toolbar { display: grid; grid-template-columns: 1fr auto; gap: 8px; margin-bottom: 12px; }
    .memory-list { border-top: 1px solid var(--line); }
    .memory-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      padding: 12px 0;
      border-bottom: 1px solid var(--line);
      align-items: center;
    }
    .memory-content { line-height: 1.5; }
    .memory-actions { display: flex; gap: 7px; flex-wrap: wrap; justify-content: flex-end; }
    .character-detail {
      min-width: 0;
      border-top: 1px solid var(--line);
      background: var(--panel);
    }
    .character-detail-head {
      min-height: 66px;
      padding: 12px clamp(16px, 2vw, 22px);
      border-bottom: 1px solid var(--line);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .character-detail-title { min-width: 0; display: grid; gap: 2px; }
    .character-detail-title > span { color: var(--muted); font-size: 11px; }
    .character-detail-title h3 { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 17px; }
    .character-tabs { width: min(700px, 64vw); grid-template-columns: repeat(5, minmax(0, 1fr)); }
    .character-panel { min-width: 0; padding: 20px clamp(16px, 2vw, 22px) 22px; }
    .character-editor-form { display: grid; }
    .character-editor-head h4,
    .character-memory-head h4 { margin: 0; font-size: 15px; }
    .character-save-actions { justify-content: flex-end; }
    .character-save-actions .primary { min-width: 104px; }
    .character-memory-head {
      min-height: 40px;
      margin-bottom: 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .character-memory-head > div { display: flex; align-items: baseline; gap: 8px; }
    .character-memory-head .primary { width: auto; }
    .character-memory-head .primary svg { width: 16px; height: 16px; }
    #characterMemoryPanel .memory-toolbar { margin-bottom: 0; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
    #characterMemoryPanel .memory-list { border-top: 0; }
    .character-function-panel { display: grid; gap: 18px; }
    .character-function-head {
      min-height: 40px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .character-function-head > div { min-width: 0; display: flex; align-items: baseline; gap: 8px; }
    .character-function-head h4 { margin: 0; font-size: 15px; }
    .character-function-head-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
    }
    .character-function-head-actions .toggle { white-space: nowrap; }
    .character-function-head-actions button { width: auto; }
    .function-overview {
      display: grid;
      gap: 12px;
      padding: 15px 0;
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
    }
    .function-overview-primary {
      min-width: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
    }
    .function-role-copy { min-width: 0; display: grid; gap: 3px; }
    .function-role-copy span,
    .function-learning-summary { color: var(--muted); font-size: 11px; }
    .function-role-copy strong { overflow-wrap: anywhere; font-size: 16px; font-weight: 650; }
    .function-status-badge {
      flex: 0 0 auto;
      min-height: 26px;
      padding: 4px 8px;
      border: 1px solid #dce2df;
      border-radius: 5px;
      background: #f7f9f8;
      color: #59635e;
      font-size: 11px;
    }
    .function-status-badge.pending { border-color: #e7cc8d; background: #fff9e9; color: #856421; }
    .function-status-badge.ready { border-color: #b9d9c6; background: #f1faf5; color: #177348; }
    .function-status-badge.failed { border-color: #efc4c1; background: #fff5f4; color: #a23f38; }
    .function-capability-chips {
      min-width: 0;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .function-capability-chip {
      min-height: 26px;
      padding: 4px 8px;
      border: 1px solid #dfe4e1;
      border-radius: 5px;
      background: #fff;
      color: #3f4944;
      font-size: 11px;
    }
    .function-capability-chip.primary { border-color: #b7d7c3; background: #f2f9f5; color: #166f45; }
    .character-skill-document {
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 6px;
      overflow: hidden;
      background: #fff;
    }
    .character-skill-document-head {
      min-height: 48px;
      padding: 9px 11px;
      border-bottom: 1px solid var(--line);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      background: #f8faf9;
    }
    .character-skill-title { min-width: 0; display: grid; gap: 2px; }
    .character-skill-title strong { font-size: 13px; }
    .character-skill-title span { color: var(--muted); font-size: 10px; overflow-wrap: anywhere; }
    .character-skill-version-controls {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      gap: 7px;
    }
    .character-skill-version-controls select { width: auto; min-width: 108px; }
    .character-skill-version-controls button { width: auto; }
    .character-skill-markdown {
      min-height: 120px;
      padding: 15px 17px 18px;
      color: #303833;
      overflow-wrap: anywhere;
    }
    .character-skill-empty {
      min-height: 120px;
      display: grid;
      place-items: center;
      color: var(--muted);
      font-size: 12px;
    }
    .character-function-advanced {
      min-width: 0;
      border-top: 1px solid var(--line);
    }
    .character-function-advanced > summary {
      min-height: 42px;
      display: flex;
      align-items: center;
      gap: 7px;
      color: #49534e;
      font-size: 12px;
      font-weight: 620;
      cursor: pointer;
      list-style: none;
    }
    .character-function-advanced > summary::-webkit-details-marker { display: none; }
    .character-function-advanced > summary svg {
      width: 15px;
      height: 15px;
      transition: transform 160ms ease;
    }
    .character-function-advanced[open] > summary svg { transform: rotate(90deg); }
    .character-function-advanced > form { padding-top: 2px; }
    .function-profile-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 160px;
      gap: 12px;
      padding-block: 14px;
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
    }
    .function-profile-grid label {
      min-width: 0;
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 12px;
    }
    .function-profile-grid input,
    .function-profile-grid select,
    .function-profile-grid textarea { width: 100%; min-width: 0; }
    .function-profile-grid .full { grid-column: 1 / -1; }
    .function-profile-grid textarea { min-height: 76px; resize: vertical; }
    .capability-section-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
    }
    .capability-section-head h5 { margin: 0; font-size: 13px; }
    .capability-list { border-top: 1px solid var(--line); }
    .capability-row {
      padding: 13px 0;
      border-bottom: 1px solid var(--line);
      display: grid;
      gap: 11px;
      opacity: 0.7;
    }
    .capability-row.enabled { opacity: 1; }
    .capability-row-main {
      min-width: 0;
      display: grid;
      grid-template-columns: minmax(210px, 1fr) auto;
      align-items: center;
      gap: 14px;
    }
    .capability-identity {
      min-width: 0;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: start;
      gap: 10px;
    }
    .capability-identity input { margin-top: 3px; }
    .capability-copy { min-width: 0; display: grid; gap: 3px; }
    .capability-copy strong { font-size: 13px; }
    .capability-copy span { color: var(--muted); font-size: 11px; line-height: 1.45; }
    .capability-controls {
      display: grid;
      grid-template-columns: 86px 142px auto;
      align-items: end;
      gap: 9px;
    }
    .capability-level {
      display: grid;
      gap: 4px;
      color: var(--muted);
      font-size: 10px;
    }
    .capability-level select { width: 86px; }
    .capability-responsibility { height: var(--control-height); grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .capability-responsibility button { min-width: 0; padding-inline: 8px; font-size: 11px; }
    .capability-row:not(.enabled) .capability-responsibility button.active {
      background: #eef0ef;
      color: #8a918d;
    }
    .capability-auto { height: var(--control-height); white-space: nowrap; }
    .capability-evidence {
      color: var(--muted);
      font-size: 10px;
      font-variant-numeric: tabular-nums;
    }
    .capability-bindings {
      margin-left: 28px;
      border-top: 1px dashed #e3e6e4;
      padding-top: 9px;
    }
    .capability-bindings summary {
      width: fit-content;
      min-height: 28px;
      display: flex;
      align-items: center;
      gap: 6px;
      color: #4d5752;
      font-size: 11px;
      cursor: pointer;
      list-style: none;
    }
    .capability-bindings summary::-webkit-details-marker { display: none; }
    .capability-bindings summary svg { width: 14px; height: 14px; }
    .capability-binding-body { display: grid; gap: 10px; padding: 10px 0 2px; }
    .capability-module-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
      gap: 7px;
    }
    .capability-module-option {
      min-width: 0;
      min-height: 34px;
      padding: 6px 8px;
      border: 1px solid #e1e5e2;
      border-radius: 6px;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 7px;
      background: #fafbfa;
      color: #46504b;
      font-size: 11px;
    }
    .capability-module-option.recommended { border-color: #bcd9c7; background: #f5faf7; }
    .capability-module-option span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .capability-module-option small { color: var(--muted); font-size: 9px; }
    .capability-module-option small.on { color: #168653; }
    .capability-notes {
      display: grid;
      gap: 5px;
      color: var(--muted);
      font-size: 11px;
    }
    .capability-notes textarea { width: 100%; min-height: 58px; resize: vertical; }
    .character-function-actions { justify-content: flex-end; }
    .character-function-actions .primary { min-width: 104px; }
    .relationship-panel { display: grid; gap: 18px; }
    .relationship-head {
      min-height: 40px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .relationship-head-copy { min-width: 0; display: flex; align-items: baseline; gap: 8px; }
    .relationship-head h4 { margin: 0; font-size: 15px; }
    .relationship-overview {
      display: grid;
      grid-template-columns: minmax(180px, 0.7fr) minmax(0, 1.3fr);
      gap: 18px;
      padding: 16px 0;
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
    }
    .relationship-stage { display: grid; align-content: start; gap: 8px; }
    .relationship-stage-label { color: var(--muted); font-size: 11px; }
    .relationship-stage strong { font-size: 22px; font-weight: 650; }
    .relationship-definition { display: grid; gap: 7px; margin-top: 3px; }
    .relationship-definition-row { display: flex; align-items: baseline; gap: 7px; font-size: 12px; }
    .relationship-definition-row span { color: var(--muted); }
    .relationship-definition-row b { color: #303733; font-weight: 620; }
    .relationship-bonds { display: flex; flex-wrap: wrap; gap: 5px; }
    .relationship-bond-chip {
      min-height: 24px;
      padding: 3px 7px;
      border: 1px solid #d9dfdc;
      border-radius: 5px;
      background: #fff;
      color: #46504b;
      font-size: 11px;
    }
    .affect-summary { display: flex; flex-wrap: wrap; gap: 6px; }
    .affect-chip {
      min-height: 25px;
      padding: 4px 8px;
      border: 1px solid #dfe3e1;
      border-radius: 6px;
      background: #f6f8f7;
      color: #4e5752;
      font-size: 11px;
    }
    .relationship-metrics { display: grid; gap: 10px; }
    .relationship-metric { display: grid; grid-template-columns: 52px minmax(0, 1fr) 32px; gap: 10px; align-items: center; font-size: 12px; }
    .relationship-metric > span:first-child { color: #4d5551; }
    .relationship-metric > strong { text-align: right; font-size: 12px; font-variant-numeric: tabular-nums; }
    .relationship-meter { height: 7px; overflow: hidden; border-radius: 4px; background: #e8ebe9; }
    .relationship-meter > i { display: block; height: 100%; border-radius: inherit; background: #38a169; }
    .relationship-metric[data-tone="warm"] .relationship-meter > i { background: #d58a36; }
    .relationship-metric[data-tone="cool"] .relationship-meter > i { background: #4789b8; }
    .relationship-metric[data-tone="alert"] .relationship-meter > i { background: #d65a5a; }
    .relationship-events h5 { margin: 0 0 8px; font-size: 13px; }
    .relationship-event-list { border-top: 1px solid var(--line); }
    .relationship-event {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      padding: 11px 0;
      border-bottom: 1px solid var(--line);
    }
    .relationship-event-copy { min-width: 0; display: grid; gap: 4px; }
    .relationship-event-copy strong { font-size: 12px; }
    .relationship-event-copy p { margin: 0; color: #4f5753; font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
    .relationship-event-copy time { color: var(--muted); font-size: 10px; }
    .relationship-delta { align-self: center; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px; max-width: 190px; }
    .relationship-delta span { padding: 2px 5px; border-radius: 4px; background: #f0f2f1; color: #5b625f; font-size: 10px; font-variant-numeric: tabular-nums; }
    .relationship-empty { padding: 28px 10px; color: var(--muted); text-align: center; font-size: 12px; }
    .character-life-panel { display: grid; gap: 18px; }
    .character-life-head,
    .life-world-binding {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .character-life-head > div { min-width: 0; display: flex; align-items: baseline; gap: 8px; }
    .character-life-head h4 { margin: 0; font-size: 15px; }
    .life-world-binding { padding-block: 12px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
    .life-world-binding label { flex: 1; display: grid; grid-template-columns: auto minmax(180px, 1fr); align-items: center; gap: 10px; color: var(--muted); font-size: 12px; }
    .life-runtime-band {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
    }
    .life-runtime-band > div { min-width: 0; padding: 13px 12px; display: grid; gap: 4px; border-right: 1px solid var(--line); }
    .life-runtime-band > div:last-child { border-right: 0; }
    .life-runtime-band span { color: var(--muted); font-size: 10px; }
    .life-runtime-band strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
    .life-settings-band { display: grid; gap: 14px; }
    .life-settings-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    .life-settings-grid > label { display: grid; gap: 6px; color: var(--muted); font-size: 12px; }
    .life-toggle-stack { display: grid; align-content: end; gap: 8px; }
    .life-toggle-stack .toggle { justify-content: space-between; }
    .life-actions { justify-content: flex-end; }
    .life-proactive-pause {
      min-height: 40px;
      padding: 8px 10px;
      border: 1px solid #ead8aa;
      border-radius: 6px;
      background: #fff9e9;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      color: #765b1e;
      font-size: 12px;
    }
    .life-proactive-pause[hidden] { display: none; }
    .life-proactive-pause button { min-height: 30px; padding: 0 9px; }
    .life-detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
    .life-detail-section { min-width: 0; }
    .life-detail-section h5 { margin: 0 0 8px; font-size: 13px; }
    .life-place-list,
    .life-event-list,
    .world-place-list { border-top: 1px solid var(--line); }
    .life-place-row,
    .life-event-row,
    .world-place-row { padding: 10px 0; border-bottom: 1px solid var(--line); display: grid; gap: 5px; }
    .life-place-row strong,
    .life-event-row strong,
    .world-place-row strong { font-size: 12px; }
    .life-place-row p,
    .life-event-row p,
    .world-place-row p { margin: 0; color: #525a56; font-size: 11px; line-height: 1.5; }
    .life-capabilities { display: flex; flex-wrap: wrap; gap: 4px; }
    .life-capabilities span { padding: 2px 6px; border-radius: 4px; background: #eef3f0; color: #466052; font-size: 10px; }
    .life-event-row time { color: var(--muted); font-size: 10px; }
    .life-proactive-list,
    .life-topic-policy-list { border-top: 1px solid var(--line); }
    .life-proactive-row,
    .life-topic-policy-row {
      min-width: 0;
      padding: 10px 0;
      border-bottom: 1px solid var(--line);
      display: grid;
      gap: 5px;
    }
    .life-proactive-row-head,
    .life-topic-policy-row { grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px; }
    .life-proactive-row-head { display: grid; }
    .life-proactive-row strong,
    .life-topic-policy-row strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
    .life-proactive-row p { margin: 0; color: #525a56; font-size: 11px; line-height: 1.45; overflow-wrap: anywhere; }
    .life-proactive-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; color: var(--muted); font-family: Arial, sans-serif; font-size: 10px; font-variant-numeric: normal; letter-spacing: 0; }
    .life-decision-badge { padding: 2px 5px; border-radius: 4px; background: #eef1ef; color: #505a54; }
    .life-decision-badge.delivered { background: #e7f5ec; color: #287243; }
    .life-decision-badge.failed { background: #fbeaea; color: #a33d3d; }
    .life-decision-badge.pending { background: #fff4d9; color: #81621d; }
    .life-topic-mode { color: var(--muted); font-size: 11px; }
    .life-topic-policy-row button { width: 30px; height: 30px; padding: 0; }
    .life-empty-row { padding: 24px 8px; color: var(--muted); font-size: 12px; text-align: center; }
    .memory-empty { padding: 38px 12px; color: var(--muted); text-align: center; font-size: 13px; }
    .memory-editor-dialog { width: min(680px, calc(100vw - 28px)); }
    .memory-editor-form { padding: 18px; display: grid; gap: 16px; }
    .memory-editor-form textarea { min-height: 112px; }
    .management-shell {
      max-width: 1080px;
      margin: 0 auto;
      display: grid;
      gap: 14px;
    }
    .management-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .management-head h2 { margin: 0; font-size: 18px; }
    .management-tabs { grid-template-columns: repeat(3, 1fr); }
    .management-panel {
      background: var(--panel);
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
      padding: 16px;
      min-width: 0;
    }
    .management-panel h3 {
      margin: 0 0 12px;
      font-size: 15px;
    }
    .module-list { border-top: 1px solid var(--line); }
    .module-row {
      min-width: 0;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto auto;
      gap: 12px;
      align-items: center;
      padding: 13px 0;
      border-bottom: 1px solid var(--line);
    }
    .module-detail-button { width: 32px; height: 32px; }
    .module-detail-dialog,
    .message-edit-dialog {
      width: min(720px, calc(100vw - 28px));
      max-height: min(720px, calc(100vh - 40px));
      padding: 0;
      border: 1px solid #d8d8d8;
      border-radius: 8px;
      background: #ffffff;
      color: var(--text);
      box-shadow: 0 12px 34px rgba(0, 0, 0, 0.2);
    }
    .module-detail-dialog::backdrop,
    .message-edit-dialog::backdrop { background: rgba(0, 0, 0, 0.28); }
    .module-detail-content {
      max-height: min(620px, calc(100vh - 112px));
      padding: 16px 18px 26px;
      overflow: auto;
    }
    .module-detail-meta { margin-bottom: 12px; color: var(--muted); font-size: 11px; }
    .message-edit-form { padding: 16px; display: grid; gap: 12px; }
    .message-edit-form textarea { min-height: 150px; max-height: 46vh; resize: vertical; }
    .character-channel-dialog {
      width: min(680px, calc(100vw - 28px));
      height: min(760px, calc(100dvh - 36px));
      overflow: hidden;
    }
    .character-channel-dialog[open] { display: grid; grid-template-rows: 52px auto minmax(0, 1fr); }
    .character-channel-dialog::backdrop { background: rgba(0, 0, 0, 0.34); }
    .character-channel-participants {
      min-width: 0;
      padding: 12px 16px;
      display: flex;
      align-items: center;
      gap: 10px;
      border-bottom: 1px solid var(--line);
      background: #f8f9f8;
    }
    .character-channel-participants strong {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
    }
    .character-channel-participants span:last-child {
      margin-left: auto;
      color: var(--muted);
      font-size: 11px;
      white-space: nowrap;
    }
    .character-channel-messages {
      min-height: 0;
      padding: 16px;
      overflow: auto;
      background: #ededed;
      overscroll-behavior: contain;
    }
    .character-channel-message {
      margin: 0 0 14px;
      display: grid;
      grid-template-columns: 36px minmax(0, 1fr);
      gap: 9px;
      align-items: start;
    }
    .character-channel-message-avatar {
      width: 36px;
      height: 36px;
      border-radius: 6px;
      display: grid;
      place-items: center;
      overflow: hidden;
      background: hsl(var(--avatar-hue, 145) 52% 46%);
      color: #fff;
      font-size: 11px;
      font-weight: 700;
    }
    .character-channel-message-avatar img { width: 100%; height: 100%; object-fit: cover; }
    .character-channel-message-copy { min-width: 0; display: grid; justify-items: start; gap: 4px; }
    .character-channel-message-meta { color: #858585; font-size: 10px; }
    .character-channel-message-bubble {
      max-width: min(520px, 86%);
      padding: 9px 11px;
      border-radius: 5px;
      background: #fff;
      color: var(--text);
      font-size: 13px;
      line-height: 1.55;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }
    .character-channel-system {
      margin: 10px auto 16px;
      width: fit-content;
      max-width: 88%;
      padding: 4px 8px;
      border-radius: 4px;
      background: rgba(0, 0, 0, 0.08);
      color: #747474;
      font-size: 10px;
      text-align: center;
    }
    .character-channel-empty {
      min-height: 180px;
      display: grid;
      place-items: center;
      color: var(--muted);
      font-size: 12px;
    }
    .character-profile-dialog {
      width: min(640px, calc(100vw - 28px));
      max-height: min(780px, calc(100dvh - 28px));
      padding: 0;
      border: 1px solid #d8d8d8;
      border-radius: 8px;
      background: #ffffff;
      color: var(--text);
      box-shadow: 0 12px 34px rgba(0, 0, 0, 0.2);
      overflow: hidden;
    }
    .character-profile-dialog[open] { display: flex; flex-direction: column; }
    .character-profile-dialog::backdrop { background: rgba(0, 0, 0, 0.34); }
    .character-profile-content { min-height: 0; overflow: auto; overscroll-behavior: contain; }
    .character-profile-identity {
      min-height: 132px;
      padding: 24px 22px;
      display: grid;
      grid-template-columns: 84px minmax(0, 1fr);
      align-items: center;
      gap: 18px;
      border-bottom: 1px solid var(--line);
      background: #ffffff;
    }
    .character-profile-avatar {
      width: 84px;
      height: 84px;
      border-radius: 8px;
      display: grid;
      place-items: center;
      overflow: hidden;
      background: hsl(var(--avatar-hue, 145) 52% 46%);
      color: #ffffff;
      font-size: 28px;
      font-weight: 700;
    }
    .character-profile-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .character-profile-name { min-width: 0; display: grid; gap: 5px; }
    .character-profile-name h3 { margin: 0; overflow-wrap: anywhere; font-size: 21px; line-height: 1.3; }
    .character-profile-name span { color: var(--muted); font-size: 11px; }
    .character-profile-soul { padding: 18px 22px 28px; background: #ffffff; }
    .character-profile-soul > h3 { margin: 0 0 14px; font-size: 14px; }
    .character-profile-soul .markdown-body { color: #303632; font-size: 13px; line-height: 1.7; }
    .character-profile-empty { margin: 0; padding: 28px 0; color: var(--muted); text-align: center; }
    .module-type {
      min-width: 48px;
      padding: 3px 7px;
      border-radius: 6px;
      background: #e6f7fa;
      color: #0e6674;
      font-size: 11px;
      font-weight: 700;
      text-align: center;
    }
    .module-type.skill { background: #eaf7ee; color: #25643b; }
    .module-name { font-size: 14px; font-weight: 700; }
    .module-description { margin-top: 3px; color: #465468; font-size: 12px; line-height: 1.45; }
    .module-metadata { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 3px; }
    .module-source { color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
    .module-token { color: #344054; font-size: 11px; }
    .permission-section {
      margin-top: 22px;
      padding-top: 16px;
      border-top: 1px solid var(--line);
    }
    .permission-path {
      max-width: 62%;
      overflow-wrap: anywhere;
      text-align: right;
      font-size: 11px;
      color: var(--muted);
    }
    .permission-list { border-top: 1px solid var(--line); }
    .memory-manager-toolbar {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr)) auto;
      gap: 8px;
      margin-bottom: 14px;
    }
    .memory-manager-toolbar input,
    .memory-manager-toolbar select { width: 100%; min-width: 0; }
    .memory-manager-form {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
      padding: 14px 0;
      border-top: 1px solid var(--line);
    }
    .memory-manager-form label { display: grid; gap: 5px; min-width: 0; color: var(--muted); font-size: 12px; }
    .memory-manager-form .full { grid-column: 1 / -1; }
    .memory-manager-form input,
    .memory-manager-form select,
    .memory-manager-form textarea { width: 100%; min-width: 0; }
    .memory-source { margin-top: 4px; color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
    .memory-badges { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
    .memory-badge {
      padding: 2px 6px;
      border: 1px solid #d7dee8;
      border-radius: 5px;
      background: #f7f9fc;
      color: #465468;
      font-size: 10px;
      font-weight: 700;
    }
    .memory-badge.core { border-color: #97d7ad; background: #effaf2; color: #25643b; }
    .person-directory {
      margin: 14px 0;
      padding: 14px 0;
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
    }
    .person-profile-list { display: grid; gap: 8px; }
    .person-profile {
      border: 1px solid var(--line);
      border-radius: 7px;
      background: #fafbfc;
      overflow: hidden;
    }
    .person-profile > summary {
      min-height: 54px;
      padding: 10px 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      cursor: pointer;
      list-style: none;
    }
    .person-profile > summary::-webkit-details-marker { display: none; }
    .person-profile-title { min-width: 0; display: grid; gap: 3px; }
    .person-profile-title strong { overflow-wrap: anywhere; font-size: 14px; }
    .person-profile-meta { color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
    .person-profile-form {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      padding: 12px;
      border-top: 1px solid var(--line);
      background: white;
    }
    .person-profile-form label { display: grid; gap: 5px; min-width: 0; color: var(--muted); font-size: 12px; }
    .person-profile-form input,
    .person-profile-form select,
    .person-profile-form textarea { width: 100%; min-width: 0; }
    .person-profile-form .full { grid-column: 1 / -1; }
    .person-profile-form textarea { min-height: 180px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .person-visibility-list { display: flex; flex-wrap: wrap; gap: 6px 12px; }
    .person-visibility-list label { display: inline-flex; align-items: center; grid-template-columns: auto 1fr; gap: 6px; color: var(--text); }
    .person-visibility-list input { width: 16px; height: 16px; }
    .retrieval-preview {
      margin: 14px 0;
      padding: 12px 0;
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
    }
    .retrieval-preview-toolbar {
      display: grid;
      grid-template-columns: 110px minmax(180px, 1fr) 120px auto;
      gap: 8px;
    }
    .retrieval-preview-toolbar input,
    .retrieval-preview-toolbar select { width: 100%; min-width: 0; }
    .retrieval-preview-results {
      max-height: 260px;
      margin-top: 10px;
      overflow: auto;
      border-top: 1px solid var(--line);
    }
    .retrieval-preview-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      padding: 9px 0;
      border-bottom: 1px solid var(--line);
      font-size: 12px;
    }
    .memory-job-list { border-top: 1px solid var(--line); margin-top: 18px; }
    .memory-job-row { padding: 10px 0; border-bottom: 1px solid var(--line); display: grid; gap: 4px; }
    .permission-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 14px;
      align-items: center;
      min-width: 0;
      padding: 13px 0;
      border-bottom: 1px solid var(--line);
    }
    .permission-access { grid-template-columns: repeat(3, minmax(72px, 1fr)); }
    .permission-runtime { margin-top: 9px; }
    .toggle {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
      cursor: pointer;
    }
    .toggle input {
      appearance: none;
      width: 42px;
      height: 24px;
      margin: 0;
      padding: 0;
      border: 1px solid #a9b3c2;
      border-radius: 12px;
      background: #d9dee7;
      position: relative;
      cursor: pointer;
      transition: background 140ms ease, border-color 140ms ease;
    }
    .toggle input::after {
      content: "";
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: white;
      position: absolute;
      top: 2px;
      left: 2px;
      box-shadow: 0 1px 2px rgba(16, 24, 40, 0.2);
      transition: transform 140ms ease;
    }
    .toggle input:checked { border-color: var(--primary); background: var(--primary); }
    .toggle input:checked::after { transform: translateX(18px); }
    .toggle input:disabled { opacity: 0.55; cursor: not-allowed; }
    .toggle:has(input:disabled) { cursor: not-allowed; }
    .profile-document-form {
      display: grid;
      gap: 12px;
    }
    .user-insight-section {
      margin-top: 22px;
      padding-top: 18px;
      border-top: 1px solid var(--line);
    }
    .user-insight-summary {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 0;
      margin: 4px 0 10px;
    }
    .user-insight-summary span { white-space: nowrap; }
    .user-insight-summary span + span::before { content: "·"; margin: 0 10px; color: #a0a0a0; }
    .user-insight-list { border-top: 1px solid var(--line); }
    #profileState,
    .user-insight-row .schedule-meta {
      font-family: Arial, sans-serif;
      font-variant-numeric: tabular-nums;
      letter-spacing: 0;
    }
    .user-insight-row {
      display: grid;
      gap: 5px;
      padding: 12px 0;
      border-bottom: 1px solid var(--line);
    }
    .user-insight-main {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .user-insight-claim { min-width: 0; line-height: 1.5; overflow-wrap: anywhere; }
    .user-insight-decision {
      flex: 0 0 auto;
      padding: 2px 7px;
      border: 1px solid #d7dee8;
      border-radius: 5px;
      background: #f7f9fc;
      color: #465468;
      font-size: 10px;
      font-weight: 700;
    }
    .user-insight-decision[data-decision="promoted"] { border-color: #97d7ad; background: #effaf2; color: #25643b; }
    .user-insight-decision[data-decision="blocked_sensitive"] { border-color: #efb7b7; background: #fff4f4; color: #9b2c2c; }
    .user-insight-decision[data-decision="accumulating"] { border-color: #e5c583; background: #fff9e8; color: #805b13; }
    .user-insight-decision[data-decision="conflicted"] { border-color: #e5c583; background: #fff9e8; color: #805b13; }
    .user-insight-evidence summary {
      width: fit-content;
      color: var(--muted);
      font-size: 11px;
      cursor: pointer;
    }
    .user-insight-evidence pre {
      max-height: 180px;
      margin: 8px 0 0;
      padding: 9px;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 5px;
      background: #f7f8fa;
      color: #344054;
      font-size: 11px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .user-insight-row-actions { display: flex; align-items: center; gap: 6px; }
    .user-insight-row-actions .icon-button { width: 28px; height: 28px; }
    .profile-markdown,
    .character-soul-markdown {
      min-height: 360px;
      height: min(52vh, 520px);
      max-height: none;
      resize: vertical;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      line-height: 1.6;
      tab-size: 2;
    }
    .character-soul-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .character-soul-head h4 { margin: 0; color: var(--text); font-size: 14px; }
    .profile-character-count.error,
    .character-soul-count.error { color: var(--danger); }
    .secondary {
      height: 38px;
      padding: 0 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: white;
      color: var(--text);
      cursor: pointer;
    }
    .messages {
      overflow: auto;
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .bubble {
      max-width: min(760px, 92%);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 12px;
      background: var(--assistant);
      line-height: 1.5;
    }
    .bubble-text {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .bubble.user {
      margin-left: auto;
      background: var(--user);
      border-color: #bfd3f8;
    }
    .bubble.assistant {
      margin-right: auto;
    }
    .meta {
      display: block;
      margin-bottom: 4px;
      color: var(--muted);
      font-size: 12px;
    }
    .message-progress {
      margin: 0 0 7px;
      padding: 0;
      border: 0;
      color: #465468;
      font-size: 12px;
      white-space: normal;
    }
    .message-progress summary {
      min-height: 26px;
      cursor: pointer;
      color: #344054;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-weight: 600;
      list-style: none;
      user-select: none;
    }
    .message-progress summary::-webkit-details-marker { display: none; }
    .message-progress summary::marker { content: ""; }
    .progress-chevron {
      flex: 0 0 auto;
      width: 14px;
      height: 14px;
      color: #8a9199;
      transition: transform 140ms ease;
    }
    .message-progress[open] .progress-chevron { transform: rotate(90deg); }
    .progress-summary { min-width: 0; display: inline-flex; align-items: center; }
    .typing-indicator {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      color: #5f676f;
      font-weight: 500;
    }
    .typing-dots {
      height: 12px;
      display: inline-flex;
      align-items: center;
      gap: 3px;
    }
    .typing-dot {
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: #6f777f;
      opacity: 0.35;
      animation: message-typing-dot 1.1s ease-in-out infinite;
    }
    .typing-dot:nth-child(2) { animation-delay: 140ms; }
    .typing-dot:nth-child(3) { animation-delay: 280ms; }
    @keyframes message-typing-dot {
      0%, 60%, 100% { opacity: 0.35; transform: translateY(0); }
      30% { opacity: 1; transform: translateY(-2px); }
    }
    @media (prefers-reduced-motion: reduce) {
      .typing-dot { animation: none; opacity: 0.65; }
      .progress-chevron { transition: none; }
    }
    .progress-state { margin-left: 7px; color: var(--muted); font-weight: 400; }
    .progress-state.active { color: #1d4ed8; }
    .progress-state.failed { color: var(--danger); }
    .progress-list {
      display: grid;
      gap: 4px;
      margin: 5px 0 2px 20px;
      padding: 7px 9px;
      border-left: 2px solid #d9dde1;
      background: #f7f8f9;
      list-style: none;
    }
    .progress-step {
      display: grid;
      grid-template-columns: 14px minmax(0, 1fr);
      gap: 6px;
      align-items: start;
    }
    .progress-step-body { min-width: 0; }
    .progress-mark { color: #667085; text-align: center; }
    .progress-step.active .progress-mark { color: #2563eb; }
    .progress-step.failed .progress-mark { color: var(--danger); }
    .progress-tool-result {
      margin-top: 3px;
      color: #59616b;
    }
    .progress-tool-result summary {
      min-height: 22px;
      gap: 7px;
      color: #667085;
      font-size: 11px;
      font-weight: 500;
    }
    .progress-tool-result[open] summary { margin-bottom: 4px; }
    .progress-tool-size { color: #8a9199; font-weight: 400; }
    .progress-tool-output {
      max-height: 320px;
      margin: 0;
      overflow: auto;
      padding: 7px 9px;
      border: 0;
      border-left: 2px solid #d8dde3;
      border-radius: 0;
      background: rgba(255, 255, 255, 0.72);
      color: #39414a;
      font: 11px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }
    .composer {
      border-top: 1px solid var(--line);
      padding: 12px;
      background: var(--panel);
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto auto;
      gap: 10px;
      align-items: end;
    }
    textarea {
      width: 100%;
      min-height: 48px;
      max-height: 160px;
      resize: vertical;
      padding: 10px 12px;
      line-height: 1.45;
    }
    .primary {
      height: 48px;
      padding: 0 18px;
      border: 0;
      border-radius: 8px;
      color: white;
      background: var(--primary);
      cursor: pointer;
    }
    .primary:disabled {
      opacity: 0.55;
      cursor: wait;
    }
    .primary:hover:not(:disabled) {
      background: var(--primary-strong);
    }
    .composer .secondary { height: 48px; min-width: 48px; padding: 0 12px; }
    aside {
      background: var(--panel);
      min-height: 0;
      display: grid;
      grid-template-rows: auto 1fr;
      overflow: hidden;
    }
    .side-head {
      padding: 14px;
      border-bottom: 1px solid var(--line);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .side-head h2 {
      margin: 0;
      font-size: 15px;
    }
    .debug-workspace {
      min-height: 0;
      display: grid;
      grid-template-columns: 280px minmax(0, 1fr);
      grid-template-rows: auto minmax(0, 1fr);
      overflow: hidden;
    }
    .trace-scope-tabs {
      grid-column: 1 / -1;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    .trace-scope-tabs[hidden] { display: none; }
    .trace-scope-tabs button {
      min-width: 0;
      height: 32px;
      padding: 0 11px;
      border: 1px solid transparent;
      border-radius: 6px;
      background: transparent;
      color: var(--muted);
      font-size: 12px;
      cursor: pointer;
    }
    .trace-scope-tabs button:hover { background: #f0f3f7; }
    .trace-scope-tabs button.active {
      border-color: #a9bde6;
      background: #eaf1ff;
      color: #2454a6;
      font-weight: 700;
    }
    .trace-scope-count {
      margin-left: 5px;
      font-variant-numeric: tabular-nums;
    }
    .mobile-trace-select { display: none; }
    .trace-index {
      min-width: 0;
      min-height: 0;
      overflow: auto;
      padding: 10px;
      border-right: 1px solid var(--line);
      background: #f8fafc;
      display: flex;
      flex-direction: column;
      gap: 7px;
    }
    .trace-index-item {
      width: 100%;
      min-width: 0;
      padding: 9px 10px;
      border: 1px solid transparent;
      border-radius: 7px;
      background: transparent;
      color: var(--text);
      text-align: left;
      cursor: pointer;
      display: grid;
      gap: 5px;
    }
    .trace-index-item:hover { background: #eef2f7; }
    .trace-index-item.active {
      border-color: #9bb8ef;
      background: #eaf1ff;
    }
    .trace-index-title {
      display: -webkit-box;
      overflow: hidden;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      font-size: 13px;
      font-weight: 700;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .trace-index-meta {
      color: var(--muted);
      font-size: 11px;
      line-height: 1.3;
    }
    .trace-inspector,
    .trace-detail {
      min-width: 0;
      min-height: 0;
      overflow: hidden;
    }
    .trace-detail {
      height: 100%;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
    }
    .trace-detail-head {
      padding: 10px 14px;
      border-bottom: 1px solid var(--line);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px 18px;
      flex-wrap: wrap;
    }
    .trace-detail-title {
      margin: 0 0 3px;
      font-size: 14px;
      overflow-wrap: anywhere;
    }
    .trace-detail-meta {
      color: var(--muted);
      font-size: 11px;
    }
    .trace-actions,
    .trace-view-tabs {
      display: flex;
      align-items: center;
      gap: 7px;
      flex-wrap: wrap;
    }
    .trace-view-tabs {
      padding: 3px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: #eef1f6;
    }
    .trace-view-tabs button {
      height: 30px;
      padding: 0 10px;
      border: 0;
      border-radius: 5px;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
    }
    .trace-view-tabs button.active {
      background: white;
      color: var(--text);
      box-shadow: 0 1px 2px rgba(16, 24, 40, 0.12);
    }
    .trace-actions > .secondary {
      height: 36px;
      padding-inline: 10px;
      font-size: 12px;
    }
    .trace-content {
      min-width: 0;
      min-height: 0;
      overflow: auto;
      padding: 12px 14px 28px;
      display: flex;
      flex-direction: column;
      gap: 9px;
      scroll-behavior: smooth;
    }
    .trace-block {
      flex: 0 0 auto;
      border-left: 4px solid #7b8798;
      background: #f3f5f8;
    }
    .trace-block.system { border-color: #e11d48; background: #fff1f2; }
    .trace-block.user { border-color: #2563eb; background: #eff6ff; }
    .trace-block.assistant { border-color: #16a34a; background: #f0fdf4; }
    .trace-block.tool { border-color: #d97706; background: #fffbeb; }
    .trace-block.schema { border-color: #0891b2; background: #ecfeff; }
    .trace-block.parameters { border-color: #64748b; background: #f8fafc; }
    .trace-block.economics { border-color: #5b6472; background: #f7f8fa; }
    .trace-quantity-summary {
      flex: 0 0 auto;
      padding: 10px;
      border: 1px solid var(--line);
      background: #f8fafc;
    }
    .trace-quantity-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 8px;
    }
    .trace-quantity-head strong { font-size: 12px; }
    .trace-quantity-head span { color: var(--muted); font-size: 10px; }
    .economics-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
    }
    .economics-metric {
      min-width: 0;
      padding: 9px;
      border: 1px solid var(--line);
      background: #fafafa;
    }
    .economics-metric span { display: block; color: var(--muted); font-size: 10px; }
    .economics-metric strong { display: block; margin-top: 3px; font-size: 14px; overflow-wrap: anywhere; }
    .retrieval-candidate { padding: 7px 0; border-top: 1px solid var(--line); font-size: 12px; }
    .retrieval-candidate:first-child { border-top: 0; }
    .trace-block summary {
      min-height: 38px;
      padding: 8px 10px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      color: #344054;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
    }
    .trace-block-size {
      color: var(--muted);
      font-weight: 400;
      text-transform: none;
      white-space: nowrap;
    }
    .trace-block pre,
    .trace-json {
      margin: 0;
      padding: 10px 12px 14px;
      border-top: 1px solid rgba(99, 112, 131, 0.18);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-size: 12px;
      line-height: 1.55;
      tab-size: 2;
    }
    .trace-content.nowrap pre {
      white-space: pre;
      overflow-wrap: normal;
    }
    .trace-json {
      flex: 0 0 auto;
      min-height: 100%;
      overflow: visible;
      border: 0;
      border-radius: 6px;
      background: #101827;
      color: #d7e0f5;
    }
    .trace-empty {
      height: 100%;
      display: grid;
      place-items: center;
      padding: 20px;
      color: var(--muted);
      font-size: 13px;
      text-align: center;
    }
    .trace-legend {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 5px;
    }
    .trace-key {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      color: var(--muted);
      font-size: 11px;
    }
    .trace-swatch {
      width: 8px;
      height: 8px;
      border-radius: 2px;
      background: #64748b;
    }
    .trace-swatch.system { background: #e11d48; }
    .trace-swatch.user { background: #2563eb; }
    .trace-swatch.assistant { background: #16a34a; }
    .trace-swatch.tool { background: #d97706; }
    .trace-swatch.schema { background: #0891b2; }
    .muted {
      color: var(--muted);
      font-size: 13px;
    }
    .status {
      min-height: 20px;
      color: var(--muted);
      font-size: 13px;
    }
    .error {
      color: var(--danger);
    }
    @media (max-width: 900px) {
      header { align-items: stretch; flex-direction: column; }
      .header-left, .header-right { width: 100%; }
      .header-left { align-items: flex-start; }
      .header-left .segmented { width: 100%; }
      .segmented button { min-width: 0; padding-inline: 7px; }
      .header-right { justify-content: flex-start; }
      .controls { min-width: 0; }
      .controls input, .controls select { min-width: 0; max-width: 180px; }
      main { grid-template-columns: 1fr; }
      .composer { grid-template-columns: 1fr; }
      .primary { width: 100%; }
      .settings-grid { grid-template-columns: 1fr; }
      .model-profile-bar { grid-template-columns: minmax(0, 1fr) repeat(3, auto); }
      .schedule-form { grid-template-columns: 1fr; }
      .schedule-form > label { grid-column: auto; }
      .schedule-row { grid-template-columns: 1fr; }
      .schedule-actions { justify-content: flex-start; }
      .character-grid { grid-template-columns: 1fr; }
      .character-grid .full { grid-column: auto; }
      .memory-toolbar, .memory-row { grid-template-columns: 1fr; }
      .memory-actions { justify-content: flex-start; }
      .module-row { grid-template-columns: auto minmax(0, 1fr); }
      .module-row .module-detail-button { grid-column: 1; justify-self: start; }
      .module-row .toggle { grid-column: 2; grid-row: 2; justify-self: start; }
      .permission-row { grid-template-columns: 1fr; }
      .permission-row .toggle { justify-self: start; }
      .permission-path { max-width: 100%; text-align: left; }
      .permission-access { width: 100%; }
      .memory-manager-toolbar,
      .memory-manager-form,
      .retrieval-preview-toolbar { grid-template-columns: 1fr; }
      .memory-manager-form .full { grid-column: auto; }
      .person-profile-form { grid-template-columns: 1fr; }
      .person-profile-form .full { grid-column: auto; }
      .economics-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .profile-markdown,
      .character-soul-markdown { min-height: 280px; height: 44vh; }
      .debug-workspace {
        grid-template-columns: minmax(0, 1fr);
        grid-template-rows: auto auto minmax(0, 1fr);
      }
      .trace-index {
        max-height: 124px;
        overflow-x: hidden;
        overflow-y: auto;
        border-right: 0;
        border-bottom: 1px solid var(--line);
        flex-direction: column;
      }
      .trace-index-item {
        flex: 0 0 auto;
      }
      .trace-detail-head { align-items: flex-start; }
      .trace-actions { width: 100%; }
    }

    /* WeChat-inspired application shell */
    .app {
      grid-template-columns: 76px minmax(0, 1fr);
      grid-template-rows: 64px minmax(0, 1fr) 28px;
      background: var(--bg);
    }
    header { display: contents; }
    .header-left {
      grid-column: 1;
      grid-row: 1 / 4;
      width: 76px;
      min-width: 0;
      padding: 14px 8px 10px;
      background: var(--rail);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 20px;
      overflow: hidden;
    }
    .header-left h1 {
      width: 60px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      color: #f5f5f5;
    }
    .brand-mark {
      width: 42px;
      height: 42px;
      border-radius: 8px;
      display: grid;
      place-items: center;
      background: var(--primary);
      color: #ffffff;
      font-size: 15px;
      font-weight: 750;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
    }
    .brand-name {
      color: #b6b9bd;
      font-size: 10px;
      font-weight: 600;
      white-space: nowrap;
    }
    .nav-segmented {
      width: 60px;
      display: flex;
      flex: 1;
      flex-direction: column;
      gap: 3px;
      border: 0;
      border-radius: 0;
      background: transparent;
      overflow: visible;
    }
    .nav-segmented button {
      width: 60px;
      min-width: 0;
      height: 54px;
      padding: 5px 2px;
      border-radius: 6px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 4px;
      color: #aeb2b7;
      font-size: 10px;
      line-height: 1;
    }
    .nav-segmented button svg { width: 21px; height: 21px; stroke-width: 1.8; }
    .nav-segmented button:hover { background: rgba(255, 255, 255, 0.07); color: #ffffff; }
    .nav-segmented button.active {
      background: rgba(255, 255, 255, 0.1);
      color: #ffffff;
    }
    .nav-segmented button.active svg { color: #20d874; }
    .header-right {
      grid-column: 2;
      grid-row: 1;
      min-width: 0;
      padding: 0 20px;
      border-bottom: 1px solid #e3e3e3;
      background: rgba(250, 250, 250, 0.96);
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 12px;
      flex-wrap: nowrap;
    }
    .conversation-heading {
      min-width: 168px;
      max-width: 280px;
      margin-right: auto;
      display: grid;
      gap: 1px;
      overflow: hidden;
    }
    .conversation-heading strong,
    .conversation-heading span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .conversation-heading strong { font-size: 15px; font-weight: 650; }
    .conversation-heading span { color: var(--muted); font-size: 11px; }
    .conversation-heading .conversation-scene { color: #52705e; }
    .session-picker { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .session-picker .controls { min-width: 0; }
    #sessionSelect { width: 190px; }
    .session-picker > .icon-button { flex: 0 0 34px; width: 34px; height: 34px; }
    .header-right .controls { gap: 6px; flex-wrap: nowrap; }
    .header-right .controls > .muted { font-size: 11px; white-space: nowrap; }
    .header-right input,
    .header-right select {
      height: 34px;
      border-color: #d7d7d7;
      background: #ffffff;
      font-size: 13px;
    }
    .header-right input { width: 148px; }
    select:focus,
    input:focus,
    textarea:focus {
      border-color: #73d9a1;
      outline: 2px solid rgba(7, 193, 96, 0.12);
      outline-offset: 0;
    }
    main {
      grid-column: 2;
      grid-row: 2;
      background: var(--bg);
    }
    footer {
      grid-column: 2;
      grid-row: 3;
      padding: 4px 14px !important;
      border-top-color: #e5e5e5 !important;
      background: #fafafa !important;
    }
    footer .status { min-height: 18px; font-size: 11px; }
    .chat { background: #f3f3f3; }
    .messages {
      padding: 24px clamp(18px, 4vw, 56px) 28px;
      gap: 18px;
      scrollbar-color: #c7c7c7 transparent;
    }
    .message-row {
      width: min(100%, 980px);
      margin: 0 auto;
      display: flex;
      align-items: flex-start;
      gap: 10px;
    }
    .message-row.user { flex-direction: row-reverse; }
    .message-row.tool { padding-inline: 46px; }
    .message-row.system {
      width: 100%;
      justify-content: center;
      padding: 0 42px;
    }
    .system-event {
      max-width: min(680px, 100%);
      display: flex;
      align-items: flex-start;
      justify-content: center;
      gap: 6px;
      padding: 5px 10px;
      color: #777d82;
      font-size: 12px;
      line-height: 1.5;
      text-align: center;
    }
    .system-event svg { flex: 0 0 auto; width: 14px; height: 14px; margin-top: 2px; }
    .system-event .markdown-body > :first-child { margin-top: 0; }
    .system-event .markdown-body > :last-child { margin-bottom: 0; }
    .system-event-actions { display: inline-flex; gap: 4px; margin-left: 2px; }
    .system-event-action {
      width: 24px;
      height: 24px;
      padding: 0;
      border: 1px solid #d7dadd;
      border-radius: 5px;
      background: transparent;
      color: #656b70;
      display: inline-grid;
      place-items: center;
      cursor: pointer;
    }
    .system-event-action:hover { background: #e9ebed; color: #25292c; }
    .system-event-action svg { width: 13px; height: 13px; margin: 0; }
    .message-row.interaction {
      width: min(100%, 980px);
      justify-content: center;
      padding: 2px 42px;
    }
    .interaction-event {
      max-width: min(620px, 100%);
      min-width: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      color: #67716b;
      font-size: 12px;
      line-height: 1.45;
      text-align: center;
    }
    .interaction-event::before,
    .interaction-event::after { content: ""; width: clamp(20px, 7vw, 72px); height: 1px; background: #d7ddd9; }
    .interaction-event-copy { min-width: 0; display: inline-flex; align-items: center; gap: 6px; }
    .interaction-event-copy svg { flex: 0 0 auto; width: 14px; height: 14px; color: #4d7b5e; }
    .interaction-event-copy span { overflow-wrap: anywhere; }
    .interaction-event-actions { display: inline-flex; align-items: center; gap: 5px; }
    .interaction-event-actions button {
      min-width: 0;
      height: 28px;
      padding: 0 9px;
      border: 1px solid #cfd8d2;
      border-radius: 5px;
      background: #f8faf9;
      color: #42614e;
      font-size: 11px;
      cursor: pointer;
    }
    .interaction-event-actions button.primary { border-color: #70bf8e; background: #eaf7ef; color: #24613b; }
    .archived-dialog,
    .session-action-dialog,
    .world-manager-dialog {
      width: min(620px, calc(100vw - 28px));
      max-height: min(640px, calc(100vh - 48px));
      padding: 0;
      border: 1px solid #d8d8d8;
      border-radius: 8px;
      background: #ffffff;
      color: var(--text);
      box-shadow: 0 12px 34px rgba(0, 0, 0, 0.2);
    }
    .session-action-dialog { width: min(440px, calc(100vw - 28px)); }
    .world-manager-dialog { width: min(860px, calc(100vw - 28px)); max-height: min(820px, calc(100vh - 32px)); }
    .archived-dialog::backdrop,
    .session-action-dialog::backdrop,
    .world-manager-dialog::backdrop { background: rgba(0, 0, 0, 0.28); }
    .archived-dialog-head {
      height: 52px;
      padding: 0 12px 0 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #e4e4e4;
    }
    .archived-dialog-head h2 { margin: 0; font-size: 15px; }
    .archived-list { max-height: min(540px, calc(100vh - 120px)); overflow: auto; }
    .archived-row {
      min-width: 0;
      padding: 12px 14px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      border-bottom: 1px solid #ededed;
    }
    .archived-row:last-child { border-bottom: 0; }
    .archived-row strong,
    .archived-row span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .archived-row strong { font-size: 13px; }
    .archived-row span { margin-top: 3px; color: var(--muted); font-size: 11px; }
    .archived-row-actions { display: flex; gap: 6px; }
    .archived-row-actions .icon-button { width: 30px; height: 30px; }
    .archived-empty { padding: 30px 16px; color: var(--muted); font-size: 13px; text-align: center; }
    .session-action-form { padding: 16px; display: grid; gap: 14px; }
    .session-action-copy { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.55; }
    .session-action-field { display: grid; gap: 6px; color: #3d4246; font-size: 12px; font-weight: 600; }
    .session-action-field input { width: 100%; height: 38px; }
    .dialog-error { min-height: 18px; color: var(--danger); font-size: 12px; line-height: 1.5; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
    .dialog-actions button { min-width: 78px; }
    .world-manager-body { max-height: min(750px, calc(100vh - 86px)); padding: 16px; overflow: auto; display: grid; gap: 16px; }
    .world-manager-picker { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
    .world-form,
    .world-place-form { display: grid; gap: 14px; }
    .world-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .world-form-grid .full { grid-column: 1 / -1; }
    .world-form-grid label { display: grid; gap: 6px; color: var(--muted); font-size: 12px; }
    .world-form-grid textarea { min-height: 86px; resize: vertical; }
    #worldRules { min-height: 128px; }
    .world-card-summary {
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #f7f8f7;
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 12px;
    }
    .world-card-summary > div { min-width: 0; display: grid; gap: 5px; }
    .world-card-summary span { color: var(--muted); font-size: 10px; }
    .world-card-summary strong { overflow-wrap: anywhere; font-size: 12px; font-weight: 600; }
    .world-card-members { display: flex !important; align-items: center; gap: 7px !important; }
    .world-card-members .group-avatar-cluster { flex: 0 0 28px; }
    .world-places-section { padding-top: 16px; border-top: 1px solid var(--line); display: grid; gap: 14px; }
    .world-place-row { grid-template-columns: minmax(0, 1fr) auto; align-items: center; }
    .world-place-row-copy { min-width: 0; display: grid; gap: 4px; }
    .world-place-row-actions { display: flex; gap: 6px; }
    .capability-fieldset { margin: 0; padding: 10px 12px 12px; border: 1px solid var(--line); }
    .capability-fieldset legend { padding: 0 4px; color: var(--muted); font-size: 11px; }
    .world-capability-options { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px 10px; }
    .world-capability-options label { display: flex; align-items: center; gap: 6px; color: #424b46; font-size: 11px; }
    .session-actions-desktop { display: flex; align-items: center; gap: 6px; }
    .session-actions-desktop .icon-button { width: 34px; height: 34px; }
    .mobile-session-actions { position: relative; display: none; }
    .session-actions-menu {
      position: absolute;
      z-index: 30;
      top: calc(100% + 6px);
      right: 0;
      width: 168px;
      padding: 5px;
      border: 1px solid #d9d9d9;
      border-radius: 6px;
      background: #ffffff;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.18);
    }
    .session-actions-menu[hidden] { display: none; }
    .session-actions-menu button {
      width: 100%;
      min-height: 36px;
      padding: 7px 9px;
      border: 0;
      background: transparent;
      color: var(--text);
      display: flex;
      align-items: center;
      gap: 9px;
      text-align: left;
      cursor: pointer;
    }
    .session-actions-menu button:hover,
    .session-actions-menu button:focus-visible { background: #f0f1f2; }
    .session-actions-menu button:disabled { color: #b5b8bb; cursor: not-allowed; }
    .session-actions-menu button svg { width: 15px; height: 15px; }
    .message-avatar {
      flex: 0 0 38px;
      width: 38px;
      height: 38px;
      border-radius: 6px;
      display: grid;
      place-items: center;
      background: #ffffff;
      color: #4a4a4a;
      border: 1px solid rgba(0, 0, 0, 0.06);
      box-shadow: var(--shadow);
      font-size: 12px;
      font-weight: 700;
    }
    button.message-avatar { padding: 0; cursor: pointer; }
    .character-profile-trigger:hover,
    .character-profile-trigger:focus-visible {
      border-color: rgba(7, 168, 82, 0.48);
      box-shadow: 0 0 0 3px rgba(7, 168, 82, 0.1);
      outline: none;
    }
    .message-row.user .message-avatar { background: #dff8d1; color: #176d3a; }
    .message-row.tool .message-avatar { background: #fff3ca; color: #8b6400; }
    .message-avatar.world-avatar { padding: 0; overflow: hidden; background: #d9dddb; }
    .message-avatar.world-avatar > .group-avatar-cluster { width: 100%; height: 100%; }
    .message-avatar svg { width: 18px; height: 18px; }
    .message-stack {
      min-width: 0;
      max-width: min(760px, calc(100% - 48px));
      display: flex;
      flex-direction: column;
      align-items: flex-start;
    }
    .message-row.user .message-stack { align-items: flex-end; }
    .message-row.tool .message-stack { width: min(760px, 100%); max-width: 100%; }
    .meta {
      margin: 0 4px 5px;
      color: #8b8b8b;
      font-size: 11px;
      line-height: 1.2;
    }
    .bubble {
      position: relative;
      max-width: 100%;
      margin: 0;
      padding: 9px 12px;
      border: 0;
      border-radius: 6px;
      background: var(--assistant);
      box-shadow: var(--shadow);
      line-height: 1.62;
    }
    .bubble-text.markdown-body { white-space: normal; }
    .message-bubble-row { max-width: 100%; display: flex; align-items: center; gap: 5px; }
    .message-row.user .message-bubble-row { flex-direction: row-reverse; }
    .message-bubble-content { min-width: 0; max-width: 100%; display: grid; justify-items: start; gap: 5px; }
    .message-row.user .message-bubble-content { justify-items: end; }
    .message-bubble-content .bubble { width: fit-content; }
    .message-bubble-content .bubble + .bubble::before { display: none; }
    .message-actions { display: inline-flex; gap: 2px; opacity: 0; transition: opacity 120ms ease; }
    .message-row:hover .message-actions,
    .message-actions:focus-within,
    .proactive-message-actions { opacity: 1; }
    .message-action {
      width: 26px;
      height: 26px;
      padding: 0;
      border: 0;
      border-radius: 5px;
      background: transparent;
      color: #777d82;
      display: inline-grid;
      place-items: center;
      cursor: pointer;
    }
    .message-action:hover { background: #e3e5e7; color: #202326; }
    .message-action svg { width: 14px; height: 14px; }
    .proactive-feedback { position: relative; }
    .proactive-feedback > summary { list-style: none; }
    .proactive-feedback > summary::-webkit-details-marker { display: none; }
    .proactive-feedback-panel {
      position: absolute;
      z-index: 24;
      top: calc(100% + 4px);
      right: 0;
      width: 164px;
      padding: 4px;
      border: 1px solid #d7d9d8;
      border-radius: 6px;
      background: #ffffff;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
      display: grid;
    }
    .proactive-feedback-panel button {
      min-height: 34px;
      padding: 6px 8px;
      border: 0;
      border-radius: 4px;
      background: transparent;
      color: #343936;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 11px;
      text-align: left;
      cursor: pointer;
    }
    .proactive-feedback-panel button:hover { background: #f0f2f1; }
    .proactive-feedback-panel button svg { width: 14px; height: 14px; }
    .proactive-feedback-receipt { color: #5a7161; opacity: 1; cursor: default; }
    .bubble.assistant::before,
    .bubble.user::before {
      content: "";
      position: absolute;
      top: 12px;
      width: 0;
      height: 0;
      border-top: 6px solid transparent;
      border-bottom: 6px solid transparent;
    }
    .bubble.assistant::before {
      left: -6px;
      border-right: 7px solid #ffffff;
    }
    .message-row.world-narration .bubble.assistant {
      background: #f4f5f4;
      color: #414844;
    }
    .message-row.world-narration .bubble.assistant::before { border-right-color: #f4f5f4; }
    .world-scene-turn {
      width: min(100%, 860px);
      margin: 0 auto;
      padding: 2px 0 20px;
      border-bottom: 1px solid #dfe2e0;
      display: grid;
      gap: 14px;
    }
    .world-scene-head { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .world-scene-head-copy { min-width: 0; display: grid; gap: 2px; }
    .world-scene-head-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #4d5651; font-size: 12px; }
    .world-scene-head-copy span { color: #8a918d; font-size: 10px; }
    .world-scene-participants { display: flex; align-items: center; }
    .world-scene-participants .world-scene-mini-avatar + .world-scene-mini-avatar { margin-left: -5px; }
    .world-scene-mini-avatar {
      width: 25px;
      height: 25px;
      padding: 0;
      overflow: hidden;
      border: 2px solid #f3f3f3;
      border-radius: 50%;
      background: #e7ece9;
      color: #3d654d;
      display: grid;
      place-items: center;
      font-size: 9px;
      font-weight: 700;
    }
    .world-scene-mini-avatar img { width: 100%; height: 100%; object-fit: cover; }
    button.world-scene-mini-avatar { cursor: pointer; }
    .world-scene-copy { min-width: 0; padding: 0 clamp(2px, 2vw, 18px); }
    .world-scene-fragment { min-width: 0; display: grid; gap: 7px; }
    .world-scene-fragment + .world-scene-fragment { margin-top: 16px; }
    .world-scene-speaker {
      width: fit-content;
      padding: 0;
      border: 0;
      background: transparent;
      color: #347250;
      font-size: 11px;
      font-weight: 650;
    }
    button.world-scene-speaker { cursor: pointer; }
    .world-scene-fragment.director .world-scene-speaker { color: #737a76; }
    .world-scene-text { color: #252a27; font-size: 15px; line-height: 1.88; }
    .world-scene-text > :first-child { margin-top: 0; }
    .world-scene-text > :last-child { margin-bottom: 0; }
    .world-scene-fragment .message-progress { width: fit-content; max-width: 100%; }
    .bubble.user {
      margin: 0;
      background: var(--user);
      border: 0;
    }
    .bubble.user::before {
      right: -6px;
      border-left: 7px solid var(--user);
    }
    .bubble.media-only { padding: 0; background: transparent; box-shadow: none; }
    .bubble.media-only::before { display: none; }
    .message-attachments { display: grid; gap: 7px; }
    .message-image-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 5px; }
    .message-image-grid.multiple { grid-template-columns: repeat(2, minmax(0, 136px)); }
    .message-image-thumb,
    .message-inline-image {
      width: min(230px, 52vw);
      aspect-ratio: 4 / 3;
      padding: 0;
      border: 1px solid rgba(0, 0, 0, 0.09);
      border-radius: 6px;
      background: #f4f4f4;
      display: block;
      overflow: hidden;
      cursor: zoom-in;
    }
    .message-image-grid.multiple .message-image-thumb { width: 136px; aspect-ratio: 1; }
    .message-image-thumb img,
    .message-inline-image img { width: 100%; height: 100%; display: block; object-fit: contain; }
    .message-inline-image { margin: 0.7em 0; }
    .message-inline-image img { margin: 0; }
    .message-file-attachment {
      max-width: 280px;
      min-height: 42px;
      padding: 7px 9px;
      border: 1px solid rgba(0, 0, 0, 0.1);
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.72);
      color: var(--text);
      display: grid;
      grid-template-columns: 24px minmax(0, 1fr) 16px;
      gap: 7px;
      align-items: center;
      text-decoration: none;
    }
    .message-file-attachment:hover { background: #ffffff; }
    .message-file-attachment > svg { width: 18px; height: 18px; color: #687078; }
    .message-file-copy { min-width: 0; display: grid; gap: 1px; }
    .message-file-copy strong,
    .message-file-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .message-file-copy strong { font-size: 11px; }
    .message-file-copy small { color: var(--muted); font-size: 9px; }
    .message-file-download { width: 14px; height: 14px; color: #687078; }
    .message-attachments + .bubble-text { margin-top: 8px; }
    .message-progress {
      margin: 0 0 7px;
      padding: 0;
      color: #60656f;
    }
    .progress-step.active .progress-mark,
    .progress-state.active { color: #07994e; }
    .chat-empty {
      min-height: 100%;
      display: grid;
      place-content: center;
      justify-items: center;
      gap: 10px;
      color: var(--muted);
    }
    .chat-empty .brand-mark { width: 48px; height: 48px; }
    .chat-empty strong { color: #505050; font-size: 14px; font-weight: 600; }
    .composer {
      padding: 10px 18px 12px;
      grid-template-columns: minmax(0, 1fr) 38px 38px auto;
      gap: 8px;
      border-top-color: #dfdfdf;
      background: #fafafa;
    }
    .composer textarea {
      grid-column: 1 / -1;
      min-height: 66px;
      max-height: 180px;
      padding: 8px 4px;
      border: 0;
      border-radius: 0;
      background: transparent;
      line-height: 1.55;
      resize: none;
    }
    .composer textarea:focus { outline: 0; }
    .composer #cancelMessageBtn { grid-column: 2; }
    .composer #retryMessageBtn { grid-column: 3; }
    .composer #sendBtn { grid-column: 4; }
    .composer .secondary,
    .composer .primary {
      height: 36px;
      min-width: 36px;
      border-radius: 6px;
    }
    .icon-button {
      padding: 0;
      display: inline-grid;
      place-items: center;
    }
    .icon-button svg { width: 16px; height: 16px; }
    .header-right .conversation-list-toggle { display: none; }
    .send-button {
      padding: 0 14px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }
    .send-button svg { width: 16px; height: 16px; }
    .primary { background: var(--primary); }
    .primary:hover:not(:disabled) { background: var(--primary-strong); }
    .secondary:hover:not(:disabled) { border-color: #bfbfbf; background: #f5f5f5; }

    .markdown-body { min-width: 0; overflow-wrap: anywhere; }
    .markdown-body > :first-child { margin-top: 0; }
    .markdown-body > :last-child { margin-bottom: 0; }
    .markdown-body p { margin: 0 0 0.7em; }
    .markdown-body h1,
    .markdown-body h2,
    .markdown-body h3,
    .markdown-body h4 {
      margin: 1em 0 0.5em;
      color: #181818;
      line-height: 1.35;
      font-weight: 680;
    }
    .markdown-body h1 { font-size: 20px; }
    .markdown-body h2 { padding-bottom: 5px; border-bottom: 1px solid rgba(0, 0, 0, 0.1); font-size: 17px; }
    .markdown-body h3 { font-size: 15px; }
    .markdown-body h4 { font-size: 14px; }
    .markdown-body ul,
    .markdown-body ol { margin: 0.45em 0 0.75em; padding-left: 1.5em; }
    .markdown-body li { margin: 0.2em 0; }
    .markdown-body li > p { margin: 0; }
    .markdown-body blockquote {
      margin: 0.75em 0;
      padding: 6px 10px;
      border-left: 3px solid #47bd78;
      background: rgba(0, 0, 0, 0.035);
      color: #5d5d5d;
    }
    .markdown-body code {
      padding: 0.12em 0.32em;
      border-radius: 4px;
      background: rgba(0, 0, 0, 0.07);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.9em;
    }
    .markdown-body pre {
      max-width: 100%;
      margin: 0.75em 0;
      padding: 11px 12px;
      border-radius: 6px;
      background: #24272c;
      color: #f2f2f2;
      overflow: auto;
      line-height: 1.5;
    }
    .markdown-body pre code { padding: 0; background: transparent; color: inherit; font-size: 12px; }
    .markdown-body a { color: #087d45; text-decoration: underline; text-underline-offset: 2px; }
    .markdown-body img { display: block; max-width: 100%; height: auto; margin: 0.75em 0; border-radius: 6px; }
    .markdown-body hr { margin: 1em 0; border: 0; border-top: 1px solid rgba(0, 0, 0, 0.12); }
    .markdown-table-wrap { max-width: 100%; margin: 0.75em 0; overflow-x: auto; }
    .markdown-body table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .markdown-body th,
    .markdown-body td { padding: 7px 8px; border: 1px solid rgba(0, 0, 0, 0.13); text-align: left; }
    .markdown-body th { background: rgba(0, 0, 0, 0.045); font-weight: 650; }
    .bubble.user .markdown-body blockquote { background: rgba(255, 255, 255, 0.28); }
    .feature-test-panel { min-height: 0; overflow: auto; background: #f7f7f7; }
    .feature-test-toolbar {
      position: sticky;
      top: 0;
      z-index: 2;
      min-height: 52px;
      padding: 8px 14px;
      border-bottom: 1px solid var(--line);
      background: rgba(250, 250, 250, 0.97);
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .feature-test-toolbar select { min-width: 180px; }
    .feature-test-field { min-width: 180px; display: grid; gap: 3px; }
    .feature-test-field > span { color: var(--muted); font-size: 10px; line-height: 1; }
    .feature-test-field select { width: 100%; }
    .feature-test-state { min-width: 140px; color: var(--muted); font-size: 11px; }
    .feature-test-report { border-bottom: 1px solid var(--line); background: #ffffff; }
    .feature-test-score-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 1px;
      background: var(--line);
    }
    .feature-test-score-grid > div { min-width: 0; padding: 12px 14px; background: #ffffff; display: grid; gap: 4px; }
    .feature-test-score-grid span { color: var(--muted); font-size: 10px; }
    .feature-test-score-grid strong { font: 650 22px/1 Arial, sans-serif; font-variant-numeric: tabular-nums; }
    .feature-test-score-grid strong.good { color: #087d45; }
    .feature-test-score-grid strong.warn { color: #9a6507; }
    .feature-test-score-grid strong.bad { color: var(--danger); }
    .feature-test-report-meta { padding: 9px 14px; color: var(--muted); font-size: 11px; line-height: 1.5; }
    .feature-test-history { padding: 0 14px; background: #ffffff; }
    .feature-test-history details { padding: 10px 0; }
    .feature-test-history summary { cursor: pointer; color: #3f4b45; font-size: 12px; }
    .feature-test-history-table { width: 100%; margin-top: 8px; border-collapse: collapse; font-size: 11px; }
    .feature-test-history-table th,
    .feature-test-history-table td { padding: 7px 6px; border-top: 1px solid var(--line); text-align: left; }
    .feature-test-history-table th { color: var(--muted); font-weight: 500; }
    .feature-test-history-table td:not(:first-child) { white-space: nowrap; font-variant-numeric: tabular-nums; }
    .feature-test-list,
    .feature-test-results { padding: 0 14px; }
    .feature-test-case {
      min-width: 0;
      padding: 12px 0;
      border-bottom: 1px solid var(--line);
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 10px;
      align-items: start;
    }
    .feature-test-case input { width: 16px; height: 16px; margin-top: 2px; }
    .feature-test-case strong { font-size: 13px; }
    .feature-test-case p { margin: 4px 0; color: var(--muted); font-size: 12px; line-height: 1.45; }
    .feature-test-criteria { display: block; margin: 5px 0; color: #536c5e; font-size: 10px; line-height: 1.45; }
    .feature-test-input { display: block; padding: 5px 7px; background: #eeeeee; font-size: 11px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .feature-test-result { padding: 14px 0; border-top: 1px solid var(--line); }
    .feature-test-result-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .feature-test-result-head strong { font-size: 13px; }
    .feature-test-result-scores { display: flex; align-items: center; gap: 8px; font: 600 11px/1.2 Arial, sans-serif; font-variant-numeric: tabular-nums; }
    .feature-test-status.pass { color: #087d45; }
    .feature-test-status.fail { color: var(--danger); }
    .feature-test-rules { margin: 8px 0 0; padding: 0; list-style: none; display: grid; gap: 5px; }
    .feature-test-rules li { font-size: 11px; line-height: 1.45; }
    .feature-test-reply { max-height: 180px; margin-top: 9px; padding: 8px; overflow: auto; background: #ffffff; font-size: 12px; }
    .feature-test-quality { margin-top: 9px; border-top: 1px solid #ededed; }
    .feature-test-quality summary { padding-top: 8px; cursor: pointer; font-size: 11px; }
    .feature-test-quality-summary { margin: 8px 0; color: #39453f; font-size: 11px; line-height: 1.55; }
    .feature-test-dimensions { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 1px; background: var(--line); }
    .feature-test-dimension { min-width: 0; padding: 7px; background: #ffffff; }
    .feature-test-dimension strong { display: block; margin-bottom: 3px; font: 650 13px/1 Arial, sans-serif; }
    .feature-test-dimension span { display: block; color: var(--muted); font-size: 9px; }
    .feature-test-dimension p { margin: 5px 0 0; color: #505a55; font-size: 10px; line-height: 1.4; }
    .initiative-debug-panel { min-height: 0; overflow: auto; background: #f7f7f7; }
    .initiative-summary {
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 1px;
      background: var(--line);
    }
    .initiative-summary > div { min-width: 0; padding: 9px 10px; background: #ffffff; display: grid; gap: 3px; }
    .initiative-summary span { color: var(--muted); font-size: 10px; }
    .initiative-summary strong { font-family: Arial, sans-serif; font-size: 15px; font-variant-numeric: normal; letter-spacing: 0; }
    .initiative-debug-list { padding: 0 14px; }
    .initiative-debug-row {
      padding: 12px 0;
      border-bottom: 1px solid var(--line);
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 7px 12px;
    }
    .initiative-debug-copy { min-width: 0; display: grid; gap: 4px; }
    .initiative-debug-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
    .initiative-debug-meta { color: var(--muted); font-family: Arial, sans-serif; font-size: 10px; font-variant-numeric: normal; letter-spacing: 0; overflow-wrap: anywhere; }
    .initiative-debug-score { align-self: start; min-width: 42px; font-family: Arial, sans-serif; text-align: right; font-size: 12px; font-variant-numeric: normal; letter-spacing: 0; }
    .initiative-debug-detail { grid-column: 1 / -1; }
    .initiative-debug-detail summary { color: #59615d; font-size: 10px; cursor: pointer; }
    .initiative-debug-detail pre { max-height: 180px; margin: 6px 0 0; padding: 8px; overflow: auto; background: #ffffff; font-size: 10px; white-space: pre-wrap; }

    .settings-page { padding: 22px clamp(16px, 3vw, 34px) 36px; background: #f5f5f5; }
    .settings-shell,
    .schedule-shell,
    .character-shell,
    .management-shell { max-width: 1040px; }
    .settings-shell {
      padding: 22px;
      border-color: #e1e1e1;
      box-shadow: var(--shadow);
    }
    .schedule-head h2,
    .character-head h2,
    .management-head h2,
    .settings-shell h2 { font-weight: 650; }
    .schedule-editor,
    .schedule-list,
    .workspace-section,
    .management-panel { border-color: #e0e0e0; }
    .management-panel { border-radius: 6px; box-shadow: var(--shadow); }
    .module-row,
    .permission-row,
    .memory-row,
    .schedule-row { border-bottom-color: #ededed; }
    .toggle input:checked { border-color: var(--primary); background: var(--primary); }
    .segmented button.active { background: var(--primary); }
    .nav-segmented button.active { background: rgba(255, 255, 255, 0.1); }

    /* Shared dimensions keep page actions visually aligned across workspaces. */
    .primary,
    .secondary {
      width: auto;
      height: var(--control-height);
      min-height: var(--control-height);
      padding: 0 13px;
      border-radius: var(--control-radius);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      line-height: 1;
      white-space: nowrap;
      vertical-align: middle;
    }
    .primary svg,
    .secondary svg {
      flex: 0 0 var(--control-icon-size);
      width: var(--control-icon-size);
      height: var(--control-icon-size);
      margin: 0;
    }
    .primary.icon-button,
    .secondary.icon-button {
      width: var(--control-height);
      min-width: var(--control-height);
      padding: 0;
      display: inline-grid;
      place-items: center;
    }
    .segmented:not(.nav-segmented) button {
      height: var(--control-height);
      min-height: var(--control-height);
      padding-block: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      line-height: 1;
    }
    .header-right input,
    .header-right select { height: var(--control-height); }
    .session-picker > .icon-button,
    .session-actions-desktop .icon-button,
    .schedule-month-nav button,
    .schedule-toolbar .primary,
    .schedule-actions button,
    .avatar-actions button,
    .module-detail-button { height: var(--control-height); }
    .schedule-month-nav button,
    .module-detail-button { width: var(--control-height); }
    .conversation-list-head .icon-button {
      width: 32px;
      min-width: 32px;
      height: 32px;
    }
    .header-right .conversation-list-toggle { display: none; }
    .settings-actions {
      gap: 8px;
      align-items: center;
      margin-top: 14px;
    }
    .settings-actions > .muted {
      min-height: var(--control-height);
      display: inline-flex;
      align-items: center;
    }
    .workspace-section {
      padding: 18px clamp(16px, 2vw, 22px) 20px;
      border-bottom: 1px solid var(--line);
    }
    .management-panel { padding: 20px clamp(18px, 2vw, 24px); }
    .character-editor-head,
    .character-picker,
    .management-head,
    .schedule-head,
    .avatar-actions { align-items: center; }

    @media (min-width: 901px) and (max-width: 1240px) {
      .app { grid-template-rows: 110px minmax(0, 1fr) 28px; }
      .header-right {
        height: 110px;
        padding: 8px 16px;
        display: grid;
        grid-template-columns: minmax(150px, 0.8fr) minmax(210px, 1fr) minmax(210px, 1fr);
        grid-template-rows: 42px 42px;
        gap: 8px 12px;
        align-content: center;
        justify-content: stretch;
      }
      .conversation-heading {
        grid-column: 1;
        grid-row: 1 / 3;
        min-width: 0;
        max-width: none;
        margin-right: 0;
        align-self: center;
      }
      .session-picker {
        grid-column: 2 / 4;
        grid-row: 1;
        width: 100%;
      }
      .session-picker .controls { flex: 1 1 auto; }
      #sessionSelect {
        width: 100%;
        min-width: 150px;
      }
      #modeControl {
        grid-column: 2;
        grid-row: 2;
      }
      #chatCharacterControl {
        grid-column: 3;
        grid-row: 2;
      }
      #modeControl,
      #chatCharacterControl { width: 100%; }
      .header-right .controls > .muted { display: none; }
      .header-right input,
      .header-right select {
        width: 100%;
        max-width: none;
      }
    }

    @media (max-width: 900px) {
      .app {
        grid-template-columns: minmax(0, 1fr);
        grid-template-rows: 138px minmax(0, 1fr) 60px;
      }
      .header-left {
        grid-column: 1;
        grid-row: 3;
        width: 100%;
        height: 60px;
        padding: 0;
        border-top: 1px solid #dddddd;
        background: rgba(250, 250, 250, 0.98);
        flex-direction: row;
        gap: 0;
        overflow: hidden;
      }
      .header-left h1 { display: none; }
      .nav-segmented {
        width: 100%;
        height: 60px;
        flex-direction: row;
        gap: 0;
      }
      .nav-segmented button {
        flex: 1 1 0;
        width: auto;
        height: 60px;
        padding: 5px 1px 4px;
        border-radius: 0;
        color: #737373;
        font-size: 9px;
      }
      .nav-segmented button svg { width: 20px; height: 20px; }
      .nav-segmented button:hover,
      .nav-segmented button.active { background: transparent; color: #07a852; }
      .nav-segmented button.active svg { color: #07a852; }
      .header-right {
        grid-column: 1;
        grid-row: 1;
        position: relative;
        z-index: 20;
        width: 100%;
        min-width: 0;
        height: 138px;
        padding: 4px 10px;
        gap: 7px;
        display: grid;
        grid-template-columns: minmax(105px, 2fr) minmax(155px, 3fr);
        grid-template-rows: 42px 40px 40px;
        justify-content: stretch;
        overflow: visible;
      }
      .conversation-heading {
        grid-column: 1 / -1;
        grid-row: 1;
        min-width: 0;
        max-width: none;
        margin-right: 0;
        overflow: hidden;
        position: relative;
        padding-left: 36px;
      }
      .header-right .conversation-list-toggle {
        position: absolute;
        left: 0;
        top: 4px;
        width: 30px;
        height: 30px;
        display: inline-grid;
      }
      .conversation-heading strong {
        overflow: hidden;
        font-size: 14px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .conversation-heading span { display: block; font-size: 10px; }
      .conversation-heading .conversation-scene:not([hidden]) { display: block; }
      .session-picker { grid-column: 1 / -1; grid-row: 3; width: 100%; }
      .session-picker .controls { flex: 1 1 auto; }
      .session-picker > .icon-button { flex-basis: 30px; width: 30px; height: 30px; }
      .session-actions-desktop { display: none; }
      .mobile-session-actions { display: block; flex: 0 0 30px; }
      .mobile-session-actions > .icon-button { width: 30px; height: 30px; }
      .header-right .controls { min-width: 0; }
      .header-right .controls > .muted { display: none; }
      .header-right input,
      .header-right select { width: 100%; max-width: none; height: 34px; padding-inline: 8px; }
      #sessionSelect { width: 100%; }
      #modeControl { grid-column: 1; grid-row: 2; }
      #chatCharacterControl { grid-column: 2; grid-row: 2; }
      main { grid-column: 1; grid-row: 2; }
      footer { display: none; }
      .chat-workspace { position: relative; grid-template-columns: minmax(0, 1fr); }
      .conversation-sidebar { display: none; border-right: 0; }
      .chat-workspace.list-open .conversation-sidebar { display: flex; }
      .chat-workspace.list-open .chat-thread { display: none; }
      .conversation-item { min-height: 60px; height: auto; }
      .messages { padding: 16px 10px 22px; gap: 16px; }
      .message-row { gap: 8px; }
      .message-row.tool { padding-inline: 0; }
      .message-row.system { padding-inline: 8px; }
      .message-avatar { flex-basis: 34px; width: 34px; height: 34px; font-size: 10px; }
      .message-stack { max-width: calc(100% - 42px); }
      .message-row.tool .message-stack { max-width: calc(100% - 42px); }
      .message-actions { opacity: 1; }
      .bubble { padding: 8px 10px; font-size: 14px; }
      .bubble.assistant::before,
      .bubble.user::before { top: 10px; }
      .composer {
        padding: 8px 10px 9px;
        grid-template-columns: minmax(0, 1fr) 36px 36px auto;
      }
      .composer textarea { min-height: 52px; max-height: 132px; font-size: 15px; }
      .send-button { padding-inline: 11px; }
      .settings-page { padding: 14px 12px 28px; }
      .settings-shell { padding: 16px 12px; }
      .settings-shell,
      .schedule-shell,
      .character-shell,
      .management-shell { width: 100%; }
      .schedule-owner-head { align-items: stretch; gap: 12px; }
      .schedule-title-group { width: 100%; align-items: flex-start; gap: 12px; }
      .schedule-title-group h2 { width: 100%; }
      .schedule-owner-tabs { width: 100%; }
      .schedule-owner-tabs button { min-width: 0; }
      .schedule-character-field { width: 100%; grid-template-columns: 42px minmax(0, 1fr); }
      .schedule-view-tabs { display: grid; width: 100%; }
      .schedule-head { align-items: flex-start; }
      .schedule-navigation { align-items: center; }
      .schedule-scope-summary { display: none; }
      .schedule-toolbar { width: 100%; }
      .schedule-month-nav { flex: 1 1 auto; grid-template-columns: 34px minmax(100px, 1fr) 34px; }
      #schedulePage:not([data-mobile-view="calendar"]) .schedule-month-nav { display: none; }
      .schedule-dashboard { display: block; }
      .schedule-side { display: block; }
      .schedule-side > section + section { margin-top: 12px; }
      #schedulePage[data-mobile-view="agenda"] .calendar-panel,
      #schedulePage[data-mobile-view="agenda"] .task-panel,
      #schedulePage[data-mobile-view="calendar"] .schedule-side,
      #schedulePage[data-mobile-view="tasks"] .calendar-panel,
      #schedulePage[data-mobile-view="tasks"] .schedule-agenda { display: none; }
      .calendar-day { min-height: 62px; padding: 4px; }
      .calendar-events { gap: 2px; margin-top: 2px; }
      .calendar-event { padding-inline: 2px; font-size: 8px; }
      .schedule-agenda .schedule-row { padding-inline: 12px; }
      .schedule-side .schedule-list,
      .task-list { max-height: none; }
      .character-card-grid { grid-template-columns: repeat(auto-fit, minmax(158px, 1fr)); gap: 8px; }
      .world-card-grid { grid-template-columns: repeat(auto-fit, minmax(158px, 1fr)); }
      .character-card { min-height: 92px; padding: 9px; grid-template-columns: 44px minmax(0, 1fr); gap: 8px; }
      .character-card-avatar { width: 44px; height: 44px; font-size: 16px; }
      .character-head #newCharacterBtn { width: auto; }
      .character-detail-head { min-height: 0; padding: 12px 14px; align-items: stretch; flex-direction: column; }
      .character-tabs { width: 100%; }
      .character-tabs button { padding-inline: 5px; font-size: 11px; }
      .character-panel { padding: 16px 14px 18px; }
      .character-function-head { align-items: stretch; flex-direction: column; }
      .character-function-head-actions { justify-content: space-between; }
      .function-overview-primary { align-items: flex-start; flex-direction: column; }
      .character-skill-document-head { align-items: stretch; flex-direction: column; }
      .character-skill-version-controls { display: grid; grid-template-columns: minmax(0, 1fr) auto; }
      .character-skill-version-controls select { width: 100%; min-width: 0; }
      .character-skill-markdown { padding: 13px 14px 16px; }
      .function-profile-grid { grid-template-columns: minmax(0, 1fr); }
      .function-profile-grid .full { grid-column: auto; }
      .capability-row-main { grid-template-columns: minmax(0, 1fr); align-items: stretch; }
      .capability-controls { grid-template-columns: 82px minmax(120px, 1fr); }
      .capability-level select { width: 82px; }
      .capability-auto { grid-column: 1 / -1; justify-self: start; }
      .capability-bindings { margin-left: 0; }
      .capability-module-grid { grid-template-columns: minmax(0, 1fr); }
      .life-world-binding { align-items: stretch; flex-direction: column; }
      .life-world-binding label { grid-template-columns: minmax(0, 1fr); }
      .life-runtime-band { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .life-runtime-band > div:nth-child(2) { border-right: 0; }
      .life-runtime-band > div:nth-child(-n + 2) { border-bottom: 1px solid var(--line); }
      .life-settings-grid,
      .life-detail-grid,
      .world-form-grid { grid-template-columns: minmax(0, 1fr); }
      .world-form-grid .full { grid-column: auto; }
      .life-actions { display: grid; grid-template-columns: minmax(0, 1fr); }
      .life-proactive-pause { align-items: stretch; flex-direction: column; }
      .initiative-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .initiative-summary > div:last-child { grid-column: 1 / -1; }
      .world-capability-options { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .world-manager-dialog { width: calc(100vw - 16px); max-height: calc(100vh - 16px); }
      .world-manager-body { padding: 12px; }
      .relationship-overview { grid-template-columns: minmax(0, 1fr); gap: 14px; }
      .relationship-event { grid-template-columns: minmax(0, 1fr); }
      .relationship-delta { justify-content: flex-start; max-width: none; }
      .character-memory-head .primary { width: auto; }
      .character-save-actions .primary { width: 100%; }
      .avatar-editor { grid-template-columns: 60px minmax(0, 1fr); }
      .avatar-preview { width: 60px; height: 60px; }
      .avatar-hint { grid-column: 1 / -1; }
      .management-panel { padding: 14px 12px; }
      .workspace-section { padding: 16px 14px 18px; }
      .profile-markdown,
      .character-soul-markdown { min-height: 260px; height: 42vh; }
      body[data-ui-mode="debug"] .app {
        grid-template-rows: 0 minmax(0, 1fr) 60px;
      }
      body[data-ui-mode="debug"] .header-right { display: none; }
      body[data-ui-mode="debug"] #debugPane .side-head {
        min-height: 44px;
        padding: 6px 8px;
        display: block;
      }
      body[data-ui-mode="debug"] #debugPane .side-head > div:first-child { display: none; }
      body[data-ui-mode="debug"] #debugPane .side-head > .trace-actions {
        width: 100%;
        display: grid;
        grid-template-columns: minmax(0, 1fr) 34px;
        gap: 6px;
      }
      body[data-ui-mode="debug"] #debugPane .side-head .trace-view-tabs {
        min-width: 0;
        flex-wrap: nowrap;
        overflow: hidden;
        scrollbar-width: none;
      }
      body[data-ui-mode="debug"] #debugPane .side-head .trace-view-tabs::-webkit-scrollbar { display: none; }
      body[data-ui-mode="debug"] #debugPane .side-head .trace-view-tabs button {
        flex: 1 1 0;
        min-width: 0;
        height: 28px;
        padding-inline: 3px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 10px;
      }
      body[data-ui-mode="debug"] #refreshLogsBtn {
        width: 34px;
        min-width: 34px;
        height: 34px;
      }
      body[data-ui-mode="debug"] .debug-workspace {
        width: 100%;
        max-width: 100vw;
        grid-template-columns: minmax(0, 1fr);
        grid-template-rows: auto 48px minmax(0, 1fr);
      }
      body[data-ui-mode="debug"] .trace-scope-tabs {
        width: 100%;
        padding: 6px 8px;
        box-sizing: border-box;
      }
      body[data-ui-mode="debug"] .trace-scope-tabs button {
        flex: 1 1 0;
        padding-inline: 6px;
      }
      body[data-ui-mode="debug"] #debugPane,
      body[data-ui-mode="debug"] .trace-inspector,
      body[data-ui-mode="debug"] .trace-detail,
      body[data-ui-mode="debug"] .trace-detail-head {
        min-width: 0;
        width: 100%;
        max-width: 100vw;
        box-sizing: border-box;
      }
      body[data-ui-mode="debug"] .trace-inspector { grid-column: 1; }
      body[data-ui-mode="debug"] .mobile-trace-select {
        display: block;
        align-self: center;
        width: calc(100% - 16px);
        height: 36px;
        margin: 6px 8px;
        padding-inline: 9px 30px;
        font-size: 12px;
      }
      body[data-ui-mode="debug"] .trace-index { display: none; }
      body[data-ui-mode="debug"] .trace-detail-head {
        padding: 7px 8px 6px;
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 6px;
        overflow: hidden;
      }
      body[data-ui-mode="debug"] .trace-detail-head > .trace-actions {
        min-width: 0;
        width: 100%;
        max-width: 100%;
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 6px;
        overflow: visible;
      }
      body[data-ui-mode="debug"] .trace-detail-head .trace-view-tabs {
        min-width: 0;
        width: 100%;
        max-width: 100%;
        grid-column: 1 / -1;
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      body[data-ui-mode="debug"] .trace-detail-head .trace-view-tabs button,
      body[data-ui-mode="debug"] .trace-detail-head .secondary {
        min-width: 0;
        width: 100%;
        padding-inline: 5px;
        white-space: nowrap;
      }
      body[data-ui-mode="debug"] .trace-detail-head .secondary { height: 32px; font-size: 11px; }
      body[data-ui-mode="debug"] .trace-detail-title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      body[data-ui-mode="debug"] .trace-detail-meta {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      body[data-ui-mode="debug"] .trace-content { padding: 8px 8px 20px; }
      body[data-ui-mode="debug"] .trace-block summary { min-height: 34px; padding-block: 6px; }
      .scene-editor-form .character-grid,
      .memory-editor-form .character-grid { grid-template-columns: minmax(0, 1fr); }
      .scene-editor-form .character-grid .full,
      .memory-editor-form .character-grid .full { grid-column: auto; }
      .scene-info-actions > button { width: auto; }
    }

    .management-tabs { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .settings-tabs { grid-template-columns: repeat(5, minmax(0, 1fr)); }
    .settings-shell {
      max-width: 1040px;
      padding: 0;
      border: 0;
      background: transparent;
      box-shadow: none;
      display: grid;
      gap: 14px;
    }
    .settings-head h2 { margin: 0; }
    .settings-panel { min-width: 0; }
    .settings-data-section {
      margin-top: 20px;
      padding-top: 18px;
      border-top: 1px solid var(--line);
    }
    .settings-data-section h3 { margin-bottom: 12px; }
    .okf-section-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }
    .okf-section-head h3 { margin: 0; }
    .okf-version {
      flex: 0 0 auto;
      padding: 3px 7px;
      border: 1px solid #d8dde3;
      border-radius: 5px;
      color: #59636d;
      background: #f5f6f7;
      font: 10px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .okf-export-options {
      grid-column: 1 / -1;
      display: flex;
      align-items: center;
      gap: 10px 18px;
      flex-wrap: wrap;
      min-height: var(--control-height);
    }
    .okf-export-options .checkbox-row { color: #59636d; }
    .okf-import-preview {
      margin-top: 14px;
      border-block: 1px solid var(--line);
    }
    .okf-import-preview[hidden] { display: none; }
    .okf-preview-summary {
      min-height: 38px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      color: #4d5761;
      font-size: 12px;
    }
    .okf-preview-summary strong { color: var(--ink); }
    .okf-document-list {
      max-height: 224px;
      overflow: auto;
      border-top: 1px solid var(--line);
    }
    .okf-document-row {
      min-width: 0;
      display: grid;
      grid-template-columns: 18px minmax(0, 1fr) auto;
      gap: 9px;
      align-items: start;
      padding: 9px 2px;
      border-bottom: 1px solid var(--line);
      font-size: 11px;
    }
    .okf-document-row:last-child { border-bottom: 0; }
    .okf-document-row > svg { width: 15px; height: 15px; margin-top: 1px; }
    .okf-document-row.ready > svg { color: var(--primary); }
    .okf-document-row.unsupported > svg { color: #9a6a18; }
    .okf-document-row.invalid > svg { color: var(--danger); }
    .okf-document-row.reserved > svg { color: #7a848e; }
    .okf-document-copy { min-width: 0; display: grid; gap: 2px; }
    .okf-document-copy strong,
    .okf-document-copy span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .okf-document-copy span { color: var(--muted); }
    .okf-document-status { color: var(--muted); white-space: nowrap; }
    .settings-field select,
    .settings-field input,
    .settings-field textarea { width: 100%; min-width: 0; }
    .prompt-mode-tabs { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .prompt-settings-view-tabs {
      width: min(360px, 100%);
      margin-bottom: 16px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .meeting-preset-panel { display: grid; gap: 16px; }
    .meeting-preset-heading {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 14px;
    }
    .meeting-preset-heading h3 { margin: 0; }
    .meeting-preset-heading p {
      max-width: 680px;
      margin: 5px 0 0;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.55;
    }
    .meeting-preset-picker {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      gap: 8px;
      align-items: center;
    }
    .meeting-preset-picker select { width: 100%; min-width: 0; }
    .meeting-preset-import {
      padding: 13px 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fafbfa;
      display: grid;
      gap: 11px;
    }
    .meeting-preset-import[hidden] { display: none; }
    .meeting-preset-import-summary {
      min-width: 0;
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
    }
    .meeting-preset-import-summary strong {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .meeting-preset-import-summary span { color: var(--muted); font-size: 11px; }
    .meeting-preset-import-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(180px, 0.7fr);
      gap: 10px;
    }
    .meeting-preset-import-grid label,
    .meeting-preset-parameters-field {
      min-width: 0;
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 12px;
    }
    .meeting-preset-import-grid input,
    .meeting-preset-import-grid select { width: 100%; min-width: 0; }
    .meeting-preset-editor {
      min-width: 0;
      padding-top: 2px;
      border-top: 1px solid var(--line);
      display: grid;
      gap: 15px;
    }
    .meeting-preset-editor[hidden] { display: none; }
    .meeting-preset-editor-head {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 14px;
    }
    .meeting-preset-editor-head .settings-field { flex: 1 1 auto; }
    .meeting-preset-parameter-band {
      padding: 12px 0;
      border-block: 1px solid var(--line);
      display: grid;
      gap: 10px;
    }
    .meeting-preset-parameters {
      min-height: 110px;
      resize: vertical;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      line-height: 1.5;
    }
    .meeting-preset-compatibility {
      padding: 10px 12px;
      border: 1px solid #e0e5e2;
      border-radius: 7px;
      color: #59645e;
      background: #f8faf8;
      display: grid;
      gap: 5px;
      font-size: 11px;
      line-height: 1.5;
    }
    .meeting-preset-compatibility[hidden] { display: none; }
    .meeting-preset-compatibility strong { color: var(--ink); }
    .meeting-preset-compatibility .warn { color: #8b6416; }
    .meeting-preset-prompt-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
    }
    .meeting-preset-prompt-head h4 { margin: 0; font-size: 14px; }
    .meeting-preset-prompt-list { border-top: 1px solid var(--line); }
    .meeting-preset-prompt-row {
      min-width: 0;
      border-bottom: 1px solid var(--line);
    }
    .meeting-preset-prompt-row > summary {
      min-height: 48px;
      padding: 8px 2px;
      display: grid;
      grid-template-columns: 20px minmax(0, 1fr) auto auto;
      gap: 9px;
      align-items: center;
      cursor: pointer;
      list-style: none;
    }
    .meeting-preset-prompt-row > summary::-webkit-details-marker { display: none; }
    .meeting-preset-prompt-row > summary input { width: 16px; height: 16px; }
    .meeting-preset-prompt-row > summary strong {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
    }
    .meeting-preset-prompt-role,
    .meeting-preset-prompt-kind {
      padding: 2px 6px;
      border: 1px solid #dce1de;
      border-radius: 999px;
      color: #5e6963;
      background: #f7f8f7;
      font-size: 10px;
      white-space: nowrap;
    }
    .meeting-preset-prompt-kind { color: #3f7054; background: #f0f8f3; }
    .meeting-preset-prompt-editor {
      padding: 2px 2px 14px 31px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 150px;
      gap: 10px;
    }
    .meeting-preset-prompt-editor label {
      min-width: 0;
      display: grid;
      gap: 5px;
      color: var(--muted);
      font-size: 11px;
    }
    .meeting-preset-prompt-editor input,
    .meeting-preset-prompt-editor select,
    .meeting-preset-prompt-editor textarea { width: 100%; min-width: 0; }
    .meeting-preset-prompt-editor .full { grid-column: 1 / -1; }
    .meeting-preset-prompt-editor textarea {
      min-height: 132px;
      resize: vertical;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      line-height: 1.5;
    }
    .meeting-preset-prompt-row:not(.enabled) > summary strong { color: var(--muted); }
    .meeting-preset-empty {
      min-height: 110px;
      border-block: 1px solid var(--line);
      display: grid;
      place-items: center;
      color: var(--muted);
      font-size: 12px;
      text-align: center;
    }
    .character-preset-hint {
      color: var(--muted);
      font-size: 10px;
      line-height: 1.45;
    }
    .prompt-editor-field { margin-top: 14px; }
    .system-prompt-editor {
      min-height: 300px;
      height: min(44vh, 480px);
      max-height: none;
      resize: vertical;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      line-height: 1.55;
    }
    .system-prompt-details {
      margin-top: 14px;
      border-top: 1px solid var(--line);
    }
    .system-prompt-details summary {
      padding: 12px 0;
      color: #465468;
      cursor: pointer;
      font-size: 12px;
      font-weight: 650;
    }
    .system-prompt-details pre {
      max-height: 320px;
      margin: 0 0 10px;
      padding: 12px;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #f7f8f9;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-size: 11px;
      line-height: 1.55;
    }
    .composer {
      position: relative;
      grid-template-columns: minmax(0, 1fr) 38px 38px 38px 38px auto;
    }
    .attachment-queue {
      grid-column: 1 / -1;
      min-width: 0;
      display: flex;
      gap: 7px;
      overflow-x: auto;
      padding-bottom: 2px;
    }
    .attachment-queue[hidden] { display: none; }
    .attachment-chip {
      flex: 0 0 auto;
      max-width: 240px;
      min-height: 34px;
      padding: 4px 5px 4px 8px;
      border: 1px solid #d9d9d9;
      border-radius: 6px;
      background: #ffffff;
      display: grid;
      grid-template-columns: 18px minmax(0, 1fr) 26px;
      gap: 6px;
      align-items: center;
      box-shadow: var(--shadow);
    }
    .attachment-chip svg { width: 16px; height: 16px; color: #5c6670; }
    .attachment-chip-copy { min-width: 0; display: grid; gap: 1px; }
    .attachment-chip-copy strong,
    .attachment-chip-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .attachment-chip-copy strong { font-size: 11px; }
    .attachment-chip-copy small { color: var(--muted); font-size: 9px; }
    .attachment-remove {
      width: 26px;
      height: 26px;
      padding: 0;
      border: 0;
      border-radius: 5px;
      background: transparent;
      color: #7a7a7a;
      cursor: pointer;
      display: grid;
      place-items: center;
    }
    .attachment-remove:hover { background: #eeeeee; color: var(--danger); }
    .composer #attachFileBtn { grid-column: 2; }
    .composer #emojiPickerBtn { grid-column: 3; }
    .composer #cancelMessageBtn { grid-column: 4; }
    .composer #retryMessageBtn { grid-column: 5; }
    .composer #sendBtn { grid-column: 6; }
    .emoji-picker {
      position: absolute;
      z-index: 30;
      left: 18px;
      bottom: calc(100% - 2px);
      width: min(344px, calc(100vw - 36px));
      max-height: min(300px, calc(var(--app-height, 100dvh) - 180px));
      overflow: hidden;
      border: 1px solid #d5d7da;
      border-radius: 8px;
      background: #ffffff;
      box-shadow: 0 12px 34px rgba(0, 0, 0, 0.18);
      display: grid;
      grid-template-rows: 42px minmax(0, 1fr);
    }
    .emoji-picker[hidden] { display: none; }
    .emoji-category-tabs {
      min-width: 0;
      padding: 4px 6px;
      border-bottom: 1px solid #ececec;
      background: #f7f7f7;
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 3px;
    }
    .emoji-category-button,
    .emoji-option {
      min-width: 0;
      padding: 0;
      border: 0;
      background: transparent;
      cursor: pointer;
      font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Noto Emoji", sans-serif;
      touch-action: manipulation;
    }
    .emoji-category-button {
      height: 33px;
      border-radius: 5px;
      color: #62676d;
      font-size: 18px;
    }
    .emoji-category-button:hover { background: #eceeef; }
    .emoji-category-button.active { background: #dff4e8; color: #087d45; }
    .emoji-grid {
      min-height: 0;
      padding: 8px;
      overflow-y: auto;
      overscroll-behavior: contain;
      display: grid;
      grid-template-columns: repeat(8, minmax(32px, 1fr));
      grid-auto-rows: 38px;
      gap: 2px;
    }
    .emoji-option {
      width: 100%;
      height: 38px;
      border-radius: 6px;
      font-size: 23px;
      line-height: 1;
    }
    .emoji-option:hover,
    .emoji-option:focus-visible { background: #f0f1f2; outline: 0; }
    .workspace-file-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .workspace-file-location { min-width: 0; display: grid; gap: 4px; }
    .workspace-file-location h3 { margin: 0; }
    .workspace-file-location code { color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
    .workspace-file-actions { display: flex; align-items: center; gap: 7px; }
    .workspace-file-state { min-height: 18px; margin: 8px 0; }
    .workspace-file-list { border-top: 1px solid var(--line); }
    .workspace-file-row {
      min-width: 0;
      display: grid;
      grid-template-columns: 30px minmax(0, 1fr) minmax(110px, auto) minmax(120px, auto);
      gap: 10px;
      align-items: center;
      min-height: 50px;
      padding: 7px 0;
      border-bottom: 1px solid #ededed;
    }
    .workspace-file-icon { width: 30px; height: 30px; display: grid; place-items: center; color: #53616f; }
    .workspace-file-icon svg { width: 18px; height: 18px; }
    .workspace-file-name {
      min-width: 0;
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--text);
      text-align: left;
      cursor: pointer;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .workspace-file-name:hover { color: #087d45; }
    .workspace-file-meta { color: var(--muted); font-size: 10px; white-space: nowrap; }
    .workspace-file-row-actions { display: flex; justify-content: flex-end; gap: 3px; }
    .workspace-file-row-actions button { width: 30px; height: 30px; }
    .workspace-file-empty { padding: 36px 12px; color: var(--muted); text-align: center; font-size: 12px; }
    .workspace-file-preview-content {
      min-height: 180px;
      max-height: min(660px, calc(100vh - 112px));
      padding: 16px;
      overflow: auto;
      background: #f7f7f7;
    }
    .workspace-file-preview-content pre {
      margin: 0;
      padding: 14px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #ffffff;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    .workspace-file-preview-content img { display: block; max-width: 100%; max-height: 70vh; margin: auto; object-fit: contain; }
    .workspace-file-preview-content iframe { width: 100%; height: min(66vh, 640px); border: 0; background: #ffffff; }
    .chat-image-dialog {
      width: min(1080px, calc(100vw - 28px));
      max-height: calc(100vh - 28px);
      padding: 0;
      border: 1px solid #d8d8d8;
      border-radius: 8px;
      background: #ffffff;
      color: var(--text);
      box-shadow: 0 14px 38px rgba(0, 0, 0, 0.24);
    }
    .chat-image-dialog::backdrop { background: rgba(0, 0, 0, 0.56); }
    .chat-image-head { min-height: 52px; padding: 7px 9px 7px 16px; border-bottom: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .chat-image-head h2 { min-width: 0; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
    .chat-image-actions { display: flex; gap: 6px; }
    .chat-image-actions .icon-button { width: 34px; height: 34px; }
    .chat-image-stage { min-height: 240px; height: min(78vh, 760px); padding: 12px; display: grid; place-items: center; overflow: auto; background: #1c1c1c; }
    .chat-image-stage img { display: block; max-width: 100%; max-height: 100%; object-fit: contain; }

    @media (max-width: 900px) {
      .feature-test-toolbar { align-items: end; }
      .feature-test-field { min-width: min(100%, 210px); flex: 1 1 180px; }
      .feature-test-score-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .feature-test-dimensions { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .feature-test-history { overflow-x: auto; }
      .settings-shell { padding: 0; }
      .management-head,
      .settings-head { align-items: flex-start; }
      .management-tabs,
      .settings-tabs { width: 100%; }
      .prompt-settings-view-tabs { width: 100%; }
      .meeting-preset-heading,
      .meeting-preset-editor-head,
      .meeting-preset-import-summary { align-items: stretch; flex-direction: column; }
      .meeting-preset-picker { grid-template-columns: minmax(0, 1fr) repeat(2, auto); }
      .meeting-preset-import-grid,
      .meeting-preset-prompt-editor { grid-template-columns: minmax(0, 1fr); }
      .meeting-preset-prompt-editor { padding-left: 2px; }
      .meeting-preset-prompt-editor .full { grid-column: auto; }
      .meeting-preset-prompt-row > summary {
        grid-template-columns: 20px minmax(0, 1fr) auto;
      }
      .meeting-preset-prompt-kind { grid-column: 2 / -1; justify-self: start; }
      .composer { grid-template-columns: minmax(0, 1fr) 36px 36px 36px 36px auto; }
      .emoji-picker { left: 10px; width: min(344px, calc(100vw - 20px)); }
      .workspace-file-row { grid-template-columns: 30px minmax(0, 1fr) auto; }
      .workspace-file-meta { display: none; }
      .message-image-thumb,
      .message-inline-image { width: min(220px, 62vw); }
      .message-image-grid.multiple { grid-template-columns: repeat(2, minmax(0, 112px)); }
      .message-image-grid.multiple .message-image-thumb { width: 112px; }
      .chat-image-dialog { width: calc(100vw - 16px); max-height: calc(100vh - 16px); }
      .chat-image-stage { height: calc(100vh - 84px); padding: 8px; }
      .character-profile-dialog {
        width: calc(100vw - 16px);
        height: calc(100dvh - 16px);
        max-height: calc(100dvh - 16px);
      }
      .character-channel-dialog {
        width: calc(100vw - 16px);
        height: calc(100dvh - 16px);
        max-height: calc(100dvh - 16px);
      }
      .character-channel-messages { padding: 12px 10px max(16px, env(safe-area-inset-bottom, 0px)); }
      .character-channel-message-bubble { max-width: 92%; }
      .character-profile-identity { min-height: 116px; padding: 20px 18px; grid-template-columns: 72px minmax(0, 1fr); gap: 14px; }
      .character-profile-avatar { width: 72px; height: 72px; font-size: 24px; }
      .character-profile-soul { padding: 16px 18px max(24px, env(safe-area-inset-bottom, 0px)); }
      .workspace-file-row-actions { grid-column: 2 / -1; justify-content: flex-start; }
      .workspace-file-head { align-items: flex-start; }
      .workspace-file-actions { width: 100%; }
      .workspace-file-actions #workspaceFileUploadBtn { margin-left: auto; }
      .system-prompt-editor { min-height: 250px; height: 38vh; }
    }

    /* Chat chrome: navigation belongs to the sidebar; the top bar only identifies the active conversation. */
    .app { grid-template-rows: 64px minmax(0, 1fr) 28px; }
    .header-right {
      height: 64px;
      padding: 0 18px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .conversation-heading {
      min-width: 0;
      max-width: min(720px, calc(100% - 92px));
      margin-right: auto;
      display: flex;
      align-items: center;
      gap: 10px;
      overflow: hidden;
    }
    .conversation-header-avatar {
      flex: 0 0 38px;
      width: 38px;
      height: 38px;
      border-radius: 7px;
      overflow: hidden;
      display: grid;
      place-items: center;
      background: hsl(var(--avatar-hue, 145) 52% 46%);
      color: #ffffff;
      font-size: 13px;
      font-weight: 700;
    }
    button.conversation-header-avatar { padding: 0; border: 0; cursor: pointer; }
    button.conversation-header-avatar:disabled { cursor: default; }
    button.conversation-header-avatar:not(:disabled):hover,
    button.conversation-header-avatar:not(:disabled):focus-visible {
      box-shadow: 0 0 0 3px rgba(7, 168, 82, 0.14);
      outline: none;
    }
    .conversation-header-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .conversation-heading-copy { min-width: 0; display: grid; gap: 3px; }
    .conversation-title-line { min-width: 0; display: flex; align-items: center; gap: 8px; }
    .conversation-title-line strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; font-weight: 650; }
    .conversation-mode-badge {
      flex: 0 0 auto;
      color: #687078;
      font-size: 11px;
      white-space: nowrap;
    }
    .conversation-mode-badge::before { content: ""; display: inline-block; width: 5px; height: 5px; margin: 0 5px 1px 0; border-radius: 50%; background: #26a967; }
    .conversation-heading .conversation-scene {
      min-width: 0;
      display: block;
      color: #607066;
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .conversation-header-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; }
    .conversation-header-actions > .icon-button,
    .mobile-session-actions > .icon-button { width: 34px; height: 34px; }
    .conversation-header-actions > .context-budget-button {
      width: auto;
      min-width: 34px;
      padding: 0 9px;
      gap: 6px;
      color: #52615a;
      font-size: 11px;
      font-family: Arial, sans-serif;
      font-variant-numeric: normal;
      letter-spacing: 0;
      white-space: nowrap;
    }
    .context-budget-button svg { color: #239b61; }
    .context-budget-button[data-level="warning"] { color: #8a5b08; background: #fff8e6; border-color: #ead6a4; }
    .context-budget-button[data-level="warning"] svg { color: #b87800; }
    .context-budget-button[data-level="critical"] { color: #a33838; background: #fff1f0; border-color: #eac2bf; }
    .context-budget-button[data-level="critical"] svg { color: #c54848; }
    .context-budget-percent { display: none; }
    .mobile-session-actions { position: relative; display: block; }
    .session-actions-desktop { display: none; }
    .conversation-list-head-actions { display: flex; align-items: center; gap: 5px; }
    .new-conversation-form { padding: 18px; display: grid; gap: 16px; }
    .new-conversation-mode { min-width: 0; margin: 0; padding: 0; border: 0; }
    .new-conversation-mode legend { margin-bottom: 7px; color: var(--muted); font-size: 13px; }
    .new-conversation-mode .segmented { width: 100%; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .new-conversation-mode .segmented button { min-width: 0; }
    .scene-info-dialog { width: min(700px, calc(100vw - 28px)); }
    .scene-info-content { max-height: min(480px, calc(100vh - 176px)); padding: 8px 18px; overflow: auto; }
    .scene-info-row { padding: 11px 0; border-bottom: 1px solid #ededed; display: grid; grid-template-columns: 86px minmax(0, 1fr); gap: 12px; font-size: 12px; line-height: 1.55; }
    .scene-info-row:last-child { border-bottom: 0; }
    .scene-info-row dt { color: var(--muted); }
    .scene-info-row dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    .scene-info-actions { padding: 12px 18px 16px; border-top: 1px solid #ededed; display: flex; justify-content: flex-end; gap: 8px; }
    .world-event-actions { margin-right: auto; display: flex; gap: 7px; flex-wrap: wrap; }
    .world-event-actions[hidden] { display: none; }
    .scene-editor-form { max-height: min(560px, calc(100vh - 176px)); padding: 16px 18px; overflow: auto; }
    .scene-editor-form label { display: grid; gap: 6px; color: var(--muted); font-size: 13px; }
    .scene-editor-form textarea { min-height: 92px; }
    .context-budget-dialog { width: min(520px, calc(100vw - 28px)); overflow: hidden; }
    .context-budget-body { max-height: min(520px, calc(100dvh - 168px)); padding: 18px; overflow: auto; display: grid; gap: 16px; }
    .context-budget-summary { display: flex; align-items: end; justify-content: space-between; gap: 12px; }
    .context-budget-summary strong { font-family: Arial, sans-serif; font-size: 26px; line-height: 1; font-variant-numeric: normal; letter-spacing: 0; }
    .context-budget-summary span { color: var(--muted); font-size: 12px; text-align: right; }
    .context-budget-meter { height: 8px; overflow: hidden; border-radius: 4px; background: #e8ece9; }
    .context-budget-meter > span { display: block; width: 0; height: 100%; background: #26a967; transition: width 180ms ease; }
    .context-budget-meter[data-level="warning"] > span { background: #c48710; }
    .context-budget-meter[data-level="critical"] > span { background: #cb4b4b; }
    .context-budget-metrics { margin: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; overflow: hidden; border: 1px solid #e5e8e6; border-radius: 6px; background: #e5e8e6; }
    .context-budget-metrics > div { min-width: 0; padding: 10px 12px; background: #fff; display: grid; gap: 3px; }
    .context-budget-metrics dt { color: var(--muted); font-size: 11px; }
    .context-budget-metrics dd { margin: 0; overflow-wrap: anywhere; font-family: Arial, sans-serif; font-size: 12px; font-variant-numeric: normal; letter-spacing: 0; }
    .context-budget-note { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.55; }
    .context-budget-state { min-height: 18px; color: var(--muted); font-size: 12px; }
    .context-budget-dialog > .scene-info-actions { background: #ffffff; }

    @media (max-width: 900px) {
      .app {
        position: fixed;
        top: var(--visual-viewport-top, 0px);
        right: 0;
        left: 0;
        width: 100%;
        height: var(--app-height, 100dvh);
        grid-template-rows: 58px minmax(0, 1fr) calc(60px + env(safe-area-inset-bottom, 0px));
      }
      .header-right {
        grid-column: 1;
        grid-row: 1;
        width: 100%;
        height: 58px;
        padding: 0 10px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 7px;
        overflow: visible;
      }
      .conversation-heading {
        flex: 1 1 auto;
        min-width: 0;
        max-width: none;
        margin: 0;
        padding: 0;
        gap: 8px;
      }
      .header-right .conversation-list-toggle {
        position: static;
        flex: 0 0 32px;
        width: 32px;
        height: 32px;
        display: inline-grid;
      }
      .conversation-header-avatar { flex-basis: 34px; width: 34px; height: 34px; border-radius: 6px; }
      .conversation-heading-copy { gap: 2px; }
      .conversation-title-line strong { font-size: 14px; }
      .conversation-mode-badge,
      .conversation-heading .conversation-scene { font-size: 10px; }
      .conversation-title-line { gap: 6px; }
      .conversation-header-actions { gap: 4px; }
      .conversation-header-actions > .icon-button,
      .mobile-session-actions > .icon-button { width: 32px; height: 32px; }
      .conversation-header-actions > .context-budget-button { width: 32px; min-width: 32px; padding: 0; gap: 0; }
      .context-budget-button svg,
      .context-budget-tokens { display: none; }
      .context-budget-percent { display: inline; font-family: Arial, sans-serif; font-size: 9px; font-variant-numeric: normal; letter-spacing: 0; }
      .context-budget-body { padding: 14px 16px; gap: 12px; }
      .context-budget-summary strong { font-size: 23px; }
      .world-scene-turn { padding-bottom: 16px; gap: 11px; }
      .world-scene-copy { padding-inline: 2px; }
      .world-scene-fragment + .world-scene-fragment { margin-top: 14px; }
      .world-scene-text { font-size: 14px; line-height: 1.8; }
      .world-card-summary { grid-template-columns: minmax(0, 1fr); }
      .message-row.interaction { padding-inline: 8px; }
      .interaction-event { flex-wrap: wrap; gap: 6px; }
      .interaction-event::before,
      .interaction-event::after { width: 18px; }
      main { grid-column: 1; grid-row: 2; }
      .header-left { height: calc(60px + env(safe-area-inset-bottom, 0px)); padding-bottom: env(safe-area-inset-bottom, 0px); }
      .composer { padding-bottom: max(9px, env(safe-area-inset-bottom, 0px)); }
      .composer textarea { font-size: 16px; }
      body.keyboard-open .app { grid-template-rows: 58px minmax(0, 1fr) 0; }
      body.keyboard-open .header-left { visibility: hidden; pointer-events: none; }
      body.keyboard-open .composer { padding-bottom: 8px; }
      .scene-info-row { grid-template-columns: 72px minmax(0, 1fr); }
      .scene-info-actions { flex-wrap: wrap; }
      .world-event-actions { width: 100%; margin-right: 0; }
    }
  </style>
</head>
<body>
  <div class="app">
    <header>
      <div class="header-left">
        <h1><span id="brandUserAvatar" class="brand-mark">我</span><span class="brand-name">RP Agent</span></h1>
        <div class="segmented nav-segmented" aria-label="UI mode">
          <button id="normalBtn" class="active" type="button"><i data-lucide="message-circle" aria-hidden="true"></i><span>聊天</span></button>
          <button id="scheduleBtn" type="button"><i data-lucide="calendar-days" aria-hidden="true"></i><span>日程</span></button>
          <button id="charactersBtn" type="button"><i data-lucide="drama" aria-hidden="true"></i><span>角色</span></button>
          <button id="managementBtn" type="button"><i data-lucide="blocks" aria-hidden="true"></i><span>管理</span></button>
          <button id="settingsBtn" type="button"><i data-lucide="settings" aria-hidden="true"></i><span>设置</span></button>
          <button id="debugBtn" type="button"><i data-lucide="activity" aria-hidden="true"></i><span>Debug</span></button>
        </div>
      </div>
      <div class="header-right">
        <div class="conversation-heading">
          <button id="conversationListToggle" class="secondary icon-button conversation-list-toggle" type="button" title="会话列表" aria-label="会话列表"><i data-lucide="chevron-left" aria-hidden="true"></i></button>
          <button id="conversationHeaderAvatar" class="conversation-header-avatar" type="button" title="查看角色资料" aria-label="查看角色资料" disabled>角</button>
          <span class="conversation-heading-copy">
            <span class="conversation-title-line"><strong id="conversationCharacter">未选择角色</strong><span id="conversationMode" class="conversation-mode-badge">角色私聊</span></span>
            <span id="conversationScene" class="conversation-scene" hidden></span>
          </span>
        </div>
        <div class="conversation-header-actions">
          <button id="contextBudgetBtn" class="secondary icon-button context-budget-button" type="button" title="上下文余量" aria-label="查看上下文余量" hidden><i data-lucide="gauge" aria-hidden="true"></i><span id="contextBudgetTokens" class="context-budget-tokens">--</span><span id="contextBudgetPercent" class="context-budget-percent">--</span></button>
          <button id="interactionToggleBtn" class="secondary icon-button" type="button" title="发起见面" aria-label="发起见面" hidden><i data-lucide="map-pin" aria-hidden="true"></i></button>
          <button id="interactionUndoBtn" class="secondary icon-button" type="button" title="撤销上次状态切换" aria-label="撤销上次状态切换" hidden><i data-lucide="undo-2" aria-hidden="true"></i></button>
          <button id="sceneInfoBtn" class="secondary icon-button" type="button" title="场景信息" aria-label="场景信息" hidden><i data-lucide="map-pin" aria-hidden="true"></i></button>
          <div class="mobile-session-actions">
            <button id="sessionActionsMenuBtn" class="secondary icon-button" type="button" title="会话操作" aria-label="会话操作" aria-expanded="false" aria-controls="sessionActionsMenu"><i data-lucide="ellipsis" aria-hidden="true"></i></button>
            <div id="sessionActionsMenu" class="session-actions-menu" role="menu" hidden>
              <button id="mobileRenameSessionBtn" type="button" role="menuitem" disabled><i data-lucide="pencil" aria-hidden="true"></i><span>重命名会话</span></button>
              <button id="mobileArchiveSessionBtn" type="button" role="menuitem" disabled><i data-lucide="archive" aria-hidden="true"></i><span>归档会话</span></button>
              <button id="mobileDeleteSessionBtn" type="button" role="menuitem" disabled><i data-lucide="trash-2" aria-hidden="true"></i><span>永久删除会话</span></button>
              <button id="resetWorldConversationBtn" type="button" role="menuitem" hidden><i data-lucide="message-square-x" aria-hidden="true"></i><span>重置世界会话</span></button>
            </div>
          </div>
        </div>
        <div class="session-state-controls" hidden>
          <select id="sessionSelect" aria-label="会话"><option value="">新会话</option></select>
          <button id="newSessionBtn" type="button">新建会话</button>
          <button id="renameSessionBtn" type="button" disabled>重命名会话</button>
          <button id="archiveSessionBtn" type="button" disabled>归档会话</button>
          <button id="deleteSessionBtn" type="button" disabled>永久删除会话</button>
          <button id="archivedSessionsBtn" type="button">查看归档会话</button>
          <button id="mobileArchivedSessionsBtn" type="button">查看归档会话</button>
          <label id="modeControl"><select id="modeSelect"><option value="sms">角色私聊</option></select></label>
          <label id="chatCharacterControl"><select id="chatCharacterSelect"><option value="">请创建或选择角色</option></select></label>
        </div>
      </div>
    </header>
    <main id="mainPane">
      <section id="chatPane" class="chat">
        <div id="chatWorkspace" class="chat-workspace">
          <aside class="conversation-sidebar" aria-label="世界与角色会话列表">
            <div class="conversation-list-head"><strong id="conversationListTitle">会话</strong><span class="conversation-list-head-actions"><button id="sidebarBatchManageBtn" class="secondary icon-button" type="button" title="批量管理" aria-label="批量管理会话"><i data-lucide="list-checks" aria-hidden="true"></i></button><button id="sidebarArchivedSessionsBtn" class="secondary icon-button" type="button" title="归档会话" aria-label="查看归档会话"><i data-lucide="archive-restore" aria-hidden="true"></i></button><button id="sidebarNewSessionBtn" class="secondary icon-button" type="button" title="新建对话" aria-label="新建对话"><i data-lucide="message-square-plus" aria-hidden="true"></i></button></span></div>
            <div id="conversationList" class="conversation-list"></div>
            <div id="conversationBatchBar" class="conversation-batch-bar" hidden>
              <div class="conversation-batch-summary"><strong id="conversationBatchCount">已选 0 项</strong><button id="conversationBatchSelectAllBtn" class="text-button" type="button">全选</button></div>
              <div class="conversation-batch-actions"><button id="conversationBatchArchiveBtn" class="secondary" type="button" disabled><i data-lucide="archive" aria-hidden="true"></i><span>归档</span></button><button id="conversationBatchDeleteBtn" class="danger-button" type="button" disabled><i data-lucide="trash-2" aria-hidden="true"></i><span>删除</span></button></div>
            </div>
          </aside>
          <div class="chat-thread">
            <div id="messages" class="messages" aria-live="polite"></div>
            <form id="composer" class="composer">
              <div id="attachmentQueue" class="attachment-queue" hidden></div>
              <textarea id="textInput" placeholder="输入消息，例如：5分钟后提醒我喝水"></textarea>
              <div id="emojiPicker" class="emoji-picker" role="dialog" aria-label="选择表情" hidden>
                <div id="emojiPickerCategories" class="emoji-category-tabs" role="tablist" aria-label="表情分类"></div>
                <div id="emojiPickerGrid" class="emoji-grid" role="group" aria-label="表情列表"></div>
              </div>
              <input id="chatAttachmentInput" type="file" multiple hidden />
              <button id="attachFileBtn" class="secondary icon-button" type="button" title="上传附件" aria-label="上传附件"><i data-lucide="paperclip" aria-hidden="true"></i></button>
              <button id="emojiPickerBtn" class="secondary icon-button" type="button" title="选择表情" aria-label="选择表情" aria-expanded="false" aria-controls="emojiPicker"><i data-lucide="smile" aria-hidden="true"></i></button>
              <button id="cancelMessageBtn" class="secondary icon-button" type="button" title="停止生成" aria-label="停止" disabled><i data-lucide="square" aria-hidden="true"></i></button>
              <button id="retryMessageBtn" class="secondary icon-button" type="button" title="重试失败消息" aria-label="重试" disabled><i data-lucide="rotate-ccw" aria-hidden="true"></i></button>
              <button id="sendBtn" class="primary send-button" type="submit"><i data-lucide="send-horizontal" aria-hidden="true"></i><span>发送</span></button>
            </form>
          </div>
        </div>
      </section>
      <section id="schedulePage" class="settings-page" hidden>
        <div class="schedule-shell">
          <div class="schedule-owner-head">
            <div class="schedule-title-group">
              <h2>日程</h2>
              <div class="segmented schedule-owner-tabs" role="tablist" aria-label="日程归属">
                <button id="userScheduleTabBtn" class="active" type="button" role="tab" aria-selected="true"><i data-lucide="user" aria-hidden="true"></i><span>用户日程</span></button>
                <button id="characterScheduleTabBtn" type="button" role="tab" aria-selected="false"><i data-lucide="bot" aria-hidden="true"></i><span>角色日程</span></button>
              </div>
            </div>
            <label id="scheduleCharacterField" class="schedule-character-field" hidden><span>角色</span><select id="scheduleCharacterSelect" aria-label="角色日程角色"></select></label>
          </div>
          <div class="schedule-view-tabs segmented" role="tablist" aria-label="日程视图">
            <button id="scheduleAgendaViewBtn" class="active" type="button" role="tab" aria-selected="true">日程</button>
            <button id="scheduleCalendarViewBtn" type="button" role="tab" aria-selected="false">月历</button>
            <button id="scheduleTasksViewBtn" type="button" role="tab" aria-selected="false">任务</button>
          </div>
          <div class="schedule-head schedule-navigation">
            <div id="scheduleScopeSummary" class="schedule-scope-summary">我的现实日程与提醒</div>
            <div class="schedule-toolbar">
              <button id="scheduleTodayBtn" class="secondary" type="button">今天</button>
              <div class="schedule-month-nav" aria-label="月份切换">
                <button id="schedulePreviousMonthBtn" class="secondary icon-button" type="button" title="上个月" aria-label="上个月"><i data-lucide="chevron-left" aria-hidden="true"></i></button>
                <span id="scheduleMonthLabel" class="schedule-month-label"></span>
                <button id="scheduleNextMonthBtn" class="secondary icon-button" type="button" title="下个月" aria-label="下个月"><i data-lucide="chevron-right" aria-hidden="true"></i></button>
              </div>
              <button id="scheduleCreateBtn" class="primary" type="button"><i data-lucide="plus" aria-hidden="true"></i><span>新建</span></button>
            </div>
          </div>
          <div class="schedule-dashboard">
            <section class="calendar-panel" aria-label="月历">
              <div class="calendar-weekdays" aria-hidden="true"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div>
              <div id="scheduleCalendar" class="calendar-grid"></div>
            </section>
            <div class="schedule-side">
              <section class="schedule-agenda" aria-labelledby="scheduleAgendaTitle">
                <div class="schedule-agenda-head"><div class="schedule-head"><h3 id="scheduleAgendaTitle">当日日程</h3><span id="scheduleState" class="muted"></span></div></div>
                <div id="scheduleList" class="schedule-list"></div>
              </section>
              <section class="task-panel" aria-labelledby="taskListTitle">
                <div class="task-panel-head">
                  <div class="schedule-head"><h3 id="taskListTitle">任务清单</h3><span id="taskCount" class="muted"></span></div>
                  <div class="segmented task-filters" aria-label="任务筛选">
                    <button id="taskPendingBtn" class="active" type="button">待办</button>
                    <button id="taskAllBtn" type="button">全部</button>
                    <button id="taskCompletedBtn" type="button">已完成</button>
                  </div>
                </div>
                <div id="taskList" class="task-list"></div>
              </section>
            </div>
          </div>
        </div>
        <dialog id="scheduleEditorDialog" class="schedule-editor-dialog" aria-labelledby="scheduleEditorTitle">
          <div class="schedule-editor-head"><div><h3 id="scheduleEditorTitle">新建日程</h3><span id="scheduleEditorScope" class="schedule-editor-scope">用户日程</span></div><button id="closeScheduleEditorBtn" class="secondary icon-button" type="button" title="关闭" aria-label="关闭日程编辑"><i data-lucide="x" aria-hidden="true"></i></button></div>
          <form id="scheduleForm" class="schedule-editor">
            <div class="schedule-form">
              <label class="schedule-title-field">标题<input id="scheduleTitle" required /></label>
              <label class="schedule-kind-field">类型
                <select id="scheduleKind">
                  <option value="reminder">提醒</option>
                  <option value="event">事件</option>
                  <option value="task">任务</option>
                </select>
              </label>
              <label class="schedule-recurrence-field">重复
                <select id="scheduleRecurrence">
                  <option value="">不重复</option>
                  <option value="FREQ=DAILY">每天</option>
                  <option value="FREQ=WEEKLY">每周</option>
                </select>
              </label>
              <label class="checkbox-row schedule-all-day"><input id="scheduleAllDay" type="checkbox" /><span>全天</span></label>
              <label class="schedule-start-field">开始时间<input id="scheduleStart" type="datetime-local" /></label>
              <label id="scheduleEndField" class="schedule-end-field">结束时间<input id="scheduleEnd" type="datetime-local" /></label>
              <label class="full">备注<textarea id="scheduleNotes"></textarea></label>
            </div>
            <div class="settings-actions">
              <button id="saveScheduleBtn" class="primary" type="submit">创建日程</button>
              <button id="resetScheduleBtn" class="secondary" type="button">取消</button>
              <span id="scheduleEditorState" class="muted"></span>
            </div>
          </form>
        </dialog>
      </section>
      <section id="charactersPage" class="settings-page" hidden>
        <div class="character-shell">
          <div class="character-head">
            <h2>角色与世界</h2>
          </div>
          <section class="entity-library-section" aria-labelledby="characterLibraryTitle">
            <div class="entity-library-head">
              <div><h3 id="characterLibraryTitle">角色卡</h3><p>私聊身份、关系与个人记忆</p></div>
              <button id="newCharacterBtn" class="primary" type="button"><i data-lucide="user-plus" aria-hidden="true"></i><span>新建角色</span></button>
            </div>
            <div id="characterCardGrid" class="character-card-grid" aria-label="角色列表"></div>
            <div id="characterListEmpty" class="character-list-empty" hidden>
              <i data-lucide="users-round" aria-hidden="true"></i>
              <strong>还没有角色</strong>
            </div>
          </section>
          <section class="entity-library-section" aria-labelledby="worldLibraryTitle">
            <div class="entity-library-head">
              <div><h3 id="worldLibraryTitle">世界卡</h3><p>规则、地点、事件与演绎模型</p></div>
              <button id="newWorldCardBtn" class="primary" type="button"><i data-lucide="map-plus" aria-hidden="true"></i><span>新建世界</span></button>
            </div>
            <div id="worldCardGrid" class="character-card-grid world-card-grid" aria-label="世界列表"></div>
            <div id="worldListEmpty" class="character-list-empty" hidden>
              <i data-lucide="map" aria-hidden="true"></i>
              <strong>还没有世界</strong>
            </div>
          </section>
          <section id="characterDetail" class="character-detail" hidden>
            <div class="character-detail-head">
              <div class="character-detail-title"><span>角色资料</span><h3 id="characterDetailTitle">新角色</h3></div>
              <div class="segmented character-tabs" role="tablist" aria-label="角色管理视图">
                <button id="characterSettingsTabBtn" class="active" type="button" role="tab" aria-selected="true" aria-controls="characterSettingsPanel">角色设定</button>
                <button id="characterFunctionTabBtn" type="button" role="tab" aria-selected="false" aria-controls="characterFunctionPanel">职责能力</button>
                <button id="characterMemoryTabBtn" type="button" role="tab" aria-selected="false" aria-controls="characterMemoryPanel">长期记忆</button>
                <button id="characterRelationshipTabBtn" type="button" role="tab" aria-selected="false" aria-controls="characterRelationshipPanel">关系</button>
                <button id="characterLifeTabBtn" type="button" role="tab" aria-selected="false" aria-controls="characterLifePanel">生活</button>
              </div>
            </div>
            <div id="characterSettingsPanel" class="character-panel" role="tabpanel">
              <form id="characterForm" class="character-editor-form">
                <div class="character-editor-head"><h4>身份与 SOUL.md</h4><span id="characterState" class="muted"></span></div>
                <div class="character-grid">
                  <div class="full avatar-editor">
                    <span id="characterAvatarPreview" class="avatar-preview" style="--avatar-hue:145">角</span>
                    <div class="avatar-actions">
                      <input id="characterAvatarInput" type="file" accept="image/png,image/jpeg,image/webp" hidden />
                      <button id="changeCharacterAvatarBtn" class="secondary" type="button"><i data-lucide="image-plus" aria-hidden="true"></i><span>更换头像</span></button>
                      <button id="removeCharacterAvatarBtn" class="secondary" type="button"><i data-lucide="trash-2" aria-hidden="true"></i><span>移除</span></button>
                    </div>
                    <span class="avatar-hint">自动裁剪为正方形，仅保存在本机。</span>
	                  </div>
	                  <label>名称<input id="characterName" required /></label>
	                  <label>使用模型<select id="characterModelProfile"><option value="">继承系统默认模型</option></select></label>
	                  <label class="full">见面模式预设
	                    <select id="characterMeetingPreset"><option value="">不启用上下文预设</option></select>
	                    <span class="character-preset-hint">仅在角色处于现场见面状态时启用；退出见面后立即恢复 SMS 默认的系统提示词、用户画像和上下文编排。</span>
	                  </label>
	                  <div class="full character-soul-head">
                    <h4>SOUL.md</h4>
                    <span id="characterSoulCount" class="muted character-soul-count">0 / 8000</span>
                  </div>
                  <textarea id="characterSoulMarkdown" class="full character-soul-markdown" aria-label="角色 SOUL.md" spellcheck="false"></textarea>
                </div>
                <div class="settings-actions character-save-actions">
                  <button id="saveCharacterBtn" class="primary" type="submit">创建角色</button>
                </div>
              </form>
            </div>
            <div id="characterFunctionPanel" class="character-panel character-function-panel" role="tabpanel" hidden>
              <div class="character-function-head">
                <div><h4>职能与 SKILL.md</h4><span id="characterFunctionState" class="muted"></span></div>
                <div class="character-function-head-actions">
                  <label class="toggle"><span>自动维护</span><input id="characterFunctionAutomatic" type="checkbox" /></label>
                  <button id="refreshCharacterFunctionBtn" class="secondary" type="button"><i data-lucide="refresh-cw" aria-hidden="true"></i><span>重新分析</span></button>
                </div>
              </div>
              <section class="function-overview" aria-label="角色职能概览">
                <div class="function-overview-primary">
                  <div class="function-role-copy">
                    <span>当前职责</span>
                    <strong id="characterFunctionRole">尚未形成</strong>
                  </div>
                  <span id="characterFunctionStatusBadge" class="function-status-badge">等待分析</span>
                </div>
                <div id="characterFunctionCapabilities" class="function-capability-chips"></div>
                <span id="characterFunctionLearning" class="function-learning-summary"></span>
              </section>
              <section class="character-skill-document" aria-labelledby="characterSkillTitle">
                <div class="character-skill-document-head">
                  <div class="character-skill-title">
                    <strong id="characterSkillTitle">SKILL.md</strong>
                    <span id="characterSkillMeta">尚未生成</span>
                  </div>
                  <div class="character-skill-version-controls">
                    <select id="characterSkillVersionSelect" aria-label="Skill 历史版本" disabled></select>
                    <button id="activateCharacterSkillVersionBtn" class="secondary" type="button" hidden><i data-lucide="history" aria-hidden="true"></i><span>恢复</span></button>
                  </div>
                </div>
                <div id="characterSkillMarkdown" class="character-skill-markdown markdown-body"><div class="character-skill-empty">尚未生成 Skill</div></div>
              </section>
              <details id="characterFunctionAdvanced" class="character-function-advanced">
                <summary><i data-lucide="chevron-right" aria-hidden="true"></i><span>高级设置</span></summary>
                <form id="characterFunctionForm">
                  <div class="function-profile-grid">
                    <label>公开职责<input id="characterPublicRole" maxlength="120" /></label>
                    <label>并行任务上限
                      <select id="characterMaxConcurrentTasks">
                        <option value="1">1</option>
                        <option value="2">2</option>
                        <option value="3">3</option>
                        <option value="4">4</option>
                        <option value="5">5</option>
                      </select>
                    </label>
                    <label class="full">偏好任务<textarea id="characterTaskPreferences" maxlength="1000"></textarea></label>
                    <label class="full">回避任务<textarea id="characterAvoidedTasks" maxlength="1000"></textarea></label>
                  </div>
                  <div class="capability-section-head">
                    <h5>专业能力</h5>
                    <span id="characterCapabilityCount" class="muted">0 项</span>
                  </div>
                  <div id="characterCapabilityList" class="capability-list"></div>
                  <div class="settings-actions character-function-actions">
                    <button id="saveCharacterFunctionBtn" class="primary" type="submit">保存高级设置</button>
                  </div>
                </form>
              </details>
            </div>
            <div id="characterMemoryPanel" class="character-panel" role="tabpanel" hidden>
              <div class="character-memory-head">
                <div><h4>长期记忆</h4><span id="memoryState" class="muted"></span></div>
                <button id="addMemoryBtn" class="primary" type="button"><i data-lucide="plus" aria-hidden="true"></i><span>添加记忆</span></button>
              </div>
              <div class="memory-toolbar">
                <input id="memorySearch" placeholder="搜索内容或标签" aria-label="搜索长期记忆" />
                <button id="searchMemoryBtn" class="secondary" type="button"><i data-lucide="search" aria-hidden="true"></i><span>搜索</span></button>
              </div>
              <div id="memoryList" class="memory-list"></div>
            </div>
            <div id="characterRelationshipPanel" class="character-panel relationship-panel" role="tabpanel" hidden>
              <div class="relationship-head">
                <div class="relationship-head-copy"><h4>关系与情绪</h4><span id="relationshipState" class="muted"></span></div>
                <button id="resetRelationshipBtn" class="secondary" type="button"><i data-lucide="rotate-ccw" aria-hidden="true"></i><span>重置</span></button>
              </div>
              <div id="relationshipOverview" class="relationship-overview"></div>
              <section class="relationship-events">
                <h5>变化记录</h5>
                <div id="relationshipEventList" class="relationship-event-list"></div>
              </section>
            </div>
            <div id="characterLifePanel" class="character-panel character-life-panel" role="tabpanel" hidden>
              <div class="character-life-head">
                <div><h4>共享世界与自主生活</h4><span id="characterLifeState" class="muted"></span></div>
              </div>
              <div class="life-world-binding">
                <label>所在世界<select id="characterWorldSelect"><option value="">不加入共享世界</option></select></label>
                <button id="saveCharacterWorldBtn" class="secondary" type="button"><i data-lucide="link" aria-hidden="true"></i><span>保存归属</span></button>
              </div>
              <div id="characterLifeEmpty" class="relationship-empty">选择一个共享世界后，可设置地点、日程和主动消息。</div>
              <div id="characterLifeContent" hidden>
                <section class="life-runtime-band" aria-label="角色当前状态">
                  <div><span>当前位置</span><strong id="lifeCurrentPlace">未设置</strong></div>
                  <div><span>正在做</span><strong id="lifeCurrentActivity">自由活动</strong></div>
                  <div><span>状态</span><strong id="lifeAvailability">空闲</strong></div>
                  <div><span>精力</span><strong id="lifeEnergy">70</strong></div>
                </section>
                <section class="life-settings-band">
                  <div class="life-settings-grid">
                    <label>常驻地点<select id="lifeHomePlace"></select></label>
                    <label>当前位置<select id="lifeRuntimePlace"></select></label>
                    <label>每日主动消息上限<input id="lifeDailyMessageLimit" type="number" min="0" max="5" step="1" /></label>
                    <label>主动消息冷却（分钟）<input id="lifeProactiveCooldown" type="number" min="15" max="1440" step="15" /></label>
                    <label>每日角色私聊上限<input id="lifeSocialDailyLimit" type="number" min="0" max="5" step="1" /></label>
                    <label>角色私聊冷却（分钟）<input id="lifeSocialCooldown" type="number" min="30" max="1440" step="30" /></label>
                    <label>安静时段开始<input id="lifeQuietStart" type="time" /></label>
                    <label>安静时段结束<input id="lifeQuietEnd" type="time" /></label>
                    <div class="life-toggle-stack">
                      <label class="toggle"><span>自主安排日程</span><input id="lifeAutonomyEnabled" type="checkbox" /></label>
                      <label class="toggle"><span>允许主动发消息</span><input id="lifeProactiveEnabled" type="checkbox" /></label>
                      <label class="toggle"><span>允许自主角色私聊</span><input id="lifeSocialEnabled" type="checkbox" /></label>
                    </div>
                  </div>
                  <div class="settings-actions life-actions">
                    <button id="saveCharacterLifeBtn" class="primary" type="button">保存生活设置</button>
                    <button id="planCharacterLifeBtn" class="secondary" type="button"><i data-lucide="calendar-plus" aria-hidden="true"></i><span>安排今日</span></button>
                    <button id="simulateCharacterMomentBtn" class="secondary" type="button"><i data-lucide="sparkles" aria-hidden="true"></i><span>模拟生活片段</span></button>
                  </div>
                  <div id="lifeProactivePause" class="life-proactive-pause" hidden>
                    <span id="lifeProactivePauseText"></span>
                    <button id="resumeProactiveBtn" class="secondary" type="button"><i data-lucide="play" aria-hidden="true"></i><span>恢复主动消息</span></button>
                  </div>
                </section>
                <section class="life-detail-grid">
                  <div class="life-detail-section"><h5>地点能力</h5><div id="lifePlaceList" class="life-place-list"></div></div>
                  <div class="life-detail-section"><h5>近期事件</h5><div id="lifeEventList" class="life-event-list"></div></div>
                  <div class="life-detail-section"><h5>主动消息决策</h5><div id="lifeProactiveList" class="life-proactive-list"></div></div>
                  <div class="life-detail-section"><h5>主题偏好</h5><div id="lifeTopicPolicyList" class="life-topic-policy-list"></div></div>
                </section>
              </div>
            </div>
          </section>
        </div>
      </section>
      <section id="managementPage" class="settings-page" hidden>
        <div class="management-shell">
          <div class="management-head">
            <h2>Agent 管理</h2>
            <div class="segmented management-tabs" aria-label="管理视图">
              <button id="modulesTabBtn" class="active" type="button">能力模块</button>
              <button id="profileTabBtn" type="button">用户画像</button>
              <button id="memoryManagementTabBtn" type="button">记忆</button>
              <button id="workspaceFilesTabBtn" type="button">文件</button>
            </div>
          </div>
          <section id="modulesPanel" class="management-panel">
            <div class="schedule-head">
              <h3>MCP 与 Skills</h3>
              <button id="refreshModulesBtn" class="secondary" type="button">重新扫描</button>
            </div>
            <div id="moduleList" class="module-list"></div>
            <div class="permission-section">
              <div class="schedule-head">
                <h3>权限与工作区</h3>
                <code id="workspacePath" class="permission-path"></code>
              </div>
              <div id="permissionControls" class="permission-list">
                <div class="permission-row">
                  <div>
                    <div class="module-name">文件访问</div>
                    <div class="module-description">Agent 对专用 workspace 的访问级别</div>
                  </div>
                  <div id="workspaceAccessControls" class="segmented permission-access" aria-label="Workspace 文件访问权限">
                    <button type="button" data-workspace-access="off">关闭</button>
                    <button type="button" data-workspace-access="read_only">只读</button>
                    <button type="button" data-workspace-access="read_write">读写</button>
                  </div>
                </div>
                <div class="permission-row">
                  <div>
                    <div class="module-name">终端执行</div>
                    <div class="module-description">在 Bubblewrap 沙箱中执行命令</div>
                  </div>
                  <label class="toggle"><span id="shellPermissionLabel">已关闭</span><input id="shellPermissionInput" type="checkbox" data-permission="shellEnabled" /></label>
                </div>
                <div class="permission-row">
                  <div>
                    <div class="module-name">终端网络</div>
                    <div class="module-description">允许沙箱命令访问网络</div>
                  </div>
                  <label class="toggle"><span id="networkPermissionLabel">已关闭</span><input id="networkPermissionInput" type="checkbox" data-permission="networkEnabled" /></label>
                </div>
                <div class="permission-row">
                  <div>
                    <div class="module-name">用户画像自动编辑</div>
                    <div class="module-description">允许 User Profile MCP 更新画像 Markdown</div>
                  </div>
                  <label class="toggle"><span id="profileWritePermissionLabel">已关闭</span><input id="profileWritePermissionInput" type="checkbox" data-permission="userProfileWriteEnabled" /></label>
                </div>
                <div class="permission-row">
                  <div>
                    <div class="module-name">角色 SOUL 自动编辑</div>
                    <div class="module-description">允许当前角色专用 MCP 更新 SOUL.md</div>
                  </div>
                  <label class="toggle"><span id="soulWritePermissionLabel">已关闭</span><input id="soulWritePermissionInput" type="checkbox" data-permission="characterSoulWriteEnabled" /></label>
                </div>
                <div class="permission-row">
                  <div>
                    <div class="module-name">现实记忆收录</div>
                    <div class="module-description">允许 MCP 提议；后台可收录有原话依据的低风险信息与可信用户日程规律</div>
                  </div>
                  <label class="toggle"><span id="realityMemoryWritePermissionLabel">已关闭</span><input id="realityMemoryWritePermissionInput" type="checkbox" data-permission="realityMemoryWriteEnabled" /></label>
                </div>
                <div class="permission-row">
                  <div>
                    <div class="module-name">角色记忆提议</div>
                    <div class="module-description">允许 Agent MCP 为当前角色创建 pending RP 候选</div>
                  </div>
                  <label class="toggle"><span id="characterMemoryWritePermissionLabel">已关闭</span><input id="characterMemoryWritePermissionInput" type="checkbox" data-permission="characterMemoryWriteEnabled" /></label>
                </div>
              </div>
              <div id="permissionRuntime" class="muted permission-runtime"></div>
            </div>
          </section>
          <section id="profilePanel" class="management-panel" hidden>
            <div class="schedule-head">
              <h3>用户画像 Markdown</h3>
              <span id="profileCharacterCount" class="muted profile-character-count">0 / 2000</span>
            </div>
            <form id="profileDocumentForm" class="profile-document-form">
              <div class="avatar-editor">
                <span id="userAvatarPreview" class="avatar-preview" style="--avatar-hue:145">我</span>
                <div class="avatar-actions">
                  <input id="userAvatarInput" type="file" accept="image/png,image/jpeg,image/webp" hidden />
                  <button id="changeUserAvatarBtn" class="secondary" type="button"><i data-lucide="image-plus" aria-hidden="true"></i><span>更换头像</span></button>
                  <button id="removeUserAvatarBtn" class="secondary" type="button"><i data-lucide="trash-2" aria-hidden="true"></i><span>移除</span></button>
                </div>
                <span class="avatar-hint">用于聊天中的用户消息头像。</span>
              </div>
              <textarea id="profileMarkdown" class="profile-markdown" aria-label="用户画像 Markdown" spellcheck="false"></textarea>
              <div class="settings-actions">
                <button id="saveProfileBtn" class="primary" type="submit">保存画像</button>
                <span id="profileState" class="muted"></span>
              </div>
            </form>
            <section class="user-insight-section" aria-labelledby="userInsightTitle">
              <div class="schedule-head">
                <div>
                  <h3 id="userInsightTitle">画像形成记录</h3>
                  <div id="userInsightSummary" class="muted user-insight-summary">尚未加载</div>
                </div>
                <button id="refreshUserInsightsBtn" class="secondary icon-button" type="button" title="刷新画像形成记录" aria-label="刷新画像形成记录"><i data-lucide="refresh-cw" aria-hidden="true"></i></button>
              </div>
              <div id="userInsightList" class="user-insight-list"></div>
            </section>
          </section>
          <section id="memoryManagementPanel" class="management-panel" hidden>
            <div class="schedule-head">
              <div>
                <h3>长期记忆</h3>
                <div id="memoryCoordinatorState" class="muted"></div>
              </div>
              <button id="refreshManagedMemoriesBtn" class="secondary icon-button" type="button" title="刷新记忆" aria-label="刷新记忆"><i data-lucide="refresh-cw" aria-hidden="true"></i></button>
            </div>
            <div class="memory-manager-toolbar">
              <select id="managedMemoryRealm" aria-label="记忆领域"><option value="">全部领域</option><option value="reality">现实</option><option value="roleplay">角色</option><option value="legacy">隔离</option></select>
              <select id="managedMemoryCharacter" aria-label="筛选角色"><option value="">全部角色</option></select>
              <select id="managedMemoryTypeFilter" aria-label="记忆类型"><option value="">全部类型</option><option value="user_fact">用户事实</option><option value="preference">偏好</option><option value="goal">目标</option><option value="person">人物</option><option value="project">项目</option><option value="relationship_event">关系事件</option><option value="world_fact">世界事实</option><option value="plot_event">剧情事件</option><option value="boundary">边界</option></select>
              <select id="managedMemoryValidity" aria-label="记忆状态"><option value="">全部状态</option><option value="pending">待确认</option><option value="active">已确认</option><option value="rejected">已拒绝</option><option value="archived">已归档</option><option value="superseded">已替换</option><option value="deleted">已遗忘</option></select>
              <input id="managedMemoryQuery" type="search" placeholder="搜索正文或标签" aria-label="搜索记忆" />
              <button id="searchManagedMemoriesBtn" class="secondary icon-button" type="button" title="搜索" aria-label="搜索记忆"><i data-lucide="search" aria-hidden="true"></i></button>
            </div>
            <form id="managedMemoryForm" class="memory-manager-form">
              <label>领域<select id="managedMemoryCreateRealm"><option value="reality">现实</option><option value="roleplay">角色</option></select></label>
              <label>类型<select id="managedMemoryCreateType"></select></label>
              <label>角色<select id="managedMemoryCreateCharacter"><option value="">不绑定角色</option></select></label>
              <label>键<input id="managedMemoryCreateKey" placeholder="例如 user.location" /></label>
              <label class="full">正文<textarea id="managedMemoryCreateContent" required></textarea></label>
              <div class="settings-actions full"><button class="primary" type="submit">固定记忆</button><span id="managedMemoryActionState" class="muted"></span></div>
            </form>
            <section class="person-directory" aria-labelledby="personDirectoryTitle">
              <div class="schedule-head">
                <h3 id="personDirectoryTitle">现实人物档案</h3>
                <span id="personProfileCount" class="muted"></span>
              </div>
              <div id="personProfileList" class="person-profile-list"></div>
            </section>
            <section class="retrieval-preview" aria-labelledby="retrievalPreviewTitle">
              <div class="schedule-head"><h3 id="retrievalPreviewTitle">检索预览</h3><span class="muted">只读，不更新命中状态</span></div>
              <form id="retrievalPreviewForm" class="retrieval-preview-toolbar">
                <select id="retrievalPreviewMode" aria-label="预览模式"><option value="sms">角色私聊</option><option value="rp">世界角色记忆</option></select>
                <input id="retrievalPreviewQuery" type="search" placeholder="输入查询，空查询仅预览 bootstrap" aria-label="检索预览查询" />
                <input id="retrievalPreviewBudget" type="number" min="32" max="2000" value="360" aria-label="记忆 token 预算" />
                <button class="secondary" type="submit">运行预览</button>
              </form>
              <div id="retrievalPreviewState" class="muted" style="margin-top:8px;"></div>
              <div id="retrievalPreviewResults" class="retrieval-preview-results" hidden></div>
            </section>
            <div id="managedMemoryList" class="memory-list"></div>
            <div class="schedule-head" style="margin-top:18px;"><h3>最近捕获任务</h3><span id="memoryJobCount" class="muted"></span></div>
            <div id="memoryJobList" class="memory-job-list"></div>
          </section>
          <section id="workspaceFilesPanel" class="management-panel" hidden>
            <div class="workspace-file-head">
              <div class="workspace-file-location">
                <h3>Workspace 文件</h3>
                <code id="workspaceFilePath">/</code>
              </div>
              <div class="workspace-file-actions">
                <input id="workspaceFileUploadInput" type="file" multiple hidden />
                <button id="workspaceFileUpBtn" class="secondary icon-button" type="button" title="上一级" aria-label="上一级"><i data-lucide="corner-left-up" aria-hidden="true"></i></button>
                <button id="workspaceFileRefreshBtn" class="secondary icon-button" type="button" title="刷新文件" aria-label="刷新文件"><i data-lucide="refresh-cw" aria-hidden="true"></i></button>
                <button id="workspaceFileUploadBtn" class="primary" type="button"><i data-lucide="upload" aria-hidden="true"></i><span>上传</span></button>
              </div>
            </div>
            <div id="workspaceFileState" class="muted workspace-file-state"></div>
            <div id="workspaceFileList" class="workspace-file-list"></div>
          </section>
        </div>
      </section>
      <aside id="debugPane" hidden>
        <div class="side-head">
          <div>
            <h2>上下文调试</h2>
            <div class="trace-legend">
              <span class="trace-key"><span class="trace-swatch system"></span>System</span>
              <span class="trace-key"><span class="trace-swatch user"></span>User</span>
              <span class="trace-key"><span class="trace-swatch assistant"></span>Assistant</span>
              <span class="trace-key"><span class="trace-swatch tool"></span>Tool</span>
              <span class="trace-key"><span class="trace-swatch schema"></span>Tools schema</span>
            </div>
          </div>
          <div class="trace-actions">
            <div class="trace-view-tabs" role="tablist" aria-label="调试数据类型">
              <button id="debugTracesBtn" class="active" type="button" role="tab" aria-selected="true">Provider Trace</button>
              <button id="debugEconomicsBtn" type="button" role="tab" aria-selected="false">Context Economics</button>
              <button id="debugInitiativeBtn" type="button" role="tab" aria-selected="false">主动决策</button>
              <button id="debugFeatureTestsBtn" type="button" role="tab" aria-selected="false">功能测试</button>
            </div>
            <button id="refreshLogsBtn" class="secondary icon-button" type="button" title="刷新日志" aria-label="刷新日志"><i data-lucide="refresh-cw" aria-hidden="true"></i></button>
          </div>
        </div>
        <div id="debugWorkspace" class="debug-workspace">
          <div id="traceScopeTabs" class="trace-scope-tabs" role="tablist" aria-label="模型请求来源">
            <button id="conversationTraceScopeBtn" class="active" type="button" role="tab" aria-selected="true" title="用户触发的会话内模型请求">
              会话内<span id="conversationTraceCount" class="trace-scope-count">0</span>
            </button>
            <button id="backgroundTraceScopeBtn" type="button" role="tab" aria-selected="false" title="角色或系统在会话外发起的模型请求">
              会话外<span id="backgroundTraceCount" class="trace-scope-count">0</span>
            </button>
          </div>
          <select id="mobileTraceSelect" class="mobile-trace-select" aria-label="选择模型调用记录"></select>
          <nav id="traceIndex" class="trace-index" aria-label="模型调用记录"></nav>
          <section class="trace-inspector">
            <div id="traceEmpty" class="trace-empty">选择一条记录查看上下文。</div>
            <div id="traceDetail" class="trace-detail" hidden>
              <div class="trace-detail-head">
                <div>
                  <h3 id="traceDetailTitle" class="trace-detail-title"></h3>
                  <div id="traceDetailMeta" class="trace-detail-meta"></div>
                </div>
                <div class="trace-actions">
                  <div class="trace-view-tabs" role="tablist" aria-label="Trace 查看方式">
                    <button id="traceSemanticBtn" class="active" type="button" role="tab" aria-selected="true">语义上下文</button>
                    <button id="traceRawBtn" type="button" role="tab" aria-selected="false">原始 JSON</button>
                  </div>
                  <button id="traceExpandBtn" class="secondary" type="button">全部展开</button>
                  <button id="traceWrapBtn" class="secondary" type="button" aria-pressed="true">不换行</button>
                  <button id="traceCopyBtn" class="secondary" type="button">复制 Payload</button>
                </div>
              </div>
              <div id="traceContent" class="trace-content"></div>
            </div>
          </section>
        </div>
        <section id="featureTestPanel" class="feature-test-panel" hidden>
          <div class="feature-test-toolbar">
            <label class="feature-test-field"><span>测试角色</span><select id="featureTestCharacter" aria-label="测试角色"><option value="">选择测试角色</option></select></label>
            <label class="feature-test-field"><span>被测模型</span><select id="featureTestTargetModel" aria-label="被测模型"><option value="">选择被测模型</option></select></label>
            <label class="feature-test-field"><span>Judge 模型</span><select id="featureTestJudgeModel" aria-label="Judge 模型"><option value="">仅功能评分</option></select></label>
            <button id="selectAllFeatureTestsBtn" class="secondary" type="button">全选</button>
            <button id="runFeatureTestsBtn" class="primary" type="button"><i data-lucide="play" aria-hidden="true"></i><span>运行所选测试</span></button>
            <button id="exportFeatureTestReportBtn" class="secondary" type="button" disabled><i data-lucide="download" aria-hidden="true"></i><span>导出 JSON</span></button>
            <span id="featureTestState" class="feature-test-state"></span>
          </div>
          <div id="featureTestReport" class="feature-test-report"></div>
          <div id="featureTestHistory" class="feature-test-history"></div>
          <div id="featureTestResults" class="feature-test-results"></div>
          <div id="featureTestList" class="feature-test-list"></div>
        </section>
        <section id="initiativeDebugPanel" class="initiative-debug-panel" hidden>
          <div class="feature-test-toolbar">
            <select id="initiativeCharacterFilter" aria-label="筛选角色"><option value="">全部角色</option></select>
            <select id="initiativeDecisionFilter" aria-label="筛选主动决策">
              <option value="">全部决策</option>
              <option value="delivered">已发送</option>
              <option value="pending">等待与延后</option>
              <option value="skipped">已丢弃</option>
              <option value="failed">生成失败</option>
            </select>
            <span id="initiativeDebugState" class="muted"></span>
          </div>
          <div id="initiativeSummary" class="initiative-summary"></div>
          <div id="initiativeDebugList" class="initiative-debug-list"></div>
        </section>
      </aside>
      <section id="settingsPage" class="settings-page" hidden>
        <div class="settings-shell">
          <div class="management-head settings-head">
            <h2>设置</h2>
            <div class="segmented settings-tabs" aria-label="设置视图">
              <button id="modelSettingsTabBtn" class="active" type="button">模型</button>
              <button id="visionSettingsTabBtn" type="button">视觉</button>
              <button id="searchSettingsTabBtn" type="button">搜索</button>
              <button id="promptSettingsTabBtn" type="button">提示词</button>
              <button id="dataSettingsTabBtn" type="button">数据</button>
            </div>
          </div>
          <section id="modelSettingsPanel" class="management-panel settings-panel">
            <h3>模型 API</h3>
            <div class="model-profile-bar">
              <select id="apiProfileSelect" aria-label="模型配置"></select>
              <button id="newApiProfileBtn" class="secondary icon-button" type="button" title="新建模型配置" aria-label="新建模型配置"><i data-lucide="plus" aria-hidden="true"></i></button>
              <button id="defaultApiProfileBtn" class="secondary icon-button" type="button" title="设为系统默认" aria-label="设为系统默认"><i data-lucide="star" aria-hidden="true"></i></button>
              <button id="deleteApiProfileBtn" class="secondary icon-button" type="button" title="删除模型配置" aria-label="删除模型配置"><i data-lucide="trash-2" aria-hidden="true"></i></button>
            </div>
            <div class="settings-grid">
              <div class="settings-field full">
                <label for="apiProfileName">配置名称</label>
                <input id="apiProfileName" placeholder="例如：红莉栖专用" />
              </div>
              <label class="checkbox-row full">
                <input id="apiEnabled" type="checkbox" />
                <span>启用 OpenAI-compatible API</span>
              </label>
              <label class="checkbox-row full">
                <input id="apiVisionInputEnabled" type="checkbox" />
                <span>该主模型支持图片输入</span>
              </label>
              <div class="settings-field full">
                <label for="apiBaseUrl">Base URL</label>
                <input id="apiBaseUrl" placeholder="http://127.0.0.1:8317/v1" />
              </div>
              <div class="settings-field">
                <label for="apiModel">模型名</label>
                <select id="apiModel"><option value="">读取模型后选择</option><option value="__custom__">手动输入...</option></select>
                <input id="apiModelCustom" placeholder="输入模型名" hidden />
              </div>
              <div class="settings-field">
                <label for="apiKey">API Key</label>
                <input id="apiKey" type="password" placeholder="留空表示不修改" autocomplete="off" />
              </div>
              <div class="settings-field">
                <label for="apiTemperature">Temperature</label>
                <input id="apiTemperature" type="number" step="0.1" min="0" max="2" placeholder="可选" />
              </div>
              <div class="settings-field">
                <label for="apiMaxTokens">Max Tokens</label>
                <input id="apiMaxTokens" type="number" min="1" step="1" placeholder="可选" />
              </div>
              <div class="settings-field">
                <label for="apiContextWindowTokens">上下文窗口</label>
                <input id="apiContextWindowTokens" type="number" min="8192" max="2000000" step="1024" placeholder="131072" />
              </div>
            </div>
            <div class="settings-actions">
              <button id="saveApiSettingsBtn" class="primary" type="button">保存设置</button>
              <button id="testModelBtn" class="secondary" type="button">测试连接</button>
              <button id="discoverModelsBtn" class="secondary" type="button">读取模型</button>
              <button id="clearApiKeyBtn" class="secondary" type="button">清除 Key</button>
              <span id="apiSettingsState" class="muted"></span>
            </div>
          </section>
          <section id="visionSettingsPanel" class="management-panel settings-panel" hidden>
            <h3>图片理解</h3>
            <div class="settings-grid">
              <div class="settings-field">
                <label for="visionMode">处理模式</label>
                <select id="visionMode">
                  <option value="auto">自动</option>
                  <option value="direct">主模型直读</option>
                  <option value="mcp">Vision MCP</option>
                  <option value="off">关闭</option>
                </select>
              </div>
              <div class="settings-field">
                <label for="visionDetail">图片精度</label>
                <select id="visionDetail">
                  <option value="auto">自动</option>
                  <option value="low">低</option>
                  <option value="high">高</option>
                </select>
              </div>
              <div class="settings-field full">
                <label for="visionBaseUrl">Base URL</label>
                <input id="visionBaseUrl" placeholder="https://api.openai.com/v1" />
              </div>
              <div class="settings-field">
                <label for="visionModel">视觉模型</label>
                <select id="visionModel"><option value="">读取模型后选择</option><option value="__custom__">手动输入...</option></select>
                <input id="visionModelCustom" placeholder="输入视觉模型名" hidden />
              </div>
              <div class="settings-field">
                <label for="visionApiKey">API Key</label>
                <input id="visionApiKey" type="password" placeholder="留空表示不修改" autocomplete="off" />
              </div>
              <div class="settings-field">
                <label for="visionMaxImages">单轮图片上限</label>
                <input id="visionMaxImages" type="number" min="1" max="8" step="1" value="4" />
              </div>
            </div>
            <div class="settings-actions">
              <button id="saveVisionSettingsBtn" class="primary" type="button">保存设置</button>
              <button id="testVisionBtn" class="secondary" type="button">测试连接</button>
              <button id="discoverVisionModelsBtn" class="secondary" type="button">读取模型</button>
              <button id="clearVisionApiKeyBtn" class="secondary" type="button">清除 Key</button>
              <span id="visionSettingsState" class="muted"></span>
            </div>
          </section>
          <section id="searchSettingsPanel" class="management-panel settings-panel" hidden>
            <h3>Tavily 网页搜索</h3>
            <div class="settings-grid">
              <div class="settings-field full">
                <label for="tavilyApiKey">Tavily API Key</label>
                <input id="tavilyApiKey" type="password" placeholder="tvly-...（留空表示不修改）" autocomplete="off" />
              </div>
              <div class="settings-field full">
                <label for="tavilyProxyUrl">HTTPS 代理（可选）</label>
                <input id="tavilyProxyUrl" type="password" placeholder="例如 http://192.168.31.125:7890（留空表示不修改）" autocomplete="off" />
              </div>
            </div>
            <div class="settings-actions">
              <button id="saveTavilyBtn" class="primary" type="button">保存 Tavily 设置</button>
              <button id="testTavilyBtn" class="secondary" type="button">测试 Tavily</button>
              <button id="clearTavilyBtn" class="secondary" type="button">清除 Key</button>
              <button id="clearTavilyProxyBtn" class="secondary" type="button">清除代理</button>
              <span id="tavilySettingsState" class="muted"></span>
            </div>
	          </section>
	          <section id="promptSettingsPanel" class="management-panel settings-panel" hidden>
	            <div class="segmented prompt-settings-view-tabs" role="tablist" aria-label="提示词设置视图">
	              <button id="systemPromptSettingsViewBtn" class="active" type="button" role="tab" aria-selected="true" aria-controls="systemPromptSettingsView">系统提示词</button>
	              <button id="meetingPresetSettingsViewBtn" type="button" role="tab" aria-selected="false" aria-controls="meetingPresetSettingsView">见面模式预设</button>
	            </div>
	            <div id="systemPromptSettingsView" role="tabpanel">
	              <div class="schedule-head">
	                <h3>系统提示词</h3>
	                <div class="segmented prompt-mode-tabs" aria-label="提示词模式">
	                  <button id="smsPromptModeBtn" class="active" type="button">角色私聊</button>
	                </div>
	              </div>
	              <label class="settings-field prompt-editor-field">
	                <span>自定义行为指令（Markdown）</span>
	                <textarea id="systemPromptCustom" class="system-prompt-editor" maxlength="6000" spellcheck="false"></textarea>
	              </label>
	              <div class="settings-actions">
	                <button id="saveSystemPromptBtn" class="primary" type="button">保存提示词</button>
	                <span id="systemPromptCharacterCount" class="muted">0 / 6000</span>
	                <span id="systemPromptState" class="muted"></span>
	              </div>
	              <details class="system-prompt-details">
	                <summary>内置提示词（只读）</summary>
	                <pre id="systemPromptBuiltIn"></pre>
	              </details>
	              <details class="system-prompt-details">
	                <summary>最终提示词（只读）</summary>
	                <pre id="systemPromptEffective"></pre>
	              </details>
	            </div>
	            <div id="meetingPresetSettingsView" class="meeting-preset-panel" role="tabpanel" hidden>
	              <div class="meeting-preset-heading">
	                <div>
	                  <h3>见面模式预设</h3>
	                  <p>导入 SillyTavern / 酒馆 JSON 预设，仅在角色进入现场见面后按启用顺序编排每轮上下文；远程私聊与约见等待继续使用 SMS 默认编排。预设中的扩展脚本不会执行。</p>
	                </div>
	              </div>
	              <input id="meetingPresetImportInput" type="file" accept=".json,application/json" hidden />
	              <div class="meeting-preset-picker">
	                <select id="meetingPresetSelect" aria-label="见面模式预设"><option value="">尚未导入预设</option></select>
	                <button id="selectMeetingPresetImportBtn" class="secondary" type="button"><i data-lucide="upload" aria-hidden="true"></i><span>导入 JSON</span></button>
	                <button id="deleteMeetingPresetBtn" class="secondary icon-button" type="button" title="删除预设" aria-label="删除见面模式预设" disabled><i data-lucide="trash-2" aria-hidden="true"></i></button>
	              </div>
	              <div id="meetingPresetImportPanel" class="meeting-preset-import" hidden>
	                <div class="meeting-preset-import-summary">
	                  <strong id="meetingPresetImportFileName"></strong>
	                  <span id="meetingPresetImportSummary"></span>
	                </div>
	                <div class="meeting-preset-import-grid">
	                  <label>预设名称<input id="meetingPresetImportName" maxlength="120" /></label>
	                  <label id="meetingPresetImportOrderField">编排组<select id="meetingPresetImportOrder"></select></label>
	                </div>
	                <div class="settings-actions">
	                  <button id="importMeetingPresetBtn" class="primary" type="button">导入预设</button>
	                  <button id="cancelMeetingPresetImportBtn" class="secondary" type="button">取消</button>
	                  <span id="meetingPresetImportState" class="muted" aria-live="polite"></span>
	                </div>
	              </div>
	              <div id="meetingPresetEmpty" class="meeting-preset-empty">导入一个酒馆 JSON 预设后，可在这里逐项启用并编辑。</div>
	              <div id="meetingPresetEditor" class="meeting-preset-editor" hidden>
	                <div class="meeting-preset-editor-head">
	                  <label class="settings-field">
	                    <span>预设名称</span>
	                    <input id="meetingPresetName" maxlength="120" />
	                  </label>
	                  <span id="meetingPresetState" class="muted" aria-live="polite"></span>
	                </div>
	                <div class="meeting-preset-parameter-band">
	                  <label class="toggle"><span>应用预设模型参数</span><input id="meetingPresetParametersEnabled" type="checkbox" /></label>
	                  <label class="meeting-preset-parameters-field">
	                    <span>模型参数（JSON）</span>
	                    <textarea id="meetingPresetParameters" class="meeting-preset-parameters" spellcheck="false"></textarea>
	                  </label>
	                </div>
	                <div id="meetingPresetCompatibility" class="meeting-preset-compatibility" hidden></div>
	                <div class="meeting-preset-prompt-head">
	                  <h4>上下文分项</h4>
	                  <span id="meetingPresetPromptCount" class="muted"></span>
	                </div>
	                <div id="meetingPresetPromptList" class="meeting-preset-prompt-list"></div>
	                <div class="settings-actions">
	                  <button id="saveMeetingPresetBtn" class="primary" type="button">保存预设</button>
	                </div>
	              </div>
	            </div>
	          </section>
          <section id="dataSettingsPanel" class="management-panel settings-panel" hidden>
            <h3>Memory Vault</h3>
            <div class="settings-grid">
              <div class="settings-field full">
                <label for="memoryVaultPath">Obsidian Vault 路径</label>
                <input id="memoryVaultPath" readonly />
              </div>
            </div>
            <div class="settings-actions">
              <button id="syncMemoryVaultBtn" class="primary" type="button" title="外部编辑会在下一次安全读取时自动同步；点击可立即校验"><i data-lucide="refresh-cw" aria-hidden="true"></i><span>同步</span></button>
              <button id="rebuildMemoryVaultBtn" class="secondary" type="button"><i data-lucide="database" aria-hidden="true"></i><span>重建索引</span></button>
              <span id="memoryVaultState" class="muted"></span>
            </div>
            <div id="memoryVaultHealth" class="vault-health-panel" aria-live="polite">
              <div class="vault-health-row"><span>Writer</span><strong id="memoryVaultWriter">unknown</strong></div>
              <div class="vault-health-row"><span>Journal</span><span id="memoryVaultJournal">unknown</span></div>
              <div class="vault-health-row"><span>Recovery</span><span id="memoryVaultRecovery">unknown</span></div>
              <div class="vault-health-row"><span>Projection</span><span id="memoryVaultProjection">unknown</span></div>
              <div class="vault-health-row"><span>Backup</span><span id="memoryVaultBackup">unknown</span></div>
            </div>
            <div class="settings-data-section">
              <div class="okf-section-head"><h3>Open Knowledge Format</h3><span class="okf-version">OKF v0.1</span></div>
              <div class="settings-grid">
                <label class="settings-field">
                  <span>导入目标</span>
                  <select id="okfImportRealm">
                    <option value="auto">自动识别</option>
                    <option value="reality">现实记忆</option>
                    <option value="roleplay">角色记忆</option>
                  </select>
                </label>
                <label id="okfImportCharacterField" class="settings-field" hidden>
                  <span>目标角色</span>
                  <select id="okfImportCharacter" disabled><option value="">选择角色</option></select>
                </label>
                <div class="okf-export-options" aria-label="OKF 导出范围">
                  <label class="checkbox-row"><input id="okfIncludeProfile" type="checkbox" /><span>用户画像</span></label>
                  <label class="checkbox-row"><input id="okfIncludeSouls" type="checkbox" /><span>角色 SOUL</span></label>
                  <label class="checkbox-row"><input id="okfIncludeScenes" type="checkbox" /><span>角色场景</span></label>
                </div>
              </div>
              <input id="okfImportInput" type="file" accept=".zip,application/zip" hidden />
              <div class="settings-actions">
                <button id="exportOkfBtn" class="secondary" type="button"><i data-lucide="archive" aria-hidden="true"></i><span>导出 OKF</span></button>
                <button id="selectOkfImportBtn" class="secondary" type="button"><i data-lucide="upload" aria-hidden="true"></i><span>选择 OKF</span></button>
                <button id="stageOkfImportBtn" class="primary" type="button" disabled><i data-lucide="list-plus" aria-hidden="true"></i><span>加入待审核</span></button>
                <span id="okfImportState" class="muted" aria-live="polite"></span>
              </div>
              <div id="okfImportPreview" class="okf-import-preview" hidden>
                <div id="okfPreviewSummary" class="okf-preview-summary"></div>
                <div id="okfDocumentList" class="okf-document-list"></div>
              </div>
            </div>
            <div class="settings-data-section">
              <h3>Trace 日志</h3>
              <div class="settings-grid">
                <label class="checkbox-row full">
                  <input id="traceArchiveEnabled" type="checkbox" />
                  <span>归档全部 Provider Trace</span>
                </label>
                <div class="settings-field full">
                  <label for="traceArchivePath">JSONL 目录</label>
                  <input id="traceArchivePath" readonly />
                </div>
              </div>
              <div class="settings-actions">
                <span id="traceArchiveState" class="muted" aria-live="polite"></span>
              </div>
              <p class="muted">日志包含完整对话、工具结果和模型请求。凭据字段会脱敏，但用户在正文中输入的敏感信息仍可能被记录。</p>
            </div>
            <div class="settings-data-section">
              <h3>数据管理</h3>
              <div class="settings-actions">
                <button id="exportDataBtn" class="secondary" type="button">导出数据</button>
                <button id="deleteDataBtn" class="secondary" type="button">删除全部数据</button>
                <span id="runtimeState" class="muted"></span>
              </div>
            </div>
          </section>
        </div>
      </section>
    </main>
    <dialog id="archivedSessionsDialog" class="archived-dialog" aria-labelledby="archivedSessionsTitle">
      <div class="archived-dialog-head">
        <h2 id="archivedSessionsTitle">已归档会话</h2>
        <button id="closeArchivedSessionsBtn" class="secondary icon-button" type="button" title="关闭" aria-label="关闭归档会话"><i data-lucide="x" aria-hidden="true"></i></button>
      </div>
      <div id="archivedSessionList" class="archived-list"></div>
    </dialog>
    <dialog id="newConversationDialog" class="session-action-dialog new-conversation-dialog" aria-labelledby="newConversationTitle">
      <div class="archived-dialog-head">
        <h2 id="newConversationTitle">新建对话</h2>
        <button id="closeNewConversationBtn" class="secondary icon-button" type="button" title="关闭" aria-label="关闭新建对话"><i data-lucide="x" aria-hidden="true"></i></button>
      </div>
      <form id="newConversationForm" class="new-conversation-form">
        <fieldset class="new-conversation-kind">
          <legend>对话类型</legend>
          <div class="segmented" aria-label="新对话类型">
            <button id="newConversationDirectBtn" class="active" type="button">角色</button>
            <button id="newConversationGroupBtn" type="button">世界</button>
          </div>
        </fieldset>
        <label id="newConversationCharacterField" class="settings-field"><span>角色</span><select id="newConversationCharacter"><option value="">请选择角色</option></select></label>
        <div id="newConversationGroupFields" class="group-conversation-fields" hidden>
          <label class="settings-field"><span>共享世界</span><select id="newConversationWorld"><option value="">请选择世界</option></select></label>
          <p class="new-conversation-note">世界中的角色会按照当前事件和各自认知参与演绎。</p>
        </div>
        <div id="newConversationError" class="dialog-error" role="alert"></div>
        <div class="dialog-actions"><button id="cancelNewConversationBtn" class="secondary" type="button">取消</button><button id="createConversationBtn" class="primary" type="submit">开始对话</button></div>
      </form>
    </dialog>
    <dialog id="sceneInfoDialog" class="session-action-dialog scene-info-dialog" aria-labelledby="sceneInfoTitle">
      <div class="archived-dialog-head">
        <h2 id="sceneInfoTitle">场景信息</h2>
        <button id="closeSceneInfoBtn" class="secondary icon-button" type="button" title="关闭" aria-label="关闭场景信息"><i data-lucide="x" aria-hidden="true"></i></button>
      </div>
      <div id="sceneInfoContent" class="scene-info-content"></div>
      <form id="sceneForm" class="scene-editor-form" hidden>
        <div class="character-grid">
          <label>地点<input id="sceneLocation" /></label>
          <label>场景时间<input id="sceneTime" /></label>
          <label>当前目标<input id="sceneObjective" /></label>
          <label>参与者（逗号分隔）<input id="sceneParticipants" /></label>
          <label class="full">场景摘要<textarea id="sceneSummary"></textarea></label>
          <label class="full">未完线索（每行一项）<textarea id="sceneThreads"></textarea></label>
        </div>
        <div id="sceneState" class="dialog-error" role="status"></div>
      </form>
      <div class="scene-info-actions">
        <span id="worldEventActions" class="world-event-actions" hidden></span>
        <button id="editSceneInfoBtn" class="secondary" type="button"><i data-lucide="pencil" aria-hidden="true"></i><span>编辑场景</span></button>
        <button id="saveSceneBtn" class="primary" type="submit" form="sceneForm" hidden><i data-lucide="save" aria-hidden="true"></i><span>保存</span></button>
        <button id="dismissSceneInfoBtn" class="secondary" type="button">关闭</button>
      </div>
    </dialog>
    <dialog id="contextBudgetDialog" class="session-action-dialog context-budget-dialog" aria-labelledby="contextBudgetTitle">
      <div class="archived-dialog-head">
        <h2 id="contextBudgetTitle">上下文余量</h2>
        <button id="closeContextBudgetBtn" class="secondary icon-button" type="button" title="关闭" aria-label="关闭上下文余量"><i data-lucide="x" aria-hidden="true"></i></button>
      </div>
      <div class="context-budget-body">
        <div class="context-budget-summary"><strong id="contextBudgetRemaining">--</strong><span id="contextBudgetSource">等待会话数据</span></div>
        <div id="contextBudgetMeter" class="context-budget-meter"><span></span></div>
        <dl id="contextBudgetMetrics" class="context-budget-metrics"></dl>
        <p class="context-budget-note">余量已扣除本轮最大输出和安全保留。系统会在接近上限时主动整理，也可以在消息队列空闲时手动整理。</p>
        <div id="contextBudgetState" class="context-budget-state" role="status"></div>
      </div>
      <div class="scene-info-actions">
        <button id="compactContextBtn" class="primary" type="button"><i data-lucide="archive-restore" aria-hidden="true"></i><span>整理上下文</span></button>
        <button id="dismissContextBudgetBtn" class="secondary" type="button">关闭</button>
      </div>
    </dialog>
    <dialog id="memoryEditorDialog" class="schedule-editor-dialog memory-editor-dialog" aria-labelledby="memoryEditorTitle">
      <div class="schedule-editor-head">
        <h3 id="memoryEditorTitle">添加长期记忆</h3>
        <button id="closeMemoryEditorBtn" class="secondary icon-button" type="button" title="关闭" aria-label="关闭记忆编辑"><i data-lucide="x" aria-hidden="true"></i></button>
      </div>
      <form id="memoryForm" class="memory-editor-form">
        <div class="character-grid">
          <label>类型
            <select id="memoryType">
              <option value="relationship_event">关系事件</option>
              <option value="world_fact">世界事实</option>
              <option value="plot_event">剧情事件</option>
              <option value="boundary">边界</option>
            </select>
          </label>
          <label>连续性键<input id="memoryKey" placeholder="例如 relationship.first_meeting" /></label>
          <label class="full">内容<textarea id="memoryContent" required></textarea></label>
          <label class="full">标签（逗号分隔）<input id="memoryTags" /></label>
        </div>
        <div id="memoryEditorState" class="dialog-error" role="status"></div>
        <div class="dialog-actions">
          <button id="cancelMemoryEditorBtn" class="secondary" type="button">取消</button>
          <button class="primary" type="submit"><i data-lucide="pin" aria-hidden="true"></i><span>固定记忆</span></button>
        </div>
      </form>
    </dialog>
    <dialog id="worldManagerDialog" class="world-manager-dialog" aria-labelledby="worldManagerTitle">
      <div class="archived-dialog-head">
        <h2 id="worldManagerTitle">共享世界</h2>
        <button id="closeWorldManagerBtn" class="secondary icon-button" type="button" title="关闭" aria-label="关闭世界管理"><i data-lucide="x" aria-hidden="true"></i></button>
      </div>
      <div class="world-manager-body">
        <div class="world-manager-picker">
          <select id="worldManagerWorldSelect" aria-label="选择世界"><option value="">新建世界</option></select>
          <button id="newWorldBtn" class="secondary" type="button"><i data-lucide="plus" aria-hidden="true"></i><span>新建</span></button>
        </div>
        <form id="worldForm" class="world-form">
          <div class="world-form-grid">
            <label>名称<input id="worldName" required maxlength="80" /></label>
            <label>时区<input id="worldTimezone" value="Asia/Shanghai" /></label>
            <label>世界演绎模型<select id="worldDirectorModelProfile"><option value="">继承系统默认模型</option></select></label>
            <label>回合状态模型<select id="worldAnalystModelProfile"><option value="">跟随世界演绎模型</option></select></label>
            <label class="full">简介<textarea id="worldDescription" maxlength="1200"></textarea></label>
            <label class="full">世界规则与常识<textarea id="worldRules" maxlength="6000" spellcheck="false"></textarea></label>
          </div>
          <div class="settings-actions">
            <span id="worldManagerState" class="muted"></span>
            <button id="saveWorldBtn" class="primary" type="submit">创建世界</button>
          </div>
        </form>
        <section id="worldCardSummary" class="world-card-summary" hidden></section>
        <section id="worldPlacesSection" class="world-places-section" hidden>
          <div class="schedule-head"><h3>地点与功能</h3><span id="worldPlaceCount" class="muted"></span></div>
          <div id="worldPlaceList" class="world-place-list"></div>
          <form id="worldPlaceForm" class="world-place-form">
            <div class="world-form-grid">
              <label>地点名称<input id="worldPlaceName" required maxlength="80" /></label>
              <label class="full">地点说明<textarea id="worldPlaceDescription" maxlength="800"></textarea></label>
              <fieldset class="full capability-fieldset">
                <legend>可用功能</legend>
                <div id="worldCapabilityOptions" class="world-capability-options">
                  <label><input type="checkbox" value="rest" />休息</label>
                  <label><input type="checkbox" value="work" />工作</label>
                  <label><input type="checkbox" value="study" />学习</label>
                  <label><input type="checkbox" value="socialize" />社交</label>
                  <label><input type="checkbox" value="eat" />用餐</label>
                  <label><input type="checkbox" value="shop" />购物</label>
                  <label><input type="checkbox" value="exercise" />运动</label>
                  <label><input type="checkbox" value="travel" />出行</label>
                  <label><input type="checkbox" value="create" />创作</label>
                  <label><input type="checkbox" value="observe" />观察</label>
                  <label><input type="checkbox" value="communicate" />通信</label>
                </div>
              </fieldset>
            </div>
            <div class="settings-actions">
              <button id="cancelPlaceEditBtn" class="secondary" type="button">清空</button>
              <button id="saveWorldPlaceBtn" class="primary" type="submit">添加地点</button>
            </div>
          </form>
        </section>
      </div>
    </dialog>
    <dialog id="sessionActionDialog" class="session-action-dialog" aria-labelledby="sessionActionTitle" aria-describedby="sessionActionDescription">
      <div class="archived-dialog-head">
        <h2 id="sessionActionTitle">确认操作</h2>
        <button id="closeSessionActionBtn" class="secondary icon-button" type="button" title="关闭" aria-label="关闭操作对话框"><i data-lucide="x" aria-hidden="true"></i></button>
      </div>
      <form id="sessionActionForm" class="session-action-form">
        <p id="sessionActionDescription" class="session-action-copy"></p>
        <label id="sessionActionField" class="session-action-field"><span id="sessionActionFieldLabel">确认内容</span><input id="sessionActionInput" autocomplete="off" /></label>
        <div id="sessionActionError" class="dialog-error" role="alert" aria-live="polite"></div>
        <div class="dialog-actions">
          <button id="cancelSessionActionBtn" class="secondary" type="button">取消</button>
          <button id="confirmSessionActionBtn" class="primary" type="submit">确认</button>
        </div>
      </form>
    </dialog>
    <dialog id="messageEditDialog" class="message-edit-dialog" aria-labelledby="messageEditTitle">
      <div class="archived-dialog-head">
        <h2 id="messageEditTitle">编辑消息</h2>
        <button id="closeMessageEditBtn" class="secondary icon-button" type="button" title="关闭" aria-label="关闭编辑"><i data-lucide="x" aria-hidden="true"></i></button>
      </div>
      <form id="messageEditForm" class="message-edit-form">
        <textarea id="messageEditText" required aria-label="编辑后的消息"></textarea>
        <div id="messageEditError" class="dialog-error" role="alert"></div>
        <div class="dialog-actions"><button id="cancelMessageEditBtn" class="secondary" type="button">取消</button><button id="submitMessageEditBtn" class="primary" type="submit">保存并重新发送</button></div>
      </form>
    </dialog>
    <dialog id="characterProfileDialog" class="character-profile-dialog" aria-labelledby="characterProfileTitle">
      <div class="archived-dialog-head">
        <h2 id="characterProfileTitle">角色资料</h2>
        <button id="closeCharacterProfileBtn" class="secondary icon-button" type="button" title="关闭" aria-label="关闭角色资料"><i data-lucide="x" aria-hidden="true"></i></button>
      </div>
      <div class="character-profile-content">
        <div class="character-profile-identity">
          <span id="characterProfileAvatar" class="character-profile-avatar">角</span>
          <div class="character-profile-name"><h3 id="characterProfileName">角色</h3><span id="characterProfileMeta"></span></div>
        </div>
        <section class="character-profile-soul" aria-labelledby="characterProfileSoulTitle">
          <h3 id="characterProfileSoulTitle">角色设定</h3>
          <div id="characterProfileSoul" class="markdown-body"></div>
        </section>
      </div>
    </dialog>
    <dialog id="characterChannelDialog" class="module-detail-dialog character-channel-dialog" aria-labelledby="characterChannelTitle">
      <div class="archived-dialog-head">
        <h2 id="characterChannelTitle">角色通信</h2>
        <button id="closeCharacterChannelBtn" class="secondary icon-button" type="button" title="关闭" aria-label="关闭角色通信"><i data-lucide="x" aria-hidden="true"></i></button>
      </div>
      <div id="characterChannelParticipants" class="character-channel-participants"></div>
      <div id="characterChannelMessages" class="character-channel-messages"></div>
    </dialog>
    <dialog id="moduleDetailDialog" class="module-detail-dialog" aria-labelledby="moduleDetailTitle">
      <div class="archived-dialog-head">
        <h2 id="moduleDetailTitle">模块详情</h2>
        <button id="closeModuleDetailBtn" class="secondary icon-button" type="button" title="关闭" aria-label="关闭模块详情"><i data-lucide="x" aria-hidden="true"></i></button>
      </div>
      <div id="moduleDetailContent" class="module-detail-content"></div>
    </dialog>
    <dialog id="workspaceFilePreviewDialog" class="module-detail-dialog workspace-file-preview-dialog" aria-labelledby="workspaceFilePreviewTitle">
      <div class="archived-dialog-head">
        <h2 id="workspaceFilePreviewTitle">文件预览</h2>
        <button id="closeWorkspaceFilePreviewBtn" class="secondary icon-button" type="button" title="关闭" aria-label="关闭文件预览"><i data-lucide="x" aria-hidden="true"></i></button>
      </div>
      <div id="workspaceFilePreviewContent" class="workspace-file-preview-content"></div>
    </dialog>
    <dialog id="chatImageDialog" class="chat-image-dialog" aria-labelledby="chatImageTitle">
      <div class="chat-image-head">
        <h2 id="chatImageTitle">图片预览</h2>
        <div class="chat-image-actions">
          <a id="chatImageDownloadBtn" class="secondary icon-button" title="下载图片" aria-label="下载图片"><i data-lucide="download" aria-hidden="true"></i></a>
          <button id="closeChatImageBtn" class="secondary icon-button" type="button" title="关闭" aria-label="关闭图片预览"><i data-lucide="x" aria-hidden="true"></i></button>
        </div>
      </div>
      <div class="chat-image-stage"><img id="chatImagePreview" alt="" /></div>
    </dialog>
    <footer style="padding: 8px 14px; background: var(--panel); border-top: 1px solid var(--line);">
      <div id="status" class="status">就绪</div>
    </footer>
  </div>
  <script src="/assets/marked.umd.js"></script>
  <script src="/assets/purify.min.js"></script>
  <script src="/assets/lucide.min.js"></script>
  <script>
    const state = {
      uiMode: "normal",
      messages: [],
      busy: false,
      sessions: [],
      archivedSessions: [],
      archivedGroupChats: [],
      activeSessionId: "",
      sessionDraft: true,
      calendarCursor: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
      selectedScheduleDate: localDateKey(new Date()),
      taskFilter: "pending",
      scheduleOwnerType: "user",
      scheduleCharacterId: "",
      scheduleMobileView: "agenda",
      scheduleItems: [],
      editingScheduleId: null,
      characters: [],
      selectedCharacterId: "",
      workspaceCharacterId: "",
      characterTab: "settings",
      characterFunction: null,
      characterFunctionOpenCapabilities: [],
      characterSkillVersions: [],
      characterSkillViewingHistory: false,
      characterFunctionPollTimer: null,
      characterFunctionPollAttempts: 0,
      relationship: null,
      worlds: [],
      characterLife: null,
      worldEditorId: "",
      placeEditorId: "",
      worldEditorPlaces: [],
      unreadConversations: [],
      unreadProactiveMessages: [],
      activeProactiveMessages: [],
      newConversationMode: "sms",
      newConversationKind: "direct",
      newConversationPreferredCharacterId: "",
      groupChats: [],
      worldConversations: [],
      characterChannels: [],
      activeCharacterChannelId: "",
      activeCharacterChannelSnapshot: null,
      activeConversationKind: "direct",
      activeGroupId: "",
      groupAbortController: null,
      activeWorldId: "",
      worldAbortController: null,
      currentScene: null,
      contextBudget: null,
      contextCompacting: false,
      characterLiveState: null,
      sceneEditing: false,
      pendingCharacterAvatarDataUrl: "",
      userAvatarUrl: "",
      memories: [],
	      managementTab: "modules",
	      settingsTab: "model",
	      promptSettingsView: "system",
	      promptMode: "sms",
	      systemPrompts: null,
	      meetingPresets: [],
	      selectedMeetingPresetId: "",
	      meetingPreset: null,
	      meetingPresetImportFile: null,
	      meetingPresetImportSource: null,
	      meetingPresetImportOrderOptions: [],
	      discoveredModels: [],
      modelProfiles: [],
      defaultModelProfileId: "",
      selectedModelProfileId: "",
      discoveredVisionModels: [],
      pendingAttachments: [],
      attachmentUploadQueue: [],
      uploadingAttachments: false,
      privateInboxSource: null,
      privateInboxSessionId: "",
      privateInboxMessages: [],
      privateInboxRunning: false,
      privateTypingHeartbeatTimer: null,
      privateTypingHeartbeatLastSentAt: 0,
      okfImportFile: null,
      okfImportPreview: null,
      workspaceFileDirectory: "",
      workspaceFiles: [],
      agentModules: [],
      agentPermissions: null,
      userInsights: null,
      insightReceiptBaselines: new Map(),
      managedMemories: [],
      personProfiles: [],
      memoryJobs: [],
      retrievalPreview: null,
      lastTurnStatus: null,
      lastTurnCanRetry: false,
      debugTracesByScope: {
        conversation: [],
        background: []
      },
      debugTraceScope: "conversation",
      debugEconomics: [],
      debugProactiveMessages: [],
      debugDataset: "traces",
      featureTestCases: [],
      featureTestResults: [],
      featureTestReports: [],
      featureTestTargetModelId: "",
      featureTestJudgeModelId: "",
      featureTestModelOptionsInitialized: false,
      featureTestsRunning: false,
      conversationListOpen: false,
      conversationBatchMode: false,
      selectedSessionIds: new Set(),
      selectedGroupIds: new Set(),
      collapsedConversationGroups: new Set(),
      composingMessage: false,
      compositionEndedAt: 0,
      emojiCategory: "faces",
      selectedTraceIndexes: {
        conversation: 0,
        background: 0
      },
      selectedEconomicsIndex: 0,
      traceView: "semantic",
      traceWrap: true,
      interactionState: null,
      interactionEvents: [],
      interactionCanUndo: false,
      interactionLocations: []
    };
    const worldCapabilityLabels = {
      rest: "休息", work: "工作", study: "学习", socialize: "社交", eat: "用餐",
      shop: "购物", exercise: "运动", travel: "出行", create: "创作",
      observe: "观察", communicate: "通信"
    };
    const emojiGroups = {
      faces: {
        label: "笑脸与情绪",
        icon: "😊",
        values: ["😀", "😃", "😄", "😁", "😆", "😊", "🙂", "😉", "🥰", "😍", "🤩", "😘", "😋", "😎", "🤗", "🤔", "🫡", "🤭", "🫢", "😶", "😐", "🙄", "😮", "😴", "🥺", "😢", "😭", "😤", "😠", "😳", "🤯", "🥳", "😇", "🤓", "😏", "😌", "😅", "😂", "🤣", "🙃"]
      },
      gestures: {
        label: "手势与人物",
        icon: "👋",
        values: ["👋", "👍", "👎", "👌", "✌️", "🤞", "🤟", "🤘", "👏", "🙌", "🫶", "🙏", "💪", "🤝", "🫰", "👉", "👈", "☝️", "✋", "🖐️", "🤚", "🫂", "🙋", "🙆", "🙅", "🤷", "🤦", "💁", "🧑‍💻", "🧑‍🎨", "🧑‍🍳", "🧑‍🔬"]
      },
      hearts: {
        label: "爱心与关系",
        icon: "❤️",
        values: ["❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "🤎", "🩷", "🩵", "🩶", "💔", "❤️‍🔥", "❤️‍🩹", "💕", "💞", "💓", "💗", "💖", "💘", "💝", "💟", "💌", "💋", "🌹", "🌷", "🌸"]
      },
      activities: {
        label: "活动与物品",
        icon: "🎉",
        values: ["🎉", "✨", "🌟", "🔥", "💯", "🎁", "🎂", "🎈", "🎵", "🎧", "📷", "💡", "📌", "⏰", "💤", "☕", "🍵", "🍻", "🍰", "🍜", "🍓", "🍀", "🌙", "☀️", "🌧️", "❄️", "🌈", "🚗", "✈️", "🏠", "💻", "📚"]
      },
      symbols: {
        label: "符号",
        icon: "✅",
        values: ["✅", "❌", "⚠️", "❗", "❓", "‼️", "⁉️", "⭕", "💬", "💭", "💢", "💥", "💫", "💦", "💨", "🎶", "🔔", "🔕", "📣", "🔒", "🔑", "🔗", "📍", "➡️", "⬅️", "⬆️", "⬇️", "🔄", "▶️", "⏸️"]
      }
    };
    const nodes = {
      normalBtn: document.getElementById("normalBtn"),
      scheduleBtn: document.getElementById("scheduleBtn"),
      charactersBtn: document.getElementById("charactersBtn"),
      managementBtn: document.getElementById("managementBtn"),
      settingsBtn: document.getElementById("settingsBtn"),
      debugBtn: document.getElementById("debugBtn"),
      brandUserAvatar: document.getElementById("brandUserAvatar"),
      chatPane: document.getElementById("chatPane"),
      mainPane: document.getElementById("mainPane"),
      schedulePage: document.getElementById("schedulePage"),
      charactersPage: document.getElementById("charactersPage"),
      managementPage: document.getElementById("managementPage"),
      settingsPage: document.getElementById("settingsPage"),
      modulesTabBtn: document.getElementById("modulesTabBtn"),
      profileTabBtn: document.getElementById("profileTabBtn"),
      memoryManagementTabBtn: document.getElementById("memoryManagementTabBtn"),
      workspaceFilesTabBtn: document.getElementById("workspaceFilesTabBtn"),
      modulesPanel: document.getElementById("modulesPanel"),
      profilePanel: document.getElementById("profilePanel"),
      memoryManagementPanel: document.getElementById("memoryManagementPanel"),
      workspaceFilesPanel: document.getElementById("workspaceFilesPanel"),
      workspaceFilePath: document.getElementById("workspaceFilePath"),
      workspaceFileState: document.getElementById("workspaceFileState"),
      workspaceFileList: document.getElementById("workspaceFileList"),
      workspaceFileUpBtn: document.getElementById("workspaceFileUpBtn"),
      workspaceFileRefreshBtn: document.getElementById("workspaceFileRefreshBtn"),
      workspaceFileUploadBtn: document.getElementById("workspaceFileUploadBtn"),
      workspaceFileUploadInput: document.getElementById("workspaceFileUploadInput"),
      refreshModulesBtn: document.getElementById("refreshModulesBtn"),
      moduleList: document.getElementById("moduleList"),
      workspacePath: document.getElementById("workspacePath"),
      permissionControls: document.getElementById("permissionControls"),
      workspaceAccessControls: document.getElementById("workspaceAccessControls"),
      shellPermissionInput: document.getElementById("shellPermissionInput"),
      shellPermissionLabel: document.getElementById("shellPermissionLabel"),
      networkPermissionInput: document.getElementById("networkPermissionInput"),
      networkPermissionLabel: document.getElementById("networkPermissionLabel"),
      profileWritePermissionInput: document.getElementById("profileWritePermissionInput"),
      profileWritePermissionLabel: document.getElementById("profileWritePermissionLabel"),
      soulWritePermissionInput: document.getElementById("soulWritePermissionInput"),
      soulWritePermissionLabel: document.getElementById("soulWritePermissionLabel"),
      realityMemoryWritePermissionInput: document.getElementById("realityMemoryWritePermissionInput"),
      realityMemoryWritePermissionLabel: document.getElementById("realityMemoryWritePermissionLabel"),
      characterMemoryWritePermissionInput: document.getElementById("characterMemoryWritePermissionInput"),
      characterMemoryWritePermissionLabel: document.getElementById("characterMemoryWritePermissionLabel"),
      permissionRuntime: document.getElementById("permissionRuntime"),
      profileDocumentForm: document.getElementById("profileDocumentForm"),
      profileMarkdown: document.getElementById("profileMarkdown"),
      profileCharacterCount: document.getElementById("profileCharacterCount"),
      saveProfileBtn: document.getElementById("saveProfileBtn"),
      profileState: document.getElementById("profileState"),
      userInsightSummary: document.getElementById("userInsightSummary"),
      userInsightList: document.getElementById("userInsightList"),
      refreshUserInsightsBtn: document.getElementById("refreshUserInsightsBtn"),
      userAvatarPreview: document.getElementById("userAvatarPreview"),
      userAvatarInput: document.getElementById("userAvatarInput"),
      changeUserAvatarBtn: document.getElementById("changeUserAvatarBtn"),
      removeUserAvatarBtn: document.getElementById("removeUserAvatarBtn"),
      memoryCoordinatorState: document.getElementById("memoryCoordinatorState"),
      refreshManagedMemoriesBtn: document.getElementById("refreshManagedMemoriesBtn"),
      managedMemoryRealm: document.getElementById("managedMemoryRealm"),
      managedMemoryCharacter: document.getElementById("managedMemoryCharacter"),
      managedMemoryTypeFilter: document.getElementById("managedMemoryTypeFilter"),
      managedMemoryValidity: document.getElementById("managedMemoryValidity"),
      managedMemoryQuery: document.getElementById("managedMemoryQuery"),
      searchManagedMemoriesBtn: document.getElementById("searchManagedMemoriesBtn"),
      managedMemoryForm: document.getElementById("managedMemoryForm"),
      managedMemoryCreateRealm: document.getElementById("managedMemoryCreateRealm"),
      managedMemoryCreateType: document.getElementById("managedMemoryCreateType"),
      managedMemoryCreateCharacter: document.getElementById("managedMemoryCreateCharacter"),
      managedMemoryCreateKey: document.getElementById("managedMemoryCreateKey"),
      managedMemoryCreateContent: document.getElementById("managedMemoryCreateContent"),
      managedMemoryActionState: document.getElementById("managedMemoryActionState"),
      personProfileCount: document.getElementById("personProfileCount"),
      personProfileList: document.getElementById("personProfileList"),
      retrievalPreviewForm: document.getElementById("retrievalPreviewForm"),
      retrievalPreviewMode: document.getElementById("retrievalPreviewMode"),
      retrievalPreviewQuery: document.getElementById("retrievalPreviewQuery"),
      retrievalPreviewBudget: document.getElementById("retrievalPreviewBudget"),
      retrievalPreviewState: document.getElementById("retrievalPreviewState"),
      retrievalPreviewResults: document.getElementById("retrievalPreviewResults"),
      managedMemoryList: document.getElementById("managedMemoryList"),
      memoryJobCount: document.getElementById("memoryJobCount"),
      memoryJobList: document.getElementById("memoryJobList"),
      debugPane: document.getElementById("debugPane"),
      debugWorkspace: document.getElementById("debugWorkspace"),
      traceScopeTabs: document.getElementById("traceScopeTabs"),
      conversationTraceScopeBtn: document.getElementById("conversationTraceScopeBtn"),
      backgroundTraceScopeBtn: document.getElementById("backgroundTraceScopeBtn"),
      conversationTraceCount: document.getElementById("conversationTraceCount"),
      backgroundTraceCount: document.getElementById("backgroundTraceCount"),
      featureTestPanel: document.getElementById("featureTestPanel"),
      initiativeDebugPanel: document.getElementById("initiativeDebugPanel"),
      initiativeCharacterFilter: document.getElementById("initiativeCharacterFilter"),
      initiativeDecisionFilter: document.getElementById("initiativeDecisionFilter"),
      initiativeDebugState: document.getElementById("initiativeDebugState"),
      initiativeSummary: document.getElementById("initiativeSummary"),
      initiativeDebugList: document.getElementById("initiativeDebugList"),
      debugFeatureTestsBtn: document.getElementById("debugFeatureTestsBtn"),
      debugInitiativeBtn: document.getElementById("debugInitiativeBtn"),
      featureTestCharacter: document.getElementById("featureTestCharacter"),
      featureTestTargetModel: document.getElementById("featureTestTargetModel"),
      featureTestJudgeModel: document.getElementById("featureTestJudgeModel"),
      selectAllFeatureTestsBtn: document.getElementById("selectAllFeatureTestsBtn"),
      runFeatureTestsBtn: document.getElementById("runFeatureTestsBtn"),
      exportFeatureTestReportBtn: document.getElementById("exportFeatureTestReportBtn"),
      featureTestState: document.getElementById("featureTestState"),
      featureTestReport: document.getElementById("featureTestReport"),
      featureTestHistory: document.getElementById("featureTestHistory"),
      featureTestList: document.getElementById("featureTestList"),
      featureTestResults: document.getElementById("featureTestResults"),
      traceIndex: document.getElementById("traceIndex"),
      mobileTraceSelect: document.getElementById("mobileTraceSelect"),
      traceEmpty: document.getElementById("traceEmpty"),
      traceDetail: document.getElementById("traceDetail"),
      traceDetailTitle: document.getElementById("traceDetailTitle"),
      traceDetailMeta: document.getElementById("traceDetailMeta"),
      traceContent: document.getElementById("traceContent"),
      traceSemanticBtn: document.getElementById("traceSemanticBtn"),
      traceRawBtn: document.getElementById("traceRawBtn"),
      traceExpandBtn: document.getElementById("traceExpandBtn"),
      traceWrapBtn: document.getElementById("traceWrapBtn"),
      traceCopyBtn: document.getElementById("traceCopyBtn"),
      debugTracesBtn: document.getElementById("debugTracesBtn"),
      debugEconomicsBtn: document.getElementById("debugEconomicsBtn"),
      refreshLogsBtn: document.getElementById("refreshLogsBtn"),
      messages: document.getElementById("messages"),
      composer: document.getElementById("composer"),
      textInput: document.getElementById("textInput"),
      emojiPicker: document.getElementById("emojiPicker"),
      emojiPickerBtn: document.getElementById("emojiPickerBtn"),
      emojiPickerCategories: document.getElementById("emojiPickerCategories"),
      emojiPickerGrid: document.getElementById("emojiPickerGrid"),
      attachmentQueue: document.getElementById("attachmentQueue"),
      chatAttachmentInput: document.getElementById("chatAttachmentInput"),
      attachFileBtn: document.getElementById("attachFileBtn"),
      sendBtn: document.getElementById("sendBtn"),
      cancelMessageBtn: document.getElementById("cancelMessageBtn"),
      retryMessageBtn: document.getElementById("retryMessageBtn"),
      status: document.getElementById("status"),
      conversationCharacter: document.getElementById("conversationCharacter"),
      conversationMode: document.getElementById("conversationMode"),
      conversationScene: document.getElementById("conversationScene"),
      conversationHeaderAvatar: document.getElementById("conversationHeaderAvatar"),
      contextBudgetBtn: document.getElementById("contextBudgetBtn"),
      contextBudgetTokens: document.getElementById("contextBudgetTokens"),
      contextBudgetPercent: document.getElementById("contextBudgetPercent"),
      sceneInfoBtn: document.getElementById("sceneInfoBtn"),
      interactionToggleBtn: document.getElementById("interactionToggleBtn"),
      interactionUndoBtn: document.getElementById("interactionUndoBtn"),
      conversationListToggle: document.getElementById("conversationListToggle"),
      chatWorkspace: document.getElementById("chatWorkspace"),
      conversationList: document.getElementById("conversationList"),
      conversationListTitle: document.getElementById("conversationListTitle"),
      sidebarNewSessionBtn: document.getElementById("sidebarNewSessionBtn"),
      sidebarArchivedSessionsBtn: document.getElementById("sidebarArchivedSessionsBtn"),
      sidebarBatchManageBtn: document.getElementById("sidebarBatchManageBtn"),
      conversationBatchBar: document.getElementById("conversationBatchBar"),
      conversationBatchCount: document.getElementById("conversationBatchCount"),
      conversationBatchSelectAllBtn: document.getElementById("conversationBatchSelectAllBtn"),
      conversationBatchArchiveBtn: document.getElementById("conversationBatchArchiveBtn"),
      conversationBatchDeleteBtn: document.getElementById("conversationBatchDeleteBtn"),
      sessionSelect: document.getElementById("sessionSelect"),
      newSessionBtn: document.getElementById("newSessionBtn"),
      renameSessionBtn: document.getElementById("renameSessionBtn"),
      archiveSessionBtn: document.getElementById("archiveSessionBtn"),
      deleteSessionBtn: document.getElementById("deleteSessionBtn"),
      archivedSessionsBtn: document.getElementById("archivedSessionsBtn"),
      sessionActionsMenuBtn: document.getElementById("sessionActionsMenuBtn"),
      sessionActionsMenu: document.getElementById("sessionActionsMenu"),
      mobileRenameSessionBtn: document.getElementById("mobileRenameSessionBtn"),
      mobileArchiveSessionBtn: document.getElementById("mobileArchiveSessionBtn"),
      mobileDeleteSessionBtn: document.getElementById("mobileDeleteSessionBtn"),
      resetWorldConversationBtn: document.getElementById("resetWorldConversationBtn"),
      mobileArchivedSessionsBtn: document.getElementById("mobileArchivedSessionsBtn"),
      archivedSessionsDialog: document.getElementById("archivedSessionsDialog"),
      archivedSessionList: document.getElementById("archivedSessionList"),
      closeArchivedSessionsBtn: document.getElementById("closeArchivedSessionsBtn"),
      newConversationDialog: document.getElementById("newConversationDialog"),
      newConversationForm: document.getElementById("newConversationForm"),
      newConversationDirectBtn: document.getElementById("newConversationDirectBtn"),
      newConversationGroupBtn: document.getElementById("newConversationGroupBtn"),
      newConversationCharacterField: document.getElementById("newConversationCharacterField"),
      newConversationCharacter: document.getElementById("newConversationCharacter"),
      newConversationGroupFields: document.getElementById("newConversationGroupFields"),
      newConversationWorld: document.getElementById("newConversationWorld"),
      newConversationError: document.getElementById("newConversationError"),
      closeNewConversationBtn: document.getElementById("closeNewConversationBtn"),
      cancelNewConversationBtn: document.getElementById("cancelNewConversationBtn"),
      createConversationBtn: document.getElementById("createConversationBtn"),
      sceneInfoDialog: document.getElementById("sceneInfoDialog"),
      sceneInfoTitle: document.getElementById("sceneInfoTitle"),
      sceneInfoContent: document.getElementById("sceneInfoContent"),
      worldEventActions: document.getElementById("worldEventActions"),
      closeSceneInfoBtn: document.getElementById("closeSceneInfoBtn"),
      dismissSceneInfoBtn: document.getElementById("dismissSceneInfoBtn"),
      editSceneInfoBtn: document.getElementById("editSceneInfoBtn"),
      contextBudgetDialog: document.getElementById("contextBudgetDialog"),
      closeContextBudgetBtn: document.getElementById("closeContextBudgetBtn"),
      dismissContextBudgetBtn: document.getElementById("dismissContextBudgetBtn"),
      compactContextBtn: document.getElementById("compactContextBtn"),
      contextBudgetRemaining: document.getElementById("contextBudgetRemaining"),
      contextBudgetSource: document.getElementById("contextBudgetSource"),
      contextBudgetMeter: document.getElementById("contextBudgetMeter"),
      contextBudgetMetrics: document.getElementById("contextBudgetMetrics"),
      contextBudgetState: document.getElementById("contextBudgetState"),
      sessionActionDialog: document.getElementById("sessionActionDialog"),
      sessionActionForm: document.getElementById("sessionActionForm"),
      sessionActionTitle: document.getElementById("sessionActionTitle"),
      sessionActionDescription: document.getElementById("sessionActionDescription"),
      sessionActionField: document.getElementById("sessionActionField"),
      sessionActionFieldLabel: document.getElementById("sessionActionFieldLabel"),
      sessionActionInput: document.getElementById("sessionActionInput"),
      sessionActionError: document.getElementById("sessionActionError"),
      closeSessionActionBtn: document.getElementById("closeSessionActionBtn"),
      cancelSessionActionBtn: document.getElementById("cancelSessionActionBtn"),
      confirmSessionActionBtn: document.getElementById("confirmSessionActionBtn"),
      messageEditDialog: document.getElementById("messageEditDialog"),
      messageEditForm: document.getElementById("messageEditForm"),
      messageEditText: document.getElementById("messageEditText"),
      messageEditError: document.getElementById("messageEditError"),
      closeMessageEditBtn: document.getElementById("closeMessageEditBtn"),
      cancelMessageEditBtn: document.getElementById("cancelMessageEditBtn"),
      submitMessageEditBtn: document.getElementById("submitMessageEditBtn"),
      characterProfileDialog: document.getElementById("characterProfileDialog"),
      characterProfileAvatar: document.getElementById("characterProfileAvatar"),
      characterProfileName: document.getElementById("characterProfileName"),
      characterProfileMeta: document.getElementById("characterProfileMeta"),
      characterProfileSoul: document.getElementById("characterProfileSoul"),
      closeCharacterProfileBtn: document.getElementById("closeCharacterProfileBtn"),
      characterChannelDialog: document.getElementById("characterChannelDialog"),
      characterChannelTitle: document.getElementById("characterChannelTitle"),
      characterChannelParticipants: document.getElementById("characterChannelParticipants"),
      characterChannelMessages: document.getElementById("characterChannelMessages"),
      closeCharacterChannelBtn: document.getElementById("closeCharacterChannelBtn"),
      moduleDetailDialog: document.getElementById("moduleDetailDialog"),
      moduleDetailTitle: document.getElementById("moduleDetailTitle"),
      moduleDetailContent: document.getElementById("moduleDetailContent"),
      closeModuleDetailBtn: document.getElementById("closeModuleDetailBtn"),
      workspaceFilePreviewDialog: document.getElementById("workspaceFilePreviewDialog"),
      workspaceFilePreviewTitle: document.getElementById("workspaceFilePreviewTitle"),
      workspaceFilePreviewContent: document.getElementById("workspaceFilePreviewContent"),
      closeWorkspaceFilePreviewBtn: document.getElementById("closeWorkspaceFilePreviewBtn"),
      chatImageDialog: document.getElementById("chatImageDialog"),
      chatImageTitle: document.getElementById("chatImageTitle"),
      chatImagePreview: document.getElementById("chatImagePreview"),
      chatImageDownloadBtn: document.getElementById("chatImageDownloadBtn"),
      closeChatImageBtn: document.getElementById("closeChatImageBtn"),
      modeSelect: document.getElementById("modeSelect"),
      chatCharacterControl: document.getElementById("chatCharacterControl"),
      chatCharacterSelect: document.getElementById("chatCharacterSelect"),
      scheduleTodayBtn: document.getElementById("scheduleTodayBtn"),
      userScheduleTabBtn: document.getElementById("userScheduleTabBtn"),
      characterScheduleTabBtn: document.getElementById("characterScheduleTabBtn"),
      scheduleCharacterField: document.getElementById("scheduleCharacterField"),
      scheduleCharacterSelect: document.getElementById("scheduleCharacterSelect"),
      scheduleScopeSummary: document.getElementById("scheduleScopeSummary"),
      scheduleAgendaViewBtn: document.getElementById("scheduleAgendaViewBtn"),
      scheduleCalendarViewBtn: document.getElementById("scheduleCalendarViewBtn"),
      scheduleTasksViewBtn: document.getElementById("scheduleTasksViewBtn"),
      schedulePreviousMonthBtn: document.getElementById("schedulePreviousMonthBtn"),
      scheduleNextMonthBtn: document.getElementById("scheduleNextMonthBtn"),
      scheduleMonthLabel: document.getElementById("scheduleMonthLabel"),
      scheduleCreateBtn: document.getElementById("scheduleCreateBtn"),
      scheduleCalendar: document.getElementById("scheduleCalendar"),
      taskPendingBtn: document.getElementById("taskPendingBtn"),
      taskAllBtn: document.getElementById("taskAllBtn"),
      taskCompletedBtn: document.getElementById("taskCompletedBtn"),
      taskCount: document.getElementById("taskCount"),
      taskList: document.getElementById("taskList"),
      scheduleAgendaTitle: document.getElementById("scheduleAgendaTitle"),
      scheduleEditorDialog: document.getElementById("scheduleEditorDialog"),
      scheduleEditorTitle: document.getElementById("scheduleEditorTitle"),
      closeScheduleEditorBtn: document.getElementById("closeScheduleEditorBtn"),
      scheduleForm: document.getElementById("scheduleForm"),
      scheduleTitle: document.getElementById("scheduleTitle"),
      scheduleKind: document.getElementById("scheduleKind"),
      scheduleStart: document.getElementById("scheduleStart"),
      scheduleEnd: document.getElementById("scheduleEnd"),
      scheduleRecurrence: document.getElementById("scheduleRecurrence"),
      scheduleNotes: document.getElementById("scheduleNotes"),
      scheduleAllDay: document.getElementById("scheduleAllDay"),
      scheduleEndField: document.getElementById("scheduleEndField"),
      scheduleEditorScope: document.getElementById("scheduleEditorScope"),
      saveScheduleBtn: document.getElementById("saveScheduleBtn"),
      resetScheduleBtn: document.getElementById("resetScheduleBtn"),
      scheduleState: document.getElementById("scheduleState"),
      scheduleEditorState: document.getElementById("scheduleEditorState"),
      scheduleList: document.getElementById("scheduleList"),
      newCharacterBtn: document.getElementById("newCharacterBtn"),
      characterCardGrid: document.getElementById("characterCardGrid"),
      characterListEmpty: document.getElementById("characterListEmpty"),
      newWorldCardBtn: document.getElementById("newWorldCardBtn"),
      worldCardGrid: document.getElementById("worldCardGrid"),
      worldListEmpty: document.getElementById("worldListEmpty"),
      characterDetail: document.getElementById("characterDetail"),
      characterDetailTitle: document.getElementById("characterDetailTitle"),
      characterSettingsTabBtn: document.getElementById("characterSettingsTabBtn"),
      characterFunctionTabBtn: document.getElementById("characterFunctionTabBtn"),
      characterMemoryTabBtn: document.getElementById("characterMemoryTabBtn"),
      characterRelationshipTabBtn: document.getElementById("characterRelationshipTabBtn"),
      characterLifeTabBtn: document.getElementById("characterLifeTabBtn"),
      characterSettingsPanel: document.getElementById("characterSettingsPanel"),
      characterFunctionPanel: document.getElementById("characterFunctionPanel"),
      characterMemoryPanel: document.getElementById("characterMemoryPanel"),
      characterRelationshipPanel: document.getElementById("characterRelationshipPanel"),
      characterLifePanel: document.getElementById("characterLifePanel"),
      characterFunctionForm: document.getElementById("characterFunctionForm"),
      characterFunctionState: document.getElementById("characterFunctionState"),
      characterFunctionAutomatic: document.getElementById("characterFunctionAutomatic"),
      refreshCharacterFunctionBtn: document.getElementById("refreshCharacterFunctionBtn"),
      characterFunctionRole: document.getElementById("characterFunctionRole"),
      characterFunctionStatusBadge: document.getElementById("characterFunctionStatusBadge"),
      characterFunctionCapabilities: document.getElementById("characterFunctionCapabilities"),
      characterFunctionLearning: document.getElementById("characterFunctionLearning"),
      characterSkillMeta: document.getElementById("characterSkillMeta"),
      characterSkillVersionSelect: document.getElementById("characterSkillVersionSelect"),
      activateCharacterSkillVersionBtn: document.getElementById("activateCharacterSkillVersionBtn"),
      characterSkillMarkdown: document.getElementById("characterSkillMarkdown"),
      characterFunctionAdvanced: document.getElementById("characterFunctionAdvanced"),
      characterPublicRole: document.getElementById("characterPublicRole"),
      characterMaxConcurrentTasks: document.getElementById("characterMaxConcurrentTasks"),
      characterTaskPreferences: document.getElementById("characterTaskPreferences"),
      characterAvoidedTasks: document.getElementById("characterAvoidedTasks"),
      characterCapabilityCount: document.getElementById("characterCapabilityCount"),
      characterCapabilityList: document.getElementById("characterCapabilityList"),
      saveCharacterFunctionBtn: document.getElementById("saveCharacterFunctionBtn"),
      characterLifeState: document.getElementById("characterLifeState"),
      characterWorldSelect: document.getElementById("characterWorldSelect"),
      saveCharacterWorldBtn: document.getElementById("saveCharacterWorldBtn"),
      characterLifeEmpty: document.getElementById("characterLifeEmpty"),
      characterLifeContent: document.getElementById("characterLifeContent"),
      lifeCurrentPlace: document.getElementById("lifeCurrentPlace"),
      lifeCurrentActivity: document.getElementById("lifeCurrentActivity"),
      lifeAvailability: document.getElementById("lifeAvailability"),
      lifeEnergy: document.getElementById("lifeEnergy"),
      lifeHomePlace: document.getElementById("lifeHomePlace"),
      lifeRuntimePlace: document.getElementById("lifeRuntimePlace"),
      lifeDailyMessageLimit: document.getElementById("lifeDailyMessageLimit"),
      lifeProactiveCooldown: document.getElementById("lifeProactiveCooldown"),
      lifeSocialDailyLimit: document.getElementById("lifeSocialDailyLimit"),
      lifeSocialCooldown: document.getElementById("lifeSocialCooldown"),
      lifeQuietStart: document.getElementById("lifeQuietStart"),
      lifeQuietEnd: document.getElementById("lifeQuietEnd"),
      lifeAutonomyEnabled: document.getElementById("lifeAutonomyEnabled"),
      lifeProactiveEnabled: document.getElementById("lifeProactiveEnabled"),
      lifeSocialEnabled: document.getElementById("lifeSocialEnabled"),
      saveCharacterLifeBtn: document.getElementById("saveCharacterLifeBtn"),
      planCharacterLifeBtn: document.getElementById("planCharacterLifeBtn"),
      simulateCharacterMomentBtn: document.getElementById("simulateCharacterMomentBtn"),
      lifeProactivePause: document.getElementById("lifeProactivePause"),
      lifeProactivePauseText: document.getElementById("lifeProactivePauseText"),
      resumeProactiveBtn: document.getElementById("resumeProactiveBtn"),
      lifePlaceList: document.getElementById("lifePlaceList"),
      lifeEventList: document.getElementById("lifeEventList"),
      lifeProactiveList: document.getElementById("lifeProactiveList"),
      lifeTopicPolicyList: document.getElementById("lifeTopicPolicyList"),
      worldManagerDialog: document.getElementById("worldManagerDialog"),
      closeWorldManagerBtn: document.getElementById("closeWorldManagerBtn"),
      worldManagerWorldSelect: document.getElementById("worldManagerWorldSelect"),
      newWorldBtn: document.getElementById("newWorldBtn"),
      worldForm: document.getElementById("worldForm"),
      worldName: document.getElementById("worldName"),
      worldTimezone: document.getElementById("worldTimezone"),
      worldDirectorModelProfile: document.getElementById("worldDirectorModelProfile"),
      worldAnalystModelProfile: document.getElementById("worldAnalystModelProfile"),
      worldDescription: document.getElementById("worldDescription"),
      worldRules: document.getElementById("worldRules"),
      worldManagerState: document.getElementById("worldManagerState"),
      saveWorldBtn: document.getElementById("saveWorldBtn"),
      worldCardSummary: document.getElementById("worldCardSummary"),
      worldPlacesSection: document.getElementById("worldPlacesSection"),
      worldPlaceCount: document.getElementById("worldPlaceCount"),
      worldPlaceList: document.getElementById("worldPlaceList"),
      worldPlaceForm: document.getElementById("worldPlaceForm"),
      worldPlaceName: document.getElementById("worldPlaceName"),
      worldPlaceDescription: document.getElementById("worldPlaceDescription"),
      worldCapabilityOptions: document.getElementById("worldCapabilityOptions"),
      cancelPlaceEditBtn: document.getElementById("cancelPlaceEditBtn"),
      saveWorldPlaceBtn: document.getElementById("saveWorldPlaceBtn"),
      relationshipState: document.getElementById("relationshipState"),
      relationshipOverview: document.getElementById("relationshipOverview"),
      relationshipEventList: document.getElementById("relationshipEventList"),
      resetRelationshipBtn: document.getElementById("resetRelationshipBtn"),
	      characterForm: document.getElementById("characterForm"),
	      characterName: document.getElementById("characterName"),
	      characterModelProfile: document.getElementById("characterModelProfile"),
	      characterMeetingPreset: document.getElementById("characterMeetingPreset"),
	      characterAvatarPreview: document.getElementById("characterAvatarPreview"),
      characterAvatarInput: document.getElementById("characterAvatarInput"),
      changeCharacterAvatarBtn: document.getElementById("changeCharacterAvatarBtn"),
      removeCharacterAvatarBtn: document.getElementById("removeCharacterAvatarBtn"),
      characterSoulMarkdown: document.getElementById("characterSoulMarkdown"),
      characterSoulCount: document.getElementById("characterSoulCount"),
      saveCharacterBtn: document.getElementById("saveCharacterBtn"),
      characterState: document.getElementById("characterState"),
      sceneForm: document.getElementById("sceneForm"),
      sceneLocation: document.getElementById("sceneLocation"),
      sceneTime: document.getElementById("sceneTime"),
      sceneObjective: document.getElementById("sceneObjective"),
      sceneParticipants: document.getElementById("sceneParticipants"),
      sceneSummary: document.getElementById("sceneSummary"),
      sceneThreads: document.getElementById("sceneThreads"),
      saveSceneBtn: document.getElementById("saveSceneBtn"),
      sceneState: document.getElementById("sceneState"),
      memorySearch: document.getElementById("memorySearch"),
      searchMemoryBtn: document.getElementById("searchMemoryBtn"),
      addMemoryBtn: document.getElementById("addMemoryBtn"),
      memoryEditorDialog: document.getElementById("memoryEditorDialog"),
      closeMemoryEditorBtn: document.getElementById("closeMemoryEditorBtn"),
      cancelMemoryEditorBtn: document.getElementById("cancelMemoryEditorBtn"),
      memoryForm: document.getElementById("memoryForm"),
      memoryType: document.getElementById("memoryType"),
      memoryKey: document.getElementById("memoryKey"),
      memoryContent: document.getElementById("memoryContent"),
      memoryTags: document.getElementById("memoryTags"),
      memoryEditorState: document.getElementById("memoryEditorState"),
      memoryState: document.getElementById("memoryState"),
      memoryList: document.getElementById("memoryList"),
      apiEnabled: document.getElementById("apiEnabled"),
      apiProfileSelect: document.getElementById("apiProfileSelect"),
      apiProfileName: document.getElementById("apiProfileName"),
      newApiProfileBtn: document.getElementById("newApiProfileBtn"),
      defaultApiProfileBtn: document.getElementById("defaultApiProfileBtn"),
      deleteApiProfileBtn: document.getElementById("deleteApiProfileBtn"),
      apiVisionInputEnabled: document.getElementById("apiVisionInputEnabled"),
      apiBaseUrl: document.getElementById("apiBaseUrl"),
      apiModel: document.getElementById("apiModel"),
      apiModelCustom: document.getElementById("apiModelCustom"),
      apiKey: document.getElementById("apiKey"),
      apiTemperature: document.getElementById("apiTemperature"),
      apiMaxTokens: document.getElementById("apiMaxTokens"),
      apiContextWindowTokens: document.getElementById("apiContextWindowTokens"),
      saveApiSettingsBtn: document.getElementById("saveApiSettingsBtn"),
      testModelBtn: document.getElementById("testModelBtn"),
      discoverModelsBtn: document.getElementById("discoverModelsBtn"),
      clearApiKeyBtn: document.getElementById("clearApiKeyBtn"),
      apiSettingsState: document.getElementById("apiSettingsState"),
      modelSettingsTabBtn: document.getElementById("modelSettingsTabBtn"),
      visionSettingsTabBtn: document.getElementById("visionSettingsTabBtn"),
      searchSettingsTabBtn: document.getElementById("searchSettingsTabBtn"),
	      promptSettingsTabBtn: document.getElementById("promptSettingsTabBtn"),
	      dataSettingsTabBtn: document.getElementById("dataSettingsTabBtn"),
      modelSettingsPanel: document.getElementById("modelSettingsPanel"),
      visionSettingsPanel: document.getElementById("visionSettingsPanel"),
      searchSettingsPanel: document.getElementById("searchSettingsPanel"),
	      promptSettingsPanel: document.getElementById("promptSettingsPanel"),
	      dataSettingsPanel: document.getElementById("dataSettingsPanel"),
	      systemPromptSettingsViewBtn: document.getElementById("systemPromptSettingsViewBtn"),
	      meetingPresetSettingsViewBtn: document.getElementById("meetingPresetSettingsViewBtn"),
	      systemPromptSettingsView: document.getElementById("systemPromptSettingsView"),
	      meetingPresetSettingsView: document.getElementById("meetingPresetSettingsView"),
	      smsPromptModeBtn: document.getElementById("smsPromptModeBtn"),
      systemPromptCustom: document.getElementById("systemPromptCustom"),
      systemPromptCharacterCount: document.getElementById("systemPromptCharacterCount"),
      systemPromptState: document.getElementById("systemPromptState"),
      systemPromptBuiltIn: document.getElementById("systemPromptBuiltIn"),
	      systemPromptEffective: document.getElementById("systemPromptEffective"),
	      saveSystemPromptBtn: document.getElementById("saveSystemPromptBtn"),
	      meetingPresetImportInput: document.getElementById("meetingPresetImportInput"),
	      meetingPresetSelect: document.getElementById("meetingPresetSelect"),
	      selectMeetingPresetImportBtn: document.getElementById("selectMeetingPresetImportBtn"),
	      deleteMeetingPresetBtn: document.getElementById("deleteMeetingPresetBtn"),
	      meetingPresetImportPanel: document.getElementById("meetingPresetImportPanel"),
	      meetingPresetImportFileName: document.getElementById("meetingPresetImportFileName"),
	      meetingPresetImportSummary: document.getElementById("meetingPresetImportSummary"),
	      meetingPresetImportName: document.getElementById("meetingPresetImportName"),
	      meetingPresetImportOrderField: document.getElementById("meetingPresetImportOrderField"),
	      meetingPresetImportOrder: document.getElementById("meetingPresetImportOrder"),
	      importMeetingPresetBtn: document.getElementById("importMeetingPresetBtn"),
	      cancelMeetingPresetImportBtn: document.getElementById("cancelMeetingPresetImportBtn"),
	      meetingPresetImportState: document.getElementById("meetingPresetImportState"),
	      meetingPresetEmpty: document.getElementById("meetingPresetEmpty"),
	      meetingPresetEditor: document.getElementById("meetingPresetEditor"),
	      meetingPresetName: document.getElementById("meetingPresetName"),
	      meetingPresetState: document.getElementById("meetingPresetState"),
	      meetingPresetParametersEnabled: document.getElementById("meetingPresetParametersEnabled"),
	      meetingPresetParameters: document.getElementById("meetingPresetParameters"),
	      meetingPresetCompatibility: document.getElementById("meetingPresetCompatibility"),
	      meetingPresetPromptCount: document.getElementById("meetingPresetPromptCount"),
	      meetingPresetPromptList: document.getElementById("meetingPresetPromptList"),
	      saveMeetingPresetBtn: document.getElementById("saveMeetingPresetBtn"),
	      tavilyApiKey: document.getElementById("tavilyApiKey"),
      tavilyProxyUrl: document.getElementById("tavilyProxyUrl"),
      saveTavilyBtn: document.getElementById("saveTavilyBtn"),
      testTavilyBtn: document.getElementById("testTavilyBtn"),
      clearTavilyBtn: document.getElementById("clearTavilyBtn"),
      clearTavilyProxyBtn: document.getElementById("clearTavilyProxyBtn"),
      tavilySettingsState: document.getElementById("tavilySettingsState"),
      visionMode: document.getElementById("visionMode"),
      visionDetail: document.getElementById("visionDetail"),
      visionBaseUrl: document.getElementById("visionBaseUrl"),
      visionModel: document.getElementById("visionModel"),
      visionModelCustom: document.getElementById("visionModelCustom"),
      visionApiKey: document.getElementById("visionApiKey"),
      visionMaxImages: document.getElementById("visionMaxImages"),
      saveVisionSettingsBtn: document.getElementById("saveVisionSettingsBtn"),
      testVisionBtn: document.getElementById("testVisionBtn"),
      discoverVisionModelsBtn: document.getElementById("discoverVisionModelsBtn"),
      clearVisionApiKeyBtn: document.getElementById("clearVisionApiKeyBtn"),
      visionSettingsState: document.getElementById("visionSettingsState"),
      memoryVaultPath: document.getElementById("memoryVaultPath"),
      syncMemoryVaultBtn: document.getElementById("syncMemoryVaultBtn"),
      rebuildMemoryVaultBtn: document.getElementById("rebuildMemoryVaultBtn"),
      memoryVaultState: document.getElementById("memoryVaultState"),
      memoryVaultWriter: document.getElementById("memoryVaultWriter"),
      memoryVaultJournal: document.getElementById("memoryVaultJournal"),
      memoryVaultRecovery: document.getElementById("memoryVaultRecovery"),
      memoryVaultProjection: document.getElementById("memoryVaultProjection"),
      memoryVaultBackup: document.getElementById("memoryVaultBackup"),
      traceArchiveEnabled: document.getElementById("traceArchiveEnabled"),
      traceArchivePath: document.getElementById("traceArchivePath"),
      traceArchiveState: document.getElementById("traceArchiveState"),
      okfImportRealm: document.getElementById("okfImportRealm"),
      okfImportCharacterField: document.getElementById("okfImportCharacterField"),
      okfImportCharacter: document.getElementById("okfImportCharacter"),
      okfIncludeProfile: document.getElementById("okfIncludeProfile"),
      okfIncludeSouls: document.getElementById("okfIncludeSouls"),
      okfIncludeScenes: document.getElementById("okfIncludeScenes"),
      okfImportInput: document.getElementById("okfImportInput"),
      exportOkfBtn: document.getElementById("exportOkfBtn"),
      selectOkfImportBtn: document.getElementById("selectOkfImportBtn"),
      stageOkfImportBtn: document.getElementById("stageOkfImportBtn"),
      okfImportState: document.getElementById("okfImportState"),
      okfImportPreview: document.getElementById("okfImportPreview"),
      okfPreviewSummary: document.getElementById("okfPreviewSummary"),
      okfDocumentList: document.getElementById("okfDocumentList"),
      exportDataBtn: document.getElementById("exportDataBtn"),
      deleteDataBtn: document.getElementById("deleteDataBtn"),
      runtimeState: document.getElementById("runtimeState")
    };

    let mobileViewportFrame = 0;
    let mobileViewportWidth = Math.round(window.visualViewport?.width || window.innerWidth);
    let mobileViewportBaselineHeight = Math.round(window.visualViewport?.height || window.innerHeight);

    nodes.normalBtn.addEventListener("click", () => setUiMode("normal"));
    nodes.scheduleBtn.addEventListener("click", () => setUiMode("schedule"));
    nodes.charactersBtn.addEventListener("click", () => setUiMode("characters"));
    nodes.managementBtn.addEventListener("click", () => setUiMode("management"));
    nodes.settingsBtn.addEventListener("click", () => setUiMode("settings"));
    nodes.debugBtn.addEventListener("click", () => setUiMode("debug"));
    nodes.refreshLogsBtn.addEventListener("click", loadDebugLogs);
    nodes.modulesTabBtn.addEventListener("click", () => setManagementTab("modules"));
    nodes.profileTabBtn.addEventListener("click", () => setManagementTab("profile"));
    nodes.memoryManagementTabBtn.addEventListener("click", () => setManagementTab("memory"));
    nodes.workspaceFilesTabBtn.addEventListener("click", () => setManagementTab("files"));
    nodes.refreshModulesBtn.addEventListener("click", loadCapabilityManagement);
    nodes.moduleList.addEventListener("change", toggleAgentModule);
    nodes.moduleList.addEventListener("click", openModuleDetailFromList);
    nodes.permissionControls.addEventListener("change", toggleAgentPermission);
    nodes.workspaceAccessControls.addEventListener("click", setWorkspaceAccess);
    nodes.profileDocumentForm.addEventListener("submit", saveUserProfile);
    nodes.profileMarkdown.addEventListener("input", updateProfileCharacterCount);
    nodes.refreshUserInsightsBtn.addEventListener("click", loadUserInsights);
    nodes.userInsightList.addEventListener("click", handleUserInsightAction);
    nodes.changeUserAvatarBtn.addEventListener("click", () => nodes.userAvatarInput.click());
    nodes.userAvatarInput.addEventListener("change", changeUserAvatar);
    nodes.removeUserAvatarBtn.addEventListener("click", removeUserAvatar);
    nodes.refreshManagedMemoriesBtn.addEventListener("click", loadManagedMemories);
    nodes.searchManagedMemoriesBtn.addEventListener("click", renderManagedMemories);
    nodes.managedMemoryRealm.addEventListener("change", renderManagedMemories);
    nodes.managedMemoryCharacter.addEventListener("change", renderManagedMemories);
    nodes.managedMemoryTypeFilter.addEventListener("change", renderManagedMemories);
    nodes.managedMemoryValidity.addEventListener("change", renderManagedMemories);
    nodes.managedMemoryQuery.addEventListener("input", renderManagedMemories);
    nodes.managedMemoryCreateRealm.addEventListener("change", updateManagedMemoryCreateControls);
    nodes.managedMemoryForm.addEventListener("submit", createManagedMemory);
    nodes.retrievalPreviewForm.addEventListener("submit", runRetrievalPreview);
    nodes.retrievalPreviewResults.addEventListener("click", jumpFromMemoryDiagnostic);
    nodes.managedMemoryList.addEventListener("click", handleManagedMemoryAction);
    nodes.personProfileList.addEventListener("submit", savePersonProfile);
    nodes.personProfileList.addEventListener("change", updatePersonVisibilityControls);
    nodes.memoryJobList.addEventListener("click", retryMemoryJob);
    nodes.debugTracesBtn.addEventListener("click", () => setDebugDataset("traces"));
    nodes.debugEconomicsBtn.addEventListener("click", () => setDebugDataset("economics"));
    nodes.debugInitiativeBtn.addEventListener("click", () => setDebugDataset("initiative"));
    nodes.debugFeatureTestsBtn.addEventListener("click", () => setDebugDataset("feature-tests"));
    nodes.initiativeCharacterFilter.addEventListener("change", renderInitiativeDebug);
    nodes.initiativeDecisionFilter.addEventListener("change", renderInitiativeDebug);
    nodes.selectAllFeatureTestsBtn.addEventListener("click", toggleAllFeatureTests);
    nodes.runFeatureTestsBtn.addEventListener("click", runSelectedFeatureTests);
    nodes.exportFeatureTestReportBtn.addEventListener("click", exportLatestFeatureTestReport);
    nodes.featureTestTargetModel.addEventListener("change", () => {
      state.featureTestTargetModelId = nodes.featureTestTargetModel.value;
    });
    nodes.featureTestJudgeModel.addEventListener("change", () => {
      state.featureTestJudgeModelId = nodes.featureTestJudgeModel.value;
    });
    nodes.conversationTraceScopeBtn.addEventListener("click", () => setDebugTraceScope("conversation"));
    nodes.backgroundTraceScopeBtn.addEventListener("click", () => setDebugTraceScope("background"));
    nodes.traceIndex.addEventListener("click", selectTraceFromIndex);
    nodes.mobileTraceSelect.addEventListener("change", selectTraceFromMobile);
    nodes.traceSemanticBtn.addEventListener("click", () => setTraceView("semantic"));
    nodes.traceRawBtn.addEventListener("click", () => setTraceView("raw"));
    nodes.traceExpandBtn.addEventListener("click", toggleAllTraceBlocks);
    nodes.traceWrapBtn.addEventListener("click", toggleTraceWrap);
    nodes.traceCopyBtn.addEventListener("click", copySelectedTrace);
    nodes.traceContent.addEventListener("toggle", updateTraceExpandButton, true);
    nodes.traceContent.addEventListener("click", jumpFromMemoryDiagnostic);
    nodes.saveApiSettingsBtn.addEventListener("click", () => saveApiSettings());
    nodes.apiProfileSelect.addEventListener("change", selectApiProfile);
    nodes.newApiProfileBtn.addEventListener("click", createApiProfile);
    nodes.defaultApiProfileBtn.addEventListener("click", setDefaultApiProfile);
    nodes.deleteApiProfileBtn.addEventListener("click", deleteApiProfile);
    nodes.testModelBtn.addEventListener("click", testModelConnection);
    nodes.discoverModelsBtn.addEventListener("click", discoverModels);
    nodes.clearApiKeyBtn.addEventListener("click", clearApiKey);
    nodes.saveTavilyBtn.addEventListener("click", () => saveTavilySettings());
    nodes.testTavilyBtn.addEventListener("click", testTavilyConnection);
    nodes.clearTavilyBtn.addEventListener("click", clearTavilyKey);
    nodes.clearTavilyProxyBtn.addEventListener("click", clearTavilyProxy);
    nodes.saveVisionSettingsBtn.addEventListener("click", () => saveVisionSettings());
    nodes.testVisionBtn.addEventListener("click", testVisionConnection);
    nodes.discoverVisionModelsBtn.addEventListener("click", discoverVisionModels);
    nodes.clearVisionApiKeyBtn.addEventListener("click", clearVisionApiKey);
    nodes.syncMemoryVaultBtn.addEventListener("click", () => runMemoryVaultAction("sync"));
    nodes.rebuildMemoryVaultBtn.addEventListener("click", () => runMemoryVaultAction("rebuild"));
    nodes.traceArchiveEnabled.addEventListener("change", updateTraceArchiveSetting);
    nodes.exportOkfBtn.addEventListener("click", exportOkfBundle);
    nodes.selectOkfImportBtn.addEventListener("click", () => nodes.okfImportInput.click());
    nodes.okfImportInput.addEventListener("change", selectOkfImportBundle);
    nodes.okfImportRealm.addEventListener("change", changeOkfImportTarget);
    nodes.okfImportCharacter.addEventListener("change", () => { if (state.okfImportFile) previewOkfImport(); });
    nodes.stageOkfImportBtn.addEventListener("click", stageOkfImport);
    nodes.exportDataBtn.addEventListener("click", exportData);
    nodes.deleteDataBtn.addEventListener("click", deleteAllData);
    nodes.sessionSelect.addEventListener("change", selectSession);
    nodes.newSessionBtn.addEventListener("click", openNewConversationDialog);
    nodes.sidebarNewSessionBtn.addEventListener("click", openNewConversationDialog);
    nodes.sidebarArchivedSessionsBtn.addEventListener("click", openArchivedSessions);
    nodes.sidebarBatchManageBtn.addEventListener("click", toggleConversationBatchMode);
    nodes.conversationBatchSelectAllBtn.addEventListener("click", toggleAllConversationSelections);
    nodes.conversationBatchArchiveBtn.addEventListener("click", () => runConversationBatchAction("archive"));
    nodes.conversationBatchDeleteBtn.addEventListener("click", () => runConversationBatchAction("delete"));
    nodes.conversationListToggle.addEventListener("click", toggleConversationList);
    nodes.conversationList.addEventListener("click", selectConversationFromList);
    nodes.conversationList.addEventListener("change", updateConversationBatchSelection);
    nodes.renameSessionBtn.addEventListener("click", renameCurrentSession);
    nodes.archiveSessionBtn.addEventListener("click", archiveCurrentSession);
    nodes.deleteSessionBtn.addEventListener("click", deleteCurrentSession);
    nodes.archivedSessionsBtn.addEventListener("click", openArchivedSessions);
    nodes.sessionActionsMenuBtn.addEventListener("click", toggleSessionActionsMenu);
    nodes.mobileRenameSessionBtn.addEventListener("click", () => runMobileSessionAction(renameCurrentSession));
    nodes.mobileArchiveSessionBtn.addEventListener("click", () => runMobileSessionAction(archiveCurrentSession));
    nodes.mobileDeleteSessionBtn.addEventListener("click", () => runMobileSessionAction(deleteCurrentSession));
    nodes.resetWorldConversationBtn.addEventListener("click", () => runMobileSessionAction(resetCurrentWorldConversation));
    nodes.mobileArchivedSessionsBtn.addEventListener("click", () => runMobileSessionAction(openArchivedSessions));
    nodes.newConversationForm.addEventListener("submit", createNewConversation);
    nodes.newConversationDirectBtn.addEventListener("click", () => setNewConversationKind("direct"));
    nodes.newConversationGroupBtn.addEventListener("click", () => setNewConversationKind("world"));
    nodes.newConversationCharacter.addEventListener("change", updateNewConversationSubmit);
    nodes.newConversationWorld.addEventListener("change", updateNewConversationSubmit);
    nodes.closeNewConversationBtn.addEventListener("click", closeNewConversationDialog);
    nodes.cancelNewConversationBtn.addEventListener("click", closeNewConversationDialog);
    nodes.newConversationDialog.addEventListener("cancel", (event) => { event.preventDefault(); closeNewConversationDialog(); });
    nodes.sceneInfoBtn.addEventListener("click", openSceneInfoDialog);
    nodes.contextBudgetBtn.addEventListener("click", openContextBudgetDialog);
    nodes.closeContextBudgetBtn.addEventListener("click", closeContextBudgetDialog);
    nodes.dismissContextBudgetBtn.addEventListener("click", closeContextBudgetDialog);
    nodes.compactContextBtn.addEventListener("click", compactCurrentContext);
    nodes.contextBudgetDialog.addEventListener("cancel", (event) => { event.preventDefault(); closeContextBudgetDialog(); });
    nodes.interactionToggleBtn.addEventListener("click", openInteractionControl);
    nodes.interactionUndoBtn.addEventListener("click", undoInteractionTransition);
    nodes.closeSceneInfoBtn.addEventListener("click", closeSceneInfoDialog);
    nodes.dismissSceneInfoBtn.addEventListener("click", dismissSceneInfoDialog);
    nodes.sceneInfoDialog.addEventListener("cancel", (event) => { event.preventDefault(); dismissSceneInfoDialog(); });
    nodes.editSceneInfoBtn.addEventListener("click", beginSceneEditing);
    nodes.worldEventActions.addEventListener("click", handleWorldEventAction);
    nodes.closeArchivedSessionsBtn.addEventListener("click", () => nodes.archivedSessionsDialog.close());
    nodes.archivedSessionList.addEventListener("click", handleArchivedSessionAction);
    nodes.sessionActionForm.addEventListener("submit", submitSessionActionDialog);
    nodes.closeSessionActionBtn.addEventListener("click", () => finishSessionActionDialog(false));
    nodes.cancelSessionActionBtn.addEventListener("click", () => finishSessionActionDialog(false));
    nodes.sessionActionDialog.addEventListener("cancel", cancelSessionActionDialog);
    nodes.sessionActionDialog.addEventListener("keydown", trapSessionActionFocus);
    nodes.messageEditForm.addEventListener("submit", submitMessageEdit);
    nodes.closeMessageEditBtn.addEventListener("click", closeMessageEditDialog);
    nodes.cancelMessageEditBtn.addEventListener("click", closeMessageEditDialog);
    nodes.messageEditDialog.addEventListener("cancel", (event) => { event.preventDefault(); closeMessageEditDialog(); });
    nodes.closeCharacterProfileBtn.addEventListener("click", closeCharacterProfile);
    nodes.characterProfileDialog.addEventListener("cancel", (event) => { event.preventDefault(); closeCharacterProfile(); });
    nodes.characterProfileDialog.addEventListener("click", (event) => { if (event.target === nodes.characterProfileDialog) closeCharacterProfile(); });
    nodes.closeCharacterChannelBtn.addEventListener("click", closeCharacterChannel);
    nodes.characterChannelDialog.addEventListener("cancel", (event) => { event.preventDefault(); closeCharacterChannel(); });
    nodes.characterChannelDialog.addEventListener("click", (event) => { if (event.target === nodes.characterChannelDialog) closeCharacterChannel(); });
    nodes.closeModuleDetailBtn.addEventListener("click", () => nodes.moduleDetailDialog.close());
    nodes.closeWorkspaceFilePreviewBtn.addEventListener("click", () => nodes.workspaceFilePreviewDialog.close());
    nodes.workspaceFilePreviewDialog.addEventListener("cancel", (event) => { event.preventDefault(); nodes.workspaceFilePreviewDialog.close(); });
    nodes.closeChatImageBtn.addEventListener("click", closeChatImagePreview);
    nodes.chatImageDialog.addEventListener("cancel", (event) => { event.preventDefault(); closeChatImagePreview(); });
    nodes.chatImageDialog.addEventListener("click", (event) => { if (event.target === nodes.chatImageDialog) closeChatImagePreview(); });
    nodes.workspaceFileUpBtn.addEventListener("click", openWorkspaceParentDirectory);
    nodes.workspaceFileRefreshBtn.addEventListener("click", loadWorkspaceFiles);
    nodes.workspaceFileUploadBtn.addEventListener("click", () => nodes.workspaceFileUploadInput.click());
    nodes.workspaceFileUploadInput.addEventListener("change", uploadWorkspaceManagerFiles);
    nodes.workspaceFileList.addEventListener("click", handleWorkspaceFileAction);
    nodes.conversationHeaderAvatar.addEventListener("click", handleCharacterProfileClick);
    document.addEventListener("click", closeSessionActionsMenuFromOutside);
    document.addEventListener("keydown", closeSessionActionsMenuOnEscape);
    nodes.modeSelect.addEventListener("change", () => {
      updateRpControls();
      void loadConversationScene();
    });
    nodes.chatCharacterSelect.addEventListener("change", () => {
      state.selectedCharacterId = nodes.chatCharacterSelect.value;
      updateChatIdentity();
      renderConversationList();
      void loadConversationScene();
    });
    nodes.scheduleTodayBtn.addEventListener("click", showTodayInCalendar);
    nodes.userScheduleTabBtn.addEventListener("click", () => setScheduleOwner("user"));
    nodes.characterScheduleTabBtn.addEventListener("click", () => setScheduleOwner("character"));
    nodes.scheduleCharacterSelect.addEventListener("change", changeScheduleCharacter);
    nodes.scheduleAgendaViewBtn.addEventListener("click", () => setScheduleMobileView("agenda"));
    nodes.scheduleCalendarViewBtn.addEventListener("click", () => setScheduleMobileView("calendar"));
    nodes.scheduleTasksViewBtn.addEventListener("click", () => setScheduleMobileView("tasks"));
    nodes.schedulePreviousMonthBtn.addEventListener("click", () => moveScheduleMonth(-1));
    nodes.scheduleNextMonthBtn.addEventListener("click", () => moveScheduleMonth(1));
    nodes.scheduleCreateBtn.addEventListener("click", openNewScheduleEditor);
    nodes.closeScheduleEditorBtn.addEventListener("click", resetScheduleEditor);
    nodes.scheduleEditorDialog.addEventListener("cancel", (event) => { event.preventDefault(); resetScheduleEditor(); });
    nodes.scheduleCalendar.addEventListener("click", selectCalendarDate);
    nodes.scheduleKind.addEventListener("change", updateScheduleEditorFields);
    nodes.scheduleAllDay.addEventListener("change", updateScheduleEditorFields);
    nodes.taskPendingBtn.addEventListener("click", () => setTaskFilter("pending"));
    nodes.taskAllBtn.addEventListener("click", () => setTaskFilter("all"));
    nodes.taskCompletedBtn.addEventListener("click", () => setTaskFilter("completed"));
    nodes.taskList.addEventListener("click", handleScheduleAction);
    nodes.scheduleForm.addEventListener("submit", saveScheduleItem);
    nodes.resetScheduleBtn.addEventListener("click", resetScheduleEditor);
    nodes.scheduleList.addEventListener("click", handleScheduleAction);
    nodes.newCharacterBtn.addEventListener("click", resetCharacterForm);
    nodes.characterCardGrid.addEventListener("click", selectCharacterCard);
    nodes.newWorldCardBtn.addEventListener("click", () => openWorldManager(""));
    nodes.worldCardGrid.addEventListener("click", selectWorldCard);
    nodes.characterSettingsTabBtn.addEventListener("click", () => setCharacterTab("settings"));
    nodes.characterFunctionTabBtn.addEventListener("click", () => setCharacterTab("capabilities"));
    nodes.characterMemoryTabBtn.addEventListener("click", () => setCharacterTab("memory"));
    nodes.characterRelationshipTabBtn.addEventListener("click", () => setCharacterTab("relationship"));
    nodes.characterLifeTabBtn.addEventListener("click", () => setCharacterTab("life"));
    nodes.resetRelationshipBtn.addEventListener("click", resetRelationship);
    nodes.saveCharacterWorldBtn.addEventListener("click", saveCharacterWorld);
    nodes.saveCharacterLifeBtn.addEventListener("click", saveCharacterLife);
    nodes.planCharacterLifeBtn.addEventListener("click", planCharacterLife);
    nodes.simulateCharacterMomentBtn.addEventListener("click", simulateCharacterMoment);
    nodes.resumeProactiveBtn.addEventListener("click", resumeProactiveMessages);
    nodes.lifeTopicPolicyList.addEventListener("click", resetProactiveTopic);
    nodes.closeWorldManagerBtn.addEventListener("click", closeWorldManager);
    nodes.worldManagerDialog.addEventListener("cancel", (event) => { event.preventDefault(); closeWorldManager(); });
    nodes.worldManagerWorldSelect.addEventListener("change", selectWorldEditor);
    nodes.newWorldBtn.addEventListener("click", resetWorldEditor);
    nodes.worldForm.addEventListener("submit", saveWorld);
    nodes.worldPlaceForm.addEventListener("submit", saveWorldPlace);
    nodes.cancelPlaceEditBtn.addEventListener("click", resetPlaceEditor);
    nodes.worldPlaceList.addEventListener("click", handleWorldPlaceAction);
    nodes.characterForm.addEventListener("submit", saveCharacter);
    nodes.characterFunctionForm.addEventListener("submit", saveCharacterFunction);
    nodes.characterFunctionAutomatic.addEventListener("change", updateCharacterFunctionAutomation);
    nodes.refreshCharacterFunctionBtn.addEventListener("click", refreshCharacterFunction);
    nodes.characterSkillVersionSelect.addEventListener("change", inspectCharacterSkillVersion);
    nodes.activateCharacterSkillVersionBtn.addEventListener("click", activateCharacterSkillVersion);
    nodes.characterCapabilityList.addEventListener("change", updateCharacterCapabilityControls);
    nodes.characterCapabilityList.addEventListener("click", setCharacterCapabilityResponsibility);
    nodes.characterName.addEventListener("input", renderCharacterAvatarPreview);
    nodes.characterSoulMarkdown.addEventListener("input", updateCharacterSoulCount);
    nodes.changeCharacterAvatarBtn.addEventListener("click", () => nodes.characterAvatarInput.click());
    nodes.characterAvatarInput.addEventListener("change", changeCharacterAvatar);
    nodes.removeCharacterAvatarBtn.addEventListener("click", removeCharacterAvatar);
    nodes.sceneForm.addEventListener("submit", saveScene);
    nodes.searchMemoryBtn.addEventListener("click", loadMemories);
    nodes.addMemoryBtn.addEventListener("click", openMemoryEditor);
    nodes.closeMemoryEditorBtn.addEventListener("click", closeMemoryEditor);
    nodes.cancelMemoryEditorBtn.addEventListener("click", closeMemoryEditor);
    nodes.memoryEditorDialog.addEventListener("cancel", (event) => { event.preventDefault(); closeMemoryEditor(); });
    nodes.memoryForm.addEventListener("submit", pinMemory);
    nodes.memoryList.addEventListener("click", handleMemoryAction);
    nodes.cancelMessageBtn.addEventListener("click", cancelMessage);
    nodes.retryMessageBtn.addEventListener("click", retryMessage);
    nodes.attachFileBtn.addEventListener("click", () => nodes.chatAttachmentInput.click());
    nodes.emojiPickerBtn.addEventListener("pointerdown", (event) => event.preventDefault());
    nodes.emojiPickerBtn.addEventListener("click", toggleEmojiPicker);
    nodes.emojiPickerCategories.addEventListener("click", selectEmojiCategory);
    nodes.emojiPickerGrid.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) event.preventDefault();
    });
    nodes.emojiPickerGrid.addEventListener("click", insertSelectedEmoji);
    nodes.chatAttachmentInput.addEventListener("change", uploadChatAttachments);
    nodes.attachmentQueue.addEventListener("click", removeQueuedAttachment);
    nodes.composer.addEventListener("submit", async (event) => {
      event.preventDefault();
      await sendMessage();
    });
    nodes.messages.addEventListener("toggle", rememberMessageDisclosure, true);
    nodes.messages.addEventListener("click", handleSystemEventAction);
    nodes.messages.addEventListener("click", handleMessageAction);
    nodes.messages.addEventListener("click", handleProactiveFeedback);
    nodes.messages.addEventListener("click", handleMessageMediaClick);
    nodes.messages.addEventListener("click", handleCharacterProfileClick);
    nodes.messages.addEventListener("click", handleInteractionEventAction);
    nodes.textInput.addEventListener("compositionstart", () => {
      state.composingMessage = true;
    });
    nodes.textInput.addEventListener("compositionend", () => {
      state.composingMessage = false;
      state.compositionEndedAt = performance.now();
    });
    nodes.textInput.addEventListener("input", schedulePrivateTypingHeartbeat);
    nodes.textInput.addEventListener("paste", pasteChatAttachments);
    nodes.textInput.addEventListener("focus", scheduleMobileViewportSync);
    nodes.textInput.addEventListener("blur", scheduleMobileViewportSync);
    nodes.textInput.addEventListener("keydown", async (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        const justCommittedComposition = performance.now() - state.compositionEndedAt < 100;
        if (event.isComposing || state.composingMessage || event.keyCode === 229 || justCommittedComposition) return;
        event.preventDefault();
        await sendMessage();
      }
    });
    document.addEventListener("pointerdown", (event) => {
      if (!nodes.emojiPicker.hidden && !nodes.composer.contains(event.target)) closeEmojiPicker();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || nodes.emojiPicker.hidden) return;
      event.preventDefault();
      closeEmojiPicker(true);
    });
    nodes.modelSettingsTabBtn.addEventListener("click", () => setSettingsTab("model"));
    nodes.visionSettingsTabBtn.addEventListener("click", () => setSettingsTab("vision"));
    nodes.searchSettingsTabBtn.addEventListener("click", () => setSettingsTab("search"));
	    nodes.promptSettingsTabBtn.addEventListener("click", () => setSettingsTab("prompt"));
	    nodes.dataSettingsTabBtn.addEventListener("click", () => setSettingsTab("data"));
	    nodes.systemPromptSettingsViewBtn.addEventListener("click", () => setPromptSettingsView("system"));
	    nodes.meetingPresetSettingsViewBtn.addEventListener("click", () => setPromptSettingsView("preset"));
	    nodes.smsPromptModeBtn.addEventListener("click", () => setPromptMode("sms"));
	    nodes.systemPromptCustom.addEventListener("input", updateSystemPromptCharacterCount);
	    nodes.saveSystemPromptBtn.addEventListener("click", saveSystemPrompt);
	    nodes.meetingPresetSelect.addEventListener("change", selectMeetingPreset);
	    nodes.selectMeetingPresetImportBtn.addEventListener("click", () => nodes.meetingPresetImportInput.click());
	    nodes.meetingPresetImportInput.addEventListener("change", selectMeetingPresetImport);
	    nodes.meetingPresetImportOrder.addEventListener("change", renderMeetingPresetImport);
	    nodes.meetingPresetImportName.addEventListener("input", renderMeetingPresetImport);
	    nodes.importMeetingPresetBtn.addEventListener("click", importMeetingPreset);
	    nodes.cancelMeetingPresetImportBtn.addEventListener("click", resetMeetingPresetImport);
	    nodes.saveMeetingPresetBtn.addEventListener("click", saveMeetingPreset);
	    nodes.deleteMeetingPresetBtn.addEventListener("click", deleteMeetingPreset);
	    nodes.meetingPresetPromptList.addEventListener("change", updateMeetingPresetPromptRow);
	    nodes.meetingPresetPromptList.addEventListener("input", updateMeetingPresetPromptRow);
	    nodes.meetingPresetPromptList.addEventListener("click", preserveMeetingPresetPromptToggle);
	    nodes.apiModel.addEventListener("change", syncCustomModelVisibility);
    nodes.visionModel.addEventListener("change", syncCustomVisionModelVisibility);

    if (window.marked) {
      window.marked.setOptions({ gfm: true, breaks: true });
    }
    renderEmojiPicker();
    renderMessages();
    refreshIcons();
    updateRpControls();
    scheduleMobileViewportSync();
    window.addEventListener("resize", scheduleMobileViewportSync, { passive: true });
    window.addEventListener("orientationchange", scheduleMobileViewportSync, { passive: true });
    window.visualViewport?.addEventListener("resize", scheduleMobileViewportSync, { passive: true });
    window.visualViewport?.addEventListener("scroll", scheduleMobileViewportSync, { passive: true });
    window.addEventListener("focus", () => void acknowledgeVisibleConversation());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void acknowledgeVisibleConversation();
    });
    void initializeChat();
    window.setInterval(() => {
      if (!state.busy && state.activeConversationKind === "world" && state.activeWorldId && state.uiMode === "normal") {
        void refreshWorldMessages(true);
      } else if (!state.busy && !state.sessionDraft && state.activeSessionId && state.uiMode === "normal") {
        void refreshSessionMessages(true);
      }
    }, 3000);
    window.setInterval(() => void pollIncomingMessages(), 3000);

    function renderEmojiPicker() {
      nodes.emojiPickerCategories.innerHTML = Object.entries(emojiGroups).map(([id, group]) =>
        '<button class="emoji-category-button' + (id === state.emojiCategory ? ' active' : '') + '" type="button" role="tab"' +
          ' aria-selected="' + (id === state.emojiCategory ? 'true' : 'false') + '" aria-label="' + escapeHtml(group.label) + '"' +
          ' title="' + escapeHtml(group.label) + '" data-emoji-category="' + escapeHtml(id) + '">' + escapeHtml(group.icon) + '</button>'
      ).join("");
      const group = emojiGroups[state.emojiCategory] || emojiGroups.faces;
      nodes.emojiPickerGrid.innerHTML = group.values.map((emoji) =>
        '<button class="emoji-option" type="button" data-emoji-value="' + escapeHtml(emoji) + '"' +
          ' aria-label="插入表情 ' + escapeHtml(emoji) + '" title="' + escapeHtml(emoji) + '">' + escapeHtml(emoji) + '</button>'
      ).join("");
      nodes.emojiPickerGrid.scrollTop = 0;
    }

    function toggleEmojiPicker() {
      const open = nodes.emojiPicker.hidden;
      nodes.emojiPicker.hidden = !open;
      nodes.emojiPickerBtn.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) renderEmojiPicker();
    }

    function closeEmojiPicker(restoreFocus) {
      nodes.emojiPicker.hidden = true;
      nodes.emojiPickerBtn.setAttribute("aria-expanded", "false");
      if (restoreFocus) nodes.textInput.focus({ preventScroll: true });
    }

    function selectEmojiCategory(event) {
      const button = event.target.closest("[data-emoji-category]");
      if (!button || !emojiGroups[button.dataset.emojiCategory]) return;
      state.emojiCategory = button.dataset.emojiCategory;
      renderEmojiPicker();
    }

    function insertSelectedEmoji(event) {
      const button = event.target.closest("[data-emoji-value]");
      if (!button) return;
      const emoji = button.dataset.emojiValue || "";
      const start = Number.isInteger(nodes.textInput.selectionStart)
        ? nodes.textInput.selectionStart
        : nodes.textInput.value.length;
      const end = Number.isInteger(nodes.textInput.selectionEnd) ? nodes.textInput.selectionEnd : start;
      nodes.textInput.setRangeText(emoji, start, end, "end");
      nodes.textInput.dispatchEvent(new Event("input", { bubbles: true }));
      nodes.textInput.focus({ preventScroll: true });
    }

    function scheduleMobileViewportSync() {
      if (mobileViewportFrame) cancelAnimationFrame(mobileViewportFrame);
      mobileViewportFrame = requestAnimationFrame(syncMobileViewport);
    }

    function syncMobileViewport() {
      mobileViewportFrame = 0;
      const root = document.documentElement;
      const mobile = window.matchMedia("(max-width: 900px)").matches;
      if (!mobile) {
        document.body.classList.remove("keyboard-open");
        root.style.setProperty("--app-height", "100dvh");
        root.style.setProperty("--visual-viewport-top", "0px");
        return;
      }

      const viewport = window.visualViewport;
      const width = Math.round(viewport?.width || window.innerWidth);
      const height = Math.max(1, Math.round(viewport?.height || window.innerHeight));
      const offsetTop = Math.max(0, Math.round(viewport?.offsetTop || 0));
      const inputFocused = document.activeElement === nodes.textInput;

      if (Math.abs(width - mobileViewportWidth) > 48) {
        mobileViewportWidth = width;
        mobileViewportBaselineHeight = height;
      } else if (!inputFocused) {
        mobileViewportBaselineHeight = Math.max(mobileViewportBaselineHeight, height);
      }

      const keyboardOpen = inputFocused && mobileViewportBaselineHeight - height > 96;
      root.style.setProperty("--app-height", height + "px");
      root.style.setProperty("--visual-viewport-top", offsetTop + "px");
      document.body.classList.toggle("keyboard-open", keyboardOpen);
      if (keyboardOpen && state.uiMode === "normal") {
        document.scrollingElement?.scrollTo(0, 0);
        requestAnimationFrame(() => {
          nodes.messages.scrollTop = nodes.messages.scrollHeight;
        });
      }
    }

    function setUiMode(mode) {
      state.uiMode = mode;
      document.body.dataset.uiMode = mode;
      updateInteractionChrome();
      updateContextBudgetChrome();
      nodes.normalBtn.classList.toggle("active", mode === "normal");
      nodes.scheduleBtn.classList.toggle("active", mode === "schedule");
      nodes.charactersBtn.classList.toggle("active", mode === "characters");
      nodes.managementBtn.classList.toggle("active", mode === "management");
      nodes.settingsBtn.classList.toggle("active", mode === "settings");
      nodes.debugBtn.classList.toggle("active", mode === "debug");
      nodes.mainPane.dataset.mode = mode;
      nodes.chatPane.hidden = mode !== "normal";
      nodes.schedulePage.hidden = mode !== "schedule";
      nodes.charactersPage.hidden = mode !== "characters";
      nodes.managementPage.hidden = mode !== "management";
      nodes.settingsPage.hidden = mode !== "settings";
      nodes.debugPane.hidden = mode !== "debug";
      if (mode === "debug") {
        loadDebugLogs();
        loadFeatureTestCases();
      }
      if (mode === "settings") {
        setSettingsTab(state.settingsTab);
      }
      if (mode === "schedule") {
        setScheduleMobileView(state.scheduleMobileView);
        renderScheduleScope();
        loadScheduleItems();
      }
      if (mode === "normal") {
        nodes.conversationListToggle.hidden = false;
        updateChatIdentity();
        updateSessionActionState();
        void loadConversationScene();
        void acknowledgeVisibleConversation();
      }
      if (mode === "characters") {
        loadCharacters();
      }
      if (mode === "management") {
        loadManagement();
      }
    }

    function setManagementTab(tab) {
      state.managementTab = tab;
      nodes.modulesTabBtn.classList.toggle("active", tab === "modules");
      nodes.profileTabBtn.classList.toggle("active", tab === "profile");
      nodes.memoryManagementTabBtn.classList.toggle("active", tab === "memory");
      nodes.workspaceFilesTabBtn.classList.toggle("active", tab === "files");
      nodes.modulesPanel.hidden = tab !== "modules";
      nodes.profilePanel.hidden = tab !== "profile";
      nodes.memoryManagementPanel.hidden = tab !== "memory";
      nodes.workspaceFilesPanel.hidden = tab !== "files";
      nodes.managementPage.scrollTop = 0;
      if (tab === "modules") loadCapabilityManagement();
      if (tab === "profile") {
        loadUserProfile();
        loadUserInsights();
      }
      if (tab === "memory") loadManagedMemories();
      if (tab === "files") loadWorkspaceFiles();
    }

    function loadManagement() {
      setManagementTab(state.managementTab);
    }

    function setSettingsTab(tab) {
      state.settingsTab = tab;
      nodes.modelSettingsTabBtn.classList.toggle("active", tab === "model");
      nodes.visionSettingsTabBtn.classList.toggle("active", tab === "vision");
      nodes.searchSettingsTabBtn.classList.toggle("active", tab === "search");
      nodes.promptSettingsTabBtn.classList.toggle("active", tab === "prompt");
      nodes.dataSettingsTabBtn.classList.toggle("active", tab === "data");
      nodes.modelSettingsPanel.hidden = tab !== "model";
      nodes.visionSettingsPanel.hidden = tab !== "vision";
      nodes.searchSettingsPanel.hidden = tab !== "search";
      nodes.promptSettingsPanel.hidden = tab !== "prompt";
      nodes.dataSettingsPanel.hidden = tab !== "data";
      nodes.settingsPage.scrollTop = 0;
      if (tab === "model") loadApiSettings();
      if (tab === "vision") loadVisionSettings();
      if (tab === "search") loadTavilySettings();
      if (tab === "prompt") setPromptSettingsView(state.promptSettingsView);
      if (tab === "data") {
        loadReadiness();
        loadMemoryVaultStatus();
        loadTraceArchiveSettings();
      }
    }

    function setPromptSettingsView(view) {
      state.promptSettingsView = view === "preset" ? "preset" : "system";
      const system = state.promptSettingsView === "system";
      nodes.systemPromptSettingsViewBtn.classList.toggle("active", system);
      nodes.meetingPresetSettingsViewBtn.classList.toggle("active", !system);
      nodes.systemPromptSettingsViewBtn.setAttribute("aria-selected", String(system));
      nodes.meetingPresetSettingsViewBtn.setAttribute("aria-selected", String(!system));
      nodes.systemPromptSettingsView.hidden = !system;
      nodes.meetingPresetSettingsView.hidden = system;
      if (system) void loadSystemPrompts();
      else void loadMeetingPresetCatalog(state.selectedMeetingPresetId, true);
    }

    function setPromptMode(mode) {
      state.promptMode = mode;
      nodes.smsPromptModeBtn.classList.toggle("active", mode === "sms");
      renderSystemPromptEditor();
    }

    async function loadSystemPrompts() {
      nodes.systemPromptState.textContent = "加载中...";
      nodes.systemPromptCustom.disabled = true;
      nodes.saveSystemPromptBtn.disabled = true;
      try {
        const response = await fetch("/api/v1/system-prompts");
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "提示词加载失败");
        state.systemPrompts = body.prompts || null;
        renderSystemPromptEditor();
        nodes.systemPromptState.textContent = "已加载";
      } catch (error) {
        nodes.systemPromptState.textContent = error.message || String(error);
      } finally {
        nodes.systemPromptCustom.disabled = false;
        nodes.saveSystemPromptBtn.disabled = false;
      }
    }

    function renderSystemPromptEditor() {
      const prompt = state.systemPrompts?.[state.promptMode];
      nodes.systemPromptCustom.value = prompt?.custom || "";
      nodes.systemPromptBuiltIn.textContent = prompt?.builtIn || "";
      nodes.systemPromptEffective.textContent = prompt?.effective || "";
      updateSystemPromptCharacterCount();
    }

    function updateSystemPromptCharacterCount() {
      const count = Array.from(nodes.systemPromptCustom.value).length;
      nodes.systemPromptCharacterCount.textContent = count.toLocaleString() + " / 6000";
      nodes.systemPromptCharacterCount.classList.toggle("error", count > 6000);
    }

	    async function saveSystemPrompt() {
	      nodes.saveSystemPromptBtn.disabled = true;
	      nodes.systemPromptState.textContent = "保存中...";
      try {
        const response = await fetch("/api/v1/system-prompts", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: state.promptMode, custom: nodes.systemPromptCustom.value })
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "提示词保存失败");
        state.systemPrompts = { ...(state.systemPrompts || {}), [state.promptMode]: body.prompt };
        renderSystemPromptEditor();
        nodes.systemPromptState.textContent = "已保存";
        setStatus("系统提示词已保存");
      } catch (error) {
        nodes.systemPromptState.textContent = error.message || String(error);
        setStatus(error.message || String(error), true);
      } finally {
	        nodes.saveSystemPromptBtn.disabled = false;
	      }
	    }

	    async function loadMeetingPresetCatalog(preferredId, loadSelected = true) {
	      try {
	        const response = await fetch("/api/v1/meeting-presets");
	        const body = await response.json();
	        if (!response.ok) throw new Error(body.error || "见面模式预设加载失败");
	        state.meetingPresets = Array.isArray(body.presets) ? body.presets : [];
	        const candidate = preferredId || state.selectedMeetingPresetId;
	        state.selectedMeetingPresetId = state.meetingPresets.some((preset) => preset.id === candidate)
	          ? candidate
	          : state.meetingPresets[0]?.id || "";
	        renderMeetingPresetOptions();
	        if (loadSelected && state.selectedMeetingPresetId) {
	          await loadMeetingPreset(state.selectedMeetingPresetId);
	        } else if (!state.selectedMeetingPresetId) {
	          clearMeetingPresetEditor();
	        }
	        return state.meetingPresets;
	      } catch (error) {
	        nodes.meetingPresetState.textContent = error.message || String(error);
	        if (state.promptSettingsView === "preset") setStatus(error.message || String(error), true);
	        return [];
	      }
	    }

	    function renderMeetingPresetOptions() {
	      nodes.meetingPresetSelect.innerHTML = state.meetingPresets.length
	        ? state.meetingPresets.map((preset) => {
	            const promptCount = Number.isFinite(Number(preset.promptCount))
	              ? " · " + Number(preset.promptCount) + " 项"
	              : "";
	            return '<option value="' + escapeHtml(preset.id) + '">' +
	              escapeHtml(preset.name || "未命名预设") + promptCount + '</option>';
	          }).join("")
	        : '<option value="">尚未导入预设</option>';
	      nodes.meetingPresetSelect.value = state.selectedMeetingPresetId;
	      nodes.meetingPresetSelect.disabled = !state.meetingPresets.length;
	      nodes.deleteMeetingPresetBtn.disabled = !state.selectedMeetingPresetId;
	      renderCharacterMeetingPresetOptions();
	    }

	    function renderCharacterMeetingPresetOptions(selectedId = nodes.characterMeetingPreset.value) {
	      nodes.characterMeetingPreset.innerHTML = '<option value="">不启用上下文预设</option>' +
	        state.meetingPresets.map((preset) =>
	          '<option value="' + escapeHtml(preset.id) + '">' +
	            escapeHtml(preset.name || "未命名预设") + '</option>'
	        ).join("");
	      nodes.characterMeetingPreset.value = state.meetingPresets.some((preset) => preset.id === selectedId)
	        ? selectedId
	        : "";
	    }

	    function selectMeetingPreset() {
	      state.selectedMeetingPresetId = nodes.meetingPresetSelect.value;
	      void loadMeetingPreset(state.selectedMeetingPresetId);
	    }

	    async function loadMeetingPreset(presetId) {
	      if (!presetId) {
	        clearMeetingPresetEditor();
	        return;
	      }
	      const requestedId = presetId;
	      nodes.meetingPresetState.textContent = "加载中...";
	      nodes.meetingPresetEditor.hidden = true;
	      nodes.meetingPresetEmpty.hidden = false;
	      nodes.meetingPresetEmpty.textContent = "正在加载预设...";
	      try {
	        const response = await fetch("/api/v1/meeting-presets/" + encodeURIComponent(requestedId));
	        const body = await response.json();
	        if (!response.ok) throw new Error(body.error || "见面模式预设加载失败");
	        if (state.selectedMeetingPresetId !== requestedId) return;
	        state.meetingPreset = body.preset || null;
	        renderMeetingPresetEditor();
	        nodes.meetingPresetState.textContent = "已加载";
	      } catch (error) {
	        if (state.selectedMeetingPresetId !== requestedId) return;
	        state.meetingPreset = null;
	        clearMeetingPresetEditor(error.message || String(error));
	      }
	    }

	    function clearMeetingPresetEditor(message) {
	      state.meetingPreset = null;
	      nodes.meetingPresetEditor.hidden = true;
	      nodes.meetingPresetEmpty.hidden = false;
	      nodes.meetingPresetEmpty.textContent = message || (
	        state.meetingPresets.length
	          ? "选择一个预设进行编辑。"
	          : "导入一个酒馆 JSON 预设后，可在这里逐项启用并编辑。"
	      );
	      nodes.meetingPresetName.value = "";
	      nodes.meetingPresetParametersEnabled.checked = false;
	      nodes.meetingPresetParameters.value = "";
	      nodes.meetingPresetCompatibility.hidden = true;
	      nodes.meetingPresetCompatibility.innerHTML = "";
	      nodes.meetingPresetPromptList.innerHTML = "";
	      nodes.meetingPresetPromptCount.textContent = "";
	      if (message) nodes.meetingPresetState.textContent = message;
	    }

	    function renderMeetingPresetEditor() {
	      const preset = state.meetingPreset;
	      if (!preset) {
	        clearMeetingPresetEditor();
	        return;
	      }
	      nodes.meetingPresetEmpty.hidden = true;
	      nodes.meetingPresetEditor.hidden = false;
	      nodes.meetingPresetName.value = preset.name || "";
	      nodes.meetingPresetParametersEnabled.checked = Boolean(preset.parametersEnabled);
	      nodes.meetingPresetParameters.value = JSON.stringify(preset.parameters ?? {}, null, 2);
	      renderMeetingPresetCompatibility(preset.importInfo);
	      const prompts = Array.isArray(preset.prompts) ? preset.prompts : [];
	      nodes.meetingPresetPromptCount.textContent =
	        prompts.filter((prompt) => prompt.enabled).length + " / " + prompts.length + " 项启用";
	      nodes.meetingPresetPromptList.innerHTML = prompts.map(renderMeetingPresetPrompt).join("");
	      refreshIcons();
	    }

	    function renderMeetingPresetCompatibility(importInfo) {
	      const info = importInfo && typeof importInfo === "object" ? importInfo : {};
	      const rows = [
	        '<span><strong>编排：</strong>' +
	          escapeHtml(info.promptOrderCharacterId
	            ? "prompt_order " + info.promptOrderCharacterId
	            : "按原始 Prompt 顺序") +
	          (Number.isFinite(Number(info.sourcePromptCount))
	            ? " · 源文件 " + Number(info.sourcePromptCount) + " 项"
	            : "") +
	        '</span>',
	        '<span>导入预设不会自动绑定角色；请在角色设定中手动启用。</span>'
	      ];
	      if (Array.isArray(info.ignoredExtensionKeys) && info.ignoredExtensionKeys.length) {
	        rows.push('<span class="warn"><strong>未执行扩展：</strong>' +
	          escapeHtml(info.ignoredExtensionKeys.join("、")) + '</span>');
	      }
	      if (Array.isArray(info.unsupportedParameterKeys) && info.unsupportedParameterKeys.length) {
	        rows.push('<span class="warn"><strong>未应用参数：</strong>' +
	          escapeHtml(info.unsupportedParameterKeys.join("、")) + '</span>');
	      }
	      if (Array.isArray(info.warnings)) {
	        for (const warning of info.warnings) {
	          rows.push('<span class="warn">' + escapeHtml(warning) + '</span>');
	        }
	      }
	      nodes.meetingPresetCompatibility.innerHTML = rows.join("");
	      nodes.meetingPresetCompatibility.hidden = false;
	    }

	    function renderMeetingPresetPrompt(prompt, index) {
	      const marker = Boolean(
	        prompt?.marker ||
	        prompt?.dynamic ||
	        prompt?.kind === "marker" ||
	        prompt?.type === "marker"
	      );
	      const role = normalizeMeetingPresetRole(prompt?.role);
	      const name = String(prompt?.name || prompt?.id || "未命名分项");
	      const id = String(prompt?.id || "prompt-" + index);
	      const enabled = Boolean(prompt?.enabled);
	      const disabled = marker ? " disabled" : "";
	      return '<details class="meeting-preset-prompt-row' + (enabled ? ' enabled' : '') +
	        '" data-meeting-preset-prompt-id="' + escapeHtml(id) + '">' +
	        '<summary>' +
	          '<input type="checkbox" data-meeting-prompt-enabled aria-label="启用 ' + escapeHtml(name) + '"' +
	            (enabled ? ' checked' : '') + ' />' +
	          '<strong>' + escapeHtml(name) + '</strong>' +
	          '<span class="meeting-preset-prompt-role">' + escapeHtml(role) + '</span>' +
	          (marker ? '<span class="meeting-preset-prompt-kind">动态上下文</span>' : '') +
	        '</summary>' +
	        '<div class="meeting-preset-prompt-editor">' +
	          '<label>名称<input data-meeting-prompt-name value="' + escapeHtml(prompt?.name || "") + '"' + disabled + ' /></label>' +
	          '<label>Role<select data-meeting-prompt-role' + disabled + '>' +
	            meetingPresetRoleOptions(role) +
	          '</select></label>' +
	          '<label class="full">' + (marker ? '动态上下文插槽（由系统填充）' : '内容') +
	            '<textarea data-meeting-prompt-content spellcheck="false"' + disabled + '>' +
	              escapeHtml(prompt?.content || "") +
	            '</textarea></label>' +
	        '</div>' +
	      '</details>';
	    }

	    function normalizeMeetingPresetRole(value) {
	      if (value === "model") return "assistant";
	      return ["system", "user", "assistant"].includes(value) ? value : "user";
	    }

	    function meetingPresetRoleOptions(selected) {
	      return [
	        ["system", "system"],
	        ["user", "user"],
	        ["assistant", "assistant"]
	      ].map((entry) =>
	        '<option value="' + entry[0] + '"' + (entry[0] === selected ? ' selected' : '') + '>' +
	          entry[1] + '</option>'
	      ).join("");
	    }

	    function updateMeetingPresetPromptRow(event) {
	      const row = event.target.closest?.("[data-meeting-preset-prompt-id]");
	      if (!row) return;
	      const enabled = row.querySelector("[data-meeting-prompt-enabled]")?.checked;
	      row.classList.toggle("enabled", Boolean(enabled));
	      const nameInput = row.querySelector("[data-meeting-prompt-name]");
	      const name = nameInput?.value || row.dataset.meetingPresetPromptId || "未命名分项";
	      const summaryName = row.querySelector("summary strong");
	      if (summaryName) summaryName.textContent = name;
	      const role = row.querySelector("[data-meeting-prompt-role]")?.value;
	      const roleBadge = row.querySelector(".meeting-preset-prompt-role");
	      if (roleBadge && role) roleBadge.textContent = role;
	      const rows = [...nodes.meetingPresetPromptList.querySelectorAll("[data-meeting-preset-prompt-id]")];
	      nodes.meetingPresetPromptCount.textContent =
	        rows.filter((entry) => entry.querySelector("[data-meeting-prompt-enabled]")?.checked).length +
	        " / " + rows.length + " 项启用";
	    }

	    function preserveMeetingPresetPromptToggle(event) {
	      if (event.target.matches?.("[data-meeting-prompt-enabled]")) event.stopPropagation();
	    }

	    function collectMeetingPresetPrompts() {
	      return [...nodes.meetingPresetPromptList.querySelectorAll("[data-meeting-preset-prompt-id]")].map((row) => ({
	        id: row.dataset.meetingPresetPromptId || "",
	        name: row.querySelector("[data-meeting-prompt-name]")?.value || "",
	        role: normalizeMeetingPresetRole(row.querySelector("[data-meeting-prompt-role]")?.value),
	        content: row.querySelector("[data-meeting-prompt-content]")?.value || "",
	        enabled: Boolean(row.querySelector("[data-meeting-prompt-enabled]")?.checked)
	      }));
	    }

	    async function saveMeetingPreset() {
	      const presetId = state.selectedMeetingPresetId;
	      if (!presetId || !state.meetingPreset) return;
	      const name = nodes.meetingPresetName.value.trim();
	      if (!name) {
	        nodes.meetingPresetState.textContent = "请输入预设名称";
	        nodes.meetingPresetName.focus();
	        return;
	      }
	      let parameters;
	      try {
	        parameters = nodes.meetingPresetParameters.value.trim()
	          ? JSON.parse(nodes.meetingPresetParameters.value)
	          : {};
	        if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
	          throw new Error("模型参数必须是 JSON 对象");
	        }
	      } catch (error) {
	        nodes.meetingPresetState.textContent = error.message || "模型参数 JSON 无效";
	        nodes.meetingPresetParameters.focus();
	        return;
	      }
	      nodes.saveMeetingPresetBtn.disabled = true;
	      nodes.meetingPresetState.textContent = "保存中...";
	      try {
	        const response = await fetch("/api/v1/meeting-presets/" + encodeURIComponent(presetId), {
	          method: "PATCH",
	          headers: { "content-type": "application/json" },
	          body: JSON.stringify({
	            name,
	            parametersEnabled: nodes.meetingPresetParametersEnabled.checked,
	            parameters,
	            prompts: collectMeetingPresetPrompts()
	          })
	        });
	        const body = await response.json();
	        if (!response.ok) throw new Error(body.error || "见面模式预设保存失败");
	        state.meetingPreset = body.preset || state.meetingPreset;
	        await loadMeetingPresetCatalog(presetId, false);
	        renderMeetingPresetEditor();
	        nodes.meetingPresetState.textContent = "已保存";
	        setStatus("见面模式预设已保存");
	      } catch (error) {
	        nodes.meetingPresetState.textContent = error.message || String(error);
	        setStatus(error.message || String(error), true);
	      } finally {
	        nodes.saveMeetingPresetBtn.disabled = false;
	      }
	    }

	    async function deleteMeetingPreset() {
	      const presetId = state.selectedMeetingPresetId;
	      const preset = state.meetingPresets.find((entry) => entry.id === presetId);
	      if (!preset || !window.confirm("删除见面模式预设“" + preset.name + "”？绑定该预设的角色将不再启用它。")) return;
	      nodes.deleteMeetingPresetBtn.disabled = true;
	      try {
	        const response = await fetch("/api/v1/meeting-presets/" + encodeURIComponent(presetId), {
	          method: "DELETE"
	        });
	        const body = await response.json();
	        if (!response.ok) throw new Error(body.error || "见面模式预设删除失败");
	        state.selectedMeetingPresetId = "";
	        await loadMeetingPresetCatalog("", true);
	        await loadCharacters();
	        setStatus("见面模式预设已删除");
	      } catch (error) {
	        nodes.meetingPresetState.textContent = error.message || String(error);
	        setStatus(error.message || String(error), true);
	      } finally {
	        nodes.deleteMeetingPresetBtn.disabled = !state.selectedMeetingPresetId;
	      }
	    }

	    async function selectMeetingPresetImport() {
	      const file = nodes.meetingPresetImportInput.files?.[0] || null;
	      nodes.meetingPresetImportInput.value = "";
	      if (!file) return;
	      resetMeetingPresetImport();
	      if (file.size > 900_000) {
	        nodes.meetingPresetImportPanel.hidden = false;
	        nodes.meetingPresetImportFileName.textContent = file.name;
	        nodes.meetingPresetImportState.textContent = "JSON 文件超过 900 KB";
	        return;
	      }
	      try {
	        const source = JSON.parse(await file.text());
	        if (!source || typeof source !== "object" || Array.isArray(source)) {
	          throw new Error("预设根节点必须是 JSON 对象");
	        }
	        state.meetingPresetImportFile = file;
	        state.meetingPresetImportSource = source;
	        state.meetingPresetImportOrderOptions = meetingPresetImportOrderOptions(source);
	        nodes.meetingPresetImportName.value = file.name.replace(/\\.json$/i, "").slice(0, 120);
	        const preferredOrder = state.meetingPresetImportOrderOptions.find((entry) =>
	          String(entry.characterId) === "100001"
	        ) || state.meetingPresetImportOrderOptions.reduce((best, entry) =>
	          !best || entry.total > best.total ? entry : best
	        , null);
	        nodes.meetingPresetImportOrder.value = preferredOrder ? String(preferredOrder.characterId) : "";
	        renderMeetingPresetImport();
	        nodes.meetingPresetImportState.textContent = "JSON 已读取，请确认编排组";
	      } catch (error) {
	        nodes.meetingPresetImportPanel.hidden = false;
	        nodes.meetingPresetImportFileName.textContent = file.name;
	        nodes.meetingPresetImportSummary.textContent = "";
	        nodes.meetingPresetImportState.textContent = error.message || String(error);
	        nodes.importMeetingPresetBtn.disabled = true;
	      }
	    }

	    function meetingPresetImportOrderOptions(source) {
	      const groups = Array.isArray(source?.prompt_order) ? source.prompt_order : [];
	      return groups.filter((group) => group && Array.isArray(group.order)).map((group, index) => {
	        const order = group.order.filter((item) => item && typeof item.identifier === "string");
	        return {
	          characterId: group.character_id ?? "order-" + (index + 1),
	          total: order.length,
	          enabled: order.filter((item) => item.enabled !== false).length
	        };
	      });
	    }

	    function renderMeetingPresetImport() {
	      const file = state.meetingPresetImportFile;
	      const source = state.meetingPresetImportSource;
	      const options = state.meetingPresetImportOrderOptions;
	      nodes.meetingPresetImportPanel.hidden = !file;
	      if (!file || !source) return;
	      const selectedBefore = nodes.meetingPresetImportOrder.value;
	      nodes.meetingPresetImportFileName.textContent = file.name;
	      nodes.meetingPresetImportOrder.innerHTML = options.map((entry) =>
	        '<option value="' + escapeHtml(entry.characterId) + '">' +
	          escapeHtml(String(entry.characterId)) + " · " + entry.total + " 项（" + entry.enabled + " 项启用）</option>"
	      ).join("");
	      nodes.meetingPresetImportOrderField.hidden = !options.length;
	      nodes.meetingPresetImportOrder.disabled = !options.length;
	      if (options.some((entry) => String(entry.characterId) === selectedBefore)) {
	        nodes.meetingPresetImportOrder.value = selectedBefore;
	      } else if (options.length) {
	        const preferred = options.find((entry) => String(entry.characterId) === "100001") ||
	          options.reduce((best, entry) => entry.total > best.total ? entry : best, options[0]);
	        nodes.meetingPresetImportOrder.value = String(preferred.characterId);
	      }
	      const selected = options.find((entry) =>
	        String(entry.characterId) === nodes.meetingPresetImportOrder.value
	      );
	      const promptCount = Array.isArray(source.prompts) ? source.prompts.length : 0;
	      nodes.meetingPresetImportSummary.textContent = promptCount + " 个 Prompt" +
	        (selected ? " · 当前编排 " + selected.total + " 项，启用 " + selected.enabled + " 项" : "");
	      nodes.importMeetingPresetBtn.disabled = !nodes.meetingPresetImportName.value.trim();
	      refreshIcons();
	    }

	    async function importMeetingPreset() {
	      const source = state.meetingPresetImportSource;
	      const name = nodes.meetingPresetImportName.value.trim();
	      if (!source || !name) {
	        nodes.meetingPresetImportState.textContent = "请输入预设名称";
	        return;
	      }
	      const selectedOrder = state.meetingPresetImportOrderOptions.find((entry) =>
	        String(entry.characterId) === nodes.meetingPresetImportOrder.value
	      );
	      nodes.importMeetingPresetBtn.disabled = true;
	      nodes.selectMeetingPresetImportBtn.disabled = true;
	      nodes.meetingPresetImportState.textContent = "正在导入...";
	      try {
	        const response = await fetch("/api/v1/meeting-presets/import", {
	          method: "POST",
	          headers: { "content-type": "application/json" },
	          body: JSON.stringify({
	            name,
	            source,
	            ...(selectedOrder ? { promptOrderCharacterId: selectedOrder.characterId } : {})
	          })
	        });
	        const body = await response.json();
	        if (!response.ok) throw new Error(body.error || "见面模式预设导入失败");
	        const importedId = body.preset?.id || "";
	        resetMeetingPresetImport();
	        await loadMeetingPresetCatalog(importedId, true);
	        nodes.meetingPresetState.textContent = "已导入";
	        setStatus("见面模式预设已导入");
	      } catch (error) {
	        nodes.meetingPresetImportState.textContent = error.message || String(error);
	        setStatus(error.message || String(error), true);
	      } finally {
	        nodes.selectMeetingPresetImportBtn.disabled = false;
	        nodes.importMeetingPresetBtn.disabled = !state.meetingPresetImportSource ||
	          !nodes.meetingPresetImportName.value.trim();
	      }
	    }

	    function resetMeetingPresetImport() {
	      state.meetingPresetImportFile = null;
	      state.meetingPresetImportSource = null;
	      state.meetingPresetImportOrderOptions = [];
	      nodes.meetingPresetImportInput.value = "";
	      nodes.meetingPresetImportPanel.hidden = true;
	      nodes.meetingPresetImportFileName.textContent = "";
	      nodes.meetingPresetImportSummary.textContent = "";
	      nodes.meetingPresetImportName.value = "";
	      nodes.meetingPresetImportOrder.innerHTML = "";
	      nodes.meetingPresetImportState.textContent = "";
	      nodes.importMeetingPresetBtn.disabled = true;
	    }

	    async function loadWorkspaceFiles() {
      nodes.workspaceFileState.textContent = "加载中...";
      try {
        const query = encodeURIComponent(state.workspaceFileDirectory || ".");
        const response = await fetch("/api/v1/workspace/files?path=" + query);
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "文件列表加载失败");
        state.workspaceFileDirectory = body.path === "." ? "" : body.path;
        state.workspaceFiles = Array.isArray(body.entries) ? body.entries : [];
        nodes.workspaceFilePath.textContent = "/" + state.workspaceFileDirectory;
        nodes.workspaceFileUpBtn.disabled = !state.workspaceFileDirectory;
        nodes.workspaceFileState.textContent = state.workspaceFiles.length + " 项";
        renderWorkspaceFiles();
      } catch (error) {
        nodes.workspaceFileState.textContent = error.message || String(error);
        nodes.workspaceFileList.innerHTML = '<div class="workspace-file-empty error">' + escapeHtml(error.message || String(error)) + '</div>';
      }
    }

    function renderWorkspaceFiles() {
      if (!state.workspaceFiles.length) {
        nodes.workspaceFileList.innerHTML = '<div class="workspace-file-empty">文件夹为空</div>';
        return;
      }
      nodes.workspaceFileList.innerHTML = state.workspaceFiles.map((entry) => {
        const directory = entry.kind === "directory";
        const icon = directory ? "folder" : workspaceFileIcon(entry);
        const primaryAction = directory ? "open" : "preview";
        const actions = directory ? "" :
          '<button class="secondary icon-button" type="button" data-file-action="preview" data-file-path="' + escapeHtml(entry.path) + '" title="预览" aria-label="预览 ' + escapeHtml(entry.name) + '"><i data-lucide="eye" aria-hidden="true"></i></button>' +
          '<button class="secondary icon-button" type="button" data-file-action="download" data-file-path="' + escapeHtml(entry.path) + '" title="下载" aria-label="下载 ' + escapeHtml(entry.name) + '"><i data-lucide="download" aria-hidden="true"></i></button>';
        return '<div class="workspace-file-row">' +
          '<span class="workspace-file-icon"><i data-lucide="' + icon + '" aria-hidden="true"></i></span>' +
          '<button class="workspace-file-name" type="button" data-file-action="' + primaryAction + '" data-file-path="' + escapeHtml(entry.path) + '">' + escapeHtml(entry.name) + '</button>' +
          '<span class="workspace-file-meta">' + escapeHtml(directory ? "文件夹" : formatFileSize(entry.size)) + ' · ' + escapeHtml(formatTraceTime(entry.updatedAt)) + '</span>' +
          '<span class="workspace-file-row-actions">' + actions +
            '<button class="secondary icon-button" type="button" data-file-action="move" data-file-path="' + escapeHtml(entry.path) + '" title="移动或重命名" aria-label="移动 ' + escapeHtml(entry.name) + '"><i data-lucide="folder-input" aria-hidden="true"></i></button>' +
            '<button class="secondary icon-button" type="button" data-file-action="delete" data-file-path="' + escapeHtml(entry.path) + '" title="删除" aria-label="删除 ' + escapeHtml(entry.name) + '"><i data-lucide="trash-2" aria-hidden="true"></i></button>' +
          '</span></div>';
      }).join("");
      refreshIcons();
    }

    function workspaceFileIcon(entry) {
      if (entry.previewKind === "image") return "image";
      if (entry.previewKind === "pdf") return "file-text";
      if (entry.previewKind === "text") return "file-code-2";
      return "file";
    }

    function openWorkspaceParentDirectory() {
      const parts = state.workspaceFileDirectory.split("/").filter(Boolean);
      parts.pop();
      state.workspaceFileDirectory = parts.join("/");
      void loadWorkspaceFiles();
    }

    async function uploadWorkspaceManagerFiles() {
      const files = Array.from(nodes.workspaceFileUploadInput.files || []);
      nodes.workspaceFileUploadInput.value = "";
      if (!files.length) return;
      nodes.workspaceFileUploadBtn.disabled = true;
      nodes.workspaceFileState.textContent = "上传中...";
      try {
        await uploadWorkspaceFiles(files, state.workspaceFileDirectory || ".");
        await loadWorkspaceFiles();
        setStatus(files.length + " 个文件已上传");
      } catch (error) {
        nodes.workspaceFileState.textContent = error.message || String(error);
        setStatus(error.message || String(error), true);
      } finally {
        nodes.workspaceFileUploadBtn.disabled = false;
      }
    }

    async function handleWorkspaceFileAction(event) {
      const button = event.target.closest("button[data-file-action]");
      if (!button) return;
      const path = button.dataset.filePath || "";
      const action = button.dataset.fileAction;
      if (action === "open") {
        state.workspaceFileDirectory = path;
        await loadWorkspaceFiles();
        return;
      }
      if (action === "preview") {
        await previewWorkspaceFile(path);
        return;
      }
      if (action === "download") {
        const link = document.createElement("a");
        link.href = workspaceFileContentUrl(path, "attachment");
        link.click();
        return;
      }
      if (action === "move") {
        const moved = await openActionDialog({
          title: "移动或重命名",
          description: "输入 Workspace 内的目标相对路径。",
          fieldLabel: "目标路径",
          value: path,
          selectInput: true,
          confirmLabel: "移动",
          validate: (value) => !value.trim() ? "目标路径不能为空。" : "",
          onConfirm: async (value) => {
            const response = await fetch("/api/v1/workspace/files", {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ from: path, to: value.trim() })
            });
            const body = await response.json();
            if (!response.ok) throw new Error(body.error || "文件移动失败");
          }
        });
        if (moved) await loadWorkspaceFiles();
        return;
      }
      if (action === "delete") {
        const deleted = await openActionDialog({
          title: "删除文件",
          description: "将从 Workspace 永久删除 “" + path + "”。",
          confirmLabel: "删除",
          onConfirm: async () => {
            const response = await fetch("/api/v1/workspace/files", {
              method: "DELETE",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ path })
            });
            const body = await response.json();
            if (!response.ok) throw new Error(body.error || "文件删除失败");
          }
        });
        if (deleted) await loadWorkspaceFiles();
      }
    }

    async function previewWorkspaceFile(path) {
      nodes.workspaceFilePreviewTitle.textContent = path.split("/").pop() || path;
      nodes.workspaceFilePreviewContent.innerHTML = '<div class="workspace-file-empty">加载中...</div>';
      nodes.workspaceFilePreviewDialog.showModal();
      try {
        const response = await fetch("/api/v1/workspace/files/preview?path=" + encodeURIComponent(path));
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "文件预览失败");
        const preview = body.preview || {};
        nodes.workspaceFilePreviewContent.innerHTML = "";
        if (preview.kind === "text") {
          const pre = document.createElement("pre");
          pre.textContent = (preview.content || "") + (preview.truncated ? "\\n\\n[预览已截断]" : "");
          nodes.workspaceFilePreviewContent.append(pre);
        } else if (preview.kind === "image") {
          const image = document.createElement("img");
          image.src = workspaceFileContentUrl(path, "inline");
          image.alt = preview.entry?.name || "文件预览";
          nodes.workspaceFilePreviewContent.append(image);
        } else if (preview.kind === "pdf") {
          const frame = document.createElement("iframe");
          frame.src = workspaceFileContentUrl(path, "inline");
          frame.title = preview.entry?.name || "PDF 预览";
          nodes.workspaceFilePreviewContent.append(frame);
        } else {
          nodes.workspaceFilePreviewContent.innerHTML = '<div class="workspace-file-empty">此文件类型不支持预览，可下载后查看。</div>';
        }
      } catch (error) {
        nodes.workspaceFilePreviewContent.innerHTML = '<div class="workspace-file-empty error">' + escapeHtml(error.message || String(error)) + '</div>';
      }
    }

    function workspaceFileContentUrl(path, disposition) {
      return "/api/v1/workspace/files/content?path=" + encodeURIComponent(path) + "&disposition=" + disposition;
    }

    function isSafeWorkspacePath(value) {
      const path = String(value || "").trim().replaceAll("\\\\", "/");
      if (!path || path.startsWith("/") || path.includes("\\0")) return false;
      const segments = path.split("/");
      return segments.every((segment) => segment && segment !== "." && segment !== "..");
    }

    function workspaceImagePath(source) {
      const value = String(source || "").trim();
      if (!value.toLowerCase().startsWith("workspace:")) return null;
      let path = value.slice("workspace:".length).replace(/^\\/+/, "");
      try { path = decodeURIComponent(path); } catch {}
      return isSafeWorkspacePath(path) ? path : "";
    }

    function handleMessageMediaClick(event) {
      const trigger = event.target.closest("[data-message-image]");
      if (!trigger) return;
      event.preventDefault();
      const path = trigger.dataset.imagePath || "";
      const source = path ? workspaceFileContentUrl(path, "inline") : trigger.dataset.imageSrc || "";
      if (!source) return;
      const name = trigger.dataset.imageName || "图片预览";
      nodes.chatImageTitle.textContent = name;
      nodes.chatImagePreview.alt = name;
      nodes.chatImagePreview.src = source;
      nodes.chatImageDownloadBtn.href = path ? workspaceFileContentUrl(path, "attachment") : source;
      nodes.chatImageDownloadBtn.target = path ? "" : "_blank";
      nodes.chatImageDownloadBtn.rel = path ? "" : "noopener noreferrer";
      if (path) nodes.chatImageDownloadBtn.setAttribute("download", "");
      else nodes.chatImageDownloadBtn.removeAttribute("download");
      nodes.chatImageDialog.showModal();
      refreshIcons();
    }

    function closeChatImagePreview() {
      if (nodes.chatImageDialog.open) nodes.chatImageDialog.close();
      nodes.chatImagePreview.removeAttribute("src");
      nodes.chatImagePreview.alt = "";
      nodes.chatImageDownloadBtn.removeAttribute("href");
    }

    async function uploadWorkspaceFiles(files, directory) {
      const entries = [];
      for (const file of files) {
        if (file.size > 20 * 1024 * 1024) throw new Error(file.name + " 超过 20 MiB 上传限制");
        const query = new URLSearchParams({ directory, name: file.name });
        const response = await fetch("/api/v1/workspace/files/upload?" + query.toString(), {
          method: "POST",
          headers: { "content-type": file.type || "application/octet-stream" },
          body: file
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || (file.name + " 上传失败"));
        entries.push(body.entry);
      }
      return entries;
    }

    function formatFileSize(value) {
      const size = Number(value || 0);
      if (size < 1024) return size + " B";
      if (size < 1024 * 1024) return (size / 1024).toFixed(size < 10 * 1024 ? 1 : 0) + " KiB";
      return (size / 1024 / 1024).toFixed(size < 10 * 1024 * 1024 ? 1 : 0) + " MiB";
    }

    function formatTokenCount(value) {
      const tokens = Math.max(0, Number(value || 0));
      if (tokens < 1_000) return Math.round(tokens) + " tokens";
      if (tokens < 1_000_000) {
        const precision = tokens < 10_000 ? 1 : 0;
        return (tokens / 1_000).toFixed(precision) + "k tokens";
      }
      return (tokens / 1_000_000).toFixed(tokens < 10_000_000 ? 1 : 0) + "m tokens";
    }

    function formatCompactTokenCount(value) {
      return formatTokenCount(value).replace(/ tokens$/u, "");
    }

    async function loadScheduleItems() {
      nodes.scheduleState.textContent = "加载中...";
      if (state.scheduleOwnerType === "character" && !state.scheduleCharacterId) {
        state.scheduleItems = [];
        renderScheduleWorkspace();
        nodes.scheduleState.textContent = "请先选择角色";
        return;
      }
      try {
        const query = new URLSearchParams({ ownerType: state.scheduleOwnerType });
        if (state.scheduleOwnerType === "character") query.set("characterId", state.scheduleCharacterId);
        const response = await fetch("/api/v1/schedule-items?" + query.toString());
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "日程加载失败");
        state.scheduleItems = Array.isArray(body.items) ? body.items : [];
        renderScheduleWorkspace();
      } catch (error) {
        nodes.scheduleState.textContent = error.message || String(error);
        nodes.scheduleList.innerHTML = '<div class="error">' + escapeHtml(error.message || String(error)) + '</div>';
      }
    }

    function setScheduleOwner(ownerType) {
      if (ownerType !== "user" && ownerType !== "character") return;
      state.scheduleOwnerType = ownerType;
      if (ownerType === "character" && !state.scheduleCharacterId) {
        state.scheduleCharacterId = state.selectedCharacterId || state.characters[0]?.id || "";
      }
      renderScheduleScope();
      state.scheduleItems = [];
      renderScheduleWorkspace();
      nodes.scheduleState.textContent = "加载中...";
      void loadScheduleItems();
    }

    function changeScheduleCharacter() {
      state.scheduleCharacterId = nodes.scheduleCharacterSelect.value;
      renderScheduleScope();
      state.scheduleItems = [];
      renderScheduleWorkspace();
      nodes.scheduleState.textContent = "加载中...";
      void loadScheduleItems();
    }

    function renderScheduleCharacterOptions() {
      if (!nodes.scheduleCharacterSelect) return;
      if (state.scheduleCharacterId && !state.characters.some((entry) => entry.id === state.scheduleCharacterId)) {
        state.scheduleCharacterId = "";
      }
      if (!state.scheduleCharacterId) state.scheduleCharacterId = state.selectedCharacterId || state.characters[0]?.id || "";
      nodes.scheduleCharacterSelect.innerHTML = state.characters.length
        ? state.characters.map((character) => '<option value="' + escapeHtml(character.id) + '">' + escapeHtml(character.name) + '</option>').join("")
        : '<option value="">暂无角色</option>';
      nodes.scheduleCharacterSelect.value = state.scheduleCharacterId;
      nodes.scheduleCharacterSelect.disabled = !state.characters.length;
    }

    function renderScheduleScope() {
      renderScheduleCharacterOptions();
      const characterMode = state.scheduleOwnerType === "character";
      const character = state.characters.find((entry) => entry.id === state.scheduleCharacterId);
      nodes.userScheduleTabBtn.classList.toggle("active", !characterMode);
      nodes.characterScheduleTabBtn.classList.toggle("active", characterMode);
      nodes.userScheduleTabBtn.setAttribute("aria-selected", String(!characterMode));
      nodes.characterScheduleTabBtn.setAttribute("aria-selected", String(characterMode));
      nodes.scheduleCharacterField.hidden = !characterMode;
      nodes.scheduleCreateBtn.disabled = characterMode && !character;
      nodes.scheduleScopeSummary.textContent = characterMode
        ? (character ? character.name + "自己的安排，不触发现实通知" : "请先创建并选择角色")
        : "我的现实日程与提醒";
      updateScheduleHeaderContext();
      refreshIcons();
    }

    function setScheduleMobileView(view) {
      if (!["agenda", "calendar", "tasks"].includes(view)) return;
      state.scheduleMobileView = view;
      nodes.schedulePage.dataset.mobileView = view;
      const buttons = [
        [nodes.scheduleAgendaViewBtn, "agenda"],
        [nodes.scheduleCalendarViewBtn, "calendar"],
        [nodes.scheduleTasksViewBtn, "tasks"]
      ];
      buttons.forEach(([button, value]) => {
        button.classList.toggle("active", value === view);
        button.setAttribute("aria-selected", String(value === view));
      });
    }

    function renderScheduleWorkspace() {
      renderScheduleCalendar();
      renderTaskList();
      renderScheduleItems();
      refreshIcons();
    }

    function renderScheduleCalendar() {
      const cursor = new Date(state.calendarCursor.getFullYear(), state.calendarCursor.getMonth(), 1);
      state.calendarCursor = cursor;
      nodes.scheduleMonthLabel.textContent = cursor.toLocaleDateString("zh-CN", { year: "numeric", month: "long" });
      const offset = (cursor.getDay() + 6) % 7;
      const gridStart = new Date(cursor);
      gridStart.setDate(cursor.getDate() - offset);
      const today = localDateKey(new Date());
      const cells = [];
      for (let index = 0; index < 42; index += 1) {
        const date = new Date(gridStart);
        date.setDate(gridStart.getDate() + index);
        const key = localDateKey(date);
        const items = scheduleItemsOnDate(key);
        const labels = items.slice(0, 3).map((item) =>
          '<span class="calendar-event ' + escapeHtml(item.kind) + ' ' + escapeHtml(scheduleItemDisplayState(item)) + '" title="' + escapeHtml(formatCalendarEvent(item)) + '">' + escapeHtml(formatCalendarEvent(item)) + '</span>'
        ).join("");
        const more = items.length > 3 ? '<span class="calendar-more">+' + (items.length - 3) + ' 项</span>' : "";
        const classes = [
          "calendar-day",
          date.getMonth() === cursor.getMonth() ? "" : "outside",
          key === today ? "today" : "",
          key === state.selectedScheduleDate ? "selected" : ""
        ].filter(Boolean).join(" ");
        cells.push('<button class="' + classes + '" type="button" data-date="' + key + '" aria-label="' +
          escapeHtml(date.toLocaleDateString("zh-CN")) + '"><span class="calendar-day-number">' + date.getDate() + '</span>' +
          '<span class="calendar-events">' + labels + more + '</span></button>');
      }
      nodes.scheduleCalendar.innerHTML = cells.join("");
    }

    function renderTaskList() {
      const tasks = state.scheduleItems
        .filter((item) => item.kind === "task" && item.status !== "cancelled")
        .filter((item) => state.taskFilter === "all" || (state.taskFilter === "completed" ? item.status === "completed" : item.status === "scheduled"))
        .sort((left, right) => {
          if (left.status !== right.status) return left.status === "scheduled" ? -1 : 1;
          return String(left.startAt || left.createdAt).localeCompare(String(right.startAt || right.createdAt));
        });
      const pending = state.scheduleItems.filter((item) => item.kind === "task" && item.status === "scheduled").length;
      nodes.taskCount.textContent = pending + " 待办";
      if (!tasks.length) {
        nodes.taskList.innerHTML = '<div class="schedule-empty">当前没有任务</div>';
        return;
      }
      nodes.taskList.innerHTML = tasks.map((item) => {
        const completed = item.status === "completed";
        const time = item.startAt ? formatScheduleTime(item.startAt, item.timezone) : "未设置时间";
        return '<div class="task-item' + (completed ? ' completed' : '') + '">' +
          '<button class="task-check" type="button" data-action="' + (completed ? 'noop' : 'complete') + '" data-id="' + escapeHtml(item.id) + '" title="' + (completed ? '已完成' : '标记完成') + '" aria-label="' + (completed ? '已完成' : '完成任务') + '"><i data-lucide="' + (completed ? 'circle-check-big' : 'circle') + '" aria-hidden="true"></i></button>' +
          '<span class="task-copy"><strong>' + escapeHtml(item.title) + '</strong><span>' + escapeHtml(time) + '</span></span>' +
          '<button class="task-edit" type="button" data-action="edit" data-id="' + escapeHtml(item.id) + '" title="编辑任务" aria-label="编辑任务"><i data-lucide="pencil" aria-hidden="true"></i></button>' +
        '</div>';
      }).join("");
    }

    function renderScheduleItems() {
      const selected = parseLocalDateKey(state.selectedScheduleDate);
      nodes.scheduleAgendaTitle.textContent = selected.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" });
      const selectedItems = scheduleItemsOnDate(state.selectedScheduleDate);
      nodes.scheduleState.textContent = selectedItems.length + " 项";
      if (!selectedItems.length) {
        nodes.scheduleList.innerHTML = '<div class="schedule-empty">这一天没有日程</div>';
        return;
      }
      nodes.scheduleList.innerHTML = selectedItems.map((item) => {
        const occurrences = Array.isArray(item.occurrences) ? item.occurrences : [];
        const occurrence = occurrences.find((entry) => ["scheduled", "processing"].includes(entry.status));
        const notifications = Array.isArray(item.notifications) ? item.notifications : [];
        const notification = notifications.at(-1);
        const displayState = scheduleItemDisplayState(item);
        const time = item.startAt ? formatScheduleTime(item.startAt, item.timezone) : "未设置时间";
        const recurrence = item.recurrenceRule ? " · " + recurrenceLabel(item.recurrenceRule) : "";
        const notes = item.notes ? '<div class="schedule-meta">' + escapeHtml(item.notes) + '</div>' : "";
        const delivery = notification
          ? '<div class="schedule-meta">通知：' + escapeHtml(notificationStatusLabel(notification.status)) +
            (notification.lastError ? ' · ' + escapeHtml(notification.lastError) : '') + '</div>'
          : "";
        const snooze = item.ownerType === "user" && item.kind === "reminder" && occurrence
          ? '<button class="secondary" type="button" data-action="snooze" data-occurrence-id="' + escapeHtml(occurrence.id) + '">稍后 10 分钟</button>'
          : "";
        const retry = notification && notification.status === "failed"
          ? '<button class="secondary" type="button" data-action="retry-notification" data-notification-id="' + escapeHtml(notification.id) + '">重试通知</button>'
          : "";
        const mutable = displayState === "scheduled" || displayState === "failed";
        return '<section class="schedule-row ' + escapeHtml(displayState) + '">' +
          '<div><h3 class="schedule-title">' + escapeHtml(item.title) + '<span class="schedule-status-badge ' + escapeHtml(displayState) + '">' + escapeHtml(scheduleStatusLabel(displayState)) + '</span></h3>' +
          '<div class="schedule-meta">' + escapeHtml(kindLabel(item.kind)) + ' · ' + escapeHtml(time) + escapeHtml(recurrence) + '</div>' +
          notes + delivery + '</div>' +
          '<div class="schedule-actions">' +
          '<button class="secondary" type="button" data-action="edit" data-id="' + escapeHtml(item.id) + '">编辑</button>' +
          (mutable && item.kind !== "reminder" ? '<button class="secondary" type="button" data-action="complete" data-id="' + escapeHtml(item.id) + '">完成</button>' : "") +
          snooze +
          retry +
          (mutable ? '<button class="secondary" type="button" data-action="cancel" data-id="' + escapeHtml(item.id) + '">取消</button>' : "") +
          '</div></section>';
      }).join("");
    }

    function scheduleItemsOnDate(key) {
      return state.scheduleItems.filter((item) => {
        if (item.status === "cancelled") return false;
        if (item.startAt && localDateKey(new Date(item.startAt)) === key) return true;
        return Array.isArray(item.occurrences) && item.occurrences.some((entry) => entry.dueAt && localDateKey(new Date(entry.dueAt)) === key);
      }).sort((left, right) => String(left.startAt || left.createdAt).localeCompare(String(right.startAt || right.createdAt)));
    }

    function scheduleItemDisplayState(item) {
      if (item.status === "cancelled" || item.status === "completed") return item.status;
      const occurrences = Array.isArray(item.occurrences) ? item.occurrences : [];
      const notifications = Array.isArray(item.notifications) ? item.notifications : [];
      if (occurrences.some((entry) => ["scheduled", "processing"].includes(entry.status))) return "scheduled";
      if (notifications.some((entry) => entry.status === "failed") || occurrences.some((entry) => entry.status === "failed")) return "failed";
      if (notifications.some((entry) => entry.status === "delivered") || occurrences.some((entry) => entry.status === "delivered")) return "delivered";
      return "scheduled";
    }

    function scheduleStatusLabel(status) {
      return ({ scheduled: "待进行", delivered: "已送达", completed: "已完成", failed: "通知失败", cancelled: "已取消" })[status] || status;
    }

    function formatCalendarEvent(item) {
      if (!item.startAt || item.allDay) return item.title;
      try {
        const time = new Intl.DateTimeFormat("zh-CN", {
          timeZone: item.timezone,
          hour: "2-digit",
          minute: "2-digit",
          hour12: false
        }).format(new Date(item.startAt));
        return time + " " + item.title;
      } catch {
        return item.title;
      }
    }

    function showTodayInCalendar() {
      const today = new Date();
      state.calendarCursor = new Date(today.getFullYear(), today.getMonth(), 1);
      state.selectedScheduleDate = localDateKey(today);
      renderScheduleWorkspace();
    }

    function moveScheduleMonth(offset) {
      state.calendarCursor = new Date(state.calendarCursor.getFullYear(), state.calendarCursor.getMonth() + offset, 1);
      state.selectedScheduleDate = localDateKey(state.calendarCursor);
      renderScheduleWorkspace();
    }

    function selectCalendarDate(event) {
      const button = event.target.closest("button[data-date]");
      if (!button) return;
      state.selectedScheduleDate = button.dataset.date;
      const selected = parseLocalDateKey(state.selectedScheduleDate);
      state.calendarCursor = new Date(selected.getFullYear(), selected.getMonth(), 1);
      renderScheduleWorkspace();
      if (window.matchMedia("(max-width: 900px)").matches) setScheduleMobileView("agenda");
    }

    function setTaskFilter(filter) {
      state.taskFilter = filter;
      nodes.taskPendingBtn.classList.toggle("active", filter === "pending");
      nodes.taskAllBtn.classList.toggle("active", filter === "all");
      nodes.taskCompletedBtn.classList.toggle("active", filter === "completed");
      renderTaskList();
      refreshIcons();
    }

    function openNewScheduleEditor() {
      if (state.scheduleOwnerType === "character" && !state.scheduleCharacterId) return;
      clearScheduleEditor();
      const selected = parseLocalDateKey(state.selectedScheduleDate);
      const now = new Date();
      selected.setHours(localDateKey(now) === state.selectedScheduleDate ? Math.min(now.getHours() + 1, 23) : 9, 0, 0, 0);
      nodes.scheduleStart.value = isoToLocalInput(selected.toISOString(), false);
      nodes.scheduleEditorDialog.showModal();
      nodes.scheduleTitle.focus();
    }

    async function saveScheduleItem(event) {
      event.preventDefault();
      const payload = {
        kind: nodes.scheduleKind.value,
        title: nodes.scheduleTitle.value.trim(),
        notes: nodes.scheduleNotes.value.trim() || undefined,
        startAt: localInputToIso(nodes.scheduleStart.value, nodes.scheduleAllDay.checked),
        endAt: localInputToIso(nodes.scheduleEnd.value, nodes.scheduleAllDay.checked),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
        allDay: nodes.scheduleAllDay.checked,
        recurrenceRule: nodes.scheduleRecurrence.value || undefined
      };
      if (!state.editingScheduleId) {
        payload.ownerType = state.scheduleOwnerType;
        if (state.scheduleOwnerType === "character") payload.characterId = state.scheduleCharacterId;
      }
      if (!payload.title) return;
      nodes.saveScheduleBtn.disabled = true;
      nodes.scheduleEditorState.textContent = "保存中...";
      try {
        const editing = state.editingScheduleId;
        const response = await fetch(
          editing ? "/api/v1/schedule-items/" + encodeURIComponent(editing) : "/api/v1/schedule-items",
          {
            method: editing ? "PATCH" : "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload)
          }
        );
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "日程保存失败");
        const saved = body.item;
        if (saved?.startAt) {
          const date = new Date(saved.startAt);
          state.selectedScheduleDate = localDateKey(date);
          state.calendarCursor = new Date(date.getFullYear(), date.getMonth(), 1);
        }
        resetScheduleEditor();
        await loadScheduleItems();
        setStatus(editing ? "日程已更新" : "日程已创建");
      } catch (error) {
        nodes.scheduleEditorState.textContent = error.message || String(error);
        setStatus(error.message || String(error), true);
      } finally {
        nodes.saveScheduleBtn.disabled = false;
      }
    }

    async function handleScheduleAction(event) {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      const action = button.dataset.action;
      const id = button.dataset.id;
      if (action === "edit" && id) {
        beginScheduleEdit(id);
        return;
      }
      if (action === "cancel" && id) {
        const item = state.scheduleItems.find((entry) => entry.id === id);
        const confirmed = await openActionDialog({
          title: "取消日程",
          description: "确定取消“" + (item?.title || "这项日程") + "”？取消后将不再触发后续提醒。",
          confirmLabel: "取消日程"
        });
        if (!confirmed) return;
      }
      let url = "";
      let method = "POST";
      let body;
      if (action === "complete" && id) url = "/api/v1/schedule-items/" + encodeURIComponent(id) + "/complete";
      if (action === "cancel" && id) {
        url = "/api/v1/schedule-items/" + encodeURIComponent(id);
        method = "DELETE";
      }
      if (action === "snooze" && button.dataset.occurrenceId) {
        url = "/api/v1/reminder-occurrences/" + encodeURIComponent(button.dataset.occurrenceId) + "/snooze";
        body = JSON.stringify({ minutes: 10 });
      }
      if (action === "retry-notification" && button.dataset.notificationId) {
        url = "/api/v1/notifications/" + encodeURIComponent(button.dataset.notificationId) + "/retry";
      }
      if (!url) return;
      try {
        const response = await fetch(url, {
          method,
          headers: body ? { "content-type": "application/json" } : undefined,
          body
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "操作失败");
        await loadScheduleItems();
        setStatus("日程已更新");
      } catch (error) {
        setStatus(error.message || String(error), true);
      }
    }

    function beginScheduleEdit(id) {
      const item = state.scheduleItems.find((entry) => entry.id === id);
      if (!item) return;
      state.editingScheduleId = id;
      nodes.scheduleTitle.value = item.title || "";
      nodes.scheduleKind.value = item.kind;
      nodes.scheduleKind.disabled = true;
      nodes.scheduleAllDay.checked = Boolean(item.allDay);
      updateScheduleEditorFields();
      nodes.scheduleStart.value = isoToLocalInput(item.startAt, item.allDay);
      nodes.scheduleEnd.value = isoToLocalInput(item.endAt, item.allDay);
      nodes.scheduleRecurrence.value = item.recurrenceRule || "";
      nodes.scheduleNotes.value = item.notes || "";
      nodes.saveScheduleBtn.textContent = "保存修改";
      nodes.scheduleEditorTitle.textContent = "编辑日程";
      nodes.scheduleEditorScope.textContent = state.scheduleOwnerType === "character" ? "角色日程 · 不触发现实通知" : "用户日程 · 可触发现实通知";
      nodes.scheduleEditorState.textContent = "";
      nodes.scheduleEditorDialog.showModal();
      nodes.scheduleTitle.focus();
    }

    function resetScheduleEditor() {
      clearScheduleEditor();
      if (nodes.scheduleEditorDialog.open) nodes.scheduleEditorDialog.close();
    }

    function clearScheduleEditor() {
      state.editingScheduleId = null;
      nodes.scheduleForm.reset();
      nodes.scheduleKind.disabled = false;
      const characterMode = state.scheduleOwnerType === "character";
      const reminderOption = nodes.scheduleKind.querySelector('option[value="reminder"]');
      reminderOption.disabled = characterMode;
      nodes.scheduleKind.value = characterMode ? "event" : "reminder";
      nodes.saveScheduleBtn.textContent = "创建日程";
      nodes.scheduleEditorTitle.textContent = "新建日程";
      const character = state.characters.find((entry) => entry.id === state.scheduleCharacterId);
      nodes.scheduleEditorScope.textContent = characterMode
        ? (character?.name || "角色") + "的日程 · 不触发现实通知"
        : "用户日程 · 可触发现实通知";
      nodes.scheduleEditorState.textContent = "";
      updateScheduleEditorFields();
    }

    function updateScheduleEditorFields() {
      const allDay = nodes.scheduleAllDay.checked;
      for (const input of [nodes.scheduleStart, nodes.scheduleEnd]) {
        const value = input.value;
        input.type = allDay ? "date" : "datetime-local";
        if (allDay && value) input.value = value.slice(0, 10);
        if (!allDay && value && value.length === 10) input.value = value + "T09:00";
      }
      nodes.scheduleEndField.hidden = nodes.scheduleKind.value !== "event";
      nodes.scheduleForm.classList.toggle("without-end", nodes.scheduleEndField.hidden);
      if (nodes.scheduleEndField.hidden) nodes.scheduleEnd.value = "";
    }

	    async function initializeChat() {
	      await Promise.all([
	        loadModelProfiles(),
	        loadMeetingPresetCatalog("", false),
	        loadUserAvatarState()
	      ]);
	      await loadCharacters();
      await loadSessions();
      await pollIncomingMessages();
    }

    async function refreshConversationMetadata() {
      const [response, worldResponse, channelResponse] = await Promise.all([
        fetch("/api/v1/sessions"),
        fetch("/api/v1/world-conversations"),
        fetch("/api/v1/character-channels")
      ]);
      const [body, worldBody, channelBody] = await Promise.all([
        response.json(),
        worldResponse.json(),
        channelResponse.json()
      ]);
      if (!response.ok) throw new Error(body.error || "会话状态刷新失败");
      if (!worldResponse.ok) throw new Error(worldBody.error || "世界会话状态刷新失败");
      if (!channelResponse.ok) throw new Error(channelBody.error || "角色通信状态刷新失败");
      state.sessions = Array.isArray(body.sessions)
        ? body.sessions.slice().sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))
        : [];
      state.worldConversations = Array.isArray(worldBody.conversations)
        ? worldBody.conversations.slice().sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))
        : [];
      state.characterChannels = Array.isArray(channelBody.channels) ? channelBody.channels : [];
      state.worlds = state.worldConversations.map((entry) => entry.world).filter(Boolean);
      renderWorldOptions();
      renderSessionOptions();
      renderConversationList();
      renderCharacterCards();
    }

    async function pollIncomingMessages() {
      try {
        const previousCounts = new Map(state.unreadConversations.map((entry) => [entry.sessionId, Number(entry.unreadCount || 0)]));
        const previousProactive = new Set(state.unreadProactiveMessages.map((message) => message.id));
        const previousWorldCounts = new Map(state.worldConversations.map((entry) => [entry.worldId, Number(entry.unreadCount || 0)]));
        const previousChannelCounts = new Map(state.characterChannels.map((entry) => [entry.id, Number(entry.unreadCount || 0)]));
        const [unreadResponse, proactiveResponse, worldResponse, channelResponse] = await Promise.all([
          fetch("/api/v1/conversation-unread"),
          fetch("/api/v1/proactive-messages?unreadOnly=1&limit=100"),
          fetch("/api/v1/world-conversations"),
          fetch("/api/v1/character-channels")
        ]);
        const [unreadBody, proactiveBody, worldBody, channelBody] = await Promise.all([
          unreadResponse.json(),
          proactiveResponse.json(),
          worldResponse.json(),
          channelResponse.json()
        ]);
        if (!unreadResponse.ok) throw new Error(unreadBody.error || "未读消息状态加载失败");
        if (!proactiveResponse.ok) throw new Error(proactiveBody.error || "主动消息状态加载失败");
        if (!worldResponse.ok) throw new Error(worldBody.error || "世界未读状态加载失败");
        if (!channelResponse.ok) throw new Error(channelBody.error || "角色通信状态加载失败");
        state.unreadConversations = Array.isArray(unreadBody.conversations) ? unreadBody.conversations : [];
        state.unreadProactiveMessages = Array.isArray(proactiveBody.messages) ? proactiveBody.messages : [];
        state.worldConversations = Array.isArray(worldBody.conversations) ? worldBody.conversations : [];
        state.characterChannels = Array.isArray(channelBody.channels) ? channelBody.channels : [];
        state.worlds = state.worldConversations.map((entry) => entry.world).filter(Boolean);
        const addedConversations = state.unreadConversations.filter((entry) =>
          Number(entry.unreadCount || 0) > Number(previousCounts.get(entry.sessionId) || 0));
        const addedProactive = state.unreadProactiveMessages.filter((message) => !previousProactive.has(message.id));
        const addedWorlds = state.worldConversations.filter((entry) =>
          Number(entry.unreadCount || 0) > Number(previousWorldCounts.get(entry.worldId) || 0));
        const addedChannels = state.characterChannels.filter((entry) =>
          Number(entry.unreadCount || 0) > Number(previousChannelCounts.get(entry.id) || 0));
        if (addedConversations.length || addedProactive.length || addedWorlds.length || addedChannels.length) {
          await refreshConversationMetadata();
          if (nodes.characterChannelDialog.open && state.activeCharacterChannelId &&
              addedChannels.some((entry) => entry.id === state.activeCharacterChannelId)) {
            await openCharacterChannel(state.activeCharacterChannelId, true);
          } else if (isWorldConversationVisible(state.activeWorldId) && worldConversationUnreadCount(state.activeWorldId) > 0) {
            await refreshWorldMessages(true);
            await markWorldConversationRead(state.activeWorldId);
          } else if (isConversationVisible(state.activeSessionId) && conversationUnreadCount(state.activeSessionId) > 0) {
            await refreshSessionMessages(true);
            await markConversationRead(state.activeSessionId);
          } else {
            const latest = [...addedConversations, ...addedProactive, ...addedWorlds, ...addedChannels]
              .sort((left, right) => String(right.lastUnreadAt || right.deliveredAt || right.updatedAt || "")
                .localeCompare(String(left.lastUnreadAt || left.deliveredAt || left.updatedAt || "")))[0];
            const worldConversation = state.worldConversations.find((entry) => entry.worldId === latest?.worldId);
            const characterChannel = state.characterChannels.find((entry) => entry.id === latest?.id);
            const character = state.characters.find((entry) => entry.id === latest?.characterId) ||
              state.characters.find((entry) => entry.id === state.sessions.find((session) => session.id === latest?.sessionId)?.characterId);
            setStatus(characterChannel
              ? characterChannel.characterNames.join(" 与 ") + " 有了新消息"
              : worldConversation
              ? (worldConversation.world?.name || "世界") + " 有了新进展"
              : (character?.name || "角色") + " 发来一条新消息");
          }
        } else {
          renderConversationList();
        }
      } catch {
        // Background polling must not replace the current UI status with a transient network error.
      }
    }

    function isConversationVisible(sessionId) {
      return Boolean(sessionId) && state.uiMode === "normal" && state.activeConversationKind === "direct" &&
        state.activeSessionId === sessionId && !state.sessionDraft && document.visibilityState === "visible" &&
        document.hasFocus();
    }

    function isWorldConversationVisible(worldId) {
      return Boolean(worldId) && state.uiMode === "normal" && state.activeConversationKind === "world" &&
        state.activeWorldId === worldId && document.visibilityState === "visible" && document.hasFocus();
    }

    function worldConversationUnreadCount(worldId) {
      return Number(state.worldConversations.find((entry) => entry.worldId === worldId)?.unreadCount || 0);
    }

    function conversationUnreadCount(sessionId) {
      const generic = Number(state.unreadConversations.find((entry) => entry.sessionId === sessionId)?.unreadCount || 0);
      const sessionCount = Number(state.sessions.find((entry) => entry.id === sessionId)?.unreadCount || 0);
      const proactive = state.unreadProactiveMessages.filter((message) => message.sessionId === sessionId).length;
      return Math.max(generic, sessionCount, proactive);
    }

    async function markConversationRead(sessionId) {
      if (!sessionId) return;
      const response = await fetch("/api/v1/sessions/" + encodeURIComponent(sessionId) + "/read", { method: "POST" });
      if (!response.ok) return;
      state.unreadConversations = state.unreadConversations.filter((entry) => entry.sessionId !== sessionId);
      state.unreadProactiveMessages = state.unreadProactiveMessages.filter((message) => message.sessionId !== sessionId);
      const session = state.sessions.find((entry) => entry.id === sessionId);
      if (session) session.unreadCount = 0;
      renderConversationList();
    }

    async function markWorldConversationRead(worldId) {
      if (!worldId) return;
      const response = await fetch("/api/v1/worlds/" + encodeURIComponent(worldId) + "/conversation/read", { method: "POST" });
      if (!response.ok) return;
      const conversation = state.worldConversations.find((entry) => entry.worldId === worldId);
      if (conversation) conversation.unreadCount = 0;
      renderConversationList();
    }

    async function acknowledgeVisibleConversation() {
      if (isWorldConversationVisible(state.activeWorldId)) {
        const worldId = state.activeWorldId;
        await refreshWorldMessages(true);
        if (isWorldConversationVisible(worldId)) await markWorldConversationRead(worldId);
        return;
      }
      const sessionId = state.activeSessionId;
      if (!isConversationVisible(sessionId)) return;
      await refreshSessionMessages(true);
      if (!isConversationVisible(sessionId)) return;
      await markConversationRead(sessionId);
      void refreshConversationMetadata();
    }

    async function loadSessions() {
      try {
        const [response, worldResponse, channelResponse] = await Promise.all([
          fetch("/api/v1/sessions"),
          fetch("/api/v1/world-conversations"),
          fetch("/api/v1/character-channels")
        ]);
        const [body, worldBody, channelBody] = await Promise.all([
          response.json(),
          worldResponse.json(),
          channelResponse.json()
        ]);
        if (!response.ok) throw new Error(body.error || "会话加载失败");
        if (!worldResponse.ok) throw new Error(worldBody.error || "世界会话加载失败");
        if (!channelResponse.ok) throw new Error(channelBody.error || "角色通信加载失败");
        state.sessions = Array.isArray(body.sessions)
          ? body.sessions.slice().sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))
          : [];
        state.worldConversations = Array.isArray(worldBody.conversations)
          ? worldBody.conversations.slice().sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))
          : [];
        state.characterChannels = Array.isArray(channelBody.channels) ? channelBody.channels : [];
        state.worlds = state.worldConversations.map((entry) => entry.world).filter(Boolean);
        renderWorldOptions();
        renderConversationList();
        renderCharacterCards();
        const currentWorld = state.worldConversations.find((entry) => entry.worldId === state.activeWorldId);
        if (state.activeConversationKind === "world" && currentWorld) {
          await applyWorldConversation(currentWorld);
          return;
        }
        const current = state.sessions.find((entry) => entry.id === state.activeSessionId);
        if (current) {
          await applySession(current);
          return;
        }
        const recentBound = state.sessions.find((entry) => entry.characterId);
        const recentWorld = state.worldConversations.find((entry) => Number(entry.messageCount || 0) > 0);
        if (recentWorld && (!recentBound || String(recentWorld.updatedAt) > String(recentBound.updatedAt))) {
          await applyWorldConversation(recentWorld);
          return;
        }
        if (recentBound) {
          await applySession(recentBound);
          return;
        }
        if (state.worldConversations[0]) {
          await applyWorldConversation(state.worldConversations[0]);
          return;
        }
        startNewSession();
      } catch (error) {
        setStatus(error.message || String(error), true);
        if (!state.activeSessionId) startNewSession();
      }
    }

    function startNewSession() {
      if (state.busy) return;
      closePrivateInboxEvents();
      state.activeConversationKind = "direct";
      state.activeGroupId = "";
      state.activeWorldId = "";
      state.activeSessionId = generateSessionId();
      state.sessionDraft = true;
      state.messages = [];
      state.privateInboxMessages = [];
      state.privateInboxRunning = false;
      state.contextBudget = null;
      state.characterLiveState = null;
      updateContextBudgetChrome();
      clearInteractionState();
      state.lastTurnStatus = null;
      state.lastTurnCanRetry = false;
      updateRetryState();
      setSessionControlsLocked(false);
      nodes.attachFileBtn.disabled = false;
      renderSessionOptions();
      setConversationListOpen(false);
      renderConversationList();
      updateSessionActionState();
      updateChatIdentity();
      clearConversationScene();
      setStatus(state.selectedCharacterId ? "新会话已准备" : "点击会话列表中的 + 开始新对话");
    }

    let newConversationOpener = null;

    function openNewConversationDialog() {
      if (nodes.newConversationDialog.open) return;
      if (state.busy) {
        setStatus("当前消息仍在生成，结束后再新建对话", true);
        return;
      }
      newConversationOpener = document.activeElement;
      const options = state.characters.map((character) =>
        '<option value="' + escapeHtml(character.id) + '">' + escapeHtml(character.name) + '</option>'
      ).join("");
      nodes.newConversationCharacter.innerHTML = '<option value="">请选择角色</option>' + options;
      const preferredCharacter = [state.newConversationPreferredCharacterId, state.selectedCharacterId]
        .find((id) => id && state.characters.some((entry) => entry.id === id)) || state.characters[0]?.id || "";
      nodes.newConversationCharacter.value = preferredCharacter;
      nodes.newConversationWorld.innerHTML = '<option value="">请选择世界</option>' + state.worldConversations.map((conversation) =>
        '<option value="' + escapeHtml(conversation.worldId) + '">' + escapeHtml(conversation.world?.name || "未命名世界") + '</option>'
      ).join("");
      nodes.newConversationWorld.value = state.activeWorldId && state.worldConversations.some((entry) => entry.worldId === state.activeWorldId)
        ? state.activeWorldId
        : state.worldConversations[0]?.worldId || "";
      nodes.newConversationError.textContent = state.characters.length ? "" : "请先在角色页创建角色。";
      setNewConversationKind("direct");
      nodes.newConversationDialog.showModal();
      refreshIcons();
      requestAnimationFrame(() => nodes.newConversationCharacter.focus());
    }

    function closeNewConversationDialog() {
      if (nodes.newConversationDialog.open) nodes.newConversationDialog.close();
      const opener = newConversationOpener;
      newConversationOpener = null;
      opener?.focus?.();
    }

    function setNewConversationKind(kind) {
      state.newConversationKind = kind === "world" ? "world" : "direct";
      const world = state.newConversationKind === "world";
      nodes.newConversationDirectBtn.classList.toggle("active", !world);
      nodes.newConversationGroupBtn.classList.toggle("active", world);
      nodes.newConversationCharacterField.hidden = world;
      nodes.newConversationGroupFields.hidden = !world;
      updateNewConversationSubmit();
    }

    function updateNewConversationSubmit() {
      if (state.newConversationKind === "world") {
        nodes.createConversationBtn.textContent = "进入世界";
        nodes.createConversationBtn.disabled = !nodes.newConversationWorld.value;
        nodes.newConversationError.textContent = state.worldConversations.length
          ? ""
          : "请先在角色页的生活分页中创建共享世界。";
        return;
      }
      nodes.createConversationBtn.textContent = "打开私聊";
      nodes.createConversationBtn.disabled = !nodes.newConversationCharacter.value;
      nodes.newConversationError.textContent = state.characters.length ? "" : "请先在角色页创建角色。";
    }

    async function createNewConversation(event) {
      event.preventDefault();
      if (state.newConversationKind === "world") {
        const worldId = nodes.newConversationWorld.value;
        const conversation = state.worldConversations.find((entry) => entry.worldId === worldId);
        if (!conversation) {
          nodes.newConversationError.textContent = "请选择世界。";
          return;
        }
        closeNewConversationDialog();
        await applyWorldConversation(conversation);
        requestAnimationFrame(() => nodes.textInput.focus());
        return;
      }
      const characterId = nodes.newConversationCharacter.value;
      if (!characterId) {
        nodes.newConversationError.textContent = "请选择角色。";
        return;
      }
      state.selectedCharacterId = characterId;
      state.newConversationPreferredCharacterId = "";
      nodes.chatCharacterSelect.value = characterId;
      nodes.modeSelect.value = "sms";
      nodes.createConversationBtn.disabled = true;
      try {
        const response = await fetch("/api/v1/direct-conversations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ characterId })
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "私聊打开失败");
        await refreshConversationMetadata();
        const session = state.sessions.find((entry) => entry.id === body.session?.id);
        if (!session) throw new Error("私聊会话未出现在会话列表中");
        closeNewConversationDialog();
        await applySession(session);
        requestAnimationFrame(() => nodes.textInput.focus());
      } catch (error) {
        nodes.newConversationError.textContent = error.message || String(error);
        nodes.createConversationBtn.disabled = false;
      }
    }

    async function selectSession() {
      const session = state.sessions.find((entry) => entry.id === nodes.sessionSelect.value);
      if (!session) return;
      await applySession(session);
    }

    async function applySession(session) {
      const changedSession = state.activeSessionId !== session.id || state.activeConversationKind !== "direct";
      if (changedSession) closePrivateInboxEvents();
      state.activeConversationKind = "direct";
      state.activeGroupId = "";
      state.activeWorldId = "";
      state.activeSessionId = session.id;
      state.sessionDraft = false;
      if (changedSession) {
        state.contextBudget = null;
        state.characterLiveState = null;
      }
      state.lastTurnStatus = session.lastTurnStatus || null;
      state.lastTurnCanRetry = Boolean(session.lastTurnCanRetry);
      updateRetryState();
      nodes.modeSelect.value = "sms";
      state.selectedCharacterId = session.characterId || "";
      state.interactionState = session.interactionPresence ? {
        presence: session.interactionPresence,
        location: session.interactionLocation || "",
        continuity: "canonical",
        lens: session.interactionPresence === "co_present" ? "observable_scene" : "message"
      } : null;
      nodes.chatCharacterSelect.value = state.selectedCharacterId;
      setSessionControlsLocked(true);
      nodes.attachFileBtn.disabled = false;
      renderSessionOptions();
      updateSessionActionState();
      updateChatIdentity();
      setConversationListOpen(false);
      renderConversationList();
      if (session.characterId) openPrivateInboxEvents(session.id);
      await refreshSessionMessages(false);
      if (isConversationVisible(session.id)) await markConversationRead(session.id);
      await loadConversationScene();
      if (!session.characterId) {
        setStatus("这是未绑定角色的旧会话，仅供查看；请新建会话后继续。", true);
      }
    }

    async function applyWorldConversation(conversation) {
      closePrivateInboxEvents();
      state.activeConversationKind = "world";
      state.activeWorldId = conversation.worldId;
      state.activeGroupId = "";
      state.activeSessionId = "";
      state.sessionDraft = false;
      state.selectedCharacterId = "";
      state.privateInboxMessages = [];
      state.privateInboxRunning = false;
      state.contextBudget = null;
      state.characterLiveState = null;
      state.lastTurnStatus = null;
      state.lastTurnCanRetry = false;
      nodes.modeSelect.value = "sms";
      nodes.chatCharacterSelect.value = "";
      nodes.attachFileBtn.disabled = false;
      state.pendingAttachments = [];
      renderAttachmentQueue();
      clearInteractionState();
      updateContextBudgetChrome();
      setSessionControlsLocked(true);
      renderSessionOptions();
      updateRetryState();
      updateSessionActionState();
      updateChatIdentity();
      setConversationListOpen(false);
      renderConversationList();
      clearConversationScene();
      await refreshWorldMessages(false);
      if (isWorldConversationVisible(conversation.worldId)) await markWorldConversationRead(conversation.worldId);
    }

    async function refreshWorldMessages(silent) {
      if (state.activeConversationKind !== "world" || !state.activeWorldId) return;
      const requestedWorldId = state.activeWorldId;
      if (!silent) setStatus("加载世界时间线...");
      try {
        const [messageResponse, conversationResponse] = await Promise.all([
          fetch("/api/v1/worlds/" + encodeURIComponent(requestedWorldId) + "/conversation/messages"),
          fetch("/api/v1/worlds/" + encodeURIComponent(requestedWorldId) + "/conversation")
        ]);
        const [messageBody, conversationBody] = await Promise.all([
          messageResponse.json(),
          conversationResponse.json()
        ]);
        if (!messageResponse.ok) throw new Error(messageBody.error || "世界时间线加载失败");
        if (!conversationResponse.ok) throw new Error(conversationBody.error || "世界状态加载失败");
        if (state.activeConversationKind !== "world" || state.activeWorldId !== requestedWorldId) return;
        const detail = conversationBody.conversation;
        const index = state.worldConversations.findIndex((entry) => entry.worldId === requestedWorldId);
        if (detail && index >= 0) state.worldConversations[index] = { ...state.worldConversations[index], ...detail };
        state.messages = (messageBody.messages || []).map(normalizeWorldMessage).filter(Boolean);
        updateChatIdentity();
        renderMessages();
        if (!silent) setStatus("就绪");
      } catch (error) {
        if (!silent) setStatus(error.message || String(error), true);
      }
    }

    function normalizeWorldMessage(message) {
      if (!message || typeof message !== "object") return null;
      const role = message.senderType === "user"
        ? "user"
        : message.senderType === "system" ? "system" : "assistant";
      return {
        role,
        text: message.content || "",
        senderId: message.senderId || "",
        worldTurnId: message.turnId || "",
        worldNarration: message.senderType === "director",
        worldMessageId: message.id,
        attachments: Array.isArray(message.attachments) ? message.attachments : [],
        timestampMs: message.createdAt ? new Date(message.createdAt).getTime() : 0,
        at: message.createdAt
          ? new Date(message.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
          : ""
      };
    }

    async function applyGroupChat(group) {
      closePrivateInboxEvents();
      state.activeConversationKind = "group";
      state.activeGroupId = group.id;
      state.activeSessionId = "";
      state.sessionDraft = false;
      state.selectedCharacterId = "";
      state.privateInboxMessages = [];
      state.privateInboxRunning = false;
      state.contextBudget = null;
      state.characterLiveState = null;
      updateContextBudgetChrome();
      clearInteractionState();
      state.lastTurnStatus = null;
      state.lastTurnCanRetry = false;
      nodes.modeSelect.value = group.mode === "rp" ? "rp" : "sms";
      nodes.chatCharacterSelect.value = "";
      nodes.attachFileBtn.disabled = true;
      state.pendingAttachments = [];
      renderAttachmentQueue();
      setSessionControlsLocked(true);
      updateRetryState();
      updateSessionActionState();
      updateChatIdentity();
      setConversationListOpen(false);
      renderConversationList();
      clearConversationScene();
      await refreshGroupMessages(false);
    }

    async function refreshGroupMessages(silent) {
      if (state.activeConversationKind !== "group" || !state.activeGroupId) return;
      if (!silent) setStatus("加载群聊...");
      try {
        const response = await fetch("/api/v1/group-chats/" + encodeURIComponent(state.activeGroupId) + "/messages");
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "群聊消息加载失败");
        state.messages = (body.messages || []).map((message) => ({
          role: message.senderType === "user" ? "user" : message.senderType === "character" ? "assistant" : "system",
          text: message.content || "",
          senderId: message.senderId || "",
          groupMessageId: message.id,
          at: message.createdAt ? new Date(message.createdAt).toLocaleTimeString() : ""
        }));
        renderMessages();
        if (!silent) setStatus("就绪");
      } catch (error) {
        if (!silent) setStatus(error.message || String(error), true);
      }
    }

    function renderSessionOptions() {
      const draft = state.sessionDraft
        ? '<option value="' + escapeHtml(state.activeSessionId) + '">新会话（未保存）</option>'
        : "";
      const options = state.sessions.map((session) =>
        '<option value="' + escapeHtml(session.id) + '">' + escapeHtml(sessionLabel(session)) + '</option>'
      ).join("");
      nodes.sessionSelect.innerHTML = draft + options || '<option value="">暂无会话</option>';
      nodes.sessionSelect.value = state.activeSessionId;
    }

    function sessionLabel(session) {
      const character = state.characters.find((entry) => entry.id === session.characterId);
      const identity = character?.name || "未绑定角色";
      const date = new Date(session.updatedAt || session.createdAt || 0);
      const time = Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
      });
      return [identity, session.title && session.title !== identity ? session.title : "", time].filter(Boolean).join(" · ");
    }

    function renderConversationList() {
      if (!nodes.conversationList) return;
      const availableSessionIds = new Set(state.sessions.map((session) => session.id));
      state.selectedSessionIds = new Set([...state.selectedSessionIds].filter((sessionId) => availableSessionIds.has(sessionId)));
      if (!state.sessions.length && !state.worldConversations.length) {
        nodes.conversationList.innerHTML = '<div class="conversation-list-empty">点击右上角 + 开始新对话</div>';
        updateConversationBatchControls();
        return;
      }
      nodes.conversationList.innerHTML = renderWorldConversationSection() + renderRoleConversationSection();
      updateConversationBatchControls();
      refreshIcons();
    }

    function renderWorldConversationSection() {
      if (!state.worldConversations.length) return "";
      const sectionKey = "__worlds__";
      const collapsed = state.collapsedConversationGroups.has(sectionKey);
      const unreadCount = state.worldConversations.reduce((total, entry) => total + Number(entry.unreadCount || 0), 0) +
        state.characterChannels.reduce((total, entry) => total + Number(entry.unreadCount || 0), 0);
      const items = state.worldConversations.map((conversation) => {
        const active = state.activeConversationKind === "world" && conversation.worldId === state.activeWorldId;
        const date = new Date(conversation.updatedAt || conversation.createdAt || 0);
        const time = Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
        const members = (conversation.characterIds || []).map((id) => state.characters.find((entry) => entry.id === id)).filter(Boolean);
        const event = conversation.activeEvent;
        const preview = event
          ? (event.status === "planned" ? "待开始 · " : "进行中 · ") + event.title
          : conversation.preview || members.length + " 位角色";
        const content = worldAvatarCluster(conversation, "compact") +
          '<span class="conversation-copy"><span class="conversation-line"><strong>' + escapeHtml(conversation.world?.name || "未命名世界") + '</strong>' +
          conversationUnreadBadge(Number(conversation.unreadCount || 0), "世界未读消息") + '<span class="conversation-time">' + escapeHtml(time) + '</span></span>' +
          '<span class="conversation-preview">' + escapeHtml(preview) + '</span></span>';
        const worldItem = state.conversationBatchMode
          ? '<div class="conversation-item batch-disabled' + (active ? ' active' : '') + '">' + content + '</div>'
          : '<button class="conversation-item' + (active ? ' active' : '') + '" type="button" data-world-id="' + escapeHtml(conversation.worldId) + '">' + content + '</button>';
        if (state.conversationBatchMode) return worldItem;
        const channels = state.characterChannels
          .filter((channel) => channel.worldId === conversation.worldId)
          .map(renderCharacterChannelItem)
          .join("");
        return worldItem + channels;
      }).join("");
      const head = '<button class="conversation-group-head" type="button" data-conversation-group-toggle="' + sectionKey + '" aria-expanded="' + String(!collapsed) + '">' +
        '<span class="conversation-group-avatar"><i data-lucide="globe-2" aria-hidden="true"></i></span>' +
        '<span class="conversation-group-copy"><span class="conversation-group-title"><strong>世界</strong>' +
        conversationUnreadBadge(unreadCount, "世界未读消息") + '</span><span>' + state.worldConversations.length + ' 个世界 · ' +
        state.characterChannels.length + ' 个角色通信</span></span>' +
        '<i class="conversation-group-chevron" data-lucide="chevron-down" aria-hidden="true"></i></button>';
      return '<section class="conversation-group' + (collapsed ? ' collapsed' : '') + '" data-conversation-group="' + sectionKey + '">' + head +
        '<div class="conversation-group-sessions"' + (collapsed && !state.conversationBatchMode ? ' hidden' : '') + '>' + items + '</div></section>';
    }

    function renderCharacterChannelItem(channel) {
      const names = Array.isArray(channel.characterNames) ? channel.characterNames : ["角色", "角色"];
      const date = new Date(channel.lastMessageAt || channel.updatedAt || channel.createdAt || 0);
      const time = Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
      const status = ({
        queued: "等待中", running: "交流中", completed: "", declined: "未继续",
        failed: "未完成", cancelled: "已取消"
      })[channel.latestEpisodeStatus] || "";
      const preview = [status, channel.preview || "尚无消息"].filter(Boolean).join(" · ");
      return '<button class="conversation-item character-channel-item" type="button" data-character-channel-id="' +
        escapeHtml(channel.id) + '">' + characterChannelAvatar(channel) +
        '<span class="conversation-copy"><span class="conversation-line"><strong>' +
        escapeHtml(names.join(" 与 ")) + '</strong>' +
        conversationUnreadBadge(Number(channel.unreadCount || 0), "角色通信未读消息") +
        '<span class="conversation-time">' + escapeHtml(time) + '</span></span>' +
        '<span class="conversation-preview">' + escapeHtml(preview) + '</span></span></button>';
    }

    function characterChannelAvatar(channel) {
      const ids = Array.isArray(channel.characterIds) ? channel.characterIds : [];
      const names = Array.isArray(channel.characterNames) ? channel.characterNames : [];
      return '<span class="character-channel-avatar">' + [0, 1].map((index) => {
        const character = state.characters.find((entry) => entry.id === ids[index]);
        const name = character?.name || names[index] || "角色";
        return '<span style="--avatar-hue:' + avatarHue(name) + '">' +
          avatarImageOrInitial(character?.avatarUrl, name) + '</span>';
      }).join("") + '</span>';
    }

    function renderRoleConversationSection() {
      if (!state.sessions.length) return "";
      const sectionKey = "__roles__";
      const collapsed = state.collapsedConversationGroups.has(sectionKey);
      const unreadCount = state.sessions.reduce((total, session) => total + conversationUnreadCount(session.id), 0);
      const allSelected = state.sessions.length > 0 && state.sessions.every((session) => state.selectedSessionIds.has(session.id));
      const head = state.conversationBatchMode
        ? '<label class="conversation-group-head batch"><input type="checkbox" data-role-conversations-select-all aria-label="选择全部角色会话"' + (allSelected ? ' checked' : '') + ' />' +
          '<span class="conversation-group-avatar"><i data-lucide="message-circle" aria-hidden="true"></i></span>' +
          '<span class="conversation-group-copy"><strong>角色</strong><span>' + state.sessions.length + ' 个私聊</span></span></label>'
        : '<button class="conversation-group-head" type="button" data-conversation-group-toggle="' + sectionKey + '" aria-expanded="' + String(!collapsed) + '">' +
          '<span class="conversation-group-avatar"><i data-lucide="message-circle" aria-hidden="true"></i></span>' +
          '<span class="conversation-group-copy"><span class="conversation-group-title"><strong>角色</strong>' +
          conversationUnreadBadge(unreadCount, "角色未读消息") + '</span><span>' + state.sessions.length + ' 个私聊</span></span>' +
          '<i class="conversation-group-chevron" data-lucide="chevron-down" aria-hidden="true"></i></button>';
      const items = state.sessions.map((session) => renderConversationItem(session)).join("");
      return '<section class="conversation-group' + (collapsed ? ' collapsed' : '') + '" data-conversation-group="' + sectionKey + '">' + head +
        '<div class="conversation-group-sessions"' + (collapsed && !state.conversationBatchMode ? ' hidden' : '') + '>' + items + '</div></section>';
    }

    function renderConversationItem(session) {
      const active = session.id === state.activeSessionId;
      const character = state.characters.find((entry) => entry.id === session.characterId);
      const date = new Date(session.updatedAt || session.createdAt || 0);
      const time = date && !Number.isNaN(date.getTime())
        ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
        : "";
      const title = character?.name || session.title || "未绑定角色";
      const lifecycle = session.sleepState === "sleeping"
        ? "休息中"
        : session.sleepState === "tired" ? "有些困了" : "";
      const interaction = session.interactionPresence === "co_present"
        ? "正在一起" + (session.interactionLocation ? " · " + session.interactionLocation : "")
        : session.interactionPresence === "meeting_pending"
          ? "约好见面" + (session.interactionLocation ? " · " + session.interactionLocation : "")
          : "";
      const previewText = session.preview && session.preview !== title ? session.preview : "开始聊天";
      const preview = [interaction, lifecycle, previewText].filter(Boolean).join(" · ");
      const unreadCount = conversationUnreadCount(session.id);
      const unread = conversationUnreadBadge(unreadCount, "未读消息");
      const content = '<span class="conversation-group-avatar compact-role" style="--avatar-hue:' + avatarHue(title) + '">' + avatarImageOrInitial(character?.avatarUrl, title) + '</span>' +
        '<span class="conversation-copy"><span class="conversation-line"><strong>' + escapeHtml(title) + '</strong>' + (session.sleepState === "sleeping" ? '<i data-lucide="moon" aria-label="角色正在休息"></i>' : '') + unread + '<span class="conversation-time">' + escapeHtml(time) + '</span></span>' +
        '<span class="conversation-preview">' + escapeHtml(preview) + '</span></span>';
      if (!state.conversationBatchMode) {
        return '<button class="conversation-item' + (active ? ' active' : '') + '" type="button" data-session-id="' + escapeHtml(session.id) + '"' +
          (session.draft ? ' data-session-draft="true"' : '') + '>' + content + '</button>';
      }
      if (session.draft) {
        return '<div class="conversation-item batch-disabled active" data-session-draft="true">' + content + '</div>';
      }
      return '<label class="conversation-item batch' + (active ? ' active' : '') + '"><input type="checkbox" data-conversation-session-select="' + escapeHtml(session.id) + '" aria-label="选择会话 ' + escapeHtml(title) + '"' +
        (state.selectedSessionIds.has(session.id) ? ' checked' : '') + ' />' + content + '</label>';
    }

    function conversationUnreadBadge(count, label) {
      return count
        ? '<span class="conversation-unread" aria-label="' + escapeHtml(label + "，" + count + " 条") + '">' + Math.min(count, 99) + '</span>'
        : '';
    }

    function updateConversationBatchControls() {
      const selectedCount = state.selectedSessionIds.size;
      const selectableCount = state.sessions.length;
      nodes.conversationListTitle.textContent = state.conversationBatchMode ? "批量管理" : "会话";
      nodes.conversationBatchBar.hidden = !state.conversationBatchMode;
      nodes.sidebarArchivedSessionsBtn.hidden = state.conversationBatchMode;
      nodes.sidebarNewSessionBtn.hidden = state.conversationBatchMode;
      nodes.sidebarBatchManageBtn.disabled = !state.conversationBatchMode && !selectableCount;
      nodes.sidebarBatchManageBtn.innerHTML = '<i data-lucide="' + (state.conversationBatchMode ? "check" : "list-checks") + '" aria-hidden="true"></i>';
      nodes.sidebarBatchManageBtn.title = state.conversationBatchMode ? "完成批量管理" : "批量管理";
      nodes.sidebarBatchManageBtn.setAttribute("aria-label", state.conversationBatchMode ? "完成批量管理" : "批量管理会话");
      nodes.conversationBatchCount.textContent = "已选 " + selectedCount + " 项";
      nodes.conversationBatchSelectAllBtn.textContent = selectableCount > 0 && selectedCount === selectableCount ? "取消全选" : "全选";
      nodes.conversationBatchSelectAllBtn.disabled = !selectableCount;
      nodes.conversationBatchArchiveBtn.disabled = !selectedCount || state.busy;
      nodes.conversationBatchDeleteBtn.disabled = !selectedCount || state.busy;
    }

    function toggleConversationBatchMode() {
      if (state.busy) return;
      state.conversationBatchMode = !state.conversationBatchMode;
      state.selectedSessionIds.clear();
      renderConversationList();
    }

    function toggleAllConversationSelections() {
      if (!state.conversationBatchMode) return;
      const allSelected = state.selectedSessionIds.size === state.sessions.length;
      if (allSelected) {
        state.selectedSessionIds.clear();
      } else {
        state.selectedSessionIds = new Set(state.sessions.map((session) => session.id));
      }
      renderConversationList();
    }

    function updateConversationBatchSelection(event) {
      if (!state.conversationBatchMode) return;
      const allRolesInput = event.target.closest("input[data-role-conversations-select-all]");
      if (allRolesInput) {
        state.sessions.forEach((session) => {
          if (allRolesInput.checked) state.selectedSessionIds.add(session.id);
          else state.selectedSessionIds.delete(session.id);
        });
        renderConversationList();
        return;
      }
      const sessionInput = event.target.closest("input[data-conversation-session-select]");
      if (!sessionInput) return;
      const sessionId = sessionInput.dataset.conversationSessionSelect;
      if (sessionInput.checked) state.selectedSessionIds.add(sessionId);
      else state.selectedSessionIds.delete(sessionId);
      renderConversationList();
    }

    async function runConversationBatchAction(action) {
      const selectedCount = state.selectedSessionIds.size;
      if (state.busy || !state.conversationBatchMode || !selectedCount) return;
      const sessionIds = [...state.selectedSessionIds];
      const deleting = action === "delete";
      const confirmation = "永久删除 " + selectedCount + " 个会话";
      const completed = await openActionDialog({
        title: deleting ? "批量永久删除" : "批量归档",
        description: deleting
          ? "将永久删除选中的 " + selectedCount + " 个会话及其消息、场景和待确认操作。请输入“" + confirmation + "”确认。"
          : "将选中的 " + selectedCount + " 个会话移入归档，之后仍可逐个恢复。",
        fieldLabel: deleting ? "输入确认短语" : undefined,
        value: "",
        confirmLabel: deleting ? "永久删除" : "归档",
        validate: deleting ? (value) => value === confirmation ? "" : "确认短语不匹配，未删除。" : undefined,
        onConfirm: async (value) => {
          const response = await fetch("/api/v1/conversations/batch", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action, sessionIds, groupIds: [], confirmation: deleting ? value : undefined })
          });
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || (deleting ? "批量删除失败" : "批量归档失败"));
        }
      });
      if (!completed) return;
      const activeWasSelected = state.activeConversationKind === "direct" && state.selectedSessionIds.has(state.activeSessionId);
      state.conversationBatchMode = false;
      state.selectedSessionIds.clear();
      if (activeWasSelected) {
        state.activeSessionId = "";
        state.activeGroupId = "";
        state.activeConversationKind = "direct";
        state.sessionDraft = false;
      }
      await loadSessions();
      setStatus(selectedCount + " 个会话已" + (deleting ? "永久删除" : "归档"));
    }

    function avatarHue(value) {
      let hash = 0;
      for (const character of String(value || "角色")) hash = (hash * 31 + character.codePointAt(0)) % 360;
      return [145, 202, 18, 338, 265, 48][hash % 6];
    }

    async function selectConversationFromList(event) {
      const groupToggle = event.target.closest("button[data-conversation-group-toggle]");
      if (groupToggle) {
        const groupKey = groupToggle.dataset.conversationGroupToggle;
        if (state.collapsedConversationGroups.has(groupKey)) state.collapsedConversationGroups.delete(groupKey);
        else state.collapsedConversationGroups.add(groupKey);
        renderConversationList();
        return;
      }
      if (state.conversationBatchMode) return;
      const channelItem = event.target.closest("button[data-character-channel-id]");
      if (channelItem && !state.busy) {
        await openCharacterChannel(channelItem.dataset.characterChannelId);
        return;
      }
      const worldItem = event.target.closest("button[data-world-id]");
      if (worldItem && !state.busy) {
        const conversation = state.worldConversations.find((entry) => entry.worldId === worldItem.dataset.worldId);
        if (conversation) await applyWorldConversation(conversation);
        return;
      }
      const item = event.target.closest("button[data-session-id]");
      if (!item || state.busy) return;
      if (item.dataset.sessionDraft) {
        setConversationListOpen(false);
        nodes.textInput.focus();
        return;
      }
      const session = state.sessions.find((entry) => entry.id === item.dataset.sessionId);
      if (session) {
        await applySession(session);
      }
    }

    function toggleConversationList() {
      setConversationListOpen(!state.conversationListOpen);
    }

    function setConversationListOpen(open) {
      state.conversationListOpen = Boolean(open);
      nodes.chatWorkspace.classList.toggle("list-open", state.conversationListOpen);
      nodes.conversationListToggle.innerHTML = '<i data-lucide="' + (state.conversationListOpen ? "arrow-left" : "chevron-left") + '" aria-hidden="true"></i>';
      nodes.conversationListToggle.setAttribute("aria-label", state.conversationListOpen ? "返回对话" : "会话列表");
      refreshIcons();
    }

    let actionDialogState = null;

    function toggleSessionActionsMenu() {
      const opening = nodes.sessionActionsMenu.hidden;
      nodes.sessionActionsMenu.hidden = !opening;
      nodes.sessionActionsMenuBtn.setAttribute("aria-expanded", String(opening));
      if (opening) {
        const firstEnabled = nodes.sessionActionsMenu.querySelector("button:not(:disabled)");
        firstEnabled?.focus();
      }
    }

    function closeSessionActionsMenu() {
      nodes.sessionActionsMenu.hidden = true;
      nodes.sessionActionsMenuBtn.setAttribute("aria-expanded", "false");
    }

    function closeSessionActionsMenuFromOutside(event) {
      if (!event.target.closest(".mobile-session-actions")) closeSessionActionsMenu();
    }

    function closeSessionActionsMenuOnEscape(event) {
      if (event.key !== "Escape" || nodes.sessionActionsMenu.hidden) return;
      event.preventDefault();
      closeSessionActionsMenu();
      nodes.sessionActionsMenuBtn.focus();
    }

    function runMobileSessionAction(action) {
      closeSessionActionsMenu();
      nodes.sessionActionsMenuBtn.focus();
      void action();
    }

    function updateSessionActionState() {
      const directActive = state.activeConversationKind === "direct" && !state.sessionDraft && Boolean(state.activeSessionId);
      const worldActive = state.activeConversationKind === "world" && Boolean(state.activeWorldId);
      const privatePending = directActive && (state.privateInboxRunning || state.privateInboxMessages.length > 0);
      nodes.renameSessionBtn.disabled = !directActive;
      nodes.archiveSessionBtn.disabled = !directActive || privatePending;
      nodes.deleteSessionBtn.disabled = !directActive || privatePending;
      nodes.mobileRenameSessionBtn.disabled = !directActive;
      nodes.mobileRenameSessionBtn.hidden = !directActive;
      nodes.mobileArchiveSessionBtn.disabled = !directActive || privatePending;
      nodes.mobileArchiveSessionBtn.hidden = !directActive;
      nodes.mobileDeleteSessionBtn.disabled = !directActive || privatePending;
      nodes.mobileDeleteSessionBtn.hidden = !directActive;
      nodes.resetWorldConversationBtn.hidden = !worldActive;
      nodes.resetWorldConversationBtn.disabled = !worldActive || state.busy;
      nodes.mobileArchiveSessionBtn.querySelector("span").textContent = "归档会话";
      nodes.mobileDeleteSessionBtn.querySelector("span").textContent = "永久删除会话";
      nodes.sessionActionsMenuBtn.hidden = !directActive && !worldActive;
      if (!directActive && !worldActive) closeSessionActionsMenu();
    }

    async function renameCurrentSession() {
      if (state.busy || state.sessionDraft || !state.activeSessionId) return;
      const current = state.sessions.find((entry) => entry.id === state.activeSessionId);
      if (!current || !await openSessionActionDialog("rename", current)) return;
      await loadSessions();
      setStatus("会话已重命名");
    }

    async function archiveCurrentSession() {
      if (state.busy || state.privateInboxRunning || state.privateInboxMessages.length || state.sessionDraft) return;
      if (state.activeConversationKind === "group") {
        const group = state.groupChats.find((entry) => entry.id === state.activeGroupId);
        if (!group) return;
        const archived = await openActionDialog({
          title: "归档群聊",
          description: "归档“" + group.title + "”后，将切换到最近的可用会话，并可在归档会话中恢复。",
          confirmLabel: "归档",
          onConfirm: async () => {
            const response = await fetch("/api/v1/group-chats/" + encodeURIComponent(group.id) + "/archive", {
              method: "POST"
            });
            const body = await response.json();
            if (!response.ok) throw new Error(body.error || "归档群聊失败");
          }
        });
        if (!archived) return;
        state.groupChats = state.groupChats.filter((entry) => entry.id !== group.id);
        state.activeGroupId = "";
        state.activeConversationKind = "direct";
        await loadSessions();
        setStatus("群聊已归档");
        return;
      }
      if (!state.activeSessionId) return;
      const archivedId = state.activeSessionId;
      const current = state.sessions.find((entry) => entry.id === archivedId);
      const archived = await openActionDialog({
        title: "归档会话",
        description: "归档“" + (current?.title || "当前会话") + "”后，将切换到最近的可用会话。",
        confirmLabel: "归档",
        onConfirm: async () => {
          const response = await fetch("/api/v1/sessions/" + encodeURIComponent(archivedId) + "/archive", {
            method: "POST"
          });
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || "归档失败");
        }
      });
      if (archived) {
        state.sessions = state.sessions.filter((entry) => entry.id !== archivedId);
        state.activeSessionId = "";
        state.sessionDraft = false;
        await loadSessions();
        setStatus("会话已归档");
      }
    }

    async function openArchivedSessions() {
      nodes.archivedSessionList.innerHTML = '<div class="archived-empty">加载中...</div>';
      nodes.archivedSessionsDialog.showModal();
      refreshIcons();
      await loadArchivedSessions();
    }

    async function loadArchivedSessions() {
      try {
        const response = await fetch("/api/v1/sessions?includeArchived=1");
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "归档会话加载失败");
        state.archivedSessions = (Array.isArray(body.sessions) ? body.sessions : [])
          .filter((session) => session.archivedAt)
          .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
        state.archivedGroupChats = [];
        renderArchivedSessions();
      } catch (error) {
        nodes.archivedSessionList.innerHTML = '<div class="archived-empty error">' + escapeHtml(error.message || String(error)) + '</div>';
      }
    }

    function renderArchivedSessions() {
      if (!state.archivedSessions.length && !state.archivedGroupChats.length) {
        nodes.archivedSessionList.innerHTML = '<div class="archived-empty">暂无归档会话</div>';
        refreshIcons();
        return;
      }
      const sessions = state.archivedSessions.map((session) =>
        '<div class="archived-row" data-session-id="' + escapeHtml(session.id) + '">' +
          '<div><strong title="' + escapeHtml(session.title || session.id) + '">' + escapeHtml(session.title || "旧会话") + '</strong>' +
          '<span title="' + escapeHtml(sessionLabel(session)) + '">' + escapeHtml(sessionLabel(session)) + '</span></div>' +
          '<div class="archived-row-actions">' +
            '<button class="secondary icon-button" type="button" data-archived-action="restore" title="恢复会话" aria-label="恢复会话"><i data-lucide="archive-restore" aria-hidden="true"></i></button>' +
            '<button class="secondary icon-button" type="button" data-archived-action="delete" title="永久删除会话" aria-label="永久删除归档会话"><i data-lucide="trash-2" aria-hidden="true"></i></button>' +
          '</div></div>'
      ).join("");
      nodes.archivedSessionList.innerHTML = sessions;
      refreshIcons();
    }

    async function handleArchivedSessionAction(event) {
      const button = event.target.closest("button[data-archived-action]");
      if (!button) return;
      const groupRow = button.closest("[data-group-id]");
      if (groupRow) {
        const group = state.archivedGroupChats.find((entry) => entry.id === groupRow.dataset.groupId);
        if (!group) return;
        if (button.dataset.archivedAction === "restore") {
          try {
            const response = await fetch("/api/v1/group-chats/" + encodeURIComponent(group.id) + "/restore", { method: "POST" });
            const body = await response.json();
            if (!response.ok) throw new Error(body.error || "恢复群聊失败");
            nodes.archivedSessionsDialog.close();
            state.activeGroupId = group.id;
            state.activeConversationKind = "group";
            await loadSessions();
            setStatus("群聊已恢复");
          } catch (error) {
            setStatus(error.message || String(error), true);
          }
          return;
        }
        if (button.dataset.archivedAction === "delete" && await permanentlyDeleteGroup(group)) {
          state.archivedGroupChats = state.archivedGroupChats.filter((entry) => entry.id !== group.id);
          renderArchivedSessions();
        }
        return;
      }
      const row = button.closest("[data-session-id]");
      const session = state.archivedSessions.find((entry) => entry.id === row?.dataset.sessionId);
      if (!session) return;
      if (button.dataset.archivedAction === "restore") {
        try {
          const response = await fetch("/api/v1/sessions/" + encodeURIComponent(session.id) + "/restore", { method: "POST" });
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || "恢复失败");
          nodes.archivedSessionsDialog.close();
          state.activeConversationKind = "direct";
          state.activeWorldId = "";
          state.activeGroupId = "";
          state.activeSessionId = session.id;
          await loadSessions();
          setStatus("会话已恢复");
        } catch (error) {
          setStatus(error.message || String(error), true);
        }
        return;
      }
      if (button.dataset.archivedAction === "delete" && await permanentlyDeleteSession(session)) {
        state.archivedSessions = state.archivedSessions.filter((entry) => entry.id !== session.id);
        renderArchivedSessions();
      }
    }

    async function deleteCurrentSession() {
      if (state.busy || state.privateInboxRunning || state.privateInboxMessages.length || state.sessionDraft) return;
      if (state.activeConversationKind === "group") {
        const group = state.groupChats.find((entry) => entry.id === state.activeGroupId);
        if (!group || !await permanentlyDeleteGroup(group)) return;
        state.groupChats = state.groupChats.filter((entry) => entry.id !== group.id);
        state.activeGroupId = "";
        state.activeConversationKind = "direct";
        await loadSessions();
        setStatus("群聊已永久删除");
        return;
      }
      if (!state.activeSessionId) return;
      const session = state.sessions.find((entry) => entry.id === state.activeSessionId);
      if (!session || !await permanentlyDeleteSession(session)) return;
      state.sessions = state.sessions.filter((entry) => entry.id !== session.id);
      state.activeSessionId = "";
      state.sessionDraft = false;
      await loadSessions();
      setStatus("会话已永久删除");
    }

    async function resetCurrentWorldConversation() {
      if (state.busy || state.activeConversationKind !== "world" || !state.activeWorldId) return;
      const worldId = state.activeWorldId;
      const conversation = state.worldConversations.find((entry) => entry.worldId === worldId);
      const expected = conversation?.world?.name || "";
      if (!expected) return;
      const reset = await openActionDialog({
        title: "重置世界会话",
        description: "当前消息、未完成事件和事件级模型上下文将被清空。世界卡、地点、角色、已结算事件、长期记忆、关系和日程会保留。请输入世界名称“" + expected + "”确认。",
        fieldLabel: "输入世界名称确认",
        value: "",
        confirmLabel: "重置并开始新会话",
        validate: (value) => value === expected ? "" : "世界名称不匹配，未重置。",
        onConfirm: async (value) => {
          const response = await fetch("/api/v1/worlds/" + encodeURIComponent(worldId) + "/conversation", {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ confirmation: value })
          });
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || "重置世界会话失败");
        }
      });
      if (!reset || state.activeConversationKind !== "world" || state.activeWorldId !== worldId) return;
      state.messages = [];
      clearConversationScene();
      await refreshWorldConversationList();
      await refreshWorldMessages(true);
      setStatus("已开始新的世界会话");
    }

    async function permanentlyDeleteSession(session) {
      return openSessionActionDialog("delete", session);
    }

    async function permanentlyDeleteGroup(group) {
      const expected = group.title;
      return openActionDialog({
        title: "永久删除群聊",
        description: "群聊中的全部消息将无法恢复。请输入群聊名称“" + expected + "”确认删除。",
        fieldLabel: "输入群聊名称确认",
        value: "",
        confirmLabel: "永久删除",
        validate: (value) => value === expected ? "" : "群聊名称不匹配，未删除。",
        onConfirm: async (value) => {
          const response = await fetch("/api/v1/group-chats/" + encodeURIComponent(group.id), {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ confirmation: "永久删除 " + value })
          });
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || "永久删除群聊失败");
        }
      });
    }

    function openSessionActionDialog(kind, session) {
      const expected = session.title || session.id;
      const deleting = kind === "delete";
      return openActionDialog({
        title: deleting ? "永久删除会话" : "重命名会话",
        description: deleting
          ? "消息、场景和待确认操作将无法恢复。请输入会话名称“" + expected + "”确认删除。"
          : "输入一个便于识别的会话名称。",
        fieldLabel: deleting ? "输入会话名称确认" : "会话名称",
        value: deleting ? "" : expected,
        selectInput: !deleting,
        confirmLabel: deleting ? "永久删除" : "保存",
        validate: (value) => {
          if (!deleting && !value.trim()) return "会话名称不能为空。";
          if (deleting && value !== expected) return "会话名称不匹配，未删除。";
          return "";
        },
        onConfirm: async (value) => {
          const response = await fetch("/api/v1/sessions/" + encodeURIComponent(session.id), {
            method: deleting ? "DELETE" : "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(deleting ? { confirmation: value } : { title: value.trim() })
          });
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || (deleting ? "永久删除失败" : "重命名失败"));
        }
      });
    }

    function openActionDialog(options) {
      if (actionDialogState || nodes.sessionActionDialog.open) return Promise.resolve(false);
      const usesInput = typeof options.fieldLabel === "string";
      nodes.sessionActionTitle.textContent = options.title || "确认操作";
      nodes.sessionActionDescription.textContent = options.description || "";
      nodes.sessionActionField.hidden = !usesInput;
      nodes.sessionActionFieldLabel.textContent = options.fieldLabel || "确认内容";
      nodes.sessionActionInput.value = options.value || "";
      nodes.sessionActionInput.removeAttribute("aria-invalid");
      nodes.sessionActionError.textContent = "";
      nodes.confirmSessionActionBtn.textContent = options.confirmLabel || "确认";
      nodes.confirmSessionActionBtn.disabled = false;
      const opener = options.opener || document.activeElement;
      return new Promise((resolvePromise) => {
        actionDialogState = { ...options, usesInput, opener, resolve: resolvePromise };
        nodes.sessionActionDialog.showModal();
        refreshIcons();
        requestAnimationFrame(() => {
          if (usesInput) {
            nodes.sessionActionInput.focus();
            if (options.selectInput) nodes.sessionActionInput.select();
          } else {
            nodes.confirmSessionActionBtn.focus();
          }
        });
      });
    }

    async function submitSessionActionDialog(event) {
      event.preventDefault();
      const dialogState = actionDialogState;
      if (!dialogState) return;
      const value = nodes.sessionActionInput.value;
      const validationError = dialogState.validate?.(value) || "";
      if (validationError) {
        showSessionActionError(validationError);
        return;
      }
      nodes.confirmSessionActionBtn.disabled = true;
      nodes.sessionActionError.textContent = "";
      try {
        await dialogState.onConfirm?.(value);
        finishSessionActionDialog(true);
      } catch (error) {
        nodes.confirmSessionActionBtn.disabled = false;
        showSessionActionError(error.message || String(error));
      }
    }

    function showSessionActionError(message) {
      nodes.sessionActionError.textContent = message;
      if (actionDialogState?.usesInput) {
        nodes.sessionActionInput.setAttribute("aria-invalid", "true");
        nodes.sessionActionInput.focus();
      } else {
        nodes.confirmSessionActionBtn.focus();
      }
    }

    function cancelSessionActionDialog(event) {
      event.preventDefault();
      finishSessionActionDialog(false);
    }

    function finishSessionActionDialog(result) {
      const dialogState = actionDialogState;
      if (!dialogState) return;
      actionDialogState = null;
      nodes.sessionActionDialog.close();
      dialogState.resolve(result);
      requestAnimationFrame(() => {
        if (dialogState.opener?.isConnected) dialogState.opener.focus();
      });
    }

    function trapSessionActionFocus(event) {
      if (event.key !== "Tab") return;
      const focusable = [...nodes.sessionActionDialog.querySelectorAll("button:not(:disabled), input:not(:disabled)")]
        .filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) return;
      const current = focusable.indexOf(document.activeElement);
      const offset = event.shiftKey ? -1 : 1;
      const next = current < 0
        ? (event.shiftKey ? focusable.length - 1 : 0)
        : (current + offset + focusable.length) % focusable.length;
      event.preventDefault();
      focusable[next].focus();
    }

    function setSessionControlsLocked(locked) {
      nodes.modeSelect.disabled = locked;
      nodes.chatCharacterSelect.disabled = locked;
      const hint = locked ? "已有会话的模式和角色固定；请新建会话进行更改" : "";
      nodes.modeSelect.title = hint;
      nodes.chatCharacterSelect.title = hint;
    }

    function generateSessionId() {
      const random = globalThis.crypto?.randomUUID
        ? globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12)
        : Math.random().toString(36).slice(2, 14);
      return "conversation-" + Date.now().toString(36) + "-" + random;
    }

    function updateRpControls() {
      nodes.chatCharacterControl.hidden = false;
      updateChatIdentity();
    }

    function setHeaderCharacterProfileTarget(character) {
      const available = Boolean(character?.id);
      nodes.conversationHeaderAvatar.disabled = !available;
      if (available) {
        nodes.conversationHeaderAvatar.dataset.characterProfileId = character.id;
        nodes.conversationHeaderAvatar.title = "查看" + character.name + "的资料";
        nodes.conversationHeaderAvatar.setAttribute("aria-label", "查看" + character.name + "的资料");
      } else {
        delete nodes.conversationHeaderAvatar.dataset.characterProfileId;
        nodes.conversationHeaderAvatar.title = "";
        nodes.conversationHeaderAvatar.setAttribute("aria-label", "当前没有可查看的角色资料");
      }
    }

    function updateChatIdentity() {
      updateContextBudgetChrome();
      if (state.uiMode === "schedule") {
        updateScheduleHeaderContext();
        renderConversationList();
        renderMessages();
        return;
      }
      if (state.activeConversationKind === "world") {
        const conversation = state.worldConversations.find((entry) => entry.worldId === state.activeWorldId);
        const memberCount = conversation?.characterIds?.length || 0;
        const event = conversation?.activeEvent;
        nodes.conversationCharacter.textContent = conversation?.world?.name || "共享世界";
        nodes.conversationMode.textContent = "世界演绎 · " + memberCount + " 位角色";
        nodes.conversationHeaderAvatar.classList.add("group");
        nodes.conversationHeaderAvatar.innerHTML = worldAvatarCluster(conversation);
        setHeaderCharacterProfileTarget(null);
        if (event) {
          const status = event.status === "planned" ? "待开始" : "进行中";
          nodes.conversationScene.textContent = status + " · " + event.title;
          nodes.conversationScene.title = [event.title, event.summary, event.objective].filter(Boolean).join(" · ");
          nodes.conversationScene.hidden = false;
          state.currentScene = { ...event, worldEvent: true };
          nodes.sceneInfoBtn.hidden = false;
        } else {
          state.currentScene = null;
          nodes.conversationScene.hidden = true;
          nodes.sceneInfoBtn.hidden = true;
        }
        nodes.interactionToggleBtn.hidden = true;
        nodes.interactionUndoBtn.hidden = true;
        renderConversationList();
        renderMessages();
        return;
      }
      if (state.activeConversationKind === "group") {
        const group = state.groupChats.find((entry) => entry.id === state.activeGroupId);
        const members = group?.characterIds.map((id) => state.characters.find((entry) => entry.id === id)).filter(Boolean) || [];
        nodes.conversationCharacter.textContent = group?.title || "群聊";
        nodes.conversationMode.textContent = (group?.mode === "rp" ? "群体剧情" : "角色群聊") + " · " + members.length + " 人";
        nodes.conversationHeaderAvatar.classList.add("group");
        nodes.conversationHeaderAvatar.innerHTML = groupAvatarCluster(group);
        setHeaderCharacterProfileTarget(null);
        nodes.conversationScene.hidden = true;
        nodes.sceneInfoBtn.hidden = true;
        updateInteractionChrome();
        renderConversationList();
        renderMessages();
        return;
      }
      const character = state.characters.find((entry) => entry.id === state.selectedCharacterId);
      nodes.conversationHeaderAvatar.classList.remove("group");
      nodes.conversationCharacter.textContent = character?.name || "未选择角色";
      nodes.conversationMode.textContent = "角色私聊";
      nodes.conversationHeaderAvatar.style.setProperty("--avatar-hue", avatarHue(character?.name || "角色"));
      nodes.conversationHeaderAvatar.innerHTML = avatarImageOrInitial(character?.avatarUrl, character?.name, "角");
      setHeaderCharacterProfileTarget(character);
      updateInteractionChrome();
      renderConversationList();
      renderMessages();
    }

    function clearInteractionState() {
      state.interactionState = null;
      state.interactionEvents = [];
      state.interactionCanUndo = false;
      state.interactionLocations = [];
      state.characterLiveState = null;
      updateInteractionChrome();
    }

    function updateContextBudgetChrome() {
      const budget = state.contextBudget;
      const available = state.uiMode === "normal" && state.activeConversationKind === "direct" &&
        !state.sessionDraft && Boolean(state.activeSessionId) && Boolean(budget);
      nodes.contextBudgetBtn.hidden = !available;
      if (!available) return;
      const percent = Math.max(0, Math.min(100, Math.round(Number(budget.remainingRatio || 0) * 100)));
      nodes.contextBudgetTokens.textContent = "余 " + formatCompactTokenCount(budget.remainingTokens) + " · " + percent + "%";
      nodes.contextBudgetPercent.textContent = percent + "%";
      nodes.contextBudgetBtn.dataset.level = budget.level || "healthy";
      nodes.contextBudgetBtn.title = "上下文余量 " + formatTokenCount(budget.remainingTokens) + "（" + percent +
        "%）；已用 " + formatTokenCount(budget.usedInputTokens);
      nodes.contextBudgetBtn.setAttribute("aria-label", nodes.contextBudgetBtn.title);
      nodes.contextBudgetBtn.disabled = state.contextCompacting;
    }

    function openContextBudgetDialog() {
      if (!state.contextBudget || state.sessionDraft || state.activeConversationKind !== "direct") return;
      renderContextBudgetDialog();
      nodes.contextBudgetDialog.showModal();
      refreshIcons();
    }

    function closeContextBudgetDialog() {
      if (state.contextCompacting) return;
      if (nodes.contextBudgetDialog.open) nodes.contextBudgetDialog.close();
    }

    function renderContextBudgetDialog() {
      const budget = state.contextBudget;
      if (!budget) return;
      const percent = Math.max(0, Math.min(100, Math.round(Number(budget.remainingRatio || 0) * 100)));
      const usedPercent = Math.max(0, Math.min(100, Number(budget.utilizationRatio || 0) * 100));
      const source = budget.usageSource === "measured" ? "Provider 实测（含缓存）" : "本地估算";
      const windowSource = budget.contextWindowSource === "configured"
        ? "已配置窗口"
        : "默认假设窗口，建议在模型设置中确认";
      nodes.contextBudgetRemaining.textContent = formatTokenCount(budget.remainingTokens) + " 可用";
      nodes.contextBudgetSource.textContent = percent + "% 余量 · " + source;
      nodes.contextBudgetMeter.dataset.level = budget.level || "healthy";
      nodes.contextBudgetMeter.firstElementChild.style.width = usedPercent + "%";
      const lastCompaction = budget.lastCompaction
        ? formatTraceTime(budget.lastCompaction.at) + " · " +
          (budget.lastCompaction.status === "completed" ? "已完成" : "失败")
        : "尚未整理";
      const metrics = [
        ["已用输入", formatTokenCount(budget.usedInputTokens) + " · " + source],
        ["本地估算", formatTokenCount(budget.estimatedInputTokens)],
        ["可用输入上限", formatTokenCount(budget.usableInputTokens)],
        ["模型窗口", formatTokenCount(budget.contextWindowTokens) + " · " + windowSource],
        ["最大输出保留", formatTokenCount(budget.maxOutputTokens)],
        ["安全保留", formatTokenCount(budget.safetyReserveTokens)],
        ["最近整理", lastCompaction]
      ];
      nodes.contextBudgetMetrics.innerHTML = metrics.map((entry) =>
        '<div><dt>' + escapeHtml(entry[0]) + '</dt><dd>' + escapeHtml(entry[1]) + '</dd></div>'
      ).join("");
      nodes.compactContextBtn.disabled = state.contextCompacting || state.busy || state.privateInboxRunning;
      if (!state.contextCompacting) {
        nodes.contextBudgetState.textContent = state.privateInboxRunning
          ? "消息仍在合并或生成，结束后可以整理。"
          : budget.shouldCompact ? "已进入主动整理区间。" : "当前余量充足。";
      }
    }

    async function compactCurrentContext() {
      if (!state.activeSessionId || state.contextCompacting || state.busy || state.privateInboxRunning) return;
      const requestedSessionId = state.activeSessionId;
      state.contextCompacting = true;
      nodes.contextBudgetState.textContent = "正在整理上下文...";
      nodes.compactContextBtn.disabled = true;
      updateContextBudgetChrome();
      try {
        const response = await fetch(
          "/api/v1/sessions/" + encodeURIComponent(requestedSessionId) + "/compact",
          { method: "POST" }
        );
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "上下文整理失败");
        if (state.activeSessionId !== requestedSessionId) return;
        state.contextBudget = body.result?.budgetAfter || state.contextBudget;
        renderContextBudgetDialog();
        nodes.contextBudgetState.textContent = "已完成";
        updateContextBudgetChrome();
        await refreshSessionMessages(true);
      } catch (error) {
        nodes.contextBudgetState.textContent = error.message || String(error);
      } finally {
        state.contextCompacting = false;
        updateContextBudgetChrome();
        if (nodes.contextBudgetDialog.open) nodes.compactContextBtn.disabled = state.busy || state.privateInboxRunning;
      }
    }

    function updateInteractionChrome() {
      if (state.activeConversationKind === "world") {
        nodes.interactionToggleBtn.hidden = true;
        nodes.interactionUndoBtn.hidden = true;
        nodes.textInput.placeholder = "推动世界中的下一幕";
        return;
      }
      const available = state.uiMode === "normal" && state.activeConversationKind === "direct" &&
        !state.sessionDraft && nodes.modeSelect.value === "sms" && Boolean(state.interactionState);
      nodes.interactionToggleBtn.hidden = !available;
      nodes.interactionUndoBtn.hidden = !available || !state.interactionCanUndo;
      if (!available) {
        nodes.textInput.placeholder = nodes.modeSelect.value === "rp" ? "继续当前剧情" : "发消息";
        return;
      }
      const interaction = state.interactionState;
      const location = interaction.location || "地点待定";
      if (interaction.presence === "co_present") {
        nodes.conversationMode.textContent = "见面中";
        nodes.conversationScene.textContent = "正在一起 · " + location;
        nodes.conversationScene.title = nodes.conversationScene.textContent;
        nodes.conversationScene.hidden = false;
        nodes.interactionToggleBtn.innerHTML = '<i data-lucide="log-out" aria-hidden="true"></i>';
        nodes.interactionToggleBtn.title = "结束见面";
        nodes.interactionToggleBtn.setAttribute("aria-label", "结束见面");
        nodes.textInput.placeholder = "描述你说的话或正在做的事";
      } else if (interaction.presence === "meeting_pending") {
        nodes.conversationMode.textContent = "约好见面";
        nodes.conversationScene.textContent = "约好见面 · " + location;
        nodes.conversationScene.title = nodes.conversationScene.textContent;
        nodes.conversationScene.hidden = false;
        nodes.interactionToggleBtn.innerHTML = '<i data-lucide="map-pin-check" aria-hidden="true"></i>';
        nodes.interactionToggleBtn.title = "确认已经到达";
        nodes.interactionToggleBtn.setAttribute("aria-label", "确认已经到达");
        nodes.textInput.placeholder = "发消息，或告诉她你到了";
      } else {
        nodes.conversationMode.textContent = "角色私聊";
        const live = state.characterLiveState;
        const availabilityLabels = { free: "空闲", busy: "忙碌", resting: "休息中", traveling: "在路上" };
        const liveSummary = [live?.place, live?.activity, availabilityLabels[live?.availability]].filter(Boolean).join(" · ");
        nodes.conversationScene.textContent = liveSummary;
        nodes.conversationScene.title = liveSummary;
        nodes.conversationScene.hidden = !liveSummary;
        nodes.interactionToggleBtn.innerHTML = '<i data-lucide="map-pin" aria-hidden="true"></i>';
        nodes.interactionToggleBtn.title = "发起见面";
        nodes.interactionToggleBtn.setAttribute("aria-label", "发起见面");
        nodes.textInput.placeholder = "发消息";
      }
      nodes.interactionToggleBtn.disabled = state.busy || state.privateInboxRunning;
      nodes.interactionUndoBtn.disabled = state.busy || state.privateInboxRunning;
      refreshIcons();
    }

    async function openInteractionControl() {
      const interaction = state.interactionState;
      if (!interaction || state.busy || state.privateInboxRunning || state.sessionDraft) return;
      if (interaction.presence === "remote") {
        const suggested = state.interactionLocations[0]?.name || "";
        await openActionDialog({
          title: "约见",
          description: "记录你们约定的见面地点。确认到达前，对话仍会保持消息形式。",
          fieldLabel: "见面地点",
          value: suggested,
          selectInput: Boolean(suggested),
          confirmLabel: "约好",
          validate: (value) => value.trim() ? "" : "请输入见面地点。",
          onConfirm: (value) => runInteractionAction("propose", { location: value.trim() })
        });
        return;
      }
      if (interaction.presence === "meeting_pending") {
        await openActionDialog({
          title: "确认已经到达",
          description: "确认你已经到达“" + (interaction.location || "约定地点") + "”，接下来的回复会呈现现场可见的动作、表情和环境。",
          confirmLabel: "我到了",
          onConfirm: () => runInteractionAction("begin", {
            location: interaction.location || undefined,
            placeId: interaction.placeId || undefined,
            userConfirmed: true
          })
        });
        return;
      }
      await openActionDialog({
        title: "结束见面",
        description: "结束后，你们会回到消息交流。",
        confirmLabel: "结束见面",
        onConfirm: () => runInteractionAction("end", { userConfirmed: true })
      });
    }

    async function undoInteractionTransition() {
      if (!state.interactionCanUndo || state.busy || state.privateInboxRunning) return;
      try {
        await runInteractionAction("undo", {});
      } catch {
        // runInteractionAction already presents the API error in the shared status area.
      }
    }

    async function handleInteractionEventAction(event) {
      const button = event.target.closest("button[data-interaction-action]");
      if (!button || state.busy || state.privateInboxRunning) return;
      const action = button.dataset.interactionAction;
      if (action === "begin") {
        try {
          await runInteractionAction("begin", {
            location: state.interactionState?.location || undefined,
            placeId: state.interactionState?.placeId || undefined,
            userConfirmed: true
          });
        } catch {
          // runInteractionAction already presents the API error in the shared status area.
        }
      } else if (action === "cancel") {
        try {
          await runInteractionAction("cancel", {});
        } catch {
          // runInteractionAction already presents the API error in the shared status area.
        }
      }
    }

    async function runInteractionAction(action, payload) {
      if (state.busy || state.privateInboxRunning || !state.activeSessionId) return;
      state.busy = true;
      updateInteractionChrome();
      try {
        const response = await fetch(
          "/api/v1/sessions/" + encodeURIComponent(state.activeSessionId) + "/interaction",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action, ...(payload || {}) })
          }
        );
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "互动状态更新失败");
        state.interactionState = body.state || null;
        state.interactionEvents = Array.isArray(body.events) ? body.events : [];
        state.interactionCanUndo = Boolean(body.canUndo);
        state.interactionLocations = Array.isArray(body.suggestedLocations) ? body.suggestedLocations : [];
        await refreshSessionMessages(true);
        await refreshConversationMetadata();
        setStatus(action === "begin" ? "已经见面" : action === "end" ? "已回到消息交流" : "互动状态已更新");
      } catch (error) {
        setStatus(error.message || String(error), true);
        throw error;
      } finally {
        state.busy = false;
        updateInteractionChrome();
      }
    }

    function updateScheduleHeaderContext() {
      if (state.uiMode !== "schedule") return;
      const characterMode = state.scheduleOwnerType === "character";
      const character = state.characters.find((entry) => entry.id === state.scheduleCharacterId);
      nodes.conversationCharacter.textContent = characterMode ? (character?.name || "未选择角色") : "我的日程";
      nodes.conversationHeaderAvatar.classList.remove("group");
      nodes.conversationMode.textContent = characterMode ? "角色日程" : "现实日程";
      nodes.conversationHeaderAvatar.style.setProperty("--avatar-hue", avatarHue(characterMode ? character?.name || "角色" : "我"));
      nodes.conversationHeaderAvatar.innerHTML = characterMode
        ? avatarImageOrInitial(character?.avatarUrl, character?.name, "角")
        : avatarImageOrInitial(state.userAvatarUrl, "我", "我");
      setHeaderCharacterProfileTarget(characterMode ? character : null);
      nodes.conversationScene.hidden = true;
      nodes.sceneInfoBtn.hidden = true;
      nodes.conversationListToggle.hidden = true;
      nodes.sessionActionsMenuBtn.hidden = true;
      closeSessionActionsMenu();
    }

    async function loadConversationScene(preserveDialog = false) {
      if (nodes.modeSelect.value !== "rp") {
        state.currentScene = null;
        nodes.sceneInfoBtn.hidden = true;
        if (!preserveDialog && nodes.sceneInfoDialog.open) nodes.sceneInfoDialog.close();
        updateInteractionChrome();
        return;
      }
      clearConversationScene(!preserveDialog);
      if (
        state.activeConversationKind === "group" ||
        state.sessionDraft ||
        nodes.modeSelect.value !== "rp" ||
        !state.activeSessionId ||
        !state.selectedCharacterId
      ) return;
      try {
        const response = await fetch(
          "/api/v1/sessions/" + encodeURIComponent(state.activeSessionId) +
          "/scene?characterId=" + encodeURIComponent(state.selectedCharacterId)
        );
        const body = await response.json();
        if (!response.ok) return;
        const scene = body.scene || {};
        state.currentScene = scene;
        nodes.sceneInfoBtn.hidden = false;
        const summary = [
          scene.location ? "地点 " + scene.location : "",
          scene.currentObjective ? "目标 " + scene.currentObjective : "",
          scene.summary || ""
        ].filter(Boolean).join(" · ").slice(0, 100);
        if (!summary) {
          nodes.conversationScene.textContent = "查看当前场景";
          nodes.conversationScene.title = "查看当前场景";
          nodes.conversationScene.hidden = false;
          return;
        }
        nodes.conversationScene.textContent = summary;
        nodes.conversationScene.title = summary;
        nodes.conversationScene.hidden = false;
      } catch {
        clearConversationScene();
      }
    }

    function clearConversationScene(closeDialog = true) {
      state.currentScene = null;
      nodes.conversationScene.textContent = "";
      nodes.conversationScene.title = "";
      nodes.conversationScene.hidden = true;
      nodes.sceneInfoBtn.hidden = true;
      if (closeDialog && nodes.sceneInfoDialog.open) nodes.sceneInfoDialog.close();
      if (nodes.modeSelect.value !== "rp") updateInteractionChrome();
    }

    function openSceneInfoDialog() {
      const scene = state.currentScene;
      if (!scene) return;
      setSceneInfoEditing(false);
      if (scene.worldEvent) {
        renderWorldEventInfo(scene);
        nodes.editSceneInfoBtn.hidden = true;
      } else {
        renderSceneInfo(scene);
      }
      nodes.sceneInfoDialog.showModal();
      refreshIcons();
    }

    function renderWorldEventInfo(event) {
      nodes.sceneInfoTitle.textContent = "世界事件";
      const participantNames = (event.participantIds || []).map((id) =>
        state.characters.find((entry) => entry.id === id)?.name || id
      );
      const statusLabels = { planned: "待开始", active: "进行中", resolved: "已结束", cancelled: "已取消" };
      const rows = [
        ["事件", event.title],
        ["状态", statusLabels[event.status] || event.status],
        ["当前目标", event.objective],
        ["参与者", participantNames.join("、")],
        ["事件摘要", event.summary],
        ["结算记录", event.settlementSummary]
      ].filter((entry) => entry[1]);
      nodes.sceneInfoContent.innerHTML = '<dl>' + rows.map((entry) =>
        '<div class="scene-info-row"><dt>' + escapeHtml(entry[0]) + '</dt><dd>' + escapeHtml(entry[1]) + '</dd></div>'
      ).join("") + '</dl>';
      const actions = [];
      if (event.status === "planned") {
        actions.push(worldEventActionButton("begin", "play", "开始事件", "primary"));
        actions.push(worldEventActionButton("cancel", "x", "取消事件", "secondary"));
      } else if (event.status === "active") {
        actions.push(worldEventActionButton("resolve", "circle-check", "结束并结算", "primary"));
        actions.push(worldEventActionButton("cancel", "circle-x", "取消事件", "secondary"));
      }
      actions.push(worldEventActionButton("undo", "undo-2", "撤销最近变更", "secondary"));
      nodes.worldEventActions.innerHTML = actions.join("");
      nodes.worldEventActions.hidden = false;
    }

    function worldEventActionButton(action, icon, label, className) {
      return '<button class="' + escapeHtml(className) + '" type="button" data-world-event-action="' +
        escapeHtml(action) + '"><i data-lucide="' + escapeHtml(icon) + '" aria-hidden="true"></i><span>' +
        escapeHtml(label) + '</span></button>';
    }

    async function handleWorldEventAction(event) {
      const button = event.target.closest("button[data-world-event-action]");
      if (!button || !state.activeWorldId) return;
      const action = button.dataset.worldEventAction || "";
      nodes.worldEventActions.querySelectorAll("button").forEach((control) => { control.disabled = true; });
      try {
        const response = await fetch("/api/v1/worlds/" + encodeURIComponent(state.activeWorldId) + "/conversation/event", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action })
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "世界事件更新失败");
        await refreshWorldConversationList();
        if (body.event) renderWorldEventInfo({ ...body.event, worldEvent: true });
        else closeSceneInfoDialog();
        setStatus(action === "resolve" ? "事件已结束并结算" : action === "undo" ? "已撤销最近的事件变更" : "事件状态已更新");
      } catch (error) {
        setStatus(error.message || String(error), true);
        if (state.currentScene?.worldEvent) renderWorldEventInfo(state.currentScene);
      }
      refreshIcons();
    }

    function renderSceneInfo(scene) {
      nodes.sceneInfoTitle.textContent = "场景信息";
      nodes.worldEventActions.hidden = true;
      nodes.worldEventActions.innerHTML = "";
      const rows = [
        ["地点", scene.location],
        ["场景时间", scene.inWorldTime],
        ["当前目标", scene.currentObjective],
        ["参与者", (scene.participants || []).join("、")],
        ["场景摘要", scene.summary],
        ["未完线索", (scene.openThreads || []).join("\\n")]
      ].filter((entry) => entry[1]);
      nodes.sceneInfoContent.innerHTML = rows.length
        ? '<dl>' + rows.map((entry) => '<div class="scene-info-row"><dt>' + escapeHtml(entry[0]) + '</dt><dd>' + escapeHtml(entry[1]) + '</dd></div>').join("") + '</dl>'
        : '<div class="archived-empty">当前场景尚无详细信息</div>';
    }

    function closeSceneInfoDialog() {
      setSceneInfoEditing(false);
      if (nodes.sceneInfoDialog.open) nodes.sceneInfoDialog.close();
      nodes.sceneInfoBtn.focus();
    }

    function dismissSceneInfoDialog() {
      if (state.sceneEditing) {
        setSceneInfoEditing(false);
        return;
      }
      closeSceneInfoDialog();
    }

    function beginSceneEditing() {
      if (state.activeConversationKind !== "direct" || !state.selectedCharacterId || !state.activeSessionId) return;
      const scene = state.currentScene || {};
      nodes.sceneLocation.value = scene.location || "";
      nodes.sceneTime.value = scene.inWorldTime || "";
      nodes.sceneObjective.value = scene.currentObjective || "";
      nodes.sceneParticipants.value = (scene.participants || []).join(", ");
      nodes.sceneSummary.value = scene.summary || "";
      nodes.sceneThreads.value = (scene.openThreads || []).join("\\n");
      nodes.sceneState.textContent = "";
      setSceneInfoEditing(true);
      nodes.sceneLocation.focus();
    }

    function setSceneInfoEditing(editing) {
      state.sceneEditing = editing;
      nodes.sceneInfoContent.hidden = editing;
      nodes.sceneForm.hidden = !editing;
      nodes.editSceneInfoBtn.hidden = editing;
      nodes.worldEventActions.hidden = editing || !state.currentScene?.worldEvent;
      nodes.saveSceneBtn.hidden = !editing;
      nodes.dismissSceneInfoBtn.textContent = editing ? "取消" : "关闭";
      nodes.dismissSceneInfoBtn.className = editing ? "secondary" : "secondary";
    }

    async function loadCharacters() {
      try {
        const response = await fetch("/api/v1/characters");
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "角色加载失败");
        state.characters = Array.isArray(body.characters) ? body.characters : [];
        if (state.selectedCharacterId && !state.characters.some((entry) => entry.id === state.selectedCharacterId)) {
          state.selectedCharacterId = "";
        }
        if (state.workspaceCharacterId && !state.characters.some((entry) => entry.id === state.workspaceCharacterId)) {
          state.workspaceCharacterId = "";
        }
        renderCharacterOptions();
        if (state.workspaceCharacterId) await loadCharacterWorkspace();
        else hideCharacterDetail();
      } catch (error) {
        nodes.characterState.textContent = error.message || String(error);
      }
    }

	    function renderCharacterOptions() {
	      const options = state.characters.map((character) =>
	        '<option value="' + escapeHtml(character.id) + '">' + escapeHtml(character.name) + '</option>'
	      ).join("");
	      const selectedCharacterModel = nodes.characterModelProfile.value;
	      const selectedCharacterMeetingPreset = nodes.characterMeetingPreset.value;
	      nodes.characterModelProfile.innerHTML = '<option value="">继承系统默认模型</option>' + state.modelProfiles.map((profile) =>
	        '<option value="' + escapeHtml(profile.id) + '">' + escapeHtml(profile.name) + (profile.isDefault ? '（默认）' : '') + '</option>'
	      ).join("");
	      nodes.characterModelProfile.value = state.modelProfiles.some((profile) => profile.id === selectedCharacterModel)
	        ? selectedCharacterModel
	        : "";
	      renderCharacterMeetingPresetOptions(selectedCharacterMeetingPreset);
      nodes.chatCharacterSelect.innerHTML = '<option value="">请创建或选择角色</option>' + options;
      nodes.chatCharacterSelect.value = state.selectedCharacterId;
      nodes.featureTestCharacter.innerHTML = '<option value="">选择测试角色</option>' + options;
      const featureCharacterBefore = nodes.featureTestCharacter.value;
      nodes.featureTestCharacter.value = state.characters.some((character) => character.id === featureCharacterBefore)
        ? featureCharacterBefore
        : state.selectedCharacterId || state.characters[0]?.id || "";
      const initiativeCharacterBefore = nodes.initiativeCharacterFilter.value;
      nodes.initiativeCharacterFilter.innerHTML = '<option value="">全部角色</option>' + options;
      nodes.initiativeCharacterFilter.value = state.characters.some((character) => character.id === initiativeCharacterBefore)
        ? initiativeCharacterBefore
        : "";
      const okfCharacterBefore = nodes.okfImportCharacter.value;
      nodes.okfImportCharacter.innerHTML = '<option value="">选择角色</option>' + options;
      nodes.okfImportCharacter.value = state.characters.some((character) => character.id === okfCharacterBefore)
        ? okfCharacterBefore
        : "";
      renderScheduleCharacterOptions();
      renderCharacterCards();
      updateChatIdentity();
    }

    function renderCharacterCards() {
      const cards = state.characters.map((character) => {
        const sessions = state.sessions.filter((session) => session.characterId === character.id).length;
        const active = character.id === state.workspaceCharacterId;
        return '<button class="character-card' + (active ? ' active' : '') + '" type="button" data-character-card-id="' + escapeHtml(character.id) + '">' +
          '<span class="character-card-avatar" style="--avatar-hue:' + avatarHue(character.name) + '">' + avatarImageOrInitial(character.avatarUrl, character.name) + '</span>' +
          '<span class="character-card-copy"><strong>' + escapeHtml(character.name) + '</strong><span>' + sessions + ' 个会话 · ' + Number(character.soulCharacterCount || 0).toLocaleString() + ' 字设定</span></span>' +
        '</button>';
      }).join("");
      nodes.characterCardGrid.innerHTML = cards;
      nodes.characterListEmpty.hidden = state.characters.length > 0;
      refreshIcons();
    }

    function renderWorldCards() {
      const cards = state.worlds.map((world) => {
        const conversation = state.worldConversations.find((entry) => entry.worldId === world.id);
        const memberCount = conversation?.characterIds?.length || 0;
        const event = conversation?.activeEvent;
        const director = state.modelProfiles.find((profile) => profile.id === world.directorModelProfileId);
        const modelLabel = director?.name || "默认模型";
        const eventLabel = event
          ? '<span class="world-card-event ' + escapeHtml(event.status) + '">' +
              escapeHtml((event.status === "planned" ? "待开始" : "进行中") + " · " + event.title) + '</span>'
          : '<span>当前无进行中的事件</span>';
        return '<button class="character-card world-card" type="button" data-world-card-id="' + escapeHtml(world.id) + '">' +
          '<span class="character-card-avatar">' + worldAvatarCluster(conversation) + '</span>' +
          '<span class="character-card-copy"><strong>' + escapeHtml(world.name) + '</strong>' +
            '<span>' + memberCount + ' 位角色 · ' + escapeHtml(modelLabel) + '</span>' + eventLabel + '</span>' +
        '</button>';
      }).join("");
      nodes.worldCardGrid.innerHTML = cards;
      nodes.worldListEmpty.hidden = state.worlds.length > 0;
      refreshIcons();
    }

    function selectWorldCard(event) {
      const card = event.target.closest("button[data-world-card-id]");
      if (!card) return;
      void openWorldManager(card.dataset.worldCardId || "");
    }

    function revealCharacterDetailWhenNeeded() {
      requestAnimationFrame(() => {
        const detailHead = nodes.characterDetail.querySelector(".character-detail-head");
        if (!detailHead) return;
        const pageBounds = nodes.charactersPage.getBoundingClientRect();
        const headBounds = detailHead.getBoundingClientRect();
        const margin = 16;
        if (headBounds.top >= pageBounds.top + margin && headBounds.bottom <= pageBounds.bottom - margin) return;
        const top = nodes.charactersPage.scrollTop + headBounds.top - pageBounds.top - margin;
        nodes.charactersPage.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
      });
    }

    async function selectCharacterCard(event) {
      const card = event.target.closest("button[data-character-card-id]");
      if (!card) return;
      state.workspaceCharacterId = card.dataset.characterCardId || "";
      renderCharacterCards();
      await loadCharacterWorkspace();
      revealCharacterDetailWhenNeeded();
    }

    async function loadCharacterWorkspace() {
      const character = state.characters.find((entry) => entry.id === state.workspaceCharacterId);
      if (!character) return;
      nodes.characterDetail.hidden = false;
	      nodes.characterDetailTitle.textContent = character.name || "未命名角色";
	      nodes.characterName.value = character.name || "";
	      nodes.characterModelProfile.value = character.modelProfileId || "";
	      nodes.characterMeetingPreset.value = character.meetingPresetId || "";
	      nodes.characterSoulMarkdown.value = character.soulMarkdown || "";
      state.pendingCharacterAvatarDataUrl = "";
      renderCharacterAvatarPreview();
      updateCharacterSoulCount();
      nodes.saveCharacterBtn.textContent = "保存角色";
      nodes.characterFunctionTabBtn.disabled = false;
      nodes.characterMemoryTabBtn.disabled = false;
      nodes.characterRelationshipTabBtn.disabled = false;
      nodes.characterLifeTabBtn.disabled = false;
      state.relationship = null;
      state.characterLife = null;
      state.characterFunction = null;
      state.characterFunctionOpenCapabilities = [];
      state.characterSkillVersions = [];
      state.characterSkillViewingHistory = false;
      state.characterFunctionPollAttempts = 0;
      clearCharacterFunctionPoll();
      setCharacterTab("settings");
    }

    function resetCharacterForm() {
      state.workspaceCharacterId = "";
	      nodes.characterForm.reset();
	      nodes.characterMeetingPreset.value = "";
      nodes.characterFunctionForm.reset();
      nodes.memoryForm.reset();
      nodes.memoryList.innerHTML = "";
      nodes.relationshipOverview.innerHTML = "";
      nodes.relationshipEventList.innerHTML = "";
      nodes.characterCapabilityList.innerHTML = "";
      state.relationship = null;
      state.characterFunction = null;
      state.characterFunctionOpenCapabilities = [];
      state.characterSkillVersions = [];
      state.characterSkillViewingHistory = false;
      state.characterFunctionPollAttempts = 0;
      clearCharacterFunctionPoll();
      state.pendingCharacterAvatarDataUrl = "";
      nodes.characterDetail.hidden = false;
      nodes.characterDetailTitle.textContent = "新角色";
      nodes.saveCharacterBtn.textContent = "创建角色";
      nodes.characterState.textContent = "";
      nodes.memoryState.textContent = "";
      nodes.characterFunctionState.textContent = "";
      nodes.characterFunctionTabBtn.disabled = true;
      nodes.characterMemoryTabBtn.disabled = true;
      nodes.characterRelationshipTabBtn.disabled = true;
      nodes.characterLifeTabBtn.disabled = true;
      renderCharacterCards();
      renderCharacterAvatarPreview();
      updateCharacterSoulCount();
      setCharacterTab("settings");
      revealCharacterDetailWhenNeeded();
      nodes.characterName.focus({ preventScroll: true });
    }

    function hideCharacterDetail() {
      nodes.characterDetail.hidden = true;
      nodes.characterFunctionTabBtn.disabled = true;
      nodes.characterMemoryTabBtn.disabled = true;
      nodes.characterRelationshipTabBtn.disabled = true;
      nodes.characterLifeTabBtn.disabled = true;
      state.characterTab = "settings";
    }

    function setCharacterTab(tab) {
      if (tab !== "settings" && !state.workspaceCharacterId) return;
      state.characterTab = tab;
      const settings = tab === "settings";
      const capabilities = tab === "capabilities";
      const memory = tab === "memory";
      const relationship = tab === "relationship";
      const life = tab === "life";
      nodes.characterSettingsTabBtn.classList.toggle("active", settings);
      nodes.characterFunctionTabBtn.classList.toggle("active", capabilities);
      nodes.characterMemoryTabBtn.classList.toggle("active", memory);
      nodes.characterRelationshipTabBtn.classList.toggle("active", relationship);
      nodes.characterLifeTabBtn.classList.toggle("active", life);
      nodes.characterSettingsTabBtn.setAttribute("aria-selected", String(settings));
      nodes.characterFunctionTabBtn.setAttribute("aria-selected", String(capabilities));
      nodes.characterMemoryTabBtn.setAttribute("aria-selected", String(memory));
      nodes.characterRelationshipTabBtn.setAttribute("aria-selected", String(relationship));
      nodes.characterLifeTabBtn.setAttribute("aria-selected", String(life));
      nodes.characterSettingsPanel.hidden = !settings;
      nodes.characterFunctionPanel.hidden = !capabilities;
      nodes.characterMemoryPanel.hidden = !memory;
      nodes.characterRelationshipPanel.hidden = !relationship;
      nodes.characterLifePanel.hidden = !life;
      if (capabilities) void loadCharacterFunction();
      else clearCharacterFunctionPoll();
      if (memory) void loadMemories();
      if (relationship) void loadRelationship();
      if (life) void loadCharacterLife();
    }

    async function loadCharacterFunction(silent) {
      const characterId = state.workspaceCharacterId;
      if (!characterId) return;
      clearCharacterFunctionPoll();
      if (!silent) nodes.characterFunctionState.textContent = "加载中...";
      nodes.saveCharacterFunctionBtn.disabled = true;
      try {
        const [response, skillResponse] = await Promise.all([
          fetch("/api/v1/characters/" + encodeURIComponent(characterId) + "/function-profile"),
          fetch("/api/v1/characters/" + encodeURIComponent(characterId) + "/skill-versions?limit=50")
        ]);
        const [body, skillBody] = await Promise.all([response.json(), skillResponse.json()]);
        if (!response.ok) throw new Error(body.error || "职责能力加载失败");
        if (!skillResponse.ok) throw new Error(skillBody.error || "Skill 历史加载失败");
        if (state.workspaceCharacterId !== characterId) return;
        state.characterFunction = body.functionProfile || null;
        state.characterSkillVersions = Array.isArray(skillBody.skillVersions)
          ? skillBody.skillVersions
          : [];
        renderCharacterFunction();
        scheduleCharacterFunctionPoll();
      } catch (error) {
        nodes.characterFunctionState.textContent = error.message || String(error);
      } finally {
        nodes.saveCharacterFunctionBtn.disabled = false;
      }
    }

    function clearCharacterFunctionPoll() {
      if (state.characterFunctionPollTimer) {
        clearTimeout(state.characterFunctionPollTimer);
        state.characterFunctionPollTimer = null;
      }
    }

    function scheduleCharacterFunctionPoll() {
      clearCharacterFunctionPoll();
      const profile = state.characterFunction?.profile || {};
      if (
        state.characterTab !== "capabilities" ||
        profile.manualLocked ||
        !["pending", "uninitialized"].includes(profile.inferenceStatus)
      ) {
        state.characterFunctionPollAttempts = 0;
        return;
      }
      if (profile.inferenceStatus === "uninitialized" && state.characterFunctionPollAttempts >= 2) return;
      state.characterFunctionPollAttempts += 1;
      state.characterFunctionPollTimer = setTimeout(() => {
        state.characterFunctionPollTimer = null;
        void loadCharacterFunction(true);
      }, 1200);
    }

    function characterFunctionStatus(profile, soulOutdated) {
      if (profile.manualLocked) {
        return { label: soulOutdated ? "手动维护 · 人设已变化" : "手动维护", className: "" };
      }
      if (profile.inferenceStatus === "pending") {
        return { label: "正在分析", className: "pending" };
      }
      if (profile.inferenceStatus === "failed") {
        return { label: "分析失败", className: "failed" };
      }
      if (profile.inferenceStatus === "ready") {
        return { label: soulOutdated ? "等待同步人设" : "自动维护中", className: "ready" };
      }
      return { label: "等待分析", className: "" };
    }

    function renderCharacterFunction() {
      const snapshot = state.characterFunction;
      if (!snapshot) {
        nodes.characterCapabilityList.innerHTML = "";
        nodes.characterCapabilityCount.textContent = "0 项";
        nodes.characterFunctionRole.textContent = "尚未形成";
        nodes.characterFunctionCapabilities.innerHTML = "";
        nodes.characterFunctionLearning.textContent = "";
        renderCharacterSkillDocument();
        return;
      }
      const profile = snapshot.profile || {};
      const selected = new Map((snapshot.capabilities || []).map((entry) => [entry.capabilityId, entry]));
      const evidence = new Map((snapshot.evidence || []).map((entry) => [entry.capabilityId, entry]));
      const evolution = new Map((snapshot.evolution || []).map((entry) => [entry.capabilityId, entry]));
      const openCapabilities = new Set(state.characterFunctionOpenCapabilities || []);
      const modules = Array.isArray(snapshot.modules) ? snapshot.modules : [];
      const catalog = new Map((snapshot.catalog || []).map((entry) => [entry.id, entry]));
      const status = characterFunctionStatus(profile, Boolean(snapshot.soulOutdated));
      const evidenceCount = (snapshot.evidence || []).reduce(
        (total, entry) => total + Number(entry.total || 0),
        0
      );
      const activeSkill = (snapshot.activeSkills || [])[0];
      nodes.characterFunctionAutomatic.checked = !profile.manualLocked;
      nodes.characterFunctionAutomatic.disabled = profile.inferenceStatus === "pending";
      nodes.refreshCharacterFunctionBtn.disabled = profile.inferenceStatus === "pending";
      nodes.characterFunctionRole.textContent = profile.publicRole || "尚未形成";
      nodes.characterFunctionStatusBadge.textContent = status.label;
      nodes.characterFunctionStatusBadge.className =
        "function-status-badge" + (status.className ? " " + status.className : "");
      nodes.characterFunctionCapabilities.innerHTML = (snapshot.capabilities || []).length
        ? (snapshot.capabilities || []).map((capability) => {
            const learned = evolution.get(capability.capabilityId);
            const label = catalog.get(capability.capabilityId)?.label || capability.capabilityId;
            const level = Number(learned?.effectiveLevel || capability.level || 1);
            return '<span class="function-capability-chip' +
              (capability.responsibility === "primary" ? ' primary' : '') + '">' +
              escapeHtml(label) + ' · ' + level + '级</span>';
          }).join("")
        : '<span class="muted">暂未识别专业能力</span>';
      nodes.characterFunctionLearning.textContent = [
        "能力证据 " + evidenceCount + " 条",
        activeSkill ? "Skill v" + activeSkill.version : "Skill 未生成",
        profile.manualLocked ? "手动配置" : "角色自动演进"
      ].join(" · ");
      if (profile.inferenceStatus === "pending") {
        nodes.characterFunctionState.textContent = "正在根据 SOUL.md 分析...";
      } else if (profile.inferenceStatus === "failed") {
        nodes.characterFunctionState.textContent = profile.inferenceError || "自动分析失败";
      } else if (snapshot.soulOutdated && profile.manualLocked) {
        nodes.characterFunctionState.textContent = "SOUL.md 已变化，当前保留手动设置";
      } else {
        nodes.characterFunctionState.textContent = "";
      }
      renderCharacterSkillDocument();
      nodes.characterPublicRole.value = profile.publicRole || "";
      nodes.characterTaskPreferences.value = profile.taskPreferences || "";
      nodes.characterAvoidedTasks.value = profile.avoidedTasks || "";
      nodes.characterMaxConcurrentTasks.value = String(profile.maxConcurrentTasks || 1);
      nodes.characterCapabilityList.innerHTML = (snapshot.catalog || []).map((definition) => {
        const capability = selected.get(definition.id);
        const enabled = Boolean(capability);
        const responsibility = capability?.responsibility || "support";
        const bound = new Set(capability?.moduleIds || []);
        const recommended = new Set(definition.recommendedModuleIds || []);
        const result = evidence.get(definition.id);
        const evidenceText = result
          ? "证据 " + Number(result.completed || 0) + "/" + Number(result.total || 0) + " 次完成"
          : "暂无任务证据";
        const orderedModules = [...modules].sort((left, right) =>
          Number(recommended.has(right.id)) - Number(recommended.has(left.id)) ||
          String(left.name).localeCompare(String(right.name), "zh-CN")
        );
        const moduleOptions = orderedModules.map((module) =>
          '<label class="capability-module-option' + (recommended.has(module.id) ? ' recommended' : '') + '">' +
            '<input type="checkbox" data-capability-module="' + escapeHtml(module.id) + '"' +
              (bound.has(module.id) ? ' checked' : '') + (enabled ? '' : ' disabled') + ' />' +
            '<span title="' + escapeHtml(module.id) + '">' + escapeHtml(module.name) + '</span>' +
            '<small class="' + (module.enabled ? 'on' : '') + '">' +
              (module.enabled ? '已启用' : '已关闭') + '</small>' +
          '</label>'
        ).join("");
        const levelOptions = [1, 2, 3, 4, 5].map((level) =>
          '<option value="' + level + '"' + (Number(capability?.level || 3) === level ? ' selected' : '') + '>' +
            level + ' 级</option>'
        ).join("");
        return '<article class="capability-row' + (enabled ? ' enabled' : '') + '" data-capability-id="' +
            escapeHtml(definition.id) + '" data-responsibility="' + escapeHtml(responsibility) + '">' +
          '<div class="capability-row-main">' +
            '<label class="capability-identity">' +
              '<input type="checkbox" data-capability-enabled' + (enabled ? ' checked' : '') + ' />' +
              '<span class="capability-copy"><strong>' + escapeHtml(definition.label) + '</strong>' +
                '<span>' + escapeHtml(definition.description) + '</span>' +
                '<span class="capability-evidence">' + escapeHtml(evidenceText) + '</span></span>' +
            '</label>' +
            '<div class="capability-controls">' +
              '<label class="capability-level">等级<select data-capability-level' + (enabled ? '' : ' disabled') + '>' +
                levelOptions + '</select></label>' +
              '<div class="segmented capability-responsibility" role="group" aria-label="' +
                escapeHtml(definition.label) + '职责">' +
                '<button type="button" data-capability-responsibility="primary" class="' +
                  (responsibility === "primary" ? 'active' : '') + '"' + (enabled ? '' : ' disabled') + '>主责</button>' +
                '<button type="button" data-capability-responsibility="support" class="' +
                  (responsibility === "support" ? 'active' : '') + '"' + (enabled ? '' : ' disabled') + '>协助</button>' +
              '</div>' +
              '<label class="toggle capability-auto"><span>自动接单</span>' +
                '<input type="checkbox" data-capability-auto' + (capability?.autoAccept ? ' checked' : '') +
                  (enabled ? '' : ' disabled') + ' /></label>' +
            '</div>' +
          '</div>' +
          '<details class="capability-bindings"' + (openCapabilities.has(definition.id) ? ' open' : '') + '>' +
            '<summary><i data-lucide="boxes" aria-hidden="true"></i><span>模块绑定 · <b data-binding-count>' +
              bound.size + '</b></span></summary>' +
            '<div class="capability-binding-body">' +
              '<div class="capability-module-grid">' + moduleOptions + '</div>' +
              '<label class="capability-notes">维护备注<textarea data-capability-notes maxlength="500"' +
                (enabled ? '' : ' disabled') + '>' + escapeHtml(capability?.notes || "") + '</textarea></label>' +
            '</div>' +
          '</details>' +
        '</article>';
      }).join("");
      updateCharacterCapabilityCount();
      refreshIcons();
    }

    function renderCharacterSkillDocument() {
      const snapshotActive = (state.characterFunction?.activeSkills || [])[0];
      const versions = (state.characterSkillVersions || [])
        .filter((entry) => entry && entry.status !== "rejected");
      if (!versions.length && snapshotActive) versions.push(snapshotActive);
      const active = versions.find((entry) => entry.status === "active") || snapshotActive;
      let selected = active;
      if (state.characterSkillViewingHistory) {
        selected = versions.find((entry) =>
          String(entry.version) === nodes.characterSkillVersionSelect.value) || active;
      }
      if (!selected) {
        nodes.characterSkillMeta.textContent = "尚未生成";
        nodes.characterSkillVersionSelect.innerHTML = '<option value="">无版本</option>';
        nodes.characterSkillVersionSelect.disabled = true;
        nodes.activateCharacterSkillVersionBtn.hidden = true;
        nodes.characterSkillMarkdown.innerHTML =
          '<div class="character-skill-empty">尚未生成 Skill</div>';
        return;
      }
      const sourceLabels = {
        bootstrap: "人设初始化",
        character_reflection: "角色复盘",
        manual: "手动配置"
      };
      nodes.characterSkillVersionSelect.innerHTML = versions.map((entry) =>
        '<option value="' + Number(entry.version) + '"' +
          (entry.version === selected.version ? ' selected' : '') + '>' +
          'v' + Number(entry.version) + (entry.status === "active" ? ' · 当前' : '') +
        '</option>'
      ).join("");
      nodes.characterSkillVersionSelect.disabled = versions.length < 2;
      nodes.activateCharacterSkillVersionBtn.hidden = selected.status === "active";
      nodes.activateCharacterSkillVersionBtn.dataset.version = String(selected.version);
      const createdAt = selected.createdAt ? new Date(selected.createdAt) : null;
      const timeLabel = createdAt && !Number.isNaN(createdAt.getTime())
        ? createdAt.toLocaleString("zh-CN")
        : "";
      nodes.characterSkillMeta.textContent = [
        "v" + Number(selected.version),
        sourceLabels[selected.source] || selected.source,
        selected.changeSummary || "",
        timeLabel
      ].filter(Boolean).join(" · ");
      nodes.characterSkillMarkdown.innerHTML = renderMarkdown(selected.markdown || "");
      refreshIcons();
    }

    function inspectCharacterSkillVersion() {
      state.characterSkillViewingHistory = true;
      renderCharacterSkillDocument();
    }

    async function activateCharacterSkillVersion() {
      const characterId = state.workspaceCharacterId;
      const version = Number(nodes.activateCharacterSkillVersionBtn.dataset.version || 0);
      if (!characterId || !Number.isInteger(version) || version < 1) return;
      nodes.activateCharacterSkillVersionBtn.disabled = true;
      nodes.characterFunctionState.textContent = "正在恢复 Skill...";
      try {
        const response = await fetch(
          "/api/v1/characters/" + encodeURIComponent(characterId) +
            "/skill-versions/" + encodeURIComponent(String(version)) + "/activate",
          { method: "POST" }
        );
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Skill 恢复失败");
        if (state.workspaceCharacterId !== characterId) return;
        state.characterSkillViewingHistory = false;
        state.characterFunction = body.functionProfile || state.characterFunction;
        await loadCharacterFunction(true);
        nodes.characterFunctionState.textContent = "已恢复 Skill v" + version;
      } catch (error) {
        nodes.characterFunctionState.textContent = error.message || String(error);
      } finally {
        nodes.activateCharacterSkillVersionBtn.disabled = false;
      }
    }

    function updateCharacterCapabilityControls(event) {
      const row = event.target.closest("[data-capability-id]");
      if (!row) return;
      if (event.target.matches("[data-capability-enabled]")) {
        const enabled = event.target.checked;
        row.classList.toggle("enabled", enabled);
        row.querySelectorAll(
          "select, textarea, input:not([data-capability-enabled]), button[data-capability-responsibility]"
        ).forEach((control) => { control.disabled = !enabled; });
      }
      const count = row.querySelectorAll("input[data-capability-module]:checked").length;
      const countNode = row.querySelector("[data-binding-count]");
      if (countNode) countNode.textContent = String(count);
      updateCharacterCapabilityCount();
    }

    function setCharacterCapabilityResponsibility(event) {
      const button = event.target.closest("button[data-capability-responsibility]");
      if (!button || button.disabled) return;
      const row = button.closest("[data-capability-id]");
      if (!row) return;
      row.dataset.responsibility = button.dataset.capabilityResponsibility || "support";
      row.querySelectorAll("button[data-capability-responsibility]").forEach((entry) => {
        entry.classList.toggle("active", entry === button);
      });
    }

    function updateCharacterCapabilityCount() {
      const count = nodes.characterCapabilityList.querySelectorAll(
        "[data-capability-enabled]:checked"
      ).length;
      nodes.characterCapabilityCount.textContent = count + " 项";
    }

    async function updateCharacterFunctionAutomation() {
      const characterId = state.workspaceCharacterId;
      if (!characterId) return;
      const automatic = nodes.characterFunctionAutomatic.checked;
      nodes.characterFunctionAutomatic.disabled = true;
      nodes.refreshCharacterFunctionBtn.disabled = true;
      nodes.characterFunctionState.textContent = automatic ? "正在启用自动维护..." : "正在切换为手动维护...";
      try {
        const response = await fetch(
          "/api/v1/characters/" + encodeURIComponent(characterId) + "/function-profile/automation",
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ automatic })
          }
        );
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "自动维护设置失败");
        if (state.workspaceCharacterId !== characterId) return;
        state.characterSkillViewingHistory = false;
        state.characterFunction = body.functionProfile || null;
        await loadCharacterFunction(true);
        nodes.characterFunctionState.textContent = automatic ? "自动维护已启用" : "已切换为手动维护";
      } catch (error) {
        const message = error.message || String(error);
        await loadCharacterFunction(true);
        nodes.characterFunctionState.textContent = message;
      } finally {
        nodes.characterFunctionAutomatic.disabled = false;
        nodes.refreshCharacterFunctionBtn.disabled = false;
      }
    }

    async function refreshCharacterFunction() {
      const characterId = state.workspaceCharacterId;
      if (!characterId) return;
      nodes.characterFunctionAutomatic.disabled = true;
      nodes.refreshCharacterFunctionBtn.disabled = true;
      nodes.characterFunctionState.textContent = "正在根据 SOUL.md 重新分析...";
      try {
        const response = await fetch(
          "/api/v1/characters/" + encodeURIComponent(characterId) + "/function-profile/infer",
          { method: "POST" }
        );
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "角色职能分析失败");
        if (state.workspaceCharacterId !== characterId) return;
        state.characterSkillViewingHistory = false;
        state.characterFunction = body.functionProfile || null;
        await loadCharacterFunction(true);
        nodes.characterFunctionState.textContent = "已根据 SOUL.md 更新";
      } catch (error) {
        const message = error.message || String(error);
        await loadCharacterFunction(true);
        nodes.characterFunctionState.textContent = message;
      } finally {
        nodes.characterFunctionAutomatic.disabled = false;
        nodes.refreshCharacterFunctionBtn.disabled = false;
      }
    }

    async function saveCharacterFunction(event) {
      event.preventDefault();
      const characterId = state.workspaceCharacterId;
      if (!characterId) return;
      const capabilities = [...nodes.characterCapabilityList.querySelectorAll(
        "[data-capability-id]"
      )].filter((row) => row.querySelector("[data-capability-enabled]")?.checked).map((row) => ({
        capabilityId: row.dataset.capabilityId,
        level: Number(row.querySelector("[data-capability-level]")?.value || 3),
        responsibility: row.dataset.responsibility || "support",
        autoAccept: Boolean(row.querySelector("[data-capability-auto]")?.checked),
        moduleIds: [...row.querySelectorAll("input[data-capability-module]:checked")]
          .map((input) => input.dataset.capabilityModule),
        notes: row.querySelector("[data-capability-notes]")?.value.trim() || ""
      }));
      const payload = {
        publicRole: nodes.characterPublicRole.value.trim(),
        taskPreferences: nodes.characterTaskPreferences.value.trim(),
        avoidedTasks: nodes.characterAvoidedTasks.value.trim(),
        maxConcurrentTasks: Number(nodes.characterMaxConcurrentTasks.value || 1),
        manualLocked: true,
        capabilities
      };
      state.characterFunctionOpenCapabilities = [...nodes.characterCapabilityList.querySelectorAll(
        "details.capability-bindings[open]"
      )].map((details) => details.closest("[data-capability-id]")?.dataset.capabilityId).filter(Boolean);
      nodes.saveCharacterFunctionBtn.disabled = true;
      nodes.characterFunctionState.textContent = "保存中...";
      try {
        const response = await fetch(
          "/api/v1/characters/" + encodeURIComponent(characterId) + "/function-profile",
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload)
          }
        );
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "职责能力保存失败");
        if (state.workspaceCharacterId !== characterId) return;
        state.characterFunction = body.functionProfile || null;
        state.characterSkillViewingHistory = false;
        await loadCharacterFunction(true);
        nodes.characterFunctionState.textContent = "已保存 · 手动维护";
      } catch (error) {
        nodes.characterFunctionState.textContent = error.message || String(error);
      } finally {
        nodes.saveCharacterFunctionBtn.disabled = false;
      }
    }

    async function loadWorlds() {
      const response = await fetch("/api/v1/worlds");
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "世界加载失败");
      state.worlds = Array.isArray(body.worlds) ? body.worlds : [];
      renderWorldOptions();
      return state.worlds;
    }

    function renderWorldOptions() {
      const characterWorldBefore = state.characterLife?.membership?.worldId || nodes.characterWorldSelect.value;
      const managerBefore = state.worldEditorId || nodes.worldManagerWorldSelect.value;
      const directorBefore = nodes.worldDirectorModelProfile.value;
      const analystBefore = nodes.worldAnalystModelProfile.value;
      const options = state.worlds.map((world) =>
        '<option value="' + escapeHtml(world.id) + '">' + escapeHtml(world.name) + '</option>'
      ).join("");
      const modelOptions = state.modelProfiles.map((profile) =>
        '<option value="' + escapeHtml(profile.id) + '">' + escapeHtml(profile.name) + (profile.isDefault ? '（默认）' : '') + '</option>'
      ).join("");
      nodes.characterWorldSelect.innerHTML = '<option value="">不加入共享世界</option>' + options;
      nodes.characterWorldSelect.value = state.worlds.some((world) => world.id === characterWorldBefore)
        ? characterWorldBefore
        : "";
      nodes.worldManagerWorldSelect.innerHTML = '<option value="">新建世界</option>' + options;
      nodes.worldManagerWorldSelect.value = state.worlds.some((world) => world.id === managerBefore)
        ? managerBefore
        : "";
      nodes.worldDirectorModelProfile.innerHTML = '<option value="">继承系统默认模型</option>' + modelOptions;
      nodes.worldAnalystModelProfile.innerHTML = '<option value="">跟随世界演绎模型</option>' + modelOptions;
      nodes.worldDirectorModelProfile.value = state.modelProfiles.some((profile) => profile.id === directorBefore) ? directorBefore : "";
      nodes.worldAnalystModelProfile.value = state.modelProfiles.some((profile) => profile.id === analystBefore) ? analystBefore : "";
      renderWorldCards();
    }

    async function loadCharacterLife() {
      if (!state.workspaceCharacterId) return;
      nodes.characterLifeState.textContent = "加载中...";
      try {
        await loadWorlds();
        const response = await fetch("/api/v1/characters/" + encodeURIComponent(state.workspaceCharacterId) + "/life");
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "角色生活状态加载失败");
        state.characterLife = body.life || null;
        nodes.characterLifeState.textContent = "";
        renderCharacterLife();
      } catch (error) {
        nodes.characterLifeState.textContent = error.message || String(error);
      }
    }

    function renderCharacterLife() {
      const life = state.characterLife;
      const assigned = Boolean(life?.membership && life?.world);
      renderWorldOptions();
      nodes.characterWorldSelect.value = life?.membership?.worldId || "";
      nodes.characterLifeEmpty.hidden = assigned;
      nodes.characterLifeContent.hidden = !assigned;
      if (!assigned) return;
      const placeMap = new Map((life.places || []).map((place) => [place.id, place]));
      const runtimePlace = placeMap.get(life.runtime?.placeId);
      const availabilityLabels = { free: "空闲", busy: "忙碌", resting: "休息中", traveling: "在路上" };
      nodes.lifeCurrentPlace.textContent = runtimePlace?.name || "未设置";
      nodes.lifeCurrentActivity.textContent = life.runtime?.activity || "自由活动";
      nodes.lifeAvailability.textContent = availabilityLabels[life.runtime?.availability] || "未知";
      nodes.lifeEnergy.textContent = String(life.runtime?.energy ?? 70);
      const placeOptions = (life.places || []).map((place) =>
        '<option value="' + escapeHtml(place.id) + '">' + escapeHtml(place.name) + '</option>'
      ).join("");
      nodes.lifeHomePlace.innerHTML = '<option value="">未设置</option>' + placeOptions;
      nodes.lifeRuntimePlace.innerHTML = '<option value="">未设置</option>' + placeOptions;
      nodes.lifeHomePlace.value = life.membership?.homePlaceId || "";
      nodes.lifeRuntimePlace.value = life.runtime?.placeId || "";
      nodes.lifeAutonomyEnabled.checked = Boolean(life.policy?.enabled);
      nodes.lifeProactiveEnabled.checked = Boolean(life.policy?.proactiveEnabled);
      nodes.lifeSocialEnabled.checked = Boolean(life.policy?.socialEnabled);
      nodes.lifeDailyMessageLimit.value = String(life.policy?.dailyMessageLimit ?? 1);
      nodes.lifeProactiveCooldown.value = String(life.policy?.proactiveCooldownMinutes ?? 120);
      nodes.lifeSocialDailyLimit.value = String(life.policy?.socialDailyLimit ?? 1);
      nodes.lifeSocialCooldown.value = String(life.policy?.socialCooldownMinutes ?? 240);
      nodes.lifeQuietStart.value = life.policy?.quietStart || "23:00";
      nodes.lifeQuietEnd.value = life.policy?.quietEnd || "08:00";
      const pausedUntil = life.policy?.proactivePausedUntil ? new Date(life.policy.proactivePausedUntil) : null;
      const activelyPaused = pausedUntil && Number.isFinite(pausedUntil.getTime()) && pausedUntil.getTime() > Date.now();
      nodes.lifeProactivePause.hidden = !activelyPaused;
      nodes.lifeProactivePauseText.textContent = activelyPaused
        ? "主动消息已暂停至 " + pausedUntil.toLocaleString("zh-CN")
        : "";
      nodes.planCharacterLifeBtn.disabled = !life.policy?.enabled || !(life.places || []).length;
      nodes.simulateCharacterMomentBtn.disabled = !(life.places || []).length;
      nodes.lifePlaceList.innerHTML = (life.places || []).length
        ? life.places.map((place) => '<div class="life-place-row"><strong>' + escapeHtml(place.name) + '</strong>' +
            (place.description ? '<p>' + escapeHtml(place.description) + '</p>' : '') +
            '<div class="life-capabilities">' + (place.capabilityIds || []).map((id) =>
              '<span>' + escapeHtml(worldCapabilityLabels[id] || id) + '</span>').join("") + '</div></div>').join("")
        : '<div class="life-empty-row">这个世界还没有地点</div>';
      nodes.lifeEventList.innerHTML = (life.events || []).length
        ? life.events.slice(0, 8).map((event) => '<div class="life-event-row"><strong>' + escapeHtml(event.summary) + '</strong>' +
            '<time>' + escapeHtml(new Date(event.startsAt).toLocaleString("zh-CN")) + '</time></div>').join("")
        : '<div class="life-empty-row">还没有发生生活事件</div>';
      nodes.lifeProactiveList.innerHTML = (life.proactiveMessages || []).length
        ? life.proactiveMessages.slice(0, 12).map((message) => {
            const score = Math.round(Number(message.candidateScore || 0) * 100);
            const tone = message.status === "delivered" ? "delivered" : message.status === "failed" ? "failed" : message.status;
            const detail = message.lastError || proactiveDecisionHint(message);
            return '<div class="life-proactive-row"><div class="life-proactive-row-head"><strong>' + escapeHtml(message.topicLabel || "角色近况") + '</strong>' +
              '<span class="life-decision-badge ' + escapeHtml(tone) + '">' + escapeHtml(proactiveDecisionLabel(message.decisionCode)) + '</span></div>' +
              (detail ? '<p>' + escapeHtml(detail) + '</p>' : '') +
              '<div class="life-proactive-meta"><span>评分 ' + score + '</span><span>·</span><span>' +
                escapeHtml(new Date(message.updatedAt || message.createdAt).toLocaleString("zh-CN")) + '</span>' +
                (message.feedbackType ? '<span>· ' + escapeHtml(proactiveFeedbackLabel(message.feedbackType)) + '</span>' : '') + '</div></div>';
          }).join("")
        : '<div class="life-empty-row">暂无主动消息候选</div>';
      const topicPolicies = new Map((life.proactiveTopicPolicies || []).map((policy) => [policy.topicKey, policy]));
      (life.proactiveMessages || []).forEach((message) => {
        if (!topicPolicies.has(message.topicKey)) topicPolicies.set(message.topicKey, {
          characterId: message.characterId,
          topicKey: message.topicKey,
          topicLabel: message.topicLabel,
          mode: "normal",
          helpfulCount: 0,
          lessOftenCount: 0
        });
      });
      nodes.lifeTopicPolicyList.innerHTML = topicPolicies.size
        ? [...topicPolicies.values()].sort((left, right) => proactiveTopicModeRank(left.mode) - proactiveTopicModeRank(right.mode) ||
            String(left.topicLabel).localeCompare(String(right.topicLabel), "zh-CN")).map((policy) =>
            '<div class="life-topic-policy-row"><div><strong>' + escapeHtml(policy.topicLabel || policy.topicKey) + '</strong>' +
              '<div class="life-topic-mode">' + escapeHtml(proactiveTopicModeLabel(policy.mode)) +
              ' · 有帮助 ' + Number(policy.helpfulCount || 0) + ' · 减少 ' + Number(policy.lessOftenCount || 0) + '</div></div>' +
              (policy.mode !== "normal"
                ? '<button class="secondary icon-button" type="button" data-proactive-topic-reset="' + escapeHtml(encodeURIComponent(policy.topicKey)) + '" title="恢复默认频率" aria-label="恢复默认频率"><i data-lucide="rotate-ccw" aria-hidden="true"></i></button>'
                : '<span></span>') + '</div>'
          ).join("")
        : '<div class="life-empty-row">反馈后可在这里管理主题频率</div>';
      refreshIcons();
    }

    function proactiveDecisionLabel(code) {
      return ({
        queued: "等待评估", candidate_ready: "可发送", ranked_behind: "优先级靠后",
        quiet_hours: "安静时段", daily_limit: "今日额度已满", global_cooldown: "全局冷却",
        topic_cooldown: "主题冷却", recent_user_activity: "用户刚活跃", conversation_busy: "会话忙碌",
        co_present: "见面中", paused: "已暂停", retry_cooldown: "等待重试", low_score: "评分不足",
        topic_muted: "主题已屏蔽", stale: "候选已过期", event_missing: "事件缺失",
        policy_disabled: "主动消息关闭", world_changed: "世界已切换", character_declined: "角色未发送", model_failed: "生成失败",
        delivered: "已发送"
      })[code] || code || "未知";
    }

    function proactiveDecisionHint(message) {
      const details = message?.decisionDetails || {};
      if (details.availableAfter) return "最早可在 " + new Date(details.availableAfter).toLocaleString("zh-CN") + " 再评估";
      if (details.pausedUntil) return "暂停至 " + new Date(details.pausedUntil).toLocaleString("zh-CN");
      if (details.reason) return String(details.reason);
      return message.text ? String(message.text).slice(0, 120) : "";
    }

    function proactiveFeedbackLabel(value) {
      return ({ helpful: "有帮助", less_often: "希望少一点", mute_topic: "已屏蔽主题", pause_24h: "暂停 24 小时" })[value] || value;
    }

    function proactiveTopicModeLabel(value) {
      return ({ normal: "正常频率", reduced: "降低频率", muted: "已屏蔽" })[value] || value;
    }

    function proactiveTopicModeRank(value) {
      return value === "muted" ? 0 : value === "reduced" ? 1 : 2;
    }

    async function saveCharacterWorld() {
      if (!state.workspaceCharacterId) return;
      nodes.characterLifeState.textContent = "保存中...";
      try {
        const response = await fetch("/api/v1/characters/" + encodeURIComponent(state.workspaceCharacterId) + "/life", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ worldId: nodes.characterWorldSelect.value || null })
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "世界归属保存失败");
        state.characterLife = body.life;
        nodes.characterLifeState.textContent = nodes.characterWorldSelect.value ? "已加入世界" : "已离开世界";
        renderCharacterLife();
      } catch (error) {
        nodes.characterLifeState.textContent = error.message || String(error);
      }
    }

    async function saveCharacterLife() {
      if (!state.workspaceCharacterId || !state.characterLife?.membership) return;
      nodes.characterLifeState.textContent = "保存中...";
      nodes.saveCharacterLifeBtn.disabled = true;
      try {
        const response = await fetch("/api/v1/characters/" + encodeURIComponent(state.workspaceCharacterId) + "/life", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            homePlaceId: nodes.lifeHomePlace.value || null,
            currentPlaceId: nodes.lifeRuntimePlace.value || null,
            policy: {
              enabled: nodes.lifeAutonomyEnabled.checked,
              proactiveEnabled: nodes.lifeProactiveEnabled.checked,
              socialEnabled: nodes.lifeSocialEnabled.checked,
              dailyMessageLimit: Number(nodes.lifeDailyMessageLimit.value || 0),
              proactiveCooldownMinutes: Number(nodes.lifeProactiveCooldown.value || 120),
              socialDailyLimit: Number(nodes.lifeSocialDailyLimit.value || 0),
              socialCooldownMinutes: Number(nodes.lifeSocialCooldown.value || 240),
              quietStart: nodes.lifeQuietStart.value || "23:00",
              quietEnd: nodes.lifeQuietEnd.value || "08:00"
            }
          })
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "生活设置保存失败");
        state.characterLife = body.life;
        nodes.characterLifeState.textContent = "已保存";
        renderCharacterLife();
      } catch (error) {
        nodes.characterLifeState.textContent = error.message || String(error);
      } finally {
        nodes.saveCharacterLifeBtn.disabled = false;
      }
    }

    async function planCharacterLife() {
      if (!state.workspaceCharacterId) return;
      nodes.characterLifeState.textContent = "正在安排...";
      nodes.planCharacterLifeBtn.disabled = true;
      try {
        const response = await fetch("/api/v1/characters/" + encodeURIComponent(state.workspaceCharacterId) + "/life/plan", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ force: true })
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "生活日程规划失败");
        const completedState = "已安排 " + (body.result?.plans?.length || 0) + " 项" + (body.result?.fallbackUsed ? "（未生成可用安排）" : "");
        await loadCharacterLife();
        nodes.characterLifeState.textContent = completedState;
      } catch (error) {
        nodes.characterLifeState.textContent = error.message || String(error);
      } finally {
        nodes.planCharacterLifeBtn.disabled = !state.characterLife?.policy?.enabled;
      }
    }

    async function simulateCharacterMoment() {
      if (!state.workspaceCharacterId) return;
      nodes.characterLifeState.textContent = "正在推进生活片段...";
      nodes.simulateCharacterMomentBtn.disabled = true;
      try {
        const response = await fetch("/api/v1/characters/" + encodeURIComponent(state.workspaceCharacterId) + "/life/moment", { method: "POST" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "生活片段推进失败");
        const completedState = body.result?.proactiveMessage?.status === "delivered"
          ? "片段已发生，并已主动发出消息"
          : "片段已发生";
        await Promise.all([loadCharacterLife(), refreshConversationMetadata()]);
        nodes.characterLifeState.textContent = completedState;
      } catch (error) {
        nodes.characterLifeState.textContent = error.message || String(error);
      } finally {
        nodes.simulateCharacterMomentBtn.disabled = !(state.characterLife?.places || []).length;
      }
    }

    async function resumeProactiveMessages() {
      if (!state.workspaceCharacterId) return;
      nodes.resumeProactiveBtn.disabled = true;
      nodes.characterLifeState.textContent = "正在恢复...";
      try {
        const response = await fetch("/api/v1/characters/" + encodeURIComponent(state.workspaceCharacterId) + "/life/proactive/resume", { method: "POST" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "主动消息恢复失败");
        await loadCharacterLife();
        nodes.characterLifeState.textContent = "主动消息已恢复";
      } catch (error) {
        nodes.characterLifeState.textContent = error.message || String(error);
      } finally {
        nodes.resumeProactiveBtn.disabled = false;
      }
    }

    async function resetProactiveTopic(event) {
      const button = event.target.closest("button[data-proactive-topic-reset]");
      if (!button || !state.workspaceCharacterId) return;
      const topicKey = decodeURIComponent(button.dataset.proactiveTopicReset || "");
      if (!topicKey) return;
      button.disabled = true;
      try {
        const response = await fetch("/api/v1/characters/" + encodeURIComponent(state.workspaceCharacterId) +
          "/life/proactive-topics/" + encodeURIComponent(topicKey) + "/reset", { method: "POST" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "主题偏好恢复失败");
        await loadCharacterLife();
        nodes.characterLifeState.textContent = "主题已恢复默认频率";
      } catch (error) {
        nodes.characterLifeState.textContent = error.message || String(error);
        button.disabled = false;
      }
    }

    async function openWorldManager(preferredWorldId = "") {
      nodes.worldManagerState.textContent = "加载中...";
      nodes.worldManagerDialog.showModal();
      setWorldManagerBusy(true);
      refreshIcons();
      try {
        await loadWorlds();
        const preferred = state.worlds.some((world) => world.id === preferredWorldId) ? preferredWorldId : "";
        if (preferred) await loadWorldEditor(preferred);
        else resetWorldEditor();
        nodes.worldManagerState.textContent = "";
      } catch (error) {
        nodes.worldManagerState.textContent = error.message || String(error);
      } finally {
        setWorldManagerBusy(false);
      }
    }

    function setWorldManagerBusy(busy) {
      nodes.worldManagerDialog.querySelectorAll(".world-manager-body input, .world-manager-body textarea, .world-manager-body select, .world-manager-body button")
        .forEach((control) => { control.disabled = busy; });
      nodes.worldManagerDialog.querySelector(".world-manager-body")?.setAttribute("aria-busy", String(busy));
    }

    async function closeWorldManager() {
      if (state.workspaceCharacterId && state.characterTab === "life") await loadCharacterLife();
      if (nodes.worldManagerDialog.open) nodes.worldManagerDialog.close();
    }

    async function selectWorldEditor() {
      const id = nodes.worldManagerWorldSelect.value;
      if (id) await loadWorldEditor(id);
      else resetWorldEditor();
    }

    async function loadWorldEditor(id) {
      const response = await fetch("/api/v1/worlds/" + encodeURIComponent(id));
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "世界详情加载失败");
      state.worldEditorId = body.world.id;
      state.worldEditorPlaces = Array.isArray(body.places) ? body.places : [];
      state.placeEditorId = "";
      nodes.worldManagerWorldSelect.value = state.worldEditorId;
      nodes.worldName.value = body.world.name || "";
      nodes.worldTimezone.value = body.world.timezone || "Asia/Shanghai";
      nodes.worldDirectorModelProfile.value = body.world.directorModelProfileId || "";
      nodes.worldAnalystModelProfile.value = body.world.analystModelProfileId || "";
      nodes.worldDescription.value = body.world.description || "";
      nodes.worldRules.value = body.world.rulesMarkdown || "";
      nodes.saveWorldBtn.textContent = "保存世界";
      renderWorldCardSummary(body.world);
      nodes.worldPlacesSection.hidden = false;
      resetPlaceEditor();
      renderWorldPlaces();
    }

    function resetWorldEditor() {
      state.worldEditorId = "";
      state.worldEditorPlaces = [];
      state.placeEditorId = "";
      nodes.worldManagerWorldSelect.value = "";
      nodes.worldForm.reset();
      nodes.worldTimezone.value = "Asia/Shanghai";
      nodes.worldDirectorModelProfile.value = "";
      nodes.worldAnalystModelProfile.value = "";
      nodes.saveWorldBtn.textContent = "创建世界";
      nodes.worldCardSummary.hidden = true;
      nodes.worldCardSummary.innerHTML = "";
      nodes.worldPlacesSection.hidden = true;
      nodes.worldPlaceList.innerHTML = "";
      nodes.worldManagerState.textContent = "";
      nodes.worldName.focus();
    }

    function renderWorldCardSummary(world) {
      const conversation = state.worldConversations.find((entry) => entry.worldId === world.id);
      const members = conversation?.characterIds || [];
      const event = conversation?.activeEvent;
      const participantNames = (event?.participantIds || []).map((id) =>
        state.characters.find((character) => character.id === id)?.name || id
      );
      const eventText = event
        ? (event.status === "planned" ? "待开始" : "进行中") + " · " + event.title +
          (participantNames.length ? " · " + participantNames.join("、") : "")
        : "当前无进行中的事件";
      nodes.worldCardSummary.innerHTML =
        '<div class="world-card-members">' + worldAvatarCluster(conversation, "compact") +
          '<div><span>世界成员</span><strong>' +
          members.length + ' 位角色</strong></div></div>' +
        '<div><span>当前事件</span><strong>' + escapeHtml(eventText) + '</strong></div>';
      nodes.worldCardSummary.hidden = false;
      refreshIcons();
    }

    async function saveWorld(event) {
      event.preventDefault();
      nodes.saveWorldBtn.disabled = true;
      nodes.worldManagerState.textContent = "保存中...";
      try {
        const editing = state.worldEditorId;
        const response = await fetch(editing ? "/api/v1/worlds/" + encodeURIComponent(editing) : "/api/v1/worlds", {
          method: editing ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: nodes.worldName.value.trim(),
            timezone: nodes.worldTimezone.value.trim(),
            directorModelProfileId: nodes.worldDirectorModelProfile.value || null,
            analystModelProfileId: nodes.worldAnalystModelProfile.value || null,
            description: nodes.worldDescription.value,
            rulesMarkdown: nodes.worldRules.value
          })
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "世界保存失败");
        state.worldEditorId = body.world.id;
        await refreshWorldConversationList();
        await loadWorldEditor(body.world.id);
        nodes.worldManagerState.textContent = editing ? "已保存" : "已创建";
      } catch (error) {
        nodes.worldManagerState.textContent = error.message || String(error);
      } finally {
        nodes.saveWorldBtn.disabled = false;
      }
    }

    function renderWorldPlaces() {
      nodes.worldPlaceCount.textContent = state.worldEditorPlaces.length + " 个地点";
      nodes.worldPlaceList.innerHTML = state.worldEditorPlaces.length
        ? state.worldEditorPlaces.map((place) => '<div class="world-place-row"><div class="world-place-row-copy"><strong>' + escapeHtml(place.name) + '</strong>' +
            (place.description ? '<p>' + escapeHtml(place.description) + '</p>' : '') +
            '<div class="life-capabilities">' + (place.capabilityIds || []).map((id) => '<span>' + escapeHtml(worldCapabilityLabels[id] || id) + '</span>').join("") + '</div></div>' +
            '<div class="world-place-row-actions"><button class="secondary icon-button" type="button" data-world-place-edit="' + escapeHtml(place.id) + '" title="编辑地点" aria-label="编辑地点"><i data-lucide="pencil"></i></button>' +
            '<button class="secondary icon-button" type="button" data-world-place-delete="' + escapeHtml(place.id) + '" title="删除地点" aria-label="删除地点"><i data-lucide="trash-2"></i></button></div></div>').join("")
        : '<div class="life-empty-row">添加第一个地点后，角色才可以安排生活。</div>';
      refreshIcons();
    }

    function resetPlaceEditor() {
      state.placeEditorId = "";
      nodes.worldPlaceForm.reset();
      nodes.saveWorldPlaceBtn.textContent = "添加地点";
    }

    async function saveWorldPlace(event) {
      event.preventDefault();
      if (!state.worldEditorId) return;
      const capabilities = [...nodes.worldCapabilityOptions.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
      if (!capabilities.length) {
        nodes.worldManagerState.textContent = "至少选择一个地点功能";
        return;
      }
      nodes.saveWorldPlaceBtn.disabled = true;
      try {
        const editing = state.placeEditorId;
        const response = await fetch(editing
          ? "/api/v1/world-places/" + encodeURIComponent(editing)
          : "/api/v1/worlds/" + encodeURIComponent(state.worldEditorId) + "/places", {
          method: editing ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: nodes.worldPlaceName.value.trim(),
            description: nodes.worldPlaceDescription.value,
            capabilityIds: capabilities
          })
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "地点保存失败");
        await loadWorldEditor(state.worldEditorId);
        nodes.worldManagerState.textContent = editing ? "地点已更新" : "地点已添加";
      } catch (error) {
        nodes.worldManagerState.textContent = error.message || String(error);
      } finally {
        nodes.saveWorldPlaceBtn.disabled = false;
      }
    }

    async function handleWorldPlaceAction(event) {
      const edit = event.target.closest("button[data-world-place-edit]");
      if (edit) {
        const place = state.worldEditorPlaces.find((entry) => entry.id === edit.dataset.worldPlaceEdit);
        if (!place) return;
        state.placeEditorId = place.id;
        nodes.worldPlaceName.value = place.name || "";
        nodes.worldPlaceDescription.value = place.description || "";
        const selected = new Set(place.capabilityIds || []);
        nodes.worldCapabilityOptions.querySelectorAll('input[type="checkbox"]').forEach((input) => {
          input.checked = selected.has(input.value);
        });
        nodes.saveWorldPlaceBtn.textContent = "保存地点";
        nodes.worldPlaceName.focus();
        return;
      }
      const remove = event.target.closest("button[data-world-place-delete]");
      if (!remove) return;
      const place = state.worldEditorPlaces.find((entry) => entry.id === remove.dataset.worldPlaceDelete);
      if (!place) return;
      const deleted = await openActionDialog({
        title: "删除地点",
        description: "删除“" + place.name + "”后，引用该地点的旧事件仍会保留，但角色当前位置会变为未设置。",
        confirmLabel: "删除",
        onConfirm: async () => {
          const response = await fetch("/api/v1/world-places/" + encodeURIComponent(place.id), { method: "DELETE" });
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || "地点删除失败");
        }
      });
      if (deleted) await loadWorldEditor(state.worldEditorId);
    }

    async function loadRelationship() {
      if (!state.workspaceCharacterId) return;
      nodes.relationshipState.textContent = "加载中...";
      try {
        const response = await fetch("/api/v1/characters/" + encodeURIComponent(state.workspaceCharacterId) + "/relationship");
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "关系状态加载失败");
        state.relationship = body.relationship;
        nodes.relationshipState.textContent = "";
        renderRelationship();
      } catch (error) {
        nodes.relationshipState.textContent = error.message || String(error);
      }
    }

    function renderRelationship() {
      const snapshot = state.relationship;
      if (!snapshot?.state) {
        nodes.relationshipOverview.innerHTML = '<div class="relationship-empty">暂无关系状态</div>';
        nodes.relationshipEventList.innerHTML = "";
        return;
      }
      const current = snapshot.state;
      const stageLabels = {
        stranger: "陌生", acquaintance: "初识", familiar: "熟悉", close: "亲近", intimate: "亲密", strained: "紧张"
      };
      const romanceLabels = {
        none: "尚未建立浪漫关系",
        user_interest: "用户单方好感",
        character_interest: "角色单方好感",
        mutual_interest: "互有好感，尚未交往",
        dating: "交往中",
        committed: "稳定伴侣",
        former_partners: "曾经交往"
      };
      const bondLabels = {
        friendship: "朋友", confidant: "知己", companionship: "陪伴关系", partnership: "搭档",
        mentorship: "师生", rivalry: "对手", familial: "家人般的关系"
      };
      const affectLabels = {
        calm: "平静", warm: "温暖", happy: "愉快", excited: "兴奋", moved: "感动", shy: "害羞",
        worried: "担忧", sad: "难过", angry: "生气", hurt: "受伤", guarded: "戒备"
      };
      const metrics = [
        ["信任", current.trust, "cool"],
        ["亲近", current.closeness, ""],
        ["好感", current.affection, "warm"],
        ["尊重", current.respect, "cool"],
        ["张力", current.tension, "alert"]
      ];
      const affect = current.affect || {};
      const affectChips = [
        '倾向 ' + formatSignedDecimal(affect.valence),
        '唤醒 ' + Number(affect.arousal || 0).toFixed(2),
        '克制 ' + Number(affect.control || 0).toFixed(2),
        ...(affect.labels || []).map((label) => affectLabels[label] || label)
      ];
      const bonds = Array.isArray(current.bondFacets) ? current.bondFacets : [];
      nodes.relationshipOverview.innerHTML =
        '<div class="relationship-stage"><span class="relationship-stage-label">亲疏阶段</span><strong>' +
          escapeHtml(stageLabels[current.stage] || current.stage || "初识") + '</strong><div class="relationship-definition">' +
          '<div class="relationship-definition-row"><span>浪漫状态</span><b>' +
          escapeHtml(romanceLabels[current.romanceStatus] || current.romanceStatus || romanceLabels.none) + '</b></div>' +
          '<div class="relationship-bonds">' + (bonds.length
            ? bonds.map((facet) => '<span class="relationship-bond-chip">' + escapeHtml(bondLabels[facet] || facet) + '</span>').join("")
            : '<span class="relationship-bond-chip">尚未明确关系身份</span>') + '</div></div><div class="affect-summary">' +
          affectChips.map((label) => '<span class="affect-chip">' + escapeHtml(label) + '</span>').join("") + '</div></div>' +
        '<div class="relationship-metrics">' + metrics.map(([label, value, tone]) =>
          '<div class="relationship-metric" data-tone="' + tone + '"><span>' + label + '</span><span class="relationship-meter"><i style="width:' +
            Math.max(0, Math.min(100, Number(value) || 0)) + '%"></i></span><strong>' + Number(value || 0) + '</strong></div>'
        ).join("") + '</div>';
      const eventLabels = {
        support: "支持", reliability: "可靠", vulnerability: "袒露", shared_success: "共同成果",
        conflict: "冲突", boundary_violation: "越界", repair: "修复", affection: "亲密表达",
        bond_defined: "确认关系身份", confession: "表达爱意", confession_accepted: "接受告白",
        confession_rejected: "拒绝告白", relationship_confirmed: "确认交往", commitment: "长期承诺",
        jealousy: "嫉妒", shared_secret: "共享秘密", breakup: "结束关系", reconciliation: "复合"
      };
      const dimensionLabels = { trust: "信任", closeness: "亲近", affection: "好感", respect: "尊重", tension: "张力" };
      const initiatorLabels = { user: "用户发起", character: "角色发起", mutual: "双方确认" };
      const impactLabels = { minor: "轻微", moderate: "显著", major: "重大" };
      const events = Array.isArray(snapshot.recentEvents) ? snapshot.recentEvents : [];
      nodes.relationshipEventList.innerHTML = events.length ? events.map((event) => {
        const changes = Object.entries(event.delta || {}).filter(([, value]) => Number(value) !== 0);
        const semantic = event.semanticChange || {};
        const semanticChanges = [
          ...(semantic.addedBondFacets || []).map((facet) => '建立“' + (bondLabels[facet] || facet) + '”纽带'),
          ...(semantic.romanceTo ? ['浪漫状态：' + (romanceLabels[semantic.romanceTo] || semantic.romanceTo)] : [])
        ];
        return '<article class="relationship-event"><div class="relationship-event-copy"><strong>' +
          escapeHtml(eventLabels[event.type] || event.type) + ' · ' + escapeHtml(impactLabels[event.impact] || event.impact || "轻微") +
          (event.initiator ? ' · ' + escapeHtml(initiatorLabels[event.initiator] || event.initiator) : '') +
          '</strong><p>' + escapeHtml(event.summary || "") + '</p><time>' + escapeHtml(formatTraceTime(event.createdAt)) +
          '</time></div><div class="relationship-delta">' + changes.map(([key, value]) => '<span>' +
            escapeHtml(dimensionLabels[key] || key) + ' ' + (Number(value) > 0 ? '+' : '') + Number(value) + '</span>').join("") +
            semanticChanges.map((label) => '<span>' + escapeHtml(label) + '</span>').join("") + '</div></article>';
      }).join("") : '<div class="relationship-empty">还没有明确的关系变化记录</div>';
      refreshIcons();
    }

    function formatSignedDecimal(value) {
      const number = Number(value) || 0;
      return (number > 0 ? "+" : "") + number.toFixed(2);
    }

    async function resetRelationship() {
      const character = state.characters.find((entry) => entry.id === state.workspaceCharacterId);
      if (!character) return;
      const expected = character.name;
      const confirmed = await openActionDialog({
        title: "重置关系状态",
        description: "这会清除该角色的关系变化记录，并将长期关系与短期情绪恢复为初始状态。请输入角色名称“" + expected + "”确认。",
        fieldLabel: "输入角色名称确认",
        value: "",
        confirmLabel: "重置",
        validate: (value) => value === expected ? "" : "角色名称不匹配，未重置。",
        onConfirm: async (value) => {
          const response = await fetch("/api/v1/characters/" + encodeURIComponent(character.id) + "/relationship/reset", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ confirmation: value })
          });
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || "关系状态重置失败");
          state.relationship = body.relationship;
        }
      });
      if (confirmed) {
        nodes.relationshipState.textContent = "已重置";
        renderRelationship();
      }
    }

    function updateCharacterSoulCount() {
      const count = [...nodes.characterSoulMarkdown.value].length;
      const overLimit = count > 8000;
      nodes.characterSoulCount.textContent = count + " / 8000";
      nodes.characterSoulCount.classList.toggle("error", overLimit);
      nodes.saveCharacterBtn.disabled = overLimit;
    }

    async function saveCharacter(event) {
      event.preventDefault();
      const editing = state.workspaceCharacterId;
      if ([...nodes.characterSoulMarkdown.value].length > 8000) return;
	      const payload = {
	        name: nodes.characterName.value.trim(),
	        modelProfileId: nodes.characterModelProfile.value || null,
	        meetingPresetId: nodes.characterMeetingPreset.value || null,
	        soulMarkdown: editing || nodes.characterSoulMarkdown.value
          ? nodes.characterSoulMarkdown.value
          : undefined
      };
      if (!payload.name) return;
      nodes.saveCharacterBtn.disabled = true;
      try {
        const response = await fetch(
          editing ? "/api/v1/characters/" + encodeURIComponent(editing) : "/api/v1/characters",
          {
            method: editing ? "PATCH" : "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload)
          }
        );
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "角色保存失败");
        state.workspaceCharacterId = body.character.id;
        if (!editing) state.newConversationPreferredCharacterId = body.character.id;
        if (state.pendingCharacterAvatarDataUrl) {
          const avatarResponse = await fetch("/api/v1/avatars/characters/" + encodeURIComponent(body.character.id), {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ dataUrl: state.pendingCharacterAvatarDataUrl })
          });
          const avatarBody = await avatarResponse.json();
          if (!avatarResponse.ok) throw new Error(avatarBody.error || "头像保存失败");
          state.pendingCharacterAvatarDataUrl = "";
        }
        await loadCharacters();
        nodes.characterState.textContent = editing ? "已保存" : "已创建";
      } catch (error) {
        nodes.characterState.textContent = error.message || String(error);
      } finally {
        nodes.saveCharacterBtn.disabled = false;
        updateCharacterSoulCount();
      }
    }

    async function changeCharacterAvatar() {
      const file = nodes.characterAvatarInput.files?.[0];
      nodes.characterAvatarInput.value = "";
      if (!file) return;
      try {
        const dataUrl = await imageFileToAvatarDataUrl(file);
        if (!state.workspaceCharacterId) {
          state.pendingCharacterAvatarDataUrl = dataUrl;
          renderCharacterAvatarPreview();
          nodes.characterState.textContent = "头像将在创建角色时保存";
          return;
        }
        nodes.characterState.textContent = "头像保存中...";
        const response = await fetch("/api/v1/avatars/characters/" + encodeURIComponent(state.workspaceCharacterId), {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ dataUrl })
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "头像保存失败");
        await loadCharacters();
        nodes.characterState.textContent = "头像已更新";
      } catch (error) {
        nodes.characterState.textContent = error.message || String(error);
      }
    }

    async function removeCharacterAvatar() {
      if (!state.workspaceCharacterId) {
        state.pendingCharacterAvatarDataUrl = "";
        renderCharacterAvatarPreview();
        return;
      }
      try {
        const response = await fetch("/api/v1/avatars/characters/" + encodeURIComponent(state.workspaceCharacterId), { method: "DELETE" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "头像移除失败");
        await loadCharacters();
        nodes.characterState.textContent = "头像已移除";
      } catch (error) {
        nodes.characterState.textContent = error.message || String(error);
      }
    }

    function renderCharacterAvatarPreview() {
      const character = state.characters.find((entry) => entry.id === state.workspaceCharacterId);
      const source = state.pendingCharacterAvatarDataUrl || character?.avatarUrl;
      const name = nodes.characterName.value.trim() || character?.name || "角色";
      nodes.characterAvatarPreview.style.setProperty("--avatar-hue", avatarHue(name));
      nodes.characterAvatarPreview.innerHTML = avatarImageOrInitial(source, name);
      nodes.removeCharacterAvatarBtn.disabled = !source;
    }

    async function saveScene(event) {
      event.preventDefault();
      if (!state.selectedCharacterId || !state.activeSessionId) {
        nodes.sceneState.textContent = "当前会话不可编辑场景";
        return;
      }
      const sessionId = encodeURIComponent(state.activeSessionId);
      const payload = {
        characterId: state.selectedCharacterId,
        location: nodes.sceneLocation.value.trim() || undefined,
        inWorldTime: nodes.sceneTime.value.trim() || undefined,
        currentObjective: nodes.sceneObjective.value.trim() || undefined,
        participants: splitComma(nodes.sceneParticipants.value),
        summary: nodes.sceneSummary.value.trim(),
        openThreads: splitLines(nodes.sceneThreads.value)
      };
      nodes.saveSceneBtn.disabled = true;
      try {
        const response = await fetch("/api/v1/sessions/" + sessionId + "/scene", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "场景保存失败");
        await loadConversationScene(true);
        renderSceneInfo(state.currentScene || body.scene || {});
        setSceneInfoEditing(false);
      } catch (error) {
        nodes.sceneState.textContent = error.message || String(error);
      } finally {
        nodes.saveSceneBtn.disabled = false;
      }
    }

    async function loadMemories() {
      if (!state.workspaceCharacterId) {
        state.memories = [];
        renderMemories();
        return;
      }
      const common = "characterId=" + encodeURIComponent(state.workspaceCharacterId) +
        "&query=" + encodeURIComponent(nodes.memorySearch.value.trim());
      try {
        const [activeResponse, pendingResponse] = await Promise.all([
          fetch("/api/v1/memories?" + common + "&validity=active"),
          fetch("/api/v1/memories?" + common + "&validity=pending")
        ]);
        const active = await activeResponse.json();
        const pending = await pendingResponse.json();
        if (!activeResponse.ok) throw new Error(active.error || "记忆加载失败");
        if (!pendingResponse.ok) throw new Error(pending.error || "记忆加载失败");
        state.memories = [...(pending.memories || []), ...(active.memories || [])];
        renderMemories();
        nodes.memoryState.textContent = state.memories.length + " 条";
      } catch (error) {
        nodes.memoryState.textContent = error.message || String(error);
      }
    }

    function renderMemories() {
      if (!state.memories.length) {
        nodes.memoryList.innerHTML = '<div class="memory-empty">暂无长期记忆</div>';
        return;
      }
      nodes.memoryList.innerHTML = state.memories.map((memory) => {
        const status = memory.validity === "pending" ? "待确认" : memory.validity === "active" ? "已确认" : memory.validity;
        return '<div class="memory-row"><div>' +
          '<div class="memory-content">' + escapeHtml(memory.content) + '</div>' +
          '<div class="schedule-meta">' + escapeHtml(memoryTypeLabel(memory.type)) + ' · ' + escapeHtml(status) +
          (memory.key ? ' · ' + escapeHtml(memory.key) : '') +
          (memory.tags?.length ? ' · ' + escapeHtml(memory.tags.join(" · ")) : '') + '</div></div>' +
          '<div class="memory-actions">' +
          (memory.validity === "pending" ? '<button class="secondary icon-button" type="button" data-memory-action="confirm" data-id="' + escapeHtml(memory.id) + '" title="确认" aria-label="确认"><i data-lucide="check" aria-hidden="true"></i></button>' : '') +
          '<button class="secondary icon-button" type="button" data-memory-action="correct" data-id="' + escapeHtml(memory.id) + '" title="纠正" aria-label="纠正"><i data-lucide="pencil" aria-hidden="true"></i></button>' +
          '<button class="secondary icon-button" type="button" data-memory-action="delete" data-id="' + escapeHtml(memory.id) + '" title="删除" aria-label="删除"><i data-lucide="trash-2" aria-hidden="true"></i></button>' +
          '</div></div>';
      }).join("");
      refreshIcons();
    }

    function openMemoryEditor() {
      if (!state.workspaceCharacterId) return;
      nodes.memoryForm.reset();
      nodes.memoryEditorState.textContent = "";
      nodes.memoryEditorDialog.showModal();
      nodes.memoryType.focus();
    }

    function closeMemoryEditor() {
      if (nodes.memoryEditorDialog.open) nodes.memoryEditorDialog.close();
      nodes.addMemoryBtn.focus();
    }

    async function pinMemory(event) {
      event.preventDefault();
      if (!state.workspaceCharacterId) {
        nodes.memoryEditorState.textContent = "请先选择角色";
        return;
      }
      const payload = {
        realm: "roleplay",
        scope: "character",
        type: nodes.memoryType.value,
        key: nodes.memoryKey.value.trim() || undefined,
        content: nodes.memoryContent.value.trim(),
        characterId: state.workspaceCharacterId,
        confirmed: true,
        tags: splitComma(nodes.memoryTags.value)
      };
      if (!payload.content) return;
      try {
        const response = await fetch("/api/v1/memories", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "记忆保存失败");
        nodes.memoryForm.reset();
        closeMemoryEditor();
        await loadMemories();
        nodes.memoryState.textContent = "已固定";
      } catch (error) {
        nodes.memoryEditorState.textContent = error.message || String(error);
      }
    }

    async function handleMemoryAction(event) {
      const button = event.target.closest("button[data-memory-action]");
      if (!button) return;
      const id = button.dataset.id;
      const action = button.dataset.memoryAction;
      const memory = state.memories.find((entry) => entry.id === id);
      if (!memory) return;
      let method = "PATCH";
      let body;
      if (action === "confirm") body = JSON.stringify({ confirmed: true, validity: "active" });
      if (action === "correct") {
        let content = "";
        const corrected = await openActionDialog({
          title: "纠正长期记忆",
          description: "修正后的内容会替换当前记忆，并重新标记为已确认。",
          fieldLabel: "记忆内容",
          value: memory.content,
          selectInput: true,
          confirmLabel: "保存纠正",
          validate: (value) => !value.trim()
            ? "记忆内容不能为空。"
            : value.trim() === memory.content ? "内容没有变化。" : "",
          onConfirm: (value) => { content = value.trim(); }
        });
        if (!corrected) return;
        body = JSON.stringify({ content: content.trim(), confirmed: true, validity: "active" });
      }
      if (action === "delete") {
        const confirmed = await openActionDialog({
          title: "删除长期记忆",
          description: "确定删除“" + memory.content.slice(0, 80) + (memory.content.length > 80 ? "…" : "") + "”？此操作无法恢复。",
          confirmLabel: "删除"
        });
        if (!confirmed) return;
        method = "DELETE";
      }
      try {
        const response = await fetch("/api/v1/memories/" + encodeURIComponent(id), {
          method,
          headers: body ? { "content-type": "application/json" } : undefined,
          body
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "记忆操作失败");
        await loadMemories();
      } catch (error) {
        nodes.memoryState.textContent = error.message || String(error);
      }
    }

    function splitLines(value) {
      return value.split(/\\n+/).map((entry) => entry.trim()).filter(Boolean);
    }

    function splitComma(value) {
      return value.split(/[,，]+/).map((entry) => entry.trim()).filter(Boolean);
    }

    function memoryTypeLabel(type) {
      return ({
        user_fact: "用户事实",
        preference: "偏好",
        goal: "目标",
        person: "人物",
        project: "项目",
        relationship_event: "关系事件",
        world_fact: "世界事实",
        plot_event: "剧情事件",
        boundary: "边界"
      })[type] || type;
    }

    async function loadManagedMemories() {
      nodes.memoryCoordinatorState.textContent = "加载中...";
      try {
        const [statusResponse, memoriesResponse, charactersResponse, profilesResponse] = await Promise.all([
          fetch("/api/v1/memory-coordinator/status"),
          fetch("/api/v1/memory-coordinator/memories?limit=100"),
          fetch("/api/v1/characters"),
          fetch("/api/v1/person-profiles")
        ]);
        const statusBody = await statusResponse.json();
        const memoriesBody = await memoriesResponse.json();
        const charactersBody = await charactersResponse.json();
        const profilesBody = await profilesResponse.json();
        if (!statusResponse.ok) throw new Error(statusBody.error || "捕获状态加载失败");
        if (!memoriesResponse.ok) throw new Error(memoriesBody.error || "记忆加载失败");
        if (!profilesResponse.ok) throw new Error(profilesBody.error || "人物档案加载失败");
        state.managedMemories = Array.isArray(memoriesBody.memories) ? memoriesBody.memories : [];
        state.personProfiles = Array.isArray(profilesBody.profiles) ? profilesBody.profiles : [];
        state.memoryJobs = Array.isArray(statusBody.coordinator?.recentJobs) ? statusBody.coordinator.recentJobs : [];
        state.characters = Array.isArray(charactersBody.characters) ? charactersBody.characters : state.characters;
        const characterOptions = state.characters.map((character) =>
          '<option value="' + escapeHtml(character.id) + '">' + escapeHtml(character.name) + '</option>'
        ).join("");
        const selectedFilter = nodes.managedMemoryCharacter.value;
        const selectedCreate = nodes.managedMemoryCreateCharacter.value;
        nodes.managedMemoryCharacter.innerHTML = '<option value="">全部角色</option>' + characterOptions;
        nodes.managedMemoryCreateCharacter.innerHTML = '<option value="">不绑定角色</option>' + characterOptions;
        nodes.managedMemoryCharacter.value = selectedFilter;
        nodes.managedMemoryCreateCharacter.value = selectedCreate;
        const coordinator = statusBody.coordinator || {};
        nodes.memoryCoordinatorState.textContent = (coordinator.enabled ? "自动捕获已启用" : "自动捕获已关闭") +
          " · " + Number(coordinator.pendingCandidateCount || 0) + " 个待确认 · " +
          Number(coordinator.pendingCount || 0) + " 个队列中 · 24h 约 " +
          Number(coordinator.estimatedTokensLast24Hours || 0).toLocaleString() + " tokens";
        updateManagedMemoryCreateControls();
        renderManagedMemories();
        renderPersonProfiles();
        renderMemoryJobs();
      } catch (error) {
        nodes.memoryCoordinatorState.textContent = error.message || String(error);
      }
    }

    function renderManagedMemories() {
      const query = nodes.managedMemoryQuery.value.trim().toLocaleLowerCase();
      const realm = nodes.managedMemoryRealm.value;
      const characterId = nodes.managedMemoryCharacter.value;
      const type = nodes.managedMemoryTypeFilter.value;
      const validity = nodes.managedMemoryValidity.value;
      const memories = state.managedMemories.filter((memory) => {
        if (realm && memory.realm !== realm) return false;
        if (characterId && memory.characterId !== characterId) return false;
        if (type && memory.type !== type) return false;
        if (validity && memory.validity !== validity) return false;
        if (query && !(memory.id + " " + memory.content + " " + (memory.key || "") + " " + (memory.tags || []).join(" ")).toLocaleLowerCase().includes(query)) return false;
        return true;
      });
      if (!memories.length) {
        nodes.managedMemoryList.innerHTML = '<div class="muted" style="padding:14px 0;">没有符合条件的记忆</div>';
        return;
      }
      nodes.managedMemoryList.innerHTML = memories.map((memory) => {
        const character = state.characters.find((entry) => entry.id === memory.characterId);
        const source = [memory.realm, memory.validity, character?.name, memory.sourceSessionId, memory.sourceMessageId].filter(Boolean).join(" · ");
        const usage = [
          memory.core ? '<span class="memory-badge core">核心</span>' : '',
          '<span class="memory-badge">命中 ' + Number(memory.hitCount || 0) + ' 次</span>',
          memory.lastHitAt ? '<span class="memory-badge">最近命中 ' + escapeHtml(formatTraceTime(memory.lastHitAt)) + '</span>' : '',
          memory.lastUsedAt ? '<span class="memory-badge">最近使用 ' + escapeHtml(formatTraceTime(memory.lastUsedAt)) + '</span>' : ''
        ].filter(Boolean).join("");
        const actions = memory.realm === "legacy" ?
          '<button class="secondary" type="button" data-managed-memory-action="forget" data-id="' + escapeHtml(memory.id) + '">删除隔离项</button>' :
          memory.validity === "pending" ?
            '<button class="secondary" type="button" data-managed-memory-action="confirm" data-id="' + escapeHtml(memory.id) + '">确认</button>' +
            '<button class="secondary" type="button" data-managed-memory-action="correct" data-id="' + escapeHtml(memory.id) + '">编辑后确认</button>' +
            '<button class="secondary" type="button" data-managed-memory-action="reject" data-id="' + escapeHtml(memory.id) + '">拒绝</button>' :
          memory.validity === "active" ?
            '<button class="secondary" type="button" data-managed-memory-action="correct" data-id="' + escapeHtml(memory.id) + '">纠正</button>' +
            '<button class="secondary" type="button" data-managed-memory-action="archive" data-id="' + escapeHtml(memory.id) + '">归档</button>' +
            '<button class="secondary" type="button" data-managed-memory-action="forget" data-id="' + escapeHtml(memory.id) + '">遗忘</button>' : "";
        return '<div class="memory-row"><div><div class="memory-content">' + escapeHtml(memory.content) + '</div>' +
          '<div class="schedule-meta">' + escapeHtml(memoryTypeLabel(memory.type)) + (memory.key ? ' · ' + escapeHtml(memory.key) : '') + '</div>' +
          '<div class="memory-source">' + escapeHtml(source) + '</div><div class="memory-badges">' + usage + '</div></div><div class="memory-actions">' + actions + '</div></div>';
      }).join("");
    }

    function renderPersonProfiles() {
      nodes.personProfileCount.textContent = state.personProfiles.length + " 人";
      if (!state.personProfiles.length) {
        nodes.personProfileList.innerHTML = '<div class="muted" style="padding:8px 0;">暂无人物档案</div>';
        return;
      }
      nodes.personProfileList.innerHTML = state.personProfiles.map((profile) => {
        const visibleIds = new Set(profile.visibleToCharacterIds || []);
        const visibility = profile.visibility === "selected_characters" ? "selected_characters" : "global";
        const characterOptions = state.characters.map((character) =>
          '<label><input type="checkbox" name="visibleCharacter" value="' + escapeHtml(character.id) + '"' +
            (visibleIds.has(character.id) ? ' checked' : '') + ' />' + escapeHtml(character.name) + '</label>'
        ).join("");
        const meta = [
          profile.relationship || "关系未标注",
          visibility === "global" ? "全部角色可见" : visibleIds.size + " 个角色可见",
          (profile.sourceMemoryIds || []).length + " 条来源",
          "置信度 " + Number(profile.confidence || 0).toFixed(2)
        ].join(" · ");
        return '<details class="person-profile" data-person-profile-id="' + escapeHtml(profile.id) + '">' +
          '<summary><div class="person-profile-title"><strong>' + escapeHtml(profile.displayName) + '</strong>' +
          '<span class="person-profile-meta">' + escapeHtml(meta) + '</span></div>' +
          '<i data-lucide="chevron-down" aria-hidden="true"></i></summary>' +
          '<form class="person-profile-form" data-person-profile-form="' + escapeHtml(profile.id) + '">' +
          '<label>姓名<input name="displayName" value="' + escapeHtml(profile.displayName) + '" required maxlength="80" /></label>' +
          '<label>与用户关系<input name="relationship" value="' + escapeHtml(profile.relationship || "") + '" maxlength="120" /></label>' +
          '<label class="full">别名<input name="aliases" value="' + escapeHtml((profile.aliases || []).join("，")) + '" /></label>' +
          '<label>可见范围<select name="visibility" data-person-visibility>' +
          '<option value="global"' + (visibility === "global" ? ' selected' : '') + '>全部角色</option>' +
          '<option value="selected_characters"' + (visibility === "selected_characters" ? ' selected' : '') + '>指定角色</option>' +
          '</select></label>' +
          '<div class="person-visibility-list full" data-person-visibility-list' + (visibility === "global" ? ' hidden' : '') + '>' +
          (characterOptions || '<span class="muted">暂无角色</span>') + '</div>' +
          '<label class="full">档案 Markdown<textarea name="markdown" spellcheck="false">' + escapeHtml(profile.markdown || "") + '</textarea></label>' +
          '<div class="settings-actions full"><button class="primary" type="submit">保存档案</button>' +
          '<span class="muted" data-person-save-state></span></div></form></details>';
      }).join("");
      if (window.lucide) window.lucide.createIcons();
    }

    function updatePersonVisibilityControls(event) {
      const select = event.target.closest("select[data-person-visibility]");
      if (!select) return;
      const form = select.closest("form[data-person-profile-form]");
      const list = form?.querySelector("[data-person-visibility-list]");
      if (list) list.hidden = select.value !== "selected_characters";
    }

    async function savePersonProfile(event) {
      const form = event.target.closest("form[data-person-profile-form]");
      if (!form) return;
      event.preventDefault();
      const data = new FormData(form);
      const status = form.querySelector("[data-person-save-state]");
      const button = form.querySelector('button[type="submit"]');
      if (button) button.disabled = true;
      if (status) status.textContent = "保存中...";
      try {
        const response = await fetch("/api/v1/person-profiles/" + encodeURIComponent(form.dataset.personProfileForm), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            displayName: String(data.get("displayName") || "").trim(),
            relationship: String(data.get("relationship") || "").trim() || null,
            aliases: String(data.get("aliases") || "").split(/[，,\\n]/u).map((value) => value.trim()).filter(Boolean),
            visibility: data.get("visibility") === "selected_characters" ? "selected_characters" : "global",
            visibleToCharacterIds: data.getAll("visibleCharacter").map(String),
            markdown: String(data.get("markdown") || "")
          })
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "人物档案保存失败");
        const index = state.personProfiles.findIndex((profile) => profile.id === body.profile.id);
        if (index >= 0) state.personProfiles[index] = body.profile;
        renderPersonProfiles();
        nodes.managedMemoryActionState.textContent = "人物档案已保存";
      } catch (error) {
        if (status) status.textContent = error.message || String(error);
        if (button) button.disabled = false;
      }
    }

    async function runRetrievalPreview(event) {
      event.preventDefault();
      nodes.retrievalPreviewState.textContent = "检索中...";
      nodes.retrievalPreviewResults.hidden = true;
      const params = new URLSearchParams({
        mode: nodes.retrievalPreviewMode.value,
        sessionId: state.activeSessionId || "ui-retrieval-preview",
        query: nodes.retrievalPreviewQuery.value.trim(),
        memoryTokens: String(Number(nodes.retrievalPreviewBudget.value) || 360),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
      });
      const characterId = nodes.managedMemoryCharacter.value || state.selectedCharacterId;
      if (characterId) params.set("characterId", characterId);
      try {
        const response = await fetch("/api/v1/memory-retrieval/preview?" + params.toString());
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "检索预览失败");
        state.retrievalPreview = body;
        renderRetrievalPreview();
      } catch (error) {
        nodes.retrievalPreviewState.textContent = error.message || String(error);
      }
    }

    function renderRetrievalPreview() {
      const plans = Array.isArray(state.retrievalPreview?.retrieval) ? state.retrievalPreview.retrieval : [];
      const candidates = plans.flatMap((plan) => (plan.candidates || []).map((candidate) => ({ ...candidate, plan })));
      const selected = candidates.filter((entry) => entry.selected);
      nodes.retrievalPreviewState.textContent = candidates.length + " 个候选 · " + selected.length + " 个入选 · 预算 " +
        Number(state.retrievalPreview?.budgets?.memoryTokens || 0) + " tokens";
      nodes.retrievalPreviewResults.hidden = false;
      nodes.retrievalPreviewResults.innerHTML = candidates.length ? candidates.map((entry) =>
        '<div class="retrieval-preview-row"><div><strong>' + escapeHtml(entry.memoryId) + '</strong> · ' +
          escapeHtml(entry.plan.realm + (entry.plan.characterId ? " / " + entry.plan.characterId : "")) +
          '<div class="memory-source">' + escapeHtml((entry.selected ? "入选" : "排除") + " · score " + Number(entry.score || 0).toFixed(4) +
            " · " + (entry.selected ? entry.reason : entry.exclusionReason || entry.reason) + " · " + Number(entry.estimatedTokens || 0) + " tokens") + '</div></div>' +
          '<button class="secondary" type="button" data-memory-jump="' + escapeHtml(entry.memoryId) + '">查看</button></div>'
      ).join("") : '<div class="muted" style="padding:12px 0;">无相关候选；普通 turn 不会回退注入任意记忆。</div>';
    }

    async function jumpFromMemoryDiagnostic(event) {
      const button = event.target.closest("[data-memory-jump]");
      if (!button) return;
      setUiMode("management");
      setManagementTab("memory");
      await loadManagedMemories();
      nodes.managedMemoryRealm.value = "";
      nodes.managedMemoryCharacter.value = "";
      nodes.managedMemoryValidity.value = "";
      nodes.managedMemoryQuery.value = button.dataset.memoryJump;
      renderManagedMemories();
      nodes.managedMemoryList.scrollIntoView({ block: "start" });
    }

    function updateManagedMemoryCreateControls() {
      const reality = nodes.managedMemoryCreateRealm.value === "reality";
      const types = reality
        ? [["user_fact", "用户事实"], ["preference", "偏好"], ["goal", "目标"], ["person", "人物"], ["project", "项目"], ["boundary", "边界"]]
        : [["relationship_event", "关系事件"], ["world_fact", "世界事实"], ["plot_event", "剧情事件"], ["boundary", "边界"]];
      nodes.managedMemoryCreateType.innerHTML = types.map((entry) => '<option value="' + entry[0] + '">' + entry[1] + '</option>').join("");
      nodes.managedMemoryCreateCharacter.disabled = reality;
      if (reality) nodes.managedMemoryCreateCharacter.value = "";
    }

    async function createManagedMemory(event) {
      event.preventDefault();
      const realm = nodes.managedMemoryCreateRealm.value;
      const characterId = nodes.managedMemoryCreateCharacter.value;
      if (realm === "roleplay" && !characterId) {
        nodes.managedMemoryActionState.textContent = "角色记忆必须选择角色";
        return;
      }
      nodes.managedMemoryActionState.textContent = "保存中...";
      try {
        const response = await fetch(realm === "reality" ? "/api/v1/reality-memories" : "/api/v1/memories", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            realm,
            scope: realm === "reality" ? "global" : "character",
            type: nodes.managedMemoryCreateType.value,
            key: nodes.managedMemoryCreateKey.value.trim() || undefined,
            content: nodes.managedMemoryCreateContent.value.trim(),
            characterId: realm === "roleplay" ? characterId : undefined,
            confirmed: true,
            tags: ["manual-control-plane"]
          })
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "记忆保存失败");
        nodes.managedMemoryCreateKey.value = "";
        nodes.managedMemoryCreateContent.value = "";
        nodes.managedMemoryActionState.textContent = "已固定";
        await loadManagedMemories();
      } catch (error) {
        nodes.managedMemoryActionState.textContent = error.message || String(error);
      }
    }

    async function handleManagedMemoryAction(event) {
      const button = event.target.closest("button[data-managed-memory-action]");
      if (!button) return;
      const memory = state.managedMemories.find((entry) => entry.id === button.dataset.id);
      if (!memory) return;
      const action = button.dataset.managedMemoryAction;
      let content = memory.content;
      if (action === "correct") {
        const edited = await openActionDialog({
          title: memory.validity === "pending" ? "编辑后确认" : "纠正长期记忆",
          description: memory.validity === "active" ? "原记忆将保留为已替换审计项。" : "候选将在保存后确认。",
          fieldLabel: "记忆正文",
          value: memory.content,
          selectInput: true,
          confirmLabel: "保存",
          validate: (value) => !value.trim() ? "记忆正文不能为空。" : "",
          onConfirm: (value) => { content = value.trim(); }
        });
        if (!edited) return;
      } else if (action !== "confirm") {
        const accepted = await openActionDialog({
          title: action === "reject" ? "拒绝候选" : action === "archive" ? "归档记忆" : "遗忘记忆",
          description: action === "forget" ? "该记忆会立即退出检索和模型上下文，但保留审计状态。" : memory.content.slice(0, 120),
          confirmLabel: action === "reject" ? "拒绝" : action === "archive" ? "归档" : "遗忘"
        });
        if (!accepted) return;
      }
      try {
        const endpoint = memory.realm === "legacy" && action === "forget"
          ? "/api/v1/memories/" + encodeURIComponent(memory.id)
          : "/api/v1/memories/" + encodeURIComponent(memory.id) + "/" + action;
        const response = await fetch(endpoint, {
          method: memory.realm === "legacy" && action === "forget" ? "DELETE" : "POST",
          headers: { "content-type": "application/json" },
          body: memory.realm === "legacy" && action === "forget" ? undefined : JSON.stringify(action === "correct" ? { content } : {})
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "记忆操作失败");
        if (body.diff) {
          nodes.managedMemoryActionState.textContent = "已替换旧记忆";
          await openActionDialog({
            title: "记忆冲突已替换",
            description: "旧内容：" + body.diff.previous + "\\n\\n新内容：" + body.diff.next,
            confirmLabel: "关闭"
          });
        }
        await loadManagedMemories();
      } catch (error) {
        nodes.managedMemoryActionState.textContent = error.message || String(error);
      }
    }

    function renderMemoryJobs() {
      nodes.memoryJobCount.textContent = state.memoryJobs.length + " 条";
      nodes.memoryJobList.innerHTML = state.memoryJobs.length ? state.memoryJobs.map((job) =>
        '<div class="memory-job-row"><div><strong>' + escapeHtml(job.status) + '</strong> · ' + escapeHtml(job.triggerReason) + '</div>' +
        '<div class="memory-source">' + escapeHtml(job.realm + " · " + job.sessionId + " · " + job.inputTokenEstimate + " tokens · " + (job.durationMs || 0) + " ms · " + job.resultCount + " results") + '</div>' +
        (job.lastError ? '<div class="error">' + escapeHtml(job.lastError) + '</div>' : '') +
        (job.status === "failed" && job.triggerReason === "explicit_forget_authorization" ? '<div><button class="secondary" type="button" data-memory-job-filter="' + escapeHtml(job.id) + '">筛选遗忘候选</button></div>' : '') +
        (job.status === "failed" && job.attempts < job.maxAttempts ? '<div><button class="secondary" type="button" data-memory-job-retry="' + escapeHtml(job.id) + '">重试</button></div>' : '') + '</div>'
      ).join("") : '<div class="muted" style="padding:12px 0;">暂无捕获任务</div>';
    }

    async function retryMemoryJob(event) {
      const filterButton = event.target.closest("button[data-memory-job-filter]");
      if (filterButton) {
        const job = state.memoryJobs.find((entry) => entry.id === filterButton.dataset.memoryJobFilter);
        if (!job) return;
        nodes.managedMemoryRealm.value = job.realm || "";
        nodes.managedMemoryCharacter.value = job.characterId || "";
        nodes.managedMemoryValidity.value = "active";
        nodes.managedMemoryQuery.value = "";
        renderManagedMemories();
        nodes.managedMemoryList.scrollIntoView({ block: "start" });
        return;
      }
      const button = event.target.closest("button[data-memory-job-retry]");
      if (!button) return;
      button.disabled = true;
      try {
        const response = await fetch("/api/v1/memory-coordinator/jobs/" + encodeURIComponent(button.dataset.memoryJobRetry) + "/retry", { method: "POST" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "重试失败");
        await loadManagedMemories();
      } catch (error) {
        nodes.managedMemoryActionState.textContent = error.message || String(error);
        button.disabled = false;
      }
    }

    async function loadAgentModules() {
      nodes.moduleList.innerHTML = '<div class="muted" style="padding: 14px 0;">扫描中...</div>';
      try {
        const response = await fetch("/api/v1/agent-modules");
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "模块加载失败");
        state.agentModules = Array.isArray(body.modules) ? body.modules : [];
        renderAgentModules();
      } catch (error) {
        nodes.moduleList.innerHTML = '<div class="error" style="padding: 14px 0;">' + escapeHtml(error.message || String(error)) + '</div>';
      }
    }

    async function loadCapabilityManagement() {
      await Promise.all([loadAgentModules(), loadAgentPermissions()]);
    }

    async function loadAgentPermissions() {
      setPermissionControlsDisabled(true);
      nodes.permissionRuntime.textContent = "加载中...";
      try {
        const response = await fetch("/api/v1/agent-permissions");
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "权限加载失败");
        state.agentPermissions = body.permissions || null;
        renderAgentPermissions();
      } catch (error) {
        nodes.permissionRuntime.textContent = error.message || String(error);
        setPermissionControlsDisabled(false);
      }
    }

    function renderAgentPermissions() {
      const permissions = state.agentPermissions;
      if (!permissions) return;
      nodes.workspacePath.textContent = permissions.workspaceDir || "";
      nodes.workspaceAccessControls.querySelectorAll("button[data-workspace-access]").forEach((button) => {
        button.classList.toggle("active", button.dataset.workspaceAccess === permissions.workspaceAccess);
      });
      setPermissionToggle(nodes.shellPermissionInput, nodes.shellPermissionLabel, permissions.shellEnabled);
      setPermissionToggle(nodes.networkPermissionInput, nodes.networkPermissionLabel, permissions.networkEnabled);
      setPermissionToggle(nodes.profileWritePermissionInput, nodes.profileWritePermissionLabel, permissions.userProfileWriteEnabled);
      setPermissionToggle(nodes.soulWritePermissionInput, nodes.soulWritePermissionLabel, permissions.characterSoulWriteEnabled);
      setPermissionToggle(nodes.realityMemoryWritePermissionInput, nodes.realityMemoryWritePermissionLabel, permissions.realityMemoryWriteEnabled);
      setPermissionToggle(nodes.characterMemoryWritePermissionInput, nodes.characterMemoryWritePermissionLabel, permissions.characterMemoryWriteEnabled);
      setPermissionControlsDisabled(false);
      nodes.shellPermissionInput.disabled = !permissions.shellAvailable;
      nodes.networkPermissionInput.disabled = !permissions.shellEnabled;
      const networkPermissionHint = permissions.shellEnabled ? "" : "请先启用终端执行";
      nodes.networkPermissionInput.title = networkPermissionHint;
      nodes.networkPermissionInput.closest(".toggle").title = networkPermissionHint;
      nodes.permissionRuntime.textContent = permissions.shellAvailable
        ? "Bubblewrap 可用"
        : "Bubblewrap 不可用，终端执行无法启用";
    }

    function setPermissionToggle(input, label, enabled) {
      input.checked = Boolean(enabled);
      label.textContent = enabled ? "已启用" : "已关闭";
    }

    function setPermissionControlsDisabled(disabled) {
      nodes.permissionControls.querySelectorAll("input, button").forEach((control) => {
        control.disabled = disabled;
      });
    }

    async function setWorkspaceAccess(event) {
      const button = event.target.closest("button[data-workspace-access]");
      if (!button || button.disabled) return;
      if (state.agentPermissions && button.dataset.workspaceAccess === state.agentPermissions.workspaceAccess) return;
      await patchAgentPermissions({ workspaceAccess: button.dataset.workspaceAccess });
    }

    async function toggleAgentPermission(event) {
      const input = event.target.closest("input[data-permission]");
      if (!input) return;
      await patchAgentPermissions({ [input.dataset.permission]: input.checked });
    }

    async function patchAgentPermissions(patch) {
      setPermissionControlsDisabled(true);
      try {
        const response = await fetch("/api/v1/agent-permissions", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch)
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "权限更新失败");
        state.agentPermissions = body.permissions || null;
        renderAgentPermissions();
        setStatus("Agent 权限已更新");
      } catch (error) {
        renderAgentPermissions();
        setStatus(error.message || String(error), true);
      }
    }

    function renderAgentModules() {
      if (!state.agentModules.length) {
        nodes.moduleList.innerHTML = '<div class="muted" style="padding: 14px 0;">未发现模块</div>';
        return;
      }
      nodes.moduleList.innerHTML = state.agentModules.map((module) =>
        '<div class="module-row">' +
          '<span class="module-type ' + escapeHtml(module.type) + '">' + escapeHtml(module.type === "mcp" ? "MCP" : "SKILL") + '</span>' +
          '<div><div class="module-name">' + escapeHtml(module.name) + '</div>' +
            '<div class="module-description">' + escapeHtml(module.description || "") + '</div>' +
            '<div class="module-metadata"><span class="module-source">' + escapeHtml(module.source || "") + '</span>' +
              '<span class="module-token" title="基于当前提示词和 schema 的近似值；实际值取决于模型 tokenizer">' +
                escapeHtml(module.type === "mcp"
                  ? "约 " + Number(module.estimatedTokens || 0).toLocaleString() + " tokens/轮"
                  : "索引约 " + Number(module.estimatedTokens || 0).toLocaleString() + " tokens/轮 · 全文约 " + Number(module.fullContentEstimatedTokens || 0).toLocaleString() + " tokens/调用") +
              '</span></div></div>' +
          '<button class="secondary icon-button module-detail-button" type="button" data-module-detail="' + escapeHtml(module.id) + '" title="查看模块详情" aria-label="查看 ' + escapeHtml(module.name) + ' 详情"><i data-lucide="file-text" aria-hidden="true"></i></button>' +
          '<label class="toggle"><span>' + (module.enabled ? "已启用" : "已关闭") + '</span>' +
            '<input type="checkbox" data-module-id="' + escapeHtml(module.id) + '" aria-label="切换 ' + escapeHtml(module.name) + '"' + (module.enabled ? ' checked' : '') + ' /></label>' +
        '</div>'
      ).join("");
      refreshIcons();
    }

    async function openModuleDetailFromList(event) {
      const button = event.target.closest("button[data-module-detail]");
      if (!button) return;
      button.disabled = true;
      try {
        const response = await fetch("/api/v1/agent-modules/" + encodeURIComponent(button.dataset.moduleDetail));
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "模块详情加载失败");
        const detail = body.detail || {};
        nodes.moduleDetailTitle.textContent = detail.module?.name || "模块详情";
        nodes.moduleDetailContent.innerHTML = '<div class="module-detail-meta">' +
          escapeHtml([detail.module?.type?.toUpperCase(), detail.module?.source, detail.module?.enabled ? "已启用" : "已关闭"].filter(Boolean).join(" · ")) +
          '</div><div class="markdown-body">' + renderMarkdown(detail.content || "暂无详情") + '</div>';
        nodes.moduleDetailDialog.showModal();
        refreshIcons();
      } catch (error) {
        setStatus(error.message || String(error), true);
      } finally {
        button.disabled = false;
      }
    }

    async function toggleAgentModule(event) {
      const input = event.target.closest("input[data-module-id]");
      if (!input) return;
      input.disabled = true;
      try {
        const response = await fetch("/api/v1/agent-modules/" + encodeURIComponent(input.dataset.moduleId), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: input.checked })
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "模块更新失败");
        setStatus(body.module.name + (body.module.enabled ? " 已启用" : " 已关闭"));
        await loadAgentModules();
      } catch (error) {
        input.checked = !input.checked;
        input.disabled = false;
        setStatus(error.message || String(error), true);
      }
    }

    async function loadUserProfile() {
      nodes.profileState.textContent = "加载中...";
      setProfileControlsDisabled(true);
      try {
        const response = await fetch("/api/v1/user-profile");
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "画像加载失败");
        const profile = body.profile || {};
        nodes.profileMarkdown.value = typeof body.manualMarkdown === "string" ? body.manualMarkdown : profile.markdown || "";
        state.userAvatarUrl = body.avatarUrl || "";
        renderUserAvatarPreview();
        updateProfileCharacterCount();
        nodes.profileState.textContent = profile.updatedAt ? "更新于 " + formatProfileTime(profile.updatedAt) : "";
      } catch (error) {
        nodes.profileState.textContent = error.message || String(error);
      } finally {
        setProfileControlsDisabled(false);
      }
    }

    async function loadUserInsights() {
      nodes.refreshUserInsightsBtn.disabled = true;
      nodes.userInsightSummary.textContent = "加载中...";
      try {
        const response = await fetch("/api/v1/user-insights?limit=50");
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "画像形成记录加载失败");
        state.userInsights = body.insights || null;
        renderUserInsights();
      } catch (error) {
        state.userInsights = null;
        nodes.userInsightSummary.textContent = error.message || String(error);
        nodes.userInsightList.innerHTML = "";
      } finally {
        nodes.refreshUserInsightsBtn.disabled = false;
      }
    }

    function renderUserInsights() {
      const insights = state.userInsights || {};
      const observations = Array.isArray(insights.recentObservations) ? insights.recentObservations : [];
      const summaryParts = [
        insights.enabled ? "自动收录已开启" : "自动收录已关闭",
        Number(insights.observationCount || 0) + " 条观察",
        Number(insights.promotedCount || 0) + " 条已写入",
        Number(insights.pendingCount || 0) + " 条待处理",
        Number(insights.conflictCount || 0) ? Number(insights.conflictCount) + " 条冲突" : "",
        Number(insights.blockedCount || 0) ? Number(insights.blockedCount) + " 条敏感内容已拦截" : "",
        Number(insights.userBlockedCount || 0) ? Number(insights.userBlockedCount) + " 条用户覆盖" : ""
      ].filter(Boolean);
      nodes.userInsightSummary.innerHTML = summaryParts.map((part) => '<span>' + escapeHtml(part) + '</span>').join("");
      if (!observations.length) {
        nodes.userInsightList.innerHTML = '<div class="muted" style="padding:14px 0;">日常对话、日程与提醒尚未形成画像观察</div>';
        return;
      }
      nodes.userInsightList.innerHTML = observations.map((observation) => {
        const kind = ({
          one_off_schedule: "一次性日程",
          recurring_schedule: "重复日程",
          completed_schedule: "完成记录",
          reminder_snooze: "提醒延后",
          conversation_statement: "日常对话"
        })[observation.kind] || observation.kind;
        const decision = ({
          context_only: "仅作当前状态",
          accumulating: "证据积累中",
          promoted: "已写入画像",
          blocked_sensitive: "敏感内容已拦截",
          write_disabled: "自动收录已关闭",
          conflicted: "存在冲突",
          user_blocked: "用户已覆盖",
          retracted: "来源已撤回"
        })[observation.decision] || observation.decision;
        const source = observation.sourceType === "conversation"
          ? "用户原话"
          : observation.sourceType === "reminder" ? "提醒操作" : "用户日历";
        const metadata = [kind, source, formatInsightTime(observation.observedAt)].filter(Boolean).join(" · ");
        const controls = renderUserInsightControls(observation);
        return '<div class="user-insight-row"><div class="user-insight-main"><div class="user-insight-claim">' +
          escapeHtml(observation.claimText || "无摘要") + '</div><span class="user-insight-decision" data-decision="' +
          escapeHtml(observation.decision || "") + '">' + escapeHtml(decision) + '</span></div>' +
          '<div class="schedule-meta">' + escapeHtml(metadata) + '</div>' +
          '<details class="user-insight-evidence"><summary>查看来源证据</summary><pre>' +
          escapeHtml(JSON.stringify(observation.evidence || {}, null, 2)) + '</pre></details>' + controls + '</div>';
      }).join("");
      refreshIcons();
    }

    function renderUserInsightControls(observation) {
      if (observation.decision === "blocked_sensitive" || observation.decision === "retracted") return "";
      if (observation.decision === "user_blocked") {
        return '<div class="user-insight-row-actions"><button class="secondary icon-button" type="button" data-user-insight-action="unlock" data-id="' +
          escapeHtml(observation.id) + '" title="恢复自动判断" aria-label="恢复自动判断"><i data-lucide="rotate-ccw" aria-hidden="true"></i></button></div>';
      }
      const confirm = observation.decision === "promoted"
        ? ""
        : '<button class="secondary icon-button" type="button" data-user-insight-action="confirm" data-id="' +
          escapeHtml(observation.id) + '" title="确认写入画像" aria-label="确认写入画像"><i data-lucide="check" aria-hidden="true"></i></button>';
      return '<div class="user-insight-row-actions">' + confirm +
        '<button class="secondary icon-button" type="button" data-user-insight-action="reject" data-id="' +
        escapeHtml(observation.id) + '" title="忽略并停止自动写入" aria-label="忽略画像观察"><i data-lucide="ban" aria-hidden="true"></i></button></div>';
    }

    async function handleUserInsightAction(event) {
      const button = event.target.closest("button[data-user-insight-action]");
      if (!button) return;
      const action = button.dataset.userInsightAction;
      const id = button.dataset.id;
      if (!id || !["confirm", "reject", "unlock"].includes(action)) return;
      if (action === "reject") {
        const accepted = await openActionDialog({
          title: "忽略画像观察",
          description: "该结论会从自动画像中移除，同一类证据也会停止自动写入，之后可以恢复。",
          confirmLabel: "忽略"
        });
        if (!accepted) return;
      }
      button.disabled = true;
      try {
        const response = await fetch(
          "/api/v1/user-insights/" + encodeURIComponent(id) + "/" + action,
          { method: "POST" }
        );
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "画像观察操作失败");
        state.userInsights = body.insights || state.userInsights;
        renderUserInsights();
        nodes.profileState.textContent = action === "confirm"
          ? "已写入画像"
          : action === "reject" ? "已忽略该类观察" : "已恢复自动判断";
      } catch (error) {
        nodes.profileState.textContent = error.message || String(error);
        button.disabled = false;
      }
    }

    async function loadUserAvatarState() {
      try {
        const response = await fetch("/api/v1/user-profile");
        const body = await response.json();
        if (!response.ok) return;
        state.userAvatarUrl = body.avatarUrl || "";
        renderUserAvatarPreview();
        renderMessages();
      } catch {
        state.userAvatarUrl = "";
      }
    }

    async function changeUserAvatar() {
      const file = nodes.userAvatarInput.files?.[0];
      nodes.userAvatarInput.value = "";
      if (!file) return;
      nodes.profileState.textContent = "头像保存中...";
      try {
        const dataUrl = await imageFileToAvatarDataUrl(file);
        const response = await fetch("/api/v1/avatars/user", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ dataUrl })
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "头像保存失败");
        state.userAvatarUrl = body.avatarUrl || "";
        renderUserAvatarPreview();
        renderMessages();
        nodes.profileState.textContent = "头像已更新";
      } catch (error) {
        nodes.profileState.textContent = error.message || String(error);
      }
    }

    async function removeUserAvatar() {
      try {
        const response = await fetch("/api/v1/avatars/user", { method: "DELETE" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "头像移除失败");
        state.userAvatarUrl = "";
        renderUserAvatarPreview();
        renderMessages();
        nodes.profileState.textContent = "头像已移除";
      } catch (error) {
        nodes.profileState.textContent = error.message || String(error);
      }
    }

    function renderUserAvatarPreview() {
      const avatar = avatarImageOrInitial(state.userAvatarUrl, "我", "我");
      if (nodes.userAvatarPreview) nodes.userAvatarPreview.innerHTML = avatar;
      if (nodes.brandUserAvatar) nodes.brandUserAvatar.innerHTML = avatar;
      if (nodes.removeUserAvatarBtn) nodes.removeUserAvatarBtn.disabled = !state.userAvatarUrl;
      updateScheduleHeaderContext();
    }

    async function imageFileToAvatarDataUrl(file) {
      if (!file.type.match(/^image\\/(?:png|jpeg|webp)$/)) throw new Error("请选择 JPEG、PNG 或 WebP 图片");
      if (file.size > 10 * 1024 * 1024) throw new Error("原始图片不能超过 10 MiB");
      const objectUrl = URL.createObjectURL(file);
      try {
        const image = await new Promise((resolve, reject) => {
          const element = new Image();
          element.onload = () => resolve(element);
          element.onerror = () => reject(new Error("图片无法读取"));
          element.src = objectUrl;
        });
        const size = Math.min(image.naturalWidth, image.naturalHeight);
        const sourceX = (image.naturalWidth - size) / 2;
        const sourceY = (image.naturalHeight - size) / 2;
        const canvas = document.createElement("canvas");
        canvas.width = 256;
        canvas.height = 256;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("浏览器不支持头像处理");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, 256, 256);
        context.drawImage(image, sourceX, sourceY, size, size, 0, 0, 256, 256);
        return canvas.toDataURL("image/jpeg", 0.88);
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    }

    function setProfileControlsDisabled(disabled) {
      nodes.profileDocumentForm.querySelectorAll("textarea, button").forEach((control) => {
        control.disabled = disabled;
      });
      if (!disabled) updateProfileCharacterCount();
    }

    function updateProfileCharacterCount() {
      const count = [...nodes.profileMarkdown.value].length;
      const overLimit = count > 2000;
      nodes.profileCharacterCount.textContent = count + " / 2000";
      nodes.profileCharacterCount.classList.toggle("error", overLimit);
      nodes.saveProfileBtn.disabled = overLimit;
    }

    async function saveUserProfile(event) {
      event.preventDefault();
      if ([...nodes.profileMarkdown.value].length > 2000) return;
      nodes.profileState.textContent = "保存中...";
      try {
        const response = await fetch("/api/v1/user-profile", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ markdown: nodes.profileMarkdown.value })
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "画像保存失败");
        nodes.profileMarkdown.value = typeof body.manualMarkdown === "string" ? body.manualMarkdown : body.profile.markdown;
        updateProfileCharacterCount();
        nodes.profileState.textContent = "已保存";
        setStatus("用户画像已更新");
      } catch (error) {
        nodes.profileState.textContent = error.message || String(error);
      }
    }

    function localInputToIso(value, allDay = false) {
      if (!value) return undefined;
      const date = allDay && /^\\d{4}-\\d{2}-\\d{2}$/.test(value)
        ? parseLocalDateKey(value)
        : new Date(value);
      return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
    }

    function localDateKey(value) {
      const date = value instanceof Date ? value : new Date(value);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      return year + "-" + month + "-" + day;
    }

    function parseLocalDateKey(value) {
      const [year, month, day] = String(value).split("-").map(Number);
      return new Date(year, month - 1, day);
    }

    function isoToLocalInput(value, allDay = false) {
      if (!value) return "";
      const date = new Date(value);
      if (allDay) return localDateKey(date);
      const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
      return local.toISOString().slice(0, 16);
    }

    function formatScheduleTime(value, timezone) {
      try {
        return new Intl.DateTimeFormat("zh-CN", {
          timeZone: timezone,
          month: "2-digit",
          day: "2-digit",
          weekday: "short",
          hour: "2-digit",
          minute: "2-digit"
        }).format(new Date(value));
      } catch {
        return value;
      }
    }

    function kindLabel(kind) {
      if (kind === "event") return "事件";
      if (kind === "task") return "任务";
      return "提醒";
    }

    function notificationStatusLabel(status) {
      return ({ pending: "等待投递", processing: "投递中", delivered: "已送达", failed: "投递失败" })[status] || status;
    }

    function recurrenceLabel(rule) {
      if (rule === "FREQ=DAILY") return "每天";
      if (rule === "FREQ=WEEKLY") return "每周";
      return rule;
    }

    async function loadSessionMessages() {
      return refreshSessionMessages(false);
    }

    async function refreshSessionMessages(silent) {
      if (!state.activeSessionId || state.sessionDraft) return;
      const requestedSessionId = state.activeSessionId;
      const sessionId = encodeURIComponent(requestedSessionId);
      if (!silent) setStatus("加载会话...");
      try {
        const [response, interactionResponse, inboxResponse, budgetResponse, proactiveResponse] = await Promise.all([
          fetch("/api/v1/sessions/" + sessionId + "/messages"),
          fetch("/api/v1/sessions/" + sessionId + "/interaction"),
          fetch("/api/v1/sessions/" + sessionId + "/inbox"),
          fetch("/api/v1/sessions/" + sessionId + "/context-budget"),
          fetch("/api/v1/proactive-messages?sessionId=" + sessionId + "&status=delivered&limit=100")
        ]);
        const [body, interactionBody, inboxBody, budgetBody, proactiveBody] = await Promise.all([
          response.json(),
          interactionResponse.json().catch(() => ({})),
          inboxResponse.json().catch(() => ({})),
          budgetResponse.json().catch(() => ({})),
          proactiveResponse.json().catch(() => ({}))
        ]);
        if (!response.ok) {
          throw new Error(body.error || "加载会话失败");
        }
        if (state.activeConversationKind !== "direct" || state.activeSessionId !== requestedSessionId) return;
        if (interactionResponse.ok) {
          state.interactionState = interactionBody.state || null;
          state.interactionEvents = Array.isArray(interactionBody.events) ? interactionBody.events : [];
          state.interactionCanUndo = Boolean(interactionBody.canUndo);
          state.interactionLocations = Array.isArray(interactionBody.suggestedLocations) ? interactionBody.suggestedLocations : [];
          state.characterLiveState = interactionBody.liveState || null;
        } else {
          clearInteractionState();
        }
        updateInteractionChrome();
        state.contextBudget = budgetResponse.ok ? budgetBody.budget || null : null;
        updateContextBudgetChrome();
        state.privateInboxMessages = inboxResponse.ok && Array.isArray(inboxBody.messages)
          ? inboxBody.messages
          : [];
        state.privateInboxRunning = Boolean(
          inboxResponse.ok && inboxBody.running && activePrivateBurstIds(state.privateInboxMessages).size
        );
        state.activeProactiveMessages = proactiveResponse.ok && Array.isArray(proactiveBody.messages)
          ? proactiveBody.messages
          : [];
        const storedMessages = Array.isArray(body)
          ? mergeToolResultsIntoMessages(dedupeSystemEvents(body.map(normalizeStoredMessage).filter(Boolean)))
          : [];
        const withInbox = mergePrivateInboxMessages(storedMessages, state.privateInboxMessages);
        const messages = annotateProactiveMessages(mergeInteractionEvents(
          preserveActiveBurstMessages(withInbox, state.privateInboxMessages),
          state.interactionEvents
        ), state.activeProactiveMessages);
        const latestOutcome = [...messages].reverse().find((message) => message.status);
        if (latestOutcome) {
          state.lastTurnStatus = latestOutcome.status;
          state.lastTurnCanRetry = Boolean(latestOutcome.canRetry);
          updateRetryState();
        }
        preserveLocalMessageProgress(messages);
        if (JSON.stringify(messages) !== JSON.stringify(state.messages)) {
          state.messages = messages;
          renderMessages();
        }
        updateDirectGenerationControls();
        if (!silent) setStatus("就绪");
      } catch (error) {
        if (!silent) setStatus(error.message || String(error), true);
      }
    }

    async function uploadChatAttachments() {
      const files = Array.from(nodes.chatAttachmentInput.files || []);
      nodes.chatAttachmentInput.value = "";
      await queueChatAttachments(files);
    }

    async function pasteChatAttachments(event) {
      const clipboard = event.clipboardData;
      if (!clipboard) return;
      let files = Array.from(clipboard.files || []);
      if (!files.length) {
        files = Array.from(clipboard.items || [])
          .filter((item) => item.kind === "file")
          .map((item) => item.getAsFile())
          .filter(Boolean);
      }
      if (!files.length) return;
      event.preventDefault();
      const pastedAt = Date.now();
      const normalizedFiles = files.map((file, index) => {
        if (String(file.name || "").trim()) return file;
        const extension = clipboardFileExtension(file.type);
        return new File([file], "clipboard-" + pastedAt + "-" + (index + 1) + extension, {
          type: file.type || "application/octet-stream",
          lastModified: file.lastModified || pastedAt
        });
      });
      await queueChatAttachments(normalizedFiles);
    }

    function clipboardFileExtension(contentType) {
      const extensions = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/gif": ".gif",
        "image/webp": ".webp",
        "application/pdf": ".pdf",
        "text/plain": ".txt"
      };
      return extensions[String(contentType || "").toLowerCase()] || ".bin";
    }

    async function queueChatAttachments(files) {
      if (!files.length) return;
      state.attachmentUploadQueue.push(...files);
      if (state.uploadingAttachments) {
        setStatus(state.attachmentUploadQueue.length + " 个附件等待上传...");
        return;
      }
      state.uploadingAttachments = true;
      nodes.attachFileBtn.disabled = true;
      nodes.sendBtn.disabled = true;
      setStatus("上传附件中...");
      let uploadedCount = 0;
      const failures = [];
      try {
        while (state.attachmentUploadQueue.length) {
          const file = state.attachmentUploadQueue.shift();
          try {
            const entries = await uploadWorkspaceFiles([file], "uploads");
            state.pendingAttachments.push(...entries);
            uploadedCount += entries.length;
            renderAttachmentQueue();
          } catch (error) {
            failures.push(error.message || String(error));
          }
        }
        if (failures.length) {
          const prefix = uploadedCount ? uploadedCount + " 个附件已上传；" : "";
          setStatus(prefix + failures[0] + (failures.length > 1 ? "，另有 " + (failures.length - 1) + " 个失败" : ""), true);
        } else {
          setStatus(uploadedCount + " 个附件已上传");
        }
      } finally {
        state.uploadingAttachments = false;
        nodes.attachFileBtn.disabled = false;
        nodes.sendBtn.disabled = state.busy;
      }
    }

    function renderAttachmentQueue() {
      nodes.attachmentQueue.hidden = state.pendingAttachments.length === 0;
      nodes.attachmentQueue.innerHTML = state.pendingAttachments.map((entry, index) =>
        '<div class="attachment-chip">' +
          '<i data-lucide="' + workspaceFileIcon(entry) + '" aria-hidden="true"></i>' +
          '<span class="attachment-chip-copy"><strong>' + escapeHtml(entry.name) + '</strong><small>' + escapeHtml(formatFileSize(entry.size)) + '</small></span>' +
          '<button class="attachment-remove" type="button" data-attachment-index="' + index + '" title="移除附件" aria-label="移除 ' + escapeHtml(entry.name) + '"><i data-lucide="x" aria-hidden="true"></i></button>' +
        '</div>'
      ).join("");
      refreshIcons();
    }

    function removeQueuedAttachment(event) {
      const button = event.target.closest("button[data-attachment-index]");
      if (!button || state.busy) return;
      state.pendingAttachments.splice(Number(button.dataset.attachmentIndex), 1);
      renderAttachmentQueue();
    }

    function messageWithAttachments(text, attachments) {
      if (!attachments.length) return text;
      const lines = attachments.map((entry) =>
        "- " + entry.name + " | workspace: " + entry.path + " | " + (entry.contentType || "application/octet-stream") + " | " + (entry.sizeLabel || formatFileSize(entry.size))
      );
      return (text ? text + "\\n\\n" : "") + "[附件已上传到 Workspace]\\n" + lines.join("\\n");
    }

    function generateClientMessageId() {
      if (window.crypto?.randomUUID) return window.crypto.randomUUID();
      return "msg-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
    }

    function closePrivateInboxEvents() {
      state.privateInboxSource?.close();
      state.privateInboxSource = null;
      state.privateInboxSessionId = "";
    }

    function openPrivateInboxEvents(sessionId) {
      if (!sessionId || state.activeConversationKind !== "direct") return;
      if (state.privateInboxSource && state.privateInboxSessionId === sessionId) return;
      closePrivateInboxEvents();
      const source = new EventSource(
        "/api/v1/sessions/" + encodeURIComponent(sessionId) + "/inbox/events"
      );
      state.privateInboxSource = source;
      state.privateInboxSessionId = sessionId;
      source.onmessage = (messageEvent) => {
        if (
          state.privateInboxSource !== source ||
          state.activeConversationKind !== "direct" ||
          state.activeSessionId !== sessionId
        ) return;
        try {
          void handlePrivateInboxEvent(JSON.parse(messageEvent.data)).catch((error) => {
            setStatus("消息事件处理失败：" + (error.message || String(error)), true);
          });
        } catch (error) {
          setStatus("消息事件解析失败：" + (error.message || String(error)), true);
        }
      };
      source.onerror = () => {
        if (state.privateInboxSource !== source || source.readyState !== EventSource.CLOSED) return;
        closePrivateInboxEvents();
      };
    }

    async function handlePrivateInboxEvent(event) {
      if (!event || typeof event !== "object") return;
      if (event.type === "snapshot") {
        const inbox = event.inbox || {};
        state.privateInboxMessages = Array.isArray(inbox.messages) ? inbox.messages : [];
        const activeBurstIds = activePrivateBurstIds(state.privateInboxMessages);
        state.privateInboxRunning = Boolean(inbox.running && activeBurstIds.size);
        state.privateInboxMessages.forEach(syncPrivateInboxUserBubble);
        for (const message of state.privateInboxMessages) {
          if (message.status === "processing" && message.burstId) {
            ensurePrivateBurstMessage(message.burstId, message.createdAt);
          }
        }
        const recoveredMissedCompletion = discardStalePrivateBurstPlaceholders(activeBurstIds);
        renderMessages();
        updateDirectGenerationControls();
        if (recoveredMissedCompletion) {
          await refreshSessionMessages(true);
          if (!state.privateInboxRunning) {
            if (state.lastTurnStatus) {
              applyTurnOutcome({
                status: state.lastTurnStatus,
                canRetry: state.lastTurnCanRetry
              });
            } else {
              setStatus("就绪");
            }
          }
        }
        return;
      }
      if (event.type === "message_queued" || event.type === "message_updated") {
        upsertPrivateInboxMessage(event.message);
        syncPrivateInboxUserBubble(event.message);
        renderMessages();
        return;
      }
      if (event.type === "message_retracted") {
        state.privateInboxMessages = state.privateInboxMessages.filter((message) =>
          message.id !== event.messageId && message.clientMessageId !== event.clientMessageId
        );
        state.messages = state.messages.filter((message) =>
          message.inboxMessageId !== event.messageId && message.clientMessageId !== event.clientMessageId
        );
        renderMessages();
        return;
      }
      if (event.type === "burst_started") {
        const burst = event.burst || {};
        void captureInsightReceiptBaseline(burst.id);
        const messages = Array.isArray(burst.messages) ? burst.messages : [];
        messages.forEach((message) => {
          upsertPrivateInboxMessage(message);
          syncPrivateInboxUserBubble(message);
        });
        state.privateInboxRunning = true;
        ensurePrivateBurstMessage(burst.id, messages[0]?.createdAt);
        updateDirectGenerationControls();
        renderMessages();
        return;
      }
      if (event.type === "agent_event") {
        applyPrivateAgentEvent(event.burstId, event.event);
        return;
      }
      if (event.type === "burst_done") {
        finishPrivateBurst(event.burstId, event.response || {});
        state.privateInboxMessages = state.privateInboxMessages.filter((message) =>
          !Array.isArray(event.messageIds) || !event.messageIds.includes(message.id)
        );
        state.privateInboxRunning = false;
        updateDirectGenerationControls();
        applyTurnOutcome(event.response || {});
        await refreshSessionMessages(true);
        await loadConversationScene();
        if (isConversationVisible(state.activeSessionId)) await markConversationRead(state.activeSessionId);
        void loadSessions();
        void showConversationInsightReceipt(event.burstId);
        if (state.uiMode === "debug") void loadDebugLogs();
        return;
      }
      if (event.type === "burst_failed") {
        state.insightReceiptBaselines.delete(event.burstId);
        const index = ensurePrivateBurstMessage(event.burstId);
        const message = state.messages[index];
        if (message) {
          message.role = "system";
          message.text = event.error || "模型调用失败";
          message.status = "failed";
          message.eventType = "operation_failed";
          message.progress = [];
          message.working = false;
        }
        const failedIds = new Set(Array.isArray(event.messageIds) ? event.messageIds : []);
        state.privateInboxMessages = state.privateInboxMessages.filter((entry) => !failedIds.has(entry.id));
        state.messages.forEach((entry) => {
          if (failedIds.has(entry.inboxMessageId)) entry.queueStatus = "failed";
        });
        state.privateInboxRunning = false;
        updateDirectGenerationControls();
        renderMessages();
        setStatus(event.error || "模型调用失败", true);
      }
    }

    function captureInsightReceiptBaseline(burstId) {
      if (!burstId) return;
      state.insightReceiptBaselines.set(burstId, (async () => {
        try {
          const response = await fetch("/api/v1/user-insights?limit=100");
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || "画像观察加载失败");
          const observations = Array.isArray(body.insights?.recentObservations)
            ? body.insights.recentObservations
            : [];
          return new Set(observations.map((entry) => entry.id));
        } catch {
          return null;
        }
      })());
    }

    async function showConversationInsightReceipt(burstId) {
      const baselinePromise = state.insightReceiptBaselines.get(burstId);
      const baseline = baselinePromise ? await baselinePromise : null;
      if (!baseline) {
        state.insightReceiptBaselines.delete(burstId);
        return;
      }
      const sessionId = state.activeSessionId;
      for (const delay of [400, 900, 1_800]) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (state.activeConversationKind !== "direct" || state.activeSessionId !== sessionId) break;
        try {
          const response = await fetch("/api/v1/user-insights?limit=100");
          const body = await response.json();
          if (!response.ok) continue;
          const observations = Array.isArray(body.insights?.recentObservations)
            ? body.insights.recentObservations
            : [];
          const remembered = observations.find((entry) =>
            entry.sourceType === "conversation" &&
            entry.sourceSessionId === sessionId &&
            entry.kind === "conversation_statement" &&
            entry.decision === "promoted" &&
            !baseline.has(entry.id)
          );
          if (remembered) {
            const summary = String(remembered.claimText || "").trim();
            setStatus("已记住" + (summary ? " · " + [...summary].slice(0, 36).join("") : ""));
            break;
          }
        } catch {
          // A receipt is optional observability and must not affect chat delivery.
        }
      }
      state.insightReceiptBaselines.delete(burstId);
    }

    function upsertPrivateInboxMessage(message) {
      if (!message?.id) return;
      const index = state.privateInboxMessages.findIndex((entry) => entry.id === message.id);
      if (index >= 0) state.privateInboxMessages[index] = message;
      else state.privateInboxMessages.push(message);
    }

    function syncPrivateInboxUserBubble(inboxMessage) {
      if (!inboxMessage?.id) return;
      let message = state.messages.find((entry) =>
        entry.inboxMessageId === inboxMessage.id ||
        (inboxMessage.clientMessageId && entry.clientMessageId === inboxMessage.clientMessageId)
      );
      const normalized = normalizeInboxMessage(inboxMessage);
      if (!message) {
        state.messages.push(normalized);
        return;
      }
      const localId = message.localId;
      Object.assign(message, normalized, localId ? { localId } : {});
    }

    function ensurePrivateBurstMessage(burstId, createdAt) {
      if (!burstId) return -1;
      const localId = "private-burst:" + burstId;
      const existing = state.messages.findIndex((message) => message.localId === localId);
      if (existing >= 0) return existing;
      state.messages.push(privateBurstPlaceholder(burstId, createdAt));
      return state.messages.length - 1;
    }

    function privateBurstPlaceholder(burstId, createdAt) {
      const parsedTimestamp = createdAt ? new Date(createdAt).getTime() : Date.now();
      const timestampMs = Number.isFinite(parsedTimestamp) ? parsedTimestamp + 1 : Date.now();
      return {
        role: "assistant",
        text: "",
        at: new Date(timestampMs).toLocaleTimeString(),
        timestampMs,
        localId: "private-burst:" + burstId,
        burstId,
        working: true,
        progressOpen: false,
        progress: [
          { key: "request", label: "已接收连续消息", status: "completed" },
          { key: "context", label: "准备模型上下文", status: "active" }
        ]
      };
    }

    function privateBurstId(message) {
      if (typeof message?.burstId === "string" && message.burstId) return message.burstId;
      const localId = String(message?.localId || "");
      return localId.startsWith("private-burst:") ? localId.slice("private-burst:".length) : "";
    }

    function activePrivateBurstIds(messages) {
      return new Set((Array.isArray(messages) ? messages : []).flatMap((message) =>
        message?.status === "processing" && message.burstId ? [message.burstId] : []
      ));
    }

    function discardStalePrivateBurstPlaceholders(activeBurstIds) {
      let discarded = false;
      state.messages = state.messages.filter((message) => {
        const burstId = privateBurstId(message);
        const stale = Boolean(burstId && message.working && !activeBurstIds.has(burstId));
        if (stale) discarded = true;
        return !stale;
      });
      return discarded;
    }

    function privateBurstIndex(burstId) {
      return state.messages.findIndex((message) => message.localId === "private-burst:" + burstId);
    }

    function applyPrivateAgentEvent(burstId, event) {
      let index = privateBurstIndex(burstId);
      if (index < 0) index = ensurePrivateBurstMessage(burstId);
      const message = state.messages[index];
      if (!message || !event) return;
      if (event.type === "delta") {
        updateMessageProgress(index, "generation", "生成回复", "active", true);
        const current = state.messages[privateBurstIndex(burstId)];
        if (current) current.text = String(current.text || "") + String(event.delta || "");
        renderMessages();
      } else if (event.type === "reasoning_status") {
        updateMessageProgress(index, "reasoning", "模型推理",
          event.phase === "end" ? "completed" : "active", event.phase === "end");
      } else if (event.type === "tool_start") {
        updateMessageProgress(index, "tool:" + event.toolCallId,
          "调用工具：" + toolDisplayName(event.toolName), "active", false,
          { toolName: event.toolName, toolCallId: event.toolCallId });
        setStatus("执行工具：" + toolDisplayName(event.toolName));
      } else if (event.type === "tool_end") {
        updateMessageProgress(index, "tool:" + event.toolCallId,
          "调用工具：" + toolDisplayName(event.toolName),
          event.isError ? "failed" : "completed", false,
          {
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            resultText: formatToolResult(event.result)
          });
      } else if (event.type === "auto_retry_start") {
        updateMessageProgress(index, "retry:" + event.attempt,
          "模型重试 " + event.attempt + "/" + event.maxAttempts, "active");
      } else if (event.type === "auto_retry_end") {
        updateMessageProgress(index, "retry:" + event.attempt, "模型重试 " + event.attempt,
          event.success ? "completed" : "failed");
      } else if (event.type === "lifecycle") {
        applyLifecycleProgress(index, event.eventType);
      }
    }

    function finishPrivateBurst(burstId, response) {
      let index = privateBurstIndex(burstId);
      if (index < 0) index = ensurePrivateBurstMessage(burstId);
      const message = state.messages[index];
      if (!message) return;
      message.text = response.reply || message.text || "";
      message.status = response.status;
      message.eventType = response.eventType;
      message.canRetry = Boolean(response.canRetry);
      if (response.messageType === "system") {
        message.role = "system";
        message.progress = [];
        message.progressOpen = false;
        message.working = false;
      } else {
        completeMessageProgress(index, response.status);
        addActionProgress(index, response.actions);
      }
      renderMessages();
    }

    function updateDirectGenerationControls() {
      if (state.activeConversationKind !== "direct") return;
      nodes.sendBtn.disabled = state.uploadingAttachments;
      nodes.cancelMessageBtn.disabled = !state.privateInboxRunning;
      updateRetryState();
      updateSessionActionState();
      updateInteractionChrome();
    }

    function schedulePrivateTypingHeartbeat() {
      const hasQueuedMessage = state.privateInboxMessages.some((message) => message.status === "queued");
      if (
        state.activeConversationKind !== "direct" || state.sessionDraft || !state.activeSessionId ||
        !nodes.textInput.value || !hasQueuedMessage
      ) return;
      if (state.privateTypingHeartbeatTimer) return;
      const elapsed = performance.now() - state.privateTypingHeartbeatLastSentAt;
      const delay = Math.max(0, 400 - elapsed);
      state.privateTypingHeartbeatTimer = window.setTimeout(() => {
        state.privateTypingHeartbeatTimer = null;
        void sendPrivateTypingHeartbeat();
      }, delay);
    }

    async function sendPrivateTypingHeartbeat() {
      const hasQueuedMessage = state.privateInboxMessages.some((message) => message.status === "queued");
      if (
        state.activeConversationKind !== "direct" || state.sessionDraft || !state.activeSessionId ||
        !nodes.textInput.value || !hasQueuedMessage
      ) return;
      const sessionId = state.activeSessionId;
      state.privateTypingHeartbeatLastSentAt = performance.now();
      try {
        await fetch(
          "/api/v1/sessions/" + encodeURIComponent(sessionId) + "/inbox/typing",
          { method: "POST" }
        );
      } catch {
        // Typing activity is an optimization; the bounded inbox grace window remains the fallback.
      }
    }

    async function sendMessage() {
      const rawText = nodes.textInput.value.trim();
      if (state.activeConversationKind === "world") {
        if ((!rawText && !state.pendingAttachments.length) || state.busy || state.uploadingAttachments) return;
        await sendWorldChatMessage(rawText, [...state.pendingAttachments]);
        return;
      }
      if (state.activeConversationKind === "group") {
        if (!rawText || state.busy) return;
        await sendGroupChatMessage(rawText);
        return;
      }
      if ((!rawText && !state.pendingAttachments.length) || state.uploadingAttachments) return;
      const attachments = [...state.pendingAttachments];
      const text = messageWithAttachments(rawText, attachments);
      if (!state.activeSessionId) startNewSession();
      if (!nodes.chatCharacterSelect.value) {
        setStatus("请先选择角色；如果还没有角色，请前往“角色”页创建。", true);
        nodes.chatCharacterSelect.focus();
        return;
      }
      const sessionIdValue = state.activeSessionId;
      const clientMessageId = generateClientMessageId();
      setStatus("已加入发送队列");
      closeEmojiPicker();
      nodes.textInput.value = "";
      state.pendingAttachments = [];
      renderAttachmentQueue();
      const localId = "inbox-client:" + clientMessageId;
      pushMessage("user", rawText, {
        localId,
        rawText: text,
        attachments,
        clientMessageId,
        queueStatus: "queued",
        latestUser: true,
        timestampMs: Date.now()
      });
      try {
        const response = await fetch("/api/v1/sessions/" + encodeURIComponent(sessionIdValue) + "/inbox", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            clientMessageId,
            mode: nodes.modeSelect.value,
            text,
            characterId: nodes.chatCharacterSelect.value,
            attachments: attachments.map((entry) => ({
              path: entry.path,
              name: entry.name,
              contentType: entry.contentType,
              size: entry.size
            }))
          })
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(body.error || "消息入队失败");
        }
        if (state.activeConversationKind === "direct" && state.activeSessionId === sessionIdValue) {
          const resolvedSessionId = body.message?.sessionId || sessionIdValue;
          const localMessage = state.messages.find((message) => message.localId === localId);
          if (localMessage && body.message) {
            localMessage.inboxMessageId = body.message.id;
            localMessage.queueStatus = body.message.status || "queued";
          }
          state.privateInboxMessages = Array.isArray(body.inbox?.messages)
            ? body.inbox.messages
            : state.privateInboxMessages;
          state.privateInboxRunning = Boolean(body.inbox?.running);
          const wasDraft = state.sessionDraft;
          state.activeSessionId = resolvedSessionId;
          state.sessionDraft = false;
          setSessionControlsLocked(true);
          updateSessionActionState();
          openPrivateInboxEvents(resolvedSessionId);
          renderMessages();
          updateDirectGenerationControls();
          schedulePrivateTypingHeartbeat();
          if (wasDraft || resolvedSessionId !== sessionIdValue) void loadSessions();
        }
      } catch (error) {
        if (state.activeConversationKind === "direct" && state.activeSessionId === sessionIdValue) {
          const localMessage = state.messages.find((message) => message.localId === localId);
          if (localMessage) {
            localMessage.queueStatus = "failed";
            localMessage.queueError = error.message || String(error);
          }
          renderMessages();
        }
        setStatus(error.message || String(error), true);
      } finally {
        nodes.sendBtn.disabled = state.uploadingAttachments;
        nodes.textInput.focus();
      }
    }

    async function sendWorldChatMessage(text, attachments) {
      const conversation = state.worldConversations.find((entry) => entry.worldId === state.activeWorldId);
      if (!conversation) {
        setStatus("世界不存在或已被删除。", true);
        return;
      }
      const worldId = conversation.worldId;
      state.busy = true;
      state.lastTurnStatus = null;
      state.lastTurnCanRetry = false;
      nodes.sendBtn.disabled = true;
      nodes.cancelMessageBtn.disabled = false;
      nodes.retryMessageBtn.disabled = true;
      closeEmojiPicker();
      nodes.textInput.value = "";
      state.pendingAttachments = [];
      renderAttachmentQueue();
      pushMessage("user", text, { attachments });
      setStatus("世界正在推进...");
      const progressByCharacter = new Map();
      const controller = new AbortController();
      state.worldAbortController = controller;
      let finalResponse;
      let completionWarning = "";
      try {
        const response = await fetch("/api/v1/worlds/" + encodeURIComponent(worldId) + "/conversation/messages/stream", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
            attachments: attachments.map((entry) => ({
              path: entry.path,
              name: entry.name,
              contentType: entry.contentType,
              size: entry.size
            }))
          }),
          signal: controller.signal
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || "世界演绎请求失败");
        }
        if (!response.body) throw new Error("世界演绎流式响应不可用");
        await consumeEventStream(response.body, (event) => {
          if (event.type === "director_state") {
            if (event.phase === "planning") setStatus("世界正在读取当前状态...");
            if (event.phase === "writing") setStatus("世界正在演绎...");
            if (event.phase === "failed") {
              completionWarning = event.reasonCode === "timeout"
                ? "世界模型响应超时，请重试"
                : event.reasonCode === "model_unavailable"
                  ? "世界尚未配置可用模型"
                  : event.reasonCode === "invalid_output"
                    ? "世界模型未返回可展示正文，请重试"
                    : "世界模型调用失败，请重试";
              setStatus(completionWarning, true);
            }
          }
          if (event.type === "participant_state") {
            const character = state.characters.find((entry) => entry.id === event.characterId);
            const label = character?.name || "角色";
            let index = progressByCharacter.get(event.characterId);
            if (event.phase === "typing") {
              index = pushMessage("assistant", "", {
                senderId: event.characterId,
                working: true,
                progressOpen: false,
                progress: [{ key: "generation", label: "正在输入", status: "active" }]
              });
              progressByCharacter.set(event.characterId, index);
              setStatus(label + " 正在输入...");
            } else if ((event.phase === "failed" || event.phase === "silent") && index !== undefined) {
              state.messages.splice(index, 1);
              progressByCharacter.delete(event.characterId);
              for (const [id, storedIndex] of progressByCharacter) {
                if (storedIndex > index) progressByCharacter.set(id, storedIndex - 1);
              }
              renderMessages();
            }
          }
          if (event.type === "message") {
            if (event.message.senderType === "director") {
              pushMessage("assistant", event.message.content || "", {
                worldNarration: true,
                worldMessageId: event.message.id,
                worldTurnId: event.message.turnId || ""
              });
              return;
            }
            if (event.message.senderType !== "character") return;
            const index = progressByCharacter.get(event.message.senderId);
            if (index !== undefined && state.messages[index]) {
              state.messages[index].text = event.message.content || "";
              state.messages[index].worldMessageId = event.message.id;
              state.messages[index].worldTurnId = event.message.turnId || "";
              state.messages[index].working = false;
              completeMessageProgress(index, "completed");
              progressByCharacter.delete(event.message.senderId);
              renderMessages();
            } else {
              pushMessage("assistant", event.message.content || "", {
                senderId: event.message.senderId || "",
                worldMessageId: event.message.id,
                worldTurnId: event.message.turnId || ""
              });
            }
          }
          if (event.type === "analysis_state") {
            if (event.phase === "analyzing") setStatus("正在整理世界状态...");
            if (event.phase === "failed") {
              completionWarning = event.reasonCode === "timeout"
                ? "回复已完成，世界状态整理超时"
                : "回复已完成，世界状态整理失败";
              setStatus(completionWarning, true);
            }
          }
          if (event.type === "done") finalResponse = event.response;
          if (event.type === "error") throw new Error(event.error || "世界演绎调用失败");
        });
        if (!finalResponse) throw new Error("世界演绎流式响应提前结束");
        state.lastTurnStatus = finalResponse.turn?.status || "completed";
        await refreshWorldMessages(true);
        await refreshWorldConversationList();
        if (isWorldConversationVisible(worldId)) await markWorldConversationRead(worldId);
        const outputCount = Array.isArray(finalResponse.messages) ? finalResponse.messages.length : 0;
        setStatus(outputCount ? completionWarning || "已完成" : completionWarning || "本轮没有生成可展示内容", Boolean(completionWarning) || !outputCount);
        if (state.uiMode === "debug") await loadDebugLogs();
      } catch (error) {
        await refreshWorldMessages(true);
        if (error?.name === "AbortError") setStatus("世界演绎已停止");
        else setStatus(error.message || String(error), true);
      } finally {
        state.worldAbortController = null;
        state.busy = false;
        nodes.sendBtn.disabled = state.uploadingAttachments;
        nodes.cancelMessageBtn.disabled = true;
        updateRetryState();
        updateSessionActionState();
        nodes.textInput.focus();
      }
    }

    async function refreshWorldConversationList() {
      const response = await fetch("/api/v1/world-conversations");
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "世界会话列表刷新失败");
      state.worldConversations = Array.isArray(body.conversations) ? body.conversations : [];
      state.worlds = state.worldConversations.map((entry) => entry.world).filter(Boolean);
      renderWorldOptions();
      renderConversationList();
      updateChatIdentity();
    }

    async function sendGroupChatMessage(text) {
      const group = state.groupChats.find((entry) => entry.id === state.activeGroupId);
      if (!group) {
        setStatus("群聊不存在或已被删除。", true);
        return;
      }
      state.busy = true;
      state.lastTurnStatus = null;
      state.lastTurnCanRetry = false;
      nodes.sendBtn.disabled = true;
      nodes.cancelMessageBtn.disabled = false;
      nodes.retryMessageBtn.disabled = true;
      closeEmojiPicker();
      nodes.textInput.value = "";
      setStatus("群聊调度中...");
      pushMessage("user", text);
      const progressByCharacter = new Map();
      const controller = new AbortController();
      state.groupAbortController = controller;
      let finalResponse;
      try {
        const response = await fetch("/api/v1/group-chats/" + encodeURIComponent(group.id) + "/messages/stream", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai" }),
          signal: controller.signal
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || "群聊请求失败");
        }
        if (!response.body) throw new Error("群聊流式响应不可用");
        await consumeEventStream(response.body, (event) => {
          if (event.type === "participant_state") {
            const character = state.characters.find((entry) => entry.id === event.characterId);
            const label = character?.name || "角色";
            let index = progressByCharacter.get(event.characterId);
            if (event.phase === "typing") {
              index = pushMessage("assistant", "", {
                senderId: event.characterId,
                working: true,
                progressOpen: false,
                progress: [{ key: "generation", label: "正在输入", status: "active" }]
              });
              progressByCharacter.set(event.characterId, index);
              setStatus(label + " 正在输入...");
            } else if (event.phase === "failed" && index !== undefined) {
              state.messages.splice(index, 1);
              progressByCharacter.delete(event.characterId);
              for (const [id, storedIndex] of progressByCharacter) {
                if (storedIndex > index) progressByCharacter.set(id, storedIndex - 1);
              }
              renderMessages();
            }
          }
          if (event.type === "message") {
            const index = progressByCharacter.get(event.message.senderId);
            if (index !== undefined && state.messages[index]) {
              state.messages[index].text = event.message.content || "";
              state.messages[index].working = false;
              completeMessageProgress(index, "completed");
              progressByCharacter.delete(event.message.senderId);
              renderMessages();
            }
          }
          if (event.type === "done") finalResponse = event.response;
          if (event.type === "error") throw new Error(event.error || "群聊调用失败");
        });
        if (!finalResponse) throw new Error("群聊流式响应提前结束");
        state.lastTurnStatus = finalResponse.turn?.status || "completed";
        await refreshGroupMessages(true);
        await refreshGroupChatList();
        const speakerCount = Number(finalResponse.turn?.speakerCount || 0);
        const messageCount = Number(finalResponse.turn?.messageCount ?? finalResponse.messages?.length ?? 0);
        const turnStatus = finalResponse.turn?.status || "completed";
        setStatus(messageCount
          ? speakerCount + " 个角色发送了 " + messageCount + " 条消息"
          : turnStatus === "failed" || turnStatus === "partial"
            ? "本轮角色调用失败，请在 Debug 中查看判定记录"
            : "本轮没有角色选择发言",
          !messageCount && (turnStatus === "failed" || turnStatus === "partial"));
        if (state.uiMode === "debug") await loadDebugLogs();
      } catch (error) {
        await refreshGroupMessages(true);
        if (error?.name === "AbortError") setStatus("群聊生成已停止");
        else setStatus(error.message || String(error), true);
      } finally {
        state.groupAbortController = null;
        state.busy = false;
        nodes.sendBtn.disabled = false;
        nodes.cancelMessageBtn.disabled = true;
        updateRetryState();
        nodes.textInput.focus();
      }
    }

    async function refreshGroupChatList() {
      const response = await fetch("/api/v1/group-chats");
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "群聊列表刷新失败");
      state.groupChats = Array.isArray(body.groups) ? body.groups : [];
      renderConversationList();
      updateChatIdentity();
    }

    async function consumeEventStream(stream, onEvent) {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const result = await reader.read();
        buffer += decoder.decode(result.value || new Uint8Array(), { stream: !result.done });
        const frames = buffer.split("\\n\\n");
        buffer = frames.pop() || "";
        for (const frame of frames) {
          const data = frame.split("\\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\\n");
          if (data) onEvent(JSON.parse(data));
        }
        if (result.done) break;
      }
    }

    async function cancelMessage() {
      if (state.activeConversationKind === "world") {
        if (!state.busy) return;
        state.worldAbortController?.abort();
        setStatus("正在停止世界演绎...");
        return;
      }
      if (state.activeConversationKind === "group") {
        if (!state.busy) return;
        state.groupAbortController?.abort();
        setStatus("正在停止群聊生成...");
        return;
      }
      if (!state.privateInboxRunning) return;
      const sessionId = encodeURIComponent(state.activeSessionId);
      try {
        await fetch("/api/v1/sessions/" + sessionId + "/messages/cancel", { method: "POST" });
        setStatus("正在停止...");
      } catch (error) {
        setStatus(error.message || String(error), true);
      }
    }

    async function retryMessage() {
      if (state.busy || state.sessionDraft || !state.lastTurnCanRetry) return;
      const sessionId = encodeURIComponent(state.activeSessionId);
      nodes.retryMessageBtn.disabled = true;
      setStatus("重试中...");
      const assistantIndex = pushMessage("assistant", "", {
        working: true,
        progressOpen: false,
        progress: [{ key: "retry", label: "重新调用模型", status: "active" }]
      });
      try {
        const response = await fetch("/api/v1/sessions/" + sessionId + "/messages/retry", { method: "POST" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "重试失败");
        state.messages[assistantIndex].text = body.reply || "";
        state.messages[assistantIndex].status = body.status;
        state.messages[assistantIndex].eventType = body.eventType;
        state.messages[assistantIndex].canRetry = Boolean(body.canRetry);
        if (body.messageType === "system") {
          state.messages[assistantIndex].role = "system";
          state.messages[assistantIndex].progress = [];
          state.messages[assistantIndex].working = false;
        } else {
          completeMessageProgress(assistantIndex, body.status);
        }
        renderMessages();
        applyTurnOutcome(body);
      } catch (error) {
        state.messages[assistantIndex].role = "system";
        state.messages[assistantIndex].text = error.message || String(error);
        state.messages[assistantIndex].status = "failed";
        state.messages[assistantIndex].eventType = "operation_failed";
        state.messages[assistantIndex].canRetry = state.lastTurnCanRetry;
        state.messages[assistantIndex].progress = [];
        state.messages[assistantIndex].working = false;
        renderMessages();
        updateRetryState();
        setStatus(error.message || String(error), true);
      }
    }

    function pushMessage(role, text, extra) {
      state.messages.push({ role, text, at: new Date().toLocaleTimeString(), ...(extra || {}) });
      renderMessages();
      return state.messages.length - 1;
    }

    function normalizeStoredMessage(message) {
      if (!message || typeof message !== "object") return null;
      if (message.role === "custom" && message.display === false) return null;
      const content = typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content.filter((block) => block && block.type === "text").map((block) => block.text || "").join("")
          : "";
      const failedModelText = message.errorMessage ? "模型调用失败：" + message.errorMessage : "";
      const presentation = extractMessagePresentation(message.errorMessage ? failedModelText : content);
      if (!presentation.text && !presentation.attachments.length) return null;
      const isSystemEvent = message.role === "custom" && message.customType === "rp-agent/system_event";
      const isLegacySystemReply = message.role === "assistant" &&
        (message.api === "rp-agent" || message.provider === "rp-agent" || message.model === "rp-agent");
      const role = isSystemEvent || isLegacySystemReply || message.errorMessage
        ? "system"
        : message.role === "toolResult" ? "tool" : message.role;
      const at = message.timestamp ? new Date(message.timestamp).toLocaleTimeString() : "";
      const timestampMs = message.timestamp ? new Date(message.timestamp).getTime() : 0;
      const details = message.details && typeof message.details === "object" ? message.details : {};
      return {
        role,
        text: presentation.text,
        rawText: content,
        attachments: presentation.attachments,
        at,
        entryId: typeof message.entryId === "string" ? message.entryId : "",
        latestUser: Boolean(message.latestUser),
        status: details.status || message.turnStatus,
        eventType: details.eventType,
        canRetry: Boolean(details.canRetry ?? message.canRetry),
        toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : "",
        toolName: typeof message.toolName === "string" ? message.toolName : "",
        isError: Boolean(message.isError),
        timestampMs: Number.isFinite(timestampMs) ? timestampMs : 0
      };
    }

    function normalizeInboxMessage(message) {
      const presentation = extractMessagePresentation(message?.text || "");
      const explicitAttachments = Array.isArray(message?.attachments) ? message.attachments : [];
      const attachments = presentation.attachments.length
        ? presentation.attachments.map((entry) => {
            const source = explicitAttachments.find((candidate) => candidate.path === entry.path);
            return source ? { ...entry, ...source } : entry;
          })
        : explicitAttachments;
      const timestampMs = message?.createdAt ? new Date(message.createdAt).getTime() : Date.now();
      return {
        role: "user",
        text: presentation.text,
        rawText: String(message?.text || ""),
        attachments,
        at: new Date(Number.isFinite(timestampMs) ? timestampMs : Date.now()).toLocaleTimeString(),
        timestampMs: Number.isFinite(timestampMs) ? timestampMs : Date.now(),
        localId: "inbox:" + String(message?.id || message?.clientMessageId || generateClientMessageId()),
        inboxMessageId: String(message?.id || ""),
        clientMessageId: String(message?.clientMessageId || ""),
        queueStatus: message?.status || "queued",
        queueError: message?.lastError || "",
        latestUser: message?.status === "queued"
      };
    }

    function mergePrivateInboxMessages(messages, inboxMessages) {
      const merged = [...messages];
      const consumedTranscriptIndexes = new Set();
      for (const inboxMessage of Array.isArray(inboxMessages) ? inboxMessages : []) {
        const normalized = normalizeInboxMessage(inboxMessage);
        const transcriptIndex = inboxMessage.status === "processing"
          ? merged.findIndex((message, index) =>
              !consumedTranscriptIndexes.has(index) &&
              message.role === "user" &&
              String(message.rawText || message.text || "") === String(inboxMessage.text || "") &&
              Math.abs((message.timestampMs || 0) - normalized.timestampMs) < 120_000
            )
          : -1;
        if (transcriptIndex >= 0) {
          consumedTranscriptIndexes.add(transcriptIndex);
          Object.assign(merged[transcriptIndex], {
            inboxMessageId: normalized.inboxMessageId,
            clientMessageId: normalized.clientMessageId,
            queueStatus: normalized.queueStatus
          });
        } else if (!merged.some((message) =>
          message.inboxMessageId === normalized.inboxMessageId ||
          (normalized.clientMessageId && message.clientMessageId === normalized.clientMessageId)
        )) {
          merged.push(normalized);
        }
      }
      return merged
        .map((message, index) => ({ message, index }))
        .sort((left, right) =>
          (left.message.timestampMs || 0) - (right.message.timestampMs || 0) || left.index - right.index
        )
        .map((entry) => entry.message);
    }

    function preserveActiveBurstMessages(messages, inboxMessages) {
      const output = [...messages];
      const burstStarts = new Map();
      for (const message of Array.isArray(inboxMessages) ? inboxMessages : []) {
        if (message.status === "processing" && message.burstId && !burstStarts.has(message.burstId)) {
          burstStarts.set(message.burstId, message.createdAt);
        }
      }
      for (const [burstId, createdAt] of burstStarts) {
        const localId = "private-burst:" + burstId;
        if (output.some((message) => message.localId === localId)) continue;
        const existing = state.messages.find((message) => message.localId === localId);
        output.push(existing || privateBurstPlaceholder(burstId, createdAt));
      }
      return output
        .map((message, index) => ({ message, index }))
        .sort((left, right) =>
          (left.message.timestampMs || 0) - (right.message.timestampMs || 0) || left.index - right.index
        )
        .map((entry) => entry.message);
    }

    function mergeInteractionEvents(messages, events) {
      const transitions = (Array.isArray(events) ? events : []).filter((event) =>
        event && (event.status === "applied" || event.status === "pending")
      ).map((event) => {
        const timestamp = event.appliedAt || event.createdAt;
        const timestampMs = timestamp ? new Date(timestamp).getTime() : 0;
        return {
          role: "interaction",
          text: event.summary || "互动状态已更新",
          interactionType: event.type,
          interactionEventId: event.id,
          interactionStatus: event.status,
          location: event.location || "",
          timestampMs: Number.isFinite(timestampMs) ? timestampMs : 0,
          at: timestamp ? new Date(timestamp).toLocaleTimeString() : ""
        };
      });
      return [...messages, ...transitions]
        .map((message, index) => ({ message, index }))
        .sort((left, right) =>
          (left.message.timestampMs || 0) - (right.message.timestampMs || 0) || left.index - right.index
        )
        .map((entry) => entry.message);
    }

    function extractMessagePresentation(value) {
      const source = String(value || "").trim();
      const marker = "[附件已上传到 Workspace]";
      const markerIndex = source.lastIndexOf(marker);
      if (markerIndex < 0) return { text: source, attachments: [] };
      const attachments = source.slice(markerIndex + marker.length).trim().split("\\n").flatMap((line) => {
        const normalized = line.trim();
        if (!normalized.startsWith("- ")) return [];
        const workspaceSeparator = " | workspace: ";
        const nameEnd = normalized.indexOf(workspaceSeparator);
        if (nameEnd < 2) return [];
        const fields = normalized.slice(nameEnd + workspaceSeparator.length).split(" | ");
        if (fields.length < 3) return [];
        const path = fields.shift().trim();
        const contentType = fields.shift().trim();
        const sizeLabel = fields.join(" | ").trim();
        if (!isSafeWorkspacePath(path)) return [];
        return [{
          name: normalized.slice(2, nameEnd).trim() || path.split("/").pop() || "附件",
          path,
          contentType,
          sizeLabel
        }];
      });
      if (!attachments.length) return { text: source, attachments: [] };
      return { text: source.slice(0, markerIndex).trim(), attachments };
    }

    function mergeToolResultsIntoMessages(messages) {
      const merged = [];
      let pendingTools = [];

      const attachPending = (target) => {
        if (!target || !pendingTools.length) return false;
        target.progress = Array.isArray(target.progress) ? target.progress : [];
        pendingTools.forEach((tool, toolIndex) => {
          target.progress.push({
            key: "tool:" + (tool.toolCallId || tool.toolName || toolIndex),
            label: "调用工具：" + toolDisplayName(tool.toolName),
            status: tool.isError ? "failed" : "completed",
            toolName: tool.toolName,
            toolCallId: tool.toolCallId,
            resultText: tool.text
          });
        });
        target.working = false;
        pendingTools = [];
        return true;
      };

      for (const message of messages) {
        if (message.role === "tool") {
          pendingTools.push(message);
          continue;
        }
        if (pendingTools.length && message.role === "assistant") attachPending(message);
        if (pendingTools.length && (message.role === "user" || message.role === "system")) {
          attachPending([...merged].reverse().find((entry) => entry.role === "assistant"));
        }
        merged.push(message);
      }
      if (pendingTools.length) {
        attachPending([...merged].reverse().find((entry) => entry.role === "assistant"));
      }
      return merged;
    }

    function dedupeSystemEvents(messages) {
      return messages.filter((message, index) => !(
        message.role === "system" &&
        messages[index + 1]?.role === "system" &&
        messages[index + 1]?.text === message.text
      ));
    }

    function preserveLocalMessageProgress(messages) {
      const previous = state.messages.filter((message) =>
        message.role === "assistant" && Array.isArray(message.progress) && message.progress.length
      );
      const activeBurstIds = activePrivateBurstIds(state.privateInboxMessages);
      const used = new Set();
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.role !== "assistant") continue;
        for (let previousIndex = previous.length - 1; previousIndex >= 0; previousIndex -= 1) {
          const previousMessage = previous[previousIndex];
          const sameIdentity = Boolean(
            (message.entryId && previousMessage.entryId && message.entryId === previousMessage.entryId) ||
            (message.localId && previousMessage.localId && message.localId === previousMessage.localId)
          );
          if (used.has(previousIndex) || (!sameIdentity && previousMessage.text !== message.text)) continue;
          const burstId = privateBurstId(message);
          const preserveWorking = Boolean(
            previousMessage.working && sameIdentity && burstId && activeBurstIds.has(burstId)
          );
          if (previousMessage.working && !preserveWorking) continue;
          message.progress = previousMessage.progress;
          message.progressOpen = previousMessage.progressOpen;
          message.working = preserveWorking;
          used.add(previousIndex);
          break;
        }
      }
    }

    function annotateProactiveMessages(messages, proactiveMessages) {
      const candidates = (Array.isArray(proactiveMessages) ? proactiveMessages : [])
        .filter((entry) => entry?.status === "delivered" && entry.text);
      const used = new Set();
      for (const message of messages) {
        if (message.role !== "assistant") continue;
        let best = null;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (const candidate of candidates) {
          if (used.has(candidate.id) || String(candidate.text).trim() !== String(message.text || "").trim()) continue;
          const deliveredAt = new Date(candidate.deliveredAt || candidate.updatedAt).getTime();
          const distance = message.timestampMs && Number.isFinite(deliveredAt)
            ? Math.abs(message.timestampMs - deliveredAt)
            : 0;
          if (distance <= 120_000 && distance < bestDistance) {
            best = candidate;
            bestDistance = distance;
          }
        }
        if (best) {
          message.proactiveMessage = best;
          used.add(best.id);
        }
      }
      return messages;
    }

    function renderMessages() {
      const openProactiveFeedbackIds = new Set(
        Array.from(nodes.messages.querySelectorAll("details.proactive-feedback[open]"))
          .map((details) => details.querySelector("[data-proactive-message-id]")?.dataset.proactiveMessageId)
          .filter(Boolean)
      );
      if (!state.messages.length) {
        if (state.activeConversationKind === "world") {
          const conversation = state.worldConversations.find((entry) => entry.worldId === state.activeWorldId);
          nodes.messages.innerHTML = '<div class="chat-empty"><span class="brand-mark group-empty-avatar">' + worldAvatarCluster(conversation) + '</span><strong>' + escapeHtml(conversation?.world?.name || "共享世界") + '</strong></div>';
          refreshIcons();
          return;
        }
        if (state.activeConversationKind === "group") {
          const group = state.groupChats.find((entry) => entry.id === state.activeGroupId);
          nodes.messages.innerHTML = '<div class="chat-empty"><span class="brand-mark group-empty-avatar">' + groupAvatarCluster(group) + '</span><strong>' + escapeHtml(group?.title || "群聊") + '</strong></div>';
          refreshIcons();
          return;
        }
        const character = state.characters.find((entry) => entry.id === state.selectedCharacterId);
        const identity = character ? character.name : "请先创建或选择角色";
        nodes.messages.innerHTML = '<div class="chat-empty"><span class="brand-mark">' + avatarImageOrInitial(character?.avatarUrl, character?.name) + '</span><strong>' + escapeHtml(identity) + '</strong></div>';
        refreshIcons();
        return;
      }
      if (state.activeConversationKind === "world") {
        renderWorldTimeline();
        return;
      }
      nodes.messages.innerHTML = state.messages.map(renderStandardMessage).join("");
      for (const messageId of openProactiveFeedbackIds) {
        const button = Array.from(nodes.messages.querySelectorAll("[data-proactive-message-id]"))
          .find((entry) => entry.dataset.proactiveMessageId === messageId);
        const details = button?.closest("details.proactive-feedback");
        if (details) details.open = true;
      }
      refreshIcons();
      nodes.messages.scrollTop = nodes.messages.scrollHeight;
    }

    function renderStandardMessage(message, index) {
        if (message.role === "interaction") return renderInteractionEvent(message);
        if (message.role === "system") {
          return '<div class="message-row system" role="status">' +
            '<div class="system-event"><i data-lucide="' + escapeHtml(systemEventIcon(message.eventType)) + '" aria-hidden="true"></i>' +
            '<div class="markdown-body">' + renderMarkdown(message.text) + '</div>' +
            renderSystemEventActions(message, index) + '</div></div>';
        }
        const progress = renderMessageProgress(message, index);
        const media = renderMessageAttachments(message.attachments);
        const segments = assistantBubbleSegments(message);
        const hasText = segments.length > 0;
        const bubbleContent = (hasText ? segments : [""]).map((segment, segmentIndex) => {
          const segmentMedia = segmentIndex === 0 ? media : "";
          const segmentProgress = segmentIndex === 0 ? progress : "";
          const segmentText = segment
            ? '<div class="bubble-text markdown-body">' + renderMarkdown(segment, true) + '</div>'
            : "";
          const mediaOnly = segmentMedia && !segmentText ? " media-only" : "";
          return '<div class="bubble ' + escapeHtml(message.role) + mediaOnly + '">' +
            segmentProgress + segmentMedia + segmentText + '</div>';
        }).join("");
        const meta = [roleLabel(message), message.at, privateQueueLabel(message)].filter(Boolean).join(" · ");
        return '<div class="message-row ' + escapeHtml(message.role) + (message.worldNarration ? ' world-narration' : '') + '">' +
          renderMessageAvatar(message) +
          '<div class="message-stack">' +
            '<span class="meta">' + escapeHtml(meta) + '</span>' +
            '<div class="message-bubble-row"><div class="message-bubble-content">' + bubbleContent + '</div>' +
              renderMessageActions(message, index) + '</div>' +
          '</div>' +
        '</div>';
    }

    function renderWorldTimeline() {
      const blocks = [];
      let sceneEntries = [];
      const flushScene = () => {
        if (!sceneEntries.length) return;
        blocks.push(renderWorldSceneTurn(sceneEntries));
        sceneEntries = [];
      };
      state.messages.forEach((message, index) => {
        if (message.role === "assistant") {
          const currentTurnId = sceneEntries[0]?.message?.worldTurnId || "";
          if (sceneEntries.length && message.worldTurnId && currentTurnId && message.worldTurnId !== currentTurnId) {
            flushScene();
          }
          sceneEntries.push({ message, index });
          return;
        }
        flushScene();
        blocks.push(renderStandardMessage(message, index));
      });
      flushScene();
      nodes.messages.innerHTML = blocks.join("");
      refreshIcons();
      nodes.messages.scrollTop = nodes.messages.scrollHeight;
    }

    function renderWorldSceneTurn(entries) {
      const conversation = state.worldConversations.find((entry) => entry.worldId === state.activeWorldId);
      const event = conversation?.activeEvent;
      const explicitCharacterIds = [...new Set(entries.map((entry) => entry.message.senderId).filter(Boolean))];
      const characterIds = explicitCharacterIds.length
        ? explicitCharacterIds
        : (event?.participantIds?.length ? event.participantIds : conversation?.characterIds || []).slice(0, 6);
      const participants = characterIds.map((id) => {
        const character = state.characters.find((entry) => entry.id === id);
        if (!character) return "";
        return '<button class="world-scene-mini-avatar character-profile-trigger" type="button" data-character-profile-id="' +
          escapeHtml(character.id) + '" title="查看' + escapeHtml(character.name) + '的资料" aria-label="查看' +
          escapeHtml(character.name) + '的资料">' + avatarImageOrInitial(character.avatarUrl, character.name) + '</button>';
      }).join("");
      const firstTime = entries.find((entry) => entry.message.at)?.message.at || "";
      const title = event?.title || conversation?.world?.name || "世界演绎";
      const fragments = entries.map(({ message, index }) => {
        const character = state.characters.find((entry) => entry.id === message.senderId);
        const label = message.worldNarration ? conversation?.world?.name || "世界演绎" : character?.name || "角色";
        const speaker = character
          ? '<button class="world-scene-speaker character-profile-trigger" type="button" data-character-profile-id="' +
              escapeHtml(character.id) + '">' + escapeHtml(label) + '</button>'
          : '<span class="world-scene-speaker">' + escapeHtml(label) + '</span>';
        const progress = renderMessageProgress(message, index);
        const media = renderMessageAttachments(message.attachments);
        const prose = message.text
          ? '<div class="world-scene-text markdown-body">' + renderMarkdown(message.text, true) + '</div>'
          : "";
        return '<section class="world-scene-fragment' + (message.worldNarration ? ' director' : '') + '">' +
          speaker + progress + media + prose + '</section>';
      }).join("");
      return '<article class="world-scene-turn"><header class="world-scene-head"><div class="world-scene-head-copy"><strong>' +
        escapeHtml(title) + '</strong><span>世界回合' + (firstTime ? ' · ' + escapeHtml(firstTime) : '') +
        '</span></div><div class="world-scene-participants">' + participants + '</div></header>' +
        '<div class="world-scene-copy">' + fragments + '</div></article>';
    }

    function assistantBubbleSegments(message) {
      const text = String(message.text || "").trim();
      if (!text) return [];
      const remoteSms = message.role === "assistant" && state.activeConversationKind === "direct" &&
        nodes.modeSelect.value === "sms" && state.interactionState?.presence !== "co_present";
      if (!remoteSms || /\\u0060{3}|^\\s*\\|.+\\|\\s*$/mu.test(text)) return [text];
      const paragraphs = text.split(/\\n\\s*\\n+/u).map((entry) => entry.trim()).filter(Boolean);
      if (paragraphs.length < 2) return [text];
      if (paragraphs.length <= 4) return paragraphs;
      return [...paragraphs.slice(0, 3), paragraphs.slice(3).join("\\n\\n")];
    }

    function renderInteractionEvent(message) {
      const icon = message.interactionType === "begin_meeting"
        ? "map-pin-check"
        : message.interactionType === "end_meeting"
          ? "message-circle"
          : message.interactionType === "undo_transition" ? "undo-2" : "calendar-clock";
      const pendingActions = message.interactionType === "propose_meeting" &&
        state.interactionState?.presence === "meeting_pending" &&
        state.interactionState?.location === message.location
        ? '<span class="interaction-event-actions">' +
            '<button class="primary" type="button" data-interaction-action="begin">我到了</button>' +
            '<button type="button" data-interaction-action="cancel">取消</button></span>'
        : "";
      return '<div class="message-row interaction" role="status"><div class="interaction-event">' +
        '<span class="interaction-event-copy"><i data-lucide="' + icon + '" aria-hidden="true"></i><span>' +
        escapeHtml(message.text) + '</span></span>' + pendingActions + '</div></div>';
    }

    function renderMessageAttachments(attachments) {
      if (!Array.isArray(attachments) || !attachments.length) return "";
      const images = attachments.filter(isImageAttachment);
      const files = attachments.filter((entry) => !isImageAttachment(entry));
      const imageGrid = images.length
        ? '<div class="message-image-grid' + (images.length > 1 ? ' multiple' : '') + '">' + images.map((entry) => {
            const name = entry.name || entry.path.split("/").pop() || "图片";
            return '<button class="message-image-thumb" type="button" data-message-image="true" data-image-path="' + escapeHtml(entry.path) + '" data-image-name="' + escapeHtml(name) + '" aria-label="查看图片 ' + escapeHtml(name) + '">' +
              '<img src="' + escapeHtml(workspaceFileContentUrl(entry.path, "inline")) + '" alt="' + escapeHtml(name) + '" loading="lazy" /></button>';
          }).join("") + '</div>'
        : "";
      const fileList = files.map((entry) => {
        const name = entry.name || entry.path.split("/").pop() || "附件";
        return '<a class="message-file-attachment" href="' + escapeHtml(workspaceFileContentUrl(entry.path, "attachment")) + '" download>' +
          '<i data-lucide="file" aria-hidden="true"></i><span class="message-file-copy"><strong>' + escapeHtml(name) + '</strong><small>' + escapeHtml(entry.sizeLabel || formatFileSize(entry.size)) + '</small></span>' +
          '<i class="message-file-download" data-lucide="download" aria-hidden="true"></i></a>';
      }).join("");
      return '<div class="message-attachments">' + imageGrid + fileList + '</div>';
    }

    function isImageAttachment(entry) {
      return entry?.previewKind === "image" || String(entry?.contentType || "").toLowerCase().startsWith("image/");
    }

    function systemEventIcon(eventType) {
      if (eventType === "model_unavailable") return "settings";
      if (eventType === "module_disabled") return "blocks";
      if (eventType === "operation_failed") return "circle-alert";
      if (eventType === "cancelled") return "circle-stop";
      if (eventType === "operation_completed") return "circle-check";
      return "info";
    }

    function renderSystemEventActions(message, index) {
      const actions = [];
      if (message.eventType === "model_unavailable") {
        actions.push(systemActionButton("model-settings", "settings", "前往模型设置"));
      }
      if (message.eventType === "module_disabled") {
        actions.push(systemActionButton("module-management", "blocks", "前往模块管理"));
      }
      const latestOutcomeIndex = state.messages.findLastIndex((entry) => Boolean(entry.status));
      if (message.canRetry && index === latestOutcomeIndex) {
        actions.push(systemActionButton("retry", "rotate-ccw", "重试本轮"));
      }
      return actions.length ? '<span class="system-event-actions">' + actions.join("") + '</span>' : "";
    }

    function renderMessageActions(message, index) {
      if (state.busy) return "";
      if (message.role === "assistant" && message.proactiveMessage) {
        const proactive = message.proactiveMessage;
        if (proactive.feedbackType) {
          return '<span class="message-actions"><span class="message-action proactive-feedback-receipt" title="' +
            escapeHtml(proactiveFeedbackLabel(proactive.feedbackType)) + '" aria-label="' +
            escapeHtml(proactiveFeedbackLabel(proactive.feedbackType)) + '"><i data-lucide="check" aria-hidden="true"></i></span></span>';
        }
        return '<span class="message-actions proactive-message-actions"><details class="proactive-feedback"><summary class="message-action" title="调整主动消息" aria-label="调整主动消息"><i data-lucide="sliders-horizontal" aria-hidden="true"></i></summary>' +
          '<div class="proactive-feedback-panel">' +
            proactiveFeedbackButton(proactive.id, "helpful", "thumbs-up", "这条有帮助") +
            proactiveFeedbackButton(proactive.id, "less_often", "clock-3", "这类消息少一点") +
            proactiveFeedbackButton(proactive.id, "mute_topic", "bell-off", "不再发送这个主题") +
            proactiveFeedbackButton(proactive.id, "pause_24h", "pause", "暂停主动消息 24 小时") +
          '</div></details></span>';
      }
      if (message.role !== "user") return "";
      const queued = message.queueStatus === "queued" && Boolean(message.inboxMessageId);
      const storedLatest = message.latestUser && Boolean(message.entryId);
      if (!queued && !storedLatest) return "";
      return '<span class="message-actions">' +
        (message.text ? '<button class="message-action" type="button" data-message-action="edit" data-message-index="' + index + '" title="编辑并重新发送" aria-label="编辑消息"><i data-lucide="pencil" aria-hidden="true"></i></button>' : '') +
        '<button class="message-action" type="button" data-message-action="retract" data-message-index="' + index + '" title="撤回消息" aria-label="撤回消息"><i data-lucide="undo-2" aria-hidden="true"></i></button>' +
        '</span>';
    }

    function proactiveFeedbackButton(messageId, feedbackType, icon, label) {
      return '<button type="button" data-proactive-message-id="' + escapeHtml(messageId) + '" data-proactive-feedback="' +
        escapeHtml(feedbackType) + '"><i data-lucide="' + escapeHtml(icon) + '" aria-hidden="true"></i><span>' +
        escapeHtml(label) + '</span></button>';
    }

    async function handleProactiveFeedback(event) {
      const button = event.target.closest("button[data-proactive-feedback]");
      if (!button) return;
      const messageId = button.dataset.proactiveMessageId || "";
      const feedbackType = button.dataset.proactiveFeedback || "";
      if (!messageId || !feedbackType) return;
      button.disabled = true;
      try {
        const response = await fetch("/api/v1/proactive-messages/" + encodeURIComponent(messageId) + "/feedback", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ feedbackType })
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "主动消息反馈保存失败");
        const index = state.activeProactiveMessages.findIndex((entry) => entry.id === messageId);
        if (index >= 0) state.activeProactiveMessages[index] = body.message;
        for (const message of state.messages) {
          if (message.proactiveMessage?.id === messageId) message.proactiveMessage = body.message;
        }
        renderMessages();
        setStatus("已记录：" + proactiveFeedbackLabel(feedbackType));
      } catch (error) {
        button.disabled = false;
        setStatus(error.message || String(error), true);
      }
    }

    let editingMessage = null;

    async function handleMessageAction(event) {
      const button = event.target.closest("button[data-message-action]");
      if (!button || state.busy) return;
      const message = state.messages[Number(button.dataset.messageIndex)];
      const queued = message?.queueStatus === "queued" && Boolean(message?.inboxMessageId);
      if (!queued && (!message?.entryId || !message.latestUser)) return;
      if (button.dataset.messageAction === "edit") {
        editingMessage = message;
        nodes.messageEditText.value = message.text;
        nodes.messageEditError.textContent = "";
        nodes.messageEditDialog.showModal();
        refreshIcons();
        requestAnimationFrame(() => { nodes.messageEditText.focus(); nodes.messageEditText.select(); });
        return;
      }
      const confirmed = await openActionDialog({
        title: "撤回消息",
        description: "撤回后，这条消息及其后的角色回复会从当前对话分支移除。已产生现实副作用的轮次不能撤回。",
        confirmLabel: "撤回",
      });
      if (!confirmed) return;
      await reviseMessage(message, "retract");
    }

    function closeMessageEditDialog() {
      if (nodes.messageEditDialog.open) nodes.messageEditDialog.close();
      editingMessage = null;
      nodes.messageEditError.textContent = "";
    }

    async function submitMessageEdit(event) {
      event.preventDefault();
      if (!editingMessage || state.busy) return;
      const text = nodes.messageEditText.value.trim();
      if (!text) {
        nodes.messageEditError.textContent = "消息不能为空。";
        return;
      }
      await reviseMessage(editingMessage, "edit", messageWithAttachments(text, editingMessage.attachments || []));
    }

    async function reviseMessage(message, action, text) {
      const queued = message.queueStatus === "queued" && Boolean(message.inboxMessageId);
      state.busy = true;
      nodes.submitMessageEditBtn.disabled = true;
      nodes.messageEditError.textContent = "";
      setStatus(action === "edit"
        ? queued ? "正在更新待发送消息..." : "正在重新生成回复..."
        : "正在撤回...");
      try {
        const response = queued
          ? await fetch(
              "/api/v1/sessions/" + encodeURIComponent(state.activeSessionId) +
                "/inbox/" + encodeURIComponent(message.inboxMessageId),
              {
                method: action === "edit" ? "PATCH" : "DELETE",
                headers: { "content-type": "application/json" },
                body: action === "edit" ? JSON.stringify({ text }) : undefined,
              },
            )
          : await fetch(
              "/api/v1/sessions/" + encodeURIComponent(state.activeSessionId) +
                "/messages/" + encodeURIComponent(message.entryId) + "/" + action,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(action === "edit" ? { text } : {}),
              },
            );
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "消息操作失败");
        closeMessageEditDialog();
        await refreshSessionMessages(true);
        await loadSessions();
        setStatus(action === "edit"
          ? queued ? "待发送消息已更新" : "消息已编辑并重新发送"
          : "消息已撤回");
      } catch (error) {
        const messageText = error.message || String(error);
        if (nodes.messageEditDialog.open) nodes.messageEditError.textContent = messageText;
        setStatus(messageText, true);
      } finally {
        state.busy = false;
        nodes.submitMessageEditBtn.disabled = false;
        nodes.sendBtn.disabled = false;
        updateRetryState();
        renderMessages();
      }
    }

    function systemActionButton(action, icon, label) {
      return '<button class="system-event-action" type="button" data-system-action="' + action +
        '" title="' + escapeHtml(label) + '" aria-label="' + escapeHtml(label) + '">' +
        '<i data-lucide="' + icon + '" aria-hidden="true"></i></button>';
    }

    function handleSystemEventAction(event) {
      const button = event.target.closest("button[data-system-action]");
      if (!button) return;
      if (button.dataset.systemAction === "model-settings") {
        state.settingsTab = "model";
        setUiMode("settings");
        return;
      }
      if (button.dataset.systemAction === "module-management") {
        state.managementTab = "modules";
        setUiMode("management");
        return;
      }
      if (button.dataset.systemAction === "retry") void retryMessage();
    }

    function handleCharacterProfileClick(event) {
      const trigger = event.target.closest("[data-character-profile-id]");
      const characterId = trigger?.dataset.characterProfileId || "";
      if (!characterId) return;
      void openCharacterProfile(characterId);
    }

    async function openCharacterChannel(channelId, refreshOnly) {
      const channel = state.characterChannels.find((entry) => entry.id === channelId);
      state.activeCharacterChannelId = channelId;
      nodes.characterChannelTitle.textContent = channel?.characterNames?.join(" 与 ") || "角色通信";
      nodes.characterChannelParticipants.innerHTML = channel
        ? characterChannelAvatar(channel) + '<strong>' + escapeHtml(channel.characterNames.join(" 与 ")) +
          '</strong><span>加载中...</span>'
        : '<strong>角色通信</strong><span>加载中...</span>';
      nodes.characterChannelMessages.innerHTML = '<div class="character-channel-empty">正在加载</div>';
      if (!nodes.characterChannelDialog.open) nodes.characterChannelDialog.showModal();
      refreshIcons();
      try {
        const response = await fetch("/api/v1/character-channels/" + encodeURIComponent(channelId));
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "角色通信加载失败");
        if (state.activeCharacterChannelId !== channelId) return;
        state.activeCharacterChannelSnapshot = body.snapshot;
        renderCharacterChannel(body.snapshot);
        const readResponse = await fetch(
          "/api/v1/character-channels/" + encodeURIComponent(channelId) + "/read",
          { method: "POST" }
        );
        if (readResponse.ok) {
          const summary = state.characterChannels.find((entry) => entry.id === channelId);
          if (summary) summary.unreadCount = 0;
          renderConversationList();
        }
        if (!refreshOnly) {
          setConversationListOpen(false);
          nodes.characterChannelDialog.focus();
        }
      } catch (error) {
        nodes.characterChannelMessages.innerHTML = '<div class="character-channel-empty">' +
          escapeHtml(error.message || String(error)) + '</div>';
      }
    }

    function renderCharacterChannel(snapshot) {
      const channel = snapshot?.channel;
      if (!channel) return;
      const names = channel.characterNames || ["角色", "角色"];
      nodes.characterChannelTitle.textContent = names.join(" 与 ");
      const latestEpisode = (snapshot.episodes || [])[0];
      const statusLabel = ({
        queued: "等待中", running: "交流中", completed: "已完成",
        declined: "未继续", failed: "未完成", cancelled: "已取消"
      })[latestEpisode?.status] || "角色私聊";
      nodes.characterChannelParticipants.innerHTML = characterChannelAvatar(channel) +
        '<strong>' + escapeHtml(names.join(" 与 ")) + '</strong><span>' + escapeHtml(statusLabel) + '</span>';
      const messages = snapshot.messages || [];
      nodes.characterChannelMessages.innerHTML = messages.length
        ? messages.map((message) => {
            if (message.senderType === "system") {
              return '<div class="character-channel-system">' + escapeHtml(message.content) + '</div>';
            }
            const character = state.characters.find((entry) => entry.id === message.senderCharacterId);
            const fallbackIndex = channel.characterIds?.indexOf(message.senderCharacterId) ?? -1;
            const name = character?.name || names[fallbackIndex] || "角色";
            const time = new Date(message.createdAt);
            const timeLabel = Number.isNaN(time.getTime()) ? "" : time.toLocaleString("zh-CN", {
              month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
            });
            return '<div class="character-channel-message">' +
              '<span class="character-channel-message-avatar" style="--avatar-hue:' + avatarHue(name) + '">' +
                avatarImageOrInitial(character?.avatarUrl, name) + '</span>' +
              '<div class="character-channel-message-copy"><span class="character-channel-message-meta">' +
                escapeHtml(name + (timeLabel ? " · " + timeLabel : "")) + '</span>' +
                '<div class="character-channel-message-bubble">' + escapeHtml(message.content) + '</div></div></div>';
          }).join("")
        : '<div class="character-channel-empty">尚无角色间消息</div>';
      nodes.characterChannelMessages.scrollTop = nodes.characterChannelMessages.scrollHeight;
      refreshIcons();
    }

    function closeCharacterChannel() {
      if (nodes.characterChannelDialog.open) nodes.characterChannelDialog.close();
      state.activeCharacterChannelId = "";
      state.activeCharacterChannelSnapshot = null;
    }

    async function openCharacterProfile(characterId) {
      const cached = state.characters.find((entry) => entry.id === characterId);
      if (!cached) return;
      nodes.characterProfileDialog.dataset.characterId = characterId;
      renderCharacterProfile(cached);
      if (!nodes.characterProfileDialog.open) nodes.characterProfileDialog.showModal();
      refreshIcons();
      try {
        const response = await fetch("/api/v1/characters/" + encodeURIComponent(characterId));
        const body = await response.json();
        if (!response.ok || !body.character) return;
        const index = state.characters.findIndex((entry) => entry.id === characterId);
        const character = { ...(index >= 0 ? state.characters[index] : cached), ...body.character };
        if (index >= 0) state.characters[index] = character;
        if (nodes.characterProfileDialog.open && nodes.characterProfileDialog.dataset.characterId === characterId) {
          renderCharacterProfile(character);
        }
      } catch {
        // Cached character data remains available when a refresh cannot be completed.
      }
    }

    function renderCharacterProfile(character) {
      nodes.characterProfileAvatar.style.setProperty("--avatar-hue", avatarHue(character.name || "角色"));
      nodes.characterProfileAvatar.innerHTML = avatarImageOrInitial(character.avatarUrl, character.name, "角");
      nodes.characterProfileName.textContent = character.name || "未命名角色";
      nodes.characterProfileMeta.textContent = "SOUL.md · " + Number(character.soulCharacterCount || 0).toLocaleString() + " 字";
      const soul = String(character.soulMarkdown || "").trim();
      nodes.characterProfileSoul.innerHTML = soul
        ? renderMarkdown(soul)
        : '<p class="character-profile-empty">暂无角色设定</p>';
    }

    function closeCharacterProfile() {
      if (nodes.characterProfileDialog.open) nodes.characterProfileDialog.close();
      delete nodes.characterProfileDialog.dataset.characterId;
    }

    function renderMessageAvatar(message) {
      const content = messageAvatar(message);
      if (message.role !== "assistant") {
        return '<div class="message-avatar" aria-hidden="true">' + content + '</div>';
      }
      if (message.worldNarration) {
        return '<div class="message-avatar world-avatar" aria-hidden="true">' + content + '</div>';
      }
      const character = state.characters.find((entry) => entry.id === (message.senderId || state.selectedCharacterId));
      if (!character) return '<div class="message-avatar" aria-hidden="true">' + content + '</div>';
      return '<button class="message-avatar character-profile-trigger" type="button" data-character-profile-id="' + escapeHtml(character.id) +
        '" title="查看' + escapeHtml(character.name) + '的资料" aria-label="查看' + escapeHtml(character.name) + '的资料">' + content + '</button>';
    }

    function messageAvatar(message) {
      if (message.role === "user") return avatarImageOrInitial(state.userAvatarUrl, "我", "我");
      if (message.role === "tool") return '<i data-lucide="wrench" aria-hidden="true"></i>';
      if (message.worldNarration) {
        return worldAvatarCluster(state.worldConversations.find((entry) => entry.worldId === state.activeWorldId));
      }
      const character = state.characters.find((entry) => entry.id === (message.senderId || state.selectedCharacterId));
      return avatarImageOrInitial(character?.avatarUrl, character?.name);
    }

    function worldAvatarCluster(conversation, variant) {
      return groupAvatarCluster(conversation, variant);
    }

    function groupAvatarCluster(group, variant) {
      const members = (group?.characterIds || []).slice(0, 9)
        .map((id) => state.characters.find((entry) => entry.id === id)).filter(Boolean);
      if (!members.length) return '<span class="group-avatar-cluster members-1' + (variant ? ' ' + escapeHtml(variant) : '') + '"><span><i data-lucide="users-round" aria-hidden="true"></i></span></span>';
      return '<span class="group-avatar-cluster members-' + members.length + (variant ? ' ' + escapeHtml(variant) : '') + '">' + members.map((character) =>
        '<span>' + avatarImageOrInitial(character.avatarUrl, character.name) + '</span>'
      ).join("") + '</span>';
    }

    function avatarImageOrInitial(url, name, fallback) {
      return url
        ? '<img src="' + escapeHtml(url) + '" alt="" loading="lazy" />'
        : escapeHtml(fallback || characterInitial(name));
    }

    function characterInitial(name) {
      return Array.from(String(name || "角").trim())[0] || "角";
    }

    function renderMarkdown(value, messageMedia) {
      const source = String(value || "");
      if (!window.marked || !window.DOMPurify) {
        return escapeHtml(source).replace(/\\n/g, "<br>");
      }
      const rendered = window.marked.parse(source, { gfm: true, breaks: true });
      const renderedTemplate = document.createElement("template");
      renderedTemplate.innerHTML = rendered;
      renderedTemplate.content.querySelectorAll("img[src]").forEach((image) => {
        const path = workspaceImagePath(image.getAttribute("src"));
        if (path === null) return;
        if (!path) {
          image.replaceWith(document.createTextNode("[图片路径不可用]"));
          return;
        }
        image.setAttribute("src", workspaceFileContentUrl(path, "inline"));
        image.dataset.workspacePath = path;
      });
      const sanitized = window.DOMPurify.sanitize(renderedTemplate.innerHTML, {
        USE_PROFILES: { html: true },
        FORBID_TAGS: ["style", "iframe", "form", "button", "video", "audio", "object", "embed"],
        FORBID_ATTR: ["style", "srcdoc"]
      });
      const template = document.createElement("template");
      template.innerHTML = sanitized;
      template.content.querySelectorAll("a[href]").forEach((link) => {
        link.setAttribute("target", "_blank");
        link.setAttribute("rel", "noopener noreferrer nofollow");
      });
      template.content.querySelectorAll("img").forEach((image) => {
        image.setAttribute("loading", "lazy");
        image.setAttribute("referrerpolicy", "no-referrer");
        if (!messageMedia) return;
        const imageSource = image.getAttribute("src");
        if (!imageSource) {
          image.remove();
          return;
        }
        const name = image.getAttribute("alt") || image.dataset.workspacePath?.split("/").pop() || "图片";
        const button = document.createElement("button");
        button.type = "button";
        button.className = "message-inline-image";
        button.dataset.messageImage = "true";
        button.dataset.imageSrc = imageSource;
        button.dataset.imageName = name;
        if (image.dataset.workspacePath) button.dataset.imagePath = image.dataset.workspacePath;
        button.setAttribute("aria-label", "查看图片 " + name);
        const parentLink = image.parentElement?.tagName === "A" && image.parentElement.childElementCount === 1
          ? image.parentElement
          : null;
        (parentLink || image).replaceWith(button);
        button.append(image);
      });
      template.content.querySelectorAll("input").forEach((input) => {
        if (input.getAttribute("type") === "checkbox") input.setAttribute("disabled", "");
        else input.remove();
      });
      template.content.querySelectorAll("table").forEach((table) => {
        const wrapper = document.createElement("div");
        wrapper.className = "markdown-table-wrap";
        table.replaceWith(wrapper);
        wrapper.append(table);
      });
      return template.innerHTML;
    }

    function refreshIcons() {
      if (!window.lucide) return;
      window.lucide.createIcons({ attrs: { "stroke-width": 1.8 } });
    }

    function renderMessageProgress(message, index) {
      if (message.role !== "assistant" || !Array.isArray(message.progress) || !message.progress.length) return "";
      const hasFailure = message.progress.some((step) => step.status === "failed");
      const progressFailed = ["failed", "cancelled", "blocked"].includes(message.status) || (!message.status && hasFailure);
      const stateClass = message.working ? "active" : progressFailed ? "failed" : "";
      const stateLabel = progressFailed ? "未完成" : "已完成";
      const summary = message.working
        ? '<span class="typing-indicator"><span>正在输入</span><span class="typing-dots" aria-hidden="true"><i class="typing-dot"></i><i class="typing-dot"></i><i class="typing-dot"></i></span></span>'
        : '<span class="progress-state ' + stateClass + '">' + stateLabel + '</span>';
      const steps = message.progress.map((step, stepIndex) => {
        const mark = step.status === "completed" ? "✓" : step.status === "failed" ? "!" : "·";
        const result = renderProgressToolResult(step, index, stepIndex);
        return '<li class="progress-step ' + escapeHtml(step.status) + '">' +
          '<span class="progress-mark">' + mark + '</span>' +
          '<div class="progress-step-body"><span>' + escapeHtml(step.label) + '</span>' + result + '</div></li>';
      }).join("");
      return '<details class="message-progress' + (message.working ? ' working' : '') + '" data-message-index="' + index + '"' +
        (message.progressOpen ? ' open' : '') + '>' +
        '<summary title="展开执行详情"><i class="progress-chevron" data-lucide="chevron-right" aria-hidden="true"></i><span class="progress-summary">' + summary + '</span></summary>' +
        '<ol class="progress-list">' + steps + '</ol></details>';
    }

    function renderProgressToolResult(step, messageIndex, stepIndex) {
      const text = String(step.resultText || "");
      if (!text) return "";
      const lineCount = text.split("\\n").length;
      return '<details class="progress-tool-result" data-message-index="' + messageIndex +
        '" data-progress-step-index="' + stepIndex + '"' + (step.resultOpen ? ' open' : '') + '>' +
        '<summary><span>查看结果</span><span class="progress-tool-size">' + lineCount + ' 行 · ' +
        [...text].length.toLocaleString() + ' 字符</span></summary>' +
        '<pre class="progress-tool-output">' + escapeHtml(text) + '</pre></details>';
    }

    function rememberMessageDisclosure(event) {
      const details = event.target.closest?.("details[data-message-index]");
      if (!details) return;
      const message = state.messages[Number(details.dataset.messageIndex)];
      if (!message) return;
      if (details.classList.contains("message-progress")) message.progressOpen = details.open;
      if (details.classList.contains("progress-tool-result")) {
        const step = message.progress?.[Number(details.dataset.progressStepIndex)];
        if (step) step.resultOpen = details.open;
      }
    }

    function updateMessageProgress(index, key, label, status, keepActive, details) {
      const message = state.messages[index];
      if (!message) return;
      message.progress = Array.isArray(message.progress) ? message.progress : [];
      if (!keepActive) {
        message.progress.forEach((step) => {
          if (step.status === "active" && step.key !== key) step.status = "completed";
        });
      }
      const existing = message.progress.find((step) => step.key === key);
      if (existing) {
        existing.label = label;
        existing.status = status;
        Object.assign(existing, details || {});
      } else {
        message.progress.push({ key, label, status, ...(details || {}) });
      }
      renderMessages();
    }

    function applyLifecycleProgress(index, eventType) {
      if (eventType === "agent_start") {
        updateMessageProgress(index, "analysis", "分析请求", "active");
      } else if (eventType === "turn_start" || eventType === "message_start") {
        updateMessageProgress(index, "generation", "生成回复", "active");
      }
    }

    function completeMessageProgress(index, status) {
      const message = state.messages[index];
      if (!message) return;
      const completed = status === "completed";
      message.progress = Array.isArray(message.progress) ? message.progress : [];
      message.progress.forEach((step) => {
        if (step.status === "active") step.status = completed ? "completed" : "failed";
      });
      const finalStep = {
        completed: { key: "complete", label: "回复完成", status: "completed" },
        failed: { key: "failed", label: "请求失败", status: "failed" },
        cancelled: { key: "cancelled", label: "生成已取消", status: "failed" },
        blocked: { key: "blocked", label: "操作受阻", status: "failed" }
      }[status] || { key: "failed", label: "请求未完成", status: "failed" };
      message.progress.push({
        ...finalStep
      });
      message.working = false;
      message.progressOpen = Boolean(message.progressOpen);
    }

    function addActionProgress(index, actions) {
      const message = state.messages[index];
      if (!message || !Array.isArray(actions) || !actions.length) return;
      message.progress = Array.isArray(message.progress) ? message.progress : [];
      if (message.progress.some((step) => step.toolCallId || String(step.key || "").startsWith("tool:"))) return;
      const finalStep = message.progress.pop();
      actions.forEach((action, actionIndex) => {
        const payload = action.payload && Object.keys(action.payload).length
          ? JSON.stringify(action.payload, null, 2)
          : "";
        message.progress.push({
          key: "action:" + (action.id || actionIndex),
          label: "执行操作：" + toolDisplayName(action.actionType),
          status: action.status === "completed" ? "completed" : "failed",
          resultText: payload
        });
      });
      if (finalStep) message.progress.push(finalStep);
    }

    function formatToolResult(result) {
      if (result === undefined || result === null) return "";
      if (typeof result === "string") return result;
      if (Array.isArray(result?.content)) {
        const text = result.content
          .filter((block) => block && block.type === "text")
          .map((block) => block.text || "")
          .join("\\n")
          .trim();
        if (text) return text;
      }
      try {
        return JSON.stringify(result, null, 2);
      } catch {
        return String(result);
      }
    }

    function applyTurnOutcome(response) {
      state.lastTurnStatus = response.status || null;
      state.lastTurnCanRetry = Boolean(response.canRetry);
      updateRetryState();
      const label = {
        completed: "完成",
        failed: response.canRetry ? "生成失败，可重试" : "生成失败",
        cancelled: response.canRetry ? "已取消，可重试" : "已取消",
        blocked: "操作受阻"
      }[response.status] || "完成";
      setStatus(label, response.status === "failed");
    }

    function updateRetryState() {
      nodes.retryMessageBtn.disabled = state.activeConversationKind !== "direct" || state.busy ||
        state.privateInboxRunning || state.privateInboxMessages.length > 0 ||
        state.sessionDraft || !state.lastTurnCanRetry;
    }

    function privateQueueLabel(message) {
      if (message.queueStatus === "queued") return "未读";
      if (message.queueStatus === "processing") return "已读";
      if (message.queueStatus === "failed") return "发送失败";
      return "";
    }

    function toolDisplayName(name) {
      return ({
        create_schedule_item: "创建日程",
        list_schedule_items: "查询日程",
        update_schedule_item: "更新日程",
        complete_schedule_item: "完成日程",
        cancel_schedule_item: "取消日程",
        snooze_reminder: "稍后提醒",
        get_user_profile: "读取用户画像",
        update_user_profile: "更新用户画像",
        get_current_character_soul: "读取角色 SOUL",
        update_current_character_soul: "更新角色 SOUL",
        update_scene: "更新场景",
        propose_memory: "提议记忆",
        list_workspace: "查看工作区",
        read: "读取文件",
        write: "写入文件",
        edit: "编辑文件",
        bash: "执行终端命令",
        tavily_search: "Tavily 网页搜索",
        analyze_image: "分析图片",
        vision_auto_analyze: "分析图片",
        vision_direct_input: "发送图片给主模型",
        delegate_task: "委派子 Agent"
      })[name] || name || "未知工具";
    }

    async function loadDebugLogs() {
      nodes.traceIndex.innerHTML = '<div class="muted">加载中...</div>';
      nodes.traceDetail.hidden = true;
      nodes.traceEmpty.hidden = false;
      nodes.traceEmpty.textContent = "正在加载上下文诊断...";
      try {
        const [conversationResponse, backgroundResponse, economicsResponse, proactiveResponse] = await Promise.all([
          fetch("/api/debug/model-traces?scope=conversation&limit=10"),
          fetch("/api/debug/model-traces?scope=background&limit=10"),
          fetch("/api/debug/context-economics?limit=30"),
          fetch("/api/v1/proactive-messages?limit=500")
        ]);
        const [conversationBody, backgroundBody, economicsBody, proactiveBody] = await Promise.all([
          readJsonApiResponse(conversationResponse, "会话内 Provider Trace"),
          readJsonApiResponse(backgroundResponse, "会话外 Provider Trace"),
          readJsonApiResponse(economicsResponse, "Context Economics"),
          readJsonApiResponse(proactiveResponse, "主动决策")
        ]);
        if (!conversationResponse.ok) throw new Error(conversationBody.error || "会话内 Trace 加载失败");
        if (!backgroundResponse.ok) throw new Error(backgroundBody.error || "会话外 Trace 加载失败");
        if (!economicsResponse.ok) throw new Error(economicsBody.error || "Economics 加载失败");
        if (!proactiveResponse.ok) throw new Error(proactiveBody.error || "主动决策加载失败");
        state.debugEconomics = Array.isArray(economicsBody.economics) ? economicsBody.economics : [];
        state.debugProactiveMessages = Array.isArray(proactiveBody.messages) ? proactiveBody.messages : [];
        renderModelTraces({
          conversation: Array.isArray(conversationBody.traces) ? conversationBody.traces : [],
          background: Array.isArray(backgroundBody.traces) ? backgroundBody.traces : []
        });
        renderDebugDataset();
      } catch (error) {
        nodes.traceIndex.innerHTML = "";
        nodes.traceEmpty.hidden = false;
        nodes.traceEmpty.innerHTML = '<span class="error">' + escapeHtml(error.message || String(error)) + '</span>';
      }
    }

    async function readJsonApiResponse(response, label) {
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.toLowerCase().includes("application/json")) {
        await response.body?.cancel().catch(() => {});
        throw new Error(label + " 返回了非 JSON 响应（HTTP " + response.status + "），服务可能正在重启");
      }
      try {
        return await response.json();
      } catch {
        throw new Error(label + " 返回的 JSON 不完整，请重试");
      }
    }

    function setDebugDataset(dataset) {
      state.debugDataset = dataset;
      renderDebugDataset();
    }

    function renderDebugDataset() {
      const featureTests = state.debugDataset === "feature-tests";
      const initiative = state.debugDataset === "initiative";
      const economics = state.debugDataset === "economics";
      const traces = !featureTests && !initiative && !economics;
      nodes.debugTracesBtn.classList.toggle("active", traces);
      nodes.debugEconomicsBtn.classList.toggle("active", economics);
      nodes.debugInitiativeBtn.classList.toggle("active", initiative);
      nodes.debugFeatureTestsBtn.classList.toggle("active", featureTests);
      nodes.debugTracesBtn.setAttribute("aria-selected", String(traces));
      nodes.debugEconomicsBtn.setAttribute("aria-selected", String(economics));
      nodes.debugInitiativeBtn.setAttribute("aria-selected", String(initiative));
      nodes.debugFeatureTestsBtn.setAttribute("aria-selected", String(featureTests));
      nodes.debugWorkspace.hidden = featureTests || initiative;
      nodes.traceScopeTabs.hidden = !traces;
      nodes.featureTestPanel.hidden = !featureTests;
      nodes.initiativeDebugPanel.hidden = !initiative;
      if (featureTests) {
        renderFeatureTestCases();
        renderFeatureTestReport();
        renderFeatureTestHistory();
        renderFeatureTestResults();
        return;
      }
      if (initiative) {
        renderInitiativeDebug();
        return;
      }
      if (traces) renderTraceScopeTabs();
      renderTraceIndex();
      renderSelectedTrace();
    }

    function renderInitiativeDebug() {
      const characterId = nodes.initiativeCharacterFilter.value;
      const status = nodes.initiativeDecisionFilter.value;
      const messages = state.debugProactiveMessages.filter((message) =>
        (!characterId || message.characterId === characterId) && (!status || message.status === status)
      );
      const count = (value) => messages.filter((message) => message.status === value).length;
      const average = messages.length
        ? Math.round(messages.reduce((sum, message) => sum + Number(message.candidateScore || 0), 0) / messages.length * 100)
        : 0;
      nodes.initiativeSummary.innerHTML = [
        ["候选", messages.length], ["等待", count("pending")], ["已发送", count("delivered")],
        ["已丢弃", count("skipped")], ["平均评分", average]
      ].map((entry) => '<div><span>' + entry[0] + '</span><strong>' + entry[1] + '</strong></div>').join("");
      nodes.initiativeDebugState.textContent = messages.length + " 条记录";
      nodes.initiativeDebugList.innerHTML = messages.length ? messages.map((message) => {
        const character = state.characters.find((entry) => entry.id === message.characterId);
        const score = Math.round(Number(message.candidateScore || 0) * 100);
        const detail = JSON.stringify(message.decisionDetails || {}, null, 2);
        return '<article class="initiative-debug-row"><div class="initiative-debug-copy"><strong>' +
          escapeHtml((character?.name || message.characterId) + " · " + (message.topicLabel || message.topicKey)) + '</strong>' +
          '<div class="initiative-debug-meta"><span class="life-decision-badge ' + escapeHtml(message.status) + '">' +
          escapeHtml(proactiveDecisionLabel(message.decisionCode)) + '</span> · ' +
          escapeHtml(formatProfileTime(message.updatedAt || message.createdAt)) +
          (message.feedbackType ? ' · ' + escapeHtml(proactiveFeedbackLabel(message.feedbackType)) : '') + '</div>' +
          (message.text ? '<div class="initiative-debug-meta">' + escapeHtml(String(message.text).slice(0, 180)) + '</div>' : '') +
          '</div><strong class="initiative-debug-score">' + score + '</strong>' +
          '<details class="initiative-debug-detail"><summary>决策详情</summary><pre>' + escapeHtml(detail) + '</pre></details></article>';
      }).join("") : '<div class="life-empty-row">当前筛选下没有主动决策记录</div>';
    }

    async function loadFeatureTestCases() {
      if (state.featureTestCases.length) {
        renderFeatureTestCases();
        return;
      }
      nodes.featureTestState.textContent = "加载测试集...";
      try {
        const response = await fetch("/api/v1/feature-tests");
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "测试集加载失败");
        state.featureTestCases = Array.isArray(body.cases) ? body.cases : [];
        renderFeatureTestCases();
        nodes.featureTestState.textContent = state.featureTestCases.length + " 条内置测试";
      } catch (error) {
        nodes.featureTestState.textContent = error.message || String(error);
      }
    }

    function renderFeatureTestCases() {
      if (!state.featureTestCases.length) {
        nodes.featureTestList.innerHTML = '<div class="conversation-list-empty">暂无测试用例</div>';
        return;
      }
      const selected = new Set([...nodes.featureTestList.querySelectorAll("input[data-feature-test]:checked")].map((input) => input.value));
      nodes.featureTestList.innerHTML = state.featureTestCases.map((testCase) =>
        '<label class="feature-test-case"><input type="checkbox" data-feature-test value="' + escapeHtml(testCase.id) + '"' +
          (selected.has(testCase.id) ? ' checked' : '') + (state.featureTestsRunning ? ' disabled' : '') + ' />' +
          '<span><strong>' + escapeHtml(testCase.name) + '</strong> <span class="memory-badge">' + escapeHtml(featureCategoryLabel(testCase.category)) + '</span>' +
          '<p>' + escapeHtml(testCase.description) + '</p>' +
          (Array.isArray(testCase.qualityCriteria) && testCase.qualityCriteria.length
            ? '<span class="feature-test-criteria">Judge · ' + escapeHtml(testCase.qualityCriteria.join('；')) + '</span>'
            : '') +
          '<code class="feature-test-input">' + escapeHtml(testCase.input) + '</code></span></label>'
      ).join("");
    }

    function featureCategoryLabel(category) {
      return ({
        conversation: "对话",
        world: "世界",
        schedule: "日程",
        memory: "记忆",
        relationship: "关系",
        initiative: "主动性",
        search: "搜索",
        workspace: "文件",
        character: "角色",
        vision: "视觉",
        subagent: "子 Agent"
      })[category] || category;
    }

    function toggleAllFeatureTests() {
      const inputs = [...nodes.featureTestList.querySelectorAll("input[data-feature-test]")];
      const checked = inputs.some((input) => !input.checked);
      inputs.forEach((input) => { input.checked = checked; });
      nodes.selectAllFeatureTestsBtn.textContent = checked ? "取消全选" : "全选";
    }

    async function runSelectedFeatureTests() {
      if (state.featureTestsRunning) return;
      const ids = [...nodes.featureTestList.querySelectorAll("input[data-feature-test]:checked")].map((input) => input.value);
      const characterId = nodes.featureTestCharacter.value;
      const modelProfileId = nodes.featureTestTargetModel.value;
      const judgeModelProfileId = nodes.featureTestJudgeModel.value;
      if (!ids.length) {
        nodes.featureTestState.textContent = "请至少选择一条测试。";
        return;
      }
      if (!characterId) {
        nodes.featureTestState.textContent = "请选择测试角色。";
        nodes.featureTestCharacter.focus();
        return;
      }
      if (!modelProfileId) {
        nodes.featureTestState.textContent = "请选择被测模型。";
        nodes.featureTestTargetModel.focus();
        return;
      }
      state.featureTestsRunning = true;
      state.featureTestResults = [];
      nodes.runFeatureTestsBtn.disabled = true;
      nodes.exportFeatureTestReportBtn.disabled = true;
      nodes.featureTestCharacter.disabled = true;
      nodes.featureTestTargetModel.disabled = true;
      nodes.featureTestJudgeModel.disabled = true;
      renderFeatureTestCases();
      renderFeatureTestReport();
      renderFeatureTestResults();
      try {
        for (let index = 0; index < ids.length; index += 1) {
          const testCase = state.featureTestCases.find((entry) => entry.id === ids[index]);
          nodes.featureTestState.textContent = "运行 " + (index + 1) + "/" + ids.length + " · " + (testCase?.name || ids[index]);
          try {
            const response = await fetch("/api/v1/feature-tests/" + encodeURIComponent(ids[index]) + "/run", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ characterId, modelProfileId, judgeModelProfileId }),
            });
            const body = await response.json();
            if (!response.ok) throw new Error(body.error || "测试执行失败");
            state.featureTestResults.push({
              result: body.result,
              functional: body.functional,
              quality: body.quality
            });
          } catch (error) {
            state.featureTestResults.push({
              result: {
                caseId: ids[index], name: testCase?.name || ids[index], passed: false, status: "failed",
                durationMs: 0, modelRequests: 0, reply: "", qualitySample: "", qualitySampleLabel: "模型回复",
                rules: [{ label: "测试执行", passed: false, evidence: error.message || String(error), scope: "functional" }]
              },
              functional: { score: 0, passedRules: 0, totalRules: 1, blocked: false, blockers: [] },
              quality: judgeModelProfileId ? {
                status: "failed", score: null, dimensions: [], summary: "回复质量评分不可用",
                error: sanitizeAdaptationError(error.message || String(error)), modelRequests: 0, durationMs: 0, inputTokens: 0, outputTokens: 0
              } : undefined
            });
          }
          renderFeatureTestReport();
          renderFeatureTestResults();
        }
        const report = createFeatureTestReport(characterId, modelProfileId, judgeModelProfileId);
        state.featureTestReports.unshift(report);
        state.featureTestReports = state.featureTestReports.slice(0, 10);
        const passed = report.summary.passedCases;
        nodes.featureTestState.textContent = "完成 · " + passed + "/" + report.summary.selectedCases + " 通过";
        nodes.exportFeatureTestReportBtn.disabled = false;
        renderFeatureTestReport();
        renderFeatureTestHistory();
      } finally {
        state.featureTestsRunning = false;
        nodes.runFeatureTestsBtn.disabled = false;
        nodes.featureTestCharacter.disabled = false;
        nodes.featureTestTargetModel.disabled = false;
        nodes.featureTestJudgeModel.disabled = false;
        renderFeatureTestCases();
      }
    }

    function renderFeatureTestResults() {
      nodes.featureTestResults.innerHTML = state.featureTestResults.map((evaluation) => {
        const result = evaluation.result || {};
        const functional = evaluation.functional || {};
        const quality = evaluation.quality;
        const functionalLabel = functional.score === null || functional.score === undefined ? "功能 --" : "功能 " + formatAdaptationScore(functional.score);
        const qualityLabel = !quality ? "" : quality.status === "scored" ? "质量 " + formatAdaptationScore(quality.score) : "质量 --";
        const qualitySample = result.qualitySample && result.qualitySample !== result.reply
          ? '<details class="feature-test-reply"><summary>' + escapeHtml(result.qualitySampleLabel || "评分文本") + '</summary><div class="markdown-body">' + renderMarkdown(result.qualitySample) + '</div></details>'
          : '';
        return (
        '<section class="feature-test-result"><div class="feature-test-result-head"><strong>' + escapeHtml(result.name) + '</strong>' +
          '<span class="feature-test-result-scores"><span class="feature-test-status ' + (result.passed ? 'pass' : 'fail') + '">' + (result.passed ? 'PASS' : 'FAIL') + '</span>' +
          '<span>' + escapeHtml(functionalLabel) + '</span>' + (qualityLabel ? '<span>' + escapeHtml(qualityLabel) + '</span>' : '') + '</span></div>' +
          '<div class="memory-source">' + escapeHtml((result.durationMs || 0) + " ms · " + (result.modelRequests || 0) + " model requests · " + (result.status || "unknown")) + '</div>' +
          '<ul class="feature-test-rules">' + (result.rules || []).map((entry) => '<li class="' + (entry.passed ? 'feature-test-status pass' : 'feature-test-status fail') + '">' +
            (entry.scope === "preflight" ? 'ENV · ' : entry.passed ? 'PASS · ' : 'FAIL · ') + escapeHtml(entry.label) + ' <span class="muted">' + escapeHtml(entry.evidence || "") + '</span></li>').join("") + '</ul>' +
          renderFeatureTestQuality(quality) + qualitySample +
          (result.reply ? '<details class="feature-test-reply"><summary>模型回复</summary><div class="markdown-body">' + renderMarkdown(result.reply) + '</div></details>' : '') + '</section>'
        );
      }).join("");
      refreshIcons();
    }

    function renderFeatureTestQuality(quality) {
      if (!quality) return "";
      if (quality.status !== "scored") {
        const detail = quality.error || quality.summary || (quality.status === "skipped" ? "没有可评分文本" : "Judge 调用失败");
        return '<details class="feature-test-quality"><summary>Judge · ' + escapeHtml(quality.status === "skipped" ? "已跳过" : "评分不可用") +
          '</summary><p class="feature-test-quality-summary">' + escapeHtml(detail) + '</p></details>';
      }
      return '<details class="feature-test-quality"><summary>Judge · ' + escapeHtml(formatAdaptationScore(quality.score)) +
        ' · 置信度 ' + escapeHtml(Math.round(Number(quality.confidence || 0) * 100) + "%") + '</summary>' +
        '<p class="feature-test-quality-summary">' + escapeHtml(quality.summary || "") + '</p>' +
        (Array.isArray(quality.flags) && quality.flags.length ? '<p class="feature-test-quality-summary">Flags · ' + escapeHtml(quality.flags.join('；')) + '</p>' : '') +
        '<div class="feature-test-dimensions">' + (quality.dimensions || []).map((entry) =>
          '<div class="feature-test-dimension"><strong>' + escapeHtml(String(entry.score)) + '/5</strong><span>' + escapeHtml(entry.label || entry.id) +
          '</span><p>' + escapeHtml(entry.reason || "") + '</p></div>'
        ).join("") + '</div>' +
        '<div class="memory-source">Judge ' + escapeHtml((quality.modelRequests || 0) + " requests · " +
          (quality.inputTokens || 0) + " in / " + (quality.outputTokens || 0) + " out tokens · " + (quality.durationMs || 0) + " ms") + '</div></details>';
    }

    function summarizeFeatureTestEvaluations(evaluations) {
      const executed = evaluations.filter((entry) => Number.isFinite(entry.functional?.score));
      const judged = evaluations.filter((entry) => entry.quality?.status === "scored" && Number.isFinite(entry.quality?.score));
      const functionalScore = averageAdaptationScore(executed.map((entry) => Number(entry.functional.score)));
      const qualityScore = averageAdaptationScore(judged.map((entry) => Number(entry.quality.score)));
      const overallScore = functionalScore === null ? null : qualityScore === null
        ? functionalScore
        : roundAdaptationScore(functionalScore * 0.7 + qualityScore * 0.3);
      return {
        functionalScore,
        qualityScore,
        overallScore,
        executionCoverage: evaluations.length ? executed.length / evaluations.length : 0,
        qualityCoverage: evaluations.length ? judged.length / evaluations.length : 0,
        passedCases: evaluations.filter((entry) => entry.result?.passed).length,
        selectedCases: evaluations.length,
        blockedCases: evaluations.filter((entry) => entry.functional?.blocked).length,
        judgedCases: judged.length,
        failedJudgments: evaluations.filter((entry) => entry.quality?.status === "failed").length,
        compatibility: adaptationCompatibility(overallScore)
      };
    }

    function renderFeatureTestReport() {
      if (!state.featureTestResults.length) {
        nodes.featureTestReport.innerHTML = "";
        return;
      }
      const summary = summarizeFeatureTestEvaluations(state.featureTestResults);
      const target = state.modelProfiles.find((profile) => profile.id === nodes.featureTestTargetModel.value);
      const judge = state.modelProfiles.find((profile) => profile.id === nodes.featureTestJudgeModel.value);
      const compatibilityDetail = adaptationCompatibilityLabel(summary.compatibility) +
        (judge && summary.qualityScore === null ? " · 仅功能" : "") +
        (summary.executionCoverage < 1 ? " · 覆盖不足" : "");
      nodes.featureTestReport.innerHTML = '<div class="feature-test-score-grid">' +
        adaptationScoreCell("综合适配", summary.overallScore, compatibilityDetail) +
        adaptationScoreCell("功能完整度", summary.functionalScore, summary.passedCases + "/" + summary.selectedCases + " 用例通过") +
        adaptationScoreCell("回复质量", summary.qualityScore, judge ? summary.judgedCases + "/" + summary.selectedCases + " 已评分" : "未启用 Judge") +
        adaptationScoreCell("执行覆盖", summary.executionCoverage * 100, summary.blockedCases + " 条被前置条件阻塞") +
        '</div><div class="feature-test-report-meta">被测 · ' + escapeHtml(target?.name || "未知模型") +
        (target?.model ? ' / ' + escapeHtml(target.model) : '') + '　Judge · ' + escapeHtml(judge?.name || "未启用") +
        '　综合权重 · 功能 70% + 质量 30%' +
        (target && judge && target.id === judge.id ? '　注意 · 当前为同模型自评' : '') + '</div>';
    }

    function adaptationScoreCell(label, score, detail) {
      return '<div><span>' + escapeHtml(label) + '</span><strong class="' + adaptationScoreClass(score) + '">' +
        escapeHtml(formatAdaptationScore(score)) + '</strong><span>' + escapeHtml(detail) + '</span></div>';
    }

    function createFeatureTestReport(characterId, modelProfileId, judgeModelProfileId) {
      const target = state.modelProfiles.find((profile) => profile.id === modelProfileId);
      const judge = state.modelProfiles.find((profile) => profile.id === judgeModelProfileId);
      const character = state.characters.find((entry) => entry.id === characterId);
      return {
        version: 1,
        id: "model-adaptation-" + Date.now(),
        ranAt: new Date().toISOString(),
        target: target ? { profileId: target.id, profileName: target.name, model: target.model } : { profileId: modelProfileId },
        judge: judge ? { profileId: judge.id, profileName: judge.name, model: judge.model } : null,
        character: character ? { id: character.id, name: character.name } : { id: characterId },
        scoring: { functionalWeight: 0.7, qualityWeight: 0.3, qualityDimensions: ["instruction_following", "role_fidelity", "coherence", "naturalness", "contextual_fit"] },
        summary: summarizeFeatureTestEvaluations(state.featureTestResults),
        evaluations: state.featureTestResults
      };
    }

    function renderFeatureTestHistory() {
      if (!state.featureTestReports.length) {
        nodes.featureTestHistory.innerHTML = "";
        return;
      }
      nodes.featureTestHistory.innerHTML = '<details><summary>本页模型对比 · ' + state.featureTestReports.length + ' 次评测</summary>' +
        '<table class="feature-test-history-table"><thead><tr><th>被测模型</th><th>Judge</th><th>功能</th><th>质量</th><th>综合</th><th>覆盖</th></tr></thead><tbody>' +
        state.featureTestReports.map((report) => '<tr><td>' + escapeHtml(report.target?.profileName || report.target?.model || "未知") +
          '</td><td>' + escapeHtml(report.judge?.profileName || "未启用") + '</td><td>' + escapeHtml(formatAdaptationScore(report.summary.functionalScore)) +
          '</td><td>' + escapeHtml(formatAdaptationScore(report.summary.qualityScore)) + '</td><td>' + escapeHtml(formatAdaptationScore(report.summary.overallScore)) +
          '</td><td>' + escapeHtml(Math.round(report.summary.executionCoverage * 100) + "% · " + report.summary.selectedCases + " 项") + '</td></tr>').join("") +
        '</tbody></table></details>';
    }

    function exportLatestFeatureTestReport() {
      const report = state.featureTestReports[0];
      if (!report) return;
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const model = String(report.target?.model || "model").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60) || "model";
      anchor.href = objectUrl;
      anchor.download = "rp-agent-adaptation-" + model + "-" + report.ranAt.replace(/[:.]/g, "-") + ".json";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    }

    function formatAdaptationScore(score) {
      return Number.isFinite(score) ? Math.round(Number(score) * 10) / 10 + "/100" : "--";
    }

    function roundAdaptationScore(score) {
      return Math.round(score * 10) / 10;
    }

    function averageAdaptationScore(values) {
      return values.length ? roundAdaptationScore(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
    }

    function adaptationCompatibility(score) {
      if (!Number.isFinite(score)) return "unavailable";
      if (score >= 90) return "excellent";
      if (score >= 80) return "good";
      if (score >= 65) return "usable";
      if (score >= 50) return "limited";
      return "poor";
    }

    function adaptationCompatibilityLabel(value) {
      return ({ excellent: "高度适配", good: "良好适配", usable: "可用", limited: "有限适配", poor: "不适配", unavailable: "暂无评分" })[value] || value;
    }

    function adaptationScoreClass(score) {
      if (!Number.isFinite(score)) return "";
      return score >= 80 ? "good" : score >= 65 ? "warn" : "bad";
    }

    function sanitizeAdaptationError(value) {
      return String(value || "").replace(/https?:\\/\\/[^\\s"'<>]+/gi, "[redacted-url]").replace(/bearer\\s+[^\\s"'<>]+/gi, "Bearer [redacted]").slice(0, 500);
    }

    async function loadModelProfiles(preferredId) {
      const response = await fetch("/api/v1/model-profiles");
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "模型配置加载失败");
      state.modelProfiles = Array.isArray(body.profiles) ? body.profiles : [];
      state.defaultModelProfileId = body.defaultProfileId || "";
      const candidate = preferredId || state.selectedModelProfileId;
      state.selectedModelProfileId = state.modelProfiles.some((profile) => profile.id === candidate)
        ? candidate
        : state.defaultModelProfileId || state.modelProfiles[0]?.id || "";
      nodes.apiProfileSelect.innerHTML = state.modelProfiles.map((profile) =>
        '<option value="' + escapeHtml(profile.id) + '">' + escapeHtml(profile.name) + (profile.isDefault ? '（系统默认）' : '') + '</option>'
      ).join("");
      nodes.apiProfileSelect.value = state.selectedModelProfileId;
      nodes.deleteApiProfileBtn.disabled = state.modelProfiles.length <= 1;
      nodes.defaultApiProfileBtn.disabled = state.selectedModelProfileId === state.defaultModelProfileId;
      renderFeatureTestModelOptions();
      return state.modelProfiles.find((profile) => profile.id === state.selectedModelProfileId);
    }

    function renderFeatureTestModelOptions() {
      const options = state.modelProfiles.map((profile) =>
        '<option value="' + escapeHtml(profile.id) + '">' + escapeHtml(profile.name) +
          (profile.model ? ' · ' + escapeHtml(profile.model) : '') + (profile.isDefault ? '（默认）' : '') + '</option>'
      ).join("");
      const targetCandidate = state.featureTestTargetModelId || state.defaultModelProfileId || state.modelProfiles[0]?.id || "";
      state.featureTestTargetModelId = state.modelProfiles.some((profile) => profile.id === targetCandidate)
        ? targetCandidate
        : state.defaultModelProfileId || state.modelProfiles[0]?.id || "";
      nodes.featureTestTargetModel.innerHTML = '<option value="">选择被测模型</option>' + options;
      nodes.featureTestTargetModel.value = state.featureTestTargetModelId;

      if (!state.featureTestModelOptionsInitialized) {
        state.featureTestJudgeModelId = state.modelProfiles.find((profile) =>
          profile.enabled && profile.id !== state.featureTestTargetModelId
        )?.id ?? state.defaultModelProfileId ?? state.featureTestTargetModelId;
        state.featureTestModelOptionsInitialized = true;
      }
      if (state.featureTestJudgeModelId && !state.modelProfiles.some((profile) => profile.id === state.featureTestJudgeModelId)) {
        state.featureTestJudgeModelId = "";
      }
      nodes.featureTestJudgeModel.innerHTML = '<option value="">仅功能评分</option>' + options;
      nodes.featureTestJudgeModel.value = state.featureTestJudgeModelId;
    }

    async function loadApiSettings(preferredId) {
      nodes.apiSettingsState.textContent = "加载中...";
      try {
        const config = await loadModelProfiles(preferredId);
        if (!config) throw new Error("至少需要一个模型配置");
        nodes.apiProfileName.value = config.name || "";
        nodes.apiEnabled.checked = Boolean(config.enabled);
        nodes.apiVisionInputEnabled.checked = Boolean(config.visionInputEnabled);
        nodes.apiBaseUrl.value = config.baseUrl || "";
        renderModelOptions(config.model || "");
        nodes.apiKey.value = "";
        nodes.apiTemperature.value = config.temperature ?? "";
        nodes.apiMaxTokens.value = config.maxTokens ?? "";
        nodes.apiContextWindowTokens.value = config.contextWindowTokens ?? "";
        nodes.apiSettingsState.textContent = (config.isDefault ? "系统默认 · " : "") +
          (config.apiKeySet ? "Key: " + config.apiKeyMasked : "Key: 未设置");
        renderCharacterOptions();
      } catch (error) {
        nodes.apiSettingsState.textContent = error.message || String(error);
      }
    }

    function selectApiProfile() {
      state.selectedModelProfileId = nodes.apiProfileSelect.value;
      state.discoveredModels = [];
      void loadApiSettings(state.selectedModelProfileId);
    }

    async function createApiProfile() {
      nodes.newApiProfileBtn.disabled = true;
      try {
        const response = await fetch("/api/v1/model-profiles", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "模型配置 " + (state.modelProfiles.length + 1) })
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "模型配置创建失败");
        state.discoveredModels = [];
        await loadApiSettings(body.profile.id);
        nodes.apiProfileName.focus();
        setStatus("模型配置已创建");
      } catch (error) {
        nodes.apiSettingsState.textContent = error.message || String(error);
      } finally {
        nodes.newApiProfileBtn.disabled = false;
      }
    }

    async function setDefaultApiProfile() {
      if (!state.selectedModelProfileId) return;
      nodes.defaultApiProfileBtn.disabled = true;
      try {
        const response = await fetch("/api/v1/model-profiles/" + encodeURIComponent(state.selectedModelProfileId) + "/default", {
          method: "POST"
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "默认模型设置失败");
        await loadApiSettings(state.selectedModelProfileId);
        setStatus("系统默认模型已更新");
      } catch (error) {
        nodes.apiSettingsState.textContent = error.message || String(error);
      }
    }

    async function deleteApiProfile() {
      const profile = state.modelProfiles.find((entry) => entry.id === state.selectedModelProfileId);
      if (!profile || state.modelProfiles.length <= 1) return;
      if (!window.confirm("删除模型配置“" + profile.name + "”？绑定该配置的角色将继承系统默认模型。")) return;
      nodes.deleteApiProfileBtn.disabled = true;
      try {
        const response = await fetch("/api/v1/model-profiles/" + encodeURIComponent(profile.id), { method: "DELETE" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "模型配置删除失败");
        state.selectedModelProfileId = body.defaultProfileId || body.profiles?.[0]?.id || "";
        state.discoveredModels = [];
        await loadApiSettings(state.selectedModelProfileId);
        await loadCharacters();
        setStatus("模型配置已删除");
      } catch (error) {
        nodes.apiSettingsState.textContent = error.message || String(error);
      }
    }

    function renderModelOptions(selectedModel) {
      const models = [...new Set([selectedModel, ...state.discoveredModels].filter(Boolean))];
      nodes.apiModel.innerHTML = '<option value="">读取模型后选择</option>' + models.map((model) =>
        '<option value="' + escapeHtml(model) + '">' + escapeHtml(model) + '</option>'
      ).join("") + '<option value="__custom__">手动输入...</option>';
      if (selectedModel) {
        nodes.apiModel.value = selectedModel;
      } else if (state.discoveredModels.length) {
        nodes.apiModel.value = state.discoveredModels[0];
      }
      syncCustomModelVisibility();
    }

    function syncCustomModelVisibility() {
      const custom = nodes.apiModel.value === "__custom__";
      nodes.apiModelCustom.hidden = !custom;
      if (custom) nodes.apiModelCustom.focus();
    }

    function selectedModelName() {
      return nodes.apiModel.value === "__custom__" ? nodes.apiModelCustom.value.trim() : nodes.apiModel.value.trim();
    }

    async function loadVisionSettings() {
      nodes.visionSettingsState.textContent = "加载中...";
      try {
        const response = await fetch("/api/settings/vision");
        const config = await response.json();
        if (!response.ok) throw new Error(config.error || "视觉设置加载失败");
        nodes.visionMode.value = config.mode || "auto";
        nodes.visionDetail.value = config.detail || "auto";
        nodes.visionBaseUrl.value = config.baseUrl || "";
        nodes.visionApiKey.value = "";
        nodes.visionMaxImages.value = config.maxImages || 4;
        renderVisionModelOptions(config.model || "");
        nodes.visionSettingsState.textContent = formatVisionSettingsState(config);
      } catch (error) {
        nodes.visionSettingsState.textContent = error.message || String(error);
      }
    }

    function renderVisionModelOptions(selectedModel) {
      const models = [...new Set([selectedModel, ...state.discoveredVisionModels].filter(Boolean))];
      nodes.visionModel.innerHTML = '<option value="">读取模型后选择</option>' + models.map((model) =>
        '<option value="' + escapeHtml(model) + '">' + escapeHtml(model) + '</option>'
      ).join("") + '<option value="__custom__">手动输入...</option>';
      if (selectedModel) nodes.visionModel.value = selectedModel;
      else if (state.discoveredVisionModels.length) nodes.visionModel.value = state.discoveredVisionModels[0];
      syncCustomVisionModelVisibility();
    }

    function syncCustomVisionModelVisibility() {
      const custom = nodes.visionModel.value === "__custom__";
      nodes.visionModelCustom.hidden = !custom;
      if (custom) nodes.visionModelCustom.focus();
    }

    function selectedVisionModelName() {
      return nodes.visionModel.value === "__custom__"
        ? nodes.visionModelCustom.value.trim()
        : nodes.visionModel.value.trim();
    }

    async function saveVisionSettings(rethrow) {
      nodes.visionSettingsState.textContent = "保存中...";
      nodes.saveVisionSettingsBtn.disabled = true;
      const payload = {
        mode: nodes.visionMode.value,
        detail: nodes.visionDetail.value,
        baseUrl: nodes.visionBaseUrl.value.trim(),
        model: selectedVisionModelName(),
        maxImages: Math.max(1, Math.min(8, optionalInteger(nodes.visionMaxImages.value) || 4))
      };
      if (nodes.visionApiKey.value) payload.apiKey = nodes.visionApiKey.value;
      try {
        const response = await fetch("/api/settings/vision", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        });
        const config = await response.json();
        if (!response.ok) throw new Error(config.error || "视觉设置保存失败");
        nodes.visionApiKey.value = "";
        nodes.visionSettingsState.textContent = "已保存 · " + formatVisionSettingsState(config);
        setStatus("视觉设置已保存");
        return config;
      } catch (error) {
        nodes.visionSettingsState.textContent = error.message || String(error);
        setStatus(error.message || String(error), true);
        if (rethrow) throw error;
        return undefined;
      } finally {
        nodes.saveVisionSettingsBtn.disabled = false;
      }
    }

    async function testVisionConnection() {
      nodes.visionSettingsState.textContent = "测试连接中...";
      nodes.testVisionBtn.disabled = true;
      try {
        await saveVisionSettings(true);
        const response = await fetch("/api/v1/diagnostics/vision/test", { method: "POST" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "视觉连接测试失败");
        nodes.visionSettingsState.textContent = "连接正常 · " + body.latencyMs + " ms · " + body.model;
      } catch (error) {
        nodes.visionSettingsState.textContent = error.message || String(error);
      } finally {
        nodes.testVisionBtn.disabled = false;
      }
    }

    async function discoverVisionModels() {
      nodes.visionSettingsState.textContent = "读取模型中...";
      nodes.discoverVisionModelsBtn.disabled = true;
      try {
        const selectedBefore = selectedVisionModelName();
        await saveVisionSettings(true);
        const response = await fetch("/api/v1/diagnostics/vision/models");
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "视觉模型读取失败");
        state.discoveredVisionModels = Array.isArray(body.models) ? body.models : [];
        renderVisionModelOptions(state.discoveredVisionModels.includes(selectedBefore) ? selectedBefore : "");
        nodes.visionSettingsState.textContent = state.discoveredVisionModels.length + " 个模型";
      } catch (error) {
        nodes.visionSettingsState.textContent = error.message || String(error);
      } finally {
        nodes.discoverVisionModelsBtn.disabled = false;
      }
    }

    async function clearVisionApiKey() {
      nodes.visionSettingsState.textContent = "清除中...";
      nodes.clearVisionApiKeyBtn.disabled = true;
      try {
        const response = await fetch("/api/settings/vision", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clearApiKey: true })
        });
        const config = await response.json();
        if (!response.ok) throw new Error(config.error || "Vision Key 清除失败");
        nodes.visionApiKey.value = "";
        nodes.visionSettingsState.textContent = formatVisionSettingsState(config);
        setStatus("Vision Key 已清除");
      } catch (error) {
        nodes.visionSettingsState.textContent = error.message || String(error);
        setStatus(error.message || String(error), true);
      } finally {
        nodes.clearVisionApiKeyBtn.disabled = false;
      }
    }

    function formatVisionSettingsState(config) {
      const labels = { auto: "自动", direct: "主模型直读", mcp: "Vision MCP", off: "关闭" };
      return (labels[config.mode] || config.mode) + " · Key: " +
        (config.apiKeySet ? config.apiKeyMasked : "未设置") + " · 上限 " + (config.maxImages || 4) + " 张";
    }

    async function loadReadiness() {
      try {
        const response = await fetch("/api/v1/readiness");
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "运行状态不可用");
        nodes.runtimeState.textContent = "数据库 " + body.database + " · 通知 " + body.notificationChannel;
      } catch (error) {
        nodes.runtimeState.textContent = error.message || String(error);
      }
    }

    async function loadTavilySettings() {
      nodes.tavilySettingsState.textContent = "加载中...";
      try {
        const response = await fetch("/api/settings/tavily");
        const config = await response.json();
        if (!response.ok) throw new Error(config.error || "Tavily 设置加载失败");
        nodes.tavilyApiKey.value = "";
        nodes.tavilyProxyUrl.value = "";
        nodes.tavilySettingsState.textContent = formatTavilySettingsState(config);
      } catch (error) {
        nodes.tavilySettingsState.textContent = error.message || String(error);
      }
    }

    async function saveTavilySettings(rethrow) {
      nodes.tavilySettingsState.textContent = "保存中...";
      nodes.saveTavilyBtn.disabled = true;
      const payload = {};
      if (nodes.tavilyApiKey.value) payload.apiKey = nodes.tavilyApiKey.value;
      if (nodes.tavilyProxyUrl.value) payload.proxyUrl = nodes.tavilyProxyUrl.value;
      try {
        const response = await fetch("/api/settings/tavily", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        });
        const config = await response.json();
        if (!response.ok) throw new Error(config.error || "Tavily 设置保存失败");
        nodes.tavilyApiKey.value = "";
        nodes.tavilyProxyUrl.value = "";
        nodes.tavilySettingsState.textContent = "已保存 · " + formatTavilySettingsState(config);
        setStatus("Tavily 设置已保存");
        return config;
      } catch (error) {
        nodes.tavilySettingsState.textContent = error.message || String(error);
        setStatus(error.message || String(error), true);
        if (rethrow) throw error;
        return undefined;
      } finally {
        nodes.saveTavilyBtn.disabled = false;
      }
    }

    async function testTavilyConnection() {
      nodes.tavilySettingsState.textContent = "测试连接中...";
      nodes.testTavilyBtn.disabled = true;
      try {
        if (nodes.tavilyApiKey.value || nodes.tavilyProxyUrl.value) await saveTavilySettings(true);
        const response = await fetch("/api/v1/diagnostics/tavily/test", { method: "POST" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Tavily 连接测试失败");
        nodes.tavilySettingsState.textContent = "连接正常 · " + body.latencyMs + " ms";
      } catch (error) {
        nodes.tavilySettingsState.textContent = error.message || String(error);
      } finally {
        nodes.testTavilyBtn.disabled = false;
      }
    }

    async function clearTavilyKey() {
      nodes.tavilySettingsState.textContent = "清除中...";
      nodes.clearTavilyBtn.disabled = true;
      try {
        const response = await fetch("/api/settings/tavily", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clearApiKey: true })
        });
        const config = await response.json();
        if (!response.ok) throw new Error(config.error || "Tavily Key 清除失败");
        nodes.tavilyApiKey.value = "";
        nodes.tavilySettingsState.textContent = formatTavilySettingsState(config);
        setStatus("Tavily Key 已清除");
      } catch (error) {
        nodes.tavilySettingsState.textContent = error.message || String(error);
        setStatus(error.message || String(error), true);
      } finally {
        nodes.clearTavilyBtn.disabled = false;
      }
    }

    async function clearTavilyProxy() {
      nodes.tavilySettingsState.textContent = "清除中...";
      nodes.clearTavilyProxyBtn.disabled = true;
      try {
        const response = await fetch("/api/settings/tavily", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clearProxyUrl: true })
        });
        const config = await response.json();
        if (!response.ok) throw new Error(config.error || "Tavily 代理清除失败");
        nodes.tavilyProxyUrl.value = "";
        nodes.tavilySettingsState.textContent = formatTavilySettingsState(config);
        setStatus("Tavily 代理已清除");
      } catch (error) {
        nodes.tavilySettingsState.textContent = error.message || String(error);
        setStatus(error.message || String(error), true);
      } finally {
        nodes.clearTavilyProxyBtn.disabled = false;
      }
    }

    function formatTavilySettingsState(config) {
      const key = config.apiKeySet ? config.apiKeyMasked : "未设置";
      const proxy = config.proxyUrlSet ? config.proxyUrlMasked : "直连";
      return "Key: " + key + " · 代理: " + proxy;
    }

    async function testModelConnection() {
      nodes.apiSettingsState.textContent = "测试连接中...";
      nodes.testModelBtn.disabled = true;
      try {
        await saveApiSettings(true);
        const response = await fetch("/api/v1/diagnostics/model/test?profileId=" + encodeURIComponent(state.selectedModelProfileId), { method: "POST" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "连接测试失败");
        nodes.apiSettingsState.textContent = "连接正常 · " + body.latencyMs + " ms";
      } catch (error) {
        nodes.apiSettingsState.textContent = error.message || String(error);
      } finally {
        nodes.testModelBtn.disabled = false;
      }
    }

    async function discoverModels() {
      nodes.apiSettingsState.textContent = "读取模型中...";
      nodes.discoverModelsBtn.disabled = true;
      try {
        const selectedBefore = selectedModelName();
        await saveApiSettings(true);
        const response = await fetch("/api/v1/diagnostics/model/models?profileId=" + encodeURIComponent(state.selectedModelProfileId));
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "模型读取失败");
        state.discoveredModels = Array.isArray(body.models) ? body.models : [];
        renderModelOptions(state.discoveredModels.includes(selectedBefore) ? selectedBefore : "");
        nodes.apiSettingsState.textContent = state.discoveredModels.length + " 个模型";
      } catch (error) {
        nodes.apiSettingsState.textContent = error.message || String(error);
      } finally {
        nodes.discoverModelsBtn.disabled = false;
      }
    }

    function exportOkfBundle() {
      const query = new URLSearchParams();
      if (nodes.okfIncludeProfile.checked) query.set("includeProfile", "1");
      if (nodes.okfIncludeSouls.checked) query.set("includeSouls", "1");
      if (nodes.okfIncludeScenes.checked) query.set("includeScenes", "1");
      const link = document.createElement("a");
      link.href = "/api/v1/memory-vault/okf/export" + (query.size ? "?" + query.toString() : "");
      link.click();
      nodes.okfImportState.textContent = "正在导出 OKF...";
    }

    async function selectOkfImportBundle() {
      const file = nodes.okfImportInput.files?.[0] || null;
      nodes.okfImportInput.value = "";
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) {
        state.okfImportFile = null;
        state.okfImportPreview = null;
        nodes.okfImportState.textContent = "OKF ZIP 超过 5 MiB";
        renderOkfImportPreview();
        return;
      }
      state.okfImportFile = file;
      await previewOkfImport();
    }

    function changeOkfImportTarget() {
      const roleplay = nodes.okfImportRealm.value === "roleplay";
      nodes.okfImportCharacterField.hidden = !roleplay;
      nodes.okfImportCharacter.disabled = !roleplay;
      if (roleplay && !nodes.okfImportCharacter.value && state.characters.length) {
        nodes.okfImportCharacter.value = state.selectedCharacterId || state.characters[0].id;
      }
      if (state.okfImportFile) previewOkfImport();
    }

    function okfImportUrl(action) {
      const query = new URLSearchParams({ realm: nodes.okfImportRealm.value || "auto" });
      if (nodes.okfImportRealm.value === "roleplay" && nodes.okfImportCharacter.value) {
        query.set("characterId", nodes.okfImportCharacter.value);
      }
      return "/api/v1/memory-vault/okf/import/" + action + "?" + query.toString();
    }

    async function previewOkfImport() {
      const file = state.okfImportFile;
      if (!file) return;
      state.okfImportPreview = null;
      nodes.stageOkfImportBtn.disabled = true;
      nodes.selectOkfImportBtn.disabled = true;
      nodes.okfImportState.textContent = "校验 " + file.name + "...";
      renderOkfImportPreview();
      try {
        const response = await fetch(okfImportUrl("preview"), {
          method: "POST",
          headers: { "content-type": "application/zip" },
          body: file
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "OKF 校验失败");
        state.okfImportPreview = body.preview || null;
        renderOkfImportPreview();
        nodes.okfImportState.textContent = state.okfImportPreview?.conforms
          ? file.name + " · 校验通过"
          : file.name + " · 存在格式错误";
      } catch (error) {
        nodes.okfImportState.textContent = error.message || String(error);
        state.okfImportPreview = null;
        renderOkfImportPreview();
      } finally {
        nodes.selectOkfImportBtn.disabled = false;
      }
    }

    function renderOkfImportPreview() {
      const preview = state.okfImportPreview;
      nodes.okfImportPreview.hidden = !preview;
      nodes.stageOkfImportBtn.disabled = !preview?.conforms || !Number(preview?.readyCount || 0);
      if (!preview) {
        nodes.okfPreviewSummary.innerHTML = "";
        nodes.okfDocumentList.innerHTML = "";
        return;
      }
      const issueCount = Array.isArray(preview.issues) ? preview.issues.length : 0;
      nodes.okfPreviewSummary.innerHTML = '<strong>' + (preview.conforms ? '格式合规' : '格式错误') + '</strong>' +
        '<span>' + Number(preview.readyCount || 0) + ' 条可导入 · ' + Number(preview.unsupportedCount || 0) + ' 条跳过' +
        (issueCount ? ' · ' + issueCount + ' 个问题' : '') + '</span>';
      const labels = {
        ready: ["circle-check", "待审核"],
        unsupported: ["triangle-alert", "跳过"],
        reserved: ["book-open", "结构"],
        invalid: ["circle-x", "错误"]
      };
      nodes.okfDocumentList.innerHTML = (preview.documents || []).map((document) => {
        const status = labels[document.status] || labels.unsupported;
        const detail = document.reason || (document.status === "reserved" ? document.path : document.excerpt) || document.path;
        return '<div class="okf-document-row ' + escapeHtml(document.status || 'unsupported') + '">' +
          '<i data-lucide="' + status[0] + '" aria-hidden="true"></i>' +
          '<span class="okf-document-copy"><strong>' + escapeHtml(document.title || document.path) + '</strong>' +
          '<span title="' + escapeHtml(detail) + '">' + escapeHtml(document.type || 'Unknown') + ' · ' + escapeHtml(detail) + '</span></span>' +
          '<span class="okf-document-status">' + status[1] + '</span></div>';
      }).join("");
      refreshIcons();
    }

    async function stageOkfImport() {
      const file = state.okfImportFile;
      const preview = state.okfImportPreview;
      if (!file || !preview?.conforms || !preview.readyCount) return;
      nodes.stageOkfImportBtn.disabled = true;
      nodes.selectOkfImportBtn.disabled = true;
      nodes.okfImportState.textContent = "加入待审核队列...";
      try {
        const response = await fetch(okfImportUrl("stage"), {
          method: "POST",
          headers: { "content-type": "application/zip" },
          body: file
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "OKF 导入失败");
        nodes.okfImportState.textContent = Number(body.staged?.length || 0) + " 条记忆已加入待审核";
        await Promise.all([loadMemoryVaultStatus(), loadManagedMemories()]);
      } catch (error) {
        nodes.okfImportState.textContent = error.message || String(error);
      } finally {
        nodes.selectOkfImportBtn.disabled = false;
        nodes.stageOkfImportBtn.disabled = !state.okfImportPreview?.conforms || !state.okfImportPreview?.readyCount;
      }
    }

    function exportData() {
      const link = document.createElement("a");
      link.href = "/api/v1/export";
      link.click();
    }

    async function loadMemoryVaultStatus() {
      nodes.memoryVaultState.textContent = "加载中...";
      try {
        const [response, healthResponse] = await Promise.all([
          fetch("/api/v1/memory-vault/status"),
          fetch("/api/v1/memory-vault/health")
        ]);
        const body = await response.json();
        const healthBody = await healthResponse.json();
        if (!response.ok) throw new Error(body.error || "Vault 状态读取失败");
        if (!healthResponse.ok) throw new Error(healthBody.error || "Vault 健康状态读取失败");
        const vault = body.vault || {};
        const health = healthBody.health || {};
        nodes.memoryVaultPath.value = vault.rootPath || "仅内存模式";
        const quarantine = vault.counts?.memory ? " · " + vault.counts.memory + " 条记忆" : "";
        const external = vault.externalModifiedCount ? " · " + vault.externalModifiedCount + " 个外部修改" : "";
        nodes.memoryVaultState.textContent = (vault.inSync ? "已同步" : "待同步") + " · " + (vault.documentCount || 0) + " 个文档" + quarantine + external;
        nodes.memoryVaultWriter.textContent = (health.writer?.mode || "unknown") +
          (health.writer?.fenceToken != null ? " · fence " + health.writer.fenceToken : "") +
          (health.writer?.leaseExpiresAt ? " · 至 " + formatTraceTime(health.writer.leaseExpiresAt) : "");
        nodes.memoryVaultJournal.textContent = Number(health.journal?.pendingCount || 0) + " pending · " +
          Number(health.journal?.operationsRetained || 0) + " retained";
        nodes.memoryVaultRecovery.textContent = Number(health.startupRecoveryCount || 0) + " startup · " +
          (health.journal?.lastRecoveryAt ? formatTraceTime(health.journal.lastRecoveryAt) + " · " + health.journal.lastRecoveryOutcome : "无回放");
        nodes.memoryVaultProjection.textContent = (health.projectionConsistent ? "一致" : "不一致") + " · " +
          String(health.vaultHash || "").slice(0, 12) + " / " + String(health.projectionHash || "none").slice(0, 12);
        nodes.memoryVaultBackup.textContent = health.backup?.generatedAt ?
          formatTraceTime(health.backup.generatedAt) + " · " +
          (health.backup.valid === true ? "已验证" : health.backup.valid === false ? "验证失败" : "未验证") : "无备份记录";
      } catch (error) {
        nodes.memoryVaultState.textContent = error.message || String(error);
      }
    }

    async function loadTraceArchiveSettings() {
      nodes.traceArchiveEnabled.disabled = true;
      nodes.traceArchiveState.textContent = "加载中...";
      try {
        const response = await fetch("/api/settings/trace-archive");
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Trace 日志状态读取失败");
        renderTraceArchiveSettings(body);
      } catch (error) {
        nodes.traceArchiveState.textContent = error.message || String(error);
      }
    }

    function renderTraceArchiveSettings(status) {
      nodes.traceArchiveEnabled.checked = Boolean(status.enabled);
      nodes.traceArchiveEnabled.disabled = !status.available;
      nodes.traceArchivePath.value = status.directory || "仅持久化运行模式可用";
      const usage = Number(status.files || 0) + " 个文件 · " + formatFileSize(status.totalBytes || 0);
      nodes.traceArchiveState.textContent = status.lastError
        ? "写入失败 · " + status.lastError
        : (status.enabled ? "已开启 · " : "已关闭 · ") + usage;
    }

    async function updateTraceArchiveSetting() {
      const enabled = nodes.traceArchiveEnabled.checked;
      nodes.traceArchiveEnabled.disabled = true;
      nodes.traceArchiveState.textContent = enabled ? "开启中..." : "关闭中...";
      try {
        const response = await fetch("/api/settings/trace-archive", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled })
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Trace 日志设置失败");
        renderTraceArchiveSettings(body);
      } catch (error) {
        nodes.traceArchiveEnabled.checked = !enabled;
        nodes.traceArchiveEnabled.disabled = false;
        nodes.traceArchiveState.textContent = error.message || String(error);
      }
    }

    async function runMemoryVaultAction(action) {
      nodes.syncMemoryVaultBtn.disabled = true;
      nodes.rebuildMemoryVaultBtn.disabled = true;
      nodes.memoryVaultState.textContent = action === "sync" ? "同步中..." : "重建中...";
      try {
        const response = await fetch("/api/v1/memory-vault/" + action, { method: "POST" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Vault 操作失败");
        await loadMemoryVaultStatus();
      } catch (error) {
        nodes.memoryVaultState.textContent = error.message || String(error);
      } finally {
        nodes.syncMemoryVaultBtn.disabled = false;
        nodes.rebuildMemoryVaultBtn.disabled = false;
      }
    }

    async function deleteAllData() {
      const confirmation = "DELETE_ALL_DATA";
      const deleted = await openActionDialog({
        title: "删除全部数据",
        description: "所有会话、日程、角色和记忆都将被永久删除。输入 DELETE_ALL_DATA 确认。",
        fieldLabel: "输入确认短语",
        confirmLabel: "删除全部数据",
        validate: (value) => value !== confirmation ? "确认短语不匹配，未删除。" : "",
        onConfirm: async (value) => {
          const response = await fetch("/api/v1/data", {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ confirm: value })
          });
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || "删除失败");
        }
      });
      if (deleted) {
        state.messages = [];
        state.scheduleItems = [];
        state.characters = [];
        state.memories = [];
        state.sessions = [];
        state.selectedCharacterId = "";
        state.workspaceCharacterId = "";
        renderCharacterOptions();
        startNewSession();
        setStatus("全部用户数据已删除");
      }
    }

    async function saveApiSettings(rethrow) {
      nodes.apiSettingsState.textContent = "保存中...";
      const payload = {
        name: nodes.apiProfileName.value.trim(),
        enabled: nodes.apiEnabled.checked,
        visionInputEnabled: nodes.apiVisionInputEnabled.checked,
        baseUrl: nodes.apiBaseUrl.value.trim(),
        model: selectedModelName(),
        temperature: optionalNumber(nodes.apiTemperature.value),
        maxTokens: optionalInteger(nodes.apiMaxTokens.value),
        contextWindowTokens: optionalInteger(nodes.apiContextWindowTokens.value)
      };
      if (nodes.apiKey.value) {
        payload.apiKey = nodes.apiKey.value;
      }
      try {
        if (!state.selectedModelProfileId) throw new Error("请先选择模型配置");
        const response = await fetch("/api/v1/model-profiles/" + encodeURIComponent(state.selectedModelProfileId), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "保存失败");
        const config = body.profile;
        nodes.apiKey.value = "";
        nodes.apiSettingsState.textContent = config.apiKeySet ? "已保存，Key: " + config.apiKeyMasked : "已保存，Key: 未设置";
        await loadModelProfiles(config.id);
        renderCharacterOptions();
        setStatus("API 设置已保存");
        return config;
      } catch (error) {
        nodes.apiSettingsState.textContent = error.message || String(error);
        setStatus(error.message || String(error), true);
        if (rethrow) throw error;
        return undefined;
      }
    }

    async function clearApiKey() {
      nodes.apiSettingsState.textContent = "清除中...";
      try {
        const response = await fetch("/api/v1/model-profiles/" + encodeURIComponent(state.selectedModelProfileId), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clearApiKey: true })
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "清除失败");
        const config = body.profile;
        nodes.apiKey.value = "";
        nodes.apiSettingsState.textContent = config.apiKeySet ? "Key: " + config.apiKeyMasked : "Key: 未设置";
        setStatus("API Key 已清除");
      } catch (error) {
        nodes.apiSettingsState.textContent = error.message || String(error);
        setStatus(error.message || String(error), true);
      }
    }

    function renderModelTraces(traceGroups) {
      ["conversation", "background"].forEach((scope) => {
        const previousEntries = state.debugTracesByScope[scope] || [];
        const previousIndex = state.selectedTraceIndexes[scope] || 0;
        const previousId = previousEntries[previousIndex]?.id;
        const entries = Array.isArray(traceGroups?.[scope]) ? traceGroups[scope] : [];
        state.debugTracesByScope[scope] = entries;
        const restoredIndex = entries.findIndex((trace) => trace.id === previousId);
        state.selectedTraceIndexes[scope] = restoredIndex >= 0 ? restoredIndex : 0;
      });
      renderTraceScopeTabs();
      renderTraceIndex();
      renderSelectedTrace();
    }

    function activeDebugTraces() {
      return state.debugTracesByScope[state.debugTraceScope] || [];
    }

    function selectedDebugTraceIndex() {
      return state.selectedTraceIndexes[state.debugTraceScope] || 0;
    }

    function setSelectedDebugTraceIndex(index) {
      state.selectedTraceIndexes[state.debugTraceScope] = index;
    }

    function setDebugTraceScope(scope) {
      if (scope !== "conversation" && scope !== "background") return;
      state.debugTraceScope = scope;
      renderTraceScopeTabs();
      renderTraceIndex();
      renderSelectedTrace();
    }

    function renderTraceScopeTabs() {
      const conversation = state.debugTraceScope === "conversation";
      nodes.conversationTraceScopeBtn.classList.toggle("active", conversation);
      nodes.backgroundTraceScopeBtn.classList.toggle("active", !conversation);
      nodes.conversationTraceScopeBtn.setAttribute("aria-selected", String(conversation));
      nodes.backgroundTraceScopeBtn.setAttribute("aria-selected", String(!conversation));
      nodes.conversationTraceCount.textContent = String(state.debugTracesByScope.conversation.length);
      nodes.backgroundTraceCount.textContent = String(state.debugTracesByScope.background.length);
    }

    function emptyTraceScopeMessage() {
      return state.debugTraceScope === "conversation"
        ? "暂无会话内模型请求。用户发起对话后会显示记录。"
        : "暂无会话外模型请求。角色自主任务或后台分析运行后会显示记录。";
    }

    function renderTraceIndex() {
      if (state.debugDataset === "economics") {
        nodes.traceIndex.innerHTML = state.debugEconomics.map((entry, index) =>
          '<button class="trace-index-item' + (index === state.selectedEconomicsIndex ? ' active' : '') + '" type="button" data-trace-index="' + index + '">' +
            '<span class="trace-index-title">' + escapeHtml(traceTurnLabel(entry.turnKind) + " · " + entry.estimatedInputTokens + " tokens") + '</span>' +
            '<span class="trace-index-meta">LCP ' + Number(entry.prefixReuseRatio || 0).toLocaleString(undefined, { style: "percent", maximumFractionDigits: 1 }) +
              ' · ' + Number(entry.memoryIds?.length || 0) + ' memories<br>' + escapeHtml(formatTraceTime(entry.createdAt)) + '</span></button>'
        ).join("");
        renderMobileTraceSelect();
        if (!state.debugEconomics.length) showEmptyDebug("暂无 Context Economics。下一次 provider 请求后会生成记录。");
        return;
      }
      const traces = activeDebugTraces();
      const selectedIndex = selectedDebugTraceIndex();
      nodes.traceIndex.innerHTML = traces.map((trace, index) => {
        const turnLabel = traceTurnLabel(trace.turnKind);
        const quantity = traceContextQuantity(trace.payload);
        return '<button class="trace-index-item' + (index === selectedIndex ? ' active' : '') + '"' +
          ' type="button" data-trace-index="' + index + '" title="' + escapeHtml(trace.requestText || "") + '">' +
          '<span class="trace-index-title">' + escapeHtml(trace.requestText || "（无请求摘要）") + '</span>' +
          '<span class="trace-index-meta">#' + (index + 1) + ' · ' + escapeHtml(trace.mode || "") + ' · ' + turnLabel +
            '<br>' + quantity.total + ' 条上下文 · ' + quantity.toolSchemas + ' 个 Schema · ' + escapeHtml(formatTraceTime(trace.createdAt)) + '</span>' +
        '</button>';
      }).join("");
      renderMobileTraceSelect();
      if (!traces.length) showEmptyDebug(emptyTraceScopeMessage());
    }

    function renderMobileTraceSelect() {
      const economics = state.debugDataset === "economics";
      const entries = economics ? state.debugEconomics : activeDebugTraces();
      const selectedIndex = economics ? state.selectedEconomicsIndex : selectedDebugTraceIndex();
      nodes.mobileTraceSelect.disabled = !entries.length;
      if (!entries.length) {
        nodes.mobileTraceSelect.innerHTML = '<option value="">暂无记录</option>';
        return;
      }
      nodes.mobileTraceSelect.innerHTML = entries.map((entry, index) => {
        const label = economics
          ? (traceTurnLabel(entry.turnKind) + " · " + entry.estimatedInputTokens + " tokens · " + formatTraceTime(entry.createdAt))
          : ("#" + (index + 1) + " · " + (entry.requestText || "无请求摘要") + " · " + traceContextQuantity(entry.payload).total + " 条上下文");
        return '<option value="' + index + '"' + (index === selectedIndex ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
      }).join("");
    }

    function showEmptyDebug(message) {
      nodes.traceDetail.hidden = true;
      nodes.traceEmpty.hidden = false;
      nodes.traceEmpty.textContent = message;
    }

    function selectTraceFromIndex(event) {
      const item = event.target.closest("[data-trace-index]");
      if (!item) return;
      const index = Number(item.dataset.traceIndex);
      const entries = state.debugDataset === "economics" ? state.debugEconomics : activeDebugTraces();
      if (!Number.isInteger(index) || !entries[index]) return;
      if (state.debugDataset === "economics") state.selectedEconomicsIndex = index;
      else setSelectedDebugTraceIndex(index);
      renderTraceIndex();
      renderSelectedTrace();
    }

    function selectTraceFromMobile() {
      const index = Number(nodes.mobileTraceSelect.value);
      const entries = state.debugDataset === "economics" ? state.debugEconomics : activeDebugTraces();
      if (!Number.isInteger(index) || !entries[index]) return;
      if (state.debugDataset === "economics") state.selectedEconomicsIndex = index;
      else setSelectedDebugTraceIndex(index);
      renderTraceIndex();
      renderSelectedTrace();
    }

    function renderSelectedTrace() {
      if (state.debugDataset === "economics") {
        renderSelectedEconomics();
        return;
      }
      const trace = activeDebugTraces()[selectedDebugTraceIndex()];
      if (!trace) {
        showEmptyDebug(emptyTraceScopeMessage());
        return;
      }
      const payload = trace.payload && typeof trace.payload === "object" ? trace.payload : {};
      const quantity = traceContextQuantity(payload);
      const turnLabel = traceTurnLabel(trace.turnKind);
      const model = typeof payload.model === "string" ? payload.model : "未标明模型";
      nodes.traceEmpty.hidden = true;
      nodes.traceDetail.hidden = false;
      nodes.traceDetailTitle.textContent = trace.requestText || "（无请求摘要）";
      nodes.traceDetailMeta.textContent = [
        trace.sessionId,
        trace.mode,
        traceScopeLabel(trace.scope),
        turnLabel,
        model,
        quantity.total + " 条上下文",
        quantity.toolSchemas + " 个 Schema",
        formatTraceTime(trace.createdAt)
      ].filter(Boolean).join(" · ");
      nodes.traceSemanticBtn.classList.toggle("active", state.traceView === "semantic");
      nodes.traceRawBtn.classList.toggle("active", state.traceView === "raw");
      nodes.traceSemanticBtn.setAttribute("aria-selected", String(state.traceView === "semantic"));
      nodes.traceRawBtn.setAttribute("aria-selected", String(state.traceView === "raw"));
      nodes.traceContent.classList.toggle("nowrap", !state.traceWrap);
      nodes.traceWrapBtn.textContent = state.traceWrap ? "不换行" : "自动换行";
      nodes.traceWrapBtn.setAttribute("aria-pressed", String(state.traceWrap));
      nodes.traceExpandBtn.hidden = state.traceView !== "semantic";
      nodes.traceCopyBtn.textContent = "复制 Payload";
      if (state.traceView === "raw") {
        nodes.traceContent.innerHTML = '<pre class="trace-json">' + escapeHtml(formatTraceValue(payload)) + '</pre>';
      } else {
        nodes.traceContent.innerHTML = renderTraceQuantitySummary(quantity) + renderTraceBlocks(payload);
      }
      nodes.traceContent.scrollTop = 0;
      updateTraceExpandButton();
    }

    function renderSelectedEconomics() {
      const entry = state.debugEconomics[state.selectedEconomicsIndex];
      if (!entry) {
        showEmptyDebug("暂无 Context Economics。下一次 provider 请求后会生成记录。");
        return;
      }
      nodes.traceEmpty.hidden = true;
      nodes.traceDetail.hidden = false;
      nodes.traceDetailTitle.textContent = "Context Economics · " + entry.estimatedInputTokens + " estimated tokens";
      nodes.traceDetailMeta.textContent = [entry.sessionId, entry.mode, traceTurnLabel(entry.turnKind), formatTraceTime(entry.createdAt)].filter(Boolean).join(" · ");
      nodes.traceSemanticBtn.classList.toggle("active", state.traceView === "semantic");
      nodes.traceRawBtn.classList.toggle("active", state.traceView === "raw");
      nodes.traceSemanticBtn.setAttribute("aria-selected", String(state.traceView === "semantic"));
      nodes.traceRawBtn.setAttribute("aria-selected", String(state.traceView === "raw"));
      nodes.traceContent.classList.toggle("nowrap", !state.traceWrap);
      nodes.traceWrapBtn.textContent = state.traceWrap ? "不换行" : "自动换行";
      nodes.traceWrapBtn.setAttribute("aria-pressed", String(state.traceWrap));
      nodes.traceExpandBtn.hidden = state.traceView !== "semantic";
      nodes.traceCopyBtn.textContent = "复制指标";
      nodes.traceContent.innerHTML = state.traceView === "raw"
        ? '<pre class="trace-json">' + escapeHtml(formatTraceValue(entry)) + '</pre>'
        : renderEconomicsBlocks(entry);
      nodes.traceContent.scrollTop = 0;
      updateTraceExpandButton();
    }

    function setTraceView(view) {
      state.traceView = view;
      renderSelectedTrace();
    }

    function toggleTraceWrap() {
      state.traceWrap = !state.traceWrap;
      nodes.traceContent.classList.toggle("nowrap", !state.traceWrap);
      nodes.traceWrapBtn.textContent = state.traceWrap ? "不换行" : "自动换行";
      nodes.traceWrapBtn.setAttribute("aria-pressed", String(state.traceWrap));
    }

    function toggleAllTraceBlocks() {
      const blocks = [...nodes.traceContent.querySelectorAll("details.trace-block")];
      const shouldOpen = blocks.some((block) => !block.open);
      blocks.forEach((block) => { block.open = shouldOpen; });
      updateTraceExpandButton();
    }

    function updateTraceExpandButton() {
      const blocks = [...nodes.traceContent.querySelectorAll("details.trace-block")];
      if (!blocks.length) return;
      nodes.traceExpandBtn.textContent = blocks.every((block) => block.open) ? "全部折叠" : "全部展开";
    }

    async function copySelectedTrace() {
      const entry = state.debugDataset === "economics"
        ? state.debugEconomics[state.selectedEconomicsIndex]
        : activeDebugTraces()[selectedDebugTraceIndex()];
      if (!entry) return;
      const text = formatTraceValue(state.debugDataset === "economics" ? entry : entry.payload || {});
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.append(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      nodes.traceCopyBtn.textContent = "已复制";
      window.setTimeout(() => { nodes.traceCopyBtn.textContent = state.debugDataset === "economics" ? "复制指标" : "复制 Payload"; }, 1200);
    }

    function formatTraceTime(value) {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value || "") : date.toLocaleString();
    }

    function formatInsightTime(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value || "");
      return padDatePart(date.getMonth() + 1) + "-" + padDatePart(date.getDate()) +
        " " + padDatePart(date.getHours()) + ":" + padDatePart(date.getMinutes());
    }

    function formatProfileTime(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value || "");
      return date.getFullYear() + "-" + padDatePart(date.getMonth() + 1) + "-" +
        padDatePart(date.getDate()) + " " + padDatePart(date.getHours()) + ":" +
        padDatePart(date.getMinutes());
    }

    function padDatePart(value) {
      return String(value).padStart(2, "0");
    }

    function traceTurnLabel(kind) {
      return ({
        user: "用户消息",
        reminder_due: "到期提醒",
        group_gate: "群聊判断",
        group_reply: "群聊回复",
        subagent: "子 Agent",
        memory_extraction: "记忆提取",
        relationship_extraction: "关系提取",
        post_turn_analysis: "回合后分析",
        world_planning: "角色日程规划",
        proactive_message: "角色主动消息",
        world_director: "世界演绎",
        world_actor: "角色间自主交流",
        world_analysis: "世界回合结算",
        character_function_inference: "角色职能推断",
        character_skill_reflection: "角色 Skill 反思"
      })[kind] || kind || "模型调用";
    }

    function traceScopeLabel(scope) {
      return scope === "background" ? "会话外" : "会话内";
    }

    function renderEconomicsBlocks(entry) {
      const actual = entry.actual || {};
      const actualValue = (value) => value === null || value === undefined ? "unknown" : Number(value).toLocaleString();
      const metrics = [
        ["Input estimate", entry.estimatedInputTokens],
        ["Stable", entry.stableEstimatedTokens],
        ["Dynamic", entry.dynamicEstimatedTokens],
        ["Memory", entry.memoryEstimatedTokens],
        ["Tools", entry.toolEstimatedTokens],
        ["LCP messages", entry.lcpMessageCount + " / " + entry.messageCount],
        ["Prefix reuse", Number(entry.prefixReuseRatio || 0).toLocaleString(undefined, { style: "percent", maximumFractionDigits: 1 })],
        ["Planner budget", entry.plannerBudgetTokens],
        ["Actual input", actualValue(actual.inputTokens)],
        ["Actual output", actualValue(actual.outputTokens)],
        ["Cache read", actualValue(actual.cacheReadTokens)],
        ["Cache write", actualValue(actual.cacheWriteTokens)]
      ];
      const summary = '<div class="economics-grid">' + metrics.map((metric) =>
        '<div class="economics-metric"><span>' + escapeHtml(metric[0]) + '</span><strong>' + escapeHtml(String(metric[1])) + '</strong></div>'
      ).join("") + '</div>';
      const cache = '<details class="trace-block economics" open><summary><span>Cache contract</span><span class="trace-block-size">canonical provider payload</span></summary>' +
        '<div style="padding:10px;font-size:12px;line-height:1.6;">System <code>' + escapeHtml(String(entry.systemHash || "")) + '</code><br>' +
        'Tools <code>' + escapeHtml(String(entry.toolSchemaHash || "")) + '</code><br>' +
        'LCP estimated ' + Number(entry.lcpEstimatedTokens || 0).toLocaleString() + ' tokens' +
        (entry.cacheBreakReason ? '<br>Cache break: <strong>' + escapeHtml(entry.cacheBreakReason) + '</strong>' : '') +
        (entry.plannerTruncated ? '<br><strong>预算已命中，内容经过整条裁剪</strong>' : '') + '</div></details>';
      const sections = '<details class="trace-block economics"><summary><span>Context manifest</span><span class="trace-block-size">' +
        Number(entry.plan?.sections?.length || 0) + ' sections</span></summary><div style="padding:10px;">' +
        (entry.plan?.sections || []).map((section) => '<div class="retrieval-candidate"><strong>' + escapeHtml(section.id) + '</strong> · ' +
          escapeHtml(section.placement + " · " + section.estimatedTokens + " tokens · " + (section.included ? "included" : section.exclusionReason || "excluded") +
            (section.truncated ? " · truncated" : "")) + '</div>').join("") + '</div></details>';
      const retrieval = (entry.plan?.retrieval || []).map((plan) =>
        '<details class="trace-block economics"><summary><span>Memory Retrieval Plan · ' + escapeHtml(plan.realm + (plan.characterId ? " / " + plan.characterId : "")) + '</span>' +
        '<span class="trace-block-size">' + Number(plan.selectedMemoryIds?.length || 0) + ' / ' + Number(plan.candidateCount || 0) + ' selected</span></summary><div style="padding:10px;">' +
        (plan.candidates || []).map((candidate) => '<div class="retrieval-candidate"><strong>' + escapeHtml(candidate.memoryId) + '</strong> · score ' +
          escapeHtml(Number(candidate.score || 0).toFixed(4)) + ' · ' + escapeHtml(candidate.selected ? candidate.reason : candidate.exclusionReason || candidate.reason) +
          ' · ' + Number(candidate.estimatedTokens || 0) + ' tokens <button class="secondary" type="button" data-memory-jump="' + escapeHtml(candidate.memoryId) + '">查看记忆</button>' +
          '<div class="memory-source">relevance ' + Number(candidate.breakdown?.relevance || 0).toFixed(3) + ' · salience ' + Number(candidate.breakdown?.salience || 0).toFixed(3) +
          ' · recency ' + Number(candidate.breakdown?.recency || 0).toFixed(3) + ' · confidence ' + Number(candidate.breakdown?.confidence || 0).toFixed(3) + '</div></div>').join("") +
        '</div></details>'
      ).join("");
      return summary + cache + sections + retrieval;
    }

    function renderTraceBlocks(payload) {
      const blocks = [];
      if (payload.system !== undefined) {
        blocks.push(traceBlock("system", "System", payload.system));
      }
      if (Array.isArray(payload.messages)) {
        payload.messages.forEach((message, index) => blocks.push(traceMessageBlock(message, index)));
      }
      if (payload.input !== undefined) {
        if (Array.isArray(payload.input)) {
          payload.input.forEach((message, index) => blocks.push(traceMessageBlock(message, index)));
        } else {
          blocks.push(traceBlock("user", "Input", payload.input));
        }
      }
      if (payload.tools !== undefined) {
        blocks.push(traceBlock("schema", "Tools schema", payload.tools, false));
      }
      const parameters = {};
      Object.keys(payload).forEach((key) => {
        if (!["system", "messages", "input", "tools"].includes(key)) parameters[key] = payload[key];
      });
      if (Object.keys(parameters).length) {
        blocks.push(traceBlock("parameters", "Request parameters", parameters, false));
      }
      return blocks.join("");
    }

    function traceContextQuantity(payload) {
      const counts = { system: 0, user: 0, assistant: 0, tool: 0, other: 0 };
      let contextCharacters = 0;
      const countMessage = (message, fallbackRole) => {
        const role = traceContextRole(message, fallbackRole);
        counts[role] += 1;
        contextCharacters += traceCompactLength(message);
      };
      if (payload && payload.system !== undefined) countMessage(payload.system, "system");
      if (Array.isArray(payload?.messages)) {
        payload.messages.forEach((message) => countMessage(message, "other"));
      }
      if (payload && payload.input !== undefined) {
        if (Array.isArray(payload.input)) {
          payload.input.forEach((message) => countMessage(message, "user"));
        } else {
          countMessage(payload.input, "user");
        }
      }
      const toolSchemas = Array.isArray(payload?.tools)
        ? payload.tools.length
        : payload?.tools === undefined || payload?.tools === null ? 0 : 1;
      return {
        ...counts,
        total: counts.system + counts.user + counts.assistant + counts.tool + counts.other,
        toolSchemas,
        contextCharacters,
        toolSchemaCharacters: traceCompactLength(payload?.tools)
      };
    }

    function traceContextRole(message, fallbackRole) {
      const role = message && typeof message === "object" && !Array.isArray(message)
        ? String(message.role || "").toLowerCase()
        : "";
      if (role === "system" || role === "developer") return "system";
      if (role === "user") return "user";
      if (role === "assistant") return "assistant";
      if (role === "tool" || role === "function") return "tool";
      const type = message && typeof message === "object" && !Array.isArray(message)
        ? String(message.type || "").toLowerCase()
        : "";
      if (type === "function_call_output" || type === "tool_result") return "tool";
      if (type === "function_call") return "assistant";
      return fallbackRole;
    }

    function traceCompactLength(value) {
      if (value === undefined || value === null) return 0;
      if (typeof value === "string") return [...value].length;
      try {
        return [...JSON.stringify(value)].length;
      } catch {
        return [...String(value)].length;
      }
    }

    function renderTraceQuantitySummary(quantity) {
      const metrics = [
        ["上下文总数", quantity.total],
        ["System", quantity.system],
        ["User", quantity.user],
        ["Assistant", quantity.assistant],
        ["Tool", quantity.tool],
        ["其他", quantity.other],
        ["Tool Schema", quantity.toolSchemas],
        ["上下文字符", Number(quantity.contextCharacters || 0).toLocaleString()]
      ];
      return '<section class="trace-quantity-summary" aria-label="上下文数量汇总">' +
        '<div class="trace-quantity-head"><strong>上下文数量汇总</strong><span>Schema ' +
          Number(quantity.toolSchemaCharacters || 0).toLocaleString() + ' 字符，不计入上下文字符</span></div>' +
        '<div class="economics-grid">' + metrics.map((metric) =>
          '<div class="economics-metric"><span>' + escapeHtml(metric[0]) + '</span><strong>' +
            escapeHtml(String(metric[1])) + '</strong></div>'
        ).join("") + '</div></section>';
    }

    function traceMessageBlock(message, index) {
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        return traceBlock("parameters", "Message " + (index + 1), message);
      }
      const role = message.role === "developer" ? "system" : message.role === "function" ? "tool" :
        ["system", "user", "assistant", "tool"].includes(message.role) ? message.role : "parameters";
      const extraKeys = Object.keys(message).filter((key) => key !== "role" && key !== "content");
      const value = extraKeys.length ? message : message.content;
      return traceBlock(role, String(message.role || "message") + " " + (index + 1), value);
    }

    function traceBlock(role, label, value, open = true) {
      const text = formatTraceValue(value);
      return '<details class="trace-block ' + role + '"' + (open ? ' open' : '') + '>' +
        '<summary><span>' + escapeHtml(label) + '</span><span class="trace-block-size">' + text.length.toLocaleString() + ' 字符</span></summary>' +
        '<pre>' + escapeHtml(text) + '</pre>' +
      '</details>';
    }

    function formatTraceValue(value) {
      if (typeof value === "string") return value;
      const json = JSON.stringify(value, null, 2);
      return json === undefined ? String(value) : json;
    }

    function roleLabel(message) {
      if (message.role === "user") return "你";
      if (message.role === "assistant") {
        if (message.worldNarration) {
          return state.worldConversations.find((entry) => entry.worldId === state.activeWorldId)?.world?.name || "世界旁白";
        }
        return state.characters.find((entry) => entry.id === (message.senderId || state.selectedCharacterId))?.name || "角色";
      }
      if (message.role === "tool") return "Tool";
      return message.role;
    }

    function setStatus(text, isError) {
      nodes.status.textContent = text;
      nodes.status.classList.toggle("error", Boolean(isError));
    }

    function optionalNumber(value) {
      if (value === "") return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    }

    function optionalInteger(value) {
      if (value === "") return null;
      const number = Number(value);
      return Number.isFinite(number) ? Math.floor(number) : null;
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }
  </script>
</body>
</html>`;
}
