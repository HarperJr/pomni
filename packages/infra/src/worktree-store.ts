import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { WorktreeSchema, type Worktree, type WorktreeFilter, type WorktreeStore } from '@pomni/core';
import { applyPragmas } from './sqlite.js';

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
 * Per-run worktrees.
 *
 * Shares the database with pipeline runs and capability runs but keeps its own table and its
 * own migration counter, so the three can evolve without one's schema change forcing another's.
 *
 * Deliberately no foreign key to `pipeline_runs` and no `ON DELETE CASCADE`: cascading would
 * delete the row for a directory that is still on disk, turning a visible orphan into an
 * invisible one. `path` is UNIQUE — the database refuses to record two runs in one directory.
 */
export class SqliteWorktreeStore implements WorktreeStore {
  private readonly db: SqliteDatabase;
  private readonly cache = new Map<string, SqliteStatement>();

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    applyPragmas(this.db);
    migrate(this.db);
  }

  async insert(worktree: Worktree): Promise<void> {
    this.statement(
      `INSERT INTO worktrees (id, project_id, repo_id, run_id, path, branch, base_branch,
                              base_commit, owner_pid, status, kept_reason, created_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      worktree.id,
      worktree.projectId,
      worktree.repoId,
      worktree.runId,
      worktree.path,
      worktree.branch,
      worktree.baseBranch,
      worktree.baseCommit,
      worktree.ownerPid,
      worktree.status,
      worktree.keptReason,
      worktree.createdAt,
      worktree.endedAt,
    );
  }

  async update(id: string, worktree: Worktree): Promise<void> {
    this.statement(
      `UPDATE worktrees
         SET project_id = ?, repo_id = ?, run_id = ?, path = ?, branch = ?, base_branch = ?,
             base_commit = ?, owner_pid = ?, status = ?, kept_reason = ?, created_at = ?,
             ended_at = ?
       WHERE id = ?`,
    ).run(
      worktree.projectId,
      worktree.repoId,
      worktree.runId,
      worktree.path,
      worktree.branch,
      worktree.baseBranch,
      worktree.baseCommit,
      worktree.ownerPid,
      worktree.status,
      worktree.keptReason,
      worktree.createdAt,
      worktree.endedAt,
      id,
    );
  }

  async get(id: string): Promise<Worktree | null> {
    const row = this.statement('SELECT * FROM worktrees WHERE id = ?').get(id) as unknown as
      | WorktreeRow
      | undefined;
    return row ? toWorktree(row) : null;
  }

  async forRun(runId: string, repoId: string): Promise<Worktree | null> {
    const row = this.statement('SELECT * FROM worktrees WHERE run_id = ? AND repo_id = ?').get(
      runId,
      repoId,
    ) as unknown as WorktreeRow | undefined;
    return row ? toWorktree(row) : null;
  }

  async list(filter: WorktreeFilter): Promise<Worktree[]> {
    const where: string[] = [];
    const values: SqlValue[] = [];

    if (filter.projectId) {
      where.push('project_id = ?');
      values.push(filter.projectId);
    }
    if (filter.repoId) {
      where.push('repo_id = ?');
      values.push(filter.repoId);
    }
    if (filter.runId) {
      where.push('run_id = ?');
      values.push(filter.runId);
    }
    if (filter.status) {
      where.push('status = ?');
      values.push(filter.status);
    }

    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.statement(
      `SELECT * FROM worktrees ${clause} ORDER BY created_at`,
    ).all(...values) as unknown as WorktreeRow[];
    return rows.map(toWorktree);
  }

  async delete(id: string): Promise<void> {
    this.statement('DELETE FROM worktrees WHERE id = ?').run(id);
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

interface WorktreeRow {
  id: string;
  project_id: string;
  repo_id: string;
  run_id: string;
  path: string;
  branch: string;
  base_branch: string | null;
  base_commit: string | null;
  owner_pid: number | null;
  status: string;
  kept_reason: string | null;
  created_at: string;
  ended_at: string | null;
}

function toWorktree(row: WorktreeRow): Worktree {
  return WorktreeSchema.parse({
    id: row.id,
    projectId: row.project_id,
    repoId: row.repo_id,
    runId: row.run_id,
    path: row.path,
    branch: row.branch,
    baseBranch: row.base_branch,
    baseCommit: row.base_commit,
    ownerPid: row.owner_pid,
    status: row.status,
    keptReason: row.kept_reason,
    createdAt: row.created_at,
    endedAt: row.ended_at,
  });
}

/** Own counter, separate from the other stores sharing this file. */
const MIGRATIONS: string[] = [
  `CREATE TABLE worktrees (
     id          TEXT PRIMARY KEY,
     project_id  TEXT NOT NULL,
     repo_id     TEXT NOT NULL,
     run_id      TEXT NOT NULL,
     path        TEXT NOT NULL UNIQUE,
     branch      TEXT NOT NULL,
     base_branch TEXT,
     base_commit TEXT,
     owner_pid   INTEGER,
     status      TEXT NOT NULL,
     kept_reason TEXT,
     created_at  TEXT NOT NULL,
     ended_at    TEXT
   );
   CREATE UNIQUE INDEX idx_worktrees_run_repo ON worktrees(run_id, repo_id);
   CREATE INDEX        idx_worktrees_repo     ON worktrees(project_id, repo_id);
   CREATE INDEX        idx_worktrees_status   ON worktrees(status);`,
];

function migrate(db: SqliteDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS worktree_schema (version INTEGER NOT NULL)`);

  const row = db.prepare('SELECT version FROM worktree_schema LIMIT 1').get() as unknown as
    | { version: number }
    | undefined;
  const current = row?.version ?? 0;

  for (let version = current; version < MIGRATIONS.length; version += 1) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version] as string);
      db.exec('DELETE FROM worktree_schema');
      db.exec(`INSERT INTO worktree_schema (version) VALUES (${version + 1})`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
