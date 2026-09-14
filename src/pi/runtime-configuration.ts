import { createHash } from "node:crypto";
import type { Clock } from "../app/clock.js";
import {
  builtinMcpModuleContributions,
  normalizeAgentMcpModuleContributions,
} from "../modules/catalog.js";
import type { AgentMcpModuleContribution } from "../modules/types.js";
import type { AppDatabase } from "../storage/database.js";
import { builtinSessionCapabilityDescriptorList } from "./builtin-mcp-capabilities.js";
import {
  SessionCapabilityRegistry,
  type SessionCapability,
  type SessionCapabilityDescriptor,
} from "./session-capability.js";

const runtimeIdPattern = /^[a-z0-9][a-z0-9._/-]{0,63}$/u;
const builtinPackageId = "builtin-core";
const legacyPackageId = "deployment-legacy";
const defaultProfileId = "default";
const maximumPackages = 32;
const maximumProfiles = 32;
const maximumCapabilitiesPerPackage = 32;
const maximumAdditionalCapabilities = 128;

export type AgentCapabilityPackage = Readonly<{
  id: string;
  name: string;
  version: string;
  /** SHA-256 of the reviewed package artifact; drives reload identity. */
  contentDigest: string;
  /** A display-safe provenance label, never a credential-bearing URL. */
  source: string;
  /** Must be explicitly true before a profile may activate this package. */
  trusted: boolean;
  capabilities: readonly SessionCapability[];
}>;

export type AgentRuntimeProfileDefinition = Readonly<{
  id: string;
  name: string;
  description: string;
  /** Optional packages; built-ins and legacy deployment capabilities are inherited. */
  packageIds: readonly string[];
}>;

export type AgentRuntimeConfigurationInput = Readonly<{
  packages?: readonly AgentCapabilityPackage[];
  profiles?: readonly AgentRuntimeProfileDefinition[];
  activeProfileId?: string;
}>;

export type AgentRuntimePackageSnapshot = Readonly<{
  id: string;
  name: string;
  version: string;
  contentDigest: string;
  source: string;
  trust: "built_in" | "deployment_trusted" | "trusted" | "untrusted";
  active: boolean;
  capabilities: readonly SessionCapabilityDescriptor[];
  moduleIds: readonly string[];
}>;

export type AgentRuntimeProfileSnapshot = Readonly<{
  id: string;
  name: string;
  description: string;
  packageIds: readonly string[];
  active: boolean;
}>;

export type AgentRuntimeConfigurationSnapshot = Readonly<{
  schemaVersion: 1;
  revision: number;
  digest: string;
  resolvedAt: string;
  activeProfileId: string;
  profiles: readonly AgentRuntimeProfileSnapshot[];
  packages: readonly AgentRuntimePackageSnapshot[];
  activeCapabilities: readonly SessionCapabilityDescriptor[];
}>;

type NormalizedAgentCapabilityPackage = Readonly<{
  id: string;
  name: string;
  version: string;
  contentDigest: string;
  source: string;
  trusted: boolean;
  capabilities: readonly SessionCapability[];
}>;

type NormalizedAgentRuntimeProfile = Readonly<{
  id: string;
  name: string;
  description: string;
  packageIds: readonly string[];
}>;

export type PreparedAgentRuntimeConfiguration = Readonly<{
  activeProfileId: string;
  packages: readonly NormalizedAgentCapabilityPackage[];
  profiles: readonly NormalizedAgentRuntimeProfile[];
  legacyCapabilities: readonly SessionCapability[];
  activeCapabilities: readonly SessionCapability[];
  activeModuleContributions: readonly AgentMcpModuleContribution[];
  core: Omit<AgentRuntimeConfigurationSnapshot, "revision" | "resolvedAt">;
}>;

type StoredSnapshotRow = {
  revision: number;
  digest: string;
  snapshot_json: string;
  updated_at: string;
};

export class AgentRuntimeConfigurationError extends Error {
  readonly code = "AGENT_RUNTIME_CONFIGURATION_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "AgentRuntimeConfigurationError";
  }
}

/**
 * Owns the deployment-trusted capability graph. Persisted snapshots contain
 * descriptors only: executable mount functions are supplied again by the host
 * on every process start and are never restored from SQLite.
 */
export class AgentRuntimeConfigurationManager {
  private readonly repository: AgentRuntimeConfigurationRepository;
  private current: PreparedAgentRuntimeConfiguration;
  private snapshot: AgentRuntimeConfigurationSnapshot;

  constructor(
    database: AppDatabase,
    clock: Clock,
    legacyCapabilities: readonly SessionCapability[] = [],
    input: AgentRuntimeConfigurationInput = {},
  ) {
    this.repository = new AgentRuntimeConfigurationRepository(database, clock);
    const persistedProfileId = input.activeProfileId === undefined
      ? this.repository.persistedActiveProfileId()
      : undefined;
    try {
      this.current = resolveAgentRuntimeConfiguration(
        legacyCapabilities,
        input,
        input.activeProfileId ?? persistedProfileId,
      );
    } catch (error) {
      if (
        input.activeProfileId !== undefined ||
        persistedProfileId === undefined ||
        !(error instanceof AgentRuntimeConfigurationError) ||
        !error.message.startsWith("unknown active runtime profile:")
      ) throw error;
      // A persisted selection is data, not authority. If the host no longer
      // registers that profile, fall back to the currently declared default.
      this.current = resolveAgentRuntimeConfiguration(legacyCapabilities, input);
    }
    this.snapshot = this.repository.persist(this.current.core);
  }

  get(): AgentRuntimeConfigurationSnapshot {
    return this.snapshot;
  }

  activeCapabilities(): readonly SessionCapability[] {
    return this.current.activeCapabilities;
  }

  isolatedTaskBenchCapabilities(): readonly SessionCapability[] {
    return Object.freeze(this.current.activeCapabilities.filter(
      (capability) => capability.allowInIsolatedTaskBench === true,
    ));
  }

  activeModuleContributions(): readonly AgentMcpModuleContribution[] {
    return this.current.activeModuleContributions;
  }

  prepareReload(input: AgentRuntimeConfigurationInput): PreparedAgentRuntimeConfiguration {
    return resolveAgentRuntimeConfiguration(
      this.current.legacyCapabilities,
      input,
      input.activeProfileId ?? this.current.activeProfileId,
    );
  }

  prepareProfileActivation(profileId: string): PreparedAgentRuntimeConfiguration {
    return resolveAgentRuntimeConfiguration(
      this.current.legacyCapabilities,
      {
        packages: this.current.packages,
        profiles: this.current.profiles,
        activeProfileId: profileId,
      },
      profileId,
    );
  }

  commit(prepared: PreparedAgentRuntimeConfiguration): AgentRuntimeConfigurationSnapshot {
    const snapshot = this.repository.persist(prepared.core);
    this.current = prepared;
    this.snapshot = snapshot;
    return snapshot;
  }
}

function resolveAgentRuntimeConfiguration(
  legacyCapabilitiesInput: readonly SessionCapability[],
  input: AgentRuntimeConfigurationInput,
  preferredProfileId?: string,
): PreparedAgentRuntimeConfiguration {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AgentRuntimeConfigurationError("runtime configuration must be an object");
  }
  if (input.packages !== undefined && !Array.isArray(input.packages)) {
    throw new AgentRuntimeConfigurationError("runtime packages must be an array");
  }
  if (input.profiles !== undefined && !Array.isArray(input.profiles)) {
    throw new AgentRuntimeConfigurationError("runtime profiles must be an array");
  }
  const rawPackages = normalizePackageShells(input.packages ?? []);
  const rawLegacyCapabilities = cloneCapabilityShells(
    legacyCapabilitiesInput,
    "legacy deployment capabilities",
  );
  const allAdditionalCapabilities = [
    ...rawLegacyCapabilities,
    ...rawPackages.flatMap((entry) => entry.capabilities),
  ];
  if (allAdditionalCapabilities.length > maximumAdditionalCapabilities) {
    throw new AgentRuntimeConfigurationError(
      `runtime configuration exceeds ${maximumAdditionalCapabilities} additional capabilities`,
    );
  }
  validateCapabilityOwnership(allAdditionalCapabilities);

  const normalizedContributions = normalizeAgentMcpModuleContributions([
    ...builtinMcpModuleContributions,
    ...allAdditionalCapabilities.flatMap((capability) => capability.moduleContribution
      ? [capability.moduleContribution]
      : []),
  ]);
  const contributedById = new Map(
    normalizedContributions
      .slice(builtinMcpModuleContributions.length)
      .map((contribution) => [contribution.id, contribution]),
  );
  const normalizeCapability = (capability: SessionCapability): SessionCapability =>
    freezeCapability(capability, contributedById);
  const legacyCapabilities = Object.freeze(rawLegacyCapabilities.map(normalizeCapability));
  const packages = Object.freeze(rawPackages.map((entry) => Object.freeze({
    ...entry,
    capabilities: Object.freeze(entry.capabilities.map(normalizeCapability)),
  })));
  // Re-run ownership validation against the detached immutable graph that will
  // actually be used after the caller's objects go out of scope.
  validateCapabilityOwnership([
    ...legacyCapabilities,
    ...packages.flatMap((entry) => entry.capabilities),
  ]);

  const profiles = normalizeProfiles(input.profiles, packages);
  const requestedProfileId = boundedOptionalId(
    input.activeProfileId ?? preferredProfileId,
    "active runtime profile id",
  );
  const activeProfile = requestedProfileId
    ? profiles.find((profile) => profile.id === requestedProfileId)
    : profiles.find((profile) => profile.id === defaultProfileId);
  if (!activeProfile) {
    if (requestedProfileId) {
      throw new AgentRuntimeConfigurationError(
        `unknown active runtime profile: ${requestedProfileId}`,
      );
    }
    throw new AgentRuntimeConfigurationError(
      "activeProfileId is required when runtime profiles do not include default",
    );
  }
  const packageById = new Map(packages.map((entry) => [entry.id, entry]));
  const selectedPackages = activeProfile.packageIds.map((id) => packageById.get(id)!);
  const activeCapabilitiesInput = [
    ...legacyCapabilities,
    ...selectedPackages.flatMap((entry) => entry.capabilities),
  ];
  const activeRegistry = new SessionCapabilityRegistry(activeCapabilitiesInput);
  const activeCapabilityById = new Map(
    activeCapabilitiesInput.map((capability) => [capability.id, capability]),
  );
  const activeCapabilities = Object.freeze(activeRegistry.list().map((descriptor) => {
    const capability = activeCapabilityById.get(descriptor.id)!;
    return Object.freeze({ ...capability, order: descriptor.order });
  }));
  const activeModuleContributions = Object.freeze(activeCapabilities.flatMap((capability) =>
    capability.moduleContribution ? [capability.moduleContribution] : []
  ));

  const activePackageIds = new Set([
    builtinPackageId,
    ...(legacyCapabilities.length ? [legacyPackageId] : []),
    ...activeProfile.packageIds,
  ]);
  const packageSnapshots = Object.freeze([
    packageSnapshot({
      id: builtinPackageId,
      name: "YourChar Built-in Capabilities",
      version: "1",
      contentDigest: digestDescriptors(builtinSessionCapabilityDescriptorList),
      source: "YourChar",
      trust: "built_in",
      active: true,
      capabilities: builtinSessionCapabilityDescriptorList,
    }),
    ...(legacyCapabilities.length
      ? [packageSnapshot({
          id: legacyPackageId,
          name: "Legacy Deployment Capabilities",
          version: "unversioned",
          contentDigest: digestDescriptors(
            new SessionCapabilityRegistry(legacyCapabilities).list(),
          ),
          source: "CompanionKernelOptions",
          trust: "deployment_trusted",
          active: true,
          capabilities: new SessionCapabilityRegistry(legacyCapabilities).list(),
        })]
      : []),
    ...packages.map((entry) => packageSnapshot({
      id: entry.id,
      name: entry.name,
      version: entry.version,
      contentDigest: entry.contentDigest,
      source: entry.source,
      trust: entry.trusted ? "trusted" : "untrusted",
      active: activePackageIds.has(entry.id),
      capabilities: new SessionCapabilityRegistry(entry.capabilities).list(),
    })),
  ].sort((left, right) => left.id.localeCompare(right.id)));
  const profileSnapshots = Object.freeze(profiles.map((profile) => Object.freeze({
    id: profile.id,
    name: profile.name,
    description: profile.description,
    packageIds: Object.freeze([
      builtinPackageId,
      ...(legacyCapabilities.length ? [legacyPackageId] : []),
      ...profile.packageIds,
    ]),
    active: profile.id === activeProfile.id,
  })).sort((left, right) => left.id.localeCompare(right.id)));
  const activeCapabilityDescriptors = Object.freeze([
    ...builtinSessionCapabilityDescriptorList,
    ...activeRegistry.list(),
  ].sort(compareCapabilityDescriptors));
  const unsignedCore = Object.freeze({
    schemaVersion: 1 as const,
    activeProfileId: activeProfile.id,
    profiles: profileSnapshots,
    packages: packageSnapshots,
    activeCapabilities: activeCapabilityDescriptors,
  });
  const digest = createHash("sha256").update(JSON.stringify(unsignedCore)).digest("hex");
  const core = Object.freeze({ ...unsignedCore, digest });

  return Object.freeze({
    activeProfileId: activeProfile.id,
    packages,
    profiles,
    legacyCapabilities,
    activeCapabilities,
    activeModuleContributions,
    core,
  });
}

function normalizePackageShells(
  input: readonly AgentCapabilityPackage[],
): readonly NormalizedAgentCapabilityPackage[] {
  if (input.length > maximumPackages) {
    throw new AgentRuntimeConfigurationError(`runtime packages exceed ${maximumPackages}`);
  }
  const ids = new Set<string>([builtinPackageId, legacyPackageId]);
  return input.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new AgentRuntimeConfigurationError("runtime package must be an object");
    }
    const id = boundedId(entry.id, "runtime package id");
    if (ids.has(id)) {
      throw new AgentRuntimeConfigurationError(`duplicate or reserved runtime package id: ${id}`);
    }
    ids.add(id);
    if (typeof entry.trusted !== "boolean") {
      throw new AgentRuntimeConfigurationError(`runtime package ${id} trusted must be boolean`);
    }
    if (!Array.isArray(entry.capabilities) || !entry.capabilities.length) {
      throw new AgentRuntimeConfigurationError(
        `runtime package ${id} must contain at least one capability`,
      );
    }
    if (entry.capabilities.length > maximumCapabilitiesPerPackage) {
      throw new AgentRuntimeConfigurationError(
        `runtime package ${id} exceeds ${maximumCapabilitiesPerPackage} capabilities`,
      );
    }
    return Object.freeze({
      id,
      name: boundedString(entry.name, `runtime package ${id} name`, 200),
      version: boundedString(entry.version, `runtime package ${id} version`, 100),
      contentDigest: boundedSha256(
        entry.contentDigest,
        `runtime package ${id} contentDigest`,
      ),
      source: boundedString(entry.source, `runtime package ${id} source`, 500),
      trusted: entry.trusted,
      capabilities: cloneCapabilityShells(entry.capabilities, `runtime package ${id}`),
    });
  });
}

function normalizeProfiles(
  input: readonly AgentRuntimeProfileDefinition[] | undefined,
  packages: readonly NormalizedAgentCapabilityPackage[],
): readonly NormalizedAgentRuntimeProfile[] {
  if (input === undefined) {
    return Object.freeze([Object.freeze({
      id: defaultProfileId,
      name: "Default",
      description: "YourChar built-ins and deployment-trusted legacy capabilities.",
      packageIds: Object.freeze([]),
    })]);
  }
  if (!input.length) {
    throw new AgentRuntimeConfigurationError("runtime profiles must not be empty");
  }
  if (input.length > maximumProfiles) {
    throw new AgentRuntimeConfigurationError(`runtime profiles exceed ${maximumProfiles}`);
  }
  const packageById = new Map(packages.map((entry) => [entry.id, entry]));
  const ids = new Set<string>();
  return Object.freeze(input.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new AgentRuntimeConfigurationError("runtime profile must be an object");
    }
    const id = boundedId(entry.id, "runtime profile id");
    if (ids.has(id)) {
      throw new AgentRuntimeConfigurationError(`duplicate runtime profile id: ${id}`);
    }
    ids.add(id);
    if (!Array.isArray(entry.packageIds)) {
      throw new AgentRuntimeConfigurationError(`runtime profile ${id} packageIds must be an array`);
    }
    const packageIds = entry.packageIds.map((packageId) =>
      boundedId(packageId, `runtime profile ${id} package id`)
    );
    if (new Set(packageIds).size !== packageIds.length) {
      throw new AgentRuntimeConfigurationError(
        `runtime profile ${id} contains duplicate package ids`,
      );
    }
    for (const packageId of packageIds) {
      if (packageId === builtinPackageId || packageId === legacyPackageId) {
        throw new AgentRuntimeConfigurationError(
          `runtime profile ${id} must not explicitly reference inherited package ${packageId}`,
        );
      }
      const target = packageById.get(packageId);
      if (!target) {
        throw new AgentRuntimeConfigurationError(
          `runtime profile ${id} references unknown package ${packageId}`,
        );
      }
      if (!target.trusted) {
        throw new AgentRuntimeConfigurationError(
          `runtime profile ${id} cannot activate untrusted package ${packageId}`,
        );
      }
    }
    return Object.freeze({
      id,
      name: boundedString(entry.name, `runtime profile ${id} name`, 200),
      description: boundedString(entry.description, `runtime profile ${id} description`, 2_000),
      packageIds: Object.freeze([...packageIds]),
    });
  }));
}

function validateCapabilityOwnership(capabilities: readonly SessionCapability[]): void {
  const builtinCapabilityIds = new Set(
    builtinSessionCapabilityDescriptorList.map((entry) => entry.id),
  );
  const builtinModuleIds = new Set(
    builtinSessionCapabilityDescriptorList.flatMap((entry) => entry.moduleId ? [entry.moduleId] : []),
  );
  for (const capability of capabilities) {
    if (builtinCapabilityIds.has(capability.id)) {
      throw new AgentRuntimeConfigurationError(
        `additional capability cannot shadow built-in capability ${capability.id}`,
      );
    }
    const moduleId = capability.moduleId ?? capability.moduleContribution?.id;
    if (moduleId && builtinModuleIds.has(moduleId)) {
      throw new AgentRuntimeConfigurationError(
        `additional capability cannot bind built-in module ${moduleId}`,
      );
    }
  }
  try {
    new SessionCapabilityRegistry(capabilities);
  } catch (error) {
    throw new AgentRuntimeConfigurationError(
      error instanceof Error ? error.message : "invalid session capability graph",
    );
  }
}

function cloneCapabilityShells(
  capabilities: readonly SessionCapability[],
  label: string,
): readonly SessionCapability[] {
  if (!Array.isArray(capabilities)) {
    throw new AgentRuntimeConfigurationError(`${label} must be an array`);
  }
  return Object.freeze(capabilities.map((capability) => Object.freeze({
    id: capability?.id,
    ...(capability?.order === undefined ? {} : { order: capability.order }),
    ...(capability?.moduleId === undefined ? {} : { moduleId: capability.moduleId }),
    ...(capability?.moduleContribution === undefined
      ? {}
      : { moduleContribution: capability.moduleContribution }),
    ...(capability?.allowInIsolatedTaskBench === true
      ? { allowInIsolatedTaskBench: true as const }
      : {}),
    mount: capability?.mount,
  }) as SessionCapability));
}

function freezeCapability(
  capability: SessionCapability,
  contributedById: ReadonlyMap<string, AgentMcpModuleContribution>,
): SessionCapability {
  const contributionId = capability.moduleContribution?.id;
  const contribution = contributionId ? contributedById.get(contributionId) : undefined;
  if (contributionId && !contribution) {
    throw new AgentRuntimeConfigurationError(
      `normalized module contribution is unavailable: ${contributionId}`,
    );
  }
  return Object.freeze({
    id: capability.id,
    ...(capability.order === undefined ? {} : { order: capability.order }),
    ...(capability.moduleId === undefined ? {} : { moduleId: capability.moduleId }),
    ...(contribution ? { moduleContribution: contribution } : {}),
    ...(capability.allowInIsolatedTaskBench === true
      ? { allowInIsolatedTaskBench: true as const }
      : {}),
    mount: capability.mount,
  });
}

function packageSnapshot(input: Omit<AgentRuntimePackageSnapshot, "moduleIds">) {
  return Object.freeze({
    ...input,
    capabilities: Object.freeze(input.capabilities.map((entry) => Object.freeze({ ...entry }))),
    moduleIds: Object.freeze(input.capabilities.flatMap((entry) => entry.moduleId ? [entry.moduleId] : [])),
  });
}

function compareCapabilityDescriptors(
  left: SessionCapabilityDescriptor,
  right: SessionCapabilityDescriptor,
): number {
  return left.order - right.order || left.id.localeCompare(right.id);
}

function digestDescriptors(descriptors: readonly SessionCapabilityDescriptor[]): string {
  return createHash("sha256").update(JSON.stringify(descriptors)).digest("hex");
}

function boundedId(value: unknown, field: string): string {
  const id = boundedString(value, field, 64);
  if (!runtimeIdPattern.test(id)) {
    throw new AgentRuntimeConfigurationError(`invalid ${field}: ${id}`);
  }
  return id;
}

function boundedOptionalId(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : boundedId(value, field);
}

function boundedSha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new AgentRuntimeConfigurationError(`${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function boundedString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new AgentRuntimeConfigurationError(`${field} must be a non-empty trimmed string`);
  }
  if ([...value].length > maximum) {
    throw new AgentRuntimeConfigurationError(`${field} exceeds ${maximum} characters`);
  }
  return value;
}

class AgentRuntimeConfigurationRepository {
  constructor(
    private readonly database: AppDatabase,
    private readonly clock: Clock,
  ) {}

  persistedActiveProfileId(): string | undefined {
    const row = this.read();
    if (!row) return undefined;
    try {
      const parsed = JSON.parse(row.snapshot_json) as { activeProfileId?: unknown };
      return typeof parsed.activeProfileId === "string" ? parsed.activeProfileId : undefined;
    } catch {
      return undefined;
    }
  }

  persist(
    core: Omit<AgentRuntimeConfigurationSnapshot, "revision" | "resolvedAt">,
  ): AgentRuntimeConfigurationSnapshot {
    const existing = this.read();
    if (existing?.digest === core.digest) {
      return Object.freeze({
        ...core,
        revision: Number(existing.revision),
        resolvedAt: existing.updated_at,
      });
    }
    const revision = (existing ? Number(existing.revision) : 0) + 1;
    const resolvedAt = this.clock.now().toISOString();
    const snapshot = Object.freeze({ ...core, revision, resolvedAt });
    this.database.connection.prepare(`
      INSERT INTO agent_runtime_configuration_snapshots(
        singleton, revision, digest, snapshot_json, updated_at
      ) VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        revision = excluded.revision,
        digest = excluded.digest,
        snapshot_json = excluded.snapshot_json,
        updated_at = excluded.updated_at
    `).run(revision, core.digest, JSON.stringify(snapshot), resolvedAt);
    return snapshot;
  }

  private read(): StoredSnapshotRow | undefined {
    return this.database.connection.prepare(`
      SELECT revision, digest, snapshot_json, updated_at
      FROM agent_runtime_configuration_snapshots
      WHERE singleton = 1
    `).get() as StoredSnapshotRow | undefined;
  }
}
