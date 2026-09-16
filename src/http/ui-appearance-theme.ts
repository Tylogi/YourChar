/** Semantic dark surfaces, with explicit coverage for older auxiliary components. */
export const appearanceCss = `
    :root[data-theme="dark"] {
      color-scheme: dark;
      --bg: #181818; --panel: #222222; --list: #1d1d1d; --rail: #141414;
      --line: #383838; --text: #ededed; --muted: #a2a2a2; --sub: #b8b8b8;
      --hover: #303030; --selected: #363636;
      --primary: #383838; --primary-strong: #464646; --primary-ink: #ffffff;
      --green-ink: #dedede; --user: #343434; --user-ink: #f7f7f7;
      --assistant: #242424; --tool: #252525; --event: #242424;
      --danger: #f08484; --warning: #d6b16b; --status-ok: #69bd8a;
      --danger-surface: #352425; --warning-surface: #332d22;
    }
    :root[data-theme="light"] { color-scheme: light; }
    input, select, textarea { background: var(--panel); color: var(--text); }
    .settings-tabs { grid-template-columns: repeat(9, minmax(0, 1fr)); }
    .appearance-choices { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; max-width: 660px; margin: 24px 0; }
    .appearance-choice { display: grid; justify-items: center; gap: 8px; min-width: 0; padding: 14px 10px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); color: var(--text); cursor: pointer; }
    .appearance-choice:hover { background: var(--list); }
    .appearance-choice[aria-pressed="true"] { border-color: var(--green-ink); box-shadow: inset 0 0 0 1px var(--green-ink); }
    .appearance-choice strong { font-size: 14px; }
    .appearance-choice small { font-size: 12px; color: var(--sub); }
    .appearance-swatch { display: grid; place-items: center; width: 100%; height: 70px; border: 1px solid #80808040; border-radius: 6px; }
    .appearance-swatch svg { width: 22px; height: 22px; }
    .appearance-swatch.light { background: #f5f5f5; color: #242424; }
    .appearance-swatch.dark { background: #242424; color: #f5f5f5; }
    .appearance-swatch.system { background: linear-gradient(90deg, #f5f5f5 50%, #242424 50%); color: #808080; }
    #appearanceStatus, #localeStatus { font-size: 13px; }
    .locale-settings-block { max-width: 660px; margin-top: 30px; padding-top: 24px; border-top: 1px solid var(--line); }
    .locale-settings-block h4 { margin: 0 0 8px; font-size: 15px; }
    .locale-settings-block > .muted { margin: 0; }
    .locale-settings-block .appearance-choices { margin-top: 18px; }
    .appearance-swatch.locale-zh, .appearance-swatch.locale-en { font-size: 20px; font-weight: 700; letter-spacing: .04em; }
    /* Sent text, including Markdown and file cards, stays legible on charcoal. */
    .bubble.user .markdown-body :is(h1, h2, h3, h4, a, blockquote, code) { color: inherit; }
    .bubble.user .markdown-body a { text-decoration: underline; text-underline-offset: 3px; }
    .bubble.user .markdown-body :not(pre) > code { background: #ffffff16; }
    .bubble.user .markdown-body blockquote { background: #ffffff0d; border-color: #ffffff50; }
    .bubble.user .markdown-body :is(th, td) { border-color: #ffffff40; }
    .bubble.user .message-file-attachment { background: #ffffff12; color: var(--user-ink); border-color: #ffffff30; }
    .bubble.user .message-file-attachment :is(strong, small, a, button, svg) { color: inherit; }
    .bubble.user .message-file-attachment:hover { background: #ffffff22; }
    .conversation-mode-icon, .conversation-mode-icon.rp,
    .world-card .character-card-avatar, .conversation-header-avatar.group,
    .group-avatar-cluster, .message-avatar.world-avatar {
      background: var(--selected); color: var(--sub);
    }
    .function-capability-chip.primary, .module-type, .module-type.skill,
    .memory-badge, .memory-badge.core, .owned-skill-badge.active {
      background: var(--list); border-color: var(--line); color: var(--sub);
    }
    :root[data-theme="dark"] :is(dialog, aside, .settings-shell, .management-panel,
      .calendar-panel, .schedule-agenda, .task-panel, .character-card, .character-profile-soul,
      .conversation-batch-bar, .session-actions-menu, .proactive-feedback-panel, .emoji-picker,
      .character-skill-document, .owned-skill-card, .owned-skill-detail,
      .character-skill-package-review, .character-skill-package-manifest, .character-skill-package-detail,
      .relationship-bond-chip, .person-profile-form, .function-capability-chip,
      .feature-test-report, .feature-test-history, .feature-test-reply, .feature-test-dimension,
      .task-bench-form, .task-bench-upload-item, .git-registry-card, .im-channel-card,
      .attachment-chip, .workspace-file-preview-content pre, .context-budget-dialog > .scene-info-actions) {
      background: var(--panel); color: var(--text); border-color: var(--line);
    }
    :root[data-theme="dark"] :is(.character-skill-package-summary > div,
      .feature-test-score-grid > div, .initiative-summary > div, .context-budget-metrics > div) { background: var(--panel); color: var(--text); }
    :root[data-theme="dark"] :is(.character-skill-document-head, .owned-skill-detail-head,
      .function-status-badge, .owned-skill-badge, .affect-chip, .relationship-delta span,
      .life-capabilities span, .life-decision-badge, .person-profile, .user-insight-decision,
      .user-insight-evidence pre, .progress-list, .trace-index, .trace-block, .trace-quantity-summary,
      .economics-metric, .world-card-summary, .world-attribute-meta span, .feature-test-panel,
      .feature-test-input, .task-bench-advanced, .task-bench-upload, .task-bench-isolation,
      .initiative-debug-panel, .initiative-debug-detail pre, .git-registry-context, .git-registry-meta,
      .emoji-category-tabs, .workspace-file-preview-content, .workspace-html-preview-notice,
      .message-image-thumb, .message-inline-image, .schedule-status-badge,
      .calendar-event.completed, .calendar-event.delivered, .context-budget-metrics) {
      background: var(--list); color: var(--sub); border-color: var(--line);
    }
    :root[data-theme="dark"] :is(.relationship-meter, .context-budget-meter, .session-actions-separator) { background: var(--line); }
    :root[data-theme="dark"] :is(.owned-skill-card.active, .owned-skill-card:hover,
      .trace-scope-tabs button.active, .trace-index-item.active,
      .feature-test-history-table tr.active td, .session-actions-menu .private-mode-toggle[aria-checked="true"],
      .session-actions-menu .incognito-mode-toggle[aria-checked="true"]) { background: var(--selected); color: var(--text); border-color: var(--line); }
    :root[data-theme="dark"] :is(.trace-scope-tabs button:hover, .trace-index-item:hover,
      .session-actions-menu button:hover, .session-actions-menu button:focus-visible,
      .proactive-feedback-panel button:hover, .system-event-action:hover,
      .emoji-option:hover, .emoji-option:focus-visible, .emoji-category-button:hover,
      .attachment-remove:hover, .message-file-attachment:hover) { background: var(--hover); color: var(--text); }
    :root[data-theme="dark"] :is(.trace-view-tabs, .trace-scope-count) { background: var(--list); color: var(--sub); }
    :root[data-theme="dark"] .trace-view-tabs button.active { background: var(--selected); color: var(--text); }
    :root[data-theme="dark"] :is(.settings-field > label, .character-field > label,
      .relationship-metric, .life-panel, .life-field, .task-copy, .context-budget-summary,
      .context-budget-metrics, .trace-summary, .trace-index-item, .trace-view-tabs button,
      .trace-scope-tabs button, .owned-skill-proposal p, .message-file-attachment) { color: var(--text); }
    :root[data-theme="dark"] :is(.character-skill-document-head, .owned-skill-detail-head,
      .relationship-metric-head, .life-label, .life-row, .function-empty,
      .world-attribute-meta, .feature-test-label, .task-bench-form label,
      .trace-summary-meta, .trace-meta, .trace-block-head, .context-budget-metrics small,
      .context-budget-note, .message-file-copy small) { color: var(--sub); }
    :root[data-theme="dark"] :is(.scene-info-row, .scene-info-actions, .schedule-agenda-head,
      .task-item, .module-card, .memory-item, .character-skill-document-head, .owned-skill-detail-head,
      .settings-head, .archived-dialog-head, .schedule-editor-head, .world-attribute-row,
      .meeting-preset-prompt-row, .meeting-preset-editor, .im-channel-card,
      .trace-index-item, .trace-block, .message-file-attachment) { border-color: var(--line); }
    :root[data-theme="dark"] :is(.secondary, .icon-button) { color: var(--sub); }
    :root[data-theme="dark"] .primary { color: var(--primary-ink); }
    :root[data-theme="dark"] .primary:disabled { color: var(--sub); }
    :root[data-theme="dark"] .secondary:hover:not(:disabled) { border-color: var(--sub); }
    :root[data-theme="dark"] .danger-button { color: var(--danger); border-color: var(--danger); background: transparent; }
    :root[data-theme="dark"] .danger-button:hover:not(:disabled) { background: var(--danger-surface); }
    :root[data-theme="dark"] .toggle input { border-color: var(--sub); }
    :root[data-theme="dark"] .toggle input:checked::after { background: var(--bg); }
    :root[data-theme="dark"] :is(.im-privacy-banner, .incognito-notice, .life-proactive-pause,
      .owned-skill-proposal, .function-status-badge.pending, .owned-skill-badge.draft,
      .life-decision-badge.pending) {
      background: var(--warning-surface); color: var(--warning); border-color: var(--line);
    }
    :root[data-theme="dark"] :is(.character-collaboration-status.failed, .function-status-badge.failed,
      .life-decision-badge.failed, .schedule-status-badge.failed, .calendar-event.failed) {
      background: var(--danger-surface); color: var(--danger); border-color: var(--line);
    }
    :root[data-theme="dark"] :is(.function-status-badge.ready, .life-decision-badge.delivered,
      .schedule-status-badge.scheduled) {
      background: var(--list); color: var(--status-ok); border-color: var(--line);
    }
    :root[data-theme="dark"] .markdown-body :is(blockquote, :not(pre) > code) { background: var(--list); color: var(--sub); border-color: var(--line); }
    :root[data-theme="dark"] .bubble.user .markdown-body :is(blockquote, :not(pre) > code) { background: #ffffff0d; color: inherit; }
    :root[data-theme="dark"] .markdown-body :is(th, td, hr) { border-color: var(--line); }
    :root[data-theme="dark"] .trace-json { background: var(--rail); color: var(--text); }
    :root[data-theme="dark"] dialog::backdrop { background: #00000099; }
    @media (max-width: 600px) {
      .settings-tabs { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .appearance-choices { gap: 8px; }
      .appearance-choice { padding: 10px 6px; }
      .appearance-choice small { font-size: 11px; }
      .appearance-swatch { height: 58px; }
    }
`;
