import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Artifact,
  PipelineFilter,
  PipelineRun,
  PipelineStep,
  PipelineStore,
  Question,
} from '@pomni/core';

type SqlValue = string | number | null;

interface SqliteStatement {
  run(...params: SqlValue[]): unknown;
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDatabase;
};

/**
 * Pipeline history.
 *
 * Shares the database with capability runs but keeps its own tables and its own migration
 * counter, so the two can evolve without one's schema change forcing the other's.
 */
export class SqlitePipelineStore implements PipelineStore {
  private readonly db: SqliteDatabase;
  private readonly cache = new Map<string, SqliteStatement>();

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    migrate(this.db);
  }

  async insertRun(run: PipelineRun): Promise<void> {
    this.statement(
      `INSERT INTO pipeline_runs (id, project_id, workflow_id, workflow_name, provider_id,
                                  item_id, rerun_of, task, context, status, pid, result, error,
                                  gate_status, gate_summary, item_status, outcome, unmet,
                                  started_at, ended_at, duration_ms, cost_usd, branch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      run.id,
      run.projectId,
      run.workflowId,
      run.workflowName,
      run.providerId,
      run.itemId,
      run.rerunOf,
      run.task,
      JSON.stringify(run.context),
      run.status,
      run.pid,
      run.result,
      run.error,
      run.gateStatus,
      run.gateSummary,
      run.itemStatus,
      run.outcome,
      JSON.stringify(run.unmet),
      run.startedAt,
      run.endedAt,
      run.durationMs,
      run.costUsd,
      // Bound defensively. This method takes a record from outside, and `undefined` is not a
      // value SQLite can bind — it fails with a parameter number and no clue which field.
      run.branch ?? null,
    );
  }

  async updateRun(id: string, run: PipelineRun): Promise<void> {
    this.statement(
      // `context` is here because a resume adds a file to it — the note saying what changed
      // and what is already done. Left out, that file reached the agents in memory and was
      // gone from the row, so a person reloading the page saw a run with no explanation.
      `UPDATE pipeline_runs
         SET status = ?, pid = ?, result = ?, error = ?, gate_status = ?, gate_summary = ?,
             item_status = ?, outcome = ?, unmet = ?, ended_at = ?, duration_ms = ?,
             input_tokens = ?, output_tokens = ?, cost_usd = ?, context = ?, branch = ?
       WHERE id = ?`,
    ).run(
      run.status,
      run.pid,
      run.result,
      run.error,
      run.gateStatus,
      run.gateSummary,
      run.itemStatus,
      run.outcome,
      JSON.stringify(run.unmet),
      run.endedAt,
      run.durationMs,
      run.inputTokens,
      run.outputTokens,
      run.costUsd,
      JSON.stringify(run.context),
      run.branch ?? null,
      id,
    );
  }

  async getRun(id: string): Promise<PipelineRun | null> {
    const row = this.statement('SELECT * FROM pipeline_runs WHERE id = ?').get(id) as unknown as
      | RunRow
      | undefined;
    return row ? toRun(row) : null;
  }

  async listRuns(filter: PipelineFilter): Promise<PipelineRun[]> {
    const where: string[] = [];
    const values: SqlValue[] = [];

    if (filter.projectId) {
      where.push('project_id = ?');
      values.push(filter.projectId);
    }
    if (filter.workflowId) {
      where.push('workflow_id = ?');
      values.push(filter.workflowId);
    }
    if (filter.itemId) {
      where.push('item_id = ?');
      values.push(filter.itemId);
    }
    if (filter.status) {
      where.push('status = ?');
      values.push(filter.status);
    }

    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    values.push(Math.min(filter.limit ?? 30, 200));

    const rows = this.statement(
      `SELECT * FROM pipeline_runs ${clause} ORDER BY id DESC LIMIT ?`,
    ).all(...values) as unknown as RunRow[];
    return rows.map(toRun);
  }

  async insertStep(step: PipelineStep): Promise<void> {
    this.statement(
      `INSERT INTO pipeline_steps (id, run_id, parent_step_id, agent_id, agent_name, role,
                                   model, provider_id, task, status, output, error, outcome, unmet,
                                   actions, depth, started_at, ended_at, duration_ms,
                                   turns, cache_read_tokens, fresh_input_tokens,
                                   prompt_bytes, prompt_parts,
                                   input_tokens, output_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      step.id,
      step.runId,
      step.parentStepId,
      step.agentId,
      step.agentName,
      step.role,
      step.model,
      step.providerId,
      step.task,
      step.status,
      step.output,
      step.error,
      step.outcome,
      JSON.stringify(step.unmet),
      JSON.stringify(step.actions),
      step.depth,
      step.startedAt,
      step.endedAt,
      step.durationMs,
      step.turns,
      step.cacheReadTokens,
      step.freshInputTokens,
      step.promptBytes,
      JSON.stringify(step.promptParts),
      step.inputTokens,
      step.outputTokens,
      step.costUsd,
    );
  }

  async updateStep(id: string, step: PipelineStep): Promise<void> {
    this.statement(
      `UPDATE pipeline_steps
         SET status = ?, output = ?, error = ?, outcome = ?, unmet = ?, actions = ?,
             provider_id = ?, ended_at = ?, duration_ms = ?,
             turns = ?, cache_read_tokens = ?, fresh_input_tokens = ?,
             prompt_bytes = ?, prompt_parts = ?,
             input_tokens = ?, output_tokens = ?, cost_usd = ?
       WHERE id = ?`,
    ).run(
      step.status,
      step.output,
      step.error,
      step.outcome,
      JSON.stringify(step.unmet),
      JSON.stringify(step.actions),
      step.providerId,
      step.endedAt,
      step.durationMs,
      step.turns,
      step.cacheReadTokens,
      step.freshInputTokens,
      step.promptBytes,
      JSON.stringify(step.promptParts),
      step.inputTokens,
      step.outputTokens,
      step.costUsd,
      id,
    );
  }

  async steps(runId: string): Promise<PipelineStep[]> {
    const rows = this.statement(
      'SELECT * FROM pipeline_steps WHERE run_id = ? ORDER BY id',
    ).all(runId) as unknown as StepRow[];
    return rows.map(toStep);
  }

  async putArtifacts(artifacts: Artifact[]): Promise<void> {
    const statement = this.statement(
      `INSERT INTO pipeline_artifacts (id, run_id, step_id, name, kind, path, change, bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.db.exec('BEGIN');
    try {
      for (const artifact of artifacts) {
        statement.run(
          artifact.id,
          artifact.runId,
          artifact.stepId,
          artifact.name,
          artifact.kind,
          artifact.path,
          artifact.change,
          artifact.bytes,
          artifact.createdAt,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async artifacts(runId: string): Promise<Artifact[]> {
    const rows = this.statement(
      'SELECT * FROM pipeline_artifacts WHERE run_id = ? ORDER BY id',
    ).all(runId) as unknown as Array<{
      id: string; run_id: string; step_id: string | null; name: string; kind: string;
      path: string | null; change: string | null; bytes: number; created_at: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      stepId: row.step_id,
      name: row.name,
      kind: row.kind as Artifact['kind'],
      path: row.path,
      change: row.change,
      bytes: row.bytes,
      createdAt: row.created_at,
    }));
  }

  async insertQuestion(question: Question): Promise<void> {
    this.statement(
      `INSERT INTO pipeline_questions (id, run_id, step_id, agent_id, agent_name, question,
                                       answer, attachments, status, asked_at, answered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      question.id,
      question.runId,
      question.stepId,
      question.agentId,
      question.agentName,
      question.question,
      question.answer,
      JSON.stringify(question.attachments),
      question.status,
      question.askedAt,
      question.answeredAt,
    );
  }

  async updateQuestion(id: string, question: Question): Promise<void> {
    this.statement(
      `UPDATE pipeline_questions
         SET answer = ?, attachments = ?, status = ?, answered_at = ?
       WHERE id = ?`,
    ).run(
      question.answer,
      JSON.stringify(question.attachments),
      question.status,
      question.answeredAt,
      id,
    );
  }

  async getQuestion(id: string): Promise<Question | null> {
    const row = this.statement('SELECT * FROM pipeline_questions WHERE id = ?').get(
      id,
    ) as unknown as QuestionRow | undefined;
    return row ? toQuestion(row) : null;
  }

  async questions(runId: string): Promise<Question[]> {
    const rows = this.statement(
      'SELECT * FROM pipeline_questions WHERE run_id = ? ORDER BY id',
    ).all(runId) as unknown as QuestionRow[];
    return rows.map(toQuestion);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Already closed.
    }
  }

  private statement(sql: string): SqliteStatement {
    let statement = this.cache.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.cache.set(sql, statement);
    }
    return statement;
  }
}

interface RunRow {
  id: string;
  project_id: string;
  workflow_id: string;
  workflow_name: string;
  provider_id: string;
  item_id: string | null;
  rerun_of: string | null;
  branch: string | null;
  task: string;
  context: string | null;
  status: string;
  pid: number | null;
  result: string | null;
  error: string | null;
  gate_status: string;
  gate_summary: string | null;
  item_status: string | null;
  outcome: string | null;
  unmet: string | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
}

interface StepRow {
  id: string;
  run_id: string;
  parent_step_id: string | null;
  agent_id: string;
  agent_name: string;
  role: string;
  model: string;
  provider_id: string | null;
  task: string;
  status: string;
  output: string | null;
  outcome: string | null;
  unmet: string | null;
  actions: string | null;
  error: string | null;
  depth: number;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  turns: number;
  cache_read_tokens: number;
  fresh_input_tokens: number;
  prompt_bytes: number;
  prompt_parts: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
}

function toRun(row: RunRow): PipelineRun {
  return {
    id: row.id,
    projectId: row.project_id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    providerId: row.provider_id,
    itemId: row.item_id,
    rerunOf: row.rerun_of ?? null,
    branch: row.branch ?? null,
    task: row.task,
    context: toContext(row.context),
    status: row.status as PipelineRun['status'],
    pid: row.pid,
    result: row.result,
    error: row.error,
    gateStatus: (row.gate_status ?? 'skipped') as PipelineRun['gateStatus'],
    gateSummary: row.gate_summary,
    itemStatus: row.item_status,
    outcome: (row.outcome ?? 'unknown') as PipelineRun['outcome'],
    unmet: toList(row.unmet),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    inputTokens: row.input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    costUsd: row.cost_usd,
  };
}

/** Steps written before the column existed have no record of what they did. */
function toActions(raw: string | null): PipelineStep['actions'] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as PipelineStep['actions']) : [];
  } catch {
    return [];
  }
}

/** A JSON list column, tolerant of rows written before the column existed. */
function toList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/** Runs written before context files existed have no column value, and no context. */
function toContext(raw: string | null): PipelineRun['context'] {
  if (!raw) return [];
  try {
    return JSON.parse(raw) as PipelineRun['context'];
  } catch {
    return [];
  }
}

interface QuestionRow {
  id: string;
  run_id: string;
  step_id: string;
  agent_id: string;
  agent_name: string;
  question: string;
  answer: string | null;
  attachments: string | null;
  status: string;
  asked_at: string;
  answered_at: string | null;
}

function toQuestion(row: QuestionRow): Question {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    question: row.question,
    answer: row.answer,
    attachments: toContext(row.attachments),
    status: row.status as Question['status'],
    askedAt: row.asked_at,
    answeredAt: row.answered_at,
  };
}

function toStep(row: StepRow): PipelineStep {
  return {
    id: row.id,
    runId: row.run_id,
    parentStepId: row.parent_step_id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    role: row.role,
    model: row.model,
    task: row.task,
    status: row.status as PipelineStep['status'],
    output: row.output,
    error: row.error,
    outcome: (row.outcome ?? 'unknown') as PipelineStep['outcome'],
    unmet: toList(row.unmet),
    actions: toActions(row.actions),
    providerId: row.provider_id ?? null,
    depth: row.depth,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    turns: row.turns ?? 0,
    cacheReadTokens: row.cache_read_tokens ?? 0,
    freshInputTokens: row.fresh_input_tokens ?? 0,
    promptBytes: row.prompt_bytes ?? 0,
    promptParts: parseParts(row.prompt_parts),
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
  };
}

/** Own counter, separate from the capability-run store sharing this file. */
const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS pipeline_runs (
     id            TEXT PRIMARY KEY,
     project_id    TEXT NOT NULL,
     workflow_id   TEXT NOT NULL,
     workflow_name TEXT NOT NULL,
     provider_id   TEXT NOT NULL,
     item_id       TEXT,
     task          TEXT NOT NULL,
     status        TEXT NOT NULL,
     result        TEXT,
     error         TEXT,
     started_at    TEXT NOT NULL,
     ended_at      TEXT,
     duration_ms   INTEGER,
     cost_usd      REAL
   );
   CREATE INDEX IF NOT EXISTS idx_pipeline_project ON pipeline_runs(project_id, id DESC);

   CREATE TABLE IF NOT EXISTS pipeline_steps (
     id             TEXT PRIMARY KEY,
     run_id         TEXT NOT NULL,
     parent_step_id TEXT,
     agent_id       TEXT NOT NULL,
     agent_name     TEXT NOT NULL,
     role           TEXT NOT NULL,
     model          TEXT NOT NULL,
     task           TEXT NOT NULL,
     status         TEXT NOT NULL,
     output         TEXT,
     error          TEXT,
     depth          INTEGER NOT NULL,
     started_at     TEXT NOT NULL,
     ended_at       TEXT,
     duration_ms    INTEGER,
     input_tokens   INTEGER NOT NULL DEFAULT 0,
     output_tokens  INTEGER NOT NULL DEFAULT 0,
     cost_usd       REAL
   );
   CREATE INDEX IF NOT EXISTS idx_pipeline_steps_run ON pipeline_steps(run_id, id);`,

  `ALTER TABLE pipeline_runs ADD COLUMN gate_status TEXT NOT NULL DEFAULT 'skipped';
   ALTER TABLE pipeline_runs ADD COLUMN gate_summary TEXT;
   ALTER TABLE pipeline_runs ADD COLUMN item_status TEXT;

   CREATE TABLE IF NOT EXISTS pipeline_artifacts (
     id         TEXT PRIMARY KEY,
     run_id     TEXT NOT NULL,
     step_id    TEXT,
     name       TEXT NOT NULL,
     kind       TEXT NOT NULL,
     path       TEXT,
     change     TEXT,
     bytes      INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_pipeline_artifacts_run ON pipeline_artifacts(run_id, id);`,

  `ALTER TABLE pipeline_runs ADD COLUMN context TEXT NOT NULL DEFAULT '[]';`,

  `CREATE TABLE IF NOT EXISTS pipeline_questions (
     id          TEXT PRIMARY KEY,
     run_id      TEXT NOT NULL,
     step_id     TEXT NOT NULL,
     agent_id    TEXT NOT NULL,
     agent_name  TEXT NOT NULL,
     question    TEXT NOT NULL,
     answer      TEXT,
     status      TEXT NOT NULL,
     asked_at    TEXT NOT NULL,
     answered_at TEXT
   );
   CREATE INDEX IF NOT EXISTS idx_pipeline_questions_run ON pipeline_questions(run_id, id);`,

  `ALTER TABLE pipeline_runs ADD COLUMN outcome TEXT NOT NULL DEFAULT 'unknown';
   ALTER TABLE pipeline_runs ADD COLUMN unmet TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE pipeline_steps ADD COLUMN outcome TEXT NOT NULL DEFAULT 'unknown';
   ALTER TABLE pipeline_steps ADD COLUMN unmet TEXT NOT NULL DEFAULT '[]';`,

  `ALTER TABLE pipeline_runs ADD COLUMN rerun_of TEXT;`,

  `ALTER TABLE pipeline_questions ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';`,

  `ALTER TABLE pipeline_steps ADD COLUMN actions TEXT NOT NULL DEFAULT '[]';`,

  `ALTER TABLE pipeline_runs ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE pipeline_runs ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;`,

  `ALTER TABLE pipeline_runs ADD COLUMN pid INTEGER;`,

  `ALTER TABLE pipeline_steps ADD COLUMN provider_id TEXT;`,

  `ALTER TABLE pipeline_runs ADD COLUMN branch TEXT;`,

  // Appended, never inserted. This migration once lived in the middle of this list on an
  // unmerged branch, ran against the real database, and left it at the same version number as
  // a database built from this file with different columns in it — which is precisely the
  // divergence a counter cannot describe. Whatever comes next goes on the end too.
  `ALTER TABLE pipeline_steps ADD COLUMN turns INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE pipeline_steps ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE pipeline_steps ADD COLUMN fresh_input_tokens INTEGER NOT NULL DEFAULT 0;`,

  `ALTER TABLE pipeline_steps ADD COLUMN prompt_bytes INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE pipeline_steps ADD COLUMN prompt_parts TEXT NOT NULL DEFAULT '{}';`,
];

function migrate(db: SqliteDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS pipeline_schema (version INTEGER NOT NULL)`);

  // Every step, every time — which is what this comment always said and what the loop below
  // did not do. Starting from the recorded version trusts a counter to describe a schema, and
  // a counter can only ever describe *depth*. It cannot describe divergence.
  //
  // Two lists of the same length are indistinguishable by it. That is not hypothetical: this
  // database sat at version 12, and so did a database built from this file, and they had
  // different columns — one carried `turns`/`cache_read_tokens`/`fresh_input_tokens` from a
  // branch that was never merged, the other carried `branch`. Both were "fully migrated" and
  // neither would ever run another step, so the missing column would have stayed missing until
  // the next run failed on an INSERT naming it.
  //
  // The statements are individually safe to re-attempt — a column that is already there is
  // caught below — so the truth is the schema itself rather than a number we wrote down.
  for (let version = 0; version < MIGRATIONS.length; version += 1) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version] as string);
      db.exec('DELETE FROM pipeline_schema');
      db.exec(`INSERT INTO pipeline_schema (version) VALUES (${version + 1})`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');

      // A column that is already there is not a failure. SQLite has no
      // `ADD COLUMN IF NOT EXISTS`, and a migration inserted into the middle of this list
      // rather than appended to it leaves an existing database one step out of step — which
      // has happened, and cost a server that would not start. Record the step and carry on;
      // anything else is a real failure and still stops us.
      const message = error instanceof Error ? error.message : String(error);
      if (!/duplicate column name|already exists/i.test(message)) throw error;

      // Applied already, possibly by a different step of a reordered list. Re-run the
      // statements one at a time so the ones that have *not* been applied still land.
      for (const statement of (MIGRATIONS[version] as string).split(';')) {
        if (!statement.trim()) continue;
        try {
          db.exec(statement);
        } catch (retry) {
          const said = retry instanceof Error ? retry.message : String(retry);
          if (!/duplicate column name|already exists/i.test(said)) throw retry;
        }
      }

      db.exec('BEGIN');
      db.exec('DELETE FROM pipeline_schema');
      db.exec(`INSERT INTO pipeline_schema (version) VALUES (${version + 1})`);
      db.exec('COMMIT');
    }
  }
}

/**
 * The prompt breakdown as it comes back out of the row.
 *
 * A step recorded before the column existed reads `{}`, and every part defaults to zero —
 * which is "not measured", the same thing `promptBytes: 0` says beside it. Anything that
 * cannot be parsed is treated the same way rather than throwing: a listing should not fail
 * because one old row has something odd in a column nobody had written to yet.
 */
function parseParts(raw: string | null): {
  agent: number;
  protocol: number;
  roster: number;
  tools: number;
  repos: number;
  context: number;
} {
  const empty = { agent: 0, protocol: 0, roster: 0, tools: 0, repos: 0, context: 0 };
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const read = (key: keyof typeof empty): number =>
      typeof parsed[key] === 'number' ? (parsed[key] as number) : 0;
    return {
      agent: read('agent'),
      protocol: read('protocol'),
      roster: read('roster'),
      tools: read('tools'),
      repos: read('repos'),
      context: read('context'),
    };
  } catch {
    return empty;
  }
}
