import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { Run, RunFilter, RunStore, TestResult } from '@pomni/core';

/**
 * `node:sqlite` is newer than most bundlers' builtin lists — a static import gets rewritten
 * to a bare `sqlite` specifier and fails to resolve under Vite/Vitest. Loading it through
 * createRequire keeps the specifier opaque, and the surface we use is small enough to type
 * by hand.
 */
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
 * Run history in SQLite, via Node's built-in `node:sqlite` — no native module to compile,
 * which matters for a tool people install on Windows.
 *
 * WAL mode so the CLI can write while the server reads. Docs remain the source of truth for
 * intent; this is history, and it is safe to delete.
 */
export class SqliteRunStore implements RunStore {
  private readonly db: SqliteDatabase;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);

    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA foreign_keys = ON');
    migrate(this.db);
  }

  async insert(run: Run): Promise<void> {
    this.statement(
      `INSERT INTO runs (id, project_id, repo_id, item_id, capability, cmd, cwd, status,
                         exit_code, pid, started_at, ended_at, duration_ms, log_path, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      run.id,
      run.projectId,
      run.repoId,
      run.itemId,
      run.capability,
      run.cmd,
      run.cwd,
      run.status,
      run.exitCode,
      run.pid,
      run.startedAt,
      run.endedAt,
      run.durationMs,
      run.logPath,
      run.summary,
    );
  }

  async update(id: string, patch: Partial<Run>): Promise<void> {
    const columns: Record<keyof Run & string, string> = {
      id: 'id',
      projectId: 'project_id',
      repoId: 'repo_id',
      itemId: 'item_id',
      capability: 'capability',
      cmd: 'cmd',
      cwd: 'cwd',
      status: 'status',
      exitCode: 'exit_code',
      pid: 'pid',
      startedAt: 'started_at',
      endedAt: 'ended_at',
      durationMs: 'duration_ms',
      logPath: 'log_path',
      summary: 'summary',
    };

    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [key, value] of Object.entries(patch)) {
      const column = columns[key as keyof Run];
      if (!column || column === 'id') continue;
      sets.push(`${column} = ?`);
      values.push(value as string | number | null);
    }
    if (sets.length === 0) return;

    values.push(id);
    this.statement(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  async get(id: string): Promise<Run | null> {
    const row = this.statement('SELECT * FROM runs WHERE id = ?').get(id) as unknown as
      | RunRow
      | undefined;
    return row ? toRun(row) : null;
  }

  async list(filter: RunFilter): Promise<Run[]> {
    const where: string[] = [];
    const values: Array<string | number> = [];

    if (filter.projectId) {
      where.push('project_id = ?');
      values.push(filter.projectId);
    }
    if (filter.repoId) {
      where.push('repo_id = ?');
      values.push(filter.repoId);
    }
    if (filter.itemId) {
      where.push('item_id = ?');
      values.push(filter.itemId);
    }
    if (filter.capability) {
      where.push('capability = ?');
      values.push(filter.capability);
    }
    if (filter.status) {
      where.push('status = ?');
      values.push(filter.status);
    }
    if (filter.failedOnly) {
      where.push("status NOT IN ('passed', 'running', 'queued')");
    }
    if (filter.before) {
      where.push('id < ?');
      values.push(filter.before);
    }

    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    values.push(Math.min(filter.limit ?? 50, 500));

    const rows = this.statement(
      `SELECT * FROM runs ${clause} ORDER BY id DESC LIMIT ?`,
    ).all(...values) as unknown as RunRow[];
    return rows.map(toRun);
  }

  /** Most recent run per (repo, capability) — the rows a gate reads. */
  async latest(projectId: string, capability: string): Promise<Run[]> {
    const rows = this.statement(
      `SELECT r.* FROM runs r
       JOIN (SELECT repo_id, MAX(id) AS id FROM runs
             WHERE project_id = ? AND capability = ? GROUP BY repo_id) latest
         ON r.id = latest.id
       ORDER BY r.repo_id`,
    ).all(projectId, capability) as unknown as RunRow[];
    return rows.map(toRun);
  }

  async putTestResults(runId: string, results: TestResult[]): Promise<void> {
    const statement = this.statement(
      `INSERT INTO test_results (run_id, suite, name, status, duration_ms, message)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec('BEGIN');
    try {
      for (const result of results) {
        statement.run(runId, result.suite, result.name, result.status, result.durationMs, result.message);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async testResults(runId: string): Promise<TestResult[]> {
    const rows = this.statement(
      'SELECT suite, name, status, duration_ms, message FROM test_results WHERE run_id = ? ORDER BY rowid',
    ).all(runId) as unknown as Array<{
      suite: string;
      name: string;
      status: string;
      duration_ms: number | null;
      message: string | null;
    }>;

    return rows.map((row) => ({
      suite: row.suite,
      name: row.name,
      status: row.status as TestResult['status'],
      durationMs: row.duration_ms,
      message: row.message,
    }));
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Already closed.
    }
  }

  private readonly cache = new Map<string, SqliteStatement>();

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
  repo_id: string;
  item_id: string | null;
  capability: string;
  cmd: string;
  cwd: string;
  status: string;
  exit_code: number | null;
  pid: number | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  log_path: string;
  summary: string | null;
}

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    projectId: row.project_id,
    repoId: row.repo_id,
    itemId: row.item_id,
    capability: row.capability,
    cmd: row.cmd,
    cwd: row.cwd,
    status: row.status as Run['status'],
    exitCode: row.exit_code,
    pid: row.pid,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    logPath: row.log_path,
    summary: row.summary,
  };
}

/**
 * Migrations are numbered and applied in order; `user_version` records the last applied.
 * Append new statements, never edit an existing one.
 */
const MIGRATIONS: string[] = [
  `CREATE TABLE runs (
     id          TEXT PRIMARY KEY,
     project_id  TEXT NOT NULL,
     repo_id     TEXT NOT NULL,
     item_id     TEXT,
     capability  TEXT NOT NULL,
     cmd         TEXT NOT NULL,
     cwd         TEXT NOT NULL,
     status      TEXT NOT NULL,
     exit_code   INTEGER,
     pid         INTEGER,
     started_at  TEXT NOT NULL,
     ended_at    TEXT,
     duration_ms INTEGER,
     log_path    TEXT NOT NULL,
     summary     TEXT
   );
   CREATE INDEX idx_runs_project ON runs(project_id, id DESC);
   CREATE INDEX idx_runs_repo    ON runs(repo_id, id DESC);
   CREATE INDEX idx_runs_item    ON runs(item_id);

   CREATE TABLE test_results (
     run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
     suite       TEXT NOT NULL,
     name        TEXT NOT NULL,
     status      TEXT NOT NULL,
     duration_ms INTEGER,
     message     TEXT
   );
   CREATE INDEX idx_test_results_run ON test_results(run_id);`,
];

function migrate(db: SqliteDatabase): void {
  const row = db.prepare('PRAGMA user_version').get() as unknown as
    | { user_version: number }
    | undefined;
  const current = row?.user_version ?? 0;

  for (let version = current; version < MIGRATIONS.length; version += 1) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version] as string);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
