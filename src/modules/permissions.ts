import { chmodSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Clock } from "../app/clock.js";
import type { AppDatabase } from "../storage/database.js";
import { shellSandboxAvailability } from "../execution/shell-sandbox.js";
import type {
  AgentPermissions,
  AgentPermissionsPatch,
  WorkspaceAccess,
} from "./types.js";

type SettingRow = { module_id: string; enabled: number };

const permissionKeys = {
  workspaceRead: "permission:workspace-read",
  workspaceWrite: "permission:workspace-write",
  shell: "permission:workspace-shell",
  network: "permission:workspace-network",
  userProfileWrite: "permission:user-profile-write",
  characterSoulWrite: "permission:character-soul-write",
  characterSkillManage: "permission:character-skill-manage",
  realityMemoryWrite: "permission:reality-memory-write",
  characterMemoryWrite: "permission:character-memory-write",
} as const;

export class AgentPermissionCatalog {
  readonly workspaceDir: string;

  constructor(
    private readonly database: AppDatabase,
    private readonly clock: Clock,
    workspaceDir: string,
  ) {
    this.workspaceDir = resolve(workspaceDir);
    mkdirSync(this.workspaceDir, { recursive: true, mode: 0o700 });
    chmodSync(this.workspaceDir, 0o700);
  }

  get(): AgentPermissions {
    const settings = new Map(
      (this.database.connection
        .prepare("SELECT module_id, enabled FROM agent_module_settings WHERE module_id LIKE 'permission:%'")
        .all() as SettingRow[])
        .map((row) => [row.module_id, Boolean(row.enabled)]),
    );
    const hasWorkspaceChoice = settings.has(permissionKeys.workspaceRead) || settings.has(permissionKeys.workspaceWrite);
    const workspaceRead = settings.get(permissionKeys.workspaceRead) ?? !hasWorkspaceChoice;
    const workspaceWrite = settings.get(permissionKeys.workspaceWrite) ?? !hasWorkspaceChoice;
    const sandbox = shellSandboxAvailability();
    const networkPreference = settings.get(permissionKeys.network) ?? true;
    // An existing explicit offline policy must never become an online native
    // shell silently. Such installations re-enable Shell with informed consent.
    const shellEnabled = (settings.get(permissionKeys.shell) ?? false) && (networkPreference || sandbox.networkIsolation);
    return {
      workspaceAccess: workspaceAccessFrom(workspaceRead, workspaceWrite),
      shellEnabled,
      networkEnabled: shellEnabled && networkPreference,
      userProfileWriteEnabled: settings.get(permissionKeys.userProfileWrite) ?? true,
      characterSoulWriteEnabled: settings.get(permissionKeys.characterSoulWrite) ?? false,
      characterSkillManageEnabled: settings.get(permissionKeys.characterSkillManage) ?? false,
      realityMemoryWriteEnabled: settings.get(permissionKeys.realityMemoryWrite) ?? false,
      characterMemoryWriteEnabled: settings.get(permissionKeys.characterMemoryWrite) ?? false,
      workspaceDir: this.workspaceDir,
      shellAvailable: sandbox.available,
      shellBackend: sandbox.backend,
      shellNetworkIsolationAvailable: sandbox.networkIsolation,
      ...(sandbox.reason ? { shellUnavailableReason: sandbox.reason } : {}),
    };
  }

  update(patch: AgentPermissionsPatch): AgentPermissions {
    assertPatch(patch);
    const current = this.get();
    const next = {
      ...current,
      ...patch,
    };
    const storedNetwork = this.database.connection.prepare("SELECT enabled FROM agent_module_settings WHERE module_id = ?")
      .get(permissionKeys.network) as { enabled: number } | undefined;
    const networkPreference = patch.networkEnabled ?? (storedNetwork ? Boolean(storedNetwork.enabled) : true);
    next.networkEnabled = next.shellEnabled && networkPreference;
    if (!next.shellEnabled) next.networkEnabled = false;
    if (next.shellEnabled && !next.shellAvailable) {
      throw new AgentPermissionValidationError(current.shellUnavailableReason ?? "A working sandbox is required before shell execution can be enabled");
    }
    if (patch.networkEnabled === true && !next.shellEnabled) {
      throw new AgentPermissionValidationError("shell execution must be enabled before shell network access");
    }
    if (next.shellEnabled && !networkPreference && !current.shellNetworkIsolationAvailable) {
      throw new AgentPermissionValidationError("This native sandbox uses the host network. Enable shell networking or leave Shell disabled.");
    }

    const access = workspaceFlags(next.workspaceAccess);
    this.database.transaction(() => {
      this.persist(permissionKeys.workspaceRead, access.read);
      this.persist(permissionKeys.workspaceWrite, access.write);
      this.persist(permissionKeys.shell, next.shellEnabled);
      this.persist(permissionKeys.network, networkPreference);
      this.persist(permissionKeys.userProfileWrite, next.userProfileWriteEnabled);
      this.persist(permissionKeys.characterSoulWrite, next.characterSoulWriteEnabled);
      this.persist(permissionKeys.characterSkillManage, next.characterSkillManageEnabled);
      this.persist(permissionKeys.realityMemoryWrite, next.realityMemoryWriteEnabled);
      this.persist(permissionKeys.characterMemoryWrite, next.characterMemoryWriteEnabled);
    });
    return this.get();
  }

  contextStatus(context?: {
    mode?: "sms" | "rp";
    characterId?: string;
    conversationSpace?: "normal" | "secret";
  }): string {
    const permissions = this.get();
    const secret = context?.conversationSpace === "secret";
    const workspace = permissions.workspaceAccess === "off"
      ? "Workspace file access is disabled."
      : permissions.workspaceAccess === "read_only"
        ? "Workspace file access is read-only."
        : "Workspace file access is read-write.";
    const shell = permissions.shellEnabled
      ? `Sandboxed shell execution is enabled; network is ${permissions.networkEnabled ? "enabled" : "disabled"}.`
      : "Sandboxed shell execution is disabled.";
    const profileWrite = secret
      ? "User Profile MCP is unavailable in secret conversation space."
      : permissions.userProfileWriteEnabled
      ? "User Profile MCP writing is authorized when that module is enabled."
      : "User Profile MCP writing is disabled; profile context may still be readable."
    const soulWrite = secret
      ? "Character SOUL.md writing is unavailable in secret conversation space."
      : characterSoulStatus(permissions.characterSoulWriteEnabled, context);
    const characterSkillManage = permissions.characterSkillManageEnabled
      ? context?.characterId
        ? secret
          ? "Current-character Skill creation, activation, revision, and installed private-package toggles are authorized in secret space. Remote Skill installation is unavailable. Changes apply from the next turn and never grant tools or permissions."
          : "Current-character Skill creation, activation, revision, and safety-checked private package installation are authorized through character-bound tools. Changes apply from the next turn and never grant tools or permissions."
        : "Character Skill management is authorized but unavailable because this session has no character."
      : "Character Skill creation and private package management are disabled.";
    const realityMemoryWrite = permissions.realityMemoryWriteEnabled
      ? "Reality memory proposals are authorized. The trusted background Coordinator may auto-capture low-risk facts backed by an exact user quote; sensitive facts remain pending. Confirmation and deletion otherwise remain control-plane only."
      : "Reality memory Agent proposals and automatic daily-fact capture are disabled."
    const characterMemoryWrite = permissions.characterMemoryWriteEnabled
      ? "Current-character RP memory proposals are authorized; confirmation and deletion remain control-plane only."
      : "Character RP memory Agent proposals are disabled."
    return [
      workspace,
      shell,
      profileWrite,
      soulWrite,
      characterSkillManage,
      realityMemoryWrite,
      characterMemoryWrite,
    ]
      .map((status) => `Capability status: ${status}`)
      .join("\n");
  }

  private persist(key: string, enabled: boolean): void {
    this.database.connection.prepare(`
      INSERT INTO agent_module_settings(module_id, enabled, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(module_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at
    `).run(key, enabled ? 1 : 0, this.clock.now().toISOString());
  }
}

function characterSoulStatus(
  enabled: boolean,
  context?: {
    mode?: "sms" | "rp";
    characterId?: string;
    conversationSpace?: "normal" | "secret";
  },
): string {
  if (!enabled) return "Character SOUL.md writing is disabled.";
  if (context?.characterId) {
    return "Current-character SOUL.md reading and writing are available through the character-bound MCP tools.";
  }
  if (context?.mode === "sms" || context?.mode === "rp") {
    return `Character SOUL.md writing is authorized but unavailable because this ${context.mode.toUpperCase()} session has no character. ` +
      "Do not claim to update it; tell the user to create or select a character first.";
  }
  return "Current-character SOUL.md writing is authorized in character-bound SMS and RP sessions.";
}

export class AgentPermissionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentPermissionValidationError";
  }
}

function workspaceAccessFrom(read: boolean, write: boolean): WorkspaceAccess {
  if (write) return "read_write";
  if (read) return "read_only";
  return "off";
}

function workspaceFlags(access: WorkspaceAccess): { read: boolean; write: boolean } {
  return {
    read: access !== "off",
    write: access === "read_write",
  };
}

function assertPatch(patch: AgentPermissionsPatch): void {
  if (
    patch.workspaceAccess !== undefined &&
    !["off", "read_only", "read_write"].includes(patch.workspaceAccess)
  ) {
    throw new AgentPermissionValidationError("workspaceAccess must be off, read_only, or read_write");
  }
  for (const key of [
    "shellEnabled",
    "networkEnabled",
    "userProfileWriteEnabled",
    "characterSoulWriteEnabled",
    "characterSkillManageEnabled",
    "realityMemoryWriteEnabled",
    "characterMemoryWriteEnabled",
  ] as const) {
    if (patch[key] !== undefined && typeof patch[key] !== "boolean") {
      throw new AgentPermissionValidationError(`${key} must be a boolean`);
    }
  }
}
