import type { GitSource, ProviderProbe } from '@pomni/core';

/**
 * Works out which forge is behind a git url when the hostname does not give it away.
 *
 * `github.com` and friends are obvious, but a self-hosted GitLab lives on whatever host its
 * owner chose — which is exactly the case where knowing the provider matters, because it
 * decides the username a token is sent with (`oauth2` for GitLab, not the default).
 *
 * Best effort by design: a short timeout, and any failure falls back to `generic`. Adding a
 * repo must not hang because a probe was slow.
 */
export class HttpProviderProbe implements ProviderProbe {
  constructor(private readonly timeoutMs = 5000) {}

  async probe(url: string): Promise<GitSource['provider']> {
    const origin = originOf(url);
    if (!origin) return 'generic';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(origin, {
        redirect: 'follow',
        signal: controller.signal,
        headers: { accept: 'text/html' },
      });

      const finalUrl = response.url.toLowerCase();
      // A sign-in redirect is often enough on its own.
      if (finalUrl.includes('/users/sign_in')) return 'gitlab';

      const body = (await response.text()).slice(0, 20_000).toLowerCase();
      return fingerprint(`${finalUrl}\n${body}`);
    } catch {
      // Unreachable, slow, or not HTTP at all — the caller carries on with `generic`.
      return 'generic';
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Never touches the network. Used in tests and where a probe is not wanted. */
export class NoProviderProbe implements ProviderProbe {
  async probe(): Promise<GitSource['provider']> {
    return 'generic';
  }
}

function fingerprint(text: string): GitSource['provider'] {
  if (text.includes('gitlab')) return 'gitlab';
  if (text.includes('bitbucket')) return 'bitbucket';
  if (text.includes('github')) return 'github';
  return 'generic';
}

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}
