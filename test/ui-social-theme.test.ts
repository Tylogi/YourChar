import assert from "node:assert/strict";
import test from "node:test";
import { Script } from "node:vm";
import { parseHTML } from "linkedom";
import { renderAppHtml } from "../src/http/ui.js";
import { socialThemeCss } from "../src/http/ui-social-theme.js";

test("the production UI loads the approved social theme after the existing component styles", () => {
  const html = renderAppHtml();
  assert.ok(html.includes(`<style id="yourchar-social-theme">${socialThemeCss}</style>`));
  assert.ok(html.indexOf('id="yourchar-social-theme"') > html.indexOf("</style>"));
  for (const token of [
    "--bg: #f5f5f5", "--rail: #ededed", "--list: #f7f7f7",
    "--text: #1a1a1a", "--primary: #07c160", "--user: #95ec69",
    "--green-ink: #087b36", "--danger: #c84040", "--shadow: none",
  ]) assert.ok(socialThemeCss.includes(token), token);
  assert.match(socialThemeCss, /--font-ui: system-ui, -apple-system/);
  assert.match(socialThemeCss, /\.bubble \{ font-size: 16px;/);
  assert.match(socialThemeCss, /\.composer textarea \{ font-size: 16px;/);
  assert.match(socialThemeCss, /svg\.lucide \{ stroke-width: 1\.75;/);
  assert.doesNotMatch(socialThemeCss, /linear-gradient|backdrop-filter|filter:|url\(/);
  assert.doesNotMatch(html, /ui-social-assets\/avatars\.png/);
  assert.match(html, /id="conversationHeaderAvatar"/);
  assert.match(html, /id="scheduleCalendarViewBtn"/);
  assert.match(html, /id="scheduleCalendar" class="calendar-grid"/);
  assert.match(html, /id="scheduleMonthLabel"[^>]+aria-live="polite"/);
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Script(script));
});

test("meeting and settings details use neutral surfaces and readable labels", () => {
  assert.match(socialThemeCss, /\.composer \.primary \{ background: var\(--text\); color: var\(--panel\)/);
  assert.match(socialThemeCss, /\.composer \.primary:hover:not\(:disabled\) \{ background: #333333/);
  assert.match(socialThemeCss, /\.composer \.primary:disabled \{ background: var\(--selected\); color: var\(--sub\)/);
  assert.match(socialThemeCss, /\.scene-info-row \{[^}]*font-size: 14px/);
  assert.match(socialThemeCss, /\.meeting-preset-prompt-role, \.meeting-preset-prompt-kind \{[^}]*background: var\(--list\)[^}]*font-size: 12px/);
  assert.match(socialThemeCss, /\.vault-history-entry \{ border: 1px solid var\(--line\); background: var\(--list\)/);
  assert.doesNotMatch(socialThemeCss, /var\(--(?:ink|surface|border)\)/);
});

test("the retained month calendar renders 42 dates with selected/today states and safe event labels", () => {
  const html = renderAppHtml();
  const script = html.match(/function renderScheduleCalendar\(\) \{[\s\S]*?(?=\n    function renderTaskList)/)?.[0];
  assert.ok(script);
  const now = new Date();
  const dateKey = (date: Date) => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
  const selected = dateKey(now);
  const { document } = parseHTML('<span id="month"></span><div id="calendar"></div>');
  const nodes = {
    scheduleMonthLabel: document.querySelector("#month"),
    scheduleCalendar: document.querySelector("#calendar"),
  };
  const context = {
    state: { calendarCursor: new Date(now.getFullYear(), now.getMonth(), 1), selectedScheduleDate: selected },
    nodes,
    localDateKey: dateKey,
    scheduleItemsOnDate: (key: string) => key === selected ? [{ kind: "event", title: '<img src=x> "下午见"', status: "scheduled" }] : [],
    scheduleItemDisplayState: (item: { status: string }) => item.status,
    formatCalendarEvent: (item: { title: string }) => item.title,
    escapeHtml: (value: unknown) => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!),
  };
  new Script(script + "\nrenderScheduleCalendar();").runInNewContext(context);
  assert.equal(document.querySelectorAll(".calendar-day").length, 42);
  assert.equal(document.querySelectorAll('[aria-pressed="true"]').length, 1);
  assert.equal(document.querySelectorAll('[aria-current="date"]').length, 1);
  assert.equal(document.querySelector('[aria-pressed="true"]')?.getAttribute("data-date"), selected);
  assert.match(document.querySelector('[aria-current="date"]')?.getAttribute("aria-label") ?? "", /1 项日程/);
  assert.equal(document.querySelectorAll("img").length, 0);
  assert.equal(document.querySelector(".calendar-event")?.textContent, '<img src=x> "下午见"');
});
