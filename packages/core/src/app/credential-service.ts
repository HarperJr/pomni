import {
  CredentialSchema,
  CredentialsFileSchema,
  defaultUsernameFor,
  hostFor,
  hostOfUrl,
  secretHint,
  type Credential,
  type CredentialInfo,
  type SecretRef,
} from '../domain/credential.js';
import { ConflictError, CredentialError, NotFoundError, ValidationError } from '../domain/errors.js';
import { assertSlug, deriveId } from '../domain/ids.js';
import { layout } from '../domain/layout.js';
import type { Clock, CredentialStore, DocStore, GitAuth, GitPort } from '../ports/index.js';

export interface CreateCredentialInput {
  name: string;
  id?: string;
  provider?: Credential['provider'];
  host?: string;
  username?: string;
  secretRef: SecretRef;
  /** Only for `file` refs. Written to the gitignored secret file, never to credentials.yaml. */
  secret?: string;
}

/**
 * What may be changed after the fact. The id is not among them — repos reference a
 * credential by id, and renaming it would orphan them.
 */
export interface UpdateCredentialInput {
  name?: string;
  provider?: Credential['provider'];
  host?: string;
  username?: string;
  secretRef?: SecretRef;
  /** A replacement token. Only meaningful when the resulting ref is `file`. */
  secret?: string;
}

/**
 * Credentials are metadata plus a pointer. The token itself lives wherever the secret ref
 * says (an env var, the gh CLI, or a gitignored 0600 file) and is fetched at use time, so
 * `.pomni/credentials.yaml` stays safe to commit.
 */
export class CredentialService {
  constructor(
    private readonly docs: DocStore,
    private readonly store: CredentialStore,
    private readonly git: GitPort,
    private readonly clock: Clock,
  ) {}

  async list(): Promise<CredentialInfo[]> {
    const credentials = await this.readAll();
    return Promise.all(credentials.map((credential) => this.describe(credential)));
  }

  /** Metadata plus what may safely be said about the secret. Never the secret itself. */
  private async describe(credential: Credential): Promise<CredentialInfo> {
    const secret = await this.safeResolve(credential);
    return {
      ...credential,
      hasSecret: Boolean(secret),
      secretHint: secretHint(secret),
    };
  }

  async get(id: string): Promise<Credential> {
    const found = (await this.readAll()).find((credential) => credential.id === id);
    if (!found) throw new NotFoundError('credential', id);
    return found;
  }

  async create(input: CreateCredentialInput): Promise<CredentialInfo> {
    const name = input.name.trim();
    if (!name) throw new ValidationError('credential name is required');

    const id = input.id?.trim() || deriveId(name, 'cred');
    assertSlug(id, 'credential id');

    const credentials = await this.readAll();
    if (credentials.some((credential) => credential.id === id)) {
      throw new ConflictError(`credential '${id}' already exists`);
    }

    const provider = input.provider ?? 'generic';
    const host = (input.host?.trim() || hostFor(provider)).toLowerCase();
    if (!host) {
      throw new ValidationError('host is required for a generic credential (e.g. git.example.com)');
    }

    if (input.secretRef.kind === 'file') {
      if (!input.secret?.trim()) {
        throw new ValidationError('a token is required when storing the secret in Pomni');
      }
    } else if (input.secret) {
      throw new ValidationError(
        `a token was supplied but this credential reads from '${input.secretRef.kind}' — drop the token or switch to file storage`,
      );
    }

    const credential = CredentialSchema.parse({
      id,
      name,
      provider,
      host,
      username: input.username?.trim() || defaultUsernameFor(provider),
      secretRef: input.secretRef,
      createdAt: this.clock.iso(),
    });

    if (input.secretRef.kind === 'file' && input.secret) {
      await this.store.put(id, input.secret.trim());
    }

    await this.writeAll([...credentials, credential]);
    return this.describe(credential);
  }

  /**
   * Edit a credential in place — rotate a token, fix a host, switch where the secret comes
   * from. Repos keep pointing at it by id, so a rotation is invisible to them.
   */
  async update(id: string, patch: UpdateCredentialInput): Promise<CredentialInfo> {
    const credentials = await this.readAll();
    const index = credentials.findIndex((credential) => credential.id === id);
    if (index === -1) throw new NotFoundError('credential', id);

    const current = credentials[index] as Credential;
    const provider = patch.provider ?? current.provider;
    const secretRef = patch.secretRef ?? current.secretRef;

    // Switching provider without touching host or username is a common way to end up with
    // a credential that cannot possibly work — GitLab rejects GitHub's default username.
    // Carry the defaults across, but only where the user never overrode them.
    const host =
      patch.host?.trim() ??
      (provider !== current.provider && current.host === hostFor(current.provider) && hostFor(provider)
        ? hostFor(provider)
        : current.host);

    const username =
      patch.username?.trim() ??
      (provider !== current.provider && current.username === defaultUsernameFor(current.provider)
        ? defaultUsernameFor(provider)
        : current.username);

    if (!host) {
      throw new ValidationError('host is required (e.g. git.example.com)');
    }

    if (secretRef.kind === 'file') {
      if (patch.secret?.trim()) {
        await this.store.put(id, patch.secret.trim());
      } else if (current.secretRef.kind !== 'file') {
        throw new ValidationError(
          'a token is required when switching to storing the secret in Pomni',
        );
      }
    } else {
      if (patch.secret) {
        throw new ValidationError(
          `a token was supplied but this credential reads from '${secretRef.kind}' — drop the token or switch to file storage`,
        );
      }
      // Do not leave a stored secret behind for a credential that no longer reads one.
      if (current.secretRef.kind === 'file') await this.store.forget(id);
    }

    const next = CredentialSchema.parse({
      ...current,
      name: patch.name?.trim() || current.name,
      provider,
      host: host.toLowerCase(),
      username,
      secretRef,
    });

    credentials[index] = next;
    await this.writeAll(credentials);
    return this.describe(next);
  }

  async remove(id: string): Promise<void> {
    const credentials = await this.readAll();
    if (!credentials.some((credential) => credential.id === id)) {
      throw new NotFoundError('credential', id);
    }
    await this.store.forget(id);
    await this.writeAll(credentials.filter((credential) => credential.id !== id));
  }

  /** Resolve to git auth, or null when this credential has no usable secret. */
  async auth(id: string): Promise<GitAuth> {
    const credential = await this.get(id);
    const secret = await this.store.resolve(credential);
    if (!secret) {
      throw new CredentialError(
        `credential '${id}' has no secret — ${describeSecretSource(credential.secretRef)}`,
      );
    }
    return { username: credential.username, secret };
  }

  /**
   * Pick a credential for a url by host, so one stored token serves every repo on that
   * forge without being named each time.
   *
   * Port-tolerant on purpose: a self-hosted forge is reached as `host:3380`, but nobody
   * thinks to type the port when registering the credential, and silently not matching is
   * a miserable thing to debug. An exact match still wins, so a per-port credential is
   * possible when someone genuinely runs two forges on one host.
   */
  async findForUrl(url: string): Promise<Credential | null> {
    const host = hostOfUrl(url);
    if (!host) return null;

    const credentials = await this.readAll();
    const exact = credentials.find((credential) => credential.host === host);
    if (exact) return exact;

    const hostname = stripPort(host);
    return credentials.find((credential) => stripPort(credential.host) === hostname) ?? null;
  }

  /** Verify the secret resolves and, when a url is given, that the remote accepts it. */
  async test(id: string, url?: string): Promise<{ ok: boolean; message: string }> {
    let auth: GitAuth;
    try {
      auth = await this.auth(id);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }

    if (!url) return { ok: true, message: 'secret resolved' };

    try {
      await this.git.testRemote(url, auth);
      return { ok: true, message: 'remote accepted the credential' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  private async safeResolve(credential: Credential): Promise<string | null> {
    try {
      return await this.store.resolve(credential);
    } catch {
      return null;
    }
  }

  private async readAll(): Promise<Credential[]> {
    const ref = await this.docs.read(layout.credentials, CredentialsFileSchema);
    return ref?.data.credentials ?? [];
  }

  private async writeAll(credentials: Credential[]): Promise<void> {
    await this.docs.write(layout.credentials, { version: 1 as const, credentials });
  }
}

function stripPort(host: string): string {
  return host.replace(/:\d+$/, '');
}

function describeSecretSource(ref: SecretRef): string {
  switch (ref.kind) {
    case 'env':
      return `environment variable ${ref.var} is not set`;
    case 'gh-cli':
      return "run 'gh auth login' so the GitHub CLI can provide a token";
    case 'file':
      return 'the stored token is missing; add it again';
  }
}
