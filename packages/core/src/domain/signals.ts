import type { PipelineRun, PipelineStep } from './pipeline.js';

/**
 * What a run says went wrong, as data instead of prose.
 *
 * Derived rather than recorded. Everything here is already written down — a step's outcome,
 * its unmet list, the run's error, what it cost — and deriving keeps one copy of each fact
 * instead of two that can disagree. The cost is that a signal's definition changes under
 * history when this file changes; that is the right trade for a report, and the wrong one for
 * anything a decision is billed against.
 */

export const SIGNAL_KINDS = [
  'partial',
  'blocked',
  'unmet',
  'refusal',
  'no-output',
  'session-cap',
  'budget-stop',
  'expensive',
  'prompt-heavy',
] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export interface Signal {
  kind: SignalKind;
  runId: string;
  /** The agent it is about. Null for a signal about the run rather than any one agent. */
  agentId: string | null;
  agentName: string | null;
  /** One sentence a person reads. The evidence, not the conclusion. */
  detail: string;
}

/**
 * Phrases an agent uses when it did not do the job and is explaining why.
 *
 * Deliberately narrow. A wide list catches an agent *describing* a limitation in code it
 * reviewed and reports it as a refusal, which teaches the reader to ignore the signal — and a
 * signal people ignore is worse than one that does not exist.
 */
const REFUSALS = [
  'i have no shell',
  'i cannot run',
  'i was not able to run',
  'no round left',
  'i had no round',
  'i did not delegate',
  'i could not verify',
];

/** A step that cost more than this share of its run is worth naming on its own. */
const EXPENSIVE_SHARE = 0.4;

/** Scaffolding larger than the agent's own prompt, measured on the turn that was sent. */
function promptHeavy(step: PipelineStep): boolean {
  const { agent, ...frame } = step.promptParts;
  if (agent === 0) return false;
  return Object.values(frame).reduce((sum, part) => sum + part, 0) > agent;
}

/**
 * Every signal one run raises.
 *
 * Ordered by how much a reader should care, not by when it happened: an agent that said the
 * work was not done outranks one that merely cost a lot.
 */
export function signalsFor(run: PipelineRun, steps: PipelineStep[]): Signal[] {
  const signals: Signal[] = [];
  const spent = steps.reduce((sum, step) => sum + step.inputTokens + step.outputTokens, 0);

  const about = (step: PipelineStep, kind: SignalKind, detail: string): Signal => ({
    kind,
    runId: run.id,
    agentId: step.agentId,
    agentName: step.agentName,
    detail,
  });

  for (const step of steps) {
    if (step.outcome === 'partial') {
      signals.push(about(step, 'partial', 'reported the work as partial'));
    }
    if (step.outcome === 'blocked') {
      signals.push(about(step, 'blocked', 'reported itself blocked'));
    }
    for (const unmet of step.unmet) {
      signals.push(about(step, 'unmet', unmet));
    }

    const said = (step.output ?? '').toLowerCase();
    const refusal = REFUSALS.find((phrase) => said.includes(phrase));
    if (refusal) signals.push(about(step, 'refusal', `said "${refusal}"`));

    if (step.status === 'done' && !step.output?.trim()) {
      signals.push(about(step, 'no-output', 'finished without saying anything'));
    }

    const stepSpent = step.inputTokens + step.outputTokens;
    if (spent > 0 && stepSpent / spent > EXPENSIVE_SHARE) {
      signals.push(
        about(
          step,
          'expensive',
          `took ${Math.round((stepSpent / spent) * 100)}% of this run's tokens`,
        ),
      );
    }

    if (promptHeavy(step)) {
      const { agent, ...frame } = step.promptParts;
      const frameBytes = Object.values(frame).reduce((sum, part) => sum + part, 0);
      signals.push(
        about(step, 'prompt-heavy', `carried ${frameBytes} bytes of frame around ${agent} of prompt`),
      );
    }
  }

  // About the run rather than any one agent: nobody chose these, and blaming the last agent
  // to speak for them is how a prompt gets edited for something that was never its fault.
  const error = run.error ?? '';
  if (/session limit|usage limit/i.test(error)) {
    signals.push({
      kind: 'session-cap',
      runId: run.id,
      agentId: null,
      agentName: null,
      detail: 'stopped by the provider session limit',
    });
  }
  if (/policy\.maxCostUsd|policy\.maxTurns/.test(error)) {
    signals.push({
      kind: 'budget-stop',
      runId: run.id,
      agentId: null,
      agentName: null,
      detail: 'stopped by the project budget',
    });
  }

  return signals;
}

export interface Finding {
  kind: SignalKind;
  agentId: string | null;
  agentName: string | null;
  /** Distinct runs this happened in. Length is what made it a finding. */
  runIds: string[];
  /** What was said, most recent first. Kept whole — the wording is the evidence. */
  details: string[];
}

/**
 * Signals that kept happening.
 *
 * Repetition, not a single event: an agent that says it had no shell once had a bad turn, and
 * an agent that says it three times across three runs is being asked for something it cannot
 * do. The threshold counts *distinct runs*, so an agent repeating itself inside one run — which
 * is one problem, not three — never reaches it on its own.
 */
export function findings(signals: Signal[], threshold = 3): Finding[] {
  const groups = new Map<string, Finding>();

  for (const signal of signals) {
    const key = `${signal.kind}::${signal.agentId ?? '-'}`;
    const found = groups.get(key) ?? {
      kind: signal.kind,
      agentId: signal.agentId,
      agentName: signal.agentName,
      runIds: [],
      details: [],
    };
    if (!found.runIds.includes(signal.runId)) found.runIds.push(signal.runId);
    found.details.push(signal.detail);
    groups.set(key, found);
  }

  return [...groups.values()]
    .filter((finding) => finding.runIds.length >= threshold)
    .sort((a, b) => b.runIds.length - a.runIds.length);
}

/**
 * Whether a signal has kept happening since the agent was last changed.
 *
 * Measured against `agent.updatedAt` rather than a record of amendments. Nothing new is
 * stored: the agent already carries when it last changed, and a run already carries when it
 * started, so "before" and "after" are a comparison of two timestamps that both exist. The
 * limit of that, stated: any edit to the agent resets the clock, not only an amendment. A
 * rename counts as a change here. That is the price of not keeping a second ledger.
 *
 * `after: 0` with `before` high is the shape worth seeing. It is not proof — the runs since
 * may simply not have exercised the agent — which is why the count of runs since is returned
 * beside it rather than a verdict.
 */
export function since(
  signals: Signal[],
  runs: Array<{ id: string; startedAt: string }>,
  changedAt: string,
): { before: number; after: number; runsAfter: number } {
  const boundary = Date.parse(changedAt);
  const startedAt = new Map(runs.map((run) => [run.id, Date.parse(run.startedAt)]));

  // Counted in distinct runs, the same unit a finding is counted in. Counting signals here
  // and runs there puts two different things on one line and reads as a contradiction — a
  // finding in 11 runs cannot have 31 of them anywhere.
  const before = new Set<string>();
  const after = new Set<string>();
  for (const signal of signals) {
    const started = startedAt.get(signal.runId);
    if (started === undefined) continue;
    (started >= boundary ? after : before).add(signal.runId);
  }

  const runsAfter = runs.filter((run) => Date.parse(run.startedAt) >= boundary).length;
  return { before: before.size, after: after.size, runsAfter };
}
