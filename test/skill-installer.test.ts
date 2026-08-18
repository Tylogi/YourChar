import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { strToU8, zipSync, type Zippable } from "fflate";
import {
  AgentSkillInstallerError,
  AgentSkillInstallerService,
  type AgentSkillInstallerOptions,
  type SkillInstallerTransport,
  type SkillInstallerTransportRequest,
} from "../src/modules/skill-installer.js";

const publicAddress = { address: "93.184.216.34", family: 4 as const };
const commit = "0123456789abcdef0123456789abcdef01234567";
const treeUrl = "https://github.com/MiniMax-AI/MiniMax-H3/tree/main/.claude/skills/h3-prompt-writing";
const genericUrl = "https://downloads.example.com/h3-skill.zip";
const skillMarkdown = [
  "---",
  "name: h3-prompt-writing",
  "description: Write reliable MiniMax H3 prompts.",
  "---",
  "",
  "# H3 Prompt Writing",
  "",
  "Use the bundled reference.",
  "",
].join("\n");

test("GitHub tree source resolves to an immutable commit, stages review metadata, publishes, and rolls back", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-skill-installer-"));
  const archive = githubArchive();
  const requests: Array<{ url: string; addresses: readonly { address: string; family: 4 | 6 }[] }> = [];
  const installer = createInstaller(stateDir, async (request) => {
    requests.push({ url: request.url.href, addresses: request.addresses });
    if (request.url.hostname === "api.github.com") {
      return jsonResponse({ sha: commit });
    }
    return zipResponse(archive);
  });
  try {
    const staged = await installer.stage({ sourceUrl: treeUrl });
    assert.match(staged.stageId, /^[0-9a-f-]{36}$/);
    assert.match(staged.digest, /^[0-9a-f]{64}$/);
    assert.match(staged.archiveSha256, /^[0-9a-f]{64}$/);
    assert.equal(staged.metadata.name, "h3-prompt-writing");
    assert.equal(staged.metadata.description, "Write reliable MiniMax H3 prompts.");
    assert.equal(staged.skillMarkdown, skillMarkdown);
    assert.deepEqual(staged.manifest.map((entry) => entry.path), [
      "SKILL.md",
      "references/base-en.txt",
      "references/ref-en.txt",
    ]);
    assert.deepEqual(staged.source, {
      requestedUrl: treeUrl,
      resolvedArchiveUrl: `https://codeload.github.com/MiniMax-AI/MiniMax-H3/zip/${commit}`,
      finalArchiveUrl: `https://codeload.github.com/MiniMax-AI/MiniMax-H3/zip/${commit}`,
      packagePath: ".claude/skills/h3-prompt-writing",
      requestedRef: "main",
      resolvedCommit: commit,
    });
    assert.deepEqual(requests.map((entry) => entry.url), [
      "https://api.github.com/repos/MiniMax-AI/MiniMax-H3/commits/main",
      `https://codeload.github.com/MiniMax-AI/MiniMax-H3/zip/${commit}`,
    ]);
    assert.ok(requests.every((entry) => entry.addresses[0]?.address === publicAddress.address));
    const quarantine = join(stateDir, "skill-installer-quarantine", `stage-${staged.stageId}`);
    assert.equal(statSync(quarantine).mode & 0o777, 0o700);
    assert.equal(statSync(join(quarantine, "package", "SKILL.md")).mode & 0o777, 0o600);

    assert.throws(
      () => installer.confirm({ stageId: staged.stageId, digest: "0".repeat(64) }),
      hasCode("STAGE_DIGEST_MISMATCH"),
    );
    const receipt = installer.confirm({ stageId: staged.stageId, digest: staged.digest });
    const target = join(stateDir, "skills", "h3-prompt-writing");
    assert.equal(existsSync(quarantine), false);
    assert.equal(statSync(target).mode & 0o777, 0o700);
    assert.equal(statSync(join(target, "SKILL.md")).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(target, "references", "base-en.txt"), "utf8"), "base prompt\n");
    installer.rollbackInstall(receipt);
    assert.equal(existsSync(target), false);
  } finally {
    installer.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("expectedSha256 binds the normalized selected package rather than the containing repository archive", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-skill-digest-"));
  const archive = githubArchive({ unrelatedBytes: 600_000, unrelatedArchive: true });
  const installer = createInstaller(stateDir, async (request) =>
    request.url.hostname === "api.github.com" ? jsonResponse({ sha: commit }) : zipResponse(archive));
  try {
    const first = await installer.stage({ sourceUrl: treeUrl });
    assert.equal(first.metadata.files, 3);
    assert.equal(first.manifest.some((entry) => entry.path.includes("unrelated")), false);
    assert.equal(installer.cancel({ stageId: first.stageId, digest: first.digest }), true);
    const second = await installer.stage({ sourceUrl: treeUrl, expectedSha256: first.digest });
    assert.equal(second.digest, first.digest);
    installer.cancel(second.stageId);
    await assert.rejects(
      installer.stage({ sourceUrl: treeUrl, expectedSha256: "f".repeat(64) }),
      hasCode("DIGEST_MISMATCH"),
    );
  } finally {
    installer.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("GitHub tree falls back from REST rate limiting to one immutable currentOid in the pinned page", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-skill-github-page-"));
  const requests: string[] = [];
  const installer = createInstaller(stateDir, async (request) => {
    requests.push(request.url.href);
    if (request.url.hostname === "api.github.com") {
      return { response: new Response("rate limited", { status: 403 }) };
    }
    if (request.url.hostname === "github.com") {
      return {
        response: new Response(
          `<html><script type="application/json">{"currentOid":"${commit}","currentOid":"${commit}"}</script></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        ),
      };
    }
    return zipResponse(githubArchive());
  });
  try {
    const staged = await installer.stage({ sourceUrl: treeUrl });
    assert.equal(staged.source.resolvedCommit, commit);
    assert.deepEqual(requests, [
      "https://api.github.com/repos/MiniMax-AI/MiniMax-H3/commits/main",
      treeUrl,
      `https://codeload.github.com/MiniMax-AI/MiniMax-H3/zip/${commit}`,
    ]);
    installer.cancel(staged.stageId);
  } finally {
    installer.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }

  const ambiguousDir = mkdtempSync(join(tmpdir(), "rp-agent-skill-github-page-ambiguous-"));
  const ambiguous = createInstaller(ambiguousDir, async (request) => {
    if (request.url.hostname === "api.github.com") {
      return { response: new Response("rate limited", { status: 403 }) };
    }
    return {
      response: new Response(
        `{"currentOid":"${commit}","currentOid":"${"f".repeat(40)}"}`,
        { headers: { "content-type": "text/html" } },
      ),
    };
  });
  try {
    await assert.rejects(ambiguous.stage({ sourceUrl: treeUrl }), hasCode("GITHUB_METADATA_INVALID"));
  } finally {
    ambiguous.dispose();
    rmSync(ambiguousDir, { recursive: true, force: true });
  }
});

test("source URL, every redirect, and every DNS answer fail closed before archive bytes are trusted", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-skill-network-"));
  let transportCalls = 0;
  const installer = new AgentSkillInstallerService({
    stateDir,
    resolveHostname: async (hostname) => hostname === "private.example.com"
      ? [{ address: "127.0.0.1", family: 4 }]
      : [publicAddress],
    transport: async () => {
      transportCalls += 1;
      return {
        response: new Response(null, {
          status: 302,
          headers: { location: "https://private.example.com/skill.zip" },
        }),
      };
    },
  });
  try {
    for (const sourceUrl of [
      "http://downloads.example.com/skill.zip",
      "https://user:secret@downloads.example.com/skill.zip",
      "https://downloads.example.com:444/skill.zip",
      "https://downloads.example.com/skill.zip?token=secret",
      "https://downloads.example.com/skill.zip#fragment",
      "https://localhost/skill.zip",
    ]) {
      await assert.rejects(installer.stage({ sourceUrl }), AgentSkillInstallerError);
    }
    assert.equal(transportCalls, 0);
    await assert.rejects(installer.stage({ sourceUrl: genericUrl }), hasCode("PRIVATE_ADDRESS"));
    assert.equal(transportCalls, 1, "redirect target is rejected before a second transport call");
  } finally {
    installer.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }

  const mixedStateDir = mkdtempSync(join(tmpdir(), "rp-agent-skill-mixed-dns-"));
  let mixedTransportCalled = false;
  const mixed = new AgentSkillInstallerService({
    stateDir: mixedStateDir,
    resolveHostname: async () => [publicAddress, { address: "10.0.0.2", family: 4 }],
    transport: async () => {
      mixedTransportCalled = true;
      return zipResponse(genericArchive());
    },
  });
  try {
    await assert.rejects(mixed.stage({ sourceUrl: genericUrl }), hasCode("PRIVATE_ADDRESS"));
    assert.equal(mixedTransportCalled, false);
  } finally {
    mixed.dispose();
    rmSync(mixedStateDir, { recursive: true, force: true });
  }
});

test("Clash Fake-IP is accepted only for exact GitHub hosts with a real public fallback", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-skill-github-fake-ip-"));
  const pinned: Array<readonly { address: string; family: 4 | 6 }[]> = [];
  const installer = new AgentSkillInstallerService({
    stateDir,
    resolveHostname: async () => [
      { address: "198.19.10.20", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ],
    transport: async (request) => {
      pinned.push(request.addresses);
      return request.url.hostname === "api.github.com"
        ? jsonResponse({ sha: commit })
        : zipResponse(githubArchive());
    },
  });
  try {
    const staged = await installer.stage({ sourceUrl: treeUrl });
    assert.equal(pinned.length, 2);
    assert.ok(pinned.every((answers) => answers[0]?.address === "198.19.10.20"));
    assert.ok(pinned.every((answers) => answers.some((answer) => answer.family === 6)));
    installer.cancel(staged.stageId);
  } finally {
    installer.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }

  for (const entry of [
    {
      label: "generic host",
      sourceUrl: genericUrl,
      answers: [
        { address: "198.18.1.2", family: 4 as const },
        publicAddress,
      ],
    },
    {
      label: "GitHub without public fallback",
      sourceUrl: treeUrl,
      answers: [{ address: "198.18.1.2", family: 4 as const }],
    },
    {
      label: "GitHub mixed with a private answer",
      sourceUrl: treeUrl,
      answers: [
        { address: "198.18.1.2", family: 4 as const },
        publicAddress,
        { address: "10.0.0.8", family: 4 as const },
      ],
    },
  ]) {
    const rejectedDir = mkdtempSync(join(tmpdir(), `rp-agent-skill-fake-ip-${entry.label.replace(/\W+/g, "-")}-`));
    let called = false;
    const rejected = new AgentSkillInstallerService({
      stateDir: rejectedDir,
      resolveHostname: async () => entry.answers,
      transport: async () => {
        called = true;
        return zipResponse(genericArchive());
      },
    });
    try {
      await assert.rejects(rejected.stage({ sourceUrl: entry.sourceUrl }), hasCode("PRIVATE_ADDRESS"));
      assert.equal(called, false, entry.label);
    } finally {
      rejected.dispose();
      rmSync(rejectedDir, { recursive: true, force: true });
    }
  }
});

test("archive extraction rejects traversal, portable collisions, links, nested archives, bombs, and invalid package roots", async () => {
  const cases: Array<{ name: string; archive: Uint8Array; code: string; limits?: AgentSkillInstallerOptions["limits"] }> = [
    {
      name: "traversal",
      archive: makeZip({
        "wrapper/SKILL.md": bytes(skillMarkdown),
        "wrapper/../escape.txt": bytes("escape"),
      }),
      code: "PATH_TRAVERSAL",
    },
    {
      name: "absolute path",
      archive: makeZip({
        "/wrapper/SKILL.md": bytes(skillMarkdown),
      }),
      code: "PATH_TRAVERSAL",
    },
    {
      name: "Windows drive",
      archive: makeZip({
        "C:/wrapper/SKILL.md": bytes(skillMarkdown),
      }),
      code: "PATH_TRAVERSAL",
    },
    {
      name: "case collision",
      archive: makeZip({
        "wrapper/SKILL.md": bytes(skillMarkdown),
        "wrapper/Readme.txt": bytes("one"),
        "wrapper/README.txt": bytes("two"),
      }),
      code: "PATH_COLLISION",
    },
    {
      name: "symbolic link",
      archive: makeZip({
        "wrapper/SKILL.md": bytes(skillMarkdown),
        "wrapper/link": [bytes("target"), { os: 3, attrs: 0o120777 * 65_536 }],
      }),
      code: "ARCHIVE_LINK",
    },
    {
      name: "device node",
      archive: makeZip({
        "wrapper/SKILL.md": bytes(skillMarkdown),
        "wrapper/device": [new Uint8Array(), { os: 3, attrs: 0o020666 * 65_536 }],
      }),
      code: "ARCHIVE_LINK",
    },
    {
      name: "hard-link capable Unix metadata",
      archive: makeZip({
        "wrapper/SKILL.md": bytes(skillMarkdown),
        "wrapper/file.txt": [bytes("target"), { extra: { 0x000d: new Uint8Array() } }],
      }),
      code: "ARCHIVE_LINK",
    },
    {
      name: "nested archive",
      archive: makeZip({
        "wrapper/SKILL.md": bytes(skillMarkdown),
        "wrapper/payload.zip": makeZip({ "payload.txt": bytes("nested") }),
      }),
      code: "NESTED_ARCHIVE",
    },
    {
      name: "compression bomb",
      archive: makeZip({
        "wrapper/SKILL.md": bytes(skillMarkdown),
        "wrapper/large.txt": new Uint8Array(20_000),
      }),
      code: "ARCHIVE_BOMB",
      limits: { maximumEntryBytes: 10_000 },
    },
    {
      name: "multiple roots",
      archive: makeZip({
        "one/SKILL.md": bytes(skillMarkdown),
        "two/file.txt": bytes("two"),
      }),
      code: "PACKAGE_ROOT_INVALID",
    },
    {
      name: "nested Skill package",
      archive: makeZip({
        "wrapper/SKILL.md": bytes(skillMarkdown),
        "wrapper/nested/SKILL.md": bytes(skillMarkdown.replace("h3-prompt-writing", "nested-skill")),
      }),
      code: "SKILL_FILE_INVALID",
    },
    {
      name: "invalid Skill name",
      archive: makeZip({
        "wrapper/SKILL.md": bytes(skillMarkdown.replace("h3-prompt-writing", "Unsafe_Name")),
      }),
      code: "SKILL_NAME_INVALID",
    },
  ];

  for (const entry of cases) {
    const stateDir = mkdtempSync(join(tmpdir(), `rp-agent-skill-archive-${entry.name.replace(/\W+/g, "-")}-`));
    const installer = createInstaller(stateDir, async () => zipResponse(entry.archive), {
      limits: entry.limits,
    });
    try {
      await assert.rejects(
        installer.stage({ sourceUrl: genericUrl }),
        (error) => hasCode(entry.code)(error) || assert.fail(`${entry.name}: unexpected error ${String(error)}`),
      );
      assert.deepEqual(readdirNames(join(stateDir, "skill-installer-quarantine")), []);
    } finally {
      installer.dispose();
      rmSync(stateDir, { recursive: true, force: true });
    }
  }
});

test("v1 never overwrites, and rollback refuses to delete a package changed after confirm", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-skill-overwrite-"));
  const archive = genericArchive();
  const installer = createInstaller(stateDir, async () => zipResponse(archive));
  try {
    const firstStage = await installer.stage({ sourceUrl: genericUrl });
    const firstReceipt = installer.confirm({ stageId: firstStage.stageId, digest: firstStage.digest });
    const target = join(stateDir, "skills", firstReceipt.name);
    const secondStage = await installer.stage({ sourceUrl: genericUrl });
    assert.throws(
      () => installer.confirm({ stageId: secondStage.stageId, digest: secondStage.digest }),
      hasCode("SKILL_EXISTS"),
    );
    installer.cancel(secondStage.stageId);
    writeFileSync(join(target, "user-added.txt"), "keep me", { mode: 0o600 });
    assert.throws(() => installer.rollbackInstall(firstReceipt), hasCode("ROLLBACK_CHANGED"));
    assert.equal(readFileSync(join(target, "user-added.txt"), "utf8"), "keep me");
  } finally {
    installer.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("confirm revalidates quarantine contents and an injected catalog-wide name check", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-skill-revalidate-"));
  let nameAvailable = true;
  const installer = createInstaller(stateDir, async () => zipResponse(genericArchive()), {
    isSkillNameAvailable: () => nameAvailable,
  });
  try {
    const tampered = await installer.stage({ sourceUrl: genericUrl });
    const quarantinedSkill = join(
      stateDir,
      "skill-installer-quarantine",
      `stage-${tampered.stageId}`,
      "package",
      "SKILL.md",
    );
    writeFileSync(quarantinedSkill, `${skillMarkdown}\nchanged after review\n`, { mode: 0o600 });
    assert.throws(
      () => installer.confirm({ stageId: tampered.stageId, digest: tampered.digest }),
      hasCode("STAGE_CHANGED"),
    );
    assert.equal(existsSync(join(stateDir, "skills", "h3-prompt-writing")), false);
    installer.cancel(tampered.stageId);

    const colliding = await installer.stage({ sourceUrl: genericUrl });
    nameAvailable = false;
    assert.throws(
      () => installer.confirm({ stageId: colliding.stageId, digest: colliding.digest }),
      hasCode("SKILL_NAME_CONFLICT"),
    );
    assert.equal(existsSync(join(stateDir, "skills", "h3-prompt-writing")), false);
    installer.cancel(colliding.stageId);
  } finally {
    installer.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("cancel, expiry, bounded downloads, and request timeout remove quarantined state", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-skill-lifecycle-"));
  let now = Date.parse("2026-08-11T00:00:00.000Z");
  const installer = createInstaller(stateDir, async () => zipResponse(genericArchive()), {
    now: () => now,
    limits: { stageTtlMs: 60_000 },
  });
  try {
    const staged = await installer.stage({ sourceUrl: genericUrl });
    const snapshot = installer.getStage(staged.stageId);
    assert.equal(snapshot?.metadata.name, "h3-prompt-writing");
    if (snapshot) snapshot.manifest[0].path = "caller-mutation";
    assert.equal(installer.getStage(staged.stageId)?.manifest[0].path, "SKILL.md");
    assert.throws(
      () => installer.cancel({ stageId: staged.stageId, digest: "0".repeat(64) }),
      hasCode("STAGE_DIGEST_MISMATCH"),
    );
    now += 60_001;
    assert.equal(installer.cleanupExpired(), 1);
    assert.equal(installer.getStage(staged.stageId), undefined);
    assert.equal(existsSync(join(stateDir, "skill-installer-quarantine", `stage-${staged.stageId}`)), false);
    assert.throws(
      () => installer.confirm({ stageId: staged.stageId, digest: staged.digest }),
      hasCode("STAGE_NOT_FOUND"),
    );
  } finally {
    installer.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }

  const boundedDir = mkdtempSync(join(tmpdir(), "rp-agent-skill-bounded-"));
  const bounded = createInstaller(boundedDir, async () => ({
    response: new Response(toArrayBuffer(new Uint8Array(256)), {
      headers: { "content-type": "application/zip", "content-length": "256" },
    }),
  }), { limits: { maximumDownloadBytes: 128 } });
  try {
    await assert.rejects(bounded.stage({ sourceUrl: genericUrl }), hasCode("DOWNLOAD_TOO_LARGE"));
  } finally {
    bounded.dispose();
    rmSync(boundedDir, { recursive: true, force: true });
  }

  const timeoutDir = mkdtempSync(join(tmpdir(), "rp-agent-skill-timeout-"));
  const timeout = createInstaller(timeoutDir, ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }), { limits: { requestTimeoutMs: 10 } });
  try {
    await assert.rejects(timeout.stage({ sourceUrl: genericUrl }), hasCode("REQUEST_TIMEOUT"));
  } finally {
    timeout.dispose();
    rmSync(timeoutDir, { recursive: true, force: true });
  }
});

function createInstaller(
  stateDir: string,
  transport: SkillInstallerTransport,
  overrides: Omit<AgentSkillInstallerOptions, "stateDir" | "transport" | "resolveHostname"> = {},
): AgentSkillInstallerService {
  return new AgentSkillInstallerService({
    stateDir,
    transport,
    resolveHostname: async () => [publicAddress],
    ...overrides,
  });
}

function githubArchive(options: { unrelatedBytes?: number; unrelatedArchive?: boolean } = {}): Uint8Array {
  const root = `MiniMax-H3-${commit}`;
  const skillRoot = `${root}/.claude/skills/h3-prompt-writing`;
  const entries: Zippable = {
    [`${skillRoot}/SKILL.md`]: bytes(skillMarkdown),
    [`${skillRoot}/references/base-en.txt`]: bytes("base prompt\n"),
    [`${skillRoot}/references/ref-en.txt`]: bytes("reference prompt\n"),
  };
  if (options.unrelatedBytes) entries[`${root}/models/large.bin`] = new Uint8Array(options.unrelatedBytes);
  if (options.unrelatedArchive) entries[`${root}/examples/unrelated.zip`] = bytes("not selected or extracted");
  return makeZip(entries, { level: 0 });
}

function genericArchive(): Uint8Array {
  return makeZip({
    "h3-prompt-writing/SKILL.md": bytes(skillMarkdown),
    "h3-prompt-writing/references/base-en.txt": bytes("base prompt\n"),
  });
}

function makeZip(entries: Zippable, options: { level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 } = {}): Uint8Array {
  return zipSync(entries, { level: options.level ?? 6 });
}

function bytes(value: string): Uint8Array {
  return strToU8(value);
}

function zipResponse(archive: Uint8Array) {
  return Promise.resolve({
    response: new Response(toArrayBuffer(archive), { headers: { "content-type": "application/zip" } }),
  });
}

function jsonResponse(value: unknown) {
  return Promise.resolve({
    response: new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } }),
  });
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof AgentSkillInstallerError && error.code === code;
}

function readdirNames(path: string): string[] {
  return existsSync(path) ? readdirSync(path) : [];
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}
