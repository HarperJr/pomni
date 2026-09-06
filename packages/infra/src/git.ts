import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  GitError,
  type CloneOptions,
  type GitAuth,
  type GitPort,
  type VcsInfo,
  type WorktreeRef,
} from '@pomni/core';
import { ensureAskpass } from './askpass.js';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface RunOptions {
  cwd?: string;
  auth?: GitAuth;
  onLine?: (line: string) => void;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export class GitCli implements GitPort {
  async isAvailable(): Promise<boolean> {
    try {
      const result = await this.run(['--version'], {});
      return result.code === 0;
    } catch {
      return false;
    }
  }

  async isRepo(dir: string): Promise<boolean> {
    const result = await this.run(['-C', dir, 'rev-parse', '--git-dir'], {});
    return result.code === 0;
  }

  async clone(options: CloneOptions): Promise<void> {
    const args = ['clone', '--progress'];
    if (options.depth) args.push('--depth', String(options.depth));
    if (options.ref) args.push('--branch', options.ref);
    args.push(options.url, options.dir);

    const result = await this.run(args, {
      auth: options.auth,
      onLine: options.onProgress,
    });

    if (result.code !== 0) {
      throw new GitError(explainCloneFailure(result, options), {
        url: options.url,
        stderr: redact(result.stderr, options.auth),
      });
    }
  }

  async info(dir: string): Promise<VcsInfo | null> {
    if (!(await this.isRepo(dir))) return null;

    const [branch, head, remote, originHead, status] = await Promise.all([
      this.text(['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']),
      this.text(['-C', dir, 'rev-parse', 'HEAD']),
      this.text(['-C', dir, 'remote', 'get-url', 'origin']),
      this.text(['-C', dir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']),
      this.text(['-C', dir, 'status', '--porcelain']),
    ]);

    return {
      isRepo: true,
      currentBranch: branch === 'HEAD' ? null : branch,
      defaultBranch: originHead ? originHead.replace(/^origin\//, '') : null,
      remote: remote ?? null,
      head: head ?? null,
      dirty: Boolean(status && status.length > 0),
    };
  }

  /**
   * Files the working copy differs by. Includes untracked files, because a new file an agent
   * wrote is exactly the thing you want to see afterwards.
   */
  async changes(dir: string): Promise<Array<{ path: string; change: string }>> {
    const result = await this.run(['-C', dir, 'status', '--porcelain'], {});
    if (result.code !== 0) return [];

    const changes: Array<{ path: string; change: string }> = [];
    for (const line of result.stdout.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;

      const code = line.slice(0, 2).trim();
      const path = line.slice(3).trim();
      if (!path) continue;

      changes.push({ path, change: describeChange(code) });
    }
    return changes;
  }

  async fetch(dir: string, auth?: GitAuth): Promise<void> {
    const result = await this.run(['-C', dir, 'fetch', '--all', '--prune'], { auth });
    if (result.code !== 0) {
      throw new GitError(`git fetch failed: ${firstUsefulLine(redact(result.stderr, auth))}`);
    }
  }

  async testRemote(url: string, auth?: GitAuth): Promise<void> {
    const result = await this.run(['ls-remote', '--exit-code', '--heads', url], {
      auth,
      timeoutMs: 60_000,
    });
    if (result.code !== 0) {
      throw new GitError(explainAuthFailure(redact(result.stderr, auth)));
    }
  }

  private worktreesSupported: boolean | null = null;

  /**
   * True for git 2.5 or newer. Cached for the process lifetime — a failure to run git or to
   * parse its version is treated as "no", the same as any other reason worktrees are refused.
   */
  async supportsWorktrees(): Promise<boolean> {
    if (this.worktreesSupported !== null) return this.worktreesSupported;

    try {
      const result = await this.run(['--version'], {});
      if (result.code !== 0) {
        this.worktreesSupported = false;
        return false;
      }
      const match = /git version (\d+)\.(\d+)/.exec(result.stdout);
      if (!match) {
        this.worktreesSupported = false;
        return false;
      }
      const major = Number(match[1]);
      const minor = Number(match[2]);
      this.worktreesSupported = major > 2 || (major === 2 && minor >= 5);
      return this.worktreesSupported;
    } catch {
      this.worktreesSupported = false;
      return false;
    }
  }

  async addWorktree(
    repoDir: string,
    options: { path: string; branch: string; baseRef: string },
  ): Promise<{ head: string }> {
    await mkdir(dirname(options.path), { recursive: true });

    const result = await this.run(
      ['-C', repoDir, 'worktree', 'add', '-b', options.branch, options.path, options.baseRef],
      {},
    );
    if (result.code !== 0) {
      throw new GitError(`git worktree add failed: ${firstUsefulLine(result.stderr)}`);
    }

    const head = await this.text(['-C', options.path, 'rev-parse', 'HEAD']);
    return { head: head ?? '' };
  }

  async removeWorktree(
    repoDir: string,
    path: string,
    options?: { deleteBranch?: string },
  ): Promise<void> {
    const result = await this.run(['-C', repoDir, 'worktree', 'remove', path], {});
    if (result.code !== 0) {
      throw new GitError(`git worktree remove failed: ${firstUsefulLine(result.stderr)}`);
    }

    if (!options?.deleteBranch) return;

    // `-d`, not `-D`: if the branch is unmerged, that means the run committed work that lives
    // nowhere else. Leaving it in place is the point, not a failure to report.
    await this.run(['-C', repoDir, 'branch', '-d', options.deleteBranch], {});
  }

  async listWorktrees(repoDir: string): Promise<WorktreeRef[]> {
    const result = await this.run(['-C', repoDir, 'worktree', 'list', '--porcelain'], {});
    if (result.code !== 0) {
      throw new GitError(`git worktree list failed: ${firstUsefulLine(result.stderr)}`);
    }
    return parseWorktreePorcelain(result.stdout);
  }

  async pruneWorktrees(repoDir: string): Promise<void> {
    const result = await this.run(['-C', repoDir, 'worktree', 'prune'], {});
    if (result.code !== 0) {
      throw new GitError(`git worktree prune failed: ${firstUsefulLine(result.stderr)}`);
    }
  }

  // -------------------------------------------------------------------------

  private async text(args: string[]): Promise<string | null> {
    const result = await this.run(args, {});
    if (result.code !== 0) return null;
    const value = result.stdout.trim();
    return value.length > 0 ? value : null;
  }

  private async run(args: string[], options: RunOptions): Promise<RunResult> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // Never block waiting for a terminal that isn't there.
      GIT_TERMINAL_PROMPT: '0',
      // Stop Git Credential Manager (default on Windows) from popping a GUI or caching.
      GCM_INTERACTIVE: 'never',
      LC_ALL: 'C',
    };

    // Disable inherited credential helpers so our askpass is the only answer, and so no
    // helper persists the token to the OS keychain behind the user's back.
    const configArgs = ['-c', 'credential.helper='];

    if (options.auth) {
      env.GIT_ASKPASS = await ensureAskpass();
      env.POMNI_ASKPASS_USER = options.auth.username;
      env.POMNI_ASKPASS_SECRET = options.auth.secret;
    }

    return new Promise<RunResult>((resolvePromise, rejectPromise) => {
      const child = spawn('git', [...configArgs, ...args], {
        cwd: options.cwd,
        env,
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let pending = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        rejectPromise(new GitError(`git ${args[0] ?? ''} timed out`));
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        if (!options.onLine) return;
        // git writes progress with \r; treat both as line breaks.
        pending += text;
        const lines = pending.split(/\r\n|\r|\n/);
        pending = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) options.onLine(redact(trimmed, options.auth));
        }
      });

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const message =
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'git is not installed or not on PATH'
            : error.message;
        rejectPromise(new GitError(message));
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise({ code: code ?? 1, stdout, stderr });
      });
    });
  }
}

/** Never let a token reach a log, an event stream or an error message. */
export function redact(text: string, auth?: GitAuth): string {
  if (!auth?.secret) return text;
  return text.split(auth.secret).join('***');
}

function describeChange(code: string): string {
  if (code === '??') return 'added';
  if (code.includes('D')) return 'deleted';
  if (code.includes('A')) return 'added';
  if (code.includes('R')) return 'renamed';
  return 'modified';
}

/**
 * `git worktree list --porcelain` output: blank-line-separated stanzas, one per worktree
 * (the main one included — the caller decides whether to filter it out).
 */
function parseWorktreePorcelain(output: string): WorktreeRef[] {
  const refs: WorktreeRef[] = [];
  let current: { path: string | null; branch: string | null; head: string | null; prunable: boolean } | null =
    null;

  const flush = () => {
    if (current?.path) {
      refs.push({
        path: current.path,
        branch: current.branch,
        head: current.head,
        prunable: current.prunable,
      });
    }
    current = null;
  };

  for (const line of output.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      flush();
      continue;
    }
    if (line.startsWith('worktree ')) {
      flush();
      current = { path: line.slice('worktree '.length).trim(), branch: null, head: null, prunable: false };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim();
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      current.branch = null;
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      current.prunable = true;
    }
  }
  flush();

  return refs;
}

function firstUsefulLine(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^(Cloning into|remote:\s*$)/i.test(line));
  return lines[lines.length - 1] ?? stderr.trim() ?? 'unknown error';
}

function explainAuthFailure(stderr: string): string {
  // Network problems first: a host that cannot be reached is not an auth or a naming
  // problem, and saying "repository not found" there sends people looking in the wrong
  // place. This matters for hosts on a VPN or tailnet, which come and go.
  const host = /unable to access '([^']+)'/i.exec(stderr)?.[1];
  if (/could not resolve host/i.test(stderr)) {
    return `cannot resolve the host${host ? ` for ${host}` : ''} — check the url, and that you are on the right network or VPN.`;
  }
  if (/failed to connect|connection refused|connection timed out|couldn't connect/i.test(stderr)) {
    return `cannot connect${host ? ` to ${host}` : ''} — the host is reachable by name but refused the connection. Check the port, and that the server is up.`;
  }
  if (/ssl certificate problem|certificate verify failed|self.signed certificate/i.test(stderr)) {
    return 'the TLS certificate was rejected — if it is self-signed, trust it at the OS level rather than disabling verification.';
  }

  if (/authentication failed|invalid username or password|403/i.test(stderr)) {
    return 'authentication failed — the token was rejected. Check that it has not expired and grants repo read access.';
  }
  if (/could not read Username|terminal prompts disabled/i.test(stderr)) {
    return 'the remote asked for credentials but none were supplied — attach a credential to this repo.';
  }
  if (/repository .* not found|404/i.test(stderr)) {
    return 'repository not found — check the url, or that the token can see a private repo.';
  }
  return firstUsefulLine(stderr);
}

function explainCloneFailure(result: RunResult, options: CloneOptions): string {
  const stderr = redact(result.stderr, options.auth);
  if (options.ref && /Remote branch .* not found|pathspec/i.test(stderr)) {
    return `branch or tag '${options.ref}' does not exist on the remote`;
  }
  return `clone failed: ${explainAuthFailure(stderr)}`;
}
