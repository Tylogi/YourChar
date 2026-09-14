import type { Clock } from "../app/clock.js";
import {
  maximumWorkflowConcurrency,
  type SessionWorkflowDecisionReason,
  type SessionWorkflowDetail,
  type SessionWorkflowNodeExecution,
  type SessionWorkflowNodeKind,
  type SessionWorkflowReplayDecision,
  type SessionWorkflowResultReference,
  type SessionWorkflowService,
} from "./session-workflows.js";

export type WorkflowChildStatus =
  | "queued"
  | "running"
  | "idle"
  | "completed"
  | "failed"
  | "cancelled";

export type WorkflowChildState = Readonly<{
  id: string;
  status: WorkflowChildStatus;
  reference: SessionWorkflowResultReference;
  /** Safe Subagent checkpoints can recover automatically; shell jobs never can. */
  recovery?: "automatic_pending" | "decision_required" | "unavailable";
  decisionReason?: SessionWorkflowDecisionReason;
}>;

export type SessionWorkflowCoordinatorPort = Readonly<{
  findByAdmission: (
    parentSessionId: string,
    execution: SessionWorkflowNodeExecution,
  ) => WorkflowChildState | undefined;
  findById: (
    parentSessionId: string,
    execution: SessionWorkflowNodeExecution,
  ) => WorkflowChildState | undefined;
  start: (
    parentSessionId: string,
    execution: SessionWorkflowNodeExecution,
    dependencyReferences: readonly SessionWorkflowResultReference[],
    timeoutSeconds: number,
  ) => WorkflowChildState;
  retry: (
    parentSessionId: string,
    execution: SessionWorkflowNodeExecution,
    timeoutSeconds: number,
  ) => WorkflowChildState;
  interrupt: (
    parentSessionId: string,
    execution: SessionWorkflowNodeExecution,
  ) => Promise<WorkflowChildState | undefined>;
  isCapacityError: (error: unknown) => boolean;
}>;

/**
 * Host-owned DAG pump. Every launch reservation and replay choice is durable
 * before a child side effect begins, so re-running this coordinator is safe.
 */
export class SessionWorkflowCoordinator {
  private readonly scheduled = new Set<string>();
  private readonly pumping = new Set<string>();
  private readonly rerun = new Set<string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private disposed = false;

  constructor(
    private readonly service: SessionWorkflowService,
    private readonly clock: Clock,
    private readonly port: SessionWorkflowCoordinatorPort,
  ) {}

  recover(): number {
    if (this.disposed) return 0;
    const workflows = this.service.listRecoverable(100);
    for (const workflow of workflows) this.schedule(workflow.parentSessionId, workflow.id);
    return workflows.length;
  }

  start(
    parentSessionId: string,
    workflowId: string,
    expectedRevision: number,
    source: "agent" | "http" | "host" = "host",
  ): SessionWorkflowDetail {
    const workflow = this.service.start(parentSessionId, workflowId, expectedRevision, source);
    this.armDeadline(workflow);
    this.schedule(parentSessionId, workflowId);
    return workflow;
  }

  cancel(
    parentSessionId: string,
    workflowId: string,
    expectedRevision: number,
    note: string,
    source: "agent" | "http" | "host" = "host",
  ): SessionWorkflowDetail {
    const workflow = this.service.requestCancel(
      parentSessionId,
      workflowId,
      expectedRevision,
      note,
      source,
    );
    this.schedule(parentSessionId, workflowId);
    return workflow;
  }

  decideReplay(
    parentSessionId: string,
    workflowId: string,
    nodeKey: string,
    decision: SessionWorkflowReplayDecision,
    note: string,
  ): SessionWorkflowDetail {
    const workflow = this.service.decideReplay(
      parentSessionId,
      workflowId,
      nodeKey,
      decision,
      note,
      "http",
    );
    this.schedule(parentSessionId, workflowId);
    return workflow;
  }

  onChildTerminal(kind: SessionWorkflowNodeKind, childJobId: string): void {
    if (this.disposed) return;
    const workflow = this.service.findWorkflowForChild(kind, childJobId);
    if (workflow) this.schedule(workflow.parentSessionId, workflow.id);
    // A terminal child also frees global/per-session capacity for a different
    // workflow whose reservation was previously deferred.
    this.recover();
  }

  schedule(parentSessionId: string, workflowId: string): void {
    if (this.disposed) return;
    const key = `${parentSessionId}\0${workflowId}`;
    if (this.pumping.has(key)) {
      this.rerun.add(key);
      return;
    }
    if (this.scheduled.has(key)) return;
    this.scheduled.add(key);
    queueMicrotask(() => {
      this.scheduled.delete(key);
      void this.pump(parentSessionId, workflowId).catch(() => undefined);
    });
  }

  async pump(parentSessionId: string, workflowId: string): Promise<SessionWorkflowDetail> {
    const key = `${parentSessionId}\0${workflowId}`;
    if (this.disposed || this.pumping.has(key)) {
      if (!this.disposed) this.rerun.add(key);
      const existing = this.service.get(parentSessionId, workflowId);
      if (!existing) throw new Error(`Workflow is unavailable: ${workflowId}`);
      return existing;
    }
    this.pumping.add(key);
    try {
      let workflow = this.service.get(parentSessionId, workflowId);
      if (!workflow) throw new Error(`Workflow is unavailable: ${workflowId}`);
      if (workflow.deadlineAt && Date.parse(workflow.deadlineAt) <= this.clock.now().getTime() &&
          !["completed", "failed", "cancelled"].includes(workflow.status)) {
        workflow = this.service.markDeadlineExceeded(parentSessionId, workflowId);
      }

      if (workflow.status !== "cancelling") await this.reconcileChildren(workflow);
      workflow = this.service.get(parentSessionId, workflowId) ?? workflow;
      if (workflow.status === "cancelling") {
        await this.cancelChildren(workflow);
      }
      workflow = this.service.settle(parentSessionId, workflowId);

      if (workflow.status === "running") {
        for (;;) {
          const reservations = this.service.reserveReady(
            parentSessionId,
            workflowId,
            maximumWorkflowConcurrency,
            "host",
          );
          if (!reservations.length) break;
          let capacityDeferred = false;
          for (const execution of reservations) {
            const launched = await this.launchOrRecover(workflow, execution);
            if (!launched) capacityDeferred = true;
          }
          if (capacityDeferred) break;
          workflow = this.service.settle(parentSessionId, workflowId);
          if (workflow.status !== "running") break;
        }
        workflow = this.service.settle(parentSessionId, workflowId);
      }
      if (["completed", "failed", "cancelled"].includes(workflow.status)) {
        this.clearDeadline(workflow.id);
      } else {
        this.armDeadline(workflow);
      }
      return workflow;
    } finally {
      this.pumping.delete(key);
      if (this.rerun.delete(key) && !this.disposed) {
        this.schedule(parentSessionId, workflowId);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.scheduled.clear();
    this.rerun.clear();
  }

  private async reconcileChildren(workflow: SessionWorkflowDetail): Promise<void> {
    for (const node of workflow.nodes) {
      if (node.status !== "launching" && node.status !== "running") continue;
      const execution = this.service.getNodeExecution(workflow.parentSessionId, node.id);
      await this.launchOrRecover(workflow, execution);
    }
  }

  private async launchOrRecover(
    workflow: SessionWorkflowDetail,
    execution: SessionWorkflowNodeExecution,
  ): Promise<boolean> {
    let child = execution.node.childJobId
      ? this.port.findById(workflow.parentSessionId, execution)
      : this.port.findByAdmission(workflow.parentSessionId, execution);
    try {
      if (child && !execution.node.childJobId) {
        this.service.attachChild(workflow.parentSessionId, execution.node.id, child.id, "recovery");
        execution = this.service.getNodeExecution(workflow.parentSessionId, execution.node.id);
      }
      if (!child) {
        if (execution.node.childJobId) {
          this.service.applyChildStatus(workflow.parentSessionId, execution.node.id, {
            status: "decision_required",
            decisionReason: "child_missing",
            resultReference: {
              kind: "workflow_decision",
              status: "decision_required",
              reason: "child_missing",
            },
          }, "recovery");
          return true;
        }
        const timeoutSeconds = remainingTimeoutSeconds(workflow, execution, this.clock.now());
        child = this.port.start(
          workflow.parentSessionId,
          execution,
          this.service.dependencyReferences(execution.node.id),
          timeoutSeconds,
        );
        this.service.attachChild(workflow.parentSessionId, execution.node.id, child.id, "host");
      } else if (execution.node.status === "launching" && execution.node.childJobId &&
          child.status === "idle") {
        const timeoutSeconds = remainingTimeoutSeconds(workflow, execution, this.clock.now());
        child = this.port.retry(workflow.parentSessionId, execution, timeoutSeconds);
        this.service.attachChild(workflow.parentSessionId, execution.node.id, child.id, "host");
      }
      this.applyChild(workflow.parentSessionId, execution.node.id, child);
      return true;
    } catch (error) {
      if (this.port.isCapacityError(error)) {
        // A fresh reservation can safely return to pending. An attached idle
        // child has already consumed a trusted replay decision, so retain the
        // launching state and retry that decision when child capacity frees.
        if (!execution.node.childJobId) {
          this.service.deferUnattachedLaunch(workflow.parentSessionId, execution.node.id);
        }
        return false;
      }
      if (!execution.node.childJobId && !child) {
        const admitted = this.port.findByAdmission(workflow.parentSessionId, execution);
        if (admitted) {
          this.service.attachChild(
            workflow.parentSessionId,
            execution.node.id,
            admitted.id,
            "recovery",
          );
          this.applyChild(workflow.parentSessionId, execution.node.id, admitted);
          return true;
        }
      }
      if (!execution.node.childJobId && !child) {
        this.service.failUnattachedLaunch(
          workflow.parentSessionId,
          execution.node.id,
          safeErrorCode(error),
        );
        return true;
      }
      if (execution.node.childJobId && child?.status === "idle") {
        this.service.applyChildStatus(workflow.parentSessionId, execution.node.id, {
          status: "decision_required",
          decisionReason: child.decisionReason ?? "process_restarted",
          resultReference: child.reference,
        }, "recovery");
        return true;
      }
      throw error;
    }
  }

  private applyChild(parentSessionId: string, nodeId: string, child: WorkflowChildState): void {
    if (child.status === "queued" || child.status === "running" ||
        (child.status === "idle" && child.recovery === "automatic_pending")) {
      return;
    }
    if (child.status === "idle") {
      this.service.applyChildStatus(parentSessionId, nodeId, {
        status: "decision_required",
        decisionReason: child.decisionReason ?? "process_restarted",
        resultReference: child.reference,
      }, "recovery");
      return;
    }
    this.service.applyChildStatus(parentSessionId, nodeId, {
      status: child.status,
      resultReference: child.reference,
    }, "host");
  }

  private async cancelChildren(workflow: SessionWorkflowDetail): Promise<void> {
    await Promise.all(workflow.nodes.map(async (node) => {
      if (node.status === "launching" && !node.childJobId) {
        this.service.failUnattachedLaunch(workflow.parentSessionId, node.id, "cancelled");
        return;
      }
      if (node.status !== "running" && node.status !== "launching") return;
      const execution = this.service.getNodeExecution(workflow.parentSessionId, node.id);
      const child = await this.port.interrupt(workflow.parentSessionId, execution);
      if (child) this.applyChild(workflow.parentSessionId, node.id, child);
    }));
  }

  private armDeadline(workflow: SessionWorkflowDetail): void {
    if (!workflow.deadlineAt || ["planned", "completed", "failed", "cancelled"].includes(workflow.status)) {
      return;
    }
    const existing = this.timers.get(workflow.id);
    if (existing) clearTimeout(existing);
    const delayMs = Math.max(1, Date.parse(workflow.deadlineAt) - this.clock.now().getTime());
    const timer = setTimeout(() => {
      this.timers.delete(workflow.id);
      this.schedule(workflow.parentSessionId, workflow.id);
    }, Math.min(delayMs, 2_147_483_647));
    timer.unref?.();
    this.timers.set(workflow.id, timer);
  }

  private clearDeadline(workflowId: string): void {
    const timer = this.timers.get(workflowId);
    if (timer) clearTimeout(timer);
    this.timers.delete(workflowId);
  }
}

function remainingTimeoutSeconds(
  workflow: SessionWorkflowDetail,
  execution: SessionWorkflowNodeExecution,
  now: Date,
): number {
  const remaining = workflow.deadlineAt
    ? Math.max(1, Math.ceil((Date.parse(workflow.deadlineAt) - now.getTime()) / 1_000))
    : execution.node.timeoutSeconds;
  return Math.max(1, Math.min(execution.node.timeoutSeconds, remaining));
}

function safeErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) return String(error.code).slice(0, 128);
  return "child_launch_failed";
}
