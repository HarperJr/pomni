import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ValidationError, type Comment, type CommentAuthor, type CommentFilter, type CommentStore } from '@pomni/core';
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
 * Comments on a backlog item or a run.
 *
 * Shares the database with the pipeline store but keeps its own table and its own migration
 * counter, so the two can evolve independently.
 */
export class SqliteCommentStore implements CommentStore {
  private readonly db: SqliteDatabase;
  private readonly cache = new Map<string, SqliteStatement>();

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    applyPragmas(this.db);
    migrate(this.db);
  }

  async insert(comment: Comment): Promise<void> {
    this.statement(
      `INSERT INTO comments (id, subject, subject_id, project_id, author, author_kind,
                             author_run_id, text, attachments, addressed_to, resolves_comment_id,
                             resolved_at, resolved_by, resolved_by_comment_id, deleted_at,
                             deleted_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      comment.id,
      comment.subject,
      comment.subjectId,
      comment.projectId,
      JSON.stringify(comment.author),
      comment.author.kind,
      comment.author.kind === 'agent' ? comment.author.runId : null,
      comment.text,
      JSON.stringify(comment.attachments),
      comment.addressedTo,
      comment.resolvesCommentId,
      comment.resolvedAt,
      comment.resolvedBy ? JSON.stringify(comment.resolvedBy) : null,
      comment.resolvedByCommentId,
      comment.deletedAt,
      comment.deletedBy ? JSON.stringify(comment.deletedBy) : null,
      comment.createdAt,
    );
  }

  async get(id: string): Promise<Comment | null> {
    const row = this.statement('SELECT * FROM comments WHERE id = ?').get(id) as unknown as
      | CommentRow
      | undefined;
    return row ? toComment(row) : null;
  }

  async list(filter: CommentFilter): Promise<Comment[]> {
    const where: string[] = ['subject = ?', 'subject_id = ?'];
    const values: SqlValue[] = [filter.subject, filter.subjectId];

    if (!filter.includeDeleted) where.push('deleted_at IS NULL');

    const rows = this.statement(
      `SELECT * FROM comments WHERE ${where.join(' AND ')} ORDER BY id`,
    ).all(...values) as unknown as CommentRow[];
    return rows.map(toComment);
  }

  async forRunContext(itemId: string): Promise<Comment[]> {
    const rows = this.statement(
      `SELECT * FROM comments WHERE subject = 'item' AND subject_id = ? AND deleted_at IS NULL
       ORDER BY id`,
    ).all(itemId) as unknown as CommentRow[];
    return rows.map(toComment);
  }

  async outstanding(itemId: string): Promise<Comment[]> {
    const rows = this.statement(
      `SELECT * FROM comments
       WHERE subject = 'item' AND subject_id = ? AND addressed_to IS NOT NULL
             AND resolved_at IS NULL AND deleted_at IS NULL
       ORDER BY id`,
    ).all(itemId) as unknown as CommentRow[];
    return rows.map(toComment);
  }

  async byAuthorRun(runId: string): Promise<Comment[]> {
    const rows = this.statement(
      'SELECT * FROM comments WHERE author_run_id = ? ORDER BY id',
    ).all(runId) as unknown as CommentRow[];
    return rows.map(toComment);
  }

  async markResolved(
    id: string,
    resolution: { at: string; by: CommentAuthor; byCommentId: string | null },
  ): Promise<void> {
    const existing = await this.get(id);
    if (!existing) throw new ValidationError(`comment '${id}' not found`);
    if (!existing.addressedTo) {
      throw new ValidationError(`comment '${id}' was never addressed to anyone`);
    }
    if (existing.resolvedAt) return;

    this.statement(
      `UPDATE comments SET resolved_at = ?, resolved_by = ?, resolved_by_comment_id = ? WHERE id = ?`,
    ).run(
      resolution.at,
      JSON.stringify(resolution.by),
      resolution.byCommentId,
      id,
    );
  }

  async markDeleted(id: string, deletion: { at: string; by: CommentAuthor }): Promise<void> {
    this.statement('UPDATE comments SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(
      deletion.at,
      JSON.stringify(deletion.by),
      id,
    );
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

interface CommentRow {
  id: string;
  subject: string;
  subject_id: string;
  project_id: string;
  author: string;
  author_kind: string;
  author_run_id: string | null;
  text: string;
  attachments: string | null;
  addressed_to: string | null;
  resolves_comment_id: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolved_by_comment_id: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  created_at: string;
}

/** A JSON object column, tolerant of a row whose value cannot parse. */
function toAuthor(raw: string | null): CommentAuthor | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CommentAuthor;
  } catch {
    return null;
  }
}

/** A JSON list column, tolerant of rows written before the column existed. */
function toList(raw: string | null): Comment['attachments'] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as Comment['attachments']) : [];
  } catch {
    return [];
  }
}

function toComment(row: CommentRow): Comment {
  return {
    id: row.id,
    subject: row.subject as Comment['subject'],
    subjectId: row.subject_id,
    projectId: row.project_id,
    author: toAuthor(row.author) as CommentAuthor,
    text: row.text,
    attachments: toList(row.attachments),
    addressedTo: row.addressed_to,
    resolvesCommentId: row.resolves_comment_id,
    resolvedAt: row.resolved_at,
    resolvedBy: toAuthor(row.resolved_by),
    resolvedByCommentId: row.resolved_by_comment_id,
    deletedAt: row.deleted_at,
    deletedBy: toAuthor(row.deleted_by),
    createdAt: row.created_at,
  };
}

/** Own counter, separate from the other tables sharing this file. */
const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS comments (
     id                      TEXT PRIMARY KEY,
     subject                 TEXT NOT NULL,
     subject_id              TEXT NOT NULL,
     project_id              TEXT NOT NULL,
     author                  TEXT NOT NULL,
     author_kind             TEXT NOT NULL,
     author_run_id           TEXT,
     text                    TEXT NOT NULL,
     attachments             TEXT NOT NULL DEFAULT '[]',
     addressed_to            TEXT,
     resolves_comment_id     TEXT,
     resolved_at             TEXT,
     resolved_by             TEXT,
     resolved_by_comment_id  TEXT,
     deleted_at              TEXT,
     deleted_by              TEXT,
     created_at              TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_comments_subject ON comments(subject, subject_id, id);
   CREATE INDEX IF NOT EXISTS idx_comments_outstanding ON comments(subject, subject_id, id)
     WHERE addressed_to IS NOT NULL AND resolved_at IS NULL AND deleted_at IS NULL;
   CREATE INDEX IF NOT EXISTS idx_comments_author_run ON comments(author_run_id, id);`,
];

function migrate(db: SqliteDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS comment_schema (version INTEGER NOT NULL)`);

  // Every step, every time — see pipeline-store.ts's migrate() for why the version number
  // itself is never trusted to describe the schema.
  for (let version = 0; version < MIGRATIONS.length; version += 1) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version] as string);
      db.exec('DELETE FROM comment_schema');
      db.exec(`INSERT INTO comment_schema (version) VALUES (${version + 1})`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');

      const message = error instanceof Error ? error.message : String(error);
      if (!/duplicate column name|already exists/i.test(message)) throw error;

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
      db.exec('DELETE FROM comment_schema');
      db.exec(`INSERT INTO comment_schema (version) VALUES (${version + 1})`);
      db.exec('COMMIT');
    }
  }
}
