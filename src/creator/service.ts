import { createHash } from "node:crypto";
import type { Clock } from "../app/clock.js";
import type { AppDatabase } from "../storage/database.js";
import { creatorOperationSchema, creatorProposalSchema, CreatorError, type CreatorMessage, type CreatorOperation, type CreatorProposal, type CreatorTarget } from "./contracts.js";

export type CreatorPort = {
  assertAvailable(): void;
  assertApplyIdle(): void;
  overview(offset: number): unknown;
  inspect(target: CreatorTarget): Record<string, unknown>;
  baseline(operation: CreatorOperation): unknown;
  execute(operation: CreatorOperation): unknown;
};
type ProposalRow = { id: string; payload: string; status: CreatorProposal["status"]; result: string | null; error: string | null; created_at: string; updated_at: string };
export type CreatorTurnRunner = (input: {
  id: string; text: string; history: CreatorMessage[]; service: CreatorService; signal: AbortSignal;
}) => Promise<string>;

export class CreatorService {
  private active?: { id: string; controller: AbortController };
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

  snapshot(before?: number) {
    this.available();
    if (before !== undefined) integer(before);
    const rows = this.database.connection.prepare(`SELECT seq,role,text,created_at FROM creator_messages
      WHERE seq < ? ORDER BY seq DESC LIMIT 31`).all(before ?? Number.MAX_SAFE_INTEGER) as unknown as Array<{
        seq: number; role: CreatorMessage["role"]; text: string; created_at: string;
      }>;
    const messages = rows.slice(0, 30).reverse().map(row => ({ seq: row.seq, role: row.role, text: row.text, createdAt: row.created_at }));
    return { messages, before: rows.length > 30 ? messages[0].seq : null, busy: this.isBusy,
      proposals: (this.database.connection.prepare(`SELECT * FROM creator_proposals
        ORDER BY CASE WHEN status='pending' THEN 0 ELSE 1 END, rowid DESC LIMIT 40`).all() as unknown as ProposalRow[]).map(row => this.decode(row)) };
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
    const count = this.database.connection.prepare("SELECT COUNT(*) AS n FROM creator_proposals WHERE status='pending'").get()!.n as number;
    if (count >= 20) throw new CreatorError("最多保留 20 份待确认草案，请先处理已有草案", 409);
    const before = this.port.baseline(parsed.data.operation);
    const target = targetFor(parsed.data.operation);
    const current = target ? this.port.inspect(target) : null;
    const operation = parsed.data.operation;
    const after = "patch" in operation ? { ...current, ...operation.patch }
      : "input" in operation ? operation.input : operation;
    const payload = { ...parsed.data, before, after, digest: hash({ ...parsed.data, before, after }) };
    const now = this.clock.now().toISOString();
    const id = this.ids.next("creator-proposal");
    this.database.connection.prepare(`INSERT INTO creator_proposals(id,turn_id,tool_key,payload,status,created_at,updated_at)
      VALUES(?,?,?,?,'pending',?,?)`).run(id, turnId, key, JSON.stringify(payload), now, now);
    return this.getProposal(id);
  }
  review(id: string, digest: string, action: "apply" | "reject") {
    this.available();
    if (this.active) throw new CreatorError("请等创作助手回复结束，或先停止回复，再确认变更", 409);
    const proposal = this.getProposal(id);
    if (proposal.digest !== digest) throw new CreatorError("预览版本不匹配，请刷新后重新确认", 409);
    if (proposal.status === "applied" && action === "apply" || proposal.status === "rejected" && action === "reject") return proposal;
    if (proposal.status !== "pending") throw new CreatorError("此草案已处理或已失效，请重新提出草案", 409);
    if (action === "reject") {
      this.finish(id, "rejected");
      this.message("system", `用户撤销了草案「${proposal.title}」，未修改角色或世界。`, undefined);
      return this.getProposal(id);
    }
    this.port.assertApplyIdle();
    const operation = creatorOperationSchema.parse(proposal.operation);
    let unchanged = false;
    try { unchanged = hash(this.port.baseline(operation)) === hash(proposal.before); } catch { /* Target removed or unavailable. */ }
    if (!unchanged) {
      this.finish(id, "stale", undefined, "目标已变化，请让创作助手重新读取并提出草案。");
      throw new CreatorError("目标已变化，旧草案不会覆盖你的新修改", 409);
    }
    this.finish(id, "applying");
    try {
      // No await: approval, conflict check and synchronous domain mutation cannot interleave.
      const result = this.port.execute(operation);
      this.finish(id, "applied", result);
      this.message("system", `已确认并应用草案「${proposal.title}」。结果：${JSON.stringify(result)}`, undefined);
    } catch {
      this.finish(id, "failed", undefined, "变更未能完整完成，请检查目标现状后重新提出草案；不会自动重试。");
      throw new CreatorError("变更未能完整完成，请检查目标现状；不会自动重试。", 409);
    }
    return this.getProposal(id);
  }
  async send(text: string, requestId: string) {
    this.available();
    if (typeof text !== "string" || !text.trim() || text.length > 8000 || typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/u.test(requestId)) throw new CreatorError("消息或请求编号不合法");
    const previous = this.database.connection.prepare("SELECT text,status FROM creator_turns WHERE id=?").get(requestId) as { text: string; status: string } | undefined;
    if (previous) {
      if (previous.text !== text) throw new CreatorError("请求编号已用于另一条消息", 409);
      return { status: previous.status, ...this.snapshot() };
    }
    if (this.active) throw new CreatorError("创作助手正在处理上一条消息", 409);
    const history = this.snapshot().messages;
    const controller = new AbortController();
    this.active = { id: requestId, controller };
    const timeout = setTimeout(() => controller.abort(), 120_000);
    let status = "completed";
    try {
      this.database.connection.prepare("INSERT INTO creator_turns(id,text,status,created_at) VALUES(?,?,'running',?)").run(requestId, text, this.clock.now().toISOString());
      this.message("user", text, requestId);
      const reply = await this.runner({ id: requestId, text, history, service: this, signal: controller.signal });
      if (controller.signal.aborted || this.disposed) throw new CreatorError("已停止回复");
      this.message("assistant", reply.slice(0, 20000), requestId);
    } catch (error) {
      status = controller.signal.aborted ? "cancelled" : "failed";
      if (!this.disposed) this.message("system", status === "cancelled"
        ? "回复已停止或超时。此轮草案已撤销，没有自动应用任何修改。"
        : (error instanceof CreatorError ? error.message : "回复未完成，请检查默认模型配置或稍后重试") + "。此轮草案已撤销。", requestId);
    } finally {
      clearTimeout(timeout);
      if (!this.disposed) {
        this.database.connection.prepare("UPDATE creator_turns SET status=? WHERE id=?").run(status, requestId);
        if (status !== "completed") this.database.connection.prepare("UPDATE creator_proposals SET status='rejected' WHERE turn_id=? AND status='pending'").run(requestId);
      }
      this.active = undefined;
    }
    return this.disposed ? { status } : { status, ...this.snapshot() };
  }
  cancel() { this.available(); this.active?.controller.abort(); return { busy: this.isBusy }; }
  dispose() { this.disposed = true; this.active?.controller.abort(); }
  export() {
    this.available();
    return { messages: this.database.connection.prepare("SELECT * FROM creator_messages ORDER BY seq").all(),
      proposals: (this.database.connection.prepare("SELECT * FROM creator_proposals ORDER BY rowid").all() as unknown as ProposalRow[]).map(row => this.decode(row)),
      turns: this.database.connection.prepare("SELECT * FROM creator_turns ORDER BY rowid").all() };
  }
  private message(role: CreatorMessage["role"], text: string, turnId: string | undefined) {
    this.database.connection.prepare("INSERT INTO creator_messages(role,text,turn_id,created_at) VALUES(?,?,?,?)")
      .run(role, text.slice(0, 20000), turnId ?? null, this.clock.now().toISOString());
  }
  private finish(id: string, status: CreatorProposal["status"], result?: unknown, error?: string) {
    this.database.connection.prepare("UPDATE creator_proposals SET status=?,result=?,error=?,updated_at=? WHERE id=?")
      .run(status, result === undefined ? null : JSON.stringify(result), error ?? null, this.clock.now().toISOString(), id);
  }
  private decode(row: ProposalRow): CreatorProposal {
    return { ...JSON.parse(row.payload), id: row.id, status: row.status, result: row.result ? JSON.parse(row.result) : undefined,
      error: row.error ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at };
  }
}
function integer(value: number) { if (!Number.isSafeInteger(value) || value < 0) throw new CreatorError("无效的分页位置"); return value; }
function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function targetFor(operation: CreatorOperation): CreatorTarget | undefined {
  if (operation.kind === "update_world") return { kind: "world", id: operation.worldId };
  if (operation.kind === "update_character") return { kind: "character", id: operation.characterId };
  if (operation.kind === "update_place") return { kind: "place", id: operation.placeId };
  return undefined;
}
