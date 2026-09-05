import { z } from 'zod';

/**
 * Credential *metadata*. The secret itself never appears in this record and never lands
 * in `.pomni/credentials.yaml`, which is a git-tracked file. A repo references a
 * credential by id; resolving it to a token is the CredentialStore's job.
 */

export const SecretRefSchema = z.discriminatedUnion('kind', [
  /** Read from an environment variable at use time. Nothing is stored by Pomni. */
  z.object({ kind: z.literal('env'), var: z.string().min(1) }),
  /** Delegate to the GitHub CLI (`gh auth token`). No new secret to manage. */
  z.object({ kind: z.literal('gh-cli') }),
  /** Stored by Pomni in .pomni/credentials.secret.json (gitignored, 0600). */
  z.object({ kind: z.literal('file') }),
]);
export type SecretRef = z.infer<typeof SecretRefSchema>;

export const CredentialSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  provider: z.enum(['github', 'gitlab', 'bitbucket', 'generic']).default('generic'),
  /** Host this credential is valid for, e.g. github.com. Used to pick one automatically. */
  host: z.string().min(1),
  /**
   * Username sent with the token. For GitHub PATs literally any non-empty value works;
   * GitLab wants `oauth2`. Defaults are applied at creation.
   */
  username: z.string().min(1),
  secretRef: SecretRefSchema,
  createdAt: z.string(),
});

export type Credential = z.infer<typeof CredentialSchema>;

export const CredentialsFileSchema = z.object({
  version: z.literal(1).default(1),
  credentials: z.array(CredentialSchema).default([]),
});
export type CredentialsFile = z.infer<typeof CredentialsFileSchema>;

/**
 * Safe shape for API responses and logs: says whether a secret resolves and gives just
 * enough of it to tell two tokens apart, never enough to use one.
 */
export interface CredentialInfo extends Credential {
  hasSecret: boolean;
  /** Masked tail, e.g. `••••4f2a`. Null when there is no secret. */
  secretHint: string | null;
}

/**
 * The last four characters of a token, masked.
 *
 * This is the one place Pomni lets any part of a secret back out, and it is a deliberate
 * trade: without it you cannot tell which token is stored, so you re-paste one you already
 * had — or worse, rotate the wrong credential. Four characters identify; they do not
 * authenticate. Anything short enough that four characters would be a meaningful fraction
 * is masked entirely.
 */
export function secretHint(secret: string | null | undefined): string | null {
  if (!secret) return null;
  return secret.length < 12 ? '••••' : `••••${secret.slice(-4)}`;
}

export function defaultUsernameFor(provider: Credential['provider']): string {
  switch (provider) {
    case 'gitlab':
      return 'oauth2';
    case 'bitbucket':
      return 'x-token-auth';
    default:
      return 'pomni';
  }
}

export function hostFor(provider: Credential['provider']): string {
  switch (provider) {
    case 'github':
      return 'github.com';
    case 'gitlab':
      return 'gitlab.com';
    case 'bitbucket':
      return 'bitbucket.org';
    default:
      return '';
  }
}

/** Extract the host from an https git url so a credential can be matched to it. */
export function hostOfUrl(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    const match = /^(?:[\w.-]+@)?([\w.-]+):/.exec(url);
    return match?.[1]?.toLowerCase() ?? null;
  }
}
