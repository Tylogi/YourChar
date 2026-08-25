import type { AppDatabase } from "../storage/database.js";
import type { ConversationSpace } from "../domain/types.js";
import type {
  CharacterCollaborationProfile,
  CharacterOwnedSkillEvaluation,
  CharacterOwnedSkillPackage,
  CharacterOwnedSkillProposal,
  CharacterOwnedSkillVersion,
} from "./types.js";

type Row = Record<string, unknown>;

export class CharacterCapabilityRepository {
  constructor(readonly database: AppDatabase) {}

  transaction<T>(operation: () => T): T {
    return this.database.transaction(operation);
  }

  getCollaborationProfile(characterId: string): CharacterCollaborationProfile | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM character_collaboration_profiles WHERE character_id = ?
    `).get(characterId) as Row | undefined;
    return row ? mapCollaborationProfile(row) : undefined;
  }

  upsertCollaborationProfile(
    profile: CharacterCollaborationProfile,
  ): CharacterCollaborationProfile {
    this.database.connection.prepare(`
      INSERT INTO character_collaboration_profiles(
        character_id, introduction, traits_json, max_concurrent_tasks,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(character_id) DO UPDATE SET
        introduction = excluded.introduction,
        traits_json = excluded.traits_json,
        max_concurrent_tasks = excluded.max_concurrent_tasks,
        updated_at = excluded.updated_at
    `).run(
      profile.characterId,
      profile.introduction,
      JSON.stringify(profile.traits),
      profile.maxConcurrentTasks,
      profile.createdAt,
      profile.updatedAt,
    );
    return this.getCollaborationProfile(profile.characterId)!;
  }

  countActiveTasks(characterId: string): number {
    const row = this.database.connection.prepare(`
      SELECT COUNT(*) AS count
      FROM character_channel_episodes
      WHERE target_character_id = ?
        AND kind = 'collaboration'
        AND status IN ('queued', 'running')
    `).get(characterId) as Row;
    return Number(row.count ?? 0);
  }

  listOwnedSkills(
    characterId: string,
    conversationSpace: ConversationSpace,
  ): CharacterOwnedSkillPackage[] {
    return (this.database.connection.prepare(`
      SELECT
        package.*,
        active.id AS active_version_id,
        active.version AS active_version,
        active.status AS active_version_status,
        active.markdown AS active_version_markdown,
        active.change_summary AS active_version_change_summary,
        active.source AS active_version_source,
        active.source_task_id AS active_version_source_task_id,
        active.content_hash AS active_version_content_hash,
        active.created_at AS active_version_created_at,
        active.activated_at AS active_version_activated_at,
        active.superseded_at AS active_version_superseded_at,
        (SELECT COUNT(*) FROM character_owned_skill_versions version
          WHERE version.package_id = package.id) AS version_count,
        (SELECT COUNT(*) FROM character_owned_skill_evaluations evaluation
          WHERE evaluation.package_id = package.id) AS evaluation_count,
        (SELECT COUNT(*) FROM character_owned_skill_evaluations evaluation
          WHERE evaluation.package_id = package.id AND evaluation.outcome = 'completed') AS completed_count,
        (SELECT COUNT(*) FROM character_owned_skill_evaluations evaluation
          WHERE evaluation.package_id = package.id AND evaluation.outcome = 'failed') AS failed_count,
        (SELECT AVG(score) FROM character_owned_skill_evaluations evaluation
          WHERE evaluation.package_id = package.id AND evaluation.score IS NOT NULL) AS average_score,
        (SELECT COUNT(*) FROM character_owned_skill_proposals proposal
          WHERE proposal.package_id = package.id AND proposal.status = 'pending') AS pending_proposal_count
      FROM character_owned_skill_packages package
      LEFT JOIN character_owned_skill_versions active
        ON active.package_id = package.id AND active.status = 'active'
      WHERE package.character_id = ? AND package.conversation_space = ?
      ORDER BY
        CASE package.status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
        package.updated_at DESC,
        package.id
    `).all(characterId, conversationSpace) as Row[]).map(mapOwnedSkillPackage);
  }

  getOwnedSkill(
    characterId: string,
    conversationSpace: ConversationSpace,
    packageId: string,
  ): CharacterOwnedSkillPackage | undefined {
    return this.listOwnedSkills(characterId, conversationSpace)
      .find((entry) => entry.id === packageId);
  }

  findOwnedSkillBySlug(
    characterId: string,
    conversationSpace: ConversationSpace,
    slug: string,
  ): CharacterOwnedSkillPackage | undefined {
    return this.listOwnedSkills(characterId, conversationSpace)
      .find((entry) => entry.slug === slug);
  }

  insertOwnedSkillPackage(skill: CharacterOwnedSkillPackage): void {
    this.database.connection.prepare(`
      INSERT INTO character_owned_skill_packages(
        id, character_id, conversation_space, slug, name, description,
        tags_json, capability_ids_json, status, auto_improve, created_by,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      skill.id,
      skill.characterId,
      skill.conversationSpace,
      skill.slug,
      skill.name,
      skill.description,
      JSON.stringify(skill.tags),
      "[]",
      skill.status,
      skill.autoImprove ? 1 : 0,
      skill.createdBy,
      skill.createdAt,
      skill.updatedAt,
    );
  }

  updateOwnedSkillPackage(skill: CharacterOwnedSkillPackage): void {
    this.database.connection.prepare(`
      UPDATE character_owned_skill_packages
      SET name = ?, description = ?, tags_json = ?, capability_ids_json = ?,
          status = ?, auto_improve = ?, updated_at = ?
      WHERE id = ? AND character_id = ? AND conversation_space = ?
    `).run(
      skill.name,
      skill.description,
      JSON.stringify(skill.tags),
      "[]",
      skill.status,
      skill.autoImprove ? 1 : 0,
      skill.updatedAt,
      skill.id,
      skill.characterId,
      skill.conversationSpace,
    );
  }

  listOwnedSkillVersions(packageId: string, limit = 100): CharacterOwnedSkillVersion[] {
    const bounded = Math.max(1, Math.min(Math.floor(limit), 500));
    return (this.database.connection.prepare(`
      SELECT * FROM character_owned_skill_versions
      WHERE package_id = ?
      ORDER BY version DESC
      LIMIT ?
    `).all(packageId, bounded) as Row[]).map(mapOwnedSkillVersion);
  }

  getOwnedSkillVersion(packageId: string, versionId: string): CharacterOwnedSkillVersion | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM character_owned_skill_versions
      WHERE package_id = ? AND id = ?
    `).get(packageId, versionId) as Row | undefined;
    return row ? mapOwnedSkillVersion(row) : undefined;
  }

  getActiveOwnedSkillVersion(packageId: string): CharacterOwnedSkillVersion | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM character_owned_skill_versions
      WHERE package_id = ? AND status = 'active'
      LIMIT 1
    `).get(packageId) as Row | undefined;
    return row ? mapOwnedSkillVersion(row) : undefined;
  }

  findOwnedSkillVersionBySourceTask(
    packageId: string,
    sourceTaskId: string,
  ): CharacterOwnedSkillVersion | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM character_owned_skill_versions
      WHERE package_id = ? AND source_task_id = ?
      LIMIT 1
    `).get(packageId, sourceTaskId) as Row | undefined;
    return row ? mapOwnedSkillVersion(row) : undefined;
  }

  nextOwnedSkillVersion(packageId: string): number {
    const row = this.database.connection.prepare(`
      SELECT COALESCE(MAX(version), 0) + 1 AS version
      FROM character_owned_skill_versions
      WHERE package_id = ?
    `).get(packageId) as Row;
    return Number(row.version ?? 1);
  }

  supersedeActiveOwnedSkillVersion(packageId: string, supersededAt: string): void {
    this.database.connection.prepare(`
      UPDATE character_owned_skill_versions
      SET status = 'superseded', superseded_at = ?
      WHERE package_id = ? AND status = 'active'
    `).run(supersededAt, packageId);
  }

  insertOwnedSkillVersion(version: CharacterOwnedSkillVersion): void {
    this.database.connection.prepare(`
      INSERT INTO character_owned_skill_versions(
        id, package_id, character_id, conversation_space, version, status,
        markdown, change_summary, source, source_task_id, content_hash,
        created_at, activated_at, superseded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      version.id,
      version.packageId,
      version.characterId,
      version.conversationSpace,
      version.version,
      version.status,
      version.markdown,
      version.changeSummary,
      version.source,
      version.sourceTaskId ?? null,
      version.contentHash,
      version.createdAt,
      version.activatedAt ?? null,
      version.supersededAt ?? null,
    );
  }

  activateOwnedSkillVersion(packageId: string, versionId: string, activatedAt: string): void {
    this.database.connection.prepare(`
      UPDATE character_owned_skill_versions
      SET status = 'active', activated_at = ?, superseded_at = NULL
      WHERE package_id = ? AND id = ?
    `).run(activatedAt, packageId, versionId);
  }

  createOwnedSkillEvaluation(evaluation: CharacterOwnedSkillEvaluation): void {
    this.database.connection.prepare(`
      INSERT INTO character_owned_skill_evaluations(
        id, package_id, version_id, character_id, conversation_space,
        source_task_id, outcome, score, result_summary, lesson, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(package_id, source_task_id) DO NOTHING
    `).run(
      evaluation.id,
      evaluation.packageId,
      evaluation.versionId,
      evaluation.characterId,
      evaluation.conversationSpace,
      evaluation.sourceTaskId,
      evaluation.outcome,
      evaluation.score ?? null,
      evaluation.resultSummary,
      evaluation.lesson,
      evaluation.createdAt,
    );
  }

  listOwnedSkillEvaluations(packageId: string, limit = 100): CharacterOwnedSkillEvaluation[] {
    const bounded = Math.max(1, Math.min(Math.floor(limit), 500));
    return (this.database.connection.prepare(`
      SELECT * FROM character_owned_skill_evaluations
      WHERE package_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(packageId, bounded) as Row[]).map(mapOwnedSkillEvaluation);
  }

  getOwnedSkillProposal(
    packageId: string,
    proposalId: string,
  ): CharacterOwnedSkillProposal | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM character_owned_skill_proposals
      WHERE package_id = ? AND id = ?
    `).get(packageId, proposalId) as Row | undefined;
    return row ? mapOwnedSkillProposal(row) : undefined;
  }

  findOwnedSkillProposalBySourceTask(
    packageId: string,
    sourceTaskId: string,
  ): CharacterOwnedSkillProposal | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM character_owned_skill_proposals
      WHERE package_id = ? AND source_task_id = ?
    `).get(packageId, sourceTaskId) as Row | undefined;
    return row ? mapOwnedSkillProposal(row) : undefined;
  }

  listOwnedSkillProposals(packageId: string, limit = 100): CharacterOwnedSkillProposal[] {
    const bounded = Math.max(1, Math.min(Math.floor(limit), 500));
    return (this.database.connection.prepare(`
      SELECT * FROM character_owned_skill_proposals
      WHERE package_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(packageId, bounded) as Row[]).map(mapOwnedSkillProposal);
  }

  insertOwnedSkillProposal(proposal: CharacterOwnedSkillProposal): void {
    this.database.connection.prepare(`
      INSERT INTO character_owned_skill_proposals(
        id, package_id, base_version_id, character_id, conversation_space,
        source_task_id, status, proposed_markdown, change_summary,
        content_hash, created_at, reviewed_at, activated_version_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(package_id, source_task_id) DO NOTHING
    `).run(
      proposal.id,
      proposal.packageId,
      proposal.baseVersionId,
      proposal.characterId,
      proposal.conversationSpace,
      proposal.sourceTaskId,
      proposal.status,
      proposal.proposedMarkdown,
      proposal.changeSummary,
      proposal.contentHash,
      proposal.createdAt,
      proposal.reviewedAt ?? null,
      proposal.activatedVersionId ?? null,
    );
  }

  updateOwnedSkillProposal(
    packageId: string,
    proposalId: string,
    status: CharacterOwnedSkillProposal["status"],
    reviewedAt: string,
    activatedVersionId?: string,
  ): void {
    this.database.connection.prepare(`
      UPDATE character_owned_skill_proposals
      SET status = ?, reviewed_at = ?, activated_version_id = ?
      WHERE package_id = ? AND id = ?
    `).run(status, reviewedAt, activatedVersionId ?? null, packageId, proposalId);
  }
}

function mapCollaborationProfile(row: Row): CharacterCollaborationProfile {
  return {
    characterId: String(row.character_id),
    introduction: String(row.introduction ?? ""),
    traits: stringArray(row.traits_json),
    maxConcurrentTasks: Number(row.max_concurrent_tasks ?? 1),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapOwnedSkillPackage(row: Row): CharacterOwnedSkillPackage {
  const activeVersion = row.active_version_id ? mapOwnedSkillVersion({
    id: row.active_version_id,
    package_id: row.id,
    character_id: row.character_id,
    conversation_space: row.conversation_space,
    version: row.active_version,
    status: row.active_version_status,
    markdown: row.active_version_markdown,
    change_summary: row.active_version_change_summary,
    source: row.active_version_source,
    source_task_id: row.active_version_source_task_id,
    content_hash: row.active_version_content_hash,
    created_at: row.active_version_created_at,
    activated_at: row.active_version_activated_at,
    superseded_at: row.active_version_superseded_at,
  }) : undefined;
  return {
    id: String(row.id),
    characterId: String(row.character_id),
    conversationSpace: row.conversation_space === "secret" ? "secret" : "normal",
    slug: String(row.slug),
    name: String(row.name),
    description: String(row.description ?? ""),
    tags: stringArray(row.tags_json),
    status: String(row.status) as CharacterOwnedSkillPackage["status"],
    autoImprove: Boolean(row.auto_improve),
    createdBy: String(row.created_by) as CharacterOwnedSkillPackage["createdBy"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(activeVersion ? { activeVersion } : {}),
    versionCount: Number(row.version_count ?? 0),
    evaluationCount: Number(row.evaluation_count ?? 0),
    completedCount: Number(row.completed_count ?? 0),
    failedCount: Number(row.failed_count ?? 0),
    ...(optionalNumber(row.average_score) === undefined
      ? {}
      : { averageScore: optionalNumber(row.average_score) }),
    pendingProposalCount: Number(row.pending_proposal_count ?? 0),
  };
}

function mapOwnedSkillVersion(row: Row): CharacterOwnedSkillVersion {
  return {
    id: String(row.id),
    packageId: String(row.package_id),
    characterId: String(row.character_id),
    conversationSpace: row.conversation_space === "secret" ? "secret" : "normal",
    version: Number(row.version),
    status: String(row.status) as CharacterOwnedSkillVersion["status"],
    markdown: String(row.markdown ?? ""),
    changeSummary: String(row.change_summary ?? ""),
    source: String(row.source) as CharacterOwnedSkillVersion["source"],
    ...(row.source_task_id ? { sourceTaskId: String(row.source_task_id) } : {}),
    contentHash: String(row.content_hash),
    createdAt: String(row.created_at),
    ...(row.activated_at ? { activatedAt: String(row.activated_at) } : {}),
    ...(row.superseded_at ? { supersededAt: String(row.superseded_at) } : {}),
  };
}

function mapOwnedSkillEvaluation(row: Row): CharacterOwnedSkillEvaluation {
  return {
    id: String(row.id),
    packageId: String(row.package_id),
    versionId: String(row.version_id),
    characterId: String(row.character_id),
    conversationSpace: row.conversation_space === "secret" ? "secret" : "normal",
    sourceTaskId: String(row.source_task_id),
    outcome: String(row.outcome) as CharacterOwnedSkillEvaluation["outcome"],
    ...(optionalNumber(row.score) === undefined ? {} : { score: optionalNumber(row.score) }),
    resultSummary: String(row.result_summary ?? ""),
    lesson: String(row.lesson ?? ""),
    createdAt: String(row.created_at),
  };
}

function mapOwnedSkillProposal(row: Row): CharacterOwnedSkillProposal {
  return {
    id: String(row.id),
    packageId: String(row.package_id),
    baseVersionId: String(row.base_version_id),
    characterId: String(row.character_id),
    conversationSpace: row.conversation_space === "secret" ? "secret" : "normal",
    sourceTaskId: String(row.source_task_id),
    status: String(row.status) as CharacterOwnedSkillProposal["status"],
    proposedMarkdown: String(row.proposed_markdown ?? ""),
    changeSummary: String(row.change_summary ?? ""),
    contentHash: String(row.content_hash),
    createdAt: String(row.created_at),
    ...(row.reviewed_at ? { reviewedAt: String(row.reviewed_at) } : {}),
    ...(row.activated_version_id
      ? { activatedVersionId: String(row.activated_version_id) }
      : {}),
  };
}

function stringArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}
