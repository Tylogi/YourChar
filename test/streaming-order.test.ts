import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { anchorStreamingReplies, streamingOrderScript } from "../src/http/streaming-order.js";
import { renderAppHtml } from "../src/http/ui.js";

type Message = { role: string; id: string; burstId?: string; inboxBurstId?: string; timestampMs?: number; entryId?: string; replyToEntryId?: string };
const ids = (messages: Message[]) => messages.map(message => message.id);

test("a reply follows its input even when its provisional timestamp sorts before the persisted user", () => {
  const input: Message[] = [
    { id: "earlier", role: "assistant" },
    { id: "reply", role: "assistant", burstId: "burst", timestampMs: 1 },
    { id: "input", role: "user", inboxBurstId: "burst", timestampMs: 2263 },
    { id: "next", role: "user", timestampMs: 2500 },
  ];
  const snapshot = structuredClone(input);
  const ordered = anchorStreamingReplies(input);
  assert.deepEqual(ids(ordered), ["earlier", "input", "reply", "next"]);
  assert.deepEqual(input, snapshot, "never rewrite a message timestamp or mutate the source list");
  assert.equal(ordered[2], input[1], "preserve the streaming object and its progress");
  assert.deepEqual(anchorStreamingReplies(ordered), ordered);
});

test("continuous messages anchor after the last member, before a later queued burst", () => {
  const input: Message[] = [
    { id: "first", role: "user", inboxBurstId: "one" },
    { id: "reply-one", role: "assistant", burstId: "one" },
    { id: "interaction", role: "interaction" },
    { id: "second", role: "user", inboxBurstId: "one" },
    { id: "reply-two", role: "system", burstId: "two" },
    { id: "next", role: "user", inboxBurstId: "two" },
  ];
  assert.deepEqual(ids(anchorStreamingReplies(input)), ["first", "interaction", "second", "reply-one", "next", "reply-two"]);
});

test("historical replies and unanchored bursts retain their original order", () => {
  const input: Message[] = [
    { id: "history", role: "assistant" },
    { id: "unloaded-input-reply", role: "assistant", burstId: "outside-window" },
    { id: "user", role: "user", inboxBurstId: "other" },
    { id: "final", role: "assistant" },
  ];
  assert.deepEqual(anchorStreamingReplies(input), input);
});

test("persisted replies keep their transcript parent when completion timestamps change", () => {
  for (const timestampMs of [-1000, 10000]) {
    const input: Message[] = [
      { id: "user", entryId: "user", role: "user", timestampMs: 2000 },
      { id: "queued-next", role: "user", timestampMs: 5000 },
      { id: "final", entryId: "final", role: "assistant", replyToEntryId: "user", timestampMs },
    ].sort((a, b) => a.timestampMs! - b.timestampMs!);
    assert.deepEqual(ids(anchorStreamingReplies(input)), ["user", "final", "queued-next"]);
  }
});

test("the actual UI merge pipeline stays ordered across polling, stream snapshots and finalization", () => {
  const html = renderAppHtml();
  const names = ["normalizeStoredMessage", "normalizeInboxMessage", "mergePrivateInboxMessages", "preserveActiveBurstMessages",
    "mergeInteractionEvents", "mergeCharacterCollaborations", "privateBurstPlaceholder", "syncPrivateInboxUserBubble"];
  const functions = names.map(name => {
    const start = html.indexOf("    function " + name + "(");
    const end = html.indexOf("\n    function ", start + 1);
    assert.ok(start >= 0 && end > start);
    return html.slice(start, end);
  }).join("\n");
  const context = vm.createContext({ state: { messages: [] },
    extractMessagePresentation: (text: string) => ({ text, attachments: [] }),
    normalizeStructuredAttachments: () => [], mergeMessageAttachments: () => [],
  });
  vm.runInContext(streamingOrderScript + "\n" + functions, context);
  const result = vm.runInContext(`(() => {
    const createdAt = "2026-09-08T08:00:00.000Z"; const t = Date.parse(createdAt);
    const inbox = [{id:"i1",clientMessageId:"client1",burstId:"b1",status:"processing",text:"测试输入",createdAt}];
    const rawUser = {role:"user",content:"测试输入",timestamp:t+2263,entryId:"u1"};
    state.messages = [normalizeInboxMessage(inbox[0]),privateBurstPlaceholder("b1",createdAt)];
    state.messages[1].text = "生成中的回复";
    const orders = [state.messages.map(m=>m.role)];
    for (let round=0; round<3; round++) {
      state.messages = mergeCharacterCollaborations(mergeInteractionEvents(preserveActiveBurstMessages(
        mergePrivateInboxMessages([normalizeStoredMessage(rawUser)],inbox),inbox),[]),[]);
      orders.push(state.messages.map(m=>m.role));
      syncPrivateInboxUserBubble(inbox[0]);
      state.messages = mergeCharacterCollaborations(state.messages,[]);
      orders.push(state.messages.map(m=>m.role));
    }
    state.messages = mergeCharacterCollaborations([
      normalizeStoredMessage(rawUser),normalizeStoredMessage({role:"assistant",content:"完整回复",timestamp:t+10000,entryId:"a1"})
    ],[]);
    orders.push(state.messages.map(m=>m.role)); return orders;
  })()`, context);
  for (const order of JSON.parse(JSON.stringify(result))) assert.deepEqual(order, ["user", "assistant"]);
});
