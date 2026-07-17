export class MemoryVaultError extends Error {
  constructor(
    message: string,
    readonly code:
      | "MEMORY_VAULT_INVALID_DOCUMENT"
      | "MEMORY_VAULT_PATH_INVALID"
      | "MEMORY_VAULT_CAS_CONFLICT"
      | "MEMORY_VAULT_DUPLICATE_ID"
      | "MEMORY_VAULT_REBUILD_FAILED"
      | "MEMORY_VAULT_MIGRATION_FAILED"
      | "MEMORY_VAULT_WRITER_BUSY"
      | "MEMORY_VAULT_STALE_WRITER"
      | "MEMORY_VAULT_RECOVERY_FAILED",
  ) {
    super(message);
    this.name = "MemoryVaultError";
  }
}

export class MemoryVaultCasError extends MemoryVaultError {
  constructor(message: string) {
    super(message, "MEMORY_VAULT_CAS_CONFLICT");
    this.name = "MemoryVaultCasError";
  }
}
