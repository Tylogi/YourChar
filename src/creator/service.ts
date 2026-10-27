import { createHash } from "node:crypto";
import type { Clock } from "../app/clock.js";
import type { AppDatabase } from "../storage/database.js";
import { creatorOperationSchema, creatorProposalSchema, CreatorBudgetError, CreatorError, type CreatorMessage, type CreatorOperation, type CreatorProposal, type CreatorSession, type CreatorSessionMode, type CreatorTarget } from "./contracts.js";

export type CreatorPort = {
  assertAvailable(): void;
  assertApplyIdle(): void;
  overview(offset: number): unknown;
  inspect(target: CreatorTarget): Record<string, unknown>;
  baseline(operation: CreatorOperation): unknown;
  execute(operation: CreatorOperation): unknown;
};
type ProposalRow = { id: string; payload: string; status: CreatorProposal["status"]; result: string | null; error: string | null; created_at: string; updated_at: string; session_id: string | null };
type SessionRow = { id: string; title: string; mode: CreatorSessionMode; created_at: string; updated_at: string; pending: number };
export type CreatorTurnMode = CreatorSessionMode;
/** `sessionId` continues that session; `newSession` starts one; neither continues the latest session. */
export type CreatorSendOptions = { sessionId?: string; newSession?: boolean; mode?: CreatorTurnMode };
export type CreatorTurnRunner = (input: {
  id: string; text: string; mode: CreatorTurnMode; history: CreatorMessage[]; service: CreatorService; signal: AbortSignal;
}) => Promise<string>;

export class CreatorService {
  private active?: { id: string; sessionId: string; controller: AbortController };
  private disposed = false;
  constructor(
    private readonly database: AppDatabase, private readonly clock: Clock,
    private readonly ids: { next(prefix: string): string }, private readonly port: CreatorPort,
    private readonly runner: CreatorTurnRunner,
  ) {
    // A crash between a domain mutation and its receipt cannot be safely replayed.
    database.connection.prepare("UPDATE creator_proposals SET status='interrupted',error=? WHERE status='applying'")
      .run("服务中断，结果可能已生效。请检查目标后重新提出草案；不会自动重试。");
    database.connection.prepare("UPDATE creator_proposals SET status='rejected' WHERE status='pending' AND turn_id IN (SELECT id FROM creator_turns WHERE status='running')").run();
    database.connection.prepare("UPDATE creator_turns SET status='failed' WHERE status='running'").run();
  }
  get isBusy() { return Boolean(this.active); }
  private available() { if (this.disposed) throw new CreatorError("创作助手已关闭", 409); this.port.assertAvailable(); }
  overview(offset = 0) { this.available(); return this.port.overview(integer(offset)); }
  inspect(target: CreatorTarget) { this.available(); return this.port.inspect(target); }

  sessions(): CreatorSession[] {
    this.available();
    return (this.database.connection.prepare(`SELECT s.*, (SELECT COUNT(*) FROM creator_proposals p
      WHERE p.session_id=s.id AND p.status='pending') AS pending FROM creator_sessions s
      ORDER BY s.updated_at DESC, s.rowid DESC LIMIT 100`).all() as unknown as SessionRow[]).map(sessionOf);
  }
  /**
   * `sessionId` undefined shows the latest session; `null` is the start page,
   * which has no transcript and lists pending drafts from every session.
   */
  snapshot(before?: number, sessionId?: string | null) {
    this.available();
    if (before !== undefined) integer(before);
    const session = sessionId === null ? undefined : sessionId === undefined ? this.latestSession() : this.requireSession(sessionId);
    const rows = session ? this.database.connection.prepare(`SELECT seq,role,text,created_at,turn_id FROM creator_messages
      WHERE session_id=? AND seq < ? ORDER BY seq DESC LIMIT 31`).all(session.id, before ?? Number.MAX_SAFE_INTEGER) as unknown as Array<{
        seq: number; role: CreatorMessage["role"]; text: string; created_at: string; turn_id: string | null;
      }> : [];
    const messages = rows.slice(0, 30).reverse().map(row => ({ seq: row.seq, role: row.role, text: row.text, createdAt: row.created_at,
      ...(row.turn_id ? { requestId: row.turn_id } : {}) }));
    const proposals = (session
      ? this.database.connection.prepare(`SELECT * FROM creator_proposals WHERE session_id=?
          ORDER BY CASE WHEN status='pending' THEN 0 ELSE 1 END, rowid DESC LIMIT 40`).all(session.id)
      : this.database.connection.prepare(`SELECT * FROM creator_proposals WHERE status='pending'
          ORDER BY rowid DESC LIMIT 400`).all()) as unknown as ProposalRow[];
    return { sessionId: session?.id ?? null, session: session ?? null, sessions: this.sessions(),
      messages, before: rows.length > 30 ? messages[0].seq : null, busy: this.isBusy, activeSessionId: this.active?.sessionId ?? null,
      proposals: proposals.map(row => this.decode(row)) };
  }
  getProposal(id: string) {
    this.available();
    const row = this.database.connection.prepare("SELECT * FROM creator_proposals WHERE id=?").get(id) as ProposalRow | undefined;
    if (!row) throw new CreatorError("找不到这份创作草案", 404);
    return this.decode(row);
  }
  propose(input: unknown, turnId: string, callId: string) {
    this.available();
    if (!this.active || this.active.id !== turnId || this.active.controller.signal.aborted) throw new CreatorError("只能在有效的创作助手回合中提交草案", 403);
    const parsed = creatorProposalSchema.safeParse(input);
    if (!parsed.success) throw new CreatorError("草案字段不合法：" + parsed.error.issues.map(issue => issue.message).join("；"));
    const key = `${turnId}:${callId}`;
    const old = this.database.connection.prepare("SELECT * FROM creator_proposals WHERE tool_key=?").get(key) as ProposalRow | undefined;
    if (old) {
      const proposal = this.decode(old);
      if (hash(parsed.data) !== hash({ title: proposal.title, reason: proposal.reason, operation: proposal.operation })) throw new CreatorError("工具调用编号已绑定另一份草案", 409);
      return proposal;
    }
    // Counted per session, so drafts left in other sessions never block this one.
    const count = this.database.connection.prepare("SELECT COUNT(*) AS n FROM creator_proposals WHERE status='pending' AND session_id=?").get(this.active.sessionId)!.n as number;
    if (count >= 20) throw new CreatorError("这个会话最多保留 20 份待确认草案，请先处理已有草案", 409);
    const before = this.port.baseline(parsed.data.operation);
    const target = targetFor(parsed.data.operation);
    const current = target ? this.port.inspect(target) : null;
    const operation = parsed.data.operation;
    const after = "patch" in operation ? { ...current, ...operation.patch }
      : "input" in operation ? operation.input : operation;
    const payload = { ...parsed.data, before, after, digest: hash({ ...parsed.data, before, after }) };
    const now = this.clock.now().toISOString();
    const id = this.ids.next("creator-proposal");
    this.database.connection.prepare(`INSERT INTO creator_proposals(id,turn_id,tool_key,payload,status,created_at,updated_at,session_id)
      VALUES(?,?,?,?,'pending',?,?,?)`).run(id, turnId, key, JSON.stringify(payload), now, now, this.active.sessionId);
    return this.getProposal(id);
  }
  review(id: string, digest: string, action: "apply" | "reject", edits?: Record<string, unknown>) {
    this.available();
    if (this.active) throw new CreatorError("请等创作助手回复结束，或先停止回复，再确认变更", 409);
    const proposal = this.getProposal(id);
    // Repeating a finished action is a no-op even if user edits changed the stored digest.
    if (proposal.status === "applied" && action === "apply" || proposal.status === "rejected" && action === "reject") return proposal;
    if (proposal.digest !== digest) throw new CreatorError("预览版本不匹配，请刷新后重新确认", 409);
    if (proposal.status !== "pending") throw new CreatorError(proposal.status === "stale" || proposal.status === "failed"
      ? `这份草案已失效：${proposal.error ?? "目标已变化"}` : "此草案已处理，请刷新查看最新状态", 409);
    if (action === "reject") {
      this.finish(id, "rejected");
      this.message("system", `用户撤销了草案「${proposal.title}」，未修改角色或世界。`, undefined, proposal.sessionId);
      return this.getProposal(id);
    }
    this.port.assertApplyIdle();
    // Edits are validated now but persisted only once every pre-apply check has passed.
    const revised = edits && Object.keys(edits).length ? this.revise(proposal, edits) : undefined;
    const operation = revised?.operation ?? creatorOperationSchema.parse(proposal.operation);
    let unchanged = false;
    try { unchanged = hash(this.port.baseline(operation)) === hash(proposal.before); } catch { /* Target removed or unavailable. */ }
    if (!unchanged) {
      this.finish(id, "stale", undefined, "目标已变化，请让创作助手重新读取并提出草案。");
      throw new CreatorError("目标已变化，旧草案不会覆盖你的新修改", 409);
    }
    if (revised) this.database.connection.prepare("UPDATE creator_proposals SET payload=? WHERE id=? AND status='pending'").run(JSON.stringify(revised.payload), id);
    this.finish(id, "applying");
    try {
      // No await: approval, conflict check and synchronous domain mutation cannot interleave.
      const result = this.port.execute(operation);
      this.finish(id, "applied", result);
      this.message("system", `已确认并应用草案「${proposal.title}」。`, undefined, proposal.sessionId);
    } catch (error) {
      console.error(`[creator] proposal ${id} (${operation.kind}) failed:`, error);
      const detail = error instanceof Error && error.message ? `：${error.message.slice(0, 300)}` : "";
      this.finish(id, "failed", undefined, `变更未能完整完成${detail}。请检查目标现状后重新提出草案；不会自动重试。`);
      throw new CreatorError(`变更未能完整完成${detail}。请检查目标现状；不会自动重试。`, 409);
    }
    return this.getProposal(id);
  }
  async send(text: string, requestId: string, options: CreatorSendOptions = {}) {
    this.available();
    if (typeof text !== "string" || !text.trim() || text.length > 8000 || typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/u.test(requestId)) throw new CreatorError("消息或请求编号不合法");
    const requestedMode = options.mode ?? "chat";
    if (requestedMode !== "chat" && requestedMode !== "world_builder") throw new CreatorError("未知的创作模式");
    if (options.sessionId !== undefined && (typeof options.sessionId !== "string" || !options.sessionId)) throw new CreatorError("无效的会话");
    const previous = this.database.connection.prepare("SELECT text,status,session_id FROM creator_turns WHERE id=?").get(requestId) as { text: string; status: string; session_id: string | null } | undefined;
    if (previous) {
      if (previous.text !== text) throw new CreatorError("请求编号已用于另一条消息", 409);
      return { status: previous.status, ...this.snapshot(undefined, previous.session_id ?? undefined) };
    }
    if (this.active) throw new CreatorError("创作助手正在处理上一条消息", 409);
    const existing = options.sessionId ? this.requireSession(options.sessionId) : options.newSession ? undefined : this.latestSession();
    const session = existing ?? this.createSession(requestedMode, text);
    const history = this.snapshot(undefined, session.id).messages;
    // A world-builder session applies its instruction to the opening message only; follow-ups are ordinary chat.
    const mode: CreatorTurnMode = session.mode === "world_builder" && !history.some(message => message.role === "user") ? "world_builder" : "chat";
    const controller = new AbortController();
    this.active = { id: requestId, sessionId: session.id, controller };
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 120_000);
    let status = "completed";
    try {
      this.database.connection.prepare("INSERT INTO creator_turns(id,text,status,created_at,session_id) VALUES(?,?,'running',?,?)").run(requestId, text, this.clock.now().toISOString(), session.id);
      this.message("user", text, requestId, session.id);
      const reply = await this.runner({ id: requestId, text, mode, history, service: this, signal: controller.signal });
      if (controller.signal.aborted || this.disposed) throw new CreatorError("已停止回复");
      this.message("assistant", reply.slice(0, 20000), requestId, session.id);
    } catch (error) {
      // Only an explicit stop retracts drafts; hitting the time or call budget keeps them for review.
      status = timedOut && !this.disposed || error instanceof CreatorBudgetError && !controller.signal.aborted ? "partial"
        : controller.signal.aborted ? "cancelled" : "failed";
      if (status === "partial") {
        if (!this.disposed) this.message("system", (timedOut ? "这一轮超时停下了。" : "这一轮内容较多，在上限处停下了。") +
          "已提出的草案保留在右侧，可以先确认；发送“继续”补齐剩下的部分。", requestId, session.id);
      } else if (!this.disposed) this.message("system", status === "cancelled"
        ? "回复已停止。此轮草案已撤销，没有自动应用任何修改。"
        : (error instanceof CreatorError ? error.message : "回复未完成，请检查默认模型配置或稍后重试") + "。此轮草案已撤销。", requestId, session.id);
    } finally {
      clearTimeout(timeout);
      if (!this.disposed) {
        // A budget-stopped turn keeps its drafts; the table records it as completed.
        this.database.connection.prepare("UPDATE creator_turns SET status=? WHERE id=?").run(status === "partial" ? "completed" : status, requestId);
        if (status !== "completed" && status !== "partial") this.database.connection.prepare("UPDATE creator_proposals SET status='rejected' WHERE turn_id=? AND status='pending'").run(requestId);
      }
      this.active = undefined;
    }
    return this.disposed ? { status } : { status, ...this.snapshot(undefined, session.id) };
  }
  cancel() { this.available(); this.active?.controller.abort(); return { busy: this.isBusy }; }
  dispose() { this.disposed = true; this.active?.controller.abort(); }
  export() {
    this.available();
    return { sessions: this.database.connection.prepare("SELECT * FROM creator_sessions ORDER BY rowid").all(),
      messages: this.database.connection.prepare("SELECT * FROM creator_messages ORDER BY seq").all(),
      proposals: (this.database.connection.prepare("SELECT * FROM creator_proposals ORDER BY rowid").all() as unknown as ProposalRow[]).map(row => this.decode(row)),
      turns: this.database.connection.prepare("SELECT * FROM creator_turns ORDER BY rowid").all() };
  }
  pendingProposalCount(turnId: string): number {
    return (this.database.connection.prepare("SELECT COUNT(*) AS n FROM creator_proposals WHERE turn_id=? AND status='pending'").get(turnId) as { n: number }).n;
  }
  /** User edits replace whole fields of a pending draft; the result is re-validated and re-digested. */
  private revise(proposal: CreatorProposal, edits: Record<string, unknown>) {
    const operation = structuredClone(proposal.operation) as Record<string, unknown>;
    const fields = (operation.input ?? operation.patch) as Record<string, unknown> | undefined;
    if (!fields) throw new CreatorError("这类草案不支持直接编辑");
    for (const [key, value] of Object.entries(edits)) {
      if (!Object.hasOwn(fields, key) || typeof value !== "string") throw new CreatorError(`不能编辑字段 ${key}`);
      fields[key] = value;
    }
    const parsed = creatorOperationSchema.safeParse(operation);
    if (!parsed.success) throw new CreatorError("修改后的内容不合法：" + parsed.error.issues.map(issue => issue.message).join("；"));
    const target = targetFor(parsed.data);
    const current = target ? this.port.inspect(target) : null;
    const after = "patch" in parsed.data ? { ...current, ...parsed.data.patch } : "input" in parsed.data ? parsed.data.input : parsed.data;
    const base = { title: proposal.title, reason: proposal.reason, operation: parsed.data };
    const payload = { ...base, before: proposal.before, after, digest: hash({ ...base, before: proposal.before, after }) };
    return { operation: parsed.data, payload };
  }
  private message(role: CreatorMessage["role"], text: string, turnId: string | undefined, sessionId: string | undefined) {
    const now = this.clock.now().toISOString();
    this.database.connection.prepare("INSERT INTO creator_messages(role,text,turn_id,created_at,session_id) VALUES(?,?,?,?,?)")
      .run(role, text.slice(0, 20000), turnId ?? null, now, sessionId ?? null);
    if (sessionId) this.database.connection.prepare("UPDATE creator_sessions SET updated_at=? WHERE id=?").run(now, sessionId);
  }
  private latestSession(): CreatorSession | undefined {
    const row = this.database.connection.prepare(`SELECT s.*, 0 AS pending FROM creator_sessions s ORDER BY s.updated_at DESC, s.rowid DESC LIMIT 1`).get() as SessionRow | undefined;
    return row ? this.requireSession(row.id) : undefined;
  }
  private requireSession(id: string): CreatorSession {
    const row = this.database.connection.prepare(`SELECT s.*, (SELECT COUNT(*) FROM creator_proposals p
      WHERE p.session_id=s.id AND p.status='pending') AS pending FROM creator_sessions s WHERE s.id=?`).get(id) as SessionRow | undefined;
    if (!row) throw new CreatorError("找不到这个会话", 404);
    return sessionOf(row);
  }
  private createSession(mode: CreatorSessionMode, firstMessage: string): CreatorSession {
    const id = this.ids.next("creator-session");
    const now = this.clock.now().toISOString();
    const title = [...firstMessage.trim().split(/\r?\n/u)[0]].slice(0, 30).join("") || "新会话";
    this.database.connection.prepare("INSERT INTO creator_sessions(id,title,mode,created_at,updated_at) VALUES(?,?,?,?,?)").run(id, title, mode, now, now);
    return this.requireSession(id);
  }
  private finish(id: string, status: CreatorProposal["status"], result?: unknown, error?: string) {
    this.database.connection.prepare("UPDATE creator_proposals SET status=?,result=?,error=?,updated_at=? WHERE id=?")
      .run(status, result === undefined ? null : JSON.stringify(result), error ?? null, this.clock.now().toISOString(), id);
  }
  private decode(row: ProposalRow): CreatorProposal {
    return { ...JSON.parse(row.payload), id: row.id, status: row.status, result: row.result ? JSON.parse(row.result) : undefined,
      error: row.error ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at, sessionId: row.session_id ?? undefined };
  }
}
function sessionOf(row: SessionRow): CreatorSession {
  return { id: row.id, title: row.title, mode: row.mode, createdAt: row.created_at, updatedAt: row.updated_at, pendingCount: Number(row.pending) };
}
function integer(value: number) { if (!Number.isSafeInteger(value) || value < 0) throw new CreatorError("无效的分页位置"); return value; }
function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function targetFor(operation: CreatorOperation): CreatorTarget | undefined {
  if (operation.kind === "update_world") return { kind: "world", id: operation.worldId };
  if (operation.kind === "update_character") return { kind: "character", id: operation.characterId };
  if (operation.kind === "update_place") return { kind: "place", id: operation.placeId };
  return undefined;
}
