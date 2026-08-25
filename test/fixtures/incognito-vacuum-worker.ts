import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { IncognitoSessionManager } from "../../src/incognito/session-manager.js";
import { AppDatabase } from "../../src/storage/database.js";

const mode = (workerData as { mode?: unknown } | undefined)?.mode;
if (mode !== "control" && mode !== "incognito") {
  throw new Error("vacuum fixture mode must be control or incognito");
}

const stateDir = mkdtempSync(join(tmpdir(), "yourchar-incognito-vacuum-source-"));
const database = new AppDatabase(join(stateDir, "rp-agent.sqlite"));
let manager: IncognitoSessionManager | undefined;
try {
  database.connection.exec(`
    CREATE TABLE incognito_vacuum_fixture(
      id INTEGER PRIMARY KEY,
      conversation_space TEXT NOT NULL,
      payload BLOB NOT NULL
    )
  `);
  const insert = database.connection.prepare(`
    INSERT INTO incognito_vacuum_fixture(conversation_space, payload)
    VALUES (?, zeroblob(524288))
  `);
  database.connection.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < 256; index += 1) {
      insert.run(index % 2 === 0 ? "secret" : "normal");
    }
    database.connection.exec("COMMIT");
  } catch (error) {
    database.connection.exec("ROLLBACK");
    throw error;
  }

  parentPort?.postMessage({ type: "observe" });
  await new Promise<void>((resolve) => {
    parentPort?.once("message", (message) => {
      if (message !== "start") throw new Error("vacuum fixture expected a start acknowledgement");
      resolve();
    });
  });
  if (mode === "control") {
    database.connection.exec("PRAGMA journal_mode = DELETE");
    database.connection.exec(
      "DELETE FROM incognito_vacuum_fixture WHERE conversation_space = 'secret'",
    );
    database.connection.exec("VACUUM");
  } else {
    manager = new IncognitoSessionManager({
      sourceStateDir: stateDir,
      sourceDatabase: database.connection,
      listSourceMetadata: () => [],
      listNormalSkillPackages: () => [],
      withSnapshotLock: (_sessionId, operation) => operation(),
      createChild: () => fakeChildKernel() as never,
    });
    const conversation = await manager.open("vacuum-fixture-character");
    await manager.close(conversation.id);
  }
  parentPort?.postMessage({ type: "done" });
} finally {
  try {
    manager?.dispose();
  } finally {
    database.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

function fakeChildKernel() {
  const now = "2026-08-20T00:00:00.000Z";
  const metadata = {
    id: "vacuum-fixture-child",
    mode: "sms" as const,
    conversationSpace: "normal" as const,
    characterId: "vacuum-fixture-character",
    canonicalDirect: true,
    createdAt: now,
    updatedAt: now,
  };
  return {
    openCanonicalPrivateConversation: async () => metadata,
    listConversationMetadata: () => [metadata],
    getSession: async () => ({ id: metadata.id, messages: [], createdAt: now, updatedAt: now }),
    getConversationTranscript: async () => [],
    sendMessage: async () => ({
      reply: "fixture",
      actions: [],
      events: [],
      status: "completed" as const,
      messageType: "assistant" as const,
      canRetry: false,
    }),
    streamMessage: async () => ({
      reply: "fixture",
      actions: [],
      events: [],
      status: "completed" as const,
      messageType: "assistant" as const,
      canRetry: false,
    }),
    cancelMessage: async () => false,
    getConversationContextBudget: async () => ({ sessionId: metadata.id }),
    compactConversationContext: async () => ({ compacted: false, reason: "fixture" }),
    getConversationInteraction: () => ({
      state: {
        sessionId: metadata.id,
        characterId: metadata.characterId,
        conversationSpace: "normal" as const,
        continuity: "canonical" as const,
        presence: "remote" as const,
        narrativeLens: "message" as const,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      },
      events: [],
      canUndo: false,
      suggestedLocations: [],
      liveState: { presence: "remote" as const, updatedAt: now },
    }),
    transitionConversationInteraction: async () => ({
      state: {
        sessionId: metadata.id,
        characterId: metadata.characterId,
        conversationSpace: "normal" as const,
        continuity: "canonical" as const,
        presence: "remote" as const,
        narrativeLens: "message" as const,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      },
      events: [],
      canUndo: false,
      suggestedLocations: [],
      liveState: { presence: "remote" as const, updatedAt: now },
    }),
    dispose: () => undefined,
  };
}
