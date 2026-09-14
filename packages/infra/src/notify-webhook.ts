import { createHmac } from 'node:crypto';
import type { WebhookPort, WebhookRequest } from '@pomni/core';
import { WEBHOOK_BODY_VERSION } from '@pomni/core';

/**
 * One HTTP POST per notification, to wherever the workspace pointed its webhook.
 *
 * The signature is optional because the webhook secret is: a workspace that configured a url
 * but no credential gets an unsigned post, which is still useful for a private endpoint that
 * trusts its network rather than a header. No retries — a run that could not tell a person
 * once is `Notification`'s problem to log, not this client's to paper over with a delay nobody
 * is watching.
 */
export class WebhookClient implements WebhookPort {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async post(request: WebhookRequest): Promise<void> {
    // Serialised once: the signature is over these exact bytes, so a second `JSON.stringify`
    // call — even of the same object — must never be allowed to run and possibly disagree with
    // this one on key order.
    const body = JSON.stringify({ version: WEBHOOK_BODY_VERSION, ...request.event });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'pomni',
      'X-Pomni-Event': request.event.kind,
    };
    if (request.secret) {
      headers['X-Pomni-Signature'] = `sha256=${createHmac('sha256', request.secret).update(body).digest('hex')}`;
    }

    const response = await this.fetchImpl(request.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`webhook returned ${response.status} ${response.statusText}`);
    }
  }
}
