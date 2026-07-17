import assert from "node:assert/strict";
import test from "node:test";
import {
  hasLongRpSceneContinuity,
  longRpSceneForTurn,
  longRpSceneTerms,
} from "../src/evaluation/long-eval-rules.js";

test("RP long evaluator accepts scene semantics without requiring the literal location", () => {
  const turn19 = [
    "林澈转身走向控制室中央那台外壳结满水珠的主发射器。",
    "他打开校准面板，盯住示波器上的频率波峰。",
  ].join("");

  assert.equal(hasLongRpSceneContinuity(turn19, "weather-station"), true);
  assert.equal(longRpSceneForTurn(19), "weather-station");
  assert.ok(longRpSceneTerms("weather-station").includes("控制室"));
  assert.ok(longRpSceneTerms("weather-station").includes("发射器"));
});

test("RP long evaluator rejects text that only matches another scene", () => {
  const archiveOnly = "地下档案库的防火门合拢，林澈翻开失踪记录。";
  const dockOnly = "潮水拍打旧码头，失联引航员的灯在栈桥下闪烁。";

  assert.equal(hasLongRpSceneContinuity(archiveOnly, "weather-station"), false);
  assert.equal(hasLongRpSceneContinuity(dockOnly, "weather-station"), false);
  assert.equal(hasLongRpSceneContinuity(archiveOnly, "archive"), true);
  assert.equal(hasLongRpSceneContinuity(dockOnly, "dock"), true);
});
