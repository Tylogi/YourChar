import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  bundledTypeScriptLspContentDigest,
  bundledTypeScriptLspRuntimePackageId,
  bundledTypeScriptLspRuntimeProfileId,
  createBundledTypeScriptLspProviderDefinition,
  createBundledTypeScriptLspRuntimeConfiguration,
  createLspNavigationCapabilityPackage,
  createStdioLspProviderDefinition,
  LspError,
  WorkspaceLspService,
  type LspProviderDefinition,
  type LspProviderQuery,
  type LspProviderResult,
} from "../src/lsp/index.js";
import { createTestRuntime } from "../src/testing/runtime.js";

test("Workspace LSP service scopes paths and bounds semantic results", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-lsp-service-"));
  const outside = mkdtempSync(join(tmpdir(), "yourchar-lsp-outside-"));
  context.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "main.ts"), "const value = 1;\n", "utf8");
  writeFileSync(join(outside, "secret.ts"), "outside\n", "utf8");
  symlinkSync(join(outside, "secret.ts"), join(root, "escape.ts"));

  const calls: LspProviderQuery[] = [];
  let closes = 0;
  const service = await WorkspaceLspService.mount(root, [fakeProvider({
    query: async (request) => {
      calls.push(request);
      if (request.operation === "hover") {
        return { kind: "hover", contents: "123456789", range: range(0, 0, 0, 5) };
      }
      return {
        kind: "locations",
        locations: [
          { uri: "file:///workspace/src/main.ts", range: range(0, 0, 0, 5) },
          { uri: "file:///workspace/src/main.ts", range: range(0, 6, 0, 11) },
          { uri: "file:///workspace/src/main.ts", range: range(0, 12, 0, 13) },
        ],
      };
    },
    close: () => { closes += 1; },
  })], {
    maximumLocations: 2,
    maximumHoverCharacters: 5,
  });

  assert.deepEqual(service.listProviders(), [{ id: "fake-typescript", extensions: [".ts"] }]);
  const definitions = await service.query({
    operation: "goToDefinition",
    path: "src/main.ts",
    position: { line: 0, character: 6 },
  });
  assert.equal(definitions.kind, "locations");
  if (definitions.kind === "locations") {
    assert.equal(definitions.locations.length, 2);
    assert.equal(definitions.locations[0]?.path, "src/main.ts");
    assert.equal(definitions.truncated, true);
  }
  assert.equal(calls[0]?.document.uri, "file:///workspace/src/main.ts");
  assert.equal(calls[0]?.document.text, "const value = 1;\n");

  const hover = await service.query({
    operation: "hover",
    path: "src/main.ts",
    position: { line: 0, character: 0 },
  });
  assert.deepEqual(hover, {
    kind: "hover",
    providerId: "fake-typescript",
    path: "src/main.ts",
    contents: "12345",
    range: range(0, 0, 0, 5),
    truncated: true,
  });

  await assert.rejects(
    service.query({
      operation: "hover",
      path: "escape.ts",
      position: { line: 0, character: 0 },
    }),
    (error) => error instanceof LspError && error.code === "LSP_INVALID_REQUEST",
  );
  await service.dispose();
  await service.dispose();
  assert.equal(closes, 1);
});

test("Workspace LSP service fails closed on provider conflicts, escaped results, and cancellation", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-lsp-fail-closed-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "main.ts"), "let value = 1;\n", "utf8");

  await assert.rejects(
    WorkspaceLspService.mount(root, [
      fakeProvider(),
      fakeProvider({ id: "other-typescript" }),
    ]),
    (error) => error instanceof LspError && error.code === "LSP_CONFLICT",
  );

  const escaped = await WorkspaceLspService.mount(root, [fakeProvider({
    query: async () => ({
      kind: "locations",
      locations: [{ uri: "file:///etc/passwd", range: range(0, 0, 0, 1) }],
    }),
  })]);
  await assert.rejects(
    escaped.query({
      operation: "findReferences",
      path: "main.ts",
      position: { line: 0, character: 0 },
    }),
    (error) => error instanceof LspError && error.code === "LSP_MALFORMED_RESPONSE",
  );
  await escaped.dispose();

  const waiting = await WorkspaceLspService.mount(root, [fakeProvider({
    query: async () => new Promise<LspProviderResult>(() => undefined),
  })]);
  const controller = new AbortController();
  const query = waiting.query({
    operation: "hover",
    path: "main.ts",
    position: { line: 0, character: 0 },
  }, controller.signal);
  controller.abort();
  await assert.rejects(
    query,
    (error) => error instanceof LspError && error.code === "LSP_CANCELLED",
  );
  await waiting.dispose();
});

test("stdio LSP provider speaks JSON-RPC inside a read-only Workspace sandbox", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-lsp-stdio-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "main.ts"), "const first = 1;\n", "utf8");
  const serverPath = resolve("test/fixtures/fake-lsp-server.mjs");
  const nodePath = realpathSync(process.execPath);
  const definition = createStdioLspProviderDefinition({
    id: "fixture-typescript",
    extensions: [".ts"],
    command: "/opt/lsp/node",
    args: ["/opt/lsp/server"],
    readOnlyBinds: [
      { source: nodePath, target: "/opt/lsp/node" },
      { source: serverPath, target: "/opt/lsp/server" },
    ],
    languageIds: { ".ts": "typescript" },
  });
  const service = await WorkspaceLspService.mount(root, [definition]);
  context.after(() => service.dispose());

  const location = await service.query({
    operation: "goToDefinition",
    path: "main.ts",
    position: { line: 0, character: 6 },
  });
  assert.equal(location.kind, "locations");
  if (location.kind === "locations") {
    assert.deepEqual(location.locations, [{ path: "main.ts", range: range(0, 0, 0, 5) }]);
  }
  for (const operation of ["findReferences", "goToImplementation"] as const) {
    const result = await service.query({
      operation,
      path: "main.ts",
      position: { line: 0, character: 6 },
    });
    assert.equal(result.kind, "locations");
    if (result.kind === "locations") {
      assert.deepEqual(result.locations, [{ path: "main.ts", range: range(0, 0, 0, 5) }]);
    }
  }

  const firstHover = await service.query({
    operation: "hover",
    path: "main.ts",
    position: { line: 0, character: 6 },
  });
  assert.equal(firstHover.kind, "hover");
  if (firstHover.kind === "hover") {
    assert.match(firstHover.contents, /snapshot=const first = 1;/u);
    assert.match(firstHover.contents, /hostHomeVisible=false/u);
    assert.match(firstHover.contents, /workspaceWritable=false/u);
  }
  assert.equal(existsSync(join(root, "lsp-must-stay-read-only.txt")), false);

  writeFileSync(join(root, "main.ts"), "const second = 2;\n", "utf8");
  const changedHover = await service.query({
    operation: "hover",
    path: "main.ts",
    position: { line: 0, character: 6 },
  });
  assert.equal(changedHover.kind, "hover");
  if (changedHover.kind === "hover") assert.match(changedHover.contents, /snapshot=const second = 2;/u);

  await service.dispose();
});

test("bundled TypeScript LSP resolves real cross-file semantics in its sandbox", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-lsp-typescript-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
    },
    include: ["src/**/*.ts"],
  }), "utf8");
  writeFileSync(
    join(root, "src", "contracts.ts"),
    "export interface Greeter {\n  greet(name: string): string;\n}\n",
    "utf8",
  );
  writeFileSync(
    join(root, "src", "implementation.ts"),
    [
      'import type { Greeter } from "./contracts";',
      "export class FriendlyGreeter implements Greeter {",
      "  greet(name: string): string {",
      "    return `Hello ${name}`;",
      "  }",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(root, "src", "main.ts"),
    [
      'import { FriendlyGreeter } from "./implementation";',
      "const greeter = new FriendlyGreeter();",
      'export const message = greeter.greet("Ada");',
      "",
    ].join("\n"),
    "utf8",
  );

  const service = await WorkspaceLspService.mount(
    root,
    [createBundledTypeScriptLspProviderDefinition({ requestTimeoutMs: 20_000 })],
    { queryTimeoutMs: 25_000 },
  );
  context.after(() => service.dispose());

  const aliasDefinition = await service.query({
    operation: "goToDefinition",
    path: "src/main.ts",
    position: { line: 1, character: 22 },
  });
  assert.equal(aliasDefinition.kind, "locations");
  if (aliasDefinition.kind === "locations") {
    assert.equal(
      aliasDefinition.locations.some((entry) => entry.path === "src/implementation.ts"),
      true,
      JSON.stringify(aliasDefinition),
    );
  }
  const definition = await service.query({
    operation: "goToDefinition",
    path: "src/main.ts",
    position: { line: 0, character: 12 },
  });
  assert.equal(definition.kind, "locations");
  if (definition.kind === "locations") {
    assert.equal(definition.locations.length > 0, true, JSON.stringify(definition));
  }

  const hover = await service.query({
    operation: "hover",
    path: "src/main.ts",
    position: { line: 2, character: 32 },
  });
  assert.equal(hover.kind, "hover");
  if (hover.kind === "hover") assert.match(hover.contents, /Greeter\.greet/u);

  const implementation = await service.query({
    operation: "goToImplementation",
    path: "src/contracts.ts",
    position: { line: 0, character: 17 },
  });
  assert.equal(implementation.kind, "locations");
  if (implementation.kind === "locations") {
    assert.equal(implementation.locations.some((entry) => entry.path === "src/implementation.ts"), true);
  }

  await service.dispose();
});

test("bundled TypeScript deployment stays default-off behind its code-navigation profile", () => {
  const configuration = createBundledTypeScriptLspRuntimeConfiguration();
  assert.match(bundledTypeScriptLspContentDigest, /^[a-f0-9]{64}$/u);
  assert.equal(configuration.packages?.[0]?.id, bundledTypeScriptLspRuntimePackageId);
  assert.equal(configuration.packages?.[0]?.trusted, true);
  assert.deepEqual(configuration.profiles?.map((profile) => ({
    id: profile.id,
    packageIds: profile.packageIds,
  })), [
    { id: "default", packageIds: [] },
    {
      id: bundledTypeScriptLspRuntimeProfileId,
      packageIds: [bundledTypeScriptLspRuntimePackageId],
    },
  ]);
});

test("LSP package requires profile, module, and Workspace permission and closes with the handle", async () => {
  let mounts = 0;
  let closes = 0;
  let queries = 0;
  const capabilityPackage = createLspNavigationCapabilityPackage({
    version: "1",
    contentDigest: "d".repeat(64),
    source: "test fixture",
    trusted: true,
    providers: [fakeProvider({
      mount: () => { mounts += 1; },
      close: () => { closes += 1; },
      query: async () => {
        queries += 1;
        return { kind: "hover", contents: "const value: number" };
      },
    })],
  });
  const runtime = createTestRuntime({
    seed: "lsp-capability",
    agentCapabilityPackages: [capabilityPackage],
    agentRuntimeProfiles: [{
      id: "default",
      name: "LSP test",
      description: "Activates the reviewed LSP package.",
      packageIds: [capabilityPackage.id],
    }],
  });
  try {
    runtime.kernel.patchAgentPermissions({ workspaceAccess: "off" });
    const module = runtime.kernel.listAgentModules().find((entry) => entry.id === "mcp:lsp-navigation");
    assert.equal(module?.enabled, false);
    assert.deepEqual(
      runtime.kernel.isolatedTaskBenchSessionCapabilities().map((entry) => entry.id),
      ["code:lsp-navigation"],
    );
    runtime.kernel.uploadWorkspaceFile({
      directory: "src",
      name: "main.ts",
      bytes: Buffer.from("const value = 1;\n"),
    });

    runtime.kernel.setAgentModuleEnabled("mcp:lsp-navigation", true);
    runtime.model.enqueue([{ kind: "assistant_text", text: "暂时没有代码导航权限。" }]);
    await runtime.kernel.sendMessage("lsp-session", { mode: "sms", text: "检查代码。" });
    assert.equal(runtime.model.requests[0]?.toolNames.includes("lsp"), false);
    assert.equal(mounts, 0);

    runtime.kernel.patchAgentPermissions({ workspaceAccess: "read_only" });
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "lsp",
        arguments: {
          operation: "hover",
          path: "src/main.ts",
          line: 1,
          character: 7,
        },
      },
      { kind: "assistant_text", text: "类型是 number。" },
    ]);
    const response = await runtime.kernel.sendMessage(
      "lsp-session",
      { mode: "sms", text: "查看 value 类型。" },
    );
    assert.equal(runtime.model.requests[1]?.toolNames.includes("lsp"), true);
    assert.equal(mounts, 1);
    assert.equal(queries, 1);
    assert.match(JSON.stringify(runtime.model.requests[2]?.messages), /const value: number/u);
    const action = response.actions.find((entry) => entry.actionType === "lsp_navigation");
    assert.equal(action?.status, "completed");
    assert.equal(action?.payload.providerId, "fake-typescript");
    assert.match(String(action?.payload.pathSha256), /^[a-f0-9]{64}$/u);
    assert.equal(JSON.stringify(action).includes("src/main.ts"), false);

    runtime.kernel.setAgentModuleEnabled("mcp:lsp-navigation", false);
    runtime.model.enqueue([{ kind: "assistant_text", text: "代码导航已关闭。" }]);
    await runtime.kernel.sendMessage("lsp-session", { mode: "sms", text: "再次检查。" });
    assert.equal(closes, 1);
    assert.equal(runtime.model.requests[3]?.toolNames.includes("lsp"), false);
  } finally {
    runtime.dispose();
  }
});

function fakeProvider(overrides: Readonly<{
  id?: string;
  mount?: () => void;
  query?: (request: LspProviderQuery, signal?: AbortSignal) => Promise<LspProviderResult>;
  close?: () => void | Promise<void>;
}> = {}): LspProviderDefinition {
  const id = overrides.id ?? "fake-typescript";
  const extensions = [".ts"] as const;
  return {
    id,
    extensions,
    mount() {
      overrides.mount?.();
      return {
        id,
        extensions,
        query: overrides.query ?? (async () => ({ kind: "empty" })),
        ...(overrides.close ? { close: overrides.close } : {}),
      };
    },
  };
}

function range(
  startLine: number,
  startCharacter: number,
  endLine: number,
  endCharacter: number,
) {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}
