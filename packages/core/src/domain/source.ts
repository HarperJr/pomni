import { z } from 'zod';
import { ValidationError } from './errors.js';

/**
 * Where a repo's code comes from.
 *
 * This union is the reason Pomni is not locked into either "link a folder" or "clone from
 * a remote". Everything downstream — capabilities, runs, gates, sessions — sees only a
 * resolved working directory and never asks which arm produced it. Adding `worktree`
 * (parallel agents on one repo) or `remote` (execution on another host) later is a new
 * arm plus a resolver, not a change to any consumer.
 */

export const LocalSourceSchema = z.object({
  kind: z.literal('local'),
  /** Absolute path to an existing checkout on this machine. */
  path: z.string().min(1),
});

export const GitSourceSchema = z.object({
  kind: z.literal('git'),
  url: z.string().min(1),
  /** Branch or tag to check out. Defaults to the remote's HEAD. */
  ref: z.string().optional(),
  /** Id of a credential in the credential store. Never a secret itself. */
  credential: z.string().optional(),
  provider: z.enum(['github', 'gitlab', 'bitbucket', 'generic']).default('generic'),
});

export const RepoSourceSchema = z.discriminatedUnion('kind', [LocalSourceSchema, GitSourceSchema]);

export type LocalSource = z.infer<typeof LocalSourceSchema>;
export type GitSource = z.infer<typeof GitSourceSchema>;
export type RepoSource = z.infer<typeof RepoSourceSchema>;

export function isGitSource(source: RepoSource): source is GitSource {
  return source.kind === 'git';
}

export function isLocalSource(source: RepoSource): source is LocalSource {
  return source.kind === 'local';
}

/** Human-readable one-liner for lists and logs. Never includes a secret. */
export function describeSource(source: RepoSource): string {
  if (source.kind === 'local') return source.path;
  return source.ref ? `${source.url} @ ${source.ref}` : source.url;
}

const SSH_URL = /^(?:[\w.-]+@)?[\w.-]+:[\w./~-]+$/;
const HTTP_URL = /^https?:\/\/[^\s]+$/i;

/**
 * Guess the provider so the UI can show the right icon and, later, so a `GitProvider`
 * adapter can offer repo listing and PR creation.
 */
export function detectProvider(url: string): GitSource['provider'] {
  const host = url.toLowerCase();
  if (host.includes('github.com')) return 'github';
  if (host.includes('gitlab.com') || host.includes('gitlab.')) return 'gitlab';
  if (host.includes('bitbucket.org')) return 'bitbucket';
  return 'generic';
}

export function isSshUrl(url: string): boolean {
  return url.startsWith('ssh://') || (SSH_URL.test(url) && !HTTP_URL.test(url));
}

export function normalizeGitUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) throw new ValidationError('git url is required');
  if (!HTTP_URL.test(trimmed) && !isSshUrl(trimmed)) {
    throw new ValidationError(
      `'${trimmed}' does not look like a git url — expected https://host/owner/repo(.git) or git@host:owner/repo(.git)`,
    );
  }
  return trimmed;
}

/**
 * Token auth only works over HTTPS. SSH urls authenticate with the user's agent/keys,
 * so attaching a credential to one is a mistake worth catching early.
 */
export function assertCredentialUsable(source: GitSource): void {
  if (source.credential && isSshUrl(source.url)) {
    throw new ValidationError(
      'a token credential cannot be used with an ssh url — use an https url, or drop the credential and rely on your ssh agent',
    );
  }
}
