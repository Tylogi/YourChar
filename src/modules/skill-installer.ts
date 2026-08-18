import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { inflateSync } from "fflate";
import ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";
import { parseDocument } from "yaml";

export type SkillInstallerResolvedAddress = {
  address: string;
  family: 4 | 6;
};

export type SkillInstallerTransportRequest = {
  url: URL;
  addresses: readonly SkillInstallerResolvedAddress[];
  headers: Readonly<Record<string, string>>;
  signal: AbortSignal;
};

export type SkillInstallerTransportResult = {
  response: Response;
  close?: () => void | Promise<void>;
};

/**
 * The injected transport receives only URLs and DNS answers that have already
 * passed the installer's SSRF policy. The production transport pins these
 * exact answers into the socket dispatcher.
 */
export type SkillInstallerTransport = (
  request: SkillInstallerTransportRequest,
) => Promise<SkillInstallerTransportResult>;

export type SkillInstallerLimits = {
  maximumDownloadBytes: number;
  maximumMetadataBytes: number;
  maximumFiles: number;
  maximumEntryBytes: number;
  maximumUnpackedBytes: number;
  maximumCompressionRatio: number;
  maximumSkillMarkdownBytes: number;
  maximumPathDepth: number;
  maximumPathLength: number;
  maximumRedirects: number;
  requestTimeoutMs: number;
  stageTtlMs: number;
};

export type AgentSkillInstallerOptions = {
  stateDir: string;
  transport?: SkillInstallerTransport;
  resolveHostname?: (hostname: string) => Promise<SkillInstallerResolvedAddress[]>;
  /** Optional catalog-level collision check for project and other discovery roots. */
  isSkillNameAvailable?: (name: string) => boolean;
  now?: () => number;
  limits?: Partial<SkillInstallerLimits>;
};

export type AgentSkillStageInput = {
  /**
   * A public HTTPS URL without credentials, query, or fragment. GitHub tree
   * URLs are resolved to an immutable commit before their codeload archive is
   * fetched. Other inputs must be ZIP archives.
   */
  sourceUrl: string;
  /** Relative package directory below the archive's single wrapper root. */
  packagePath?: string;
  /** SHA-256 of the normalized package manifest, not of the downloaded ZIP. */
  expectedSha256?: string;
};

export type AgentSkillSourceMetadata = {
  requestedUrl: string;
  resolvedArchiveUrl: string;
  finalArchiveUrl: string;
  packagePath?: string;
  requestedRef?: string;
  resolvedCommit?: string;
};

export type AgentSkillManifestEntry = {
  path: string;
  size: number;
  sha256: string;
};

export type AgentSkillStageResult = {
  stageId: string;
  /** SHA-256 of the canonical manifest; confirm must present this exact value. */
  digest: string;
  /** SHA-256 of the downloaded ZIP, supplied for provenance only. */
  archiveSha256: string;
  expiresAt: string;
  metadata: {
    name: string;
    description: string;
    files: number;
    unpackedBytes: number;
  };
  source: AgentSkillSourceMetadata;
  manifest: AgentSkillManifestEntry[];
  /** Bounded review copy of SKILL.md; never written to audit or model context here. */
  skillMarkdown: string;
};

export type AgentSkillInstallReceipt = {
  installId: string;
  name: string;
  digest: string;
  installedAt: string;
  manifest: AgentSkillManifestEntry[];
};

export type AgentSkillConfirmInput = {
  stageId: string;
  digest: string;
};

export type AgentSkillCancelInput = {
  stageId: string;
  digest?: string;
};

export class AgentSkillInstallerError extends Error {
  constructor(message: string, readonly code: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentSkillInstallerError";
  }
}

type StagedPackage = {
  result: AgentSkillStageResult;
  stageDirectory: string;
  packageDirectory: string;
  expiresAtMs: number;
  timer: ReturnType<typeof setTimeout>;
};

type InstalledPackage = {
  receipt: AgentSkillInstallReceipt;
  targetDirectory: string;
  expectedDirectories: string[];
};

type NormalizedSource = {
  requestedUrl: URL;
  archiveUrl: URL;
  packagePath?: string;
  requestedRef?: string;
  resolvedCommit?: string;
};

type GitHubSource = {
  owner: string;
  repository: string;
  ref: string;
  commit?: string;
  packagePath?: string;
  treePage?: URL;
};

type ZipEntry = {
  path: string;
  directory: boolean;
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  dataOffset: number;
  localOffset: number;
};

type ExtractedPackage = {
  name: string;
  description: string;
  files: Array<{ path: string; data: Uint8Array }>;
  manifest: AgentSkillManifestEntry[];
  digest: string;
  skillMarkdown: string;
  unpackedBytes: number;
};

const defaults: SkillInstallerLimits = {
  maximumDownloadBytes: 128 * 1024 * 1024,
  maximumMetadataBytes: 512 * 1024,
  maximumFiles: 256,
  maximumEntryBytes: 4 * 1024 * 1024,
  maximumUnpackedBytes: 16 * 1024 * 1024,
  maximumCompressionRatio: 100,
  maximumSkillMarkdownBytes: 128 * 1024,
  maximumPathDepth: 20,
  maximumPathLength: 512,
  maximumRedirects: 5,
  requestTimeoutMs: 240_000,
  stageTtlMs: 10 * 60_000,
};

const stageDirectoryPattern = /^stage-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const gitCommitPattern = /^[0-9a-f]{40}$/;
const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const nestedArchivePattern = /\.(?:zip|jar|apk|tar|tgz|tar\.gz|gz|bz2|xz|7z|rar)$/i;
const linkExtraFieldIds = new Set([0x000d, 0x756e]);
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const maximumCentralDirectoryEntries = 4096;
const githubFakeIpHosts = new Set(["github.com", "api.github.com", "codeload.github.com"]);

export class AgentSkillInstallerService {
  private readonly stateDir: string;
  private readonly skillsDirectory: string;
  private readonly quarantineDirectory: string;
  private readonly transport: SkillInstallerTransport;
  private readonly resolveHostname: (hostname: string) => Promise<SkillInstallerResolvedAddress[]>;
  private readonly isSkillNameAvailable?: (name: string) => boolean;
  private readonly now: () => number;
  private readonly limits: SkillInstallerLimits;
  private readonly stages = new Map<string, StagedPackage>();
  private readonly installed = new Map<string, InstalledPackage>();

  constructor(options: AgentSkillInstallerOptions) {
    this.stateDir = resolve(options.stateDir);
    this.skillsDirectory = join(this.stateDir, "skills");
    this.quarantineDirectory = join(this.stateDir, "skill-installer-quarantine");
    this.transport = options.transport ?? productionTransport;
    this.resolveHostname = options.resolveHostname ?? resolveHostname;
    this.isSkillNameAvailable = options.isSkillNameAvailable;
    this.now = options.now ?? Date.now;
    this.limits = validateLimits({ ...defaults, ...options.limits });
    ensurePrivateDirectory(this.stateDir);
    ensurePrivateDirectory(this.skillsDirectory);
    ensurePrivateDirectory(this.quarantineDirectory);
    this.removeOrphanedStages();
  }

  async stage(input: AgentSkillStageInput, signal?: AbortSignal): Promise<AgentSkillStageResult> {
    this.cleanupExpired();
    const expectedSha256 = normalizeExpectedSha256(input.expectedSha256);
    const source = await this.normalizeSource(input, signal);
    const archive = await this.requestBytes(source.archiveUrl, "archive", signal);
    if (!looksLikeZip(archive.bytes)) {
      throw new AgentSkillInstallerError("downloaded source is not a ZIP archive", "ARCHIVE_FORMAT");
    }
    const archiveSha256 = sha256(archive.bytes);
    const extracted = extractPackage(archive.bytes, source.packagePath, this.limits);
    if (expectedSha256 && expectedSha256 !== extracted.digest) {
      throw new AgentSkillInstallerError("package manifest SHA-256 does not match expectedSha256", "DIGEST_MISMATCH");
    }
    this.assertSkillNameAvailable(extracted.name);

    const stageId = randomUUID();
    const stageDirectory = join(this.quarantineDirectory, `stage-${stageId}`);
    const packageDirectory = join(stageDirectory, "package");
    const expiresAtMs = checkedTimestamp(this.now() + this.limits.stageTtlMs, "stage expiry");
    const expiresAt = new Date(expiresAtMs).toISOString();
    try {
      mkdirSync(packageDirectory, { recursive: true, mode: 0o700 });
      chmodSync(stageDirectory, 0o700);
      chmodSync(packageDirectory, 0o700);
      materializePackage(packageDirectory, extracted.files);
    } catch (error) {
      removeOwnedPath(stageDirectory, this.quarantineDirectory);
      throw installerError(error, "failed to write quarantined Skill package", "STAGE_WRITE_FAILED");
    }

    const result: AgentSkillStageResult = {
      stageId,
      digest: extracted.digest,
      archiveSha256,
      expiresAt,
      metadata: {
        name: extracted.name,
        description: extracted.description,
        files: extracted.files.length,
        unpackedBytes: extracted.unpackedBytes,
      },
      source: {
        requestedUrl: source.requestedUrl.href,
        resolvedArchiveUrl: source.archiveUrl.href,
        finalArchiveUrl: archive.finalUrl.href,
        ...(source.packagePath ? { packagePath: source.packagePath } : {}),
        ...(source.requestedRef ? { requestedRef: source.requestedRef } : {}),
        ...(source.resolvedCommit ? { resolvedCommit: source.resolvedCommit } : {}),
      },
      manifest: cloneManifest(extracted.manifest),
      skillMarkdown: extracted.skillMarkdown,
    };
    const timer = setTimeout(() => this.expireStage(stageId), this.limits.stageTtlMs);
    timer.unref?.();
    this.stages.set(stageId, {
      result: cloneStageResult(result),
      stageDirectory,
      packageDirectory,
      expiresAtMs,
      timer,
    });
    return result;
  }

  /**
   * Publish a staged package. v1 never overwrites or updates an existing Skill.
   * The quarantined directory is renamed into the discovery root, so a new
   * package becomes visible as one filesystem operation.
   */
  confirm(input: AgentSkillConfirmInput): AgentSkillInstallReceipt {
    this.cleanupExpired();
    const stage = this.stages.get(input.stageId);
    if (!stage) throw new AgentSkillInstallerError("Skill stage was not found or expired", "STAGE_NOT_FOUND");
    if (input.digest !== stage.result.digest) {
      throw new AgentSkillInstallerError("stage digest does not match the reviewed package", "STAGE_DIGEST_MISMATCH");
    }
    if (this.now() >= stage.expiresAtMs) {
      this.expireStage(input.stageId);
      throw new AgentSkillInstallerError("Skill stage has expired", "STAGE_EXPIRED");
    }

    const name = stage.result.metadata.name;
    const targetDirectory = join(this.skillsDirectory, name);
    this.assertSkillNameAvailable(name);
    if (existsSync(targetDirectory)) {
      throw new AgentSkillInstallerError(`Skill ${name} is already installed; v1 does not overwrite`, "SKILL_EXISTS");
    }
    let observed: ReturnType<typeof inspectInstalledPackage>;
    try {
      observed = inspectInstalledPackage(stage.packageDirectory, this.limits);
    } catch (error) {
      throw new AgentSkillInstallerError("quarantined Skill changed after review", "STAGE_CHANGED", { cause: error });
    }
    if (
      observed.digest !== stage.result.digest
      || !sameManifest(observed.manifest, stage.result.manifest)
      || !sameStrings(observed.directories, directoriesForManifest(stage.result.manifest))
    ) {
      throw new AgentSkillInstallerError("quarantined Skill changed after review", "STAGE_CHANGED");
    }
    const receipt: AgentSkillInstallReceipt = {
      installId: randomUUID(),
      name,
      digest: stage.result.digest,
      installedAt: new Date(checkedTimestamp(this.now(), "install time")).toISOString(),
      manifest: cloneManifest(stage.result.manifest),
    };
    try {
      renameSync(stage.packageDirectory, targetDirectory);
    } catch (error) {
      if (existsSync(targetDirectory)) {
        throw new AgentSkillInstallerError(`Skill ${name} is already installed; v1 does not overwrite`, "SKILL_EXISTS", { cause: error });
      }
      throw installerError(error, "failed to publish staged Skill", "PUBLISH_FAILED");
    }

    clearTimeout(stage.timer);
    this.stages.delete(input.stageId);
    removeOwnedPath(stage.stageDirectory, this.quarantineDirectory);
    this.installed.set(receipt.installId, {
      receipt: cloneReceipt(receipt),
      targetDirectory,
      expectedDirectories: directoriesForManifest(receipt.manifest),
    });
    return receipt;
  }

  /**
   * Roll back only an unchanged package created by this service instance and
   * identified by its unguessable receipt. Any post-install modification makes
   * rollback fail closed, preventing deletion of user-owned changes.
   */
  rollbackInstall(receipt: AgentSkillInstallReceipt): void {
    const installed = this.installed.get(receipt.installId);
    if (!installed || !sameReceipt(receipt, installed.receipt)) {
      throw new AgentSkillInstallerError("install receipt is invalid or already finalized", "INVALID_INSTALL_RECEIPT");
    }
    let observed: ReturnType<typeof inspectInstalledPackage>;
    try {
      observed = inspectInstalledPackage(installed.targetDirectory, this.limits);
    } catch (error) {
      throw new AgentSkillInstallerError("installed Skill changed after publish; refusing rollback", "ROLLBACK_CHANGED", {
        cause: error,
      });
    }
    if (
      observed.digest !== installed.receipt.digest
      || !sameManifest(observed.manifest, installed.receipt.manifest)
      || !sameStrings(observed.directories, installed.expectedDirectories)
    ) {
      throw new AgentSkillInstallerError("installed Skill changed after publish; refusing rollback", "ROLLBACK_CHANGED");
    }
    removeOwnedPath(installed.targetDirectory, this.skillsDirectory);
    this.installed.delete(receipt.installId);
  }

  /** Revoke the short-lived rollback capability after catalog settings commit. */
  finalizeInstall(receipt: AgentSkillInstallReceipt): void {
    const installed = this.installed.get(receipt.installId);
    if (!installed || !sameReceipt(receipt, installed.receipt)) {
      throw new AgentSkillInstallerError("install receipt is invalid or already finalized", "INVALID_INSTALL_RECEIPT");
    }
    this.installed.delete(receipt.installId);
  }

  cancel(input: AgentSkillCancelInput | string): boolean {
    const stageId = typeof input === "string" ? input : input.stageId;
    const stage = this.stages.get(stageId);
    if (!stage) return false;
    if (typeof input !== "string" && input.digest && input.digest !== stage.result.digest) {
      throw new AgentSkillInstallerError("stage digest does not match the reviewed package", "STAGE_DIGEST_MISMATCH");
    }
    clearTimeout(stage.timer);
    this.stages.delete(stageId);
    removeOwnedPath(stage.stageDirectory, this.quarantineDirectory);
    return true;
  }

  /** Return an isolated review snapshot without exposing quarantine filesystem paths. */
  getStage(stageId: string): AgentSkillStageResult | undefined {
    this.cleanupExpired();
    const stage = this.stages.get(stageId);
    return stage ? cloneStageResult(stage.result) : undefined;
  }

  cleanupExpired(): number {
    let removed = 0;
    for (const [stageId, stage] of this.stages) {
      if (this.now() < stage.expiresAtMs) continue;
      this.expireStage(stageId);
      removed += 1;
    }
    return removed;
  }

  dispose(): void {
    for (const stageId of [...this.stages.keys()]) this.cancel(stageId);
    this.installed.clear();
  }

  private async normalizeSource(input: AgentSkillStageInput, signal?: AbortSignal): Promise<NormalizedSource> {
    const requestedUrl = parseRemoteUrl(input.sourceUrl);
    const explicitPackagePath = input.packagePath
      ? validateRelativePackagePath(input.packagePath, this.limits)
      : undefined;
    const github = parseGitHubSource(requestedUrl, explicitPackagePath, this.limits);
    if (!github) {
      return { requestedUrl, archiveUrl: requestedUrl, packagePath: explicitPackagePath };
    }

    let resolvedCommit = github.commit;
    if (!resolvedCommit) {
      const apiUrl = parseRemoteUrl(
        `https://api.github.com/repos/${github.owner}/${github.repository}/commits/${encodeURIComponent(github.ref)}`,
      );
      try {
        const metadata = await this.requestBytes(apiUrl, "metadata", signal);
        resolvedCommit = parseGitHubApiCommit(metadata.bytes);
      } catch (error) {
        if (
          !(error instanceof AgentSkillInstallerError)
          || error.code !== "HTTP_ERROR"
          || !github.treePage
        ) {
          throw error;
        }
        const page = await this.requestBytes(github.treePage, "github-page", signal);
        if (page.finalUrl.hostname.toLowerCase() !== "github.com") {
          throw new AgentSkillInstallerError(
            "GitHub tree metadata redirected away from github.com",
            "GITHUB_METADATA_INVALID",
          );
        }
        resolvedCommit = parseGitHubTreePageCommit(page.bytes);
      }
    }
    const archiveUrl = parseRemoteUrl(
      `https://codeload.github.com/${github.owner}/${github.repository}/zip/${resolvedCommit}`,
    );
    return {
      requestedUrl,
      archiveUrl,
      ...(github.packagePath ? { packagePath: github.packagePath } : {}),
      requestedRef: github.ref,
      resolvedCommit,
    };
  }

  private async requestBytes(
    initialUrl: URL,
    kind: "archive" | "metadata" | "github-page",
    outerSignal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; finalUrl: URL }> {
    let current = parseRemoteUrl(initialUrl.href);
    const visited = new Set<string>();
    const maximumBytes = kind === "archive"
      ? this.limits.maximumDownloadBytes
      : this.limits.maximumMetadataBytes;
    for (let redirects = 0; redirects <= this.limits.maximumRedirects; redirects += 1) {
      if (visited.has(current.href)) {
        throw new AgentSkillInstallerError("source redirect loop detected", "REDIRECT_LOOP");
      }
      visited.add(current.href);
      const request = requestSignal(outerSignal, this.limits.requestTimeoutMs);
      let result: SkillInstallerTransportResult | undefined;
      try {
        const addresses = await abortable(
          resolveStrictPublicAddresses(current.hostname, this.resolveHostname),
          request.signal,
        );
        const fetched = await abortable(this.transport({
          url: current,
          addresses,
          headers: {
            accept: kind === "archive"
              ? "application/zip,application/octet-stream;q=0.8"
              : kind === "github-page"
                ? "text/html,application/xhtml+xml;q=0.9"
                : "application/vnd.github+json,application/json;q=0.9",
            "user-agent": "YourChar-SkillInstaller/1.0",
            ...(kind === "metadata" ? { "x-github-api-version": "2022-11-28" } : {}),
          },
          signal: request.signal,
        }), request.signal);
        result = fetched;
        const response = fetched.response;
        if (isRedirect(response.status)) {
          await response.body?.cancel();
          if (redirects === this.limits.maximumRedirects) {
            throw new AgentSkillInstallerError("source exceeded redirect limit", "TOO_MANY_REDIRECTS");
          }
          const location = response.headers.get("location");
          if (!location) throw new AgentSkillInstallerError("redirect is missing Location", "INVALID_REDIRECT");
          current = parseRemoteUrl(new URL(location, current).href);
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new AgentSkillInstallerError(`source returned HTTP ${response.status}`, "HTTP_ERROR");
        }
        validateContentType(response.headers.get("content-type"), kind);
        const declaredLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
          await response.body?.cancel();
          throw new AgentSkillInstallerError("source response exceeds configured size limit", "DOWNLOAD_TOO_LARGE");
        }
        return {
          bytes: await abortable(readBoundedBody(response, maximumBytes), request.signal),
          finalUrl: current,
        };
      } catch (error) {
        if (error instanceof AgentSkillInstallerError) throw error;
        if (request.signal.aborted) {
          const code = outerSignal?.aborted ? "REQUEST_ABORTED" : "REQUEST_TIMEOUT";
          throw new AgentSkillInstallerError("source request was cancelled or timed out", code, { cause: error });
        }
        throw installerError(error, "source request failed", "REQUEST_FAILED");
      } finally {
        request.dispose();
        try {
          await result?.close?.();
        } catch {
          // Dispatcher cleanup must not replace the request's security result.
        }
      }
    }
    throw new AgentSkillInstallerError("source exceeded redirect limit", "TOO_MANY_REDIRECTS");
  }

  private expireStage(stageId: string): void {
    const stage = this.stages.get(stageId);
    if (!stage) return;
    clearTimeout(stage.timer);
    this.stages.delete(stageId);
    removeOwnedPath(stage.stageDirectory, this.quarantineDirectory);
  }

  private assertSkillNameAvailable(name: string): void {
    if (!this.isSkillNameAvailable) return;
    let available: boolean;
    try {
      available = this.isSkillNameAvailable(name);
    } catch (error) {
      throw installerError(error, "could not verify Skill name availability", "SKILL_NAME_CHECK_FAILED");
    }
    if (!available) {
      throw new AgentSkillInstallerError(
        `Skill name ${name} collides with an existing Agent Skill`,
        "SKILL_NAME_CONFLICT",
      );
    }
  }

  private removeOrphanedStages(): void {
    for (const entry of readdirSync(this.quarantineDirectory, { withFileTypes: true })) {
      if (!stageDirectoryPattern.test(entry.name)) continue;
      removeOwnedPath(join(this.quarantineDirectory, entry.name), this.quarantineDirectory);
    }
  }
}

async function productionTransport(
  request: SkillInstallerTransportRequest,
): Promise<SkillInstallerTransportResult> {
  const dispatcher = createPinnedDispatcher(request.url.hostname, request.addresses);
  try {
    const response = await undiciFetch(request.url, {
      method: "GET",
      redirect: "manual",
      dispatcher,
      headers: request.headers,
      signal: request.signal,
    });
    return {
      response: response as unknown as Response,
      close: () => dispatcher.close(),
    };
  } catch (error) {
    await dispatcher.close();
    throw error;
  }
}

function createPinnedDispatcher(hostname: string, addresses: readonly SkillInstallerResolvedAddress[]): Agent {
  const expectedHostname = hostnameForIp(hostname).toLowerCase();
  let index = 0;
  return new Agent({
    connect: {
      lookup(requestedHostname, options, callback) {
        if (hostnameForIp(requestedHostname).toLowerCase() !== expectedHostname) {
          callback(new Error("validated hostname changed during connection"), "", 0);
          return;
        }
        if (options.all) {
          (callback as unknown as (
            error: null,
            entries: readonly SkillInstallerResolvedAddress[],
          ) => void)(null, addresses);
          return;
        }
        const selected = addresses[index % addresses.length];
        index += 1;
        callback(null, selected.address, selected.family);
      },
    },
  });
}

async function resolveHostname(hostname: string): Promise<SkillInstallerResolvedAddress[]> {
  const plainHostname = hostnameForIp(hostname);
  if (ipaddr.isValid(plainHostname)) {
    const parsed = ipaddr.parse(plainHostname);
    return [{ address: plainHostname, family: parsed.kind() === "ipv4" ? 4 : 6 }];
  }
  const addresses = await lookup(plainHostname, { all: true, verbatim: true });
  return addresses.map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 }));
}

async function resolveStrictPublicAddresses(
  hostname: string,
  resolver: (hostname: string) => Promise<SkillInstallerResolvedAddress[]>,
): Promise<SkillInstallerResolvedAddress[]> {
  const plainHostname = hostnameForIp(hostname).toLowerCase();
  let answers: SkillInstallerResolvedAddress[];
  try {
    answers = await resolver(plainHostname);
  } catch (error) {
    throw installerError(error, "source hostname could not be resolved", "DNS_FAILED");
  }
  if (!answers.length) throw new AgentSkillInstallerError("source hostname did not resolve", "DNS_EMPTY");
  const publicAnswers: SkillInstallerResolvedAddress[] = [];
  const syntheticAnswers: SkillInstallerResolvedAddress[] = [];
  for (const answer of answers) {
    if (!ipaddr.isValid(answer.address)) {
      throw new AgentSkillInstallerError("source hostname resolved to an invalid address", "DNS_INVALID");
    }
    let address = ipaddr.parse(answer.address);
    if (address instanceof ipaddr.IPv6 && address.isIPv4MappedAddress()) address = address.toIPv4Address();
    const family = address.kind() === "ipv4" ? 4 : 6;
    if (answer.family !== family && !(answer.family === 6 && family === 4)) {
      throw new AgentSkillInstallerError("source hostname resolved with an invalid address family", "DNS_INVALID");
    }
    if (isTunSyntheticAddress(address)) {
      syntheticAnswers.push({ address: address.toString(), family });
      continue;
    }
    if (address.range() !== "unicast") {
      throw new AgentSkillInstallerError(
        "private, loopback, link-local, reserved, mixed, or special-use DNS answers are blocked",
        "PRIVATE_ADDRESS",
      );
    }
    publicAnswers.push({ address: address.toString(), family });
  }
  if (syntheticAnswers.length) {
    if (
      ipaddr.isValid(plainHostname)
      || !githubFakeIpHosts.has(plainHostname)
      || !publicAnswers.length
    ) {
      throw new AgentSkillInstallerError(
        "benchmark-range DNS answers are allowed only for pinned GitHub hosts with a public fallback",
        "PRIVATE_ADDRESS",
      );
    }
  }
  const pinned = [...syntheticAnswers, ...publicAnswers];
  return [...new Map(pinned.map((entry) => [`${entry.family}:${entry.address}`, entry])).values()];
}

function isTunSyntheticAddress(address: ipaddr.IPv4 | ipaddr.IPv6): boolean {
  if (!(address instanceof ipaddr.IPv4)) return false;
  const [first, second] = address.octets;
  return first === 198 && (second === 18 || second === 19);
}

function parseRemoteUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch (error) {
    throw new AgentSkillInstallerError("a valid absolute source URL is required", "INVALID_URL", { cause: error });
  }
  if (parsed.protocol !== "https:") {
    throw new AgentSkillInstallerError("Skill sources must use HTTPS", "INVALID_PROTOCOL");
  }
  if (parsed.username || parsed.password) {
    throw new AgentSkillInstallerError("source URL credentials are not allowed", "URL_CREDENTIALS");
  }
  if (parsed.port && parsed.port !== "443") {
    throw new AgentSkillInstallerError("Skill sources must use HTTPS port 443", "INVALID_PORT");
  }
  if (parsed.search || parsed.hash || parsed.href.includes("?") || parsed.href.includes("#")) {
    throw new AgentSkillInstallerError("source URL query strings and fragments are not allowed", "URL_SECRETS");
  }
  if (!parsed.hostname) throw new AgentSkillInstallerError("source URL hostname is required", "INVALID_URL");
  const hostname = hostnameForIp(parsed.hostname).toLowerCase();
  if (
    hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".home.arpa")
  ) {
    throw new AgentSkillInstallerError("local source hostnames are blocked", "PRIVATE_ADDRESS");
  }
  return parsed;
}

function parseGitHubSource(
  url: URL,
  explicitPackagePath: string | undefined,
  limits: SkillInstallerLimits,
): GitHubSource | undefined {
  const hostname = url.hostname.toLowerCase();
  if (hostname !== "github.com" && hostname !== "codeload.github.com") return undefined;
  const parts = decodeUrlPath(url);
  if (parts.length < 4) return undefined;
  const [owner, repository] = parts;
  if (!githubSlug(owner) || !githubSlug(repository)) {
    throw new AgentSkillInstallerError("GitHub owner or repository is invalid", "GITHUB_URL_INVALID");
  }
  let ref: string | undefined;
  let packagePath = explicitPackagePath;
  let treePage: URL | undefined;
  if (hostname === "github.com" && parts[2] === "tree") {
    treePage = url;
    ref = parts[3];
    const treePackagePath = parts.slice(4).join("/");
    if (!treePackagePath) {
      throw new AgentSkillInstallerError("GitHub tree URL must identify a Skill package directory", "GITHUB_URL_INVALID");
    }
    const normalizedTreePath = validateRelativePackagePath(treePackagePath, limits);
    if (packagePath && packagePath !== normalizedTreePath) {
      throw new AgentSkillInstallerError("packagePath conflicts with the GitHub tree URL", "PACKAGE_PATH_CONFLICT");
    }
    packagePath = normalizedTreePath;
  } else if (hostname === "github.com" && parts[2] === "archive") {
    const archiveTail = parts.slice(3).join("/");
    if (!archiveTail.toLowerCase().endsWith(".zip")) return undefined;
    ref = archiveTail.slice(0, -4).replace(/^refs\/(?:heads|tags)\//, "");
  } else if (hostname === "codeload.github.com" && parts[2] === "zip") {
    ref = parts.slice(3).join("/").replace(/^refs\/(?:heads|tags)\//, "");
  } else {
    return undefined;
  }
  if (!ref || ref.length > 255 || /[\x00-\x1f\\]/.test(ref)) {
    throw new AgentSkillInstallerError("GitHub ref is invalid", "GITHUB_URL_INVALID");
  }
  return {
    owner,
    repository,
    ref,
    ...(gitCommitPattern.test(ref.toLowerCase()) ? { commit: ref.toLowerCase() } : {}),
    ...(packagePath ? { packagePath } : {}),
    ...(treePage ? { treePage } : {}),
  };
}

function decodeUrlPath(url: URL): string[] {
  try {
    return url.pathname.split("/").filter(Boolean).map((part) => {
      const decoded = decodeURIComponent(part);
      if (!decoded || decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0")) {
        throw new Error("invalid encoded path segment");
      }
      return decoded;
    });
  } catch (error) {
    throw new AgentSkillInstallerError("source URL path is invalid", "INVALID_URL", { cause: error });
  }
}

function githubSlug(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(value) && value !== "." && value !== "..";
}

function validateRelativePackagePath(value: string, limits: SkillInstallerLimits): string {
  const normalized = validateArchivePath(value, false, limits);
  if (normalized.endsWith("/")) return normalized.slice(0, -1);
  return normalized;
}

function extractPackage(bytes: Uint8Array, packagePath: string | undefined, limits: SkillInstallerLimits): ExtractedPackage {
  const entries = parseZipEntries(bytes, limits);
  const topLevels = new Set(entries.map((entry) => entry.path.split("/")[0]));
  if (topLevels.size !== 1) {
    throw new AgentSkillInstallerError("ZIP must contain exactly one top-level wrapper directory", "PACKAGE_ROOT_INVALID");
  }
  const wrapper = [...topLevels][0];
  if (entries.some((entry) => !entry.directory && entry.path === wrapper)) {
    throw new AgentSkillInstallerError("ZIP top-level package root must be a directory", "PACKAGE_ROOT_INVALID");
  }
  const root = packagePath ? `${wrapper}/${packagePath}` : wrapper;
  const selected = entries.filter((entry) => entry.path.startsWith(`${root}/`));
  if (!selected.length) {
    throw new AgentSkillInstallerError("selected Skill package directory was not found in ZIP", "PACKAGE_NOT_FOUND");
  }
  const selectedFiles = selected.filter((entry) => !entry.directory);
  if (selectedFiles.length > limits.maximumFiles) {
    throw new AgentSkillInstallerError("selected Skill package contains too many files", "ARCHIVE_TOO_MANY_FILES");
  }
  let selectedUnpackedBytes = 0;
  for (const entry of selectedFiles) {
    selectedUnpackedBytes += entry.uncompressedSize;
    if (
      entry.uncompressedSize > limits.maximumEntryBytes
      || selectedUnpackedBytes > limits.maximumUnpackedBytes
      || (entry.uncompressedSize > 0
        && entry.uncompressedSize / Math.max(1, entry.compressedSize) > limits.maximumCompressionRatio)
    ) {
      throw new AgentSkillInstallerError("selected Skill package exceeds expanded-size limits", "ARCHIVE_BOMB");
    }
    if (nestedArchivePattern.test(entry.path)) {
      throw new AgentSkillInstallerError(`nested archive is not allowed: ${entry.path}`, "NESTED_ARCHIVE");
    }
  }
  const relativeEntries = selectedFiles.map((entry) => ({
    entry,
    path: entry.path.slice(root.length + 1),
  }));
  if (!relativeEntries.length || relativeEntries.some((entry) => !entry.path)) {
    throw new AgentSkillInstallerError("selected Skill package contains no files", "PACKAGE_EMPTY");
  }
  const skillEntries = relativeEntries.filter((entry) => basename(entry.path) === "SKILL.md");
  if (skillEntries.length !== 1 || skillEntries[0].path !== "SKILL.md") {
    throw new AgentSkillInstallerError("package must contain exactly one direct SKILL.md and no nested Skill package", "SKILL_FILE_INVALID");
  }

  const files = relativeEntries.map(({ entry, path }) => ({ path, data: decompressEntry(bytes, entry) }));
  for (const file of files) {
    if (nestedArchivePattern.test(file.path) || looksLikeNestedArchive(file.data)) {
      throw new AgentSkillInstallerError(`nested archive is not allowed: ${file.path}`, "NESTED_ARCHIVE");
    }
  }
  const skillFile = files.find((file) => file.path === "SKILL.md");
  if (!skillFile) throw new AgentSkillInstallerError("package SKILL.md is missing", "SKILL_FILE_INVALID");
  if (skillFile.data.byteLength > limits.maximumSkillMarkdownBytes) {
    throw new AgentSkillInstallerError("SKILL.md exceeds the review size limit", "SKILL_TOO_LARGE");
  }
  let skillMarkdown: string;
  try {
    skillMarkdown = utf8Decoder.decode(skillFile.data);
  } catch (error) {
    throw new AgentSkillInstallerError("SKILL.md must be valid UTF-8", "SKILL_MARKDOWN_INVALID", { cause: error });
  }
  const metadata = parseSkillMetadata(skillMarkdown);
  const manifest = files.map((file) => ({
    path: file.path,
    size: file.data.byteLength,
    sha256: sha256(file.data),
  })).sort(compareManifestEntries);
  const unpackedBytes = manifest.reduce((total, entry) => total + entry.size, 0);
  return {
    ...metadata,
    files: files.sort((left, right) => compareText(left.path, right.path)),
    manifest,
    digest: manifestDigest(manifest),
    skillMarkdown,
    unpackedBytes,
  };
}

function parseZipEntries(bytes: Uint8Array, limits: SkillInstallerLimits): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  if (u16(view, eocd + 4) !== 0 || u16(view, eocd + 6) !== 0) {
    throw new AgentSkillInstallerError("multi-disk ZIP archives are not supported", "ZIP_UNSUPPORTED");
  }
  const entriesOnDisk = u16(view, eocd + 8);
  const entryCount = u16(view, eocd + 10);
  const centralSize = u32(view, eocd + 12);
  const centralOffset = u32(view, eocd + 16);
  if (
    entriesOnDisk === 0xffff
    || entryCount === 0xffff
    || centralSize === 0xffffffff
    || centralOffset === 0xffffffff
  ) {
    throw new AgentSkillInstallerError("ZIP64 archives are not supported", "ZIP64_UNSUPPORTED");
  }
  if (entriesOnDisk !== entryCount || entryCount === 0) {
    throw new AgentSkillInstallerError("ZIP central directory is inconsistent", "ZIP_INVALID");
  }
  if (entryCount > maximumCentralDirectoryEntries) {
    throw new AgentSkillInstallerError("ZIP central directory contains too many entries", "ARCHIVE_TOO_MANY_FILES");
  }
  if (centralOffset + centralSize > eocd || centralOffset + centralSize > bytes.byteLength) {
    throw new AgentSkillInstallerError("ZIP central directory is out of bounds", "ZIP_INVALID");
  }

  const entries: ZipEntry[] = [];
  const collisionKeys = new Map<string, { path: string; directory: boolean }>();
  const occupiedRanges: Array<{ start: number; end: number }> = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    requireRange(view, cursor, 46);
    if (u32(view, cursor) !== 0x02014b50) {
      throw new AgentSkillInstallerError("ZIP central directory entry is invalid", "ZIP_INVALID");
    }
    const versionMadeBy = u16(view, cursor + 4);
    const flags = u16(view, cursor + 8);
    const compression = u16(view, cursor + 10);
    const expectedCrc32 = u32(view, cursor + 16);
    const compressedSize = u32(view, cursor + 20);
    const uncompressedSize = u32(view, cursor + 24);
    const nameLength = u16(view, cursor + 28);
    const extraLength = u16(view, cursor + 30);
    const commentLength = u16(view, cursor + 32);
    const diskStart = u16(view, cursor + 34);
    const externalAttributes = u32(view, cursor + 38);
    const localOffset = u32(view, cursor + 42);
    const entryEnd = cursor + 46 + nameLength + extraLength + commentLength;
    requireRange(view, cursor, entryEnd - cursor);
    if (entryEnd > centralOffset + centralSize || diskStart !== 0) {
      throw new AgentSkillInstallerError("ZIP central directory entry is out of bounds", "ZIP_INVALID");
    }
    validateZipFlags(flags);
    if (compression !== 0 && compression !== 8) {
      throw new AgentSkillInstallerError("ZIP compression method is not supported", "ZIP_UNSUPPORTED");
    }
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const decodedName = decodeZipFilename(rawName, Boolean(flags & 0x0800));
    const path = validateArchivePath(decodedName, true, limits);
    const directory = path.endsWith("/");
    validateZipEntryType(versionMadeBy, externalAttributes, directory);
    validateExtraFields(bytes.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength));
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new AgentSkillInstallerError("ZIP64 entries are not supported", "ZIP64_UNSUPPORTED");
    }
    if (directory && (compressedSize !== 0 || uncompressedSize !== 0)) {
      throw new AgentSkillInstallerError("ZIP directory entry contains data", "ZIP_INVALID");
    }
    const collisionKey = path.replace(/\/$/, "").normalize("NFC").toLowerCase();
    if (collisionKeys.has(collisionKey)) {
      throw new AgentSkillInstallerError(`ZIP path collision: ${path}`, "PATH_COLLISION");
    }
    collisionKeys.set(collisionKey, { path, directory });

    requireRange(view, localOffset, 30);
    if (u32(view, localOffset) !== 0x04034b50) {
      throw new AgentSkillInstallerError("ZIP local file header is invalid", "ZIP_INVALID");
    }
    const localFlags = u16(view, localOffset + 6);
    const localCompression = u16(view, localOffset + 8);
    const localNameLength = u16(view, localOffset + 26);
    const localExtraLength = u16(view, localOffset + 28);
    validateZipFlags(localFlags);
    if (localFlags !== flags || localCompression !== compression) {
      throw new AgentSkillInstallerError("ZIP local and central headers disagree", "ZIP_INVALID");
    }
    requireRange(view, localOffset + 30, localNameLength + localExtraLength);
    const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    if (!equalBytes(rawName, localName)) {
      throw new AgentSkillInstallerError("ZIP local and central filenames disagree", "ZIP_INVALID");
    }
    validateExtraFields(bytes.subarray(
      localOffset + 30 + localNameLength,
      localOffset + 30 + localNameLength + localExtraLength,
    ));
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataOffset + compressedSize;
    requireRange(view, dataOffset, compressedSize);
    if (dataEnd > centralOffset) {
      throw new AgentSkillInstallerError("ZIP entry data overlaps its central directory", "ZIP_INVALID");
    }
    occupiedRanges.push({ start: localOffset, end: dataEnd });
    entries.push({
      path,
      directory,
      compression,
      compressedSize,
      uncompressedSize,
      crc32: expectedCrc32,
      dataOffset,
      localOffset,
    });
    cursor = entryEnd;
  }
  if (cursor !== centralOffset + centralSize) {
    throw new AgentSkillInstallerError("ZIP central directory has trailing or missing data", "ZIP_INVALID");
  }
  occupiedRanges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < occupiedRanges.length; index += 1) {
    if (occupiedRanges[index].start < occupiedRanges[index - 1].end) {
      throw new AgentSkillInstallerError("ZIP entries overlap", "ZIP_INVALID");
    }
  }
  const files = [...collisionKeys.values()].filter((entry) => !entry.directory);
  for (const file of files) {
    const fileKey = file.path.toLowerCase();
    if ([...collisionKeys.keys()].some((key) => key.startsWith(`${fileKey}/`))) {
      throw new AgentSkillInstallerError(`ZIP file/directory collision: ${file.path}`, "PATH_COLLISION");
    }
  }
  return entries;
}

function findEndOfCentralDirectory(view: DataView): number {
  const minimum = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (u32(view, offset) !== 0x06054b50) continue;
    requireRange(view, offset, 22);
    const commentLength = u16(view, offset + 20);
    if (offset + 22 + commentLength === view.byteLength) return offset;
  }
  throw new AgentSkillInstallerError("ZIP end-of-central-directory record was not found", "ZIP_INVALID");
}

function validateZipFlags(flags: number): void {
  if (flags & 0x0001 || flags & 0x0040 || flags & 0x2000) {
    throw new AgentSkillInstallerError("encrypted or masked ZIP entries are not allowed", "ZIP_ENCRYPTED");
  }
}

function validateZipEntryType(versionMadeBy: number, externalAttributes: number, directory: boolean): void {
  const platform = versionMadeBy >>> 8;
  const mode = externalAttributes >>> 16;
  const type = mode & 0o170000;
  if (type !== 0 && type !== 0o100000 && type !== 0o040000) {
    throw new AgentSkillInstallerError("ZIP links, devices, sockets, and other special files are not allowed", "ARCHIVE_LINK");
  }
  if (platform === 3 && type !== 0) {
    if (directory !== (type === 0o040000)) {
      throw new AgentSkillInstallerError("ZIP entry type disagrees with its path", "ZIP_INVALID");
    }
  }
  const dosDirectory = Boolean(externalAttributes & 0x10);
  if (dosDirectory && !directory) {
    throw new AgentSkillInstallerError("ZIP directory attribute disagrees with its path", "ZIP_INVALID");
  }
}

function validateExtraFields(extra: Uint8Array): void {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  let cursor = 0;
  while (cursor < extra.byteLength) {
    if (cursor + 4 > extra.byteLength) {
      throw new AgentSkillInstallerError("ZIP extra field is malformed", "ZIP_INVALID");
    }
    const id = u16(view, cursor);
    const size = u16(view, cursor + 2);
    if (cursor + 4 + size > extra.byteLength) {
      throw new AgentSkillInstallerError("ZIP extra field is out of bounds", "ZIP_INVALID");
    }
    if (id === 0x0001) throw new AgentSkillInstallerError("ZIP64 entries are not supported", "ZIP64_UNSUPPORTED");
    if (linkExtraFieldIds.has(id)) {
      throw new AgentSkillInstallerError("ZIP Unix link metadata is not allowed", "ARCHIVE_LINK");
    }
    cursor += 4 + size;
  }
}

function decodeZipFilename(raw: Uint8Array, utf8: boolean): string {
  if (!utf8 && raw.some((value) => value > 0x7f)) {
    throw new AgentSkillInstallerError("non-ASCII ZIP filenames must declare UTF-8", "PATH_INVALID");
  }
  try {
    return utf8Decoder.decode(raw);
  } catch (error) {
    throw new AgentSkillInstallerError("ZIP filename is not valid UTF-8", "PATH_INVALID", { cause: error });
  }
}

function validateArchivePath(value: string, allowDirectory: boolean, limits: SkillInstallerLimits): string {
  if (!value || value.length > limits.maximumPathLength || value.includes("\0")) {
    throw new AgentSkillInstallerError("archive path is empty or too long", "PATH_INVALID");
  }
  if (value !== value.normalize("NFC")) {
    throw new AgentSkillInstallerError("archive paths must use NFC Unicode normalization", "PATH_INVALID");
  }
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value) || value.includes("\\")) {
    throw new AgentSkillInstallerError("absolute and Windows archive paths are not allowed", "PATH_TRAVERSAL");
  }
  const directory = value.endsWith("/");
  if (directory && !allowDirectory) {
    throw new AgentSkillInstallerError("packagePath must identify a directory without a trailing slash", "PACKAGE_PATH_INVALID");
  }
  const body = directory ? value.slice(0, -1) : value;
  const parts = body.split("/");
  if (
    !body
    || parts.length > limits.maximumPathDepth
    || parts.some((part) => !part || part === "." || part === ".." || part.length > 255)
  ) {
    throw new AgentSkillInstallerError("archive path traversal or invalid segment was blocked", "PATH_TRAVERSAL");
  }
  if (parts.some((part) => /[:\x00-\x1f\x7f]/.test(part))) {
    throw new AgentSkillInstallerError("archive path contains a forbidden character", "PATH_INVALID");
  }
  return directory ? `${parts.join("/")}/` : parts.join("/");
}

function decompressEntry(archive: Uint8Array, entry: ZipEntry): Uint8Array {
  const compressed = archive.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  let data: Uint8Array;
  try {
    if (entry.compression === 0) {
      if (entry.compressedSize !== entry.uncompressedSize) {
        throw new Error("stored entry sizes disagree");
      }
      data = Uint8Array.from(compressed);
    } else {
      data = inflateSync(compressed, { out: new Uint8Array(entry.uncompressedSize) });
    }
  } catch (error) {
    throw new AgentSkillInstallerError(`failed to decompress ${entry.path}`, "ZIP_INVALID", { cause: error });
  }
  if (data.byteLength !== entry.uncompressedSize || crc32(data) !== entry.crc32) {
    throw new AgentSkillInstallerError(`ZIP integrity check failed for ${entry.path}`, "ZIP_INTEGRITY");
  }
  return data;
}

function parseSkillMetadata(markdown: string): { name: string; description: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) {
    throw new AgentSkillInstallerError("SKILL.md must begin with YAML frontmatter", "SKILL_MARKDOWN_INVALID");
  }
  const document = parseDocument(match[1], { schema: "core" });
  if (document.errors.length) {
    throw new AgentSkillInstallerError("SKILL.md frontmatter is invalid YAML", "SKILL_MARKDOWN_INVALID", {
      cause: document.errors[0],
    });
  }
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new AgentSkillInstallerError("SKILL.md frontmatter aliases are not allowed", "SKILL_MARKDOWN_INVALID", { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentSkillInstallerError("SKILL.md frontmatter must be a mapping", "SKILL_MARKDOWN_INVALID");
  }
  const record = value as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  if (!skillNamePattern.test(name) || name.length > 64) {
    throw new AgentSkillInstallerError("Skill name must be 1-64 lowercase letters, digits, and single hyphens", "SKILL_NAME_INVALID");
  }
  if (!description || description.length > 1024 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(description)) {
    throw new AgentSkillInstallerError("Skill description must be 1-1024 safe characters", "SKILL_DESCRIPTION_INVALID");
  }
  return { name, description };
}

function materializePackage(root: string, files: Array<{ path: string; data: Uint8Array }>): void {
  const directories = new Set<string>();
  for (const file of files) {
    let parent = dirname(file.path);
    while (parent !== ".") {
      directories.add(parent);
      parent = dirname(parent);
    }
  }
  for (const directory of [...directories].sort((left, right) => {
    const depth = left.split("/").length - right.split("/").length;
    return depth || compareText(left, right);
  })) {
    const target = join(root, ...directory.split("/"));
    mkdirSync(target, { mode: 0o700 });
    chmodSync(target, 0o700);
  }
  for (const file of files) {
    const target = join(root, ...file.path.split("/"));
    writeFileSync(target, file.data, { flag: "wx", mode: 0o600 });
    chmodSync(target, 0o600);
  }
}

function inspectInstalledPackage(root: string, limits: SkillInstallerLimits): {
  manifest: AgentSkillManifestEntry[];
  digest: string;
  directories: string[];
} {
  assertPrivateDirectory(root, "installed Skill");
  const manifest: AgentSkillManifestEntry[] = [];
  const directories: string[] = [];
  let totalBytes = 0;
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      validateArchivePath(relativePath, entry.isDirectory(), limits);
      const target = join(directory, entry.name);
      const stats = lstatSync(target);
      if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
        throw new AgentSkillInstallerError("installed Skill contains a link or special file", "ROLLBACK_CHANGED");
      }
      if (stats.isDirectory()) {
        directories.push(relativePath);
        visit(target, relativePath);
        continue;
      }
      if (stats.size > limits.maximumEntryBytes || manifest.length >= limits.maximumFiles) {
        throw new AgentSkillInstallerError("installed Skill exceeds verification limits", "ROLLBACK_CHANGED");
      }
      totalBytes += stats.size;
      if (totalBytes > limits.maximumUnpackedBytes) {
        throw new AgentSkillInstallerError("installed Skill exceeds verification limits", "ROLLBACK_CHANGED");
      }
      const data = readFileSync(target);
      manifest.push({ path: relativePath, size: data.byteLength, sha256: sha256(data) });
    }
  };
  visit(root, "");
  manifest.sort(compareManifestEntries);
  directories.sort(compareText);
  return { manifest, digest: manifestDigest(manifest), directories };
}

function directoriesForManifest(manifest: readonly AgentSkillManifestEntry[]): string[] {
  const directories = new Set<string>();
  for (const entry of manifest) {
    let parent = dirname(entry.path);
    while (parent !== ".") {
      directories.add(parent);
      parent = dirname(parent);
    }
  }
  return [...directories].sort(compareText);
}

function manifestDigest(manifest: readonly AgentSkillManifestEntry[]): string {
  const canonical = JSON.stringify({ version: 1, files: manifest });
  return sha256(new TextEncoder().encode(canonical));
}

function looksLikeZip(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  const signature = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  return signature === 0x04034b50 || signature === 0x06054b50;
}

function looksLikeNestedArchive(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  const first = bytes.subarray(0, 8);
  return (
    (first[0] === 0x50 && first[1] === 0x4b && (first[2] === 0x03 || first[2] === 0x05 || first[2] === 0x07))
    || (first[0] === 0x1f && first[1] === 0x8b)
    || (first[0] === 0x37 && first[1] === 0x7a && first[2] === 0xbc && first[3] === 0xaf)
    || (first[0] === 0xfd && first[1] === 0x37 && first[2] === 0x7a && first[3] === 0x58)
    || (first[0] === 0x42 && first[1] === 0x5a && first[2] === 0x68)
    || (first[0] === 0x52 && first[1] === 0x61 && first[2] === 0x72 && first[3] === 0x21)
    || (bytes.byteLength >= 262
      && bytes[257] === 0x75
      && bytes[258] === 0x73
      && bytes[259] === 0x74
      && bytes[260] === 0x61
      && bytes[261] === 0x72)
  );
}

function validateContentType(value: string | null, kind: "archive" | "metadata" | "github-page"): void {
  const contentType = value?.split(";", 1)[0].trim().toLowerCase() ?? "";
  if (!contentType) return;
  const allowed = kind === "archive"
    ? new Set(["application/zip", "application/x-zip-compressed", "application/octet-stream"])
    : kind === "github-page"
      ? new Set(["text/html", "application/xhtml+xml"])
      : new Set(["application/json", "application/vnd.github+json"]);
  if (!allowed.has(contentType)) {
    throw new AgentSkillInstallerError(`source returned unsupported content type: ${contentType}`, "CONTENT_TYPE_INVALID");
  }
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new AgentSkillInstallerError("source response exceeds configured size limit", "DOWNLOAD_TOO_LARGE");
    }
    chunks.push(next.value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function requestSignal(outer: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort(outer?.reason);
  if (outer?.aborted) forwardAbort();
  else outer?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("request timeout")), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", forwardAbort);
    },
  };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("request aborted"));
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const abort = (): void => rejectPromise(signal.reason ?? new Error("request aborted"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolvePromise(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        rejectPromise(error);
      },
    );
  });
}

function ensurePrivateDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(path, "installer state");
  chmodSync(path, 0o700);
}

function assertPrivateDirectory(path: string, label: string): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new AgentSkillInstallerError(`${label} path must be a real directory`, "UNSAFE_STATE_DIRECTORY");
  }
}

function removeOwnedPath(path: string, owner: string): void {
  const normalizedOwner = resolve(owner);
  const normalizedPath = resolve(path);
  const nested = relative(normalizedOwner, normalizedPath);
  if (!nested || nested === ".." || nested.startsWith(`..${sep}`)) {
    throw new AgentSkillInstallerError("refusing to remove a path outside installer ownership", "UNSAFE_REMOVE");
  }
  if (!existsSync(normalizedPath)) return;
  const stats = lstatSync(normalizedPath);
  if (stats.isSymbolicLink()) unlinkSync(normalizedPath);
  else rmSync(normalizedPath, { recursive: true, force: false });
}

function validateLimits(limits: SkillInstallerLimits): SkillInstallerLimits {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new AgentSkillInstallerError(`installer limit ${name} must be a positive integer`, "INVALID_LIMITS");
    }
  }
  return Object.freeze({ ...limits });
}

function checkedTimestamp(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 8_640_000_000_000_000) {
    throw new AgentSkillInstallerError(`${label} is outside the supported date range`, "INVALID_CLOCK");
  }
  return value;
}

function normalizeExpectedSha256(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!sha256Pattern.test(normalized)) {
    throw new AgentSkillInstallerError("expectedSha256 must be exactly 64 hexadecimal characters", "DIGEST_INVALID");
  }
  return normalized;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function objectString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function parseGitHubApiCommit(bytes: Uint8Array): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decoder.decode(bytes));
  } catch (error) {
    throw new AgentSkillInstallerError("GitHub commit metadata is invalid JSON", "GITHUB_METADATA_INVALID", {
      cause: error,
    });
  }
  const commit = objectString(parsed, "sha")?.toLowerCase();
  if (!commit || !gitCommitPattern.test(commit)) {
    throw new AgentSkillInstallerError(
      "GitHub commit metadata did not contain an immutable commit SHA",
      "GITHUB_METADATA_INVALID",
    );
  }
  return commit;
}

function parseGitHubTreePageCommit(bytes: Uint8Array): string {
  let html: string;
  try {
    html = utf8Decoder.decode(bytes);
  } catch (error) {
    throw new AgentSkillInstallerError("GitHub tree page is not valid UTF-8", "GITHUB_METADATA_INVALID", {
      cause: error,
    });
  }
  const commits = new Set<string>();
  for (const match of html.matchAll(/["']currentOid["']\s*:\s*["']([0-9a-fA-F]{40})["']/g)) {
    commits.add(match[1].toLowerCase());
  }
  if (commits.size !== 1) {
    throw new AgentSkillInstallerError(
      "GitHub tree page must identify exactly one immutable currentOid",
      "GITHUB_METADATA_INVALID",
    );
  }
  return [...commits][0];
}

function installerError(error: unknown, message: string, code: string): AgentSkillInstallerError {
  return error instanceof AgentSkillInstallerError
    ? error
    : new AgentSkillInstallerError(`${message}: ${errorMessage(error)}`, code, { cause: error });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hostnameForIp(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function requireRange(view: DataView, offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > view.byteLength) {
    throw new AgentSkillInstallerError("ZIP structure is out of bounds", "ZIP_INVALID");
  }
}

function u16(view: DataView, offset: number): number {
  requireRange(view, offset, 2);
  return view.getUint16(offset, true);
}

function u32(view: DataView, offset: number): number {
  requireRange(view, offset, 4);
  return view.getUint32(offset, true);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function compareManifestEntries(left: AgentSkillManifestEntry, right: AgentSkillManifestEntry): number {
  return compareText(left.path, right.path);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function cloneManifest(manifest: readonly AgentSkillManifestEntry[]): AgentSkillManifestEntry[] {
  return manifest.map((entry) => ({ ...entry }));
}

function cloneStageResult(result: AgentSkillStageResult): AgentSkillStageResult {
  return {
    ...result,
    metadata: { ...result.metadata },
    source: { ...result.source },
    manifest: cloneManifest(result.manifest),
  };
}

function cloneReceipt(receipt: AgentSkillInstallReceipt): AgentSkillInstallReceipt {
  return { ...receipt, manifest: cloneManifest(receipt.manifest) };
}

function sameManifest(left: readonly AgentSkillManifestEntry[], right: readonly AgentSkillManifestEntry[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameReceipt(left: AgentSkillInstallReceipt, right: AgentSkillInstallReceipt): boolean {
  return left.installId === right.installId
    && left.name === right.name
    && left.digest === right.digest
    && left.installedAt === right.installedAt
    && sameManifest(left.manifest, right.manifest);
}
