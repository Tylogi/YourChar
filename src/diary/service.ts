import { randomUUID } from "node:crypto";
import type { Clock } from "../app/clock.js";
import type { IdGenerator } from "../app/id-generator.js";
import type { AppDatabase } from "../storage/database.js";
import { diaryMemoryText, parseDiaryMemory } from "./prompts.js";
import type { DiaryEntry, DiaryGenerator, DiaryJobKind, DiaryMemory, DiarySettings, DiarySettingsPatch, DiarySource } from "./types.js";
import type { MeetingPreset } from "../meeting-preset/types.js";

type Row = Record<string, unknown>;
export class DiaryValidationError extends Error {}

/** Durable, bounded background work. Literary output is never memory input. */
export class CharacterDiaryService {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private controller?: AbortController;
  private disposed = false;
  private stopped = false;

  get isBusy(): boolean { return Boolean(this.running); }

  constructor(
    private readonly database: AppDatabase,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly options: {
      generate: DiaryGenerator;
      resolveNarrativePreset?: (source: DiarySource, settings: DiarySettings) => MeetingPreset | undefined;
      canRun: (kind: DiaryJobKind, source: DiarySource) => boolean;
      onMemory: (entry: DiaryEntry, memory: DiaryMemory) => void;
    },
  ) {}

  settings(characterId: string): DiarySettings {
    this.assertCharacter(characterId);
    const row = this.database.connection.prepare("SELECT * FROM character_diary_settings WHERE character_id = ?").get(characterId) as Row | undefined;
    return { narrativeEnabled: row ? Boolean(row.narrative_enabled) : true, preset: String(row?.preset ?? ""),
      presetMode: (row?.preset_mode ?? "inherit") as DiarySettings["presetMode"], presetId: row?.preset_id ? String(row.preset_id) : null };
  }

  updateSettings(characterId: string, patch: DiarySettingsPatch): DiarySettings {
    this.assertCharacter(characterId);
    if (typeof patch.narrativeEnabled !== "boolean" || typeof patch.preset !== "string" || [...patch.preset].length > 6000) {
      throw new DiaryValidationError("日记设置无效，创作预设最多 6000 字");
    }
    const current = this.settings(characterId);
    const presetMode = patch.presetMode === undefined ? current.presetMode : patch.presetMode;
    const presetId = presetMode === "custom" ? (patch.presetId === undefined ? current.presetId : patch.presetId) : null;
    if (!["inherit", "custom", "none"].includes(presetMode) || (presetId !== null && (typeof presetId !== "string" || !presetId.trim()))) {
      throw new DiaryValidationError("无效的创作预设选择");
    }
    if (presetId && !this.database.connection.prepare("SELECT id FROM meeting_presets WHERE id=?").get(presetId)) throw new DiaryValidationError("所选创作预设不存在");
    if (presetMode === "custom" && !presetId) throw new DiaryValidationError("请选择创作预设，或改为默认文风");
    this.database.connection.prepare(`INSERT INTO character_diary_settings(character_id,narrative_enabled,preset,updated_at,preset_mode,preset_id) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(character_id) DO UPDATE SET narrative_enabled=excluded.narrative_enabled, preset=excluded.preset, updated_at=excluded.updated_at, preset_mode=excluded.preset_mode,preset_id=excluded.preset_id`)
      .run(characterId, Number(patch.narrativeEnabled), patch.preset.trim(), this.now(), presetMode, presetId);
    this.database.connection.prepare(`UPDATE character_diary_jobs SET status=?, lease_id=NULL, lease_until=NULL, updated_at=?
      WHERE kind='narrative' AND entry_id IN (SELECT id FROM character_diary_entries WHERE character_id=? AND invalidated_at IS NULL)
      AND status IN ('pending','paused','running')`)
      .run(patch.narrativeEnabled ? "pending" : "paused", this.now(), characterId);
    return this.settings(characterId);
  }

  capture(source: DiarySource): DiaryEntry {
    this.assertCharacter(source.characterId);
    const member = this.database.connection.prepare("SELECT world_id FROM character_world_memberships WHERE character_id=?").get(source.characterId) as Row | undefined;
    if (member?.world_id !== source.worldId || !["activity", "interaction", "world_event"].includes(source.kind) ||
      !source.id || !source.title || !Number.isFinite(Date.parse(source.occurredAt)) ||
      !source.observations.length || source.observations.some(text => typeof text !== "string" || !text.trim()) ||
      JSON.stringify(source).length > 32000) throw new DiaryValidationError("经历来源无效");
    const existing = this.database.connection.prepare("SELECT id FROM character_diary_entries WHERE character_id=? AND source_kind=? AND source_id=? AND invalidated_at IS NULL")
      .get(source.characterId, source.kind, source.id) as Row | undefined;
    if (existing) return this.get(source.characterId, String(existing.id));
    const id = this.ids.next("diary");
    const now = this.now();
    this.database.transaction(() => {
      this.database.connection.prepare(`INSERT INTO character_diary_entries
        (id,character_id,world_id,source_kind,source_id,title,occurred_at,source_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(id, source.characterId, source.worldId, source.kind, source.id, source.title.slice(0, 160), source.occurredAt, JSON.stringify(source), now);
      for (const kind of ["memory", "narrative"] as const) {
        this.database.connection.prepare(`INSERT INTO character_diary_jobs(entry_id,kind,status,available_at,updated_at) VALUES (?,?,?,?,?)`)
          .run(id, kind, kind === "narrative" && !this.settings(source.characterId).narrativeEnabled ? "paused" : "pending", now, now);
      }
    });
    return this.get(source.characterId, id);
  }

  list(characterId: string, limit = 50): DiaryEntry[] {
    this.assertCharacter(characterId);
    const rows = this.database.connection.prepare(`SELECT id FROM character_diary_entries WHERE character_id=? ORDER BY occurred_at DESC,id DESC LIMIT ?`)
      .all(characterId, Math.max(1, Math.min(100, Math.trunc(limit)))) as Row[];
    return rows.map(row => this.get(characterId, String(row.id)));
  }

  exportForCharacter(characterId: string): { characterId: string; settings: DiarySettings; entries: DiaryEntry[] } {
    const settings = this.settings(characterId);
    const rows = this.database.connection.prepare("SELECT id FROM character_diary_entries WHERE character_id=? ORDER BY occurred_at,id").all(characterId) as Row[];
    return { characterId, settings, entries: rows.map(row => this.get(characterId, String(row.id))) };
  }

  /** Retain reader history, but fence all work and context after a canonical undo. */
  invalidateSource(kind: DiarySource["kind"], sourceId: string): string[] {
    const ids = (this.database.connection.prepare("SELECT id FROM character_diary_entries WHERE source_kind=? AND source_id=? AND invalidated_at IS NULL")
      .all(kind, sourceId) as Row[]).map(row => String(row.id));
    this.database.transaction(() => {
      for (const id of ids) {
        this.database.connection.prepare("UPDATE character_diary_entries SET invalidated_at=? WHERE id=?").run(this.now(), id);
        this.database.connection.prepare("UPDATE character_diary_jobs SET status='paused',lease_id=NULL,lease_until=NULL WHERE entry_id=?").run(id);
      }
    });
    return ids;
  }

  get(characterId: string, id: string): DiaryEntry {
    const row = this.database.connection.prepare("SELECT * FROM character_diary_entries WHERE id=? AND character_id=?").get(id, characterId) as Row | undefined;
    if (!row) throw new DiaryValidationError("日记不存在或不属于该角色");
    const jobs = this.database.connection.prepare("SELECT kind,status,error FROM character_diary_jobs WHERE entry_id=? ORDER BY kind").all(id) as Row[];
    return {
      id, characterId, worldId: String(row.world_id), title: String(row.title), occurredAt: String(row.occurred_at),
      source: JSON.parse(String(row.source_json)) as DiarySource,
      invalidated: Boolean(row.invalidated_at),
      ...(row.memory_json ? { memory: JSON.parse(String(row.memory_json)) as DiaryMemory } : {}),
      ...(row.narrative_text ? { narrative: String(row.narrative_text) } : {}),
      jobs: jobs.map(job => ({ kind: String(job.kind) as DiaryJobKind, status: String(job.status) as DiaryEntry["jobs"][number]["status"], ...(job.error ? { error: String(job.error) } : {}) })),
    };
  }

  retry(characterId: string, id: string, kind: DiaryJobKind): DiaryEntry {
    const entry = this.get(characterId, id);
    if (entry.invalidated) throw new DiaryValidationError("该经历已撤销，不能重新生成");
    if (kind !== "memory" && kind !== "narrative") throw new DiaryValidationError("无效的日记任务类型");
    if (kind === "memory" && entry.jobs.some(job => job.kind === kind && job.status === "ready")) {
      throw new DiaryValidationError("已保存的记忆不随长文重写；只能重试失败的摘要");
    }
    if (!this.options.canRun(kind, entry.source) || (kind === "narrative" && !this.settings(characterId).narrativeEnabled)) {
      throw new DiaryValidationError("请先启用对应的日记创作或角色记忆／关系能力");
    }
    if (entry.jobs.some(job => job.kind === kind && job.status === "running")) throw new DiaryValidationError("正在生成，请稍后重试");
    this.database.connection.prepare(`UPDATE character_diary_jobs SET status='pending',attempts=0,available_at=?,lease_id=NULL,lease_until=NULL,error=NULL,updated_at=? WHERE entry_id=? AND kind=?`)
      .run(this.now(), this.now(), id, kind);
    return this.get(characterId, id);
  }

  memoryContext(characterId: string, worldId: string): string {
    const rows = this.database.connection.prepare(`SELECT id FROM character_diary_entries WHERE character_id=? AND world_id=? AND invalidated_at IS NULL
      ORDER BY occurred_at DESC,id DESC LIMIT 20`).all(characterId, worldId) as Row[];
    return rows.map(row => this.get(characterId, String(row.id))).filter(entry => entry.memory &&
      entry.jobs.some(job => job.kind === "memory" && job.status === "ready") && this.options.canRun("memory", entry.source))
      .slice(0, 4).map(entry => `${entry.occurredAt} · ${entry.title}\n${diaryMemoryText(entry.memory!)}`).join("\n").slice(0, 2400);
  }

  start(): void {
    if (this.timer || this.disposed) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.drain().catch(() => undefined), 60_000);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.controller?.abort();
  }

  dispose(): void { this.disposed = true; this.stop(); }

  drain(): Promise<void> {
    if (this.disposed || this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.process().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async process(): Promise<void> {
    // Four model calls per tick, one at a time. Restart recovery uses fenced leases.
    for (let count = 0; count < 4 && !this.disposed && !this.stopped; count++) {
      const now = this.now();
      this.database.connection.prepare(`UPDATE character_diary_jobs SET status='failed',lease_id=NULL,lease_until=NULL,error='上次生成中断，可重试',updated_at=? WHERE status='running' AND lease_until<=?`).run(now, now);
      const candidates = this.database.connection.prepare(`SELECT j.*,e.character_id FROM character_diary_jobs j JOIN character_diary_entries e ON e.id=j.entry_id
        WHERE e.invalidated_at IS NULL AND j.status IN ('pending','failed','paused') AND j.attempts<3 AND j.available_at<=? ORDER BY j.updated_at,j.kind`).all(now) as Row[];
      const candidate = candidates.find(job => {
        const source = this.get(String(job.character_id), String(job.entry_id)).source;
        if (!this.options.canRun(job.kind as DiaryJobKind, source)) return false;
        if (job.kind === "narrative" && !this.settings(source.characterId).narrativeEnabled) return false;
        const since = new Date(this.clock.now().getTime() - 24 * 3600_000).toISOString();
        const completed = this.database.connection.prepare(`SELECT count(*) AS n FROM character_diary_generations g JOIN character_diary_entries e ON e.id=g.entry_id
          WHERE e.character_id=? AND g.kind=? AND g.started_at>=?`).get(source.characterId, String(job.kind), since) as Row;
        return Number(completed.n) < (job.kind === "narrative" ? 3 : 12);
      });
      if (!candidate) break;
      const kind = candidate.kind as DiaryJobKind;
      const id = String(candidate.entry_id);
      const lease = randomUUID();
      const claimed = this.database.connection.prepare(`UPDATE character_diary_jobs SET status='running',attempts=attempts+1,lease_id=?,lease_until=?,updated_at=?
        WHERE entry_id=? AND kind=? AND status IN ('pending','failed','paused')`).run(lease, new Date(this.clock.now().getTime() + 180_000).toISOString(), now, id, kind);
      if (!claimed.changes) continue;
      const entry = this.get(String(candidate.character_id), id);
      const controller = new AbortController();
      this.controller = controller;
      const timeout = setTimeout(() => controller.abort(), 90_000);
      timeout.unref();
      try {
        const cached = kind === "memory" ? entry.memory : undefined;
        if (!cached) this.database.connection.prepare("INSERT INTO character_diary_generations VALUES (?,?,?,?)").run(lease, id, kind, this.now());
        const settings = this.settings(entry.characterId);
        const narrativePreset = kind === "narrative" ? this.options.resolveNarrativePreset?.(entry.source, settings) : undefined;
        const result = cached ?? await this.options.generate({ kind, source: entry.source, preset: kind === "narrative" ? settings.preset : "",
          ...(narrativePreset ? { narrativePreset } : {}), signal: controller.signal });
        if (controller.signal.aborted || this.disposed || !this.options.canRun(kind, entry.source)) throw new Error("生成已停止");
        const memory = kind === "memory" ? parseDiaryMemory(result, entry.source) : undefined;
        const narrative = kind === "narrative" && typeof result === "string" ? result.trim() : undefined;
        if (kind === "narrative" && (!narrative || [...narrative].length > 16000 || /<\/?(?:think|analysis)>/i.test(narrative))) throw new Error("日记正文无效");
        const owned = this.database.connection.prepare("SELECT entry_id FROM character_diary_jobs WHERE entry_id=? AND kind=? AND lease_id=? AND status='running'").get(id, kind, lease);
        if (!owned) continue;
        // Checkpoint first: replay exactly this validated result after partial materialization,
        // never a fresh model interpretation of the same idempotency key.
        if (memory) {
          this.database.connection.prepare("UPDATE character_diary_entries SET memory_json=? WHERE id=?").run(JSON.stringify(memory), id);
          this.options.onMemory(entry, memory);
        }
        this.database.transaction(() => {
          const changed = this.database.connection.prepare(`UPDATE character_diary_jobs SET status='ready',lease_id=NULL,lease_until=NULL,error=NULL,updated_at=? WHERE entry_id=? AND kind=? AND lease_id=? AND status='running'`)
            .run(this.now(), id, kind, lease);
          if (!changed.changes) return false;
          this.database.connection.prepare(kind === "memory" ? "UPDATE character_diary_entries SET memory_json=? WHERE id=?" : "UPDATE character_diary_entries SET narrative_text=? WHERE id=?")
            .run(kind === "memory" ? JSON.stringify(memory) : narrative!, id);
          return true;
        });
      } catch {
        if (!this.disposed) this.database.connection.prepare(`UPDATE character_diary_jobs SET status='failed',lease_id=NULL,lease_until=NULL,error='生成未完成，可稍后重试',available_at=?,updated_at=?
          WHERE entry_id=? AND kind=? AND lease_id=?`)
          .run(new Date(this.clock.now().getTime() + 600_000).toISOString(), this.now(), id, kind, lease);
      } finally {
        clearTimeout(timeout);
        if (this.controller === controller) this.controller = undefined;
      }
    }
  }

  private assertCharacter(characterId: string): void {
    if (!this.database.connection.prepare("SELECT id FROM characters WHERE id=?").get(characterId)) throw new DiaryValidationError("角色不存在");
  }
  private now(): string { return this.clock.now().toISOString(); }
}
