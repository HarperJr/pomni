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
  describeUnmetList,
  evaluate,
  findState,
  isOffFlow,
  newItemBody,
  nextOrder,
  parseSections,
  pickNext,
  requirementsFor,
  targetsFrom,
  transitionOffers,
  type BacklogItem,
  type BacklogItemDetail,
  type ChecklistEntry,
  type Estimate,
  type Evidence,
  type Flow,
  type GateRunEvidence,
  type ItemFilter,
  type ItemStatus,
  type ItemType,
  type Priority,
  type TransitionOffer,
  type UnmetRequirement,
} from '../domain/item.js';
import { layout } from '../domain/layout.js';
import { flowOf, type Project } from '../domain/project.js';
import type { Repo } from '../domain/repo.js';
import { planWaves, type WavePlan } from '../domain/schedule.js';
import type { Clock, DocRef, DocStore, EventBus, Lock, RunStore } from '../ports/index.js';
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
    const ref = await this.getRef(projectId, itemId);
    const item = ref.data;
    const from = item.status;

    if (from === to) return item;

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
    const note = options.reason ? `${describe(from, to)} — ${options.reason}` : describe(from, to);
    // A forced move is only auditable if it records what it went past.
    const waivedNote =
      waived.length > 0 ? ` — unmet: ${describeUnmetList(waived).join('; ')}` : '';

    const next = BacklogItemSchema.parse({
      ...item,
      status: to,
      // Remember where we came from so unblocking can put it back.
      statusBefore: to === RESERVED_BLOCKED ? from : null,
      blockedReason: to === RESERVED_BLOCKED ? (options.reason ?? 'blocked') : null,
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
      return this.detail(next);
    });
  }

  async block(projectId: string, itemId: string, reason: string): Promise<BacklogItem> {
    if (!reason.trim()) throw new ValidationError('blocking an item needs a reason');
    return this.transition(projectId, itemId, RESERVED_BLOCKED, { reason });
  }

  /** Restore whatever the item was doing before it was blocked. */
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
    // standing off-flow has only recovery moves, which require nothing. Dependencies are
    // resolved unconditionally rather than per arrow: the sibling list is already read.
    const evidence = await this.evidence(item, project, gatesLeaving(flow, item.status), {
      total: item.dependsOn.length,
      unfinished: blockedBy,
    });

    return {
      ...item,
      allowedTransitions: transitionOffers(item, flow, evidence),
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

  /** `dependsOn` resolved against its siblings. One list read, so only taken when asked for. */
  private async dependencyEvidence(
    item: BacklogItem,
  ): Promise<{ total: number; unfinished: string[] }> {
    const byId = new Map(
      (await this.list({ projectId: item.projectId })).map((other) => [other.id, other]),
    );
    return {
      total: item.dependsOn.length,
      unfinished: item.dependsOn.filter((id) => byId.get(id)?.status !== 'done'),
    };
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
