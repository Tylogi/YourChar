# YourChar · neutral social UI

Revision: 2026-09-07. Preview: [ui-social-modern.html](../ui-social-modern.html).

## Direction

Keep the approved social/messaging composition: navigation rail, avatar-led contact list, private chat bubbles, shared worlds, profiles, schedules, and a conventional message composer. This revision changes the visual language, not the product category or information architecture. The prototype records the approved initial direction; the production implementation is in `src/http/ui-social-theme.ts`.

## Production refinement

The follow-up production revision uses a dark neutral send button (`#1a1a1a`, white foreground; `#333333` on hover), consistent with other primary actions. Disabled primary actions use `#e6e6e6` with `#616161` text. Green remains in sent bubbles, selection and useful status indicators. The prototype palette below records the earlier green-button exploration, not the final production send treatment.

Meeting details, preset import/editor panels, data-import previews, vault history, IM settings and capability settings share neutral surfaces and borders. Form labels use 13px type; supporting labels use 12px. Natural-language prompt editors use the system UI font, while JSON parameters and diagnostic code retain monospace. Warning/error states and platform identity marks keep their semantic colors. The existing avatar-led layout, meeting behavior and full 42-date month calendar are preserved. Production currently uses the light theme; the prototype also explores a dark theme.

Production checks: `npm run build`, the UI/calendar/meeting unit tests, `npm run test:browser`, and the isolated component regression in `test/ui-social-theme.browser.mjs` (run with the same browser environment as `test/browser.mjs`).

## Color

| Role | Light | Dark |
| --- | --- | --- |
| Navigation rail | `#ededed` | `#111111` |
| Contact list | `#f7f7f7` | `#1e1e1e` |
| Conversation background | `#f5f5f5` | `#191919` |
| Received bubble / panel | `#ffffff` | `#2c2c2c` |
| Primary text | `#1a1a1a` | `#ededed` |
| Secondary text | `#616161` | `#b5b5b5` |
| Metadata | `#707070` | `#a0a0a0` |
| Selected contact | `#e6e6e6` | `#343434` |
| Send action | `#07c160` | `#07c160` |
| Sent bubble | `#95ec69` | `#3eb575` |
| Text on sent bubble | `#142510` | `#082719` |
| Small green text | `#087b36` | `#62d89a` |
| Unread count background | `#c84040` | `#c84040` |

Neutral surfaces no longer carry sage, pink, or blue tints. Green communicates sending, selection, or a completed action; unread messages use a separate red badge and an explicit number. Small green labels use a darker derived shade for legibility; green buttons use dark text instead of low-contrast white. Unread badges use WeUI's darker RED-80 value to improve white-number contrast. No gradients or glass effects are used in the interface chrome. Floating menus and drawers retain restrained neutral shadows only to show layering.

## Type

The stack starts with `system-ui` and native Apple / Windows UI fonts, followed by explicit Chinese sans-serif fallbacks (PingFang SC, Microsoft YaHei UI, Microsoft YaHei, Noto Sans CJK SC). Fonts are resolved from the user's operating system, not downloaded or bundled. Exact glyph rendering therefore varies by platform.

- Conversation text and composer: 16px, regular, 1.6–1.65 line height.
- Contact names: 16px desktop / 17px phone; medium, with semibold only on the selected contact.
- Contact previews: 13px. Supporting labels: predominantly 12–14px.
- Timestamps and navigation captions: 11px. The nonessential phone keyboard hint is 10px.
- Page / section titles: 22–24px, semibold. No decorative letter spacing or ultra-light weights.
- Narrow layouts wrap or truncate content instead of shrinking conversation text.

## Assets

Keep portraits prominent, without ornamental frames, interface tints, or photo filters. A character's avatar is identity-bearing content; it does not need to match the app palette. Shared-world avatars retain the existing member mosaic, now on a neutral gray backing.

Use only one icon family for functional controls: the project's existing Lucide icons, inlined as SVG at 24px viewBox with 1.75px strokes (2.1px for the selected navigation item). The HTML includes the upstream license notices. No additional dependency was installed. Existing generated portraits are not modified or regenerated in this revision.

## Reference notes

References checked on 2026-09-07:

- [Tencent WeUI light color tokens](https://github.com/Tencent/weui/blob/master/src/style/base/theme/vars/light.less): neutral surfaces, brand green `#07c160`, light green `#95ec69`, and the red token family.
- [Tencent WeUI dark color tokens](https://github.com/Tencent/weui/blob/master/src/style/base/theme/vars/dark.less): neutral dark surfaces and light-green counterpart `#3eb575`.
- [Tencent WeUI font variables](https://github.com/Tencent/weui/blob/master/src/style/base/variable/global.less): native system sans-serif direction.
- [Official Codex product page](https://openai.com/codex/): product reference supplied by the user; no Codex layout, proprietary font file, screenshot, or branding is copied into this prototype.

These are current public WeUI tokens, not a claim of pixel-for-pixel equivalence with the newest WeChat desktop or mobile release. Chat background, text contrast, density, and control shapes are adapted for this prototype. WeChat's desktop site could not be loaded during the reference check, so exact latest-client screenshots were not verified.

## Verification

The companion `check.mjs` runs isolated browser checks for the prototype: JavaScript syntax, portrait loading and hover preservation, native font stack, constant 16px conversation text, representative foreground/background contrast of at least 4.5:1 in both themes, message input and safe rendering, contact/world/profile flows, theme persistence, and horizontal overflow at 320–1920px viewport widths. Screenshots are written to a fresh temporary directory. No real model, reminder, or messaging service is contacted.

From the repository root:

```sh
CLOAKBROWSER_AUTO_UPDATE=false LD_LIBRARY_PATH="${CLOAKBROWSER_LIB_DIR:-$HOME/.local/share/cloakbrowser-libs/usr/lib/x86_64-linux-gnu}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" node docs/ui-social-assets/check.mjs
```

Set `CLOAKBROWSER_LIB_DIR` if the browser libraries are installed elsewhere. Existing `LD_LIBRARY_PATH` entries are preserved.
