import type { Clock } from "../app/clock.js";
import type { IdGenerator } from "../app/id-generator.js";
import type { ConversationSpace, Mode } from "../domain/types.js";
import type { AppDatabase } from "../storage/database.js";

export const maximumSessionGoalTitleCharacters = 240;
export const maximumSessionGoalSuccessCriteriaCharacters = 2_000;
export const maximumSessionGoalPlanCharacters = 4_000;
export const maximumSessionGoalNotesCharacters = 1_000;
export const maximumSessionGoalTransitionNoteCharacters = 2_000;
export const maximumSessionGoalDependencies = 16;
export const maximumSessionGoalTodos = 50;
export const maximumSessionGoalListLimit = 100;
export const maximumSessionGoalTransitionLimit = 100;

export type SessionGoalPriority = "low" | "normal" | "high" | "urgent";
export type SessionGoalStatus =
  | "planned"
  | "active"
  | "blocked"
  | "completed"
  | "cancelled";
export type SessionGoalTodoStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled";
export type SessionGoalMutationSource = "agent" | "http" | "host";
export type SessionGoalTransitionType =
  | "goal_created"
  | "goal_updated"
  | "goal_status_changed"
  | "dependencies_replaced"
  | "todo_created"
  | "todo_updated"
  | "todo_status_changed";

export type SessionGoalScope = Readonly<{
  parentSessionId: string;
  mode: Mode;
  conversationSpace: ConversationSpace;
  characterId?: string;
  secretOwnerCharacterId?: string;
}>;

export type SessionGoalTodo = Readonly<{
  id: string;
  goalId: string;
  position: number;
  title: string;
  notes: string;
  status: SessionGoalTodoStatus;
  revision: number;
  resultNote?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}>;

export type SessionGoalDependency = Readonly<{
  id: string;
  title: string;
  status: SessionGoalStatus;
  priority: SessionGoalPriority;
  satisfied: boolean;
}>;

export type SessionGoalTransition = Readonly<{
  id: string;
  sequence: number;
  type: SessionGoalTransitionType;
  source: SessionGoalMutationSource;
  subjectType: "goal" | "todo" | "dependencies";
  subjectId: string;
  fromStatus?: SessionGoalStatus | SessionGoalTodoStatus;
  toStatus?: SessionGoalStatus | SessionGoalTodoStatus;
  note?: string;
  createdAt: string;
}>;

export type SessionGoalTodoCounts = Readonly<{
  pending: number;
  inProgress: number;
  completed: number;
  cancelled: number;
  remaining: number;
  total: number;
}>;

export type SessionGoalSummary = Readonly<{
  id: string;
  parentSessionId: string;
  mode: Mode;
  conversationSpace: ConversationSpace;
  characterId?: string;
  secretOwnerCharacterId?: string;
  title: string;
  status: SessionGoalStatus;
  priority: SessionGoalPriority;
  revision: number;
  dependencyCount: number;
  blockedByGoalIds: readonly string[];
  ready: boolean;
  todoCounts: SessionGoalTodoCounts;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}>;

export type SessionGoalDetail = SessionGoalSummary & Readonly<{
  successCriteria: string;
  plan: string;
  notes: string;
  terminalNote?: string;
  dependencies: readonly SessionGoalDependency[];
  todos: readonly SessionGoalTodo[];
  recentTransitions: readonly SessionGoalTransition[];
}>;

export type CreateSessionGoalInput = Readonly<{
  title: string;
  successCriteria: string;
  plan?: string;
  notes?: string;
  priority?: SessionGoalPriority;
  dependencyGoalIds?: readonly string[];
}>;

export type UpdateSessionGoalInput = Readonly<{
  expectedRevision: number;
  title?: string;
  successCriteria?: string;
  plan?: string;
  notes?: string;
  priority?: SessionGoalPriority;
  transitionNote?: string;
}>;

export type TransitionSessionGoalInput = Readonly<{
  expectedRevision: number;
  status: SessionGoalStatus;
  note?: string;
}>;

export type CreateSessionGoalTodoInput = Readonly<{
  expectedGoalRevision: number;
  title: string;
  notes?: string;
}>;

export type UpdateSessionGoalTodoInput = Readonly<{
  expectedGoalRevision: number;
  expectedTodoRevision: number;
  title?: string;
  notes?: string;
  transitionNote?: string;
}>;

export type TransitionSessionGoalTodoInput = Readonly<{
  expectedGoalRevision: number;
  expectedTodoRevision: number;
  status: SessionGoalTodoStatus;
  note?: string;
}>;

type GoalRow = {
  id: string;
  parent_session_id: string;
  mode: string;
  conversation_space: string;
  character_id: string | null;
  secret_owner_character_id: string | null;
  title: string;
  success_criteria: string;
  plan_text: string;
  notes: string;
  priority: string;
  status: string;
  revision: number;
  terminal_note: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};

type TodoRow = {
  id: string;
  goal_id: string;
  position: number;
  title: string;
  notes: string;
  status: string;
  revision: number;
  result_note: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};

type TransitionRow = {
  id: string;
  sequence: number;
  transition_type: string;
  source: string;
  subject_type: string;
  subject_id: string;
  from_status: string | null;
  to_status: string | null;
  note: string | null;
  created_at: string;
};

const goalStatusTransitions: Readonly<Record<SessionGoalStatus, readonly SessionGoalStatus[]>> = {
  planned: Object.freeze(["active", "blocked", "completed", "cancelled"]),
  active: Object.freeze(["blocked", "completed", "cancelled"]),
  blocked: Object.freeze(["active", "completed", "cancelled"]),
  completed: Object.freeze([]),
  cancelled: Object.freeze([]),
};

const todoStatusTransitions: Readonly<
  Record<SessionGoalTodoStatus, readonly SessionGoalTodoStatus[]>
> = {
  pending: Object.freeze(["in_progress", "completed", "cancelled"]),
  in_progress: Object.freeze(["pending", "completed", "cancelled"]),
  completed: Object.freeze([]),
  cancelled: Object.freeze([]),
};

export class SessionGoalNotFoundError extends Error {
  readonly code = "SESSION_GOAL_NOT_FOUND";

  constructor(goalId: string) {
    super(`Goal is unavailable: ${goalId}`);
    this.name = "SessionGoalNotFoundError";
  }
}

export class SessionGoalTodoNotFoundError extends Error {
  readonly code = "SESSION_GOAL_TODO_NOT_FOUND";

  constructor(todoId: string) {
    super(`Goal todo is unavailable: ${todoId}`);
    this.name = "SessionGoalTodoNotFoundError";
  }
}

export class SessionGoalConflictError extends Error {
  readonly code = "SESSION_GOAL_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "SessionGoalConflictError";
  }
}

export class SessionGoalValidationError extends Error {
  readonly code = "SESSION_GOAL_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "SessionGoalValidationError";
  }
}

/**
 * Durable, session-owned work state. Every mutation updates the current
 * projection and appends exactly one typed transition in the same transaction.
 */
export class SessionGoalService {
  constructor(
    private readonly database: AppDatabase,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  create(
    scope: SessionGoalScope,
    input: CreateSessionGoalInput,
    source: SessionGoalMutationSource = "host",
  ): SessionGoalDetail {
    validateScope(scope);
    validateSource(source);
    const title = boundedText(
      input.title,
      "title",
      maximumSessionGoalTitleCharacters,
      true,
    );
    const successCriteria = boundedText(
      input.successCriteria,
      "successCriteria",
      maximumSessionGoalSuccessCriteriaCharacters,
      true,
    );
    const plan = boundedText(
      input.plan ?? "",
      "plan",
      maximumSessionGoalPlanCharacters,
    );
    const notes = boundedText(
      input.notes ?? "",
      "notes",
      maximumSessionGoalNotesCharacters,
    );
    const priority = input.priority ?? "normal";
    validatePriority(priority);
    const dependencyGoalIds = normalizeIdList(
      input.dependencyGoalIds ?? [],
      "dependencyGoalIds",
      maximumSessionGoalDependencies,
    );
    for (const dependencyId of dependencyGoalIds) {
      const dependency = this.requireGoal(scope.parentSessionId, dependencyId);
      if (dependency.status === "cancelled") {
        throw new SessionGoalConflictError(`Dependency goal ${dependencyId} is cancelled`);
      }
    }

    const id = this.idGenerator.next("session-goal");
    const now = this.now();
    this.database.transaction(() => {
      this.database.connection.prepare(`
        INSERT INTO session_goals(
          id, parent_session_id, mode, conversation_space, character_id,
          secret_owner_character_id, title, success_criteria, plan_text, notes,
          priority, status, revision, terminal_note, created_at, updated_at,
          finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', 1, NULL, ?, ?, NULL)
      `).run(
        id,
        scope.parentSessionId,
        scope.mode,
        scope.conversationSpace,
        scope.characterId ?? null,
        scope.secretOwnerCharacterId ?? null,
        title,
        successCriteria,
        plan,
        notes,
        priority,
        now,
        now,
      );
      this.replaceDependencyRows(scope.parentSessionId, id, dependencyGoalIds, now);
      this.appendTransition({
        goalId: id,
        parentSessionId: scope.parentSessionId,
        sequence: 1,
        type: "goal_created",
        source,
        subjectType: "goal",
        subjectId: id,
        payload: { title, successCriteria, plan, notes, priority, dependencyGoalIds },
        now,
      });
    });
    return this.requireDetail(scope.parentSessionId, id);
  }

  list(
    parentSessionId: string,
    options: { includeTerminal?: boolean; limit?: number } = {},
  ): readonly SessionGoalSummary[] {
    validateId(parentSessionId, "parentSessionId");
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > maximumSessionGoalListLimit) {
      throw new SessionGoalValidationError(
        `limit must be an integer between 1 and ${maximumSessionGoalListLimit}`,
      );
    }
    const terminalClause = options.includeTerminal
      ? ""
      : "AND status NOT IN ('completed', 'cancelled')";
    const rows = this.database.connection.prepare(`
      SELECT * FROM session_goals
      WHERE parent_session_id = ? ${terminalClause}
      ORDER BY
        CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
          WHEN 'normal' THEN 2 ELSE 3 END,
        updated_at DESC, id DESC
      LIMIT ?
    `).all(parentSessionId, limit) as unknown as GoalRow[];
    return Object.freeze(rows.map((row) => this.mapSummary(row)));
  }

  get(
    parentSessionId: string,
    goalId: string,
    transitionLimit = 20,
  ): SessionGoalDetail | undefined {
    validateId(parentSessionId, "parentSessionId");
    validateId(goalId, "goalId");
    if (
      !Number.isInteger(transitionLimit) ||
      transitionLimit < 0 ||
      transitionLimit > maximumSessionGoalTransitionLimit
    ) {
      throw new SessionGoalValidationError(
        `transitionLimit must be an integer between 0 and ${maximumSessionGoalTransitionLimit}`,
      );
    }
    const row = this.findGoal(parentSessionId, goalId);
    return row ? this.mapDetail(row, transitionLimit) : undefined;
  }

  update(
    parentSessionId: string,
    goalId: string,
    input: UpdateSessionGoalInput,
    source: SessionGoalMutationSource = "host",
  ): SessionGoalDetail {
    validateSource(source);
    validateRevision(input.expectedRevision, "expectedRevision");
    const goal = this.requireGoal(parentSessionId, goalId);
    this.assertRevision(goal, input.expectedRevision);
    this.assertGoalMutable(goal);
    const changed: Record<string, string> = {};
    const title = input.title === undefined
      ? goal.title
      : boundedText(input.title, "title", maximumSessionGoalTitleCharacters, true);
    if (title !== goal.title) changed.title = title;
    const successCriteria = input.successCriteria === undefined
      ? goal.success_criteria
      : boundedText(
          input.successCriteria,
          "successCriteria",
          maximumSessionGoalSuccessCriteriaCharacters,
          true,
        );
    if (successCriteria !== goal.success_criteria) changed.successCriteria = successCriteria;
    const plan = input.plan === undefined
      ? goal.plan_text
      : boundedText(input.plan, "plan", maximumSessionGoalPlanCharacters);
    if (plan !== goal.plan_text) changed.plan = plan;
    const notes = input.notes === undefined
      ? goal.notes
      : boundedText(input.notes, "notes", maximumSessionGoalNotesCharacters);
    if (notes !== goal.notes) changed.notes = notes;
    const priority = (input.priority ?? goal.priority) as SessionGoalPriority;
    validatePriority(priority);
    if (priority !== goal.priority) changed.priority = priority;
    if (!Object.keys(changed).length) {
      throw new SessionGoalValidationError("goal update must change at least one field");
    }
    const transitionNote = optionalBoundedText(
      input.transitionNote,
      "transitionNote",
      maximumSessionGoalTransitionNoteCharacters,
    );
    const revision = goal.revision + 1;
    const now = this.now();
    this.database.transaction(() => {
      this.updateGoalRevision(goal, input.expectedRevision, `
        title = ?, success_criteria = ?, plan_text = ?, notes = ?, priority = ?,
      `, [title, successCriteria, plan, notes, priority], now);
      this.appendTransition({
        goalId,
        parentSessionId,
        sequence: revision,
        type: "goal_updated",
        source,
        subjectType: "goal",
        subjectId: goalId,
        payload: changed,
        ...(transitionNote ? { note: transitionNote } : {}),
        now,
      });
    });
    return this.requireDetail(parentSessionId, goalId);
  }

  transition(
    parentSessionId: string,
    goalId: string,
    input: TransitionSessionGoalInput,
    source: SessionGoalMutationSource = "host",
  ): SessionGoalDetail {
    validateSource(source);
    validateRevision(input.expectedRevision, "expectedRevision");
    validateGoalStatus(input.status);
    const goal = this.requireGoal(parentSessionId, goalId);
    this.assertRevision(goal, input.expectedRevision);
    const fromStatus = goal.status as SessionGoalStatus;
    if (!goalStatusTransitions[fromStatus].includes(input.status)) {
      throw new SessionGoalConflictError(
        `Goal ${goalId} cannot transition from ${fromStatus} to ${input.status}`,
      );
    }
    const note = optionalBoundedText(
      input.note,
      "note",
      maximumSessionGoalTransitionNoteCharacters,
    );
    if (["blocked", "completed", "cancelled"].includes(input.status) && !note) {
      throw new SessionGoalValidationError(
        `note is required when a goal becomes ${input.status}`,
      );
    }
    if (input.status === "completed") this.assertGoalCompletable(goal);
    const revision = goal.revision + 1;
    const now = this.now();
    const terminal = input.status === "completed" || input.status === "cancelled";
    this.database.transaction(() => {
      this.updateGoalRevision(goal, input.expectedRevision, `
        status = ?, terminal_note = ?, finished_at = ?,
      `, [input.status, terminal ? note ?? null : null, terminal ? now : null], now);
      this.appendTransition({
        goalId,
        parentSessionId,
        sequence: revision,
        type: "goal_status_changed",
        source,
        subjectType: "goal",
        subjectId: goalId,
        fromStatus,
        toStatus: input.status,
        payload: { fromStatus, toStatus: input.status },
        ...(note ? { note } : {}),
        now,
      });
    });
    return this.requireDetail(parentSessionId, goalId);
  }

  setDependencies(
    parentSessionId: string,
    goalId: string,
    expectedRevision: number,
    dependencyGoalIds: readonly string[],
    source: SessionGoalMutationSource = "host",
    transitionNote?: string,
  ): SessionGoalDetail {
    validateSource(source);
    validateRevision(expectedRevision, "expectedRevision");
    const goal = this.requireGoal(parentSessionId, goalId);
    this.assertRevision(goal, expectedRevision);
    this.assertGoalMutable(goal);
    const normalized = normalizeIdList(
      dependencyGoalIds,
      "dependencyGoalIds",
      maximumSessionGoalDependencies,
    );
    if (normalized.includes(goalId)) {
      throw new SessionGoalValidationError("a goal cannot depend on itself");
    }
    for (const dependencyId of normalized) {
      const dependency = this.requireGoal(parentSessionId, dependencyId);
      if (dependency.status === "cancelled") {
        throw new SessionGoalConflictError(`Dependency goal ${dependencyId} is cancelled`);
      }
      if (this.dependencyReaches(parentSessionId, dependencyId, goalId)) {
        throw new SessionGoalValidationError(
          `dependency ${dependencyId} would create a cycle`,
        );
      }
    }
    const current = this.dependencyIds(parentSessionId, goalId);
    if (arraysEqual(current, normalized)) {
      throw new SessionGoalValidationError("dependency set is unchanged");
    }
    const note = optionalBoundedText(
      transitionNote,
      "transitionNote",
      maximumSessionGoalTransitionNoteCharacters,
    );
    const revision = goal.revision + 1;
    const now = this.now();
    this.database.transaction(() => {
      this.updateGoalRevision(goal, expectedRevision, "", [], now);
      this.replaceDependencyRows(parentSessionId, goalId, normalized, now);
      this.appendTransition({
        goalId,
        parentSessionId,
        sequence: revision,
        type: "dependencies_replaced",
        source,
        subjectType: "dependencies",
        subjectId: goalId,
        payload: { dependencyGoalIds: normalized },
        ...(note ? { note } : {}),
        now,
      });
    });
    return this.requireDetail(parentSessionId, goalId);
  }

  createTodo(
    parentSessionId: string,
    goalId: string,
    input: CreateSessionGoalTodoInput,
    source: SessionGoalMutationSource = "host",
  ): SessionGoalDetail {
    validateSource(source);
    validateRevision(input.expectedGoalRevision, "expectedGoalRevision");
    const goal = this.requireGoal(parentSessionId, goalId);
    this.assertRevision(goal, input.expectedGoalRevision);
    this.assertGoalMutable(goal);
    const count = Number((this.database.connection.prepare(`
      SELECT COUNT(*) AS count FROM session_goal_todos
      WHERE parent_session_id = ? AND goal_id = ?
    `).get(parentSessionId, goalId) as { count: number }).count);
    if (count >= maximumSessionGoalTodos) {
      throw new SessionGoalConflictError(
        `a goal may contain at most ${maximumSessionGoalTodos} todos`,
      );
    }
    const title = boundedText(
      input.title,
      "title",
      maximumSessionGoalTitleCharacters,
      true,
    );
    const notes = boundedText(
      input.notes ?? "",
      "notes",
      maximumSessionGoalNotesCharacters,
    );
    const position = Number((this.database.connection.prepare(`
      SELECT COALESCE(MAX(position), 0) + 1 AS position
      FROM session_goal_todos WHERE parent_session_id = ? AND goal_id = ?
    `).get(parentSessionId, goalId) as { position: number }).position);
    const todoId = this.idGenerator.next("session-goal-todo");
    const revision = goal.revision + 1;
    const now = this.now();
    this.database.transaction(() => {
      this.updateGoalRevision(goal, input.expectedGoalRevision, "", [], now);
      this.database.connection.prepare(`
        INSERT INTO session_goal_todos(
          id, goal_id, parent_session_id, position, title, notes, status,
          revision, result_note, created_at, updated_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 1, NULL, ?, ?, NULL)
      `).run(todoId, goalId, parentSessionId, position, title, notes, now, now);
      this.appendTransition({
        goalId,
        parentSessionId,
        sequence: revision,
        type: "todo_created",
        source,
        subjectType: "todo",
        subjectId: todoId,
        payload: { todoId, title, notes, position },
        now,
      });
    });
    return this.requireDetail(parentSessionId, goalId);
  }

  updateTodo(
    parentSessionId: string,
    goalId: string,
    todoId: string,
    input: UpdateSessionGoalTodoInput,
    source: SessionGoalMutationSource = "host",
  ): SessionGoalDetail {
    validateSource(source);
    validateRevision(input.expectedGoalRevision, "expectedGoalRevision");
    validateRevision(input.expectedTodoRevision, "expectedTodoRevision");
    const goal = this.requireGoal(parentSessionId, goalId);
    this.assertRevision(goal, input.expectedGoalRevision);
    this.assertGoalMutable(goal);
    const todo = this.requireTodo(parentSessionId, goalId, todoId);
    this.assertTodoRevision(todo, input.expectedTodoRevision);
    this.assertTodoMutable(todo);
    const title = input.title === undefined
      ? todo.title
      : boundedText(input.title, "title", maximumSessionGoalTitleCharacters, true);
    const notes = input.notes === undefined
      ? todo.notes
      : boundedText(input.notes, "notes", maximumSessionGoalNotesCharacters);
    const changed: Record<string, string> = {};
    if (title !== todo.title) changed.title = title;
    if (notes !== todo.notes) changed.notes = notes;
    if (!Object.keys(changed).length) {
      throw new SessionGoalValidationError("todo update must change at least one field");
    }
    const transitionNote = optionalBoundedText(
      input.transitionNote,
      "transitionNote",
      maximumSessionGoalTransitionNoteCharacters,
    );
    const revision = goal.revision + 1;
    const now = this.now();
    this.database.transaction(() => {
      this.updateGoalRevision(goal, input.expectedGoalRevision, "", [], now);
      const update = this.database.connection.prepare(`
        UPDATE session_goal_todos
        SET title = ?, notes = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND goal_id = ? AND parent_session_id = ? AND revision = ?
      `).run(
        title,
        notes,
        now,
        todoId,
        goalId,
        parentSessionId,
        input.expectedTodoRevision,
      );
      if (Number(update.changes) !== 1) this.throwTodoRevisionConflict(todoId);
      this.appendTransition({
        goalId,
        parentSessionId,
        sequence: revision,
        type: "todo_updated",
        source,
        subjectType: "todo",
        subjectId: todoId,
        payload: { todoId, ...changed },
        ...(transitionNote ? { note: transitionNote } : {}),
        now,
      });
    });
    return this.requireDetail(parentSessionId, goalId);
  }

  transitionTodo(
    parentSessionId: string,
    goalId: string,
    todoId: string,
    input: TransitionSessionGoalTodoInput,
    source: SessionGoalMutationSource = "host",
  ): SessionGoalDetail {
    validateSource(source);
    validateRevision(input.expectedGoalRevision, "expectedGoalRevision");
    validateRevision(input.expectedTodoRevision, "expectedTodoRevision");
    validateTodoStatus(input.status);
    const goal = this.requireGoal(parentSessionId, goalId);
    this.assertRevision(goal, input.expectedGoalRevision);
    this.assertGoalMutable(goal);
    const todo = this.requireTodo(parentSessionId, goalId, todoId);
    this.assertTodoRevision(todo, input.expectedTodoRevision);
    const fromStatus = todo.status as SessionGoalTodoStatus;
    if (!todoStatusTransitions[fromStatus].includes(input.status)) {
      throw new SessionGoalConflictError(
        `Todo ${todoId} cannot transition from ${fromStatus} to ${input.status}`,
      );
    }
    const note = optionalBoundedText(
      input.note,
      "note",
      maximumSessionGoalTransitionNoteCharacters,
    );
    if (["completed", "cancelled"].includes(input.status) && !note) {
      throw new SessionGoalValidationError(
        `note is required when a todo becomes ${input.status}`,
      );
    }
    const revision = goal.revision + 1;
    const now = this.now();
    const terminal = input.status === "completed" || input.status === "cancelled";
    this.database.transaction(() => {
      this.updateGoalRevision(goal, input.expectedGoalRevision, "", [], now);
      const update = this.database.connection.prepare(`
        UPDATE session_goal_todos
        SET status = ?, revision = revision + 1, result_note = ?,
            finished_at = ?, updated_at = ?
        WHERE id = ? AND goal_id = ? AND parent_session_id = ? AND revision = ?
      `).run(
        input.status,
        terminal ? note ?? null : null,
        terminal ? now : null,
        now,
        todoId,
        goalId,
        parentSessionId,
        input.expectedTodoRevision,
      );
      if (Number(update.changes) !== 1) this.throwTodoRevisionConflict(todoId);
      this.appendTransition({
        goalId,
        parentSessionId,
        sequence: revision,
        type: "todo_status_changed",
        source,
        subjectType: "todo",
        subjectId: todoId,
        fromStatus,
        toStatus: input.status,
        payload: { todoId, fromStatus, toStatus: input.status },
        ...(note ? { note } : {}),
        now,
      });
    });
    return this.requireDetail(parentSessionId, goalId);
  }

  private mapSummary(row: GoalRow): SessionGoalSummary {
    const dependencies = this.dependencies(row.parent_session_id, row.id);
    const blockedByGoalIds = dependencies
      .filter((entry) => !entry.satisfied)
      .map((entry) => entry.id);
    const todoCounts = this.todoCounts(row.parent_session_id, row.id);
    return Object.freeze({
      id: row.id,
      parentSessionId: row.parent_session_id,
      mode: row.mode as Mode,
      conversationSpace: row.conversation_space as ConversationSpace,
      ...(row.character_id ? { characterId: row.character_id } : {}),
      ...(row.secret_owner_character_id
        ? { secretOwnerCharacterId: row.secret_owner_character_id }
        : {}),
      title: row.title,
      status: row.status as SessionGoalStatus,
      priority: row.priority as SessionGoalPriority,
      revision: Number(row.revision),
      dependencyCount: dependencies.length,
      blockedByGoalIds: Object.freeze(blockedByGoalIds),
      ready: blockedByGoalIds.length === 0,
      todoCounts,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    });
  }

  private mapDetail(row: GoalRow, transitionLimit: number): SessionGoalDetail {
    const summary = this.mapSummary(row);
    const todos = this.database.connection.prepare(`
      SELECT * FROM session_goal_todos
      WHERE parent_session_id = ? AND goal_id = ?
      ORDER BY position ASC, id ASC
    `).all(row.parent_session_id, row.id) as unknown as TodoRow[];
    const transitions = transitionLimit === 0
      ? []
      : this.database.connection.prepare(`
          SELECT id, sequence, transition_type, source, subject_type, subject_id,
            from_status, to_status, note, created_at
          FROM session_goal_transitions
          WHERE parent_session_id = ? AND goal_id = ?
          ORDER BY sequence DESC LIMIT ?
        `).all(row.parent_session_id, row.id, transitionLimit) as unknown as TransitionRow[];
    return Object.freeze({
      ...summary,
      successCriteria: row.success_criteria,
      plan: row.plan_text,
      notes: row.notes,
      ...(row.terminal_note ? { terminalNote: row.terminal_note } : {}),
      dependencies: Object.freeze(this.dependencies(row.parent_session_id, row.id)),
      todos: Object.freeze(todos.map(mapTodo)),
      recentTransitions: Object.freeze(transitions.reverse().map(mapTransition)),
    });
  }

  private dependencies(parentSessionId: string, goalId: string): SessionGoalDependency[] {
    const rows = this.database.connection.prepare(`
      SELECT dependency.id, dependency.title, dependency.status, dependency.priority
      FROM session_goal_dependencies edge
      JOIN session_goals dependency ON dependency.id = edge.depends_on_goal_id
        AND dependency.parent_session_id = edge.parent_session_id
      WHERE edge.parent_session_id = ? AND edge.goal_id = ?
      ORDER BY dependency.id ASC
    `).all(parentSessionId, goalId) as unknown as Array<{
      id: string;
      title: string;
      status: string;
      priority: string;
    }>;
    return rows.map((entry) => Object.freeze({
      id: entry.id,
      title: entry.title,
      status: entry.status as SessionGoalStatus,
      priority: entry.priority as SessionGoalPriority,
      satisfied: entry.status === "completed",
    }));
  }

  private todoCounts(parentSessionId: string, goalId: string): SessionGoalTodoCounts {
    const row = this.database.connection.prepare(`
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
        COUNT(*) AS total
      FROM session_goal_todos WHERE parent_session_id = ? AND goal_id = ?
    `).get(parentSessionId, goalId) as {
      pending: number | null;
      in_progress: number | null;
      completed: number | null;
      cancelled: number | null;
      total: number;
    };
    const pending = Number(row.pending ?? 0);
    const inProgress = Number(row.in_progress ?? 0);
    const completed = Number(row.completed ?? 0);
    const cancelled = Number(row.cancelled ?? 0);
    return Object.freeze({
      pending,
      inProgress,
      completed,
      cancelled,
      remaining: pending + inProgress,
      total: Number(row.total),
    });
  }

  private findGoal(parentSessionId: string, goalId: string): GoalRow | undefined {
    return this.database.connection.prepare(`
      SELECT * FROM session_goals WHERE parent_session_id = ? AND id = ?
    `).get(parentSessionId, goalId) as unknown as GoalRow | undefined;
  }

  private requireGoal(parentSessionId: string, goalId: string): GoalRow {
    validateId(parentSessionId, "parentSessionId");
    validateId(goalId, "goalId");
    const row = this.findGoal(parentSessionId, goalId);
    if (!row) throw new SessionGoalNotFoundError(goalId);
    return row;
  }

  private requireDetail(parentSessionId: string, goalId: string): SessionGoalDetail {
    const detail = this.get(parentSessionId, goalId);
    if (!detail) throw new SessionGoalNotFoundError(goalId);
    return detail;
  }

  private requireTodo(parentSessionId: string, goalId: string, todoId: string): TodoRow {
    validateId(todoId, "todoId");
    const row = this.database.connection.prepare(`
      SELECT * FROM session_goal_todos
      WHERE parent_session_id = ? AND goal_id = ? AND id = ?
    `).get(parentSessionId, goalId, todoId) as unknown as TodoRow | undefined;
    if (!row) throw new SessionGoalTodoNotFoundError(todoId);
    return row;
  }

  private assertRevision(goal: GoalRow, expectedRevision: number): void {
    if (Number(goal.revision) !== expectedRevision) {
      throw new SessionGoalConflictError(
        `Goal ${goal.id} changed from expected revision ${expectedRevision}; current revision is ${goal.revision}`,
      );
    }
  }

  private assertTodoRevision(todo: TodoRow, expectedRevision: number): void {
    if (Number(todo.revision) !== expectedRevision) this.throwTodoRevisionConflict(todo.id);
  }

  private throwTodoRevisionConflict(todoId: string): never {
    throw new SessionGoalConflictError(`Todo ${todoId} changed; refresh the goal before retrying`);
  }

  private assertGoalMutable(goal: GoalRow): void {
    if (goal.status === "completed" || goal.status === "cancelled") {
      throw new SessionGoalConflictError(`Goal ${goal.id} is terminal and cannot be changed`);
    }
  }

  private assertTodoMutable(todo: TodoRow): void {
    if (todo.status === "completed" || todo.status === "cancelled") {
      throw new SessionGoalConflictError(`Todo ${todo.id} is terminal and cannot be changed`);
    }
  }

  private assertGoalCompletable(goal: GoalRow): void {
    const blockedBy = this.dependencies(goal.parent_session_id, goal.id)
      .filter((entry) => !entry.satisfied)
      .map((entry) => entry.id);
    if (blockedBy.length) {
      throw new SessionGoalConflictError(
        `Goal ${goal.id} still depends on incomplete goals: ${blockedBy.join(", ")}`,
      );
    }
    const remaining = this.todoCounts(goal.parent_session_id, goal.id).remaining;
    if (remaining > 0) {
      throw new SessionGoalConflictError(
        `Goal ${goal.id} still has ${remaining} unfinished todo(s)`,
      );
    }
  }

  private updateGoalRevision(
    goal: GoalRow,
    expectedRevision: number,
    assignments: string,
    values: readonly (string | number | null)[],
    now: string,
  ): void {
    const update = this.database.connection.prepare(`
      UPDATE session_goals SET ${assignments}
        revision = revision + 1, updated_at = ?
      WHERE id = ? AND parent_session_id = ? AND revision = ?
    `).run(...values, now, goal.id, goal.parent_session_id, expectedRevision);
    if (Number(update.changes) !== 1) {
      throw new SessionGoalConflictError(
        `Goal ${goal.id} changed; refresh it before retrying`,
      );
    }
  }

  private dependencyIds(parentSessionId: string, goalId: string): string[] {
    return (this.database.connection.prepare(`
      SELECT depends_on_goal_id FROM session_goal_dependencies
      WHERE parent_session_id = ? AND goal_id = ? ORDER BY depends_on_goal_id ASC
    `).all(parentSessionId, goalId) as Array<{ depends_on_goal_id: string }>)
      .map((entry) => entry.depends_on_goal_id);
  }

  private dependencyReaches(
    parentSessionId: string,
    startGoalId: string,
    targetGoalId: string,
  ): boolean {
    return Boolean(this.database.connection.prepare(`
      WITH RECURSIVE reachable(id) AS (
        VALUES (?)
        UNION
        SELECT edge.depends_on_goal_id
        FROM session_goal_dependencies edge
        JOIN reachable current ON current.id = edge.goal_id
        WHERE edge.parent_session_id = ?
      )
      SELECT 1 AS present FROM reachable WHERE id = ? LIMIT 1
    `).get(startGoalId, parentSessionId, targetGoalId));
  }

  private replaceDependencyRows(
    parentSessionId: string,
    goalId: string,
    dependencyGoalIds: readonly string[],
    now: string,
  ): void {
    this.database.connection.prepare(`
      DELETE FROM session_goal_dependencies WHERE parent_session_id = ? AND goal_id = ?
    `).run(parentSessionId, goalId);
    const insert = this.database.connection.prepare(`
      INSERT INTO session_goal_dependencies(
        parent_session_id, goal_id, depends_on_goal_id, created_at
      ) VALUES (?, ?, ?, ?)
    `);
    for (const dependencyId of dependencyGoalIds) {
      insert.run(parentSessionId, goalId, dependencyId, now);
    }
  }

  private appendTransition(input: Readonly<{
    goalId: string;
    parentSessionId: string;
    sequence: number;
    type: SessionGoalTransitionType;
    source: SessionGoalMutationSource;
    subjectType: "goal" | "todo" | "dependencies";
    subjectId: string;
    fromStatus?: SessionGoalStatus | SessionGoalTodoStatus;
    toStatus?: SessionGoalStatus | SessionGoalTodoStatus;
    payload: Readonly<Record<string, unknown>>;
    note?: string;
    now: string;
  }>): void {
    const payloadJson = JSON.stringify(input.payload);
    if ([...payloadJson].length > 65_536) {
      throw new SessionGoalValidationError("transition payload exceeds its durable bound");
    }
    this.database.connection.prepare(`
      INSERT INTO session_goal_transitions(
        id, goal_id, parent_session_id, sequence, transition_type, source,
        subject_type, subject_id, from_status, to_status, payload_json, note,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.idGenerator.next("session-goal-transition"),
      input.goalId,
      input.parentSessionId,
      input.sequence,
      input.type,
      input.source,
      input.subjectType,
      input.subjectId,
      input.fromStatus ?? null,
      input.toStatus ?? null,
      payloadJson,
      input.note ?? null,
      input.now,
    );
  }

  private now(): string {
    return this.clock.now().toISOString();
  }
}

function mapTodo(row: TodoRow): SessionGoalTodo {
  return Object.freeze({
    id: row.id,
    goalId: row.goal_id,
    position: Number(row.position),
    title: row.title,
    notes: row.notes,
    status: row.status as SessionGoalTodoStatus,
    revision: Number(row.revision),
    ...(row.result_note ? { resultNote: row.result_note } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
  });
}

function mapTransition(row: TransitionRow): SessionGoalTransition {
  return Object.freeze({
    id: row.id,
    sequence: Number(row.sequence),
    type: row.transition_type as SessionGoalTransitionType,
    source: row.source as SessionGoalMutationSource,
    subjectType: row.subject_type as "goal" | "todo" | "dependencies",
    subjectId: row.subject_id,
    ...(row.from_status
      ? { fromStatus: row.from_status as SessionGoalStatus | SessionGoalTodoStatus }
      : {}),
    ...(row.to_status
      ? { toStatus: row.to_status as SessionGoalStatus | SessionGoalTodoStatus }
      : {}),
    ...(row.note ? { note: row.note } : {}),
    createdAt: row.created_at,
  });
}

function validateScope(scope: SessionGoalScope): void {
  validateId(scope.parentSessionId, "parentSessionId");
  if (scope.mode !== "sms" && scope.mode !== "rp") {
    throw new SessionGoalValidationError("mode must be sms or rp");
  }
  if (scope.conversationSpace !== "normal" && scope.conversationSpace !== "secret") {
    throw new SessionGoalValidationError("conversationSpace must be normal or secret");
  }
  if (scope.conversationSpace === "secret" && scope.mode !== "sms") {
    throw new SessionGoalValidationError("secret goals are available only for SMS conversations");
  }
  if (
    (scope.conversationSpace === "normal" && scope.secretOwnerCharacterId !== undefined) ||
    (scope.conversationSpace === "secret" &&
      (!scope.characterId || scope.secretOwnerCharacterId !== scope.characterId))
  ) {
    throw new SessionGoalValidationError("secret goal scope must match its character owner");
  }
  if (scope.characterId !== undefined) validateId(scope.characterId, "characterId");
}

function validateId(value: string, field: string): void {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    [...value].length > 256
  ) {
    throw new SessionGoalValidationError(
      `${field} must contain between 1 and 256 trimmed characters`,
    );
  }
}

function validateRevision(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SessionGoalValidationError(`${field} must be a positive safe integer`);
  }
}

function validatePriority(priority: string): asserts priority is SessionGoalPriority {
  if (!["low", "normal", "high", "urgent"].includes(priority)) {
    throw new SessionGoalValidationError("priority must be low, normal, high, or urgent");
  }
}

function validateGoalStatus(status: string): asserts status is SessionGoalStatus {
  if (!["planned", "active", "blocked", "completed", "cancelled"].includes(status)) {
    throw new SessionGoalValidationError("goal status is invalid");
  }
}

function validateTodoStatus(status: string): asserts status is SessionGoalTodoStatus {
  if (!["pending", "in_progress", "completed", "cancelled"].includes(status)) {
    throw new SessionGoalValidationError("todo status is invalid");
  }
}

function validateSource(source: string): asserts source is SessionGoalMutationSource {
  if (!["agent", "http", "host"].includes(source)) {
    throw new SessionGoalValidationError("goal mutation source is invalid");
  }
}

function boundedText(value: string, field: string, maximum: number, required = false): string {
  if (typeof value !== "string") {
    throw new SessionGoalValidationError(`${field} must be a string`);
  }
  const normalized = value.trim();
  if ((required && !normalized) || [...normalized].length > maximum) {
    throw new SessionGoalValidationError(
      `${field} must contain ${required ? "between 1 and" : "at most"} ${maximum} characters`,
    );
  }
  return normalized;
}

function optionalBoundedText(
  value: string | undefined,
  field: string,
  maximum: number,
): string | undefined {
  if (value === undefined) return undefined;
  const normalized = boundedText(value, field, maximum);
  return normalized || undefined;
}

function normalizeIdList(
  values: readonly string[],
  field: string,
  maximum: number,
): string[] {
  if (!Array.isArray(values) || values.length > maximum) {
    throw new SessionGoalValidationError(`${field} may contain at most ${maximum} entries`);
  }
  const normalized = values.map((value) => {
    validateId(value, field);
    return value;
  }).sort();
  if (new Set(normalized).size !== normalized.length) {
    throw new SessionGoalValidationError(`${field} must not contain duplicates`);
  }
  return normalized;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
