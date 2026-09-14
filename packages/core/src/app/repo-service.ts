import { z } from 'zod';
import { mergeCapabilities } from '../domain/capability.js';
import { ConflictError, NotFoundError, PomniError, ValidationError } from '../domain/errors.js';
import { assertSlug, repoIdFromSource, uniqueId } from '../domain/ids.js';
import { layout } from '../domain/layout.js';
import {
  RepoSchema,
  type Repo,
  type RepoRole,
  type ResolvedRepo,
  type WorktreePolicy,
} from '../domain/repo.js';
import {
  assertCredentialUsable,
  detectProvider,
  isSshUrl,
  normalizeGitUrl,
  type GitSource,
  type RepoSource,
} from '../domain/source.js';
import type {
  Clock,
  DocRef,
  DocStore,
  EventBus,
  FastForwardResult,
  FsProbe,
  GitAuth,
  GitPort,
  Logger,
  ProviderProbe,
  StackDetection,
} from '../ports/index.js';
import type { CredentialService } from './credential-service.js';
import type { ProjectService } from './project-service.js';
import type { WorkspaceService } from './workspace-service.js';

/**
 * What a caller supplies. Looser than `RepoSource`: `provider` is derived from the url and
 * a local path is resolved, both by `normalizeSource`. Surfaces should not have to know
 * the normalised shape.
 */
export type AddRepoSourceInput =
  | { kind: 'local'; path: string }
  | {
      kind: 'git';
      url: string;
      ref?: string;
      credential?: string;
      provider?: GitSource['provider'];
    };

export interface AddRepoInput {
  source: AddRepoSourceInput;
  id?: string;
  name?: string;
  role?: RepoRole;
}

/**
 * What may be changed after the fact. Source fields are all optional and merged onto the
 * existing source, so attaching a credential does not require restating the url.
 */
export interface UpdateRepoInput {
  name?: string;
  role?: RepoRole;
  /** git sources only. */
  url?: string;
  ref?: string | null;
  credential?: string | null;
  provider?: GitSource['provider'];
  /** Required to change the url of a repo that already has a working copy. */
  reclone?: boolean;
  /** Whether a pipeline run gets its own worktree of this repo. */
  worktrees?: WorktreePolicy;
  /**
   * Per-capability ceilings, in milliseconds; `null` removes one. The capability must already
   * be declared — a timeout is a property of a command, not a command.
   */
  timeouts?: Record<string, number | null>;
}

/**
 * Adding a git repo has to clone, which can take a while. `add` returns immediately with a
 * record in `cloning`, plus a promise that settles when the work is done. The CLI awaits
 * it; the HTTP layer returns 202 and lets the browser poll. Same code path either way.
 */
export interface AddRepoResult {
  repo: Repo;
  completion: Promise<Repo>;
}

/**
 * A synced repo, plus what the sync did to its base branch.
 *
 * `advanced` is null for a repo there was nothing to advance — a linked directory, or a clone
 * that had to be made from scratch. Carried on the result rather than logged because the whole
 * point of the change is that a person can see whether the code moved.
 */
export interface SyncedRepo extends ResolvedRepo {
  advanced: FastForwardResult | null;
}

export class RepoService {
  constructor(
    private readonly docs: DocStore,
    private readonly projects: ProjectService,
    private readonly workspace: WorkspaceService,
    private readonly credentials: CredentialService,
    private readonly git: GitPort,
    private readonly fs: FsProbe,
    private readonly detection: StackDetection,
    private readonly providerProbe: ProviderProbe,
    private readonly clock: Clock,
    private readonly events: EventBus,
    private readonly logger: Logger,
  ) {}

  async add(projectId: string, input: AddRepoInput): Promise<AddRepoResult> {
    await this.projects.getRef(projectId);

    const source = await this.normalizeSource(input.source);
    const existing = await this.list(projectId);
    await this.assertNotDuplicate(existing, source);

    const desiredId =
      input.id?.trim() ||
      repoIdFromSource(source.kind === 'local' ? source.path : source.url) ||
      'repo';
    const id = uniqueId(desiredId, existing.map((repo) => repo.id));
    assertSlug(id, 'repo id');

    const now = this.clock.iso();
    const repo = RepoSchema.parse({
      id,
      projectId,
      name: input.name?.trim() || id,
      role: input.role ?? 'other',
      source,
      status: source.kind === 'local' ? 'linked' : 'cloning',
      stack: null,
      capabilities: {},
      vcs: null,
      lastError: null,
      addedAt: now,
      updatedAt: now,
    });

    await this.docs.ensureDir(layout.reposDir(projectId));
    await this.docs.write(layout.repo(projectId, id), repo, { mustNotExist: true });
    this.events.emit({ type: 'repo.added', projectId, repoId: id });

    return { repo, completion: this.materialize(repo) };
  }

  async list(projectId: string): Promise<Repo[]> {
    const files = await this.docs.list(layout.reposDir(projectId));
    const repos: Repo[] = [];
    for (const file of files) {
      if (!file.endsWith('.yaml')) continue;
      const ref = await this.readRef(projectId, file.replace(/\.yaml$/, ''));
      if (ref) repos.push(ref.data);
    }
    return repos.sort((a, b) => a.name.localeCompare(b.name));
  }

  async listResolved(projectId: string): Promise<ResolvedRepo[]> {
    return this.workspace.resolveAll(await this.list(projectId));
  }

  async get(projectId: string, repoId: string): Promise<ResolvedRepo> {
    const ref = await this.readRef(projectId, repoId);
    if (!ref) throw new NotFoundError('repo', `${projectId}/${repoId}`);
    return this.workspace.resolve(ref.data);
  }

  /**
   * `purge` deletes the cloned working copy. A linked local repo is never deleted — Pomni
   * did not create that directory and must not remove it.
   */
  async remove(
    projectId: string,
    repoId: string,
    options: { purge?: boolean } = {},
  ): Promise<void> {
    const repo = await this.get(projectId, repoId);
    if (options.purge && repo.source.kind === 'git') {
      await this.docs.removeDir(layout.workspaceRepo(projectId, repoId));
    }
    await this.docs.delete(layout.repo(projectId, repoId));
    this.events.emit({ type: 'repo.removed', projectId, repoId });
  }

  /**
   * Re-read the working copy, then re-detect stack and capabilities.
   *
   * A git repo whose working copy is absent is re-cloned rather than merely reported
   * missing: Sync is the obvious button to press after a clone failed, and the useful
   * behaviour there is "try again", surfacing the real error if it fails again.
   */
  async sync(projectId: string, repoId: string): Promise<SyncedRepo> {
    const repo = await this.get(projectId, repoId);

    if (repo.source.kind === 'git' && !repo.workingDirExists) {
      return { ...(await this.workspace.resolve(await this.materialize(repo))), advanced: null };
    }

    if (repo.source.kind !== 'git') {
      return { ...(await this.workspace.resolve(await this.inspect(repo))), advanced: null };
    }

    try {
      await this.git.fetch(repo.workingDir, await this.authFor(repo.source));
    } catch (error) {
      this.logger.warn(`fetch failed for ${projectId}/${repoId}`, error);
    }

    // Fetching told the clone what the remote has; it did not move the clone onto it. Every
    // run cuts its worktree from the clone's own base branch, so a clone that never advances
    // is a clone every run starts behind — including behind work Pomni itself just merged.
    const advanced = await this.git.fastForward(repo.workingDir, { branch: repo.source.ref });
    if (advanced.status === 'diverged' || advanced.status === 'dirty') {
      this.logger.warn(`${projectId}/${repoId}: ${advanced.detail}`);
    }

    return { ...(await this.workspace.resolve(await this.inspect(repo))), advanced };
  }

  /**
   * The credential a repo's remote authenticates with, for callers outside this service that
   * have to reach the same remote — pushing a run's branch, above all.
   *
   * Public where {@link authFor} is private because the argument is a repo rather than a
   * source: a caller that had to build a `RepoSource` to ask this question would be one
   * assembling a domain record from parts, which is how the two drift apart.
   */
  async authForRepo(repo: Pick<Repo, 'source'>): Promise<GitAuth | undefined> {
    return this.authFor(repo.source);
  }

  /**
   * Edit a repo in place, including its source.
   *
   * Attaching a credential after the fact is the common case — you add a repo, the clone
   * fails on auth, and you then create the token. Making that require remove-and-re-add
   * would throw away the id, the role and any history pointing at it.
   *
   * Changing the url of a repo that already has a working copy is the one destructive
   * edit, so it needs `reclone: true` rather than happening silently.
   */
  async update(
    projectId: string,
    repoId: string,
    patch: UpdateRepoInput,
    ifMatch?: string,
  ): Promise<Repo> {
    const ref = await this.readRef(projectId, repoId);
    if (!ref) throw new NotFoundError('repo', `${projectId}/${repoId}`);

    const current = ref.data;
    const source = await this.patchSource(projectId, current, patch);
    const urlChanged =
      source.kind === 'git' && current.source.kind === 'git' && source.url !== current.source.url;

    if (urlChanged) {
      const workingDir = this.workspace.workingDir(current);
      if ((await this.fs.exists(workingDir)) && !patch.reclone) {
        throw new ConflictError(
          `'${repoId}' already has a working copy cloned from ${
            (current.source as GitSource).url
          } — pass reclone to delete it and clone the new url instead`,
        );
      }
      if (patch.reclone) {
        await this.docs.removeDir(layout.workspaceRepo(projectId, repoId));
      }
    }

    const next = RepoSchema.parse({
      ...current,
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.role !== undefined ? { role: patch.role } : {}),
      ...(patch.worktrees !== undefined ? { worktrees: patch.worktrees } : {}),
      ...(patch.timeouts !== undefined
        ? { capabilities: withTimeouts(current, patch.timeouts) }
        : {}),
      source,
      // A source edit invalidates whatever the last attempt concluded; the next sync decides.
      ...(urlChanged ? { status: 'cloning', stack: null, vcs: null, lastError: null } : {}),
      updatedAt: this.clock.iso(),
    });

    await this.docs.write(layout.repo(projectId, repoId), next, { ifMatch: ifMatch ?? ref.rev });
    this.events.emit({ type: 'repo.updated', projectId, repoId, status: next.status });

    // A new url means the old working copy is gone; fetch the new one straight away.
    if (urlChanged) return this.materialize(next);
    return next;
  }

  // -------------------------------------------------------------------------

  /**
   * Clone if needed, then inspect. Runs detached from the caller in the HTTP path, so it
   * must never reject: failures are recorded on the repo, and a repo deleted mid-flight is
   * treated as a cancellation rather than an error.
   */
  private async materialize(repo: Repo): Promise<Repo> {
    try {
      if (repo.source.kind === 'git') {
        await this.clone(repo);
      }
      return await this.inspect(await this.reload(repo));
    } catch (error) {
      // The user removed the repo (or its project) while the clone was running. There is
      // nothing left to record against, and this is not a failure.
      if (await this.isGone(repo)) return repo;

      const message = error instanceof Error ? error.message : String(error);
      // Recorded on the repo as status=error + lastError, which is what surfaces to the
      // user. Logging at error level too would double up in the CLI.
      this.logger.debug(`failed to add ${repo.projectId}/${repo.id}`, message);

      try {
        // An unreachable remote fails the same way every retry. Without `skipUnchanged` each
        // one rewrites the record with a one-timestamp diff; a different failure still differs
        // in `lastError` and is still written.
        return await this.patch(
          repo.projectId,
          repo.id,
          (current) => ({
            ...current,
            status: 'error',
            lastError: message,
          }),
          { skipUnchanged: true },
        );
      } catch (writeError) {
        if (await this.isGone(repo)) return repo;
        throw writeError;
      }
    }
  }

  /** True once the repo record has been deleted — the signal that work should stop. */
  private async isGone(repo: Repo): Promise<boolean> {
    return !(await this.docs.exists(layout.repo(repo.projectId, repo.id)));
  }

  private async clone(repo: Repo): Promise<void> {
    if (repo.source.kind !== 'git') return;
    const dir = this.workspace.workingDir(repo);

    if (await this.fs.exists(dir)) {
      if (await this.git.isRepo(dir)) return;
      throw new ConflictError(
        `workspace directory '${dir}' already exists and is not a git repo — remove it and try again`,
      );
    }

    await this.docs.ensureDir(layout.workspaceProject(repo.projectId));
    await this.git.clone({
      url: repo.source.url,
      dir,
      ref: repo.source.ref,
      auth: await this.authFor(repo.source),
      onProgress: (line) =>
        this.events.emit({
          type: 'repo.progress',
          projectId: repo.projectId,
          repoId: repo.id,
          line,
        }),
    });
  }

  /** Read the working copy and record what is there: git info, stack, capabilities. */
  private async inspect(repo: Repo): Promise<Repo> {
    const dir = this.workspace.workingDir(repo);

    if (!(await this.fs.isDirectory(dir))) {
      return this.patch(
        repo.projectId,
        repo.id,
        (current) => ({
          ...current,
          status: 'missing',
          lastError: `working directory '${dir}' does not exist`,
        }),
        { skipUnchanged: true },
      );
    }

    const vcs = await this.git.info(dir);
    const detected = await this.detection.detect(dir);

    // Inspecting is mostly a read, and a read should leave no trace: `skipUnchanged` drops the
    // write when the only thing that moved is the clock, or the working copy's own dirtiness
    // and branch. Pomni's own repo record is a tracked file in the repo Pomni manages, so a
    // write here dirties the tree and the next checkout is refused.
    return this.patch(
      repo.projectId,
      repo.id,
      (current) => ({
        ...current,
        status: current.source.kind === 'local' ? 'linked' : 'ready',
        lastError: null,
        lastSyncedAt: this.clock.iso(),
        vcs,
        stack: detected
          ? { adapter: detected.adapter, detected: detected.detected, detectedAt: this.clock.iso() }
          : current.stack,
        capabilities: detected
          ? mergeCapabilities(current.capabilities, detected.capabilities)
          : current.capabilities,
      }),
      { skipUnchanged: true },
    );
  }

  private async normalizeSource(source: AddRepoSourceInput): Promise<RepoSource> {
    if (source.kind === 'local') {
      const path = this.fs.resolve(source.path);
      if (!(await this.fs.exists(path))) {
        throw new ValidationError(`'${path}' does not exist`);
      }
      if (!(await this.fs.isDirectory(path))) {
        throw new ValidationError(`'${path}' is not a directory`);
      }
      return { kind: 'local', path };
    }

    const url = normalizeGitUrl(source.url);
    const normalized = {
      kind: 'git' as const,
      url,
      ref: source.ref?.trim() || undefined,
      credential: source.credential?.trim() || undefined,
      provider: await this.resolveProvider(url, source.provider),
    };
    assertCredentialUsable(normalized);

    if (normalized.credential) {
      await this.credentials.get(normalized.credential);
    }
    return normalized;
  }

  /** Merge a partial source edit onto the existing source, validating the result. */
  private async patchSource(
    projectId: string,
    current: Repo,
    patch: UpdateRepoInput,
  ): Promise<RepoSource> {
    const touchesSource =
      patch.url !== undefined ||
      patch.ref !== undefined ||
      patch.credential !== undefined ||
      patch.provider !== undefined;

    if (!touchesSource) return current.source;

    if (current.source.kind !== 'git') {
      throw new ValidationError(
        `'${current.id}' is a linked local folder — remove it and add the git url instead`,
      );
    }

    const existing = current.source;
    const url = normalizeGitUrl(patch.url ?? existing.url);

    const credential =
      patch.credential === undefined
        ? existing.credential
        : patch.credential === null || patch.credential === ''
          ? undefined
          : patch.credential.trim();

    const ref =
      patch.ref === undefined
        ? existing.ref
        : patch.ref === null || patch.ref.trim() === ''
          ? undefined
          : patch.ref.trim();

    const next: GitSource = {
      kind: 'git',
      url,
      ref,
      credential,
      provider: patch.provider ?? (await this.resolveProvider(url, patch.url ? undefined : existing.provider)),
    };

    assertCredentialUsable(next);
    if (next.credential) await this.credentials.get(next.credential);

    if (url !== existing.url) {
      const siblings = (await this.list(projectId)).filter((repo) => repo.id !== current.id);
      await this.assertNotDuplicate(siblings, next);
    }

    return next;
  }

  /**
   * An explicit choice wins. Otherwise the hostname decides, and only when that yields
   * nothing does the probe go to the network — which is the self-hosted case, and the one
   * where getting it right actually changes how a token is sent.
   */
  private async resolveProvider(
    url: string,
    explicit: GitSource['provider'] | undefined,
  ): Promise<GitSource['provider']> {
    if (explicit) return explicit;

    const byHost = detectProvider(url);
    if (byHost !== 'generic') return byHost;

    try {
      return await this.providerProbe.probe(url);
    } catch {
      return 'generic';
    }
  }

  private async assertNotDuplicate(existing: Repo[], source: RepoSource): Promise<void> {
    const clash = existing.find((repo) => {
      if (repo.source.kind !== source.kind) return false;
      if (repo.source.kind === 'local' && source.kind === 'local') {
        return samePath(repo.source.path, source.path);
      }
      if (repo.source.kind === 'git' && source.kind === 'git') {
        return sameRemote(repo.source.url, source.url);
      }
      return false;
    });

    if (clash) {
      throw new ConflictError(
        `this repo is already in the project as '${clash.id}'`,
        { repoId: clash.id },
      );
    }
  }

  /**
   * Explicit credential wins; otherwise match one by host, so a single stored GitHub token
   * serves every github.com repo. Ssh urls authenticate through the user's agent.
   */
  private async authFor(source: RepoSource): Promise<GitAuth | undefined> {
    if (source.kind !== 'git' || isSshUrl(source.url)) return undefined;
    if (source.credential) return this.credentials.auth(source.credential);

    const matched = await this.credentials.findForUrl(source.url);
    if (!matched) return undefined;
    try {
      return await this.credentials.auth(matched.id);
    } catch {
      return undefined;
    }
  }

  private async reload(repo: Repo): Promise<Repo> {
    const ref = await this.readRef(repo.projectId, repo.id);
    return ref?.data ?? repo;
  }

  /**
   * Read-modify-write with the current rev, retried once. Status updates race with a user
   * renaming the repo in the UI; a single retry resolves that without a lock.
   *
   * `skipUnchanged` makes the write conditional on the result differing from what is on disk
   * in something other than what was merely true at the moment of looking — see
   * {@link sameApartFromTimestamps} and {@link withoutTimestamps}. The record
   * returned is then the one on disk, old timestamps and all, so no caller reports a
   * `lastSyncedAt` that was never persisted.
   */
  private async patch(
    projectId: string,
    repoId: string,
    mutate: (current: Repo) => Repo,
    options: { skipUnchanged?: boolean } = {},
  ): Promise<Repo> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ref = await this.readRef(projectId, repoId);
      if (!ref) throw new NotFoundError('repo', `${projectId}/${repoId}`);

      const next = RepoSchema.parse({ ...mutate(ref.data), updatedAt: this.clock.iso() });
      if (options.skipUnchanged && sameApartFromTimestamps(ref.data, next)) return ref.data;

      try {
        await this.docs.write(layout.repo(projectId, repoId), next, { ifMatch: ref.rev });
        this.events.emit({ type: 'repo.updated', projectId, repoId, status: next.status });
        return next;
      } catch (error) {
        if (error instanceof PomniError && error.code === 'stale_revision' && attempt === 0) {
          continue;
        }
        throw error;
      }
    }
    throw new ConflictError(`could not update repo '${projectId}/${repoId}'`);
  }

  private async readRef(projectId: string, repoId: string): Promise<DocRef<Repo> | null> {
    return this.docs.read(layout.repo(projectId, repoId), RepoSchema as z.ZodType<Repo>);
  }
}

/**
 * Two repo records that differ only in what was true at the moment of looking.
 *
 * The one exception: a record whose stored `lastSyncedAt` is null, being replaced by one that
 * has it. A record written before the field existed would otherwise skip every write forever
 * and read as never synced however many times it is actually synced.
 */
function sameApartFromTimestamps(a: Repo, b: Repo): boolean {
  if (a.lastSyncedAt === null && b.lastSyncedAt !== null) return false;
  return stableJson(withoutTimestamps(a)) === stableJson(withoutTimestamps(b));
}

/**
 * Drops the fields that move on their own, so what is left is what a person would want to see
 * in a diff: `head`, `status`, `stack.detected`, `capabilities` and everything else on `Repo`.
 *
 * `lastSyncedAt`, `updatedAt` and `stack.detectedAt` move on every inspection whether or not
 * anything was found. `vcs.dirty` and `vcs.currentBranch` are the same kind of observation:
 * `GitAdapter.info` derives `dirty` from `git status --porcelain`, which counts untracked
 * files, and the delivery loop switches branch as a matter of course — on Pomni's own clone
 * both flip constantly with the head unmoved, and rewriting the tracked yaml for them is the
 * write that gets the next `git checkout` refused. The price is that a record can carry a
 * stale `dirty`/`currentBranch` until something substantive changes; that is cheaper than a
 * repo whose state file cannot be checked out past.
 *
 * Everything else is compared rather than enumerated, so a field added to `Repo` later is
 * significant by default — the failure mode of forgetting a field here is a change that
 * silently never gets written.
 */
function withoutTimestamps(repo: Repo): unknown {
  const { lastSyncedAt: _lastSyncedAt, updatedAt: _updatedAt, stack, vcs, ...rest } = repo;
  const stable = {
    ...rest,
    vcs: vcs ? omit(vcs, ['dirty', 'currentBranch']) : vcs,
  };
  if (!stack) return { ...stable, stack };
  const { detectedAt: _detectedAt, ...detection } = stack;
  return { ...stable, stack: detection };
}

function omit<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Omit<T, K> {
  const rest = { ...value };
  for (const key of keys) delete rest[key];
  return rest;
}

/** Key order differs between a record parsed from disk and one built by spreading. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      : entry,
  );
}

function samePath(a: string, b: string): boolean {
  const normalize = (value: string) => value.replace(/[\\/]+$/, '').toLowerCase();
  return normalize(a) === normalize(b);
}

function sameRemote(a: string, b: string): boolean {
  const normalize = (value: string) =>
    value
      .trim()
      .replace(/\.git$/i, '')
      .replace(/\/+$/, '')
      .toLowerCase();
  return normalize(a) === normalize(b);
}

/**
 * The capability map with the given ceilings applied.
 *
 * A capability that gets a timeout becomes `manual`: re-detection replaces detected entries
 * wholesale (`mergeCapabilities`), and a ceiling somebody set on purpose must not vanish the
 * next time the stack is re-read. The price is that the command itself stops following
 * detection for that capability, which is the existing meaning of `manual` and is stated in
 * the CLI's help.
 */
function withTimeouts(repo: Repo, timeouts: Record<string, number | null>): Repo['capabilities'] {
  const capabilities = { ...repo.capabilities };
  for (const [name, timeoutMs] of Object.entries(timeouts)) {
    const existing = capabilities[name];
    if (!existing) {
      const declared = Object.keys(capabilities);
      throw new ValidationError(
        `'${repo.id}' declares no '${name}' capability${
          declared.length > 0 ? ` — it has ${declared.join(', ')}` : ''
        }`,
      );
    }
    if (timeoutMs !== null && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
      throw new ValidationError(`a timeout must be a positive number of milliseconds, got ${timeoutMs}`);
    }
    const { timeoutMs: _dropped, ...rest } = existing;
    capabilities[name] = {
      ...rest,
      ...(timeoutMs === null ? {} : { timeoutMs }),
      origin: 'manual',
    };
  }
  return capabilities;
}
