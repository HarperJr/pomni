import type { NotificationEvent } from '../domain/notification.js';

export interface WebhookRequest {
  url: string;
  event: NotificationEvent;
  /** Null when the workspace has no webhook credential configured — the post goes unsigned. */
  secret: string | null;
}

/**
 * One HTTP POST per notification, to whatever the workspace pointed its webhook at.
 *
 * No retries: a run that could not tell a person once is not made more reliable by telling
 * them twice on a delay nobody is watching. `Notification.notify` already tolerates this
 * throwing — a webhook down is logged, never fails the run or the transition that caused it.
 */
export interface WebhookPort {
  post(request: WebhookRequest): Promise<void>;
}
