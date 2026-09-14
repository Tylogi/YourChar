import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { readFileSync, realpathSync } from "node:fs";
import type { AgentRuntimeConfigurationInput } from "../pi/runtime-configuration.js";
import { createLspNavigationCapabilityPackage } from "./capability.js";
import {
  createStdioLspProviderDefinition,
  type StdioLspProviderOptions,
} from "./stdio-provider.js";
import { LspError, type LspProviderDefinition } from "./types.js";

const require = createRequire(import.meta.url);
const providerId = "typescript-language-server";
const runtimePackageId = "lsp-navigation-typescript";
const runtimeProfileId = "code-navigation";
const expectedServerVersion = "5.3.0";
const expectedTypeScriptVersion = "5.9.3";

const reviewedManifest = Object.freeze({
  revision: 1,
  providerId,
  server: {
    name: "typescript-language-server",
    version: expectedServerVersion,
    integrity: "sha512-5puofxZHgFdAYtfNpmwCAvgtaYgg8wrUnH30m7Ze3QuguId5RNRadKASpOpyDxTyUdAF51FjhTdjntLw/EuWcQ==",
  },
  typescript: {
    name: "typescript",
    version: expectedTypeScriptVersion,
    integrity: "sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==",
  },
  sandbox: {
    command: "/opt/lsp/node",
    server: "/opt/lsp/typescript-language-server/lib/cli.mjs",
    tsserver: "/opt/lsp/typescript/lib/tsserver.js",
    useSyntaxServer: "never",
  },
});

export const bundledTypeScriptLspContentDigest = createHash("sha256")
  .update(JSON.stringify(reviewedManifest))
  .digest("hex");

export const bundledTypeScriptLspRuntimePackageId = runtimePackageId;
export const bundledTypeScriptLspRuntimeProfileId = runtimeProfileId;

export type BundledTypeScriptLspProviderOptions = Readonly<{
  requestTimeoutMs?: number;
  maximumMessageBytes?: number;
}>;

/**
 * Resolve the exact npm-locked TypeScript server artifacts and expose them to
 * the generic stdio provider through three narrow read-only sandbox mounts.
 */
export function createBundledTypeScriptLspProviderDefinition(
  options: BundledTypeScriptLspProviderOptions = {},
): LspProviderDefinition {
  const serverPackage = resolveReviewedPackage(
    "typescript-language-server/package.json",
    expectedServerVersion,
  );
  const typescriptPackage = resolveReviewedPackage(
    "typescript/package.json",
    expectedTypeScriptVersion,
  );
  reviewedFile("typescript-language-server/lib/cli.mjs");
  const nodeExecutable = realpathSync(process.execPath);
  const providerOptions: StdioLspProviderOptions = {
    id: providerId,
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    command: "/opt/lsp/node",
    args: ["/opt/lsp/typescript-language-server/lib/cli.mjs", "--stdio"],
    readOnlyBinds: [
      { source: nodeExecutable, target: "/opt/lsp/node" },
      {
        source: dirname(serverPackage.path),
        target: "/opt/lsp/typescript-language-server",
      },
      { source: dirname(typescriptPackage.path), target: "/opt/lsp/typescript" },
    ],
    languageIds: {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".mts": "typescript",
      ".cts": "typescript",
      ".js": "javascript",
      ".jsx": "javascriptreact",
      ".mjs": "javascript",
      ".cjs": "javascript",
    },
    initializationOptions: {
      disableAutomaticTypingAcquisition: true,
      hostInfo: "YourChar",
      tsserver: {
        path: "/opt/lsp/typescript/lib/tsserver.js",
        // Dynamic syntax routing can answer a cold semantic query with only
        // same-file aliases. A single semantic server makes cold Task Bench
        // runs deterministic and preserves cross-file meaning.
        useSyntaxServer: "never",
      },
    },
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.maximumMessageBytes === undefined
      ? {}
      : { maximumMessageBytes: options.maximumMessageBytes }),
  };
  return createStdioLspProviderDefinition(providerOptions);
}

/** Shipped, default-off runtime package and the two production profiles. */
export function createBundledTypeScriptLspRuntimeConfiguration(): AgentRuntimeConfigurationInput {
  const lspPackage = createLspNavigationCapabilityPackage({
    version: `1+tls.${expectedServerVersion}.ts.${expectedTypeScriptVersion}`,
    contentDigest: bundledTypeScriptLspContentDigest,
    source: "YourChar npm-locked TypeScript LSP bundle",
    trusted: true,
    packageId: runtimePackageId,
    packageName: "TypeScript LSP Navigation",
    providers: [createBundledTypeScriptLspProviderDefinition()],
  });
  return Object.freeze({
    packages: Object.freeze([lspPackage]),
    profiles: Object.freeze([
      Object.freeze({
        id: "default",
        name: "Standard",
        description: "YourChar built-ins only; optional code navigation is not loaded.",
        packageIds: Object.freeze([]),
      }),
      Object.freeze({
        id: runtimeProfileId,
        name: "Code navigation",
        description: "Adds the reviewed TypeScript/JavaScript LSP provider; its module remains default-off.",
        packageIds: Object.freeze([runtimePackageId]),
      }),
    ]),
  });
}

function resolveReviewedPackage(
  specifier: string,
  expectedVersion: string,
): { path: string; version: string } {
  const path = reviewedFile(specifier);
  let version: unknown;
  try {
    version = (JSON.parse(readFileSync(path, "utf8")) as { version?: unknown }).version;
  } catch (error) {
    throw new LspError("LSP_INVALID_PROVIDER", `could not read reviewed package manifest: ${specifier}`, error);
  }
  if (version !== expectedVersion) {
    throw new LspError(
      "LSP_INVALID_PROVIDER",
      `reviewed package ${specifier} must be version ${expectedVersion}`,
    );
  }
  return { path, version };
}

function reviewedFile(specifier: string): string {
  try {
    return realpathSync(require.resolve(specifier));
  } catch (error) {
    throw new LspError("LSP_INVALID_PROVIDER", `reviewed LSP dependency is unavailable: ${specifier}`, error);
  }
}
