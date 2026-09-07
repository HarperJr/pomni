import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  GitError,
  type CloneOptions,
  type CommitResult,
  type FastForwardResult,
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

/**
 * Who a commit is by when git has nobody to name.
 *
 * Passed with `-c` on the one invocation, never written to a config file: borrowing an
 * identity for a commit is a smaller thing than configuring a machine on the user's behalf.
 */
const FALLBACK_IDENTITY = [
  '-c',
  'user.name=Pomni',
  '-c',
  'user.email=pomni@localhost',
];

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

  async branchExists(dir: string, branch: string): Promise<boolean> {
    const result = await this.run(
      ['-C', dir, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
      {},
    );
    return result.code === 0;
  }

  /**
   * Stage everything and commit it.
   *
   * `add -A` rather than `add -u`: a file an agent created is exactly the thing you want in
   * the commit, and it is the same reasoning `changes()` already applies to untracked files.
   *
   * The identity fallback is the difference between a working install and one where every run
   * silently fails to deliver. A fresh machine, or a service account, has no `user.email`, and
   * git's refusal there is fatal to the whole loop. Pomni supplies one only when git has none
   * of its own, passes it per-invocation so nothing is written into anyone's config, and says
   * that it did — an attributed commit nobody chose is worth reporting.
   */
  async commit(dir: string, options: { message: string }): Promise<CommitResult> {
    const status = await this.run(['-C', dir, 'status', '--porcelain'], {});
    if (status.code === 0 && status.stdout.trim().length === 0) {
      return { committed: false, head: await this.text(['-C', dir, 'rev-parse', 'HEAD']) };
    }

    const staged = await this.run(['-C', dir, 'add', '-A'], {});
    if (staged.code !== 0) {
      throw new GitError(`git add failed: ${firstUsefulLine(staged.stderr)}`);
    }

    // Staging can still leave nothing to commit — a file changed and changed back, or one
    // that only .gitignore had an opinion about.
    const cached = await this.run(['-C', dir, 'diff', '--cached', '--quiet'], {});
    if (cached.code === 0) {
      return { committed: false, head: await this.text(['-C', dir, 'rev-parse', 'HEAD']) };
    }

    const identity = (await this.hasIdentity(dir)) ? [] : FALLBACK_IDENTITY;
    const result = await this.run(
      ['-C', dir, ...identity, 'commit', '--no-verify', '-m', options.message],
      {},
    );
    if (result.code !== 0) {
      throw new GitError(`git commit failed: ${firstUsefulLine(result.stderr || result.stdout)}`);
    }

    return {
      committed: true,
      head: await this.text(['-C', dir, 'rev-parse', 'HEAD']),
      ...(identity.length > 0 ? { identityBorrowed: true } : {}),
    };
  }

  async push(
    dir: string,
    options: { branch: string; remote?: string; setUpstream?: boolean; auth?: GitAuth },
  ): Promise<void> {
    const args = ['-C', dir, 'push'];
    if (options.setUpstream !== false) args.push('--set-upstream');
    args.push(options.remote ?? 'origin', `refs/heads/${options.branch}:refs/heads/${options.branch}`);

    const result = await this.run(args, { auth: options.auth });
    if (result.code !== 0) {
      throw new GitError(
        `git push failed: ${explainPushFailure(redact(result.stderr, options.auth))}`,
      );
    }
  }

  /**
   * Advance a branch to its upstream, fast-forward only.
   *
   * `merge --ff-only` rather than any comparison Pomni does itself: git decides what is a
   * fast-forward, and a refusal from git is a fact rather than a guess. The dirty and
   * no-upstream checks come first only because their messages are better than git's.
   */
  async fastForward(dir: string, options: { branch?: string } = {}): Promise<FastForwardResult> {
    const branch =
      options.branch ?? (await this.text(['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']));
    const from = await this.text(['-C', dir, 'rev-parse', 'HEAD']);
    const base: FastForwardResult = {
      status: 'unavailable',
      branch,
      upstream: null,
      from,
      to: from,
      detail: '',
    };

    if (!branch || branch === 'HEAD') {
      return { ...base, detail: 'the working copy is on a detached HEAD, so there is nothing to advance' };
    }

    // Only the checked-out branch can be advanced by a merge. Anything else would need a ref
    // update behind the working copy's back, which is how a tree ends up disagreeing with HEAD.
    const current = await this.text(['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']);
    if (current !== branch) {
      return {
        ...base,
        detail: `the working copy is on '${current}', not '${branch}' — only the checked-out branch is advanced`,
      };
    }

    const upstream = await this.text([
      '-C',
      dir,
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      `${branch}@{upstream}`,
    ]);
    if (!upstream) {
      return {
        ...base,
        status: 'no-upstream',
        detail: `'${branch}' tracks nothing, so there is no upstream to advance to`,
      };
    }

    const status = await this.run(['-C', dir, 'status', '--porcelain'], {});
    const dirty = status.stdout
      .split(/\r?\n/)
      .map((line) => line.slice(3).trim())
      .filter((line) => line.length > 0);
    if (dirty.length > 0) {
      return {
        ...base,
        status: 'dirty',
        upstream,
        detail: `'${branch}' was left alone: ${dirty.length} uncommitted change${
          dirty.length === 1 ? '' : 's'
        } (${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? ', …' : ''})`,
      };
    }

    const merged = await this.run(['-C', dir, 'merge', '--ff-only', upstream], {});
    const to = await this.text(['-C', dir, 'rev-parse', 'HEAD']);

    if (merged.code !== 0) {
      return {
        ...base,
        status: 'diverged',
        upstream,
        detail:
          `'${branch}' has commits that ${upstream} does not, so it was not advanced — ` +
          'they exist nowhere else, and rebasing or resetting is yours to decide',
      };
    }

    if (from === to) {
      return { ...base, status: 'current', upstream, to, detail: `'${branch}' is already at ${upstream}` };
    }

    return {
      ...base,
      status: 'advanced',
      upstream,
      to,
      detail: `'${branch}' advanced to ${upstream} (${short(from)} → ${short(to)})`,
    };
  }

  /** Whether git can name an author here without being told. */
  private async hasIdentity(dir: string): Promise<boolean> {
    const email = await this.text(['-C', dir, 'config', '--get', 'user.email']);
    const name = await this.text(['-C', dir, 'config', '--get', 'user.name']);
    return Boolean(email && name);
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

  async attachWorktree(
    repoDir: string,
    options: { path: string; branch: string },
  ): Promise<{ head: string }> {
    await mkdir(dirname(options.path), { recursive: true });

    // No `-b`: the branch is the run's own and already exists. Creating it again is exactly
    // what made a resume fall back to the shared repo directory.
    const result = await this.run(
      ['-C', repoDir, 'worktree', 'add', options.path, options.branch],
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

function short(sha: string | null): string {
  return sha ? sha.slice(0, 7) : '?';
}

/**
 * A push fails for reasons a fetch does not, and the two that matter are worth naming: the
 * branch moved under us, and the token can read but not write.
 */
function explainPushFailure(stderr: string): string {
  if (/non-fast-forward|fetch first|behind its remote/i.test(stderr)) {
    return 'the remote branch has commits this one does not — fetch and rebase before pushing again';
  }
  if (/protected branch|pre-receive hook declined|denied|not allowed to push/i.test(stderr)) {
    return `the remote refused the push: ${firstUsefulLine(stderr)}`;
  }
  if (/authentication failed|403|invalid username or password/i.test(stderr)) {
    return 'authentication failed — the token was rejected, or it grants read access but not write';
  }
  return explainAuthFailure(stderr);
}

function explainCloneFailure(result: RunResult, options: CloneOptions): string {
  const stderr = redact(result.stderr, options.auth);
  if (options.ref && /Remote branch .* not found|pathspec/i.test(stderr)) {
    return `branch or tag '${options.ref}' does not exist on the remote`;
  }
  return `clone failed: ${explainAuthFailure(stderr)}`;
}
