import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHttpServer } from "../src/http/router.js";
import { createTestRuntime } from "../src/testing/index.js";

test("recurring user schedules become reversible profile insights", () => {
  const runtime = createTestRuntime({
    now: "2026-07-20T01:00:00.000Z",
    seed: "user-insight-recurring",
  });
  try {
    runtime.kernel.patchAgentPermissions({ realityMemoryWriteEnabled: true });
    const created = runtime.kernel.createScheduleItem({
      kind: "event",
      title: "课题组组会",
      startAt: "2026-07-21T01:00:00.000Z",
      timezone: "Asia/Shanghai",
      recurrenceRule: "FREQ=WEEKLY",
      ownerType: "user",
    });

    const status = runtime.kernel.getUserInsightStatus();
    assert.equal(status.observationCount, 1);
    assert.equal(status.promotedCount, 1);
    assert.equal(status.recentObservations[0].decision, "promoted");
    assert.match(runtime.kernel.getUserProfile().markdown, /每周.*课题组组会/);
    runtime.kernel.updateUserProfileManual("# 用户画像\n\n- 手写内容保留\n");
    assert.match(runtime.kernel.getUserProfile().markdown, /手写内容保留/);
    assert.match(runtime.kernel.getUserProfile().markdown, /每周.*课题组组会/);
    assert.equal(
      runtime.kernel.listMemories({ realm: "reality", validity: "active" })
        .filter((memory) => memory.tags.includes("user-insight")).length,
      1,
    );

    runtime.kernel.updateScheduleItem(created.item.id, { recurrenceRule: "FREQ=DAILY" });
    assert.match(runtime.kernel.getUserProfile().markdown, /每天.*课题组组会/);
    assert.doesNotMatch(runtime.kernel.getUserProfile().markdown, /每周.*课题组组会/);

    const conflicting = runtime.kernel.createScheduleItem({
      kind: "event",
      title: "课题组组会",
      startAt: "2026-07-22T01:00:00.000Z",
      timezone: "Asia/Shanghai",
      recurrenceRule: "FREQ=WEEKLY",
      ownerType: "user",
    });
    assert.doesNotMatch(runtime.kernel.getUserProfile().markdown, /课题组组会/);
    assert.equal(
      runtime.kernel.getUserInsightStatus().recentObservations
        .filter((entry) => entry.claimText.includes("课题组组会") && entry.decision === "conflicted").length,
      2,
    );

    runtime.kernel.cancelScheduleItem(conflicting.item.id);
    assert.match(runtime.kernel.getUserProfile().markdown, /每天.*课题组组会/);

    runtime.kernel.cancelScheduleItem(created.item.id);
    assert.doesNotMatch(runtime.kernel.getUserProfile().markdown, /课题组组会/);
    assert.match(runtime.kernel.getUserProfile().markdown, /手写内容保留/);
    assert.equal(runtime.kernel.getUserInsightStatus().recentObservations[0].decision, "retracted");
    assert.equal(
      runtime.kernel.listMemories({ realm: "reality", validity: "active" })
        .filter((memory) => memory.tags.includes("user-insight")).length,
      0,
    );
  } finally {
    runtime.dispose();
  }
});

test("one-off, sensitive, and character schedules do not enter the user profile", () => {
  const runtime = createTestRuntime({
    now: "2026-07-20T01:00:00.000Z",
    seed: "user-insight-boundaries",
  });
  try {
    runtime.kernel.patchAgentPermissions({ realityMemoryWriteEnabled: true });
    runtime.kernel.createScheduleItem({
      kind: "task",
      title: "寄快递",
      timezone: "Asia/Shanghai",
      ownerType: "user",
    });
    runtime.kernel.createScheduleItem({
      kind: "event",
      title: "心理咨询",
      startAt: "2026-07-21T02:00:00.000Z",
      timezone: "Asia/Shanghai",
      recurrenceRule: "FREQ=WEEKLY",
      ownerType: "user",
    });
    const character = runtime.kernel.createCharacter({ name: "助手" });
    runtime.kernel.createScheduleItem({
      kind: "event",
      title: "角色每周读书会",
      startAt: "2026-07-21T03:00:00.000Z",
      timezone: "Asia/Shanghai",
      recurrenceRule: "FREQ=WEEKLY",
      ownerType: "character",
      characterId: character.id,
    });

    const observations = runtime.kernel.getUserInsightStatus().recentObservations;
    assert.equal(observations.length, 2);
    assert.deepEqual(
      new Set(observations.map((entry) => entry.decision)),
      new Set(["context_only", "blocked_sensitive"]),
    );
    assert.ok(observations.every((entry) => !entry.claimText.includes("心理咨询")));
    const profile = runtime.kernel.getUserProfile().markdown;
    assert.doesNotMatch(profile, /寄快递|心理咨询|角色每周读书会/);
    assert.equal(runtime.kernel.listMemories({ realm: "reality", validity: "active" }).length, 0);
  } finally {
    runtime.dispose();
  }
});

test("automatically withdrawn schedule evidence can become eligible again", () => {
  const runtime = createTestRuntime({
    now: "2026-07-20T01:00:00.000Z",
    seed: "user-insight-reactivation",
  });
  try {
    runtime.kernel.patchAgentPermissions({ realityMemoryWriteEnabled: true });
    const schedule = runtime.kernel.createScheduleItem({
      kind: "event",
      title: "每周技术阅读",
      startAt: "2026-07-21T01:00:00.000Z",
      timezone: "Asia/Shanghai",
      recurrenceRule: "FREQ=WEEKLY",
      ownerType: "user",
    });
    assert.match(runtime.kernel.getUserProfile().markdown, /每周技术阅读/);

    runtime.kernel.updateScheduleItem(schedule.item.id, { notes: "银行卡验证码 123456" });
    assert.doesNotMatch(runtime.kernel.getUserProfile().markdown, /每周技术阅读/);
    assert.equal(runtime.kernel.getUserInsightStatus().recentObservations[0].decision, "blocked_sensitive");

    runtime.kernel.updateScheduleItem(schedule.item.id, { notes: "" });
    assert.match(runtime.kernel.getUserProfile().markdown, /每周技术阅读/);
    assert.equal(runtime.kernel.getUserInsightStatus().recentObservations[0].decision, "promoted");
  } finally {
    runtime.dispose();
  }
});

test("repeated completions need three local dates spanning seven days", () => {
  const runtime = createTestRuntime({
    now: "2026-07-01T01:00:00.000Z",
    seed: "user-insight-completions",
  });
  try {
    runtime.kernel.patchAgentPermissions({ realityMemoryWriteEnabled: true });
    const complete = () => {
      const task = runtime.kernel.createScheduleItem({
        kind: "task",
        title: "整理实验记录",
        timezone: "Asia/Shanghai",
        ownerType: "user",
      });
      runtime.kernel.completeScheduleItem(task.item.id);
    };

    complete();
    runtime.clock.advance(3 * 24 * 60 * 60_000);
    complete();
    assert.doesNotMatch(runtime.kernel.getUserProfile().markdown, /整理实验记录/);

    runtime.clock.advance(5 * 24 * 60 * 60_000);
    complete();
    assert.match(runtime.kernel.getUserProfile().markdown, /多个日期完成了.*整理实验记录/);
    assert.equal(runtime.kernel.getUserInsightStatus().promotedCount, 3);
  } finally {
    runtime.dispose();
  }
});

test("five matching reminder snoozes become a bounded preference insight", () => {
  const runtime = createTestRuntime({
    now: "2026-07-20T01:00:00.000Z",
    seed: "user-insight-snooze",
  });
  try {
    runtime.kernel.patchAgentPermissions({ realityMemoryWriteEnabled: true });
    const reminder = runtime.kernel.createScheduleItem({
      kind: "reminder",
      title: "起来活动",
      startAt: "2026-07-20T02:00:00.000Z",
      timezone: "Asia/Shanghai",
      ownerType: "user",
    });
    let occurrenceId = reminder.occurrence!.id;
    for (let index = 0; index < 5; index += 1) {
      occurrenceId = runtime.kernel.snoozeReminder(occurrenceId, 10).id;
      runtime.clock.advance(60_000);
    }

    assert.match(runtime.kernel.getUserProfile().markdown, /多次选择将提醒延后 10 分钟/);
    const snoozes = runtime.kernel.getUserInsightStatus().recentObservations
      .filter((entry) => entry.kind === "reminder_snooze");
    assert.equal(snoozes.length, 5);
    assert.ok(snoozes.every((entry) => entry.decision === "promoted"));
  } finally {
    runtime.dispose();
  }
});

test("persisted insights reconcile idempotently and project after profile writes are re-enabled", () => {
  const root = mkdtempSync(join(tmpdir(), "rp-agent-user-insight-"));
  const stateDir = join(root, "state");
  try {
    const first = createTestRuntime({
      stateDir,
      now: "2026-07-20T01:00:00.000Z",
      seed: "user-insight-restart-first",
    });
    first.kernel.patchAgentPermissions({
      realityMemoryWriteEnabled: true,
      userProfileWriteEnabled: false,
    });
    first.kernel.createScheduleItem({
      kind: "event",
      title: "每周论文讨论",
      startAt: "2026-07-21T01:00:00.000Z",
      timezone: "Asia/Shanghai",
      recurrenceRule: "FREQ=WEEKLY",
      ownerType: "user",
    });
    assert.doesNotMatch(first.kernel.getUserProfile().markdown, /每周论文讨论/);
    first.kernel.patchAgentPermissions({ userProfileWriteEnabled: true });
    assert.match(first.kernel.getUserProfile().markdown, /每周论文讨论/);
    first.dispose();

    const second = createTestRuntime({
      stateDir,
      now: "2026-07-20T01:05:00.000Z",
      seed: "user-insight-restart-second",
    });
    try {
      assert.equal(second.kernel.getUserInsightStatus().observationCount, 1);
      assert.equal(
        second.kernel.listMemories({ realm: "reality", validity: "active" })
          .filter((memory) => memory.tags.includes("user-insight")).length,
        1,
      );
      assert.match(second.kernel.getUserProfile().markdown, /每周论文讨论/);
    } finally {
      second.dispose();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manual correction and archive prevent automatic insight recreation", () => {
  const runtime = createTestRuntime({
    now: "2026-07-20T01:00:00.000Z",
    seed: "user-insight-user-control",
  });
  try {
    runtime.kernel.patchAgentPermissions({ realityMemoryWriteEnabled: true });
    runtime.kernel.createScheduleItem({
      kind: "event",
      title: "研究进展同步",
      startAt: "2026-07-21T01:00:00.000Z",
      timezone: "Asia/Shanghai",
      recurrenceRule: "FREQ=WEEKLY",
      ownerType: "user",
    });
    const generated = runtime.kernel.listMemories({ realm: "reality", validity: "active" })
      .find((memory) => memory.tags.includes("user-insight"))!;
    const corrected = runtime.kernel.correctMemory(generated.id, {
      content: "用户手动确认：研究进展同步的频率会按项目阶段调整。",
    }).memory;

    runtime.kernel.userInsightCoordinator.reconcile();
    runtime.kernel.userInsightCoordinator.reconcile();
    assert.equal(runtime.kernel.memoryLifecycle.get(corrected.id).validity, "active");
    assert.ok(runtime.kernel.memoryLifecycle.get(corrected.id).tags.includes("user-corrected"));
    assert.match(runtime.kernel.getUserProfile().markdown, /频率会按项目阶段调整/);
    assert.ok(runtime.kernel.getUserInsightStatus().recentObservations.some((entry) =>
      entry.claimText.includes("研究进展同步") && entry.decision === "user_blocked"
    ));

    runtime.kernel.createScheduleItem({
      kind: "event",
      title: "周末复盘",
      startAt: "2026-07-25T01:00:00.000Z",
      timezone: "Asia/Shanghai",
      recurrenceRule: "FREQ=WEEKLY",
      ownerType: "user",
    });
    const archived = runtime.kernel.listMemories({ realm: "reality", validity: "active" })
      .find((memory) => memory.content.includes("周末复盘"))!;
    runtime.kernel.archiveMemory(archived.id);
    runtime.kernel.userInsightCoordinator.reconcile();
    runtime.kernel.userInsightCoordinator.reconcile();
    assert.doesNotMatch(runtime.kernel.getUserProfile().markdown, /周末复盘/);
    assert.equal(runtime.kernel.listMemories({ realm: "reality", validity: "active" })
      .filter((memory) => memory.content.includes("周末复盘")).length, 0);
    assert.ok(runtime.kernel.getUserInsightStatus().recentObservations.some((entry) =>
      entry.claimText.includes("周末复盘") && entry.decision === "user_blocked"
    ));

    runtime.kernel.createScheduleItem({
      kind: "event",
      title: "周末复盘",
      startAt: "2026-07-26T01:00:00.000Z",
      timezone: "Asia/Shanghai",
      recurrenceRule: "FREQ=WEEKLY",
      ownerType: "user",
    });
    assert.equal(runtime.kernel.listMemories({ realm: "reality", validity: "active" })
      .filter((memory) => memory.content.includes("周末复盘")).length, 0);
    assert.equal(runtime.kernel.getUserInsightStatus().recentObservations
      .filter((entry) => entry.claimText.includes("周末复盘") && entry.decision === "user_blocked").length, 2);
  } finally {
    runtime.dispose();
  }
});

test("promoted schedule insight enters a later SMS context and is included in export deletion", async () => {
  const runtime = createTestRuntime({
    now: "2026-07-20T01:00:00.000Z",
    seed: "user-insight-context",
  });
  try {
    runtime.kernel.patchAgentPermissions({ realityMemoryWriteEnabled: true });
    runtime.kernel.createScheduleItem({
      kind: "event",
      title: "课题组固定例会",
      startAt: "2026-07-21T01:00:00.000Z",
      timezone: "Asia/Shanghai",
      recurrenceRule: "FREQ=WEEKLY",
      ownerType: "user",
    });
    const character = runtime.kernel.createCharacter({ name: "日程助手" });
    runtime.model.enqueue([{ kind: "assistant_text", text: "你的日历里记录为每周安排。" }]);
    await runtime.kernel.sendMessage("user-insight-context-session", {
      mode: "sms",
      characterId: character.id,
      text: "我的课题组固定例会是什么频率？",
      timezone: "Asia/Shanghai",
    });

    assert.match(JSON.stringify(runtime.model.requests.at(-1)?.providerPayload), /每周.*课题组固定例会/);
    const exported = await runtime.kernel.exportUserData();
    assert.equal(exported.userInsights.observationCount, 1);
    assert.equal(exported.userInsights.promotedCount, 1);

    await runtime.kernel.deleteAllUserData();
    assert.equal(runtime.kernel.getUserInsightStatus().observationCount, 0);
    assert.equal(runtime.kernel.listMemories({ realm: "reality" }).length, 0);
  } finally {
    runtime.dispose();
  }
});

test("profile HTTP edits preserve the managed insight projection", async () => {
  const runtime = createTestRuntime({
    now: "2026-07-20T01:00:00.000Z",
    seed: "user-insight-profile-http",
  });
  const server = createHttpServer({ kernel: runtime.kernel });
  try {
    runtime.kernel.patchAgentPermissions({ realityMemoryWriteEnabled: true });
    runtime.kernel.createScheduleItem({
      kind: "event",
      title: "每周架构复盘",
      startAt: "2026-07-21T01:00:00.000Z",
      timezone: "Asia/Shanghai",
      recurrenceRule: "FREQ=WEEKLY",
      ownerType: "user",
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const initial = await (await fetch(`${baseUrl}/api/v1/user-profile`)).json() as {
      profile: { markdown: string };
      manualMarkdown: string;
    };
    assert.match(initial.profile.markdown, /每周架构复盘/);
    assert.doesNotMatch(initial.manualMarkdown, /每周架构复盘/);

    const response = await fetch(`${baseUrl}/api/v1/user-profile`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown: "# 用户画像\n\n- 手写 API 内容\n" }),
    });
    assert.equal(response.status, 200);
    const updated = await response.json() as {
      profile: { markdown: string };
      manualMarkdown: string;
    };
    assert.match(updated.profile.markdown, /手写 API 内容/);
    assert.match(updated.profile.markdown, /每周架构复盘/);
    assert.doesNotMatch(updated.manualMarkdown, /每周架构复盘/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.dispose();
  }
});

test("completed SMS disclosures use exact-quote observations and reversible profile projection", async () => {
  const runtime = createTestRuntime({
    now: "2026-07-20T01:00:00.000Z",
    seed: "user-insight-conversation",
    memoryExtractor: async (input) => ({
      candidates: [{
        type: "person",
        key: "person.pet.cat",
        content: "用户养了一只名为糯米的猫。",
        salience: 0.8,
        confidence: 0.97,
        tags: ["宠物", "家人"],
        evidence: { user: "我的猫叫糯米" },
      }],
    }),
  });
  try {
    runtime.kernel.patchAgentPermissions({ realityMemoryWriteEnabled: true });
    const character = runtime.kernel.createCharacter({ name: "知心朋友" });
    runtime.model.enqueue([{ kind: "assistant_text", text: "糯米，名字很好记。" }]);
    await runtime.kernel.sendMessage("conversation-insight-session", {
      mode: "sms",
      characterId: character.id,
      text: "我的猫叫糯米，平时很黏人。",
    });
    await runtime.kernel.memoryCoordinator.drain();

    const status = runtime.kernel.getUserInsightStatus();
    const observation = status.recentObservations.find((entry) => entry.sourceType === "conversation");
    assert.ok(observation);
    assert.equal(observation.kind, "conversation_statement");
    assert.equal(observation.claimText, "我的猫叫糯米");
    assert.equal(observation.evidence.exactUserQuote, "我的猫叫糯米");
    assert.equal(observation.decision, "promoted");
    assert.match(runtime.kernel.getUserProfile().markdown, /我的猫叫糯米/);

    runtime.kernel.rejectUserInsight(observation.id);
    assert.doesNotMatch(runtime.kernel.getUserProfile().markdown, /我的猫叫糯米/);
    assert.equal(runtime.kernel.getUserInsightStatus().recentObservations[0].decision, "user_blocked");

    runtime.kernel.unlockUserInsight(observation.id);
    assert.match(runtime.kernel.getUserProfile().markdown, /我的猫叫糯米/);
    assert.equal(runtime.kernel.getUserInsightStatus().recentObservations[0].decision, "promoted");
  } finally {
    runtime.dispose();
  }
});

test("conversation insight controls are exposed over HTTP and sensitive quotes stay out", async () => {
  const runtime = createTestRuntime({
    now: "2026-07-20T01:00:00.000Z",
    seed: "user-insight-conversation-http",
    memoryExtractor: async (input) => ({
      candidates: [{
        type: "user_fact",
        key: "user.private.bank",
        content: "sensitive",
        confidence: 0.99,
        evidence: { user: input.userText },
      }],
    }),
  });
  const server = createHttpServer({ kernel: runtime.kernel });
  try {
    runtime.kernel.patchAgentPermissions({ realityMemoryWriteEnabled: true });
    const character = runtime.kernel.createCharacter({ name: "边界助手" });
    runtime.model.enqueue([{ kind: "assistant_text", text: "这类信息不应被长期保存。" }]);
    await runtime.kernel.sendMessage("sensitive-conversation-insight", {
      mode: "sms",
      characterId: character.id,
      text: "我的银行卡验证码是 123456",
    });
    await runtime.kernel.memoryCoordinator.drain();
    assert.equal(runtime.kernel.getUserInsightStatus().observationCount, 0);
    assert.doesNotMatch(runtime.kernel.getUserProfile().markdown, /123456|银行卡/);

    const schedule = runtime.kernel.createScheduleItem({
      kind: "event",
      title: "每周写作复盘",
      startAt: "2026-07-21T01:00:00.000Z",
      timezone: "Asia/Shanghai",
      recurrenceRule: "FREQ=WEEKLY",
      ownerType: "user",
    });
    const observation = runtime.kernel.getUserInsightStatus().recentObservations.find((entry) =>
      entry.sourceId === schedule.item.id
    );
    assert.ok(observation);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const rejected = await fetch(`${baseUrl}/api/v1/user-insights/${observation.id}/reject`, { method: "POST" });
    assert.equal(rejected.status, 200);
    assert.equal(((await rejected.json()) as { observation: { decision: string } }).observation.decision, "user_blocked");
    const unlocked = await fetch(`${baseUrl}/api/v1/user-insights/${observation.id}/unlock`, { method: "POST" });
    assert.equal(unlocked.status, 200);
    assert.equal(((await unlocked.json()) as { observation: { decision: string } }).observation.decision, "promoted");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.dispose();
  }
});
