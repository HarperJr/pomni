import type {
  ForgePort,
  MergeRequestRef,
  OpenMergeRequestInput,
} from '@pomni/core';

/**
 * Opens a merge request through GitLab's or GitHub's API.
 *
 * The url a person opens themselves stays the fallback everywhere, and is why nothing here
 * ever throws for a case it simply cannot handle: an ssh remote, a forge nobody wrote a client
 * for, a credential that grants git access but not API access. Each of those is answered with
 * null, and the caller offers the link instead. A run that produced working code must never
 * end badly because a merge request could not be opened for it.
 *
 * Only the two verbs this needs are implemented — find an open request for a branch, and
 * create one. A rerun of the same item is the common case, so finding comes first: a second
 * merge request for one branch is noise a reviewer has to reconcile.
 */
export class ForgeClient implements ForgePort {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async openMergeRequest(input: OpenMergeRequestInput): Promise<MergeRequestRef | null> {
    // No token means no API. Not a failure: a public repo still has a page a person can open.
    if (!input.auth?.secret) return null;

    const target = parseRemote(input.remote);
    if (!target) return null;

    if (input.provider === 'gitlab') return this.gitlab(input, target);
    if (input.provider === 'github') return this.github(input, target);
    return null;
  }

  // -------------------------------------------------------------------------

  private async gitlab(
    input: OpenMergeRequestInput,
    target: RemoteTarget,
  ): Promise<MergeRequestRef | null> {
    const base = `${target.origin}/api/v4/projects/${encodeURIComponent(target.path)}`;
    const headers = { 'PRIVATE-TOKEN': input.auth?.secret ?? '', 'Content-Type': 'application/json' };

    const existing = await this.json<Array<{ web_url: string; iid: number }>>(
      `${base}/merge_requests?state=opened&source_branch=${encodeURIComponent(input.sourceBranch)}`,
      { headers },
    );
    if (existing?.[0]) {
      return { url: existing[0].web_url, created: false, number: existing[0].iid };
    }

    // GitLab needs a target branch and will not infer one, so its own default is read first.
    const targetBranch =
      input.targetBranch ??
      (await this.json<{ default_branch: string }>(base, { headers }))?.default_branch ??
      null;
    if (!targetBranch) return null;

    const created = await this.json<{ web_url: string; iid: number }>(base + '/merge_requests', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        source_branch: input.sourceBranch,
        target_branch: targetBranch,
        title: input.title,
        description: input.description,
        remove_source_branch: true,
      }),
    });

    return created ? { url: created.web_url, created: true, number: created.iid } : null;
  }

  private async github(
    input: OpenMergeRequestInput,
    target: RemoteTarget,
  ): Promise<MergeRequestRef | null> {
    // github.com's API lives on a different host; an Enterprise install serves it under /api/v3.
    const api =
      target.origin === 'https://github.com'
        ? 'https://api.github.com'
        : `${target.origin}/api/v3`;
    const base = `${api}/repos/${target.path}`;
    const headers = {
      Authorization: `Bearer ${input.auth?.secret ?? ''}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'pomni',
    };

    const owner = target.path.split('/')[0] ?? '';
    const existing = await this.json<Array<{ html_url: string; number: number }>>(
      `${base}/pulls?state=open&head=${encodeURIComponent(`${owner}:${input.sourceBranch}`)}`,
      { headers },
    );
    if (existing?.[0]) {
      return { url: existing[0].html_url, created: false, number: existing[0].number };
    }

    const targetBranch =
      input.targetBranch ??
      (await this.json<{ default_branch: string }>(base, { headers }))?.default_branch ??
      null;
    if (!targetBranch) return null;

    const created = await this.json<{ html_url: string; number: number }>(`${base}/pulls`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        head: input.sourceBranch,
        base: targetBranch,
        title: input.title,
        body: input.description,
      }),
    });

    return created ? { url: created.html_url, created: true, number: created.number } : null;
  }

  /**
   * One request, decoded. Null for anything that is not a 2xx or is not JSON — the caller's
   * fallback is the same in every one of those cases, so distinguishing them would only make
   * the error path longer without making it more useful.
   */
  private async json<T>(url: string, init: RequestInit): Promise<T | null> {
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(FORGE_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      return (await response.json()) as T;
    } catch {
      return null;
    }
  }
}

const FORGE_TIMEOUT_MS = 20_000;

interface RemoteTarget {
  /** Scheme and host, no trailing slash. */
  origin: string;
  /** The project path: `group/subgroup/repo`, with no `.git`. */
  path: string;
}

/**
 * Split an http(s) remote into the host and the project path.
 *
 * Only http(s): an ssh remote carries no scheme the API can be reached on, and inventing one
 * would mean guessing at a port and a certificate. Those repos get the fallback link.
 */
function parseRemote(remote: string): RemoteTarget | null {
  if (!/^https?:\/\//i.test(remote)) return null;

  let parsed: URL;
  try {
    parsed = new URL(remote);
  } catch {
    return null;
  }

  const path = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!path.includes('/')) return null;

  // Credentials in the url are a second copy of the secret. Never carried into an API call.
  return { origin: `${parsed.protocol}//${parsed.host}`, path };
}
