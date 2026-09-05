import { constants } from 'node:fs';
import { access, readdir, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { DirEntry, FsProbe } from '@pomni/core';

/**
 * Reads the user's machine outside `.pomni`: validating a linked path, listing directories
 * for the picker, and giving stack detectors something to sniff.
 */
export class NodeFsProbe implements FsProbe {
  async exists(absPath: string): Promise<boolean> {
    try {
      await access(absPath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async isDirectory(absPath: string): Promise<boolean> {
    try {
      return (await stat(absPath)).isDirectory();
    } catch {
      return false;
    }
  }

  async readText(absPath: string): Promise<string | null> {
    try {
      return await readFile(absPath, 'utf8');
    } catch {
      return null;
    }
  }

  async listDir(absPath: string, options: { includeHidden?: boolean } = {}): Promise<DirEntry[]> {
    const entries = await readdir(absPath, { withFileTypes: true });
    const results: DirEntry[] = [];

    for (const entry of entries) {
      if (!options.includeHidden && entry.name.startsWith('.')) continue;
      // node_modules in a picker is pure noise.
      if (entry.name === 'node_modules') continue;

      const path = join(absPath, entry.name);
      const isDirectory = entry.isDirectory();
      results.push({
        name: entry.name,
        path,
        isDirectory,
        isGitRepo: isDirectory ? await this.exists(join(path, '.git')) : false,
      });
    }

    return results.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  async listNames(absPath: string): Promise<string[]> {
    try {
      return await readdir(absPath);
    } catch {
      return [];
    }
  }

  async remove(absPath: string): Promise<void> {
    await rm(absPath, { recursive: true, force: true });
  }

  async roots(): Promise<string[]> {
    if (process.platform !== 'win32') return ['/'];

    const found: string[] = [];
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZAB') {
      const root = `${letter}:\\`;
      if (await this.exists(root)) found.push(root);
    }
    return found.length > 0 ? found : ['C:\\'];
  }

  home(): string {
    return homedir();
  }

  resolve(input: string): string {
    const expanded = input.startsWith('~') ? join(homedir(), input.slice(1)) : input;
    return isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);
  }
}
