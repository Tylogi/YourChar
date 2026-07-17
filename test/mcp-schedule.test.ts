import assert from "node:assert/strict";
import test from "node:test";
import { VirtualClock } from "../src/app/clock.js";
import { CompanionKernel } from "../src/domain/index.js";
import { createScheduleMcpBridge } from "../src/mcp/index.js";
import type { ActionRecord } from "../src/domain/types.js";

test("schedule MCP server exposes and executes tools over JSON-RPC", async () => {
  const clock = new VirtualClock("2026-07-14T09:00:00.000Z");
  const kernel = new CompanionKernel({ stateDir: false, clock, startScheduler: false });
  const character = kernel.createCharacter({ name: "MCP 日程角色" });
  let actions: ActionRecord[] = [];
  const bridge = await createScheduleMcpBridge({
    scheduleService: kernel.scheduleService,
    store: kernel.store,
    clock,
    sessionId: "mcp-contract",
    characterId: character.id,
    actions: () => actions,
  });
  try {
    const listing = await bridge.client.listTools();
    assert.ok(listing.tools.some((tool) => tool.name === "create_schedule_item"));
    assert.ok(
      listing.tools
        .find((tool) => tool.name === "create_schedule_item")
        ?.inputSchema.properties?.timeExpression,
    );

    const response = await bridge.client.callTool({
      name: "create_schedule_item",
      arguments: {
        kind: "reminder",
        title: "喝水",
        timeExpression: "五分钟后",
        startAt: "2099-01-01T00:00:00.000Z",
        timezone: "Asia/Shanghai",
      },
      _meta: { "rp-agent/tool-call-id": "contract-call-1" },
    });

    assert.equal(response.isError, undefined);
    assert.equal(kernel.listScheduleItems()[0].startAt, "2026-07-14T09:05:00.000Z");
    assert.equal(kernel.listScheduleItems()[0].sourceSessionId, "mcp-contract");
    assert.equal(actions[0].payload.transport, "mcp");
    assert.equal(actions[0].payload.timeSource, "timeExpression");
    assert.equal(actions[0].payload.ignoredStartAt, true);

    const duplicate = await bridge.client.callTool({
      name: "create_schedule_item",
      arguments: {
        kind: "reminder",
        title: "喝水",
        timeExpression: "五分钟后",
        startAt: "2099-01-01T00:00:00.000Z",
        timezone: "Asia/Shanghai",
      },
      _meta: { "rp-agent/tool-call-id": "contract-call-duplicate" },
    });
    assert.equal(duplicate.isError, undefined);
    assert.equal(kernel.listScheduleItems().length, 1);
    assert.equal(actions.length, 1);

    actions = [];
    await bridge.client.callTool({
      name: "create_schedule_item",
      arguments: {
        kind: "reminder",
        title: "喝水",
        timeExpression: "五分钟后",
        timezone: "Asia/Shanghai",
      },
      _meta: { "rp-agent/tool-call-id": "contract-call-next-turn" },
    });
    assert.equal(kernel.listScheduleItems().length, 2);
    assert.equal(actions.length, 1);

    actions = [];
    const characterEvent = await bridge.client.callTool({
      name: "create_schedule_item",
      arguments: {
        calendar: "character",
        kind: "event",
        title: "角色自己的实验安排",
        timeExpression: "十分钟后",
        timezone: "Asia/Shanghai",
      },
      _meta: { "rp-agent/tool-call-id": "character-calendar-call" },
    });
    assert.equal(characterEvent.isError, undefined);
    const characterItems = kernel.listScheduleItems({ ownerType: "character", characterId: character.id });
    assert.equal(characterItems.length, 1);
    assert.equal(characterItems[0].title, "角色自己的实验安排");

    const listedCharacter = await bridge.client.callTool({
      name: "list_schedule_items",
      arguments: { calendar: "character" },
    });
    assert.match(JSON.stringify(listedCharacter.content), /角色自己的实验安排/);
    assert.doesNotMatch(JSON.stringify(listedCharacter.content), /喝水/);

    const invalidCharacterReminder = await bridge.client.callTool({
      name: "create_schedule_item",
      arguments: {
        calendar: "character",
        kind: "reminder",
        title: "不应创建现实通知",
        timeExpression: "十五分钟后",
      },
    });
    assert.equal(invalidCharacterReminder.isError, true);
  } finally {
    await bridge.close();
    kernel.dispose();
  }
});
