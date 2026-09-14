import { notifyBaseUrl, type PomniConfig } from '../domain/config.js';
import {
  notificationKey,
  notificationUrl,
  reasonLine,
  type NotificationEvent,
  type NotificationKind,
} from '../domain/notification.js';
import type { PipelineRun } from '../domain/pipeline.js';
import type { DesktopPort, EmittedEvent, EventBus, Logger, PipelineStore, PomniEvent } from '../ports/index.js';
import type { WebhookPort } from '../ports/notify.js';
import type { CredentialService } from './credential-service.js';
import type { WorkspaceService } from './workspace-service.js';

export interface NotificationServiceDeps {
  events: EventBus;
  store: PipelineStore;
  workspace: WorkspaceService;
  credentials: CredentialService;
  desktop: DesktopPort;
  webhook: WebhookPort;
  logger: Logger;
  /**
   * Whether this process hosts the subscribers. True (the default) is `serve` and the tests;
   * the CLI passes false, because a process that exits before a fire-and-forget send lands
   * has claimed the dedupe row for a notification nobody received. `sendTest` works either way.
   */
  hosted?: boolean;
}

/** The two channels a workspace can configure. */
export type NotificationChannel = 'desktop' | 'webhook';

/** What `pomni notify test` reports, one per configured channel. */
export interface TestResult {
  channel: NotificationChannel;
  ok: boolean;
  /** The failure, when there was one. Null on success. */
  error: string | null;
}

/**
 * Tells a person when a run needs one.
 *
 * A subscriber, not new plumbing: the three moments are already on the bus — an agent asked
 * (`pipeline.question.asked`), a run finished with a red gate (`pipeline.finished`), an item
 * landed as a merge request (`item.transitioned` into `in_review`). Each becomes one
 * `NotificationEvent` and is sent to every configured channel.
 *
 * Nothing here can fail the run or the transition that caused it. Every handler is
 * fire-and-forget and swallows its own errors into a warning; `idle()` exists so a test (or
 * a shutdown) can wait for the ones still in flight. The dedupe row is claimed before any
 * channel is tried, so a duplicate delivery is a missed notification rather than a repeated
 * one — the `PipelineStore.markNotified` contract.
 */
export class NotificationService {
  private readonly inFlight = new Set<Promise<void>>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly deps: NotificationServiceDeps) {
    if (deps.hosted ?? true) this.start();
  }

  /**
   * Subscribe to the bus, once. Returns the unsubscribe; `serve` holds it. Idempotent, so a
   * hosted service (already listening since construction) hands back the same subscription
   * rather than a second one — two subscribers would race for the dedupe row and log a
   * spurious duplicate for every event.
   */
  start(): () => void {
    if (!this.unsubscribe) {
      const off = this.deps.events.subscribe((event) => {
        this.track(this.handle(event));
      });
      this.unsubscribe = () => {
        off();
        this.unsubscribe = null;
      };
    }
    return this.unsubscribe;
  }

  /** Resolves once no handler is in flight. New events arriving meanwhile are waited for too. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }
  }

  /**
   * One sample to every configured channel, so setup can be checked without waiting for a
   * real red gate. Never deduped: a test is meant to be repeated.
   */
  async sendTest(projectId?: string | null): Promise<TestResult[]> {
    const config = await this.deps.workspace.config();
    const base = notifyBaseUrl(config);
    const event: NotificationEvent = {
      kind: 'test',
      projectId: projectId ?? '',
      runId: null,
      itemId: null,
      reason: 'This is a test notification from Pomni. If you can read this, the channel works.',
      url: projectId ? notificationUrl(base, projectId, null, null) : base.replace(/\/+$/, ''),
      ts: new Date().toISOString(),
      questionId: null,
      mergeRequestUrl: null,
    };

    const results: TestResult[] = [];
    for (const channel of configuredChannels(config)) {
      try {
        await this.send(channel, config, event);
        results.push({ channel, ok: true, error: null });
      } catch (error) {
        const message = errorMessage(error);
        this.warnFailed(channel, event.kind, message);
        results.push({ channel, ok: false, error: message });
      }
    }
    return results;
  }

  /**
   * Handle the event without letting it out — a subscriber that throws inside the bus is
   * exactly what "a notification must never fail the run" forbids. `handle` itself never
   * rejects; the `.catch` is the last line of defence against a bug in it.
   */
  private track(work: Promise<void>): void {
    const tracked = work
      .catch((error: unknown) => {
        this.deps.logger.warn('notification handler failed', { error: errorMessage(error) });
      })
      .finally(() => {
        this.inFlight.delete(tracked);
      });
    this.inFlight.add(tracked);
  }

  private async handle(event: PomniEvent & EmittedEvent): Promise<void> {
    try {
      switch (event.type) {
        case 'pipeline.question.asked':
          await this.onQuestion(event);
          return;
        case 'pipeline.finished':
          await this.onFinished(event);
          return;
        case 'item.transitioned':
          if (event.to === 'in_review') await this.onInReview(event);
          return;
        default:
          return;
      }
    } catch (error) {
      // A store or config lookup that threw. Not a channel failure, but the same rule holds:
      // nothing about telling a person may surface as a rejection on the event that did it.
      this.deps.logger.warn('notification failed', {
        channel: null,
        kind: kindOf(event),
        error: errorMessage(error),
      });
    }
  }

  private async onQuestion(
    event: Extract<PomniEvent, { type: 'pipeline.question.asked' }> & EmittedEvent,
  ): Promise<void> {
    const run = await this.deps.store.getRun(event.runId);
    if (!run) return;

    await this.notify(run, {
      kind: 'question',
      reason: reasonLine(firstLine(event.question)),
      questionId: event.questionId,
      mergeRequestUrl: null,
      ts: event.ts,
    });
  }

  private async onFinished(
    event: Extract<PomniEvent, { type: 'pipeline.finished' }> & EmittedEvent,
  ): Promise<void> {
    const run = await this.deps.store.getRun(event.runId);
    if (!run || run.gateStatus !== 'failed') return;

    await this.notify(run, {
      kind: 'gate_failed',
      reason: reasonLine(run.gateSummary ?? 'the gate failed and the run did not land'),
      questionId: null,
      mergeRequestUrl: null,
      ts: event.ts,
    });
  }

  private async onInReview(
    event: Extract<PomniEvent, { type: 'item.transitioned' }> & EmittedEvent,
  ): Promise<void> {
    // The run that landed it is the item's latest. A person moving the item by hand, with no
    // run behind it, is not a merge request waiting on anyone — nothing to say.
    const [run] = await this.deps.store.listRuns({
      projectId: event.projectId,
      itemId: event.itemId,
      limit: 1,
    });
    if (!run) return;

    // How `pipeline-service` records a landed MR: a `report` artifact named after the branch,
    // `path` the merge request url, `change: 'merge request'`.
    const artifacts = await this.deps.store.artifacts(run.id);
    const mergeRequest = artifacts.find(
      (artifact) => artifact.kind === 'report' && artifact.change === 'merge request' && artifact.path,
    );
    if (!mergeRequest?.path) return;

    const where = run.branch ?? mergeRequest.name;
    await this.notify(run, {
      kind: 'in_review',
      reason: reasonLine(`${where} landed as a merge request and is waiting for review`),
      questionId: null,
      mergeRequestUrl: mergeRequest.path,
      ts: event.ts,
    });
  }

  /**
   * Claim the dedupe row, then send to every configured channel. One failing channel does
   * not stop the other: a person with a dead webhook still gets the toast.
   */
  private async notify(
    run: PipelineRun,
    details: Pick<NotificationEvent, 'kind' | 'reason' | 'questionId' | 'mergeRequestUrl' | 'ts'>,
  ): Promise<void> {
    const config = await this.deps.workspace.config();
    const event: NotificationEvent = {
      ...details,
      projectId: run.projectId,
      runId: run.id,
      itemId: run.itemId,
      url: notificationUrl(notifyBaseUrl(config), run.projectId, run.id, run.itemId),
    };

    // Before any channel, and regardless of whether one is configured: a workspace that turns
    // a channel on later should not be told about everything that happened before it did.
    const claimed = await this.deps.store.markNotified(run.id, notificationKey(event), details.ts);
    if (!claimed) return;

    for (const channel of configuredChannels(config)) {
      try {
        await this.send(channel, config, event);
      } catch (error) {
        this.warnFailed(channel, event.kind, errorMessage(error));
      }
    }
  }

  private async send(
    channel: NotificationChannel,
    config: PomniConfig,
    event: NotificationEvent,
  ): Promise<void> {
    if (channel === 'desktop') {
      await this.deps.desktop.notify(titleOf(event), event.reason);
      return;
    }

    const url = config.notify.webhook.url;
    if (!url) return;
    const secret = await this.webhookSecret(config.notify.webhook.credential);
    await this.deps.webhook.post({ url, event, secret });
  }

  /**
   * The secret behind the configured credential, or null when none is configured. A credential
   * that is named but cannot be resolved is a failed send — the post would go unsigned to a
   * receiver that expects a signature, and a silent 401 is worse than a warning here.
   */
  private async webhookSecret(credentialId: string | null): Promise<string | null> {
    if (!credentialId) return null;
    const secret = await this.deps.credentials.secretFor(credentialId);
    if (!secret) {
      throw new Error(`webhook credential '${credentialId}' has no secret`);
    }
    return secret;
  }

  private warnFailed(channel: NotificationChannel, kind: NotificationKind, error: string): void {
    this.deps.logger.warn('notification failed', { channel, kind, error });
  }
}

function configuredChannels(config: PomniConfig): NotificationChannel[] {
  const channels: NotificationChannel[] = [];
  if (config.notify.desktop) channels.push('desktop');
  if (config.notify.webhook.url) channels.push('webhook');
  return channels;
}

/** What the toast says at the top. `<item>` is the item when there is one, else the run. */
function titleOf(event: NotificationEvent): string {
  const item = event.itemId ?? (event.runId ? `run ${event.runId}` : 'Pomni');
  switch (event.kind) {
    case 'question':
      return `Pomni: ${item} has a question`;
    case 'gate_failed':
      return `Pomni: ${item} gate went red`;
    case 'in_review':
      return `Pomni: ${item} is in review`;
    case 'test':
      return 'Pomni: test notification';
  }
}

/** The kind an event would have become, for a warning logged before it got that far. */
function kindOf(event: PomniEvent): NotificationKind | null {
  switch (event.type) {
    case 'pipeline.question.asked':
      return 'question';
    case 'pipeline.finished':
      return 'gate_failed';
    case 'item.transitioned':
      return 'in_review';
    default:
      return null;
  }
}

/** A question's first line is its gist; the rest is the options, which the link shows. */
function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
