import { z } from 'zod';
import { SpecRequirementSchema, specGaps } from './spec-quality.js';
import type { SpecGap } from './spec-quality.js';

/**
 * A task flow: the states a backlog item may sit in, the arrows between them, and what must
 * be true before an arrow may be taken.
 *
 * The flow describes *what must be true*. It cannot look anything up — no runs, no files, no
 * clock. Everything it needs is handed to `evaluate` as {@link Evidence} that someone else
 * gathered. That is the whole point: nothing here can assert that a gate passed, it can only
 * be told what the run store reported, and report back what is still missing.
 *
 * A project that declares no flow gets {@link DEFAULT_FLOW}, which reproduces the hardcoded
 * state machine Pomni shipped with, arrow for arrow, with no requirements on any of them.
 */

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

/** State names travel through CLI arguments and URLs, so they are slugs. */
export const STATE_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * Names whose meaning is wired into the service layer. A flow need not declare them, but if
 * it does they keep their behaviour: entering `blocked` stashes `statusBefore` and records a
 * `blockedReason`; `unblock` restores that status; `cancelled` is a dead end you reopen from.
 * A flow cannot rename those behaviours onto other states.
 */
export const RESERVED_BLOCKED = 'blocked';
export const RESERVED_CANCELLED = 'cancelled';

export interface FlowState {
  name: string;
  /** Human label for buttons and columns. Derived from the name when not given. */
  label: string;
  /** Shown as a board column. `blocked` is not; `done` is. */
  board: boolean;
  /** Counts as live work for "active items" and "what should I pick up next". */
  active: boolean;
}

function defaultLabel(name: string): string {
  const words = name.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const FlowStateObjectSchema = z
  .object({
    name: z.string().regex(STATE_NAME, 'a state name must look like `in_review`'),
    label: z.string().min(1).optional(),
    board: z.boolean().default(true),
    active: z.boolean().default(true),
  })
  .strict();

/** `- ready` is shorthand for `- { name: ready, board: true, active: true }`. */
export const FlowStateSchema = z
  .union([z.string().regex(STATE_NAME, 'a state name must look like `in_review`'), FlowStateObjectSchema])
  .transform((value): FlowState =>
    typeof value === 'string'
      ? { name: value, label: defaultLabel(value), board: true, active: true }
      : { ...value, label: value.label ?? defaultLabel(value.name) },
  );

// ---------------------------------------------------------------------------
// Requirements
// ---------------------------------------------------------------------------

/**
 * One box in a definition of done. `key` is what is stored on the item when a human ticks
 * it; `label` is what they read. Writing the entry as a bare string derives the key from the
 * label — which means rewording the label unticks it. Write `{ key, label }` when you want to
 * reword without losing the ticks.
 */
export interface ChecklistEntry {
  key: string;
  label: string;
}

export function checklistKey(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'item'
  );
}

const ChecklistEntrySchema = z
  .union([
    z.string().min(1),
    z.object({ key: z.string().min(1), label: z.string().min(1) }).strict(),
  ])
  .transform((value): ChecklistEntry =>
    typeof value === 'string' ? { key: checklistKey(value), label: value } : value,
  );

/**
 * What must hold before an arrow may be taken. Every kind is optional and any combination is
 * legal; an arrow with none is a plain arrow.
 */
export const RequirementsSchema = z
  .object({
    /** Every checkbox under `## Acceptance criteria` is ticked, and there is at least one. */
    acceptance: z.boolean().default(false),
    /** The named project gate has passed for every repo this item touches. */
    gate: z.string().min(1).nullable().default(null),
    /** Boxes a human ticks on the item itself. */
    checklist: z.array(ChecklistEntrySchema).default([]),
    /** Item fields that must be non-empty, e.g. `estimate`, `repos`, `branch`. */
    fields: z.array(z.string().min(1)).default([]),
    /**
     * `## Heading` sections of the item body that must exist and have something written under
     * them, e.g. `[Problem, Plan]`. Emptiness is judged by {@link sectionIsWritten}: the
     * italic prompt `newItemBody` writes into a fresh item does not count as written.
     */
    sections: z.array(z.string().min(1)).default([]),
    /**
     * The item has actually been specified, not merely filled in. Where `sections` asks whether
     * a heading has text under it, this asks whether the text says anything: the template's
     * italic prompt, `TBD`, and an acceptance list whose only entry is the title said again all
     * fail it. Judged by {@link specGaps}; see `spec-quality.ts` for what counts as a
     * non-answer, and for why none of it is a length rule.
     *
     * `null` — the default, and what every project written before this key existed
     * deserialises to — means the arrow does not ask.
     */
    spec: SpecRequirementSchema.nullable().default(null),
    /** Every item this one `dependsOn` has finished. What "finished" means is the caller's. */
    dependencies: z.boolean().default(false),
  })
  .strict();

export type Requirements = z.infer<typeof RequirementsSchema>;

export const NO_REQUIREMENTS: Requirements = {
  acceptance: false,
  gate: null,
  checklist: [],
  fields: [],
  sections: [],
  spec: null,
  dependencies: false,
};

export function hasRequirements(requires: Requirements): boolean {
  return (
    requires.acceptance ||
    requires.gate !== null ||
    requires.checklist.length > 0 ||
    requires.fields.length > 0 ||
    requires.sections.length > 0 ||
    requires.spec !== null ||
    requires.dependencies
  );
}

/**
 * Whether a section counts as written.
 *
 * `newItemBody` seeds each section with an italic prompt — `_Why does this matter?_` — and a
 * body that still carries only the prompt has had nothing said in it. Stripping italic spans
 * before trimming is what the guard this replaces did, so a fresh item is still refused out of
 * the initial state until a human writes something.
 */
export function sectionIsWritten(text: string | undefined): boolean {
  return (text ?? '').replace(/_.*?_/gs, '').trim() !== '';
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

export const FlowTransitionSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    requires: RequirementsSchema.default({}),
    /**
     * The sentence a refusal on this arrow leads with, before the unmet requirements are
     * listed beneath it — "cannot go to review — the gate is not green". It replaces the
     * generic headline only; the per-requirement lines are still {@link describeUnmet}'s, so
     * a flow author cannot reword what a gate failure says, only why this particular arrow
     * matters. Omit it and the refusal reads "cannot move from 'x' to 'y' yet".
     */
    message: z.string().min(1).optional(),
  })
  .strict();

export type FlowTransition = z.infer<typeof FlowTransitionSchema>;

export interface Flow {
  states: FlowState[];
  /** Where a new item starts. Defaults to the first declared state. */
  initial: string;
  /**
   * Where an item may go when its stored status is not a state in this flow — because the
   * flow was edited under it, or the file was hand-written. Defaults to `[initial]`.
   */
  recover: string[];
  transitions: FlowTransition[];
}

/**
 * `.strict()` on every object here, deliberately. This is hand-edited YAML and a typo in a
 * requirement key is the one failure mode that is worse than a crash: `gates: land` under a
 * permissive schema is silently dropped, and the arrow it was supposed to guard opens. A
 * project that fails to load names the offending key and is fixed by editing one line; a
 * gate that quietly stopped being enforced is found much later, by whoever trusted it.
 */
export const FlowSchema = z
  .object({
    states: z.array(FlowStateSchema).min(1),
    initial: z.string().min(1).optional(),
    recover: z.array(z.string().min(1)).optional(),
    transitions: z.array(FlowTransitionSchema).default([]),
  })
  .strict()
  .transform((value): Flow => {
    const initial = value.initial ?? (value.states[0] as FlowState).name;
    return {
      states: value.states,
      initial,
      recover: value.recover ?? [initial],
      transitions: value.transitions,
    };
  })
  .superRefine((flow, ctx) => {
    const names = new Set<string>();
    for (const state of flow.states) {
      if (names.has(state.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['states'],
          message: `state '${state.name}' is declared twice`,
        });
      }
      names.add(state.name);
    }

    if (!names.has(flow.initial)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['initial'],
        message: `initial state '${flow.initial}' is not one of the declared states`,
      });
    }

    flow.recover.forEach((name, index) => {
      if (!names.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['recover', index],
          message: `'${name}' is not one of the declared states`,
        });
      }
    });

    const seen = new Set<string>();
    flow.transitions.forEach((transition, index) => {
      for (const [key, name] of [
        ['from', transition.from],
        ['to', transition.to],
      ] as const) {
        if (!names.has(name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['transitions', index, key],
            message: `'${name}' is not one of the declared states`,
          });
        }
      }

      if (transition.from === transition.to) {
        // Staying put is always allowed and never checked, so a self-arrow's requirements
        // would never run. Refuse it rather than pretend it guards something.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['transitions', index],
          message: `a transition from '${transition.from}' to itself does nothing`,
        });
      }

      const edge = `${transition.from}->${transition.to}`;
      if (seen.has(edge)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['transitions', index],
          message: `${edge} is declared twice — which set of requirements applies is ambiguous`,
        });
      }
      seen.add(edge);

      const keys = new Set<string>();
      transition.requires.checklist.forEach((entry, position) => {
        if (keys.has(entry.key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['transitions', index, 'requires', 'checklist', position],
            message: `checklist key '${entry.key}' is used twice on this transition`,
          });
        }
        keys.add(entry.key);
      });
    });
  });

// ---------------------------------------------------------------------------
// The built-in flow
// ---------------------------------------------------------------------------

function state(name: string, board: boolean, active: boolean): FlowState {
  return { name, label: defaultLabel(name), board, active };
}

function requiring(partial: Partial<Requirements>): Requirements {
  return { ...NO_REQUIREMENTS, ...partial };
}

/**
 * Section headings the built-in flow guards. Spelled out rather than imported from `item.ts`,
 * which imports this module — the same three literals live there as `SECTION_PROBLEM` and
 * friends, and the transition tests fail loudly if the two ever disagree.
 */
const BUILT_IN_SECTIONS = {
  problem: 'Problem',
  acceptance: 'Acceptance criteria',
  plan: 'Plan',
} as const;

/**
 * The guards the service used to run, keyed the way it keyed them: on where the item is
 * *going*, not on which arrow it took. `to === 'specced'` fired whether the item came from
 * `backlog` or from `blocked`, so every arrow into a guarded state carries the guard.
 */
const BUILT_IN_GUARDS: Record<string, { requires: Requirements; message?: string }> = {
  specced: {
    requires: requiring({ sections: [BUILT_IN_SECTIONS.problem, BUILT_IN_SECTIONS.acceptance] }),
  },
  /**
   * `ready` is where an item stops being thought about and starts being picked up, by a person
   * or by an agent — so it is the last moment a placeholder can be caught cheaply. Everything
   * before it is allowed to be unfinished; that is what `backlog` is for, and no arrow out of
   * `backlog` asks for a spec.
   *
   * The `specced` guard's weaker `sections` check is left as it was on purpose. It fires one
   * arrow earlier, where "there is text under this heading" is the right question, and it can
   * only ever refuse a subset of what this refuses — so the two never contradict.
   */
  ready: {
    requires: requiring({
      sections: [BUILT_IN_SECTIONS.plan],
      spec: { sections: [BUILT_IN_SECTIONS.problem, BUILT_IN_SECTIONS.acceptance], minCriteria: 1 },
    }),
  },
  in_progress: { requires: requiring({ dependencies: true }) },
  in_review: {
    requires: requiring({ gate: 'default' }),
    // The sentence this refusal has always led with. Kept here, on the arrow, rather than in
    // the service that used to compose it.
    message: 'cannot go to review — the gate is not green',
  },
};

function arrows(from: string, targets: string[]): FlowTransition[] {
  return targets.map((to) => {
    const guard = BUILT_IN_GUARDS[to];
    if (!guard) return { from, to, requires: NO_REQUIREMENTS };
    return guard.message === undefined
      ? { from, to, requires: guard.requires }
      : { from, to, requires: guard.requires, message: guard.message };
  });
}

/**
 * The state machine Pomni had before flows existed, written out — arrows *and* guards. A
 * project with no `taskFlow` runs on this, so its items behave as they did without a second
 * code path in the service asserting the same things in its own words.
 */
export const DEFAULT_FLOW: Flow = {
  states: [
    state('backlog', true, true),
    state('specced', true, true),
    state('ready', true, true),
    state('in_progress', true, true),
    state('in_review', true, true),
    state('done', true, false),
    state('blocked', false, true),
    state('cancelled', false, false),
  ],
  initial: 'backlog',
  recover: ['backlog'],
  transitions: [
    ...arrows('backlog', ['specced', 'ready', 'blocked', 'cancelled']),
    ...arrows('specced', ['ready', 'backlog', 'blocked', 'cancelled']),
    ...arrows('ready', ['in_progress', 'specced', 'backlog', 'blocked', 'cancelled']),
    ...arrows('in_progress', ['in_review', 'ready', 'blocked', 'cancelled']),
    ...arrows('in_review', ['done', 'in_progress', 'blocked', 'cancelled']),
    // Reopening is a real workflow, not an error.
    ...arrows('done', ['in_progress']),
    // Unblocking restores the previous status, so any active one is reachable.
    ...arrows('blocked', ['backlog', 'specced', 'ready', 'in_progress', 'in_review', 'cancelled']),
    ...arrows('cancelled', ['backlog']),
  ],
};

// ---------------------------------------------------------------------------
// Reading a flow
// ---------------------------------------------------------------------------

export function findState(flow: Flow, name: string): FlowState | null {
  return flow.states.find((candidate) => candidate.name === name) ?? null;
}

/** A status the flow does not declare. Such an item is readable, listed, and recoverable. */
export function isOffFlow(flow: Flow, status: string): boolean {
  return findState(flow, status) === null;
}

/** Label for a status, including one the flow no longer knows about. */
export function stateLabel(flow: Flow, status: string): string {
  return findState(flow, status)?.label ?? defaultLabel(status);
}

export function boardColumns(flow: Flow): string[] {
  return flow.states.filter((s) => s.board).map((s) => s.name);
}

export function activeStates(flow: Flow): string[] {
  return flow.states.filter((s) => s.active).map((s) => s.name);
}

/** Every state reachable from here, off-flow statuses included via `recover`. */
export function targetsFrom(flow: Flow, from: string): string[] {
  if (isOffFlow(flow, from)) return [...flow.recover];
  return flow.transitions.filter((t) => t.from === from).map((t) => t.to);
}

/** The requirements on one arrow, or null when there is no such arrow. */
export function requirementsFor(flow: Flow, from: string, to: string): Requirements | null {
  if (from === to) return NO_REQUIREMENTS;
  if (isOffFlow(flow, from)) return flow.recover.includes(to) ? NO_REQUIREMENTS : null;
  return flow.transitions.find((t) => t.from === from && t.to === to)?.requires ?? null;
}

/**
 * The headline this arrow wants a refusal to lead with, or null for the generic one. Only a
 * declared arrow can carry one: staying put and recovery moves are never refused.
 */
export function refusalMessage(flow: Flow, from: string, to: string): string | null {
  if (from === to || isOffFlow(flow, from)) return null;
  return flow.transitions.find((t) => t.from === from && t.to === to)?.message ?? null;
}

/** The definition-of-done boxes on one arrow, so a UI can render them before the move. */
export function checklistEntries(flow: Flow, from: string, to: string): ChecklistEntry[] {
  return requirementsFor(flow, from, to)?.checklist ?? [];
}

/** Every gate name this flow can ask about, so a caller knows what evidence to gather. */
export function gatesUsed(flow: Flow): string[] {
  const gates = new Set<string>();
  for (const transition of flow.transitions) {
    if (transition.requires.gate) gates.add(transition.requires.gate);
  }
  return [...gates];
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * One capability of one gate, on one repo, as the run store reported it. The service produces
 * one of these per (gate x in-scope repo x capability); a repo that has never run the
 * capability gets an entry with `runId: null`, which reads as pending rather than failed.
 */
export interface GateRunEvidence {
  gate: string;
  repo: string;
  capability: string;
  passed: boolean;
  runId: string | null;
  finishedAt: string | null;
}

/**
 * Everything the flow is allowed to know. The domain never gathers this — the service reads
 * the run store, the item body and the item's frontmatter and hands it in.
 */
export interface Evidence {
  /** From `countAcceptance(item.body)`. */
  acceptance: { total: number; checked: number };
  /**
   * `item.title`. Needed only by the `spec` requirement, which cannot otherwise tell an
   * acceptance criterion apart from the title typed a second time.
   */
  title: string;
  /** `item.checklist`: key -> ISO timestamp it was ticked. Presence is the tick. */
  checklist: Readonly<Record<string, string>>;
  /** Item field values, keyed by field name. Pass the item itself. */
  fields: Readonly<Record<string, unknown>>;
  gates: GateRunEvidence[];
  /** From `parseSections(item.body)`: heading -> the text under it, verbatim. */
  sections: Readonly<Record<string, string>>;
  /**
   * `dependsOn`, resolved. `null` means nobody resolved them — which is not the same as
   * "there are none", and is refused rather than read as a pass. Which statuses count as
   * finished is the caller's to decide; the domain is only shown the ids that do not.
   */
  dependencies: { total: number; unfinished: string[] } | null;
}

/** Fails every requirement, so an unevidenced move is refused rather than waved through. */
export const EMPTY_EVIDENCE: Evidence = {
  acceptance: { total: 0, checked: 0 },
  title: '',
  checklist: {},
  fields: {},
  gates: [],
  sections: {},
  dependencies: null,
};

/** `0` and `false` are answers; null, blank strings and empty collections are not. */
export function isFieldSet(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}

// ---------------------------------------------------------------------------
// The evaluator
// ---------------------------------------------------------------------------

export interface GateShortfall {
  repo: string;
  capability: string;
  runId: string | null;
  finishedAt: string | null;
}

/**
 * A requirement that is not satisfied, with the numbers and names needed to render it. No
 * English lives in here — a caller writes "3 of 7 acceptance criteria unticked" or
 * "gate `land` has not passed for nons-kmp" from these fields, in its own voice.
 */
export type UnmetRequirement =
  | { kind: 'acceptance'; total: number; checked: number; unchecked: number }
  | { kind: 'gate'; gate: string; failing: GateShortfall[]; pending: GateShortfall[] }
  | { kind: 'checklist'; total: number; ticked: number; missing: ChecklistEntry[] }
  | { kind: 'fields'; missing: string[] }
  | { kind: 'sections'; missing: string[] }
  /**
   * One absence in the spec, not all of them: the evaluator emits one of these per
   * {@link SpecGap}, so that a refusal reads as a list a person can fix one line at a time and
   * watch go green. Everything a sentence needs is inside `gap`.
   */
  | { kind: 'spec'; gap: SpecGap }
  // `unfinished` empty with `total` 0 is the unresolved case — nobody looked — not "none left".
  | { kind: 'dependencies'; total: number; unfinished: string[] };

/**
 * Why a move is or is not allowed. `no_arrow` and `unknown_state` are graph answers — the
 * move is not a thing you can ever do from here — and are a different answer from
 * `requirements`, which means the arrow exists and the work is not finished yet.
 */
export type TransitionCheck =
  | { ok: true; to: string; requires: Requirements }
  | { ok: false; reason: 'unknown_state'; which: 'from' | 'to'; state: string; to: string; allowed: string[] }
  // `from` is optional so that a hand-built check still type-checks; `evaluate` always sets
  // it, and `describeCheck` needs it to say "cannot move to done from in_review".
  | { ok: false; reason: 'no_arrow'; from?: string; to: string; allowed: string[] }
  | {
      ok: false;
      reason: 'requirements';
      to: string;
      requires: Requirements;
      unmet: UnmetRequirement[];
      /** The arrow's own headline for this refusal, when it declared one. */
      message?: string;
    };

/** All `evaluate` needs of an item. Takes the real item fine — it is structurally wider. */
export interface EvaluatedItem {
  id: string;
  status: string;
}

/** One button a UI may draw: where to, what it says, whether it works and why not. */
export interface TransitionOffer {
  to: string;
  label: string;
  ok: boolean;
  /** Empty when `ok`. */
  unmet: UnmetRequirement[];
  /** `recovery` means the item's current status is not in the flow and this is a way out. */
  via: 'arrow' | 'recovery';
}

function unmetFor(requires: Requirements, evidence: Evidence): UnmetRequirement[] {
  const unmet: UnmetRequirement[] = [];

  if (requires.acceptance) {
    const { total, checked } = evidence.acceptance;
    // total === 0 counts as unmet: a project that asked for acceptance criteria did not
    // mean "unless nobody wrote any".
    if (total === 0 || checked < total) {
      unmet.push({ kind: 'acceptance', total, checked, unchecked: total - checked });
    }
  }

  if (requires.gate !== null) {
    const gate = requires.gate;
    const runs = evidence.gates.filter((run) => run.gate === gate);
    const shortfall = (run: GateRunEvidence): GateShortfall => ({
      repo: run.repo,
      capability: run.capability,
      runId: run.runId,
      finishedAt: run.finishedAt,
    });
    const failing = runs.filter((run) => !run.passed && run.runId !== null).map(shortfall);
    const pending = runs.filter((run) => !run.passed && run.runId === null).map(shortfall);
    // No evidence at all is not a pass. It means nobody ran anything, or nobody looked.
    if (runs.length === 0 || failing.length > 0 || pending.length > 0) {
      unmet.push({ kind: 'gate', gate, failing, pending });
    }
  }

  if (requires.checklist.length > 0) {
    const missing = requires.checklist.filter((entry) => !(entry.key in evidence.checklist));
    if (missing.length > 0) {
      unmet.push({
        kind: 'checklist',
        total: requires.checklist.length,
        ticked: requires.checklist.length - missing.length,
        missing,
      });
    }
  }

  if (requires.fields.length > 0) {
    const missing = requires.fields.filter((field) => !isFieldSet(evidence.fields[field]));
    if (missing.length > 0) unmet.push({ kind: 'fields', missing });
  }

  // `spec` before `sections` on purpose. An arrow may declare both, and then the refusal is
  // read top to bottom by someone working down the page: Problem, then Acceptance criteria,
  // then whatever plain `sections` still asks for. `spec` names the sections that carry the
  // thinking, so its gaps lead; the blunter "no such section" line follows.
  if (requires.spec !== null) {
    const gaps = specGaps({ sections: evidence.sections, title: evidence.title }, requires.spec);
    for (const gap of gaps) unmet.push({ kind: 'spec', gap });
  }

  if (requires.sections.length > 0) {
    const missing = requires.sections.filter((name) => !sectionIsWritten(evidence.sections[name]));
    if (missing.length > 0) unmet.push({ kind: 'sections', missing });
  }

  if (requires.dependencies) {
    const resolved = evidence.dependencies;
    // Unresolved reads as unmet with nothing to name, which is what `describeUnmet` says.
    if (resolved === null) unmet.push({ kind: 'dependencies', total: 0, unfinished: [] });
    else if (resolved.unfinished.length > 0) {
      unmet.push({ kind: 'dependencies', total: resolved.total, unfinished: resolved.unfinished });
    }
  }

  return unmet;
}

/**
 * The whole decision, as a value. Throws nothing, reads nothing, decides everything from the
 * flow and the evidence it was handed.
 */
export function evaluate(
  item: EvaluatedItem,
  flow: Flow,
  to: string,
  evidence: Evidence = EMPTY_EVIDENCE,
): TransitionCheck {
  const from = item.status;
  if (from === to) return { ok: true, to, requires: NO_REQUIREMENTS };

  if (isOffFlow(flow, from)) {
    // The item is standing somewhere the flow does not know about. It is not stuck: it may
    // step onto the flow at a recovery state, and no arrow's requirements apply because no
    // arrow was crossed.
    if (flow.recover.includes(to)) return { ok: true, to, requires: NO_REQUIREMENTS };
    return { ok: false, reason: 'unknown_state', which: 'from', state: from, to, allowed: [...flow.recover] };
  }

  if (isOffFlow(flow, to)) {
    return { ok: false, reason: 'unknown_state', which: 'to', state: to, to, allowed: targetsFrom(flow, from) };
  }

  const requires = requirementsFor(flow, from, to);
  if (requires === null) {
    return { ok: false, reason: 'no_arrow', from, to, allowed: targetsFrom(flow, from) };
  }

  const unmet = unmetFor(requires, evidence);
  if (unmet.length > 0) {
    const message = refusalMessage(flow, from, to);
    return message === null
      ? { ok: false, reason: 'requirements', to, requires, unmet }
      : { ok: false, reason: 'requirements', to, requires, unmet, message };
  }

  return { ok: true, to, requires };
}

/**
 * Every move a UI should draw for this item, in flow order, each carrying why it is disabled.
 * The one source both the board and the CLI read, so they cannot disagree.
 */
export function transitionOffers(
  item: EvaluatedItem,
  flow: Flow,
  evidence: Evidence = EMPTY_EVIDENCE,
): TransitionOffer[] {
  const offFlow = isOffFlow(flow, item.status);
  return targetsFrom(flow, item.status).map((to): TransitionOffer => {
    const check = evaluate(item, flow, to, evidence);
    return {
      to,
      label: stateLabel(flow, to),
      ok: check.ok,
      unmet: !check.ok && check.reason === 'requirements' ? check.unmet : [],
      via: offFlow ? 'recovery' : 'arrow',
    };
  });
}

// ---------------------------------------------------------------------------
// English
// ---------------------------------------------------------------------------

/**
 * The one place a refusal is put into words. The CLI, the HTTP error body and the item page
 * all print the same sentence because they all call these — an `UnmetRequirement` carries no
 * English precisely so that there is exactly one function that invents it.
 *
 * Pure, like everything else here: no `Intl`, no locale, no colour, no punctuation at the end
 * and no leading bullet. A caller adds its own bullets, its own colour and its own full stop.
 */

/**
 * The repo name on the single synthetic pending entry a service emits when a gate is required
 * but nothing is in scope to run it on. Not a real repo — never match it against a repo id.
 */
export const ANY_REPO = '*';

function commaList(values: string[]): string {
  return values.join(', ');
}

/** `a`, `a and b`, `a, b and c`. */
function andList(values: string[]): string {
  if (values.length <= 1) return values.join('');
  return `${values.slice(0, -1).join(', ')} and ${values.at(-1) ?? ''}`;
}

function gateTargets(entries: GateShortfall[]): string {
  return commaList(entries.map((entry) => `${entry.repo} (${entry.capability})`));
}

function allowsClause(allowed: string[]): string {
  return allowed.length === 0
    ? `this project's flow allows no moves from here`
    : `this project's flow allows: ${commaList(allowed)}`;
}

/**
 * One spec gap, named. "spec incomplete" is not an acceptable sentence here: the whole value of
 * this requirement is that it says *which* paragraph is a placeholder and *why* an acceptance
 * list of one does not count, so the person reading it can go and fix that thing.
 *
 * The section name is printed bare, not quoted, because it is a heading in a document the
 * reader is looking at — "Problem is still the template placeholder" is how they would say it.
 */
function describeSpecGap(gap: SpecGap): string {
  switch (gap.reason) {
    case 'missing':
      return `${gap.section} is missing from the item body`;

    case 'empty':
      return `${gap.section} is empty`;

    case 'placeholder':
      return `${gap.section} is still the template placeholder`;

    case 'criteria': {
      if (gap.found === 0) return `${gap.section} lists no criteria`;

      const count = gap.found === 1 ? 'one entry' : `${gap.found} entries`;
      if (gap.usable === 0) {
        // Every entry was thrown out. Say which of the two ways, when they were all the same
        // way — a mixed list gets the sentence that covers both.
        if (gap.placeholders === 0) {
          return gap.found === 1
            ? `${gap.section} has one entry and it repeats the title`
            : `${gap.section} has ${count} and every one repeats the title`;
        }
        if (gap.echoesTitle === 0) {
          return gap.found === 1
            ? `${gap.section} has one entry and it is still a placeholder`
            : `${gap.section} has ${count} and every one is still a placeholder`;
        }
        return `${gap.section} has ${count} and none of them says anything the title does not`;
      }

      return `${gap.section} has ${gap.usable === 1 ? 'one criterion' : `${gap.usable} criteria`} that ${gap.usable === 1 ? 'says' : 'say'} something the title does not, and needs ${gap.needed}`;
    }
  }
}

/** One unmet requirement as one line of English. */
export function describeUnmet(unmet: UnmetRequirement): string {
  switch (unmet.kind) {
    case 'acceptance': {
      if (unmet.total === 0) return 'no acceptance criteria are written in the item body';
      const noun = unmet.unchecked === 1 ? 'criterion' : 'criteria';
      return `${unmet.unchecked} of ${unmet.total} acceptance ${noun} unticked`;
    }

    case 'gate': {
      // The synthetic "nothing in scope" entry is not a repo, so it must not be printed as
      // one: `has not run for * (test)` would read as a repo literally named `*`.
      const pending = unmet.pending.filter((entry) => entry.repo !== ANY_REPO);
      if (unmet.failing.length === 0 && pending.length === 0) {
        return `gate \`${unmet.gate}\` has not run for any repo this item touches`;
      }
      const clauses: string[] = [];
      if (unmet.failing.length > 0) {
        clauses.push(`gate \`${unmet.gate}\` has not passed for ${gateTargets(unmet.failing)}`);
      }
      if (pending.length > 0) {
        clauses.push(`gate \`${unmet.gate}\` has not run for ${gateTargets(pending)}`);
      }
      return clauses.join('; ');
    }

    case 'checklist': {
      const unticked = unmet.total - unmet.ticked;
      const labels = commaList(unmet.missing.map((entry) => entry.label));
      return `${unticked} of ${unmet.total} checklist items unticked: ${labels}`;
    }

    case 'fields': {
      if (unmet.missing.length === 0) return 'a required field is empty';
      const verb = unmet.missing.length === 1 ? 'is' : 'are';
      return `${andList(unmet.missing)} ${verb} empty`;
    }

    case 'sections': {
      if (unmet.missing.length === 0) return 'a required section is missing from the item body';
      const names = andList(unmet.missing.map((name) => `'${name}'`));
      const noun = unmet.missing.length === 1 ? 'section is' : 'sections are';
      return `no ${names} ${noun} written in the item body`;
    }

    case 'spec':
      return describeSpecGap(unmet.gap);

    case 'dependencies': {
      // Nothing to name means nobody resolved them, not that none are left.
      if (unmet.unfinished.length === 0) return 'the dependencies of this item have not been checked';
      const verb = unmet.unfinished.length === 1 ? 'is' : 'are';
      return `depends on ${commaList(unmet.unfinished)}, which ${verb} not done`;
    }
  }
}

/** Exported so nobody re-maps it wrongly: the lines, in the order the evaluator found them. */
export function describeUnmetList(unmet: UnmetRequirement[]): string[] {
  return unmet.map(describeUnmet);
}

/**
 * The whole refusal as one sentence, for a place that has room for exactly one — an HTTP
 * error `message`, a toast, a thrown Error. `null` when the move is allowed. A surface with
 * room for a list should call {@link describeUnmetList} instead and print the lines.
 */
export function describeCheck(check: TransitionCheck): string | null {
  if (check.ok) return null;

  switch (check.reason) {
    case 'unknown_state':
      return `${check.state} is not a state in this project's flow (the ${check.which} of this move) — ${allowsClause(
        check.allowed,
      )}`;

    case 'no_arrow': {
      const from = check.from === undefined ? '' : ` from ${check.from}`;
      return `cannot move to ${check.to}${from} — ${allowsClause(check.allowed)}`;
    }

    case 'requirements': {
      const lines = describeUnmetList(check.unmet);
      if (lines.length === 0) return check.message ?? 'the requirements for this move are not met';
      return check.message === undefined ? lines.join('; ') : `${check.message}: ${lines.join('; ')}`;
    }
  }
}
