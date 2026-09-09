import { z } from 'zod';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import {
  ANY_REPO,
  BacklogItemSchema,
  RESERVED_BLOCKED,
  appendLog,
  assertTransition,
  checklistEntries,
  compareItems,
  countAcceptance,
  describeRequirement,
  describeUnmetList,
  eligible,
  evaluate,
  findState,
  hasRequirements,
  isOffFlow,
  newItemBody,
  nextAutoMove,
  nextOrder,
  parseSections,
  pickNext,
  requirementsFor,
  targetsFrom,
  transitionOffers,
  type BacklogItem,
  type BacklogItemDetail,
  type ChecklistEntry,
  type EligibleMove,
  type Estimate,
  type Evidence,
  type Flow,
  type GateRunEvidence,
  type ItemFilter,
  type ItemStatus,
  type ItemType,
  type Priority,
  type TransitionOffer,
  type TransitionRecord,
  type UnmetRequirement,
} from '../domain/item.js';
import { layout } from '../domain/layout.js';
import { flowOf, type Project } from '../domain/project.js';
import type { Repo } from '../domain/repo.js';
import { planWaves, type WavePlan } from '../domain/schedule.js';
import type { Clock, DocRef, DocStore, EventBus, Lock, Logger, RunStore } from '../ports/index.js';
import type { ProjectService } from './project-service.js';
import type { WorktreeService } from './worktree-service.js';

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
  /** Paths this item edits — what the wave planner reads before it falls back to the Plan. */
  touches?: string[];
  labels?: string[];
  dependsOn?: string[];
  branch?: string | null;
  body?: string;
  order?: number;
}

export interface TransitionOptions {
  /**
   * What the person making the move typed — "moving this back, the API half is not really
   * done". Stored on the move's {@link TransitionRecord} as `comment`, written into the Log
   * line beside it, and kept as `blockedReason` when the move is into `blocked`.
   */
  comment?: string;
  /**
   * The older name for {@link comment}, kept because every surface already passes it and the
   * two were always the same thing: one place to write why a move happened, not two. `comment`
   * wins when both are given.
   */
  reason?: string;
  /** Skip the guards. Recorded in the log, so a forced move is visible afterwards. */
  force?: boolean;
}

/**
 * One item that could move right now, with the moves it could make.
 *
 * The item is carried whole rather than as an id: every caller that lists these — `pomni
 * backlog list --eligible`, the board's "ready to move" badge — draws the item beside the
 * moves, and a second fetch per item to get its title is the shape this exists to avoid.
 */
export interface EligibleItem {
  item: BacklogItem;
  /** Never empty; an item with nothing outstanding to report is not returned at all. */
  moves: EligibleMove[];
}

/** The automatic move being performed, as {@link nextAutoMove} described it. */
interface AutoMove {
  to: ItemStatus;
  /**
   * The requirement that completed the arrow, straight from the domain's `lastSatisfied` —
   * never composed from whatever event happened to trigger the re-evaluation. The event and
   * the requirement are different facts, and only one of them is evidence.
   */
  because: TransitionRecord['because'];
}

/**
 * The backlog.
 *
 * Items are Markdown files: the frontmatter is structure the engine enforces, the body is
 * prose that humans and agents both edit. Guards live here rather than in the surfaces, so
 * `/backlog move` from a Claude session and `pomni backlog move` from a terminal cannot
 * disagree about what a legal transition is.
 *
 * Which moves exist and what they require is the project's `taskFlow`, evaluated in the
 * domain. This service's job in that split is to *prove* things, never to decide them: it
 * reads the run store, the item body and the item's frontmatter, hands the result over as
 * {@link Evidence}, and does what the evaluator says. Nothing here can assert that a gate
 * passed — it can only show what the run store reported.
 */
export class BacklogService {
  constructor(
    private readonly docs: DocStore,
    private readonly projects: ProjectService,
    private readonly runs: RunStore,
    private readonly lock: Lock,
    private readonly clock: Clock,
    private readonly events: EventBus,
    private readonly worktrees: WorktreeService,
    private readonly logger: Logger,
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

      const existing = await this.list({ projectId });
      const id = await this.issueId(projectId, project.data, existing);
      const now = this.clock.iso();
      // Where a new item starts is the flow's business, not a literal 'backlog'.
      const initial = flowOf(project.data).initial;

      const item = BacklogItemSchema.parse({
        id,
        projectId,
        title,
        type: input.type ?? 'feature',
        status: initial,
        priority: input.priority ?? 'P2',
        estimate: input.estimate ?? null,
        repos: input.repos ?? [],
        labels: input.labels ?? [],
        dependsOn: input.dependsOn ?? [],
        order: nextOrder(existing.filter((other) => other.status === initial)),
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

  /**
   * The id for a new item, and a refusal to reissue one that is already on disk.
   *
   * `counters.nextItem` is the intent, but `.pomni/` is a tracked directory in the repository
   * Pomni manages, so git rewrites it: a `checkout` of an older branch moves the counter
   * backwards, silently and consistently with the files beside it. The directory is then the
   * better witness of how far the numbering actually got, and the counter is caught up to it.
   *
   * This does not close the hole, and the item says so. When git removed the *files* too — the
   * way it did on the checkout that produced this guard — the directory has forgotten as well,
   * and nothing inside the repository remembers. Only state that lives outside the repository
   * could, which is the decision POMN-57 asks for and does not take here.
   */
  private async issueId(
    projectId: string,
    project: Project,
    existing: BacklogItem[],
  ): Promise<string> {
    const counter = project.counters.nextItem;
    const highest = existing.reduce((max, item) => {
      const [prefix, number] = item.id.split('-');
      if (prefix !== project.itemPrefix) return max;
      const parsed = Number(number);
      return Number.isInteger(parsed) && parsed > max ? parsed : max;
    }, 0);

    if (highest < counter) return `${project.itemPrefix}-${counter}`;

    // Catching up is one bump at a time, so `nextItem` stays the single writer of its own value
    // and nothing else has to know how it is stored.
    this.logger.warn(
      `${projectId}: the item counter said ${counter} but ${project.itemPrefix}-${highest} already` +
        ' exists — something rewrote .pomni/ underneath, most likely a branch switch. Numbering' +
        ` continues from ${highest + 1}; ids already issued are never reused.`,
    );
    for (let n = counter; n <= highest; n += 1) await this.projects.bumpItemCounter(projectId);
    return `${project.itemPrefix}-${highest + 1}`;
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
    // An edit is a trigger: this is where an acceptance criterion gets ticked, a required field
    // gets filled in and a Plan section gets written. The item as it now stands is returned, so
    // a caller that edited its way into an automatic move is told the item moved rather than
    // being handed the status it had a moment ago.
    return this.reevaluate(projectId, itemId);
  }

  /**
   * The flow this project runs on: its own `taskFlow`, or the built-in one when it declared
   * none. The single answer `pomni backlog flow`, the HTTP route and any UI drawing a board
   * read — nobody re-derives it.
   */
  async flow(projectId: string): Promise<Flow> {
    return flowOf((await this.projects.getRef(projectId)).data);
  }

  /**
   * Move an item.
   *
   * The one enforcement point: the CLI, HTTP, the web UI and the pipeline's own automatic
   * moves all arrive here, so none of them can hold a private copy of the rules. The arrow
   * and its requirements are decided by the project's flow in the domain; everything this
   * method does first is gather the evidence that decision is made on.
   */
  async transition(
    projectId: string,
    itemId: string,
    to: ItemStatus,
    options: TransitionOptions = {},
  ): Promise<BacklogItem> {
    return this.performTransition(projectId, itemId, to, options, null);
  }

  /**
   * The move itself. `auto` is what separates a person's drag from the system's own move, and
   * it is deliberately not on {@link TransitionOptions}: nothing outside this class can mark a
   * move automatic, because the only thing entitled to is {@link reevaluate}, which got the
   * move from `nextAutoMove`.
   *
   * Note what `auto` does *not* do. It picks the words in the log and the fields on the record;
   * it does not reach the guard below, which runs identically either way. There is one status
   * write in this service and this is it — an automatic move that could not pass
   * `assertTransition` throws exactly as a person's would.
   */
  private async performTransition(
    projectId: string,
    itemId: string,
    to: ItemStatus,
    options: TransitionOptions,
    auto: AutoMove | null,
  ): Promise<BacklogItem> {
    const ref = await this.getRef(projectId, itemId);
    const item = ref.data;
    const from = item.status;
    const comment = options.comment ?? options.reason;

    // Moving to the status you are already in is nothing — except into `blocked`, which is the
    // one state that carries a reason. A second run that fails for a new reason was silently
    // discarded here: POMN-54 went on showing "you've hit your session limit" from hours
    // earlier while the truth had become "the agents reported the work as partial", and its
    // log had no trace that a second run had happened at all. A stale reason is worse than no
    // reason, because it is read as current.
    if (from === to) {
      if (to !== RESERVED_BLOCKED || !comment || comment === item.blockedReason) {
        return item;
      }
      return this.reblock(projectId, ref, comment);
    }

    // Resolved per call, never cached across calls: the flow can be edited underneath us.
    const project = (await this.projects.getRef(projectId)).data;
    const flow = flowOf(project);

    // Only what this arrow asks about is worth proving. Expanding the rest would read the run
    // store and the sibling items for questions nobody asked.
    const requires = requirementsFor(flow, from, to);
    const evidence = await this.evidence(
      item,
      project,
      requires?.gate ? [requires.gate] : [],
      requires?.dependencies === true ? await this.dependencyEvidence(item) : null,
    );

    const check = evaluate({ id: itemId, status: from }, flow, to, evidence);
    let waived: UnmetRequirement[] = [];
    if (!check.ok) {
      // `--force` waives requirements — a human taking responsibility for work they say is
      // done — but never invents an arrow the flow does not have.
      if (options.force && check.reason === 'requirements') waived = check.unmet;
      else assertTransition(itemId, from, to, flow, evidence);
    }

    const now = this.clock.iso();
    const date = now.slice(0, 10);
    // The Log is one line of prose, so a comment with newlines in it is flattened for this
    // purpose only — the record below keeps what was typed, verbatim.
    const note = auto
      ? `${describe(from, to)}, automatic${
          auto.because ? ` — ${describeRequirement(auto.because)}` : ''
        }`
      : comment
        ? `${describe(from, to)} — ${oneLine(comment)}`
        : describe(from, to);
    // A forced move is only auditable if it records what it went past.
    const waivedNote =
      waived.length > 0 ? ` — unmet: ${describeUnmetList(waived).join('; ')}` : '';

    // Written alongside the Log line, never instead of it: the Log is what a person reads in a
    // diff, this is what a board reads to say "this one moved on its own". The three fields the
    // domain refuses to see together are kept apart by the branches, not by hope.
    const record: TransitionRecord = {
      at: now,
      from,
      to,
      mode: auto ? 'auto' : 'manual',
      comment: auto ? null : (comment ?? null),
      because: auto ? auto.because : null,
      forced: auto ? false : options.force === true,
    };

    const next = BacklogItemSchema.parse({
      ...item,
      status: to,
      // Remember where we came from so unblocking can put it back.
      statusBefore: to === RESERVED_BLOCKED ? from : null,
      blockedReason: to === RESERVED_BLOCKED ? (comment ?? 'blocked') : null,
      history: [...item.history, record],
      updatedAt: now,
      body: appendLog(
        item.body,
        options.force ? `${note} (forced)${waivedNote}` : note,
        date,
      ),
    });

    await this.docs.write(layout.backlogItem(projectId, itemId), next, { ifMatch: ref.rev });
    this.events.emit({ type: 'item.transitioned', projectId, itemId, from, to });
    return next;
  }

  /**
   * Re-evaluate one item and perform its automatic move, if it has one.
   *
   * The single re-evaluation path. Everything that could have changed the answer comes here —
   * {@link update} when the item is edited, {@link tickChecklist} when a box is ticked, and the
   * pipeline when an agent run or a gate run finishes — so an item advances the same way
   * whether the change arrived from the UI, the CLI or an agent.
   *
   * **Where the chain stops.** This method calls {@link nextAutoMove} exactly once and performs
   * at most `AUTO_MOVES_PER_EVENT` (one) move, and the move it performs goes through
   * {@link performTransition}, which does not call back here. There is no loop and no recursion
   * to bound — the bound is that the only caller of `performTransition` that re-evaluates is a
   * *trigger*, and a transition is not one. An item therefore advances at most one state per
   * triggering event, so a flow whose every arrow is `auto` walks one step and waits for the
   * next event, and a cycle of `auto` arrows cannot spin.
   *
   * Returns the item as it now stands: moved, or unchanged when nothing was automatic.
   */
  async reevaluate(projectId: string, itemId: string): Promise<BacklogItem> {
    const item = (await this.getRef(projectId, itemId)).data;
    const project = (await this.projects.getRef(projectId)).data;
    const flow = flowOf(project);

    const move = nextAutoMove(
      { id: item.id, status: item.status },
      flow,
      await this.evidenceFor(item, project, flow),
    );
    if (!move) return item;

    // Deliberately not `move.requires` or anything else the domain already decided: the arrow
    // is asked for by name and judged again from scratch below, on evidence read again. What
    // `nextAutoMove` bought is *which* arrow and *why* it completed, never permission.
    return this.performTransition(projectId, itemId, move.to, {}, {
      to: move.to,
      because: move.because?.requirement ?? null,
    });
  }

  /**
   * Items with a move they could make right now and nothing outstanding — what `pomni backlog
   * list --eligible` answers "what is waiting on me" with, and what the board reads to badge a
   * card "ready to move to X".
   *
   * A separate method rather than a flag on {@link list}: eligibility is not a property of the
   * stored item, it costs a run-store read per item to work out, and the answer a caller needs
   * is *which* moves — which does not fit in `BacklogItem[]`. `filter` is the same
   * {@link ItemFilter} `list` takes, so `--eligible` composes with `-s`, `--label` and the rest.
   *
   * Items are in board order and an `auto` move may appear: it means the move has not been
   * performed yet, because no event has re-evaluated the item since its requirements completed.
   */
  async eligibleItems(filter: ItemFilter): Promise<EligibleItem[]> {
    const items = await this.list(filter);
    const byProject = new Map<string, { project: Project; flow: Flow; siblings: BacklogItem[] }>();

    const found: EligibleItem[] = [];
    for (const item of items) {
      let context = byProject.get(item.projectId);
      if (!context) {
        const project = (await this.projects.getRef(item.projectId)).data;
        context = {
          project,
          flow: flowOf(project),
          // Read once per project rather than per item: `dependencyEvidence` resolves against
          // the whole backlog, and doing that per item is the backlog read squared.
          siblings: await this.list({ projectId: item.projectId }),
        };
        byProject.set(item.projectId, context);
      }

      // Nothing guarded leaves this state, so `eligible` would return [] — and finding that out
      // the slow way costs this item's gate a run-store read for an answer already known.
      if (!guardsLeaving(context.flow, item.status)) continue;

      const evidence = await this.evidenceFor(item, context.project, context.flow, context.siblings);
      const moves = eligible({ id: item.id, status: item.status }, context.flow, evidence);
      if (moves.length > 0) found.push({ item, moves });
    }

    return found;
  }

  /**
   * Tick or untick one definition-of-done box on an item.
   *
   * The key must be one the flow declares on a move out of where the item is standing —
   * ticking a box that guards nothing reachable is a typo, not a decision. Returns the full
   * detail so a UI can redraw its move buttons without a second fetch.
   */
  async tickChecklist(
    projectId: string,
    itemId: string,
    key: string,
    ticked: boolean,
  ): Promise<BacklogItemDetail> {
    return this.lock.withLock('items', async () => {
      const ref = await this.getRef(projectId, itemId);
      const item = ref.data;
      const flow = flowOf((await this.projects.getRef(projectId)).data);
      const from = item.status;

      const boxes = new Map<string, ChecklistEntry>();
      for (const to of targetsFrom(flow, from)) {
        for (const entry of checklistEntries(flow, from, to)) boxes.set(entry.key, entry);
      }

      if (!boxes.has(key)) {
        throw new ValidationError(
          boxes.size === 0
            ? `no move out of '${from}' has a checklist, so there is nothing to tick on ${itemId}`
            : `'${key}' is not a checklist box on any move out of '${from}' — valid keys: ${[
                ...boxes.keys(),
              ].join(', ')}`,
        );
      }

      const checklist = { ...item.checklist };
      const now = this.clock.iso();
      if (ticked) checklist[key] = now;
      else delete checklist[key];

      // A completed definition of done is a fact about the item, so it belongs in the Log
      // where the rest of its history is, not only in frontmatter.
      let body = item.body;
      for (const to of targetsFrom(flow, from)) {
        const entries = checklistEntries(flow, from, to);
        if (entries.length === 0) continue;
        const wasComplete = entries.every((entry) => entry.key in item.checklist);
        const isComplete = entries.every((entry) => entry.key in checklist);
        if (!wasComplete && isComplete) {
          body = appendLog(
            body,
            `checklist for ${from} → ${to} complete: ${entries
              .map((entry) => entry.label)
              .join(', ')}`,
            now.slice(0, 10),
          );
        }
      }

      const next = BacklogItemSchema.parse({ ...item, checklist, body, updatedAt: now });
      await this.docs.write(layout.backlogItem(projectId, itemId), next, { ifMatch: ref.rev });
      this.events.emit({ type: 'item.changed', projectId, itemId });
      // Ticking the last box of a definition of done is the event an `auto` arrow is most often
      // waiting on, so the detail returned is of the item *after* that move — a UI redrawing
      // from this response draws where the item actually is.
      return this.detail(await this.reevaluate(projectId, itemId));
    });
  }

  async block(projectId: string, itemId: string, reason: string): Promise<BacklogItem> {
    if (!reason.trim()) throw new ValidationError('blocking an item needs a reason');
    return this.transition(projectId, itemId, RESERVED_BLOCKED, { reason });
  }

  /** Restore whatever the item was doing before it was blocked. */
  /**
   * Record a new reason on an item that is already blocked.
   *
   * Deliberately not a transition: nothing moves, so no arrow is consulted and no requirement
   * is proved. `statusBefore` is left exactly as it was — it remembers where this item was
   * working before it first stopped, and overwriting it with `blocked` would make `unblock`
   * put the item back into `blocked`.
   */
  private async reblock(
    projectId: string,
    ref: DocRef<BacklogItem>,
    reason: string,
  ): Promise<BacklogItem> {
    const now = this.clock.iso();
    const next = BacklogItemSchema.parse({
      ...ref.data,
      blockedReason: reason,
      updatedAt: now,
      body: appendLog(ref.data.body, `still blocked — ${reason}`, now.slice(0, 10)),
    });

    await this.docs.write(layout.backlogItem(projectId, ref.data.id), next, { ifMatch: ref.rev });
    this.events.emit({ type: 'item.changed', projectId, itemId: ref.data.id });
    return next;
  }

  async unblock(projectId: string, itemId: string): Promise<BacklogItem> {
    const { data } = await this.getRef(projectId, itemId);
    if (data.status !== RESERVED_BLOCKED) {
      throw new ValidationError(`${itemId} is not blocked`);
    }
    // Nothing to restore means "back to the start", which is the flow's start, not 'backlog'.
    const fallback = (await this.flow(projectId)).initial;
    return this.transition(projectId, itemId, data.statusBefore ?? fallback, {
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

  /**
   * What {@link get}'s `allowedTransitions` would say if the item's body were `body`.
   *
   * The item page calls this as prose is typed, so someone filling in a placeholder Problem
   * watches the `spec` refusal go green without attempting the move and reading the error.
   * Placeholder detection stays in the domain — the surfaces ask, they do not re-implement.
   *
   * Read-only: nothing is written, no event is emitted, and the item's rev is untouched. Only
   * the body-derived evidence comes from the argument; gate runs, checklist, dependencies and
   * the title are the stored item's, so a preview differs from reality only where the typed
   * text does.
   */
  async previewTransitions(
    projectId: string,
    itemId: string,
    body: string,
  ): Promise<TransitionOffer[]> {
    const item = (await this.getRef(projectId, itemId)).data;
    const project = (await this.projects.getRef(projectId)).data;
    const flow = flowOf(project);

    const evidence = await this.evidence(
      item,
      project,
      gatesLeaving(flow, item.status),
      await this.dependencyEvidence(item),
      body,
    );

    return transitionOffers(item, flow, evidence);
  }

  /** The highest-priority `ready` item, which is what `feature next` will pick up. */
  async next(projectId: string): Promise<BacklogItem | null> {
    return pickNext(await this.list({ projectId }));
  }

  /**
   * The `ready` items grouped into waves that may be launched at the same time.
   *
   * Read-only like {@link next}: it gathers what the planner needs and decides nothing. Every
   * item goes in, not only the ready ones — a dependency only counts as satisfied when the item
   * it points at is `done`, and that is a fact about the items the plan will not launch.
   *
   * Launching the waves is not this method's business; the CLI starts the runs itself.
   */
  async waves(projectId: string): Promise<WavePlan> {
    const items = await this.list({ projectId });
    const repos = (await this.projects.get(projectId)).repos;

    // Asking whether a repo isolates runs costs git I/O per repo, so only the repos a ready
    // item is actually going to touch are asked about. An item naming no repos means the whole
    // project, which puts all of them in scope.
    const ready = items.filter((item) => item.status === 'ready');
    const named = new Set(ready.flatMap((item) => item.repos));
    const inScope = ready.some((item) => item.repos.length === 0)
      ? repos
      : repos.filter((repo) => named.has(repo.id));

    // Unreachable repos come back `false` rather than absent-and-throwing: one repo that is not
    // on this machine must not cost the whole project its plan.
    const repoIsolatesRuns = await this.worktrees.isolation(inScope);

    return planWaves({ items, repoIsolatesRuns });
  }

  // -------------------------------------------------------------------------

  private async detail(item: BacklogItem): Promise<BacklogItemDetail> {
    const siblings = await this.list({ projectId: item.projectId });
    const byId = new Map(siblings.map((other) => [other.id, other]));

    const project = (await this.projects.getRef(item.projectId)).data;
    const flow = flowOf(project);
    const blockedBy = item.dependsOn.filter((id) => byId.get(id)?.status !== 'done');
    // Every gate on a move out of here, so each button knows whether it would work. An item
    // standing off-flow has only recovery moves, which require nothing. The sibling list is
    // already read, so the dependency resolution comes off it rather than reading it again.
    const evidence = await this.evidenceFor(item, project, flow, siblings);

    return {
      ...item,
      allowedTransitions: transitionOffers(item, flow, evidence),
      // The same call, on the same evidence, that `reevaluate` filters for its automatic move —
      // so what the item page offers as "ready to move to X" and what the system would do
      // unasked are two readings of one answer.
      eligible: eligible({ id: item.id, status: item.status }, flow, evidence),
      flowState: findState(flow, item.status),
      offFlow: isOffFlow(flow, item.status),
      blockedBy,
      blocking: siblings
        .filter((other) => other.dependsOn.includes(item.id))
        .map((other) => other.id),
      sections: parseSections(item.body),
      acceptance: countAcceptance(item.body),
    };
  }

  // -------------------------------------------------------------------------
  // Evidence
  //
  // The service half of the split: read the world, hand the flow a value, do as it says.
  // -------------------------------------------------------------------------

  /**
   * Everything the evaluator is allowed to know about this item, with only the named gates
   * expanded — gathering evidence costs run-store reads, so nobody proves a gate nobody asked
   * about. `dependencies` is the same bargain one level up: resolving it costs a read of every
   * sibling item, so the caller passes what it has and `null` — refused, not read as a pass —
   * when the move being judged never asks.
   *
   * `body` overrides the item's stored prose, which is what {@link previewTransitions} judges
   * unsaved text with. Everything not parsed out of the body is unaffected, so a preview
   * differs from reality only where the typed text does.
   */
  private async evidence(
    item: BacklogItem,
    project: Project,
    gates: string[],
    dependencies: Evidence['dependencies'] = null,
    body: string = item.body,
  ): Promise<Evidence> {
    const runs: GateRunEvidence[] = [];
    if (gates.length > 0) {
      const repos = (await this.projects.get(project.id)).repos;
      for (const gate of gates) {
        runs.push(...(await this.gateEvidence(item, project, gate, repos)));
      }
    }

    return {
      acceptance: countAcceptance(body),
      // The title the `spec` requirement compares acceptance criteria against. Omitting it
      // reads as `''`, which no criterion echoes — the check would pass everything.
      title: item.title,
      checklist: item.checklist,
      // The item itself, so `fields: [estimate, repos, branch]` reads real fields rather than
      // a hand-maintained projection that would drift the moment a field is added.
      fields: { ...item, body } as Record<string, unknown>,
      gates: runs,
      // Verbatim: what counts as written is `sectionIsWritten`'s to say, and pre-trimming here
      // would let a fresh item's italic template prompt pass as prose.
      sections: parseSections(body),
      dependencies,
    };
  }

  /**
   * The evidence for every move out of where this item stands — what {@link detail},
   * {@link reevaluate} and {@link eligibleItems} all judge on, so the three cannot disagree
   * about what is true of an item at one moment.
   *
   * Dependencies are resolved unconditionally here rather than per arrow: all three callers ask
   * about every arrow out of the state, so at least one of them was going to need them. Pass
   * `siblings` when the backlog has already been read.
   */
  private async evidenceFor(
    item: BacklogItem,
    project: Project,
    flow: Flow,
    siblings?: BacklogItem[],
  ): Promise<Evidence> {
    return this.evidence(
      item,
      project,
      gatesLeaving(flow, item.status),
      siblings ? dependencyEvidence(item, siblings) : await this.dependencyEvidence(item),
    );
  }

  /** `dependsOn` resolved against its siblings. One list read, so only taken when asked for. */
  private async dependencyEvidence(
    item: BacklogItem,
  ): Promise<{ total: number; unfinished: string[] }> {
    return dependencyEvidence(item, await this.list({ projectId: item.projectId }));
  }

  /**
   * One gate, expanded into what the run store actually reported.
   *
   * There is no stored gate: a gate is a list of capabilities fanned out over the repos in
   * scope. An expected pair with no run gets `runId: null` so the domain can say "has not run"
   * rather than "failed" — the difference matters to whoever reads the refusal.
   */
  private async gateEvidence(
    item: BacklogItem,
    project: Project,
    gate: string,
    repos: Repo[],
  ): Promise<GateRunEvidence[]> {
    // The project has said it does not hold itself to its gates. The evaluator has to be
    // shown something — absence of evidence reads as "nobody ran it" — so it is shown the
    // decision, once, rather than the gate being expanded and quietly ignored.
    if (!project.policy.requireGreenGate) {
      return [
        { gate, repo: ANY_REPO, capability: ANY_REPO, passed: true, runId: null, finishedAt: null },
      ];
    }

    const capabilities = project.gates[gate] ?? [];
    const scoped =
      item.repos.length > 0 ? repos.filter((repo) => item.repos.includes(repo.id)) : repos;

    const evidence: GateRunEvidence[] = [];
    for (const capability of capabilities) {
      // A repo that does not declare the capability is skipped, not failed — an api repo with
      // no `e2e` must not block a gate the web repo satisfies.
      const declaring = scoped.filter((repo) => repo.capabilities[capability] !== undefined);
      if (declaring.length === 0) continue;

      const latest = new Map(
        (await this.runs.latest(project.id, capability)).map((run) => [run.repoId, run]),
      );
      for (const repo of declaring) {
        const run = latest.get(repo.id);
        evidence.push({
          gate,
          repo: repo.id,
          capability,
          passed: run?.status === 'passed',
          runId: run?.id ?? null,
          finishedAt: run?.endedAt ?? null,
        });
      }
    }

    if (evidence.length === 0) {
      // Nothing in scope to run it on is not the same as it having passed.
      evidence.push({
        gate,
        repo: ANY_REPO,
        capability: capabilities.join(', ') || gate,
        passed: false,
        runId: null,
        finishedAt: null,
      });
    }

    return evidence;
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

/** Every gate named on an arrow out of this state — the evidence a detail read needs. */
function gatesLeaving(flow: Flow, from: string): string[] {
  const gates = new Set<string>();
  for (const to of targetsFrom(flow, from)) {
    const gate = requirementsFor(flow, from, to)?.gate;
    if (gate) gates.add(gate);
  }
  return [...gates];
}

/** Whether any arrow out of this state guards anything — the cheap precondition for eligibility. */
function guardsLeaving(flow: Flow, from: string): boolean {
  return targetsFrom(flow, from).some((to) => {
    const requires = requirementsFor(flow, from, to);
    return requires !== null && hasRequirements(requires);
  });
}

/** `dependsOn` against a backlog already in hand. Done is done; everything else is unfinished. */
function dependencyEvidence(
  item: BacklogItem,
  siblings: BacklogItem[],
): { total: number; unfinished: string[] } {
  const byId = new Map(siblings.map((other) => [other.id, other]));
  return {
    total: item.dependsOn.length,
    unfinished: item.dependsOn.filter((id) => byId.get(id)?.status !== 'done'),
  };
}

/** A comment is free text with newlines in it; a Log entry is one dated line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function describe(from: ItemStatus, to: ItemStatus): string {
  if (to === RESERVED_BLOCKED) return 'blocked';
  if (from === RESERVED_BLOCKED) return `unblocked to ${to}`;
  if (from === 'done' && to === 'in_progress') return 'reopened';
  return `${from} → ${to}`;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}
