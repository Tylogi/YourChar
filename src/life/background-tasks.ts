import { randomUUID } from "node:crypto";
import type { Clock } from "../app/clock.js";
import type { AppDatabase } from "../storage/database.js";
import type { CharacterDiaryService } from "../diary/service.js";
import { WorldValidationError } from "../world/service.js";
import type { LifeSpace } from "./goals.js";

type Row = Record<string, unknown>;
export type CharacterBackgroundTask = {
  id: string; characterId: string; worldId: string; kind: "diary" | "collaboration" | "planning";
  title: string; status: string; sourceId: string; updatedAt: string; error?: string;
  canCancel: boolean; canRetry: boolean;
};

/** A common projection/control contract, not a competing queue for existing durable workers. */
export class CharacterBackgroundTasks {
  private readonly planning = new Map<string, { characterId: string; controller: AbortController }>();
  private disposed = false;
  constructor(private readonly db: AppDatabase, private readonly clock: Clock, private readonly options: {
    diaries: CharacterDiaryService; cancelCollaboration: (id: string, characterId: string) => void;
    foregroundBusy: () => boolean;
  }) {
    this.db.connection.prepare("UPDATE character_planning_jobs SET status='failed',error='上次规划中断；不会恢复未确认的输出',updated_at=? WHERE status='running'").run(this.now());
  }

  list(characterId: string, space: LifeSpace): CharacterBackgroundTask[] {
    this.assertOwner(characterId, space);
    if (space === "secret") return [];
    const diary = this.db.connection.prepare(`SELECT j.*,e.character_id,e.world_id,e.title,e.invalidated_at FROM character_diary_jobs j
      JOIN character_diary_entries e ON e.id=j.entry_id WHERE e.character_id=?
      ORDER BY CASE WHEN j.status IN ('running','pending') AND j.cancelled_at IS NULL THEN 0 ELSE 1 END,j.updated_at DESC LIMIT 40`).all(characterId) as Row[];
    const tasks: CharacterBackgroundTask[] = diary.map(row => ({ id: `diary:${row.entry_id}:${row.kind}`, characterId, worldId: String(row.world_id), kind: "diary",
      title: `${row.kind === "memory" ? "整理记忆" : "创作日记"} · ${row.title}`, sourceId: String(row.entry_id), updatedAt: String(row.updated_at),
      status: row.cancelled_at || row.invalidated_at ? "cancelled" : row.status === "ready" ? "completed" : String(row.status),
      ...(row.error ? { error: String(row.error) } : {}), canCancel: !row.cancelled_at && !row.invalidated_at && ["pending", "running", "failed", "paused"].includes(String(row.status)),
      canRetry: !row.invalidated_at && (Boolean(row.cancelled_at) || row.status === "failed") }));
    const collaborations = this.db.connection.prepare(`SELECT e.*,j.last_error FROM character_collaboration_jobs j
      JOIN character_channel_episodes e ON e.id=j.episode_id WHERE e.initiator_character_id=? OR e.target_character_id=?
      ORDER BY CASE WHEN e.status IN ('running','queued') THEN 0 ELSE 1 END,e.updated_at DESC LIMIT 30`).all(characterId, characterId) as Row[];
    for (const row of collaborations) tasks.push({ id: `collaboration:${row.id}`, characterId, worldId: String(row.world_id), kind: "collaboration", title: String(row.title),
      sourceId: String(row.id), updatedAt: String(row.updated_at), status: String(row.status),
      ...(row.last_error || row.failure_reason ? { error: row.status === "cancelled" ? "用户已停止；已有消息保留" : "协作未完成；没有可确认的新结果" } : {}),
      canCancel: row.initiator_character_id === characterId && ["queued", "running"].includes(String(row.status)), canRetry: false });
    for (const row of this.db.connection.prepare("SELECT * FROM character_planning_jobs WHERE character_id=? ORDER BY created_at DESC LIMIT 20").all(characterId) as Row[]) {
      tasks.push({ id: `planning:${row.id}`, characterId, worldId: String(row.world_id), kind: "planning", title: "安排世界日程", sourceId: String(row.id),
        status: String(row.status), updatedAt: String(row.updated_at), ...(row.error ? { error: String(row.error) } : {}), canCancel: row.status === "running", canRetry: false });
    }
    return tasks.sort((a, b) => Number(!["running", "queued", "pending"].includes(a.status)) - Number(!["running", "queued", "pending"].includes(b.status)) || b.updatedAt.localeCompare(a.updatedAt)).slice(0, 60);
  }

  control(characterId: string, space: LifeSpace, taskId: string, action: "cancel" | "retry"): void {
    this.assertOwner(characterId, space);
    const task = this.list(characterId, space).find(value => value.id === taskId);
    if (!task || !["cancel", "retry"].includes(action) || !(action === "cancel" ? task.canCancel : task.canRetry)) throw new WorldValidationError("此任务不属于当前角色、空间，或当前状态不支持此操作");
    if (task.kind === "diary") {
      const kind = taskId.endsWith(":memory") ? "memory" : "narrative";
      if (action === "cancel") this.options.diaries.cancel(characterId, task.sourceId, kind);
      else this.options.diaries.retry(characterId, task.sourceId, kind);
    } else if (task.kind === "collaboration") this.options.cancelCollaboration(task.sourceId, characterId);
    else {
      this.db.connection.prepare("UPDATE character_planning_jobs SET status='cancelled',error='用户已停止本次规划',updated_at=? WHERE id=? AND status='running'").run(this.now(), task.sourceId);
      this.planning.get(task.sourceId)?.controller.abort();
    }
  }

  async runPlanning<T>(characterId: string, worldId: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertOwner(characterId, "normal");
    if (this.disposed || this.options.foregroundBusy()) throw new WorldValidationError("正在优先处理用户对话，请稍后规划");
    if ([...this.planning.values()].some(value => value.characterId === characterId)) throw new WorldValidationError("该角色正在规划，请勿重复启动");
    const since = new Date(this.clock.now().getTime() - 24 * 3600_000).toISOString();
    const calls = this.db.connection.prepare("SELECT count(*) AS n FROM character_planning_jobs WHERE character_id=? AND created_at>=?").get(characterId, since) as Row;
    if (Number(calls.n) >= 3) throw new WorldValidationError("该角色最近 24 小时的规划额度已用完，请稍后再试");
    const id = randomUUID();
    const controller = new AbortController();
    this.db.connection.prepare("INSERT INTO character_planning_jobs(id,character_id,world_id,status,created_at,updated_at) VALUES (?,?,?,'running',?,?)").run(id, characterId, worldId, this.now(), this.now());
    this.planning.set(id, { characterId, controller });
    const timeout = setTimeout(() => controller.abort(), 90_000);
    timeout.unref();
    try {
      const result = await operation(controller.signal);
      if (controller.signal.aborted || this.disposed) throw new Error("规划已停止");
      this.db.connection.prepare("UPDATE character_planning_jobs SET status='completed',updated_at=? WHERE id=? AND status='running'").run(this.now(), id);
      return result;
    } catch (error) {
      if (!this.disposed) this.db.connection.prepare("UPDATE character_planning_jobs SET status='failed',error='规划未完成；未确认的模型输出不会落盘',updated_at=? WHERE id=? AND status='running'").run(this.now(), id);
      throw error;
    } finally { clearTimeout(timeout); this.planning.delete(id); }
  }

  isCharacterBusy(characterId: string): boolean { return [...this.planning.values()].some(value => value.characterId === characterId); }
  get isBusy(): boolean { return this.planning.size > 0; }
  dispose(): void { this.disposed = true; for (const value of this.planning.values()) value.controller.abort(); }
  private assertOwner(id: string, space: LifeSpace): void {
    if (!["normal", "secret"].includes(space) || !this.db.connection.prepare("SELECT id FROM characters WHERE id=?").get(id)) throw new WorldValidationError("角色或空间不存在");
  }
  private now(): string { return this.clock.now().toISOString(); }
}
