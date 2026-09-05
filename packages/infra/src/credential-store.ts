import { execFile } from 'node:child_process';
import { chmod } from 'node:fs/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  CredentialError,
  layout,
  type Credential,
  type CredentialStore,
  type DocStore,
} from '@pomni/core';

const execFileAsync = promisify(execFile);

const SecretFileSchema = z.object({
  version: z.literal(1).default(1),
  secrets: z.record(z.string()).default({}),
});

/**
 * Resolves a credential to a token at the moment it is needed.
 *
 * Three sources, in ascending order of how much Pomni has to be trusted with:
 *   `env`    — an environment variable; Pomni stores nothing at all
 *   `gh-cli` — delegate to `gh auth token`; reuses auth the user already has
 *   `file`   — a gitignored 0600 JSON file, for everything else
 */
export class DefaultCredentialStore implements CredentialStore {
  constructor(private readonly docs: DocStore) {}

  async resolve(credential: Credential): Promise<string | null> {
    switch (credential.secretRef.kind) {
      case 'env': {
        const value = process.env[credential.secretRef.var];
        return value && value.trim() ? value.trim() : null;
      }
      case 'gh-cli':
        return this.ghToken();
      case 'file': {
        const secrets = await this.readSecrets();
        return secrets[credential.id] ?? null;
      }
    }
  }

  async put(credentialId: string, secret: string): Promise<void> {
    const secrets = await this.readSecrets();
    await this.writeSecrets({ ...secrets, [credentialId]: secret });
  }

  async forget(credentialId: string): Promise<void> {
    const secrets = await this.readSecrets();
    if (!(credentialId in secrets)) return;
    const { [credentialId]: _removed, ...rest } = secrets;
    await this.writeSecrets(rest);
  }

  private async ghToken(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('gh', ['auth', 'token'], {
        timeout: 15_000,
        windowsHide: true,
      });
      const token = stdout.trim();
      return token.length > 0 ? token : null;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new CredentialError(
          'the GitHub CLI (gh) is not installed or not on PATH — install it, or use a token credential instead',
        );
      }
      return null;
    }
  }

  private async readSecrets(): Promise<Record<string, string>> {
    const ref = await this.docs.read(layout.secrets, SecretFileSchema);
    return ref?.data.secrets ?? {};
  }

  private async writeSecrets(secrets: Record<string, string>): Promise<void> {
    await this.docs.write(layout.secrets, { version: 1 as const, secrets });
    // Best effort: meaningless on Windows ACLs, but correct and cheap elsewhere.
    await chmod(this.docs.absolute(layout.secrets), 0o600).catch(() => undefined);
  }
}
