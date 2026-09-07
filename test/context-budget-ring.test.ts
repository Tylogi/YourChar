import assert from "node:assert/strict";
import test from "node:test";
import { Script } from "node:vm";
import { renderAppHtml } from "../src/http/ui.js";

test("context budget is a quiet, accessible ring with bounded utilization and unchanged detail access", () => {
  const html = renderAppHtml();
  const button = html.match(/<button id="contextBudgetBtn"[\s\S]*?<\/button>/)![0];
  assert.match(button, /aria-haspopup="dialog" aria-controls="contextBudgetDialog"/);
  assert.match(button, /class="context-budget-ring"/);
  assert.doesNotMatch(button, /<span|data-lucide="gauge"/);
  assert.doesNotMatch(html, /id="contextBudgetTokens"|id="contextBudgetPercent"/);
  const source = html.match(/    function updateContextBudgetChrome\(\) \{[\s\S]*?(?=    function openContextBudgetDialog)/)![0];
  const attrs = new Map<string, string>();
  const nodes = {
    contextBudgetBtn: { hidden: true, disabled: false, title: "", dataset: { level: "" }, setAttribute: (key: string, value: string) => attrs.set(key, value) },
    contextBudgetRing: { setAttribute: (key: string, value: string) => attrs.set(key, value) },
  };
  const state = { uiMode: "normal", activeConversationKind: "direct", sessionDraft: false, activeSessionId: "example", contextCompacting: false,
    contextBudget: { remainingRatio: 0.75, remainingTokens: 7500, usedInputTokens: 2500, utilizationRatio: 0.25, level: "healthy" } };
  const context = { nodes, state, formatTokenCount: String };
  const update = () => new Script(source + "\nupdateContextBudgetChrome();").runInNewContext(context);
  update();
  assert.equal(nodes.contextBudgetBtn.hidden, false);
  assert.equal(attrs.get("stroke-dasharray"), "25.00 100");
  assert.match(attrs.get("aria-label")!, /查看上下文余量.*已用 25%.*7500 tokens（75%）/);
  for (const [ratio, dash, opacity] of [[0, "0.00 100", "0"], [1, "100.00 100", "1"], [2, "100.00 100", "1"], [-1, "0.00 100", "0"], [NaN, "0.00 100", "0"]] as const) {
    state.contextBudget.utilizationRatio = ratio; update();
    assert.equal(attrs.get("stroke-dasharray"), dash);
    assert.equal(attrs.get("opacity"), opacity);
  }
  state.contextBudget.level = "warning"; update();
  assert.equal(nodes.contextBudgetBtn.dataset.level, "warning");
  state.contextCompacting = true; update();
  assert.equal(nodes.contextBudgetBtn.disabled, true);
  state.activeConversationKind = "world"; update();
  assert.equal(nodes.contextBudgetBtn.hidden, true);
});
