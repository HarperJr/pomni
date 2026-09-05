import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { ZodType, ZodTypeDef } from 'zod';
import {
  ConflictError,
  StaleRevisionError,
  ValidationError,
  type DocRef,
  type DocStore,
  type WriteOptions,
} from '@pomni/core';

/**
 * Filesystem doc store for `.pomni`.
 *
 * Three properties everything else relies on:
 *   - writes are atomic (temp file in the same directory, then rename), so a watcher or a
 *     concurrent reader never sees half a document;
 *   - every read carries a `rev` (hash of the bytes) and writes can require it, so a
 *     concurrent editor gets a conflict instead of losing work;
 *   - `.json` files are serialised as JSON, everything else as YAML.
 */
export class FileDocStore implements DocStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  absolute(relPath: string): string {
    const target = resolve(this.root, relPath);
    const boundary = this.root.endsWith(sep) ? this.root : this.root + sep;
    if (target !== this.root && !target.startsWith(boundary)) {
      throw new ValidationError(`path '${relPath}' escapes the Pomni workspace`);
    }
    return target;
  }

  async read<T>(
    relPath: string,
    schema: ZodType<T, ZodTypeDef, unknown>,
  ): Promise<DocRef<T> | null> {
    const raw = await this.readRaw(relPath);
    if (raw === null) return null;

    const parsed = schema.safeParse(deserialize(relPath, raw.text));
    if (!parsed.success) {
      throw new ValidationError(`'${relPath}' is not valid`, parsed.error.format());
    }
    return { data: parsed.data, rev: raw.rev };
  }

  async write<T>(relPath: string, data: T, options: WriteOptions = {}): Promise<string> {
    const absPath = this.absolute(relPath);
    const current = await this.readRaw(relPath);

    if (options.mustNotExist && current !== null) {
      throw new ConflictError(`'${relPath}' already exists`);
    }

    if (options.ifMatch !== undefined) {
      const actual = current?.rev ?? '';
      if (actual !== options.ifMatch) {
        throw new StaleRevisionError(
          relPath,
          options.ifMatch,
          actual,
          current ? deserialize(relPath, current.text) : null,
        );
      }
    }

    const text = serialize(relPath, data);
    await mkdir(dirname(absPath), { recursive: true });

    // Same directory, so the rename is atomic (a temp dir could be another volume).
    const tmpPath = `${absPath}.${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
      await writeFile(tmpPath, text, 'utf8');
      await rename(tmpPath, absPath);
    } catch (error) {
      await unlink(tmpPath).catch(() => undefined);
      throw error;
    }

    return revOf(text);
  }

  async delete(relPath: string): Promise<void> {
    await unlink(this.absolute(relPath)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  async list(relDir: string): Promise<string[]> {
    try {
      const entries = await readdir(this.absolute(relDir));
      return entries.sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async exists(relPath: string): Promise<boolean> {
    try {
      await access(this.absolute(relPath), constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async removeDir(relDir: string): Promise<void> {
    await rm(this.absolute(relDir), { recursive: true, force: true });
  }

  async ensureDir(relDir: string): Promise<void> {
    await mkdir(this.absolute(relDir), { recursive: true });
  }

  private async readRaw(relPath: string): Promise<{ text: string; rev: string } | null> {
    try {
      const text = await readFile(this.absolute(relPath), 'utf8');
      return { text, rev: revOf(text) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
}

/** Short content hash. Collisions are not a security boundary here, only a staleness check. */
export function revOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

function isJson(relPath: string): boolean {
  return relPath.toLowerCase().endsWith('.json');
}

function isMarkdown(relPath: string): boolean {
  return relPath.toLowerCase().endsWith('.md');
}

function serialize(relPath: string, data: unknown): string {
  if (isJson(relPath)) return `${JSON.stringify(data, null, 2)}\n`;
  if (isMarkdown(relPath)) return serializeMarkdown(data);
  return stringifyYaml(data, { lineWidth: 100 });
}

function deserialize(relPath: string, text: string): unknown {
  if (isJson(relPath)) return text.trim() ? JSON.parse(text) : {};
  if (isMarkdown(relPath)) return deserializeMarkdown(text);
  return parseYaml(text) ?? {};
}

// The trailing group eats the blank line the serializer writes after the closing fence,
// so serialize -> deserialize is the identity on the body.
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n(\r?\n)?/;

/**
 * Markdown with YAML frontmatter, exposed as `{ ...frontmatter, body }`.
 *
 * The body is carried as one opaque string, so a round-trip is byte-exact: an agent editing
 * the file with ordinary tools never has its formatting rewritten underneath it, and a spec
 * change shows up in `git diff` as the prose edit it actually was.
 */
export function deserializeMarkdown(text: string): Record<string, unknown> {
  const match = FRONTMATTER.exec(text);
  if (!match) return { body: text };

  const frontmatter = (parseYaml(match[1] ?? '') ?? {}) as Record<string, unknown>;
  return { ...frontmatter, body: text.slice(match[0].length) };
}

export function serializeMarkdown(data: unknown): string {
  const { body, ...frontmatter } = (data ?? {}) as Record<string, unknown> & { body?: string };
  const yaml = stringifyYaml(frontmatter, { lineWidth: 100 }).trimEnd();
  const text = (body ?? '').replace(/^\n+/, '');
  return '---\n' + yaml + '\n---\n\n' + text;
}

/**
 * Walk up from `start` looking for a `.pomni` directory, so the CLI works from anywhere
 * inside the harness repo — the same way git finds `.git`.
 */
export async function findWorkspaceRoot(start: string): Promise<string | null> {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, '.pomni');
    try {
      await access(candidate, constants.F_OK);
      return candidate;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
}

export function workspaceRootFor(cwd: string, explicit?: string): string {
  if (explicit) {
    const base = isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
    return normalize(base).endsWith('.pomni') ? normalize(base) : join(base, '.pomni');
  }
  return join(resolve(cwd), '.pomni');
}
