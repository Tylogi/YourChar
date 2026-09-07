import assert from "node:assert/strict";
import test from "node:test";
import { Script } from "node:vm";
import { appearanceBootstrap } from "../src/http/ui-appearance.js";
import { renderAppHtml } from "../src/http/ui.js";

test("appearance is applied before styles, follows system changes and safely persists explicit choices", () => {
  const html = renderAppHtml();
  assert.ok(html.indexOf(appearanceBootstrap) < html.indexOf("<style>"));
  assert.match(html, /id="appearanceSettingsTabBtn"/);
  for (const blocked of [false, true]) {
    const callbacks: Record<string, (event?: any) => void> = {};
    const stored = new Map<string, string>();
    const root = { dataset: { theme: "" }, style: { colorScheme: "" } };
    const media = { matches: true, addEventListener: (name: string, fn: () => void) => { callbacks[name] = fn; } };
    const window: Record<string, any> = { matchMedia: () => media, dispatchEvent() {}, addEventListener: (name: string, fn: () => void) => { callbacks[name] = fn; } };
    const context = { window, document: { documentElement: root, querySelector: () => ({ setAttribute() {} }) }, Event,
      localStorage: { getItem: (key: string) => { if (blocked) throw new Error("blocked"); return stored.get(key); }, setItem: (key: string, value: string) => { if (blocked) throw new Error("blocked"); stored.set(key, value); } } };
    new Script(appearanceBootstrap).runInNewContext(context);
    const appearance = window.yourcharAppearance;
    assert.equal(root.dataset.theme, "dark");
    assert.equal(root.style.colorScheme, "dark");
    appearance.apply("light", true);
    callbacks.change();
    assert.equal(root.dataset.theme, "light", "manual choice overrides system");
    assert.equal(stored.get("yourchar.appearance"), blocked ? undefined : "light");
    appearance.apply("system", true);
    media.matches = false; callbacks.change();
    assert.equal(root.dataset.theme, "light");
    media.matches = true; callbacks.change();
    assert.equal(root.dataset.theme, "dark");
    callbacks.storage({ key: "yourchar.appearance", newValue: "light" });
    assert.equal(root.dataset.theme, "light");
    callbacks.storage({ key: "unrelated", newValue: "dark" });
    assert.equal(root.dataset.theme, "light");
    callbacks.storage({ key: null, newValue: null });
    assert.equal(appearance.preference, "system");
    appearance.apply('<img src=x>', true);
    assert.equal(appearance.preference, "system");
  }
});
