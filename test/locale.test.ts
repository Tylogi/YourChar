import assert from "node:assert/strict";
import test from "node:test";
import { Script } from "node:vm";
import { parseHTML } from "linkedom";
import {
  englishUiMessages,
  localeBootstrap,
  UI_LOCALE_STORAGE_KEY,
} from "../src/http/ui-locale.js";
import { renderAppHtml } from "../src/http/ui.js";

test("locale bootstrap resolves system language before styles and persists only explicit choices", () => {
  const html = renderAppHtml();
  assert.ok(html.indexOf(localeBootstrap) < html.indexOf("<style>"));
  assert.match(html, /id="localeChoices"/);
  assert.match(html, /data-locale-choice="system"/);
  assert.match(html, /data-locale-choice="zh-CN"/);
  assert.match(html, /data-locale-choice="en"/);

  for (const scenario of [
    { languages: ["zh-CN", "en-US"], stored: undefined, expectedLocale: "zh-CN", expectedPreference: "system" },
    { languages: ["en-US", "zh-CN"], stored: undefined, expectedLocale: "en", expectedPreference: "system" },
    { languages: ["zh-CN"], stored: "en", expectedLocale: "en", expectedPreference: "en" },
    { languages: ["en-US"], stored: "zh-CN", expectedLocale: "zh-CN", expectedPreference: "zh-CN" },
    { languages: ["en-US"], stored: "invalid", expectedLocale: "en", expectedPreference: "system" },
  ]) {
    const stored = new Map<string, string>();
    if (scenario.stored) stored.set(UI_LOCALE_STORAGE_KEY, scenario.stored);
    const root: Record<string, any> = { lang: "zh-CN", dataset: {} };
    const timers: Array<() => void> = [];
    const window: Record<string, any> = { setTimeout: (callback: () => void) => { timers.push(callback); } };
    const context = {
      window,
      navigator: { languages: scenario.languages, language: scenario.languages[0] },
      document: { documentElement: root },
      localStorage: { getItem: (key: string) => stored.get(key) ?? null },
    };
    new Script(localeBootstrap).runInNewContext(context);
    assert.equal(root.lang, scenario.expectedLocale);
    assert.equal(root.dataset.locale, scenario.expectedLocale);
    assert.equal(root.dataset.localePreference, scenario.expectedPreference);
    assert.equal(window.__yourcharLocaleBootstrap.preference, scenario.expectedPreference);
    assert.equal(window.__yourcharLocaleBootstrap.locale, scenario.expectedLocale);
    assert.equal(stored.get(UI_LOCALE_STORAGE_KEY), scenario.stored);
    for (const callback of timers) callback();
    assert.equal(root.dataset.localePending, undefined);
  }
});

test("English catalog covers the primary product navigation and never treats user content as a key", () => {
  assert.ok(Object.keys(englishUiMessages).length >= 700);
  assert.equal(englishUiMessages["聊天"], "Chat");
  assert.equal(englishUiMessages["日程"], "Schedule");
  assert.equal(englishUiMessages["角色"], "Characters");
  assert.equal(englishUiMessages["管理"], "Manage");
  assert.equal(englishUiMessages["外观与语言"], "Appearance & language");
  assert.equal(englishUiMessages["设置，这是用户写的内容"], undefined);
});

test("every static Chinese UI string and accessible label has an English catalog entry", () => {
  const { document } = parseHTML(renderAppHtml());
  for (const element of document.querySelectorAll("script, style")) element.remove();
  const sources = new Set<string>();
  const visit = (node: any) => {
    if (node.nodeType === 3) {
      const source = String(node.nodeValue || "").trim().replace(/\s+/gu, " ");
      if (/[\u3400-\u9fff]/u.test(source)) sources.add(source);
    }
    for (const child of node.childNodes || []) visit(child);
  };
  visit(document.body);
  for (const element of document.querySelectorAll("[aria-label], [placeholder], [title]")) {
    for (const attribute of ["aria-label", "placeholder", "title"]) {
      const source = element.getAttribute(attribute);
      if (source && /[\u3400-\u9fff]/u.test(source)) sources.add(source);
    }
  }
  const missing = [...sources].filter(source => !englishUiMessages[source]);
  assert.deepEqual(missing, []);
});
