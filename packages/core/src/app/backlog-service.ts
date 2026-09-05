import { z } from 'zod';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import {
  BacklogItemSchema,
  SECTION_ACCEPTANCE,
  SECTION_PLAN,
  SECTION_PROBLEM,
  appendLog,
  assertTransition,
  compareItems,
  countAcceptance,
  newItemBody,
  nextOrder,
  parseSections,
  pickNext,
  type BacklogItem,
  type BacklogItemDetail,
  type Estimate,
  type ItemFilter,
  type ItemStatus,
  type ItemType,
  type Priority,
} from '../domain/item.js';
import { layout } from '../domain/layout.js';
import type { Clock, DocRef, DocStore, EventBus, Lock, RunStore } from '../ports/index.js';
import type { ProjectService } from './project-service.js';

export interface CreateItemInput {
  title: string;
  type?: ItemType;
  priority?: Priority;
  estimate?: Estimate;
  repos?: string[];
  labels?: string[];
  dependsOn?: string[];
  body?: string;
}

export interface UpdateItemInput {
  title?: string;
  type?: ItemType;
  priority?: Priority;
  estimate?: Estimate | null;
  repos?: string[];
  labels?: string[];
  dependsOn?: string[];
  branch?: string | null;
  body?: string;
  order?: number;
}

export interface TransitionOptions {
  reason?: string;
  /** Skip the guards. Recorded in the log, so a forced move is visible afterwards. */
  force?: boolean;
}

/**
 * The backlog.
 *
 * Items are Markdown files: the frontmatter is structure the engine enforces, the body is
 * prose that humans and agents both edit. Guards live here rather than in the surfaces, so
 * `/backlog move` from a Claude session and `pomni backlog move` from a terminal cannot
 * disagree about what a legal transition is.
 */
export class BacklogService {
  constructor(
    private readonly docs: DocStore,
    private readonly projects: ProjectService,
    private readonly runs: RunStore,
    private readonly lock: Lock,
    private readonly clock: Clock,
    private readonly events: EventBus,
  ) {}

  /**
   * Creating an item writes the item *and* bumps the project's counter, so it takes the
   * advisory lock — otherwise two processes can hand out the same id.
   */
  async create(projectId: string, input: CreateItemInput): Promise<BacklogItem> {
    const title = input.title.trim();
    if (!title) throw new ValidationError('an item needs a title');

    return this.lock.withLock('items', async () => {
      const project = await this.projects.getRef(projectId);
      await this.assertReposExist(projectId, input.repos ?? []);

      const id = `${project.data.itemPrefix}-${project.data.counters.nextItem}`;
      const existing = await this.list({ projectId });
      const now = this.clock.iso();

      const item = BacklogItemSchema.parse({
        id,
        projectId,
        title,
        type: input.type ?? 'feature',
        status: 'backlog',
        priority: input.priority ?? 'P2',
        estimate: input.estimate ?? null,
        repos: input.repos ?? [],
        labels: input.labels ?? [],
        dependsOn: input.dependsOn ?? [],
        order: nextOrder(existing.filter((other) => other.status === 'backlog')),
        createdAt: now,
        updatedAt: now,
        body: input.body ?? newItemBody(title),
      });

      await this.docs.ensureDir(layout.backlogDir(projectId));
      await this.docs.write(layout.backlogItem(projectId, id), item, { mustNotExist: true });
      await this.projects.bumpItemCounter(projectId);

      this.events.emit({ type: 'item.created', projectId, itemId: id });
      return item;
    });
  }

  async list(filter: ItemFilter): Promise<BacklogItem[]> {
    const projectIds = filter.projectId
      ? [filter.projectId]
      : await this.projects.listIds();

    const items: BacklogItem[] = [];
    for (const projectId of projectIds) {
      const files = await this.docs.list(layout.backlogDir(projectId));
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const ref = await this.readRef(projectId, file.replace(/\.md$/, ''));
        if (ref) items.push(ref.data);
      }
    }

    return items.filter((item) => matches(item, filter)).sort(compareItems);
  }

  async get(projectId: string, itemId: string): Promise<BacklogItemDetail> {
    const ref = await this.readRef(projectId, itemId);
    if (!ref) throw new NotFoundError('item', `${projectId}/${itemId}`);
    return this.detail(ref.data);
  }

  async getRef(projectId: string, itemId: string): Promise<DocRef<BacklogItem>> {
    const ref = await this.readRef(projectId, itemId);
    if (!ref) throw new NotFoundError('item', `${projectId}/${itemId}`);
    return ref;
  }

  async update(
    projectId: string,
    itemId: string,
    patch: UpdateItemInput,
    ifMatch?: string,
  ): Promise<BacklogItem> {
    const ref = await this.getRef(projectId, itemId);
    if (patch.repos) await this.assertReposExist(projectId, patch.repos);
    if (patch.dependsOn) await this.assertNoCycle(projectId, itemId, patch.dependsOn);

    const next = BacklogItemSchema.parse({
      ...ref.data,
      ...stripUndefined(patch),
      updatedAt: this.clock.iso(),
    });

    await this.docs.write(layout.backlogItem(projectId, itemId), next, {
      ifMatch: ifMatch ?? ref.rev,
    });
    this.events.emit({ type: 'item.changed', projectId, itemId });
    return next;
  }

  /**
   * Move an item. Guards are per-transition and explained in the error rather than being
   * silently coerced — a spec with no acceptance criteria is not "ready", and saying so is
   * more useful than pretending otherwise.
   */
  async transition(
    projectId: string,
    itemId: string,
    to: ItemStatus,
    options: TransitionOptions = {},
  ): Promise<BacklogItem> {
    const ref = await this.getRef(projectId, itemId);
    const item = ref.data;
    const from = item.status;

    if (from === to) return item;
    assertTransition(itemId, from, to);

    if (!options.force) await this.checkGuards(item, to);

    const now = this.clock.iso();
    const date = now.slice(0, 10);
    const note = options.reason ? `${describe(from, to)} — ${options.reason}` : describe(from, to);

    const next = BacklogItemSchema.parse({
      ...item,
      status: to,
      // Remember where we came from so unblocking can put it back.
      statusBefore: to === 'blocked' ? from : null,
      blockedReason: to === 'blocked' ? (options.reason ?? 'blocked') : null,
      updatedAt: now,
      body: appendLog(item.body, options.force ? `${note} (forced)` : note, date),
    });

    await this.docs.write(layout.backlogItem(projectId, itemId), next, { ifMatch: ref.rev });
    this.events.emit({ type: 'item.transitioned', projectId, itemId, from, to });
    return next;
  }

  async block(projectId: string, itemId: string, reason: string): Promise<BacklogItem> {
    if (!reason.trim()) throw new ValidationError('blocking an item needs a reason');
    return this.transition(projectId, itemId, 'blocked', { reason });
  }

  /** Restore whatever the item was doing before it was blocked. */
  async unblock(projectId: string, itemId: string): Promise<BacklogItem> {
    const { data } = await this.getRef(projectId, itemId);
    if (data.status !== 'blocked') {
      throw new ValidationError(`${itemId} is not blocked`);
    }
    return this.transition(projectId, itemId, data.statusBefore ?? 'backlog', {
      reason: 'unblocked',
      force: true,
    });
  }

  async remove(projectId: string, itemId: string): Promise<void> {
    await this.getRef(projectId, itemId);

    // Leaving a dangling dependency would silently un-block whatever pointed at it.
    const dependents = (await this.list({ projectId })).filter((item) =>
      item.dependsOn.includes(itemId),
    );
    if (dependents.length > 0) {
      throw new ConflictError(
        `${itemId} is a dependency of ${dependents.map((item) => item.id).join(', ')} — unlink it first`,
        { dependents: dependents.map((item) => item.id) },
      );
    }

    await this.docs.delete(layout.backlogItem(projectId, itemId));
    this.events.emit({ type: 'item.removed', projectId, itemId });
  }

  /** Reorder a board column. Takes the lock: it rewrites every item whose rank changed. */
  async reorder(projectId: string, status: ItemStatus, orderedIds: string[]): Promise<void> {
    await this.lock.withLock('items', async () => {
      for (const [index, itemId] of orderedIds.entries()) {
        const ref = await this.getRef(projectId, itemId);
        if (ref.data.status !== status) {
          throw new ValidationError(`${itemId} is not in the '${status}' column`);
        }

        const order = (index + 1) * 10;
        if (ref.data.order === order) continue;

        await this.docs.write(
          layout.backlogItem(projectId, itemId),
          BacklogItemSchema.parse({ ...ref.data, order, updatedAt: this.clock.iso() }),
          { ifMatch: ref.rev },
        );
      }
      this.events.emit({ type: 'item.changed', projectId, itemId: orderedIds[0] ?? '' });
    });
  }

  /** The highest-priority `ready` item, which is what `feature next` will pick up. */
  async next(projectId: string): Promise<BacklogItem | null> {
    return pickNext(await this.list({ projectId }));
  }

  // -------------------------------------------------------------------------

  private async detail(item: BacklogItem): Promise<BacklogItemDetail> {
    const siblings = await this.list({ projectId: item.projectId });
    const byId = new Map(siblings.map((other) => [other.id, other]));

    return {
      ...item,
      blockedBy: item.dependsOn.filter((id) => byId.get(id)?.status !== 'done'),
      blocking: siblings
        .filter((other) => other.dependsOn.includes(item.id))
        .map((other) => other.id),
      sections: parseSections(item.body),
      acceptance: countAcceptance(item.body),
    };
  }

  private async checkGuards(item: BacklogItem, to: ItemStatus): Promise<void> {
    const sections = parseSections(item.body);

    if (to === 'specced') {
      const problem = (sections[SECTION_PROBLEM] ?? '').replace(/_.*?_/gs, '').trim();
      if (!problem) {
        throw new ValidationError(
          `${item.id} has no '${SECTION_PROBLEM}' section yet — describe what is broken before marking it specced`,
        );
      }
      if (countAcceptance(item.body).total === 0) {
        throw new ValidationError(
          `${item.id} has no acceptance criteria — add at least one '- [ ] …' under '${SECTION_ACCEPTANCE}'`,
        );
      }
    }

    if (to === 'ready') {
      const plan = (sections[SECTION_PLAN] ?? '').replace(/_.*?_/gs, '').trim();
      if (!plan) {
        throw new ValidationError(
          `${item.id} has no '${SECTION_PLAN}' section yet — say how it will be built before marking it ready`,
        );
      }
    }

    if (to === 'in_progress') {
      const detail = await this.detail(item);
      if (detail.blockedBy.length > 0) {
        throw new ValidationError(
          `${item.id} depends on ${detail.blockedBy.join(', ')}, which ${
            detail.blockedBy.length === 1 ? 'is' : 'are'
          } not done`,
        );
      }
    }

    if (to === 'in_review') await this.assertGateGreen(item);
  }

  /**
   * The point of contact between the backlog and runs: an item only reaches review if the
   * project's gate has actually passed for the repos it touches. "Done because an agent
   * said so" is exactly what this prevents.
   */
  private async assertGateGreen(item: BacklogItem): Promise<void> {
    const project = (await this.projects.getRef(item.projectId)).data;
    if (!project.policy.requireGreenGate) return;

    const failures: string[] = [];
    for (const capability of project.gates.default) {
      const latest = await this.runs.latest(item.projectId, capability);
      const relevant = latest.filter(
        (run) => item.repos.length === 0 || item.repos.includes(run.repoId),
      );

      for (const run of relevant) {
        if (run.status !== 'passed') {
          failures.push(`${run.repoId} ${capability}: ${run.summary ?? run.status}`);
        }
      }
    }

    if (failures.length > 0) {
      throw new ValidationError(
        `${item.id} cannot go to review — the gate is not green:\n  ${failures.join('\n  ')}\n` +
          "Run 'pomni verify' first, or pass --force to record that you moved it anyway.",
      );
    }
  }

  private async assertReposExist(projectId: string, repoIds: string[]): Promise<void> {
    if (repoIds.length === 0) return;
    const known = new Set((await this.projects.get(projectId)).repos.map((repo) => repo.id));
    const unknown = repoIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new ValidationError(
        `unknown repo${unknown.length === 1 ? '' : 's'} in '${projectId}': ${unknown.join(', ')}`,
      );
    }
  }

  /** A dependency cycle would deadlock every item in it, so refuse to create one. */
  private async assertNoCycle(
    projectId: string,
    itemId: string,
    dependsOn: string[],
  ): Promise<void> {
    if (dependsOn.includes(itemId)) {
      throw new ValidationError(`${itemId} cannot depend on itself`);
    }

    const items = new Map((await this.list({ projectId })).map((item) => [item.id, item]));
    const missing = dependsOn.filter((id) => !items.has(id));
    if (missing.length > 0) {
      throw new ValidationError(`unknown item${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`);
    }

    const seen = new Set<string>();
    const walk = (id: string): boolean => {
      if (id === itemId) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return (items.get(id)?.dependsOn ?? []).some(walk);
    };

    const cycle = dependsOn.find(walk);
    if (cycle) {
      throw new ValidationError(`depending on ${cycle} would create a cycle`);
    }
  }

  private async readRef(projectId: string, itemId: string): Promise<DocRef<BacklogItem> | null> {
    return this.docs.read(
      layout.backlogItem(projectId, itemId),
      BacklogItemSchema as z.ZodType<BacklogItem>,
    );
  }
}

function matches(item: BacklogItem, filter: ItemFilter): boolean {
  if (filter.status) {
    const wanted = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (!wanted.includes(item.status)) return false;
  }
  if (filter.type && item.type !== filter.type) return false;
  if (filter.priority && item.priority !== filter.priority) return false;
  if (filter.label && !item.labels.includes(filter.label)) return false;
  if (filter.repo && !item.repos.includes(filter.repo)) return false;
  if (filter.query && !item.title.toLowerCase().includes(filter.query.toLowerCase())) return false;
  return true;
}

function describe(from: ItemStatus, to: ItemStatus): string {
  if (to === 'blocked') return 'blocked';
  if (from === 'blocked') return `unblocked to ${to}`;
  if (from === 'done' && to === 'in_progress') return 'reopened';
  return `${from} → ${to}`;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}
