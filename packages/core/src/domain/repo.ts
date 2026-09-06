import { z } from 'zod';
import { CapabilityMapSchema } from './capability.js';
import { RepoSourceSchema } from './source.js';

/**
 * A repo is one codebase inside a project. A fullstack project typically has several:
 * a web app, an api, maybe a mobile client and a shared library. Each carries its own
 * stack and its own commands — that is why capabilities live here and not on Project.
 */

/**
 * `auto`   — the default. A repo Pomni cloned gets a worktree per run; a repo the user linked
 *            does not, because it is the user's own tree and the user did not ask.
 * `always` — take a worktree even for a linked repo. `git worktree add` still never checks out,
 *            moves or cleans the user's tree; it writes one bookkeeping entry under their
 *            `.git/worktrees/`, which is exactly what this value is the consent for.
 * `never`  — never; runs share this repo's directory, and the scheduler treats two runs
 *            sharing it as a conflict.
 *
 * `always` is not a promise: a repo that cannot support worktrees at all — no commits, no git,
 * a git too old — still falls back to the shared directory rather than failing the run.
 */
export const WorktreePolicySchema = z.enum(['auto', 'always', 'never']);
export type WorktreePolicy = z.infer<typeof WorktreePolicySchema>;

export const RepoRoleSchema = z.enum([
  'web',
  'api',
  'mobile',
  'desktop',
  'lib',
  'infra',
  'docs',
  'other',
]);
export type RepoRole = z.infer<typeof RepoRoleSchema>;

/**
 * `linked`  — local source, directory present
 * `cloning` — git clone in flight
 * `ready`   — clone complete and usable
 * `error`   — last operation failed; see lastError
 * `missing` — the working directory has disappeared since it was added
 */
export const RepoStatusSchema = z.enum(['linked', 'cloning', 'ready', 'error', 'missing']);
export type RepoStatus = z.infer<typeof RepoStatusSchema>;

export const StackSchema = z.object({
  /** Which detector produced this. */
  adapter: z.string(),
  /** Human-readable markers: "next@15", "pnpm", "vitest". */
  detected: z.array(z.string()),
  detectedAt: z.string(),
});
export type Stack = z.infer<typeof StackSchema>;

export const VcsInfoSchema = z.object({
  isRepo: z.boolean(),
  currentBranch: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  remote: z.string().nullable(),
  head: z.string().nullable(),
  dirty: z.boolean(),
});
export type VcsInfo = z.infer<typeof VcsInfoSchema>;

export const RepoSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string().min(1),
  role: RepoRoleSchema.default('other'),
  source: RepoSourceSchema,
  status: RepoStatusSchema,
  stack: StackSchema.nullable().default(null),
  capabilities: CapabilityMapSchema.default({}),
  /** Default 'auto', so every repos/*.yaml written before this field keeps parsing untouched. */
  worktrees: WorktreePolicySchema.default('auto'),
  vcs: VcsInfoSchema.nullable().default(null),
  lastError: z.string().nullable().default(null),
  /** When the working copy was last fetched and re-detected. Null until the first sync. */
  lastSyncedAt: z.string().nullable().default(null),
  addedAt: z.string(),
  updatedAt: z.string(),
});

export type Repo = z.infer<typeof RepoSchema>;

/**
 * A repo plus the things that are true only at this moment on this machine.
 * Never persisted — `workingDir` is derived, and persisting it would rot.
 */
export interface ResolvedRepo extends Repo {
  workingDir: string;
  workingDirExists: boolean;
}

export function isBusy(repo: Repo): boolean {
  return repo.status === 'cloning';
}

export function isUsable(repo: Repo): boolean {
  return repo.status === 'linked' || repo.status === 'ready';
}
