import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ChatMessageSchema,
  ChatSchema,
  type Chat,
  type ChatFilter,
  type ChatMessage,
  type ChatStore,
} from '@pomni/core';
import { applyPragmas } from './sqlite.js';

type SqlValue = string | number | null;

interface SqliteStatement {
  run(...params: SqlValue[]): { changes: number | bigint };
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
 * Chat history.
 *
 * Shares the database with pipeline runs and capability runs but keeps its own tables and its
 * own migration counter, so the three can evolve without one's schema change forcing another's.
 *
 * Foreign keys are enabled on this connection so `ON DELETE CASCADE` on `chat_messages.chatId`
 * actually fires — `node:sqlite` does not turn that pragma on by default.
 */
export class SqliteChatStore implements ChatStore {
  private readonly db: SqliteDatabase;
  private readonly cache = new Map<string, SqliteStatement>();

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    applyPragmas(this.db);
    this.db.exec('PRAGMA foreign_keys = ON');
    migrate(this.db);
  }

  async createChat(chat: Chat): Promise<void> {
    this.statement(
      `INSERT INTO chats (id, title, providerId, model, createdAt, updatedAt,
                          inputTokens, outputTokens, costUsd, projectId, titleGeneratedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      chat.id,
      chat.title,
      chat.providerId,
      chat.model,
      chat.createdAt,
      chat.updatedAt,
      chat.inputTokens,
      chat.outputTokens,
      chat.costUsd,
      chat.projectId,
      chat.titleGeneratedAt,
    );
  }

  async listChats(filter: ChatFilter = {}): Promise<Chat[]> {
    const where: string[] = [];
    const values: SqlValue[] = [];

    if (filter.query) {
      where.push('title LIKE ? ESCAPE \'\\\'');
      values.push(`%${escapeLike(filter.query)}%`);
    }
    if (filter.providerId) {
      where.push('providerId = ?');
      values.push(filter.providerId);
    }

    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    values.push(Math.min(filter.limit ?? 50, 200));

    const rows = this.statement(
      `SELECT * FROM chats ${clause} ORDER BY updatedAt DESC LIMIT ?`,
    ).all(...values) as unknown as ChatRow[];
    return rows.map(toChat);
  }

  async getChat(id: string): Promise<Chat | null> {
    const row = this.statement('SELECT * FROM chats WHERE id = ?').get(id) as unknown as
      | ChatRow
      | undefined;
    return row ? toChat(row) : null;
  }

  async updateChat(chat: Chat): Promise<void> {
    this.statement(
      `UPDATE chats
         SET title = ?, providerId = ?, model = ?, updatedAt = ?,
             inputTokens = ?, outputTokens = ?, costUsd = ?, projectId = ?, titleGeneratedAt = ?
       WHERE id = ?`,
    ).run(
      chat.title,
      chat.providerId,
      chat.model,
      chat.updatedAt,
      chat.inputTokens,
      chat.outputTokens,
      chat.costUsd,
      chat.projectId,
      chat.titleGeneratedAt,
      chat.id,
    );
  }

  /**
   * Settles a title generated in the background, but only while it is still unset — a message
   * sent while generation was in flight, or a hand rename, may have already changed the chat
   * underneath it. A single `UPDATE ... WHERE titleGeneratedAt IS NULL` avoids the read-modify-
   * write race that a read followed by `updateChat` would reintroduce.
   */
  async settleTitle(chatId: string, title: string, at: string): Promise<boolean> {
    const result = this.statement(
      `UPDATE chats SET title = ?, titleGeneratedAt = ? WHERE id = ? AND titleGeneratedAt IS NULL`,
    ).run(title, at, chatId);
    return Number(result.changes) > 0;
  }

  async deleteChat(id: string): Promise<void> {
    this.statement('DELETE FROM chats WHERE id = ?').run(id);
  }

  async appendMessage(message: ChatMessage): Promise<void> {
    this.statement(
      `INSERT INTO chat_messages (id, chatId, role, text, providerId, model, actions,
                                  createdAt, inputTokens, outputTokens, costUsd,
                                  projectId, addresses)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      message.id,
      message.chatId,
      message.role,
      message.text,
      message.providerId,
      message.model,
      JSON.stringify(message.actions),
      message.createdAt,
      message.inputTokens,
      message.outputTokens,
      message.costUsd,
      message.projectId,
      JSON.stringify(message.addresses),
    );
  }

  async updateMessage(message: ChatMessage): Promise<void> {
    this.statement(
      `UPDATE chat_messages
         SET role = ?, text = ?, providerId = ?, model = ?, actions = ?,
             inputTokens = ?, outputTokens = ?, costUsd = ?, projectId = ?, addresses = ?
       WHERE id = ?`,
    ).run(
      message.role,
      message.text,
      message.providerId,
      message.model,
      JSON.stringify(message.actions),
      message.inputTokens,
      message.outputTokens,
      message.costUsd,
      message.projectId,
      JSON.stringify(message.addresses),
      message.id,
    );
  }

  async listMessages(chatId: string): Promise<ChatMessage[]> {
    const rows = this.statement(
      'SELECT * FROM chat_messages WHERE chatId = ? ORDER BY createdAt ASC',
    ).all(chatId) as unknown as ChatMessageRow[];
    return rows.map(toChatMessage);
  }

  async getMessage(id: string): Promise<ChatMessage | null> {
    const row = this.statement('SELECT * FROM chat_messages WHERE id = ?').get(
      id,
    ) as unknown as ChatMessageRow | undefined;
    return row ? toChatMessage(row) : null;
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

/** Escapes `%` and `_` so a query substring is matched literally, not as a LIKE pattern. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

interface ChatRow {
  id: string;
  title: string;
  providerId: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  projectId: string | null;
  titleGeneratedAt: string | null;
}

function toChat(row: ChatRow): Chat {
  return ChatSchema.parse({
    id: row.id,
    title: row.title,
    providerId: row.providerId,
    model: row.model,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costUsd: row.costUsd,
    projectId: row.projectId,
    titleGeneratedAt: row.titleGeneratedAt,
  });
}

interface ChatMessageRow {
  id: string;
  chatId: string;
  role: string;
  text: string;
  providerId: string | null;
  model: string | null;
  actions: string;
  createdAt: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  projectId: string | null;
  addresses: string;
}

function toChatMessage(row: ChatMessageRow): ChatMessage {
  return ChatMessageSchema.parse({
    id: row.id,
    chatId: row.chatId,
    role: row.role,
    text: row.text,
    providerId: row.providerId,
    model: row.model,
    actions: parseJsonArray(row.actions),
    createdAt: row.createdAt,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costUsd: row.costUsd,
    projectId: row.projectId,
    addresses: parseJsonArray(row.addresses),
  });
}

/** Tolerant of a malformed or missing JSON-array column; the schema still validates each entry. */
function parseJsonArray(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS chats (
     id           TEXT PRIMARY KEY,
     title        TEXT NOT NULL,
     providerId   TEXT NOT NULL,
     model        TEXT NOT NULL,
     createdAt    TEXT NOT NULL,
     updatedAt    TEXT NOT NULL,
     inputTokens  INTEGER NOT NULL DEFAULT 0,
     outputTokens INTEGER NOT NULL DEFAULT 0,
     costUsd      REAL
   );
   CREATE INDEX IF NOT EXISTS idx_chats_updated ON chats(updatedAt DESC);

   CREATE TABLE IF NOT EXISTS chat_messages (
     id           TEXT PRIMARY KEY,
     chatId       TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
     role         TEXT NOT NULL,
     text         TEXT NOT NULL,
     providerId   TEXT,
     model        TEXT,
     actions      TEXT NOT NULL DEFAULT '[]',
     createdAt    TEXT NOT NULL,
     inputTokens  INTEGER NOT NULL DEFAULT 0,
     outputTokens INTEGER NOT NULL DEFAULT 0,
     costUsd      REAL
   );
   CREATE INDEX IF NOT EXISTS idx_chat_messages_chat ON chat_messages(chatId, createdAt);`,

  `ALTER TABLE chats ADD COLUMN projectId TEXT;
   ALTER TABLE chats ADD COLUMN titleGeneratedAt TEXT;
   UPDATE chats SET titleGeneratedAt = createdAt WHERE title != '';

   ALTER TABLE chat_messages ADD COLUMN projectId TEXT;
   ALTER TABLE chat_messages ADD COLUMN addresses TEXT NOT NULL DEFAULT '[]';

   CREATE INDEX IF NOT EXISTS idx_chats_project ON chats(projectId, updatedAt DESC);`,
];

function migrate(db: SqliteDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS chat_schema (version INTEGER NOT NULL)`);

  const row = db.prepare('SELECT version FROM chat_schema LIMIT 1').get() as unknown as
    | { version: number }
    | undefined;
  const current = row?.version ?? 0;

  for (let version = current; version < MIGRATIONS.length; version += 1) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version] as string);
      db.exec('DELETE FROM chat_schema');
      db.exec(`INSERT INTO chat_schema (version) VALUES (${version + 1})`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
