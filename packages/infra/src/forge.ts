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
   * One request, decoded.
   *
   * The two answers are told apart on purpose. A forge that could not be reached, or that
   * answered something this client cannot use, is null — the caller falls back to the link and
   * there is nothing a person would act on. A forge that answered *and refused* throws, because
   * that refusal is actionable and silence about it is the worst outcome: the run looks as
   * though it never tried. A token with `write_repository` but not `api` pushes perfectly and
   * then fails here with 403, which is exactly the case that has to say so out loud.
   */
  private async json<T>(url: string, init: RequestInit): Promise<T | null> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(FORGE_TIMEOUT_MS),
      });
    } catch {
      // Unreachable host, TLS, timeout. The link works without any of them.
      return null;
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error(`the forge refused the token (${response.status}): ${await reason(response)}`);
    }
    if (response.status === 422) {
      throw new Error(`the forge would not open it (422): ${await reason(response)}`);
    }
    if (!response.ok) return null;

    try {
      return (await response.json()) as T;
    } catch {
      return null;
    }
  }
}

/** The forge's own words, when it gave any. Both GitLab and GitHub answer JSON here. */
async function reason(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as Record<string, unknown>;
    const detail =
      body.error_description ?? body.message ?? body.error ?? JSON.stringify(body).slice(0, 200);
    const scope = typeof body.scope === 'string' ? ` (scopes it wanted: ${body.scope})` : '';
    return `${String(detail)}${scope}`;
  } catch {
    return response.statusText || 'no detail';
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
