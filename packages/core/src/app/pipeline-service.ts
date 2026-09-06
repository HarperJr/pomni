import {
  assertRunnable,
  isOrchestrator,
  type Agent,
} from '../domain/agent.js';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import { layout } from '../domain/layout.js';
import {
  contextBytes,
  HUMAN_AGENT_ID,
  parseVerdict,
  VERDICT_PROTOCOL,
  MAX_CONTEXT_BYTES,
  MAX_CONTEXT_FILE_BYTES,
  ORCHESTRATOR_PROTOCOL,
  parseDelegations,
  summarise,
  withBrief,
  withContext,
  type ContextFile,
  type PipelineFilter,
  type PipelineRun,
  type PipelineRunDetail,
  type PipelineStep,
  type Question,
  type Verdict,
} from '../domain/pipeline.js';
import { toolBriefing } from '../domain/tool.js';
import { ulid } from '../domain/ulid.js';
import { chooseWorkflow, entryAgent, findAgent, rosterFor, type Workflow } from '../domain/workflow.js';
import { worktreeEligibility, type WorktreeProbe } from '../domain/worktree.js';
import type { Artifact } from '../domain/pipeline.js';
import type { ResolvedRepo } from '../domain/repo.js';
import type {
  Clock,
  DocStore,
  EventBus,
  GitPort,
  LlmMessage,
  Logger,
  PipelineStore,
} from '../ports/index.js';
import type { BacklogService } from './backlog-service.js';
import type { ProjectService } from './project-service.js';
import type { RunService } from './run-service.js';
import type { ProviderService } from './provider-service.js';
import type { ToolService } from './tool-service.js';
import type { RepoService } from './repo-service.js';
import type { WorkflowService } from './workflow-service.js';
import type { WorktreeService } from './worktree-service.js';

export interface StartRunInput {
  projectId: string;
  task: string;
  workflowId?: string;
  itemId?: string;
  /** Repo whose working directory agents run in. Defaults to the project's first repo. */
  repoId?: string;
  providerId?: string;
  /** Files to put in front of every agent — a spec, a log, an existing design. */
  context?: ContextFile[];
  /** Set when this run is a second attempt at an earlier one. */
  rerunOf?: string;
}

export interface StartRunResult {
  run: PipelineRun;
  completion: Promise<PipelineRun>;
}

/** How many delegate-and-review rounds one orchestrator gets before we stop it. */
const MAX_ROUNDS = 8;
/** How many agents one round may run at once. */
const MAX_PARALLEL = 4;
/**
 * How many times one agent may hand a problem up before it has to answer with what it has.
 *
 * One. An agent that escalates, is answered, and escalates again is not converging, and the
 * second answer costs another wait on a person who has already helped once.
 */
const MAX_ESCALATIONS = 1;
/** How long a run waits for a person before giving up on the question. */
const ANSWER_TIMEOUT_MS = 60 * 60 * 1000;
/**
 * How often a waiting run looks for its answer.
 *
 * The answer usually arrives in another process — the browser talks to the server, the run
 * may have been started from a terminal — so the shared store, not an in-memory promise, is
 * what both sides can see. A read of one row every second costs nothing.
 */
const ANSWER_POLL_MS = 1000;

/**
 * Runs a task through a workflow.
 *
 * The orchestrator is asked for delegations, we run them, and we feed the results back until
 * it answers in prose instead. Doing the loop here rather than through native tool-calling
 * costs a little flexibility and buys two things that matter more: it works identically on
 * every provider — including the Claude Code CLI, which runs its own tool loop and cannot
 * hand individual calls back — and every delegation becomes an event, which is what makes a
 * run watchable rather than a transcript you read afterwards.
 */
export class PipelineService {
  private readonly cancelled = new Set<string>();
  /** Runs this process is actually executing. Anything else marked running is a leftover. */
  private readonly owned = new Set<string>();
  /**
   * Files that arrived mid-run, attached to an answer.
   *
   * Kept beside the run rather than pushed into it: the run object is passed by reference to
   * every agent still to come, and quietly mutating a domain record is how you end up with
   * two versions of the truth. Merged in when each agent's task is built.
   */
  private readonly handedOver = new Map<string, ContextFile[]>();
  /** The tail of each project's claim queue. See `claim`. */
  private readonly claims = new Map<string, Promise<void>>();

  constructor(
    private readonly docs: DocStore,
    private readonly store: PipelineStore,
    private readonly projects: ProjectService,
    private readonly workflows: WorkflowService,
    private readonly repos: RepoService,
    private readonly providers: ProviderService,
    private readonly tools: ToolService,
    private readonly backlog: BacklogService,
    private readonly runs: RunService,
    private readonly git: GitPort,
    private readonly clock: Clock,
    private readonly events: EventBus,
    private readonly logger: Logger,
    private readonly worktrees: WorktreeService,
  ) {}

  async start(input: StartRunInput): Promise<StartRunResult> {
    const task = input.task.trim();
    if (!task) throw new ValidationError('a run needs a task');

    const context = normaliseContext(input.context ?? []);

    await this.projects.getRef(input.projectId);

    const attached = await this.workflows.forProject(input.projectId);
    if (attached.length === 0) {
      throw new ValidationError(
        `no workflow is attached to '${input.projectId}' — attach one first`,
      );
    }

    const chosen = chooseWorkflow(attached, task, input.workflowId);
    if (!chosen) {
      throw new ValidationError(
        `could not tell which workflow to use — name one. Attached: ${attached
          .map((workflow) => workflow.id)
          .join(', ')}`,
      );
    }

    this.workflows.assertRunnable(chosen);

    const provider = await this.providers.resolve(input.providerId);

    // The run id comes first now, because the worktree's branch is named after it, and the
    // worktrees come before the workspace, because the directories the agents are given are
    // this run's copies rather than the repos themselves.
    const runId = ulid(this.clock.now().getTime());
    const pid = process.pid;

    const usable = (await this.repos.listResolved(input.projectId)).filter(
      (repo) => repo.workingDirExists,
    );
    if (input.repoId && !usable.some((repo) => repo.id === input.repoId)) {
      throw new ValidationError(`repo '${input.repoId}' has no working copy`);
    }

    // A run pinned to one repo is only *worked* in that one. Cutting a worktree of every other
    // repo in the project costs a checkout and an install each, and puts the run at the mercy
    // of a conflict over a repo it was never going to touch. The rest stay readable below —
    // narrowing where the work happens is not the same as narrowing what may be read.
    const isolated = input.repoId ? usable.filter((repo) => repo.id === input.repoId) : usable;

    // Claiming is one step, not four. `assertNotInUse` answers out of the running runs in the
    // store and this run's row is written three awaits later, so on its own it is a look that
    // decides nothing: two overlapping `start()` calls both found the shared repo free and
    // both walked into it.
    const { run, taken, workspace } = await this.claim(input.projectId, async () => {
      await this.assertNotInUse(input.projectId, isolated);
      const taken = await this.worktrees.take(input.projectId, runId, isolated, { pid });
      const workspace = this.workspace(usable, taken.dirs, input.repoId);

      const claimed: PipelineRun = {
        id: runId,
        projectId: input.projectId,
        workflowId: chosen.id,
        workflowName: chosen.name,
        providerId: provider.id,
        itemId: input.itemId ?? null,
        rerunOf: input.rerunOf ?? null,
        task,
        context,
        status: 'running',
        pid,
        result: null,
        error: null,
        gateStatus: 'skipped',
        gateSummary: null,
        itemStatus: null,
        outcome: 'unknown',
        // A repo that could not be isolated is something this run was asked for and did not
        // get, so it belongs with everything else it did not deliver. `gateSummary` is the
        // gate's own words and a worktree note in it would read as a gate result.
        unmet: taken.fallbacks.map((fallback) => fallback.reason),
        startedAt: this.clock.iso(),
        endedAt: null,
        durationMs: null,
        costUsd: null,
      };

      await this.docs.ensureDir(layout.pipelineDir(claimed.id));
      // The row is what the next `start()` reads, so it goes down before this one lets go.
      await this.store.insertRun(claimed);
      return { run: claimed, taken, workspace };
    });

    this.events.emit({
      type: 'pipeline.started',
      runId: run.id,
      projectId: run.projectId,
      workflowId: run.workflowId,
      task,
    });

    // Moving the item as work starts is the point of running from the backlog: the board
    // should reflect that something is happening without anyone updating it by hand.
    if (run.itemId) {
      const moved = await this.moveItem(run, 'in_progress', 'agent run started');
      if (moved?.startsWith('could not move')) {
        await this.store.updateRun(run.id, { ...run, itemStatus: moved });
      }
    }

    for (const fallback of taken.fallbacks) this.logger.warn(fallback.reason);

    this.owned.add(run.id);
    return { run, completion: this.execute(run, chosen, workspace, taken.dirs, isolated) };
  }

  async get(id: string): Promise<PipelineRunDetail> {
    const run = await this.store.getRun(id);
    if (!run) throw new NotFoundError('run', id);
    return {
      ...run,
      steps: await this.store.steps(id),
      artifacts: await this.store.artifacts(id),
      questions: await this.store.questions(id),
    };
  }

  async list(filter: PipelineFilter): Promise<PipelineRun[]> {
    return this.store.listRuns(filter);
  }

  /**
   * Run a finished run again.
   *
   * Not a resume: the tree is rebuilt from the task, because a half-finished delegation tree
   * cannot be trusted to describe a world that has since changed. What does carry over is
   * the *reason it ended* — attached as a context file, so the agent that was blocked last
   * time starts knowing what blocked it instead of walking into it again.
   */
  async rerun(runId: string): Promise<StartRunResult> {
    const previous = await this.get(runId);
    if (previous.status === 'running') {
      throw new ValidationError('that run is still going — stop it before running it again');
    }

    const carried = previous.context.filter((file) => file.name !== ATTEMPT_FILE);

    return this.start({
      projectId: previous.projectId,
      task: previous.task,
      workflowId: previous.workflowId,
      itemId: previous.itemId ?? undefined,
      providerId: previous.providerId,
      rerunOf: previous.id,
      context: [...carried, { name: ATTEMPT_FILE, content: describeAttempt(previous) }],
    });
  }

  /** Open questions across every run, newest first. What a person is being asked for. */
  async openQuestions(projectId?: string): Promise<Question[]> {
    const runs = await this.store.listRuns({ projectId, status: 'running' });
    const open: Question[] = [];

    for (const run of runs) {
      const questions = await this.store.questions(run.id);
      open.push(...questions.filter((question) => question.status === 'open'));
    }
    return open.reverse();
  }

  /**
   * Answer a question a run is waiting on.
   *
   * The waiting run is usually in another process, so this only writes the answer down and
   * says so; the run finds it by polling the row it is blocked on.
   */
  async answer(questionId: string, text: string, files: ContextFile[] = []): Promise<Question> {
    const answer = text.trim();
    const attachments = normaliseContext(files);
    if (!answer && attachments.length === 0) {
      throw new ValidationError('an answer needs words, a file, or both');
    }

    const question = await this.store.getQuestion(questionId);
    if (!question) throw new NotFoundError('question', questionId);
    if (question.status !== 'open') {
      throw new ValidationError(`that question was already ${question.status}`);
    }

    const answered: Question = {
      ...question,
      answer: answer || `See the attached ${attachments.map((file) => file.name).join(', ')}.`,
      attachments,
      status: 'answered',
      answeredAt: this.clock.iso(),
    };
    await this.store.updateQuestion(questionId, answered);
    this.events.emit({
      type: 'pipeline.question.answered',
      runId: question.runId,
      questionId,
    });
    return answered;
  }

  /** Ask a run to stop. In-flight agents finish; nothing new is delegated. */
  async cancel(id: string): Promise<PipelineRun> {
    const run = await this.store.getRun(id);
    if (!run) throw new NotFoundError('run', id);
    if (run.status !== 'running') return run;

    // A run whose process died stays `running` for ever: nothing is left to receive the
    // signal, and the row outlives the work it described. Close it out here instead —
    // this process can prove it is not the one executing it.
    if (!this.owned.has(id)) {
      // `owned` is a set in this process's memory, so "not owned here" is not "owned by
      // nobody" — the CLI's set is empty for every run the server is executing. The pid on
      // the row is the only evidence that crosses processes, and `worktreeState` already
      // decides this way.
      const alive = run.pid !== null && (await this.runs.isProcessAlive(run.pid));

      const closed: PipelineRun = {
        ...run,
        status: 'cancelled',
        pid: null,
        error: 'the process running this pipeline is gone; the run was closed out',
        endedAt: this.clock.iso(),
        durationMs: Date.parse(this.clock.iso()) - Date.parse(run.startedAt),
      };
      await this.store.updateRun(id, closed);

      if (alive) {
        // Its agents are mid-turn in another process and cannot see the flag we would set
        // here. Removing their directory out from under them is worse than leaving it:
        // that process's own finally gives it back, and `pomni doctor` catches it if not.
        this.logger.warn(
          `run ${id} is still executing in process ${run.pid}; it was marked cancelled but its ` +
            'worktrees were left to that process',
        );
        this.finish(closed);
        return closed;
      }

      // Nothing is behind the pid, so this path never reaches `execute`'s finally and is the
      // only chance to give the dead run's worktrees back. Left to doctor they would sit there
      // until someone ran it. A dirty one is still kept, not deleted.
      const released = await this.releaseWorktrees(closed);
      this.finish(released);
      return released;
    }

    this.cancelled.add(id);
    this.events.emit({ type: 'pipeline.cancelling', runId: id });
    return run;
  }

  // -------------------------------------------------------------------------

  private async execute(
    run: PipelineRun,
    workflow: Workflow,
    workspace: { cwd: string | undefined; dirs: string[]; repos: ResolvedRepo[] },
    /** Where this run's copy of each repo is, by repo id. What the gate must run against. */
    dirOverrides: Record<string, string>,
    /** The repos worktrees were asked for, with their own directories still on them. */
    isolated: ResolvedRepo[],
  ): Promise<PipelineRun> {
    const { cwd } = workspace;
    const started = Date.now();
    let cost = 0;
    /** Assigned by whichever arm ends the run; the finally releases against it. */
    let settled: PipelineRun | undefined;

    try {
      run = await this.installDependencies(run, isolated, dirOverrides);

      const entry = entryAgent(workflow);
      const result = await this.runAgent({
        run,
        workflow,
        agent: entry,
        task: run.task,
        parentStepId: null,
        depth: 0,
        cwd,
        workspace,
        addCost: (amount) => {
          cost += amount;
        },
      });

      // A run is green only if the agent that did the work says it is. `passed` used to mean
      // no more than "the model returned prose", which is how a run ended green while its
      // own transcript explained the work had not been done.
      const verdict = result.verdict;

      let finished: PipelineRun = {
        ...run,
        status: this.cancelled.has(run.id)
          ? 'cancelled'
          : verdict.outcome === 'blocked'
            ? 'failed'
            : 'passed',
        error: verdict.outcome === 'blocked' ? verdict.unmet.join('; ') || 'blocked' : null,
        pid: null,
        outcome: verdict.outcome,
        // The agents' unmet list, after whatever the run already could not give itself —
        // a repo it had to share is as much a shortfall as a job it did not finish.
        unmet: [...run.unmet, ...verdict.unmet],
        result: result.answer,
        endedAt: this.clock.iso(),
        durationMs: Date.now() - started,
        costUsd: cost || null,
      };

      await this.captureArtifacts(finished, cwd);

      // The gate is what turns "the agents finished" into "the change works". Without it a
      // pipeline can only report its own opinion of itself.
      if (finished.status === 'passed') {
        finished = await this.runGate(finished, dirOverrides);
        if (finished.itemId) {
          // Review means "someone should look at finished work". Both halves have to hold:
          // the gate proves the repo still builds, the verdict says the work was actually
          // done. A green gate over an unfinished job is the more dangerous of the two,
          // because it looks like evidence.
          const ready = finished.gateStatus !== 'failed' && finished.outcome === 'done';
          const why =
            finished.gateStatus === 'failed'
              ? 'the gate did not pass after the agent run'
              : `the agents reported the work as ${finished.outcome}${
                  finished.unmet.length > 0 ? `: ${finished.unmet.join('; ')}` : ''
                }`;

          const moved = ready
            ? await this.moveItem(finished, 'in_review', 'agent run finished and the gate passed')
            : await this.moveItem(finished, 'blocked', why);
          finished = { ...finished, itemStatus: moved };
        }
      }

      await this.store.updateRun(run.id, finished);
      settled = finished;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.debug(`pipeline ${run.id} failed`, message);

      const failed: PipelineRun = {
        ...run,
        status: this.cancelled.has(run.id) ? 'cancelled' : 'failed',
        pid: null,
        error: message,
        endedAt: this.clock.iso(),
        durationMs: Date.now() - started,
        costUsd: cost || null,
      };

      if (failed.itemId) {
        failed.itemStatus = await this.moveItem(failed, 'blocked', `agent run failed: ${message}`);
      }

      await this.store.updateRun(run.id, failed);
      settled = failed;
    } finally {
      this.cancelled.delete(run.id);
      this.owned.delete(run.id);
      this.handedOver.delete(run.id);
      // The one seam both the finished and the failed path reach. A run that ends badly is
      // exactly the one whose worktree is likely to be worth keeping.
      settled = await this.releaseWorktrees(settled ?? run);
    }

    // `settled` is set by both arms; the fallback only matters if the store write itself
    // threw, in which case that error is already on its way out.
    const done = settled ?? run;
    this.finish(done);
    return done;
  }

  /**
   * One agent's turn. A plain agent answers once; an orchestrator loops — delegating, reading
   * what came back, and delegating again — until it answers in prose.
   */
  private async runAgent(context: {
    run: PipelineRun;
    workflow: Workflow;
    agent: Agent;
    task: string;
    parentStepId: string | null;
    depth: number;
    cwd: string | undefined;
    workspace: { cwd: string | undefined; dirs: string[]; repos: ResolvedRepo[] };
    addCost: (amount: number) => void;
  }): Promise<{ answer: string; verdict: Verdict }> {
    const { run, workflow, agent, task, parentStepId, depth, cwd, workspace, addCost } = context;
    assertRunnable(agent);

    const orchestrating = isOrchestrator(agent);
    const roster = orchestrating ? rosterFor(workflow, agent) : [];

    // Resolved before the step is recorded: an agent asking for a tool nobody gave the
    // project should fail as a configuration error, not halfway through a paid session.
    const grants = await this.tools.grantsFor(run.projectId, [
      ...agent.tools.mcp,
      ...agent.tools.cli,
    ]);

    const { port, model, provider } = await this.providers.portFor(agent.struggle, {
      provider: run.providerId,
      // Only give an agent a working directory when it is allowed to touch files; an
      // orchestrator with a repo tends to start doing the work itself.
      cwd: agent.tools.files || agent.tools.run ? cwd : undefined,
      dirs: agent.tools.files || agent.tools.run ? workspace.dirs : [],
      tools: grants,
      files: agent.tools.files,
      run: agent.tools.run,
    });

    const step: PipelineStep = {
      id: ulid(this.clock.now().getTime()),
      runId: run.id,
      parentStepId,
      agentId: agent.id,
      agentName: agent.name,
      role: agent.role,
      model,
      task,
      status: 'running',
      output: null,
      error: null,
      outcome: 'unknown',
      unmet: [],
      actions: [],
      depth,
      startedAt: this.clock.iso(),
      endedAt: null,
      durationMs: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
    };

    await this.store.insertStep(step);
    this.events.emit({
      type: 'pipeline.step.started',
      runId: run.id,
      stepId: step.id,
      parentStepId,
      agentId: agent.id,
      agentName: agent.name,
      role: agent.role,
      model,
      depth,
      task,
    });

    const startedAt = Date.now();
    const actions: PipelineStep['actions'] = [];
    const transcript: string[] = [`# Task\n\n${task}`];
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      const briefing = toolBriefing(grants);
      const repos =
        agent.tools.files || agent.tools.run ? this.repoBriefing(workspace.repos) : null;

      const system = orchestrating
        ? [
            agent.prompt,
            '',
            ORCHESTRATOR_PROTOCOL,
            '',
            '## Agents you can delegate to',
            `- ${HUMAN_AGENT_ID} — the person who started this run. For decisions that are`
              + ' theirs, not yours. The run waits until they answer.',
            roster
              .map(
                (other) =>
                  `- \`${other.id}\` — ${other.name}. ${other.spec.split('\n')[0] ?? ''}${
                    other.outputs ? ` Returns: ${other.outputs}` : ''
                  }`,
              )
              .join('\n'),
          ].join('\n')
        : agent.prompt;

      // The briefing goes last: an agent's own prompt is what it is, and the tools it was
      // handed are context added on top rather than part of its job description.
      const briefed = briefing ? [system, '', briefing].join('\n') : system;
      // Every agent, orchestrator or not, says what it achieved. Without it a step that
      // explains why it could not do the job is indistinguishable from one that did it.
      const prompt = [briefed, ...(repos ? ['', repos] : []), '', VERDICT_PROTOCOL].join(
        '\n',
      );

      // The orchestrator's own turns stay in the conversation. Sending only the latest
      // round back is what made a lead ask the same analyst the same question four times:
      // it could not see what it had already delegated.
      const carried = [...run.context, ...(this.handedOver.get(run.id) ?? [])];
      // The entry agent's task *is* the brief; everyone else is given it alongside their own
      // instruction. Without this the orchestrator had to restate the whole background in
      // every delegation, and it did — 174kB of it across one 22-step run.
      const forAgent = depth === 0 ? task : withBrief(task, run.task);
      const history: LlmMessage[] = [
        { role: 'user', content: withContext(forAgent, carried) },
      ];
      // An exact repeat is answered from the ledger instead of being run again — a second
      // session for a question already answered costs money and returns the same thing.
      const answered = new Map<string, string>();
      const useCount = new Map<string, number>();
      let answer = '';
      let escalations = 0;

      for (
        let round = 0;
        round < (orchestrating ? MAX_ROUNDS : 1 + escalations);
        round += 1
      ) {
        if (this.cancelled.has(run.id)) {
          answer = answer || 'The run was cancelled before this agent finished.';
          break;
        }

        const result = await port.complete({
          model,
          system: prompt,
          messages: history,
          adaptiveThinking: provider.kind !== 'claude-code',
          effort: orchestrating ? 'high' : 'medium',
          maxTokens: 16_000,
        });

        inputTokens += result.usage.inputTokens;
        outputTokens += result.usage.outputTokens;
        transcript.push(`\n# Reply (round ${round + 1})\n\n${result.text}`);

        history.push({ role: 'assistant', content: result.text });
        // What the session did, not only what it concluded. A fifteen-minute turn otherwise
        // leaves one paragraph behind as its whole account of itself.
        actions.push(...(result.actions ?? []));

        this.events.emit({
          type: 'pipeline.step.output',
          runId: run.id,
          stepId: step.id,
          chunk: result.text,
        });

        const delegations = orchestrating ? parseDelegations(result.text) : null;
        if (!delegations) {
          answer = result.text;

          // An agent that cannot settle something on its own says so rather than guessing.
          // Critical means the work genuinely stops here, so we put it to a person and give
          // the agent another turn with the reply — otherwise it would have to answer now,
          // which is the guess we were trying to avoid.
          const { verdict: interim } = parseVerdict(answer);
          const escalation = interim.escalate;

          if (escalation?.critical && escalations < MAX_ESCALATIONS) {
            escalations += 1;
            this.events.emit({
              type: 'pipeline.escalated',
              runId: run.id,
              stepId: step.id,
              agentName: agent.name,
              question: escalation.question,
            });

            const reply = await this.askHuman(run, step, agent, escalation.question);
            history.push({
              role: 'user',
              content: [
                'You escalated this, and here is the answer:',
                '',
                reply,
                '',
                'Carry on with the work and give your final answer, with its verdict block.',
              ].join('\n'),
            });
            continue;
          }
          break;
        }

        // Run this round's delegations, bounded — an orchestrator that asks for twelve
        // agents at once should not open twelve sessions.
        const results: string[] = [];
        for (let index = 0; index < delegations.length; index += MAX_PARALLEL) {
          const batch = delegations.slice(index, index + MAX_PARALLEL);

          const settled = await Promise.all(
            batch.map(async (delegation) => {
              if (delegation.agent === HUMAN_AGENT_ID) {
                const key = `human::${delegation.task.trim().toLowerCase()}`;
                const previous = answered.get(key);
                if (previous !== undefined) {
                  return `### You already asked this\n\n${previous}`;
                }

                const reply = await this.askHuman(run, step, agent, delegation.task);
                answered.set(key, reply);
                useCount.set(HUMAN_AGENT_ID, (useCount.get(HUMAN_AGENT_ID) ?? 0) + 1);
                return `### The person who started this run\n\n${reply}`;
              }

              const target = findAgent(workflow, delegation.agent);
              if (!target || !roster.some((candidate) => candidate.id === target.id)) {
                return `### ${delegation.agent}\n\nThere is no such agent in your roster. Delegate only to the ids listed above.`;
              }

              const key = `${target.id}::${delegation.task.trim().toLowerCase()}`;
              const previous = answered.get(key);
              if (previous !== undefined) {
                return `### ${target.name} — you already asked this\n\n${previous}`;
              }

              this.events.emit({
                type: 'pipeline.flow',
                runId: run.id,
                fromStepId: step.id,
                fromAgentId: agent.id,
                toAgentId: target.id,
                task: delegation.task,
              });

              try {
                const output = await this.runAgent({
                  run,
                  workflow,
                  agent: target,
                  task: delegation.task,
                  parentStepId: step.id,
                  depth: depth + 1,
                  cwd,
                  workspace,
                  addCost,
                });
                answered.set(key, output.answer);
                useCount.set(target.id, (useCount.get(target.id) ?? 0) + 1);

                // Flagged in the heading, where it cannot be skimmed past. An
                // orchestrator that reads BLOCKED and still reports the run as done
                // has chosen to, rather than never having been told.
                const flag =
                  output.verdict.outcome === 'done'
                    ? ''
                    : ` — ${output.verdict.outcome.toUpperCase()}`;
                const escalated = output.verdict.escalate
                  ? `\n\nEscalated to you: ${output.verdict.escalate.question}`
                  : '';
                const unmet =
                  output.verdict.unmet.length > 0
                    ? `\n\nDid not deliver:\n${output.verdict.unmet
                        .map((entry: string) => `- ${entry}`)
                        .join('\n')}`
                    : '';

                return `### ${target.name} (\`${target.id}\`)${flag}\n\n${output.answer}${escalated}${unmet}`;
              } catch (error) {
                // One agent failing is information the orchestrator can route around.
                return `### ${target.name} (\`${target.id}\`) — FAILED\n\n${
                  error instanceof Error ? error.message : String(error)
                }`;
              }
            }),
          );

          results.push(...settled);
        }

        const ledger = [...useCount.entries()]
          .map(([id, times]) => `${id} (${times}x)`)
          .join(', ');

        history.push({
          role: 'user',
          content: [
            'Here is what came back from the agents you delegated to.',
            '',
            ...results,
            '',
            `Agents you have used so far: ${ledger || 'none'}. Do not ask one of them the same`,
            'question again — build on what it already told you.',
            '',
            'Delegate again if you still need something new, or answer in prose.',
          ].join('\n'),
        });

        if (round === MAX_ROUNDS - 1) {
          answer = 'This orchestrator kept delegating and ran out of rounds without answering.';
        }
      }

      await this.docs.write(layout.pipelineStepLog(run.id, step.id), transcript.join('\n'));

      const { verdict, prose } = parseVerdict(answer);
      answer = prose || answer;

      const done: PipelineStep = {
        ...step,
        status: this.cancelled.has(run.id) ? 'cancelled' : 'done',
        output: answer,
        outcome: verdict.outcome,
        unmet: verdict.unmet,
        actions,
        endedAt: this.clock.iso(),
        durationMs: Date.now() - startedAt,
        inputTokens,
        outputTokens,
      };

      await this.store.updateStep(step.id, done);
      this.events.emit({
        type: 'pipeline.step.finished',
        runId: run.id,
        stepId: step.id,
        agentId: agent.id,
        status: done.status,
        summary: summarise(answer),
      });

      return { answer, verdict };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      const failed: PipelineStep = {
        ...step,
        status: 'failed',
        error: message,
        endedAt: this.clock.iso(),
        durationMs: Date.now() - startedAt,
        inputTokens,
        outputTokens,
      };

      await this.store.updateStep(step.id, failed);
      this.events.emit({
        type: 'pipeline.step.finished',
        runId: run.id,
        stepId: step.id,
        agentId: agent.id,
        status: 'failed',
        summary: message,
      });

      throw error;
    }
  }

  /**
   * Install each worktree's dependencies before anybody works in it.
   *
   * `git worktree add` checks out tracked files and nothing else, and `node_modules`, `dist`
   * and `.venv` are all gitignored — so a fresh worktree has no test runner, no compiler and,
   * in a workspace repo, no links between its packages. Without this the gate could not pass
   * at all: `npm test` would exit non-zero for want of an install and the item would be moved
   * to `blocked` on evidence about a missing directory rather than about this run's code.
   *
   * A repo that fell back is already sitting in its own installed tree, and installing over it
   * would be a write into somebody else's working copy that the run never asked for.
   */
  private async installDependencies(
    run: PipelineRun,
    repos: ResolvedRepo[],
    dirOverrides: Record<string, string>,
  ): Promise<PipelineRun> {
    const notes: string[] = [];

    for (const repo of repos) {
      const dir = dirOverrides[repo.id];
      if (!dir || dir === repo.workingDir) continue;

      // Plenty of repos need none — a Go module, a repo of prose. Silence is the right answer.
      const install = repo.capabilities.install;
      if (!install || install.background) continue;

      try {
        const installed = await this.runs.run(run.projectId, 'install', {
          repoId: repo.id,
          dirOverrides,
        });
        for (const entry of installed) {
          if (entry.status === 'passed') continue;
          notes.push(
            `'${repo.name}': install (${entry.cmd}) ${entry.status} in this run's worktree` +
              `${entry.summary ? ` — ${entry.summary}` : ''}. The worktree has only the tracked` +
              ' files, so the gate is likely to fail for want of dependencies rather than for' +
              ' anything the agents did.',
          );
        }
      } catch (error) {
        // A failed install is a fact about this run, not a reason to abandon it: the agents may
        // still do useful work, and a run that stops here says less than one that carries on.
        notes.push(
          `'${repo.name}': its install could not be run in this run's worktree (${
            error instanceof Error ? error.message : String(error)
          }) — the gate is likely to fail for want of dependencies.`,
        );
      }
    }

    if (notes.length === 0) return run;
    for (const note of notes) this.logger.warn(note);

    // Recorded before the first agent turn, so a run watched live says why its gate is about
    // to go red instead of leaving it to be discovered as a mysterious failure at the end.
    const updated: PipelineRun = { ...run, unmet: [...run.unmet, ...notes] };
    await this.store.updateRun(run.id, updated);
    return updated;
  }

  /**
   * Run the project's gate against whatever the agents changed.
   *
   * Deliberately after the pipeline rather than inside it: an orchestrator asked to verify
   * its own work grades itself, and the run store already knows how to answer the question
   * properly.
   */
  private async runGate(
    run: PipelineRun,
    dirOverrides: Record<string, string>,
  ): Promise<PipelineRun> {
    try {
      // Against this run's own copies. A gate run in the shared repo directory while another
      // run is changing it grades whatever happened to be on disk, not this run's code.
      const report = await this.runs.gate(run.projectId, 'default', { dirOverrides });

      const failures = report.results
        .filter((result) => result.status === 'failed')
        .flatMap((result) =>
          result.runs
            .filter((entry) => entry.status !== 'passed')
            .map((entry) => `${entry.repoId} ${result.capability}: ${entry.summary ?? entry.status}`),
        );

      const summary = report.passed
        ? report.results
            .filter((result) => result.status === 'passed')
            .map((result) => result.capability)
            .join(', ') || 'nothing to run'
        : failures.join('; ');

      await this.store.putArtifacts([
        this.artifact(run.id, null, 'report', 'gate', summary, summary.length),
      ]);

      return {
        ...run,
        gateStatus: report.passed ? 'passed' : 'failed',
        gateSummary: summary,
      };
    } catch (error) {
      // No capabilities declared, or the gate itself could not run. Neither makes the
      // pipeline's own result wrong, so say so rather than failing the run.
      return {
        ...run,
        gateStatus: 'skipped',
        gateSummary: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * What the run produced: every agent's answer, and every file the working copy now differs
   * by. The file list is the honest record of what actually changed on disk.
   */
  private async captureArtifacts(run: PipelineRun, cwd: string | undefined): Promise<void> {
    const artifacts: Artifact[] = [];

    for (const step of await this.store.steps(run.id)) {
      if (!step.output) continue;
      artifacts.push(
        this.artifact(run.id, step.id, 'answer', step.agentName, step.output, step.output.length),
      );
    }

    if (cwd) {
      try {
        for (const change of await this.git.changes(cwd)) {
          artifacts.push({
            id: ulid(this.clock.now().getTime()),
            runId: run.id,
            stepId: null,
            name: change.path.split(/[\\/]/).pop() ?? change.path,
            kind: 'file',
            path: change.path,
            change: change.change,
            bytes: 0,
            createdAt: this.clock.iso(),
          });
        }
      } catch (error) {
        this.logger.debug('could not read working copy changes', error);
      }
    }

    // A branch that is not the default one is work waiting to be proposed. Offering the
    // merge-request link is more useful than reporting the branch name and leaving you to
    // find the page yourself.
    if (cwd) {
      const link = await this.mergeRequestLink(cwd);
      if (link) {
        artifacts.push({
          id: ulid(this.clock.now().getTime()),
          runId: run.id,
          stepId: null,
          name: link.branch,
          kind: 'report',
          path: link.url,
          change: 'merge request',
          bytes: 0,
          createdAt: this.clock.iso(),
        });
      }
    }

    if (artifacts.length > 0) await this.store.putArtifacts(artifacts);
  }

  /**
   * Where to open a merge request for whatever branch the work landed on.
   *
   * Built from the remote rather than by calling the forge: no token is needed, it works on
   * a self-hosted instance, and the page it opens is the one a human would have navigated to.
   */
  private async mergeRequestLink(cwd: string): Promise<{ branch: string; url: string } | null> {
    try {
      const vcs = await this.git.info(cwd);
      if (!vcs?.currentBranch || !vcs.remote) return null;
      if (vcs.currentBranch === vcs.defaultBranch) return null;

      const base = vcs.remote.replace(/\.git$/i, '').replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(base)) return null;

      const branch = encodeURIComponent(vcs.currentBranch);
      const url = base.includes('github.com')
        ? `${base}/compare/${branch}?expand=1`
        : `${base}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${branch}`;

      return { branch: vcs.currentBranch, url };
    } catch {
      return null;
    }
  }

  private artifact(
    runId: string,
    stepId: string | null,
    kind: Artifact['kind'],
    name: string,
    _body: string,
    bytes: number,
  ): Artifact {
    return {
      id: ulid(this.clock.now().getTime()),
      runId,
      stepId,
      name,
      kind,
      path: null,
      change: null,
      bytes,
      createdAt: this.clock.iso(),
    };
  }

  /**
   * Move the backlog item this run is for. Guards still apply — a forced move would defeat
   * the point — so a refusal is recorded rather than overridden.
   */
  /**
   * Put a question to a person and wait for the answer.
   *
   * The wait is real: the run holds here, which is the point — an orchestrator that asked
   * and carried on regardless would have been better off guessing. What stops it being a
   * hang is that the question is a visible, answerable record with a deadline on it.
   */
  private async askHuman(
    run: PipelineRun,
    step: PipelineStep,
    agent: Agent,
    text: string,
  ): Promise<string> {
    const question: Question = {
      id: ulid(this.clock.now().getTime()),
      runId: run.id,
      stepId: step.id,
      agentId: agent.id,
      agentName: agent.name,
      question: text.trim(),
      answer: null,
      attachments: [],
      status: 'open',
      askedAt: this.clock.iso(),
      answeredAt: null,
    };

    await this.store.insertQuestion(question);
    this.events.emit({
      type: 'pipeline.question.asked',
      runId: run.id,
      questionId: question.id,
      agentName: agent.name,
      question: question.question,
    });

    const deadline = Date.now() + ANSWER_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (this.cancelled.has(run.id)) {
        await this.abandon(question, 'the run was cancelled while waiting');
        return 'The run was cancelled while this question was waiting. Stop and report.';
      }

      const current = await this.store.getQuestion(question.id);
      if (current?.status === 'answered' && current.answer) {
        return this.collect(run, current);
      }
      if (current?.status === 'abandoned') {
        return 'Nobody answered this. Decide it yourself, and say in your answer that you did.';
      }

      await new Promise((resolve) => setTimeout(resolve, ANSWER_POLL_MS));
    }

    await this.abandon(question, 'nobody answered within the hour');
    return [
      'Nobody answered within the time allowed.',
      'Decide it yourself on the best evidence you have, and say plainly in your final',
      'answer which question went unanswered and what you assumed.',
    ].join(' ');
  }

  /**
   * The answer as the waiting agent receives it, and the files put where the rest of the run
   * can see them.
   *
   * Inlined here *and* added to the context on purpose. The agent that asked is mid-round —
   * its next message is the delegation results, not a fresh prompt — so the content has to
   * travel in the answer to reach it now. Everyone delegated to afterwards gets it through
   * the context block instead, which is what stops the file dying with the question.
   */
  private async collect(run: PipelineRun, question: Question): Promise<string> {
    const answer = question.answer ?? '';
    if (question.attachments.length === 0) return answer;

    const existing = this.handedOver.get(run.id) ?? [];
    const added = question.attachments.filter(
      (file) => !existing.some((seen) => seen.name === file.name),
    );
    this.handedOver.set(run.id, [...existing, ...added]);

    // Written down as well, so a reload of the console shows what was handed over.
    const stored = await this.store.getRun(run.id);
    if (stored) {
      const names = new Set(stored.context.map((file) => file.name));
      await this.store.updateRun(run.id, {
        ...stored,
        context: [...stored.context, ...added.filter((file) => !names.has(file.name))],
      });
    }

    return withContext(answer, question.attachments);
  }

  private async abandon(question: Question, reason: string): Promise<void> {
    await this.store.updateQuestion(question.id, {
      ...question,
      status: 'abandoned',
      answer: reason,
      answeredAt: this.clock.iso(),
    });
    this.events.emit({
      type: 'pipeline.question.answered',
      runId: question.runId,
      questionId: question.id,
    });
  }

  private async moveItem(run: PipelineRun, to: string, reason: string): Promise<string | null> {
    if (!run.itemId) return null;

    try {
      const moved = await this.backlog.transition(
        run.projectId,
        run.itemId,
        to as Parameters<BacklogService['transition']>[2],
        { reason },
      );
      return moved.status;
    } catch (error) {
      // A board that does not move is the whole point of running from the backlog, so a
      // refused transition is reportable rather than a debug line nobody reads. Returning
      // the reason puts it on the run, where the console and `task list` can show it.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`could not move ${run.itemId} to ${to}: ${message}`);
      return `could not move to ${to}: ${message}`;
    }
  }

  private finish(run: PipelineRun): void {
    this.events.emit({
      type: 'pipeline.finished',
      runId: run.id,
      projectId: run.projectId,
      status: run.status,
      summary: summarise(run.result ?? run.error),
    });
  }

  /**
   * Every repo an agent may touch, with the one it starts in first.
   *
   * A project is a set of repos, and the interesting work crosses them — an API contract is
   * only half a change if the app that calls it cannot be read. Handing over one directory
   * made the rest of the project invisible: agents reported being unable to see the mobile
   * app at all, and were right.
   */
  private workspace(
    repos: ResolvedRepo[],
    /** This run's directory per repo — its worktree, or the repo itself where it fell back. */
    dirOverrides: Record<string, string>,
    repoId?: string,
  ): { cwd: string | undefined; dirs: string[]; repos: ResolvedRepo[] } {
    // Substituted here rather than at every use: an agent that is told about a directory it
    // is not working in will read the wrong file and be right to be confused.
    const usable = repos.map((repo) => ({
      ...repo,
      workingDir: dirOverrides[repo.id] ?? repo.workingDir,
    }));
    if (usable.length === 0) return { cwd: undefined, dirs: [], repos: [] };

    if (repoId) {
      const named = usable.find((repo) => repo.id === repoId);
      if (!named) throw new ValidationError(`repo '${repoId}' has no working copy`);

      // Named repo first, but the others stay readable: choosing where to start is not the
      // same as choosing what may be looked at.
      const others = usable.filter((repo) => repo.id !== named.id);
      return {
        cwd: named.workingDir,
        dirs: [named.workingDir, ...others.map((repo) => repo.workingDir)],
        repos: [named, ...others],
      };
    }

    return {
      cwd: usable[0]?.workingDir,
      dirs: usable.map((repo) => repo.workingDir),
      repos: usable,
    };
  }

  /**
   * One start at a time per project, for as long as it takes to claim what it needs.
   *
   * Check-then-act is only a check if nothing can act in between, and there are two awaits
   * between the two halves. Queueing them makes the second `start()` read the store after the
   * first has written its row, so it sees the run it is about to collide with. The loser is
   * refused before it takes anything: nothing is inserted, no worktree is cut, and the
   * `ConflictError` is the same one a start against an established run has always got.
   *
   * The queue is a promise chain on this object, so the guarantee stops at this process. A
   * `pomni` CLI and a `pomni serve` starting a run on the same shared repo at the same instant
   * can still both get through — closing that needs a claim the store itself arbitrates, not a
   * variable in memory.
   */
  private async claim<T>(projectId: string, take: () => Promise<T>): Promise<T> {
    const queued = (this.claims.get(projectId) ?? Promise.resolve()).then(take);
    // The tail is the settled form: a refused start must not reject the ones queued behind it.
    this.claims.set(
      projectId,
      queued.then(
        () => undefined,
        () => undefined,
      ),
    );
    return queued;
  }

  /**
   * Refuse to start when a repo this run would have to share is already being worked in.
   *
   * There is no scheduler: "one run at a time" used to be a side effect of every run landing
   * in the same directory. A repo that gets its own worktree can never conflict — that is the
   * whole point — so this only ever fires for the ones that cannot have one.
   */
  private async assertNotInUse(projectId: string, repos: ResolvedRepo[]): Promise<void> {
    const supported = await this.git.supportsWorktrees().catch(() => false);

    const shared: Array<{ repo: ResolvedRepo; reason: string }> = [];
    for (const repo of repos) {
      const eligibility = worktreeEligibility(repo, await this.probe(repo, supported));
      if (!eligibility.eligible) shared.push({ repo, reason: eligibility.reason });
    }
    if (shared.length === 0) return;

    for (const other of await this.store.listRuns({ projectId, status: 'running' })) {
      // `running` on its own is not evidence: a session killed mid-run leaves the row there
      // for ever, and trusting it would block this repo until somebody noticed. A row with no
      // pid is still treated as in use — the escape hatch in the message is the way out.
      if (other.pid !== null && !(await this.runs.isProcessAlive(other.pid))) continue;

      const held = new Set(
        (await this.worktrees.list({ runId: other.id })).map((worktree) => worktree.repoId),
      );

      for (const { repo, reason } of shared) {
        if (held.has(repo.id)) continue;
        throw new ConflictError(
          `run ${other.id} is already working in '${repo.name}' and ${reason}. Wait for it, or ` +
            `close it out with 'pomni run cancel ${other.id}' if its process is gone.`,
        );
      }
    }
  }

  /**
   * What `worktreeEligibility` needs to know. Repeated from `WorktreeService.take` on purpose:
   * the answer is wanted here *before* anything is created, and a handful of git reads at run
   * start is cheaper than a worktree taken and then given back.
   */
  private async probe(repo: ResolvedRepo, gitSupportsWorktrees: boolean): Promise<WorktreeProbe> {
    if (!repo.workingDirExists) {
      return {
        workingDirExists: false,
        isGitRepo: false,
        gitSupportsWorktrees,
        currentBranch: null,
        head: null,
      };
    }

    const isGitRepo = await this.git.isRepo(repo.workingDir).catch(() => false);
    const info = isGitRepo ? await this.git.info(repo.workingDir).catch(() => null) : null;
    return {
      workingDirExists: true,
      isGitRepo,
      gitSupportsWorktrees,
      currentBranch: info?.currentBranch ?? null,
      head: info?.head ?? null,
    };
  }

  /**
   * Give this run's worktrees back and say what survived.
   *
   * A kept worktree is written onto the run itself, not only logged: the person reading
   * `pomni run show` is the one who has to go and look at the uncommitted work, and a line in
   * a log file they never open is the same as not telling them.
   *
   * `unmet` is its one home. It used to go into `result` as well, so `pomni run show` printed
   * every note twice; `result` is the agents' own answer, and a directory git would not remove
   * is not something they said. `unmet` already carries the fallback reasons from the same
   * feature, so everything this run could not give you about its directories reads as one list.
   */
  private async releaseWorktrees(run: PipelineRun): Promise<PipelineRun> {
    let kept: Array<{ repoId: string; path: string; reason: string | null }> = [];

    try {
      kept = (await this.worktrees.release(run.id)).filter((entry) => entry.kept);
    } catch (error) {
      // Never worth failing a finished run over.
      this.logger.warn(`could not release worktrees for ${run.id}`, error);
    }

    const notes = kept.map(
      (entry) =>
        `The worktree for '${entry.repoId}' was kept at ${entry.path} — ${
          entry.reason ?? 'it could not be removed'
        }.`,
    );

    const stored = (await this.store.getRun(run.id)) ?? run;
    const updated: PipelineRun = {
      ...stored,
      pid: null,
      unmet: [...stored.unmet, ...notes],
    };

    try {
      await this.store.updateRun(run.id, updated);
    } catch (error) {
      this.logger.warn(`could not record the worktree outcome for ${run.id}`, error);
    }
    return updated;
  }

  /** Where the repos are, told to the agent — access it does not know about is no access. */
  private repoBriefing(repos: ResolvedRepo[]): string | null {
    if (repos.length === 0) return null;

    return [
      '## Repos you can read and change',
      '',
      ...repos.map(
        (repo) =>
          `- **${repo.name}** (\`${repo.id}\`, ${repo.role}) — \`${repo.workingDir}\`${
            repo.stack ? `. ${repo.stack.detected.join(', ')}` : ''
          }`,
      ),
      '',
      'All of them are open to you, not only the first. Read across them before deciding how',
      'a change lands: a contract that one repo publishes and another consumes is one change,',
      'not two.',
    ].join('\n');
  }
}

/**
 * Checks attached files and gives them names an agent can refer to.
 *
 * The caps are not about disk: this text is sent again for every agent in the workflow and
 * every round an orchestrator takes, so a careless attachment is paid for many times over.
 * A file with a NUL byte is not text, and inlining it would only spend tokens on noise.
 */
function normaliseContext(files: ContextFile[]): ContextFile[] {
  const seen = new Set<string>();

  const normalised = files.map((file) => {
    const name = file.name.split(/[\\/]/).pop()?.trim() || 'attachment';
    const content = file.content;

    if (content.trim().length === 0) {
      throw new ValidationError(`'${name}' is empty — there is nothing in it to give an agent`);
    }
    if (content.includes('\u0000')) {
      throw new ValidationError(`'${name}' is not a text file`);
    }
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_CONTEXT_FILE_BYTES) {
      throw new ValidationError(
        `'${name}' is ${Math.round(bytes / 1000)}kB; the limit for one file is ${
          MAX_CONTEXT_FILE_BYTES / 1000
        }kB. Attach the part that matters.`,
      );
    }

    // Two files called the same thing leave an agent unable to say which one it means.
    let unique = name;
    for (let n = 2; seen.has(unique); n += 1) unique = `${name} (${n})`;
    seen.add(unique);

    return { name: unique, content };
  });

  const total = contextBytes(normalised);
  if (total > MAX_CONTEXT_BYTES) {
    throw new ValidationError(
      `attached files come to ${Math.round(total / 1000)}kB; the limit for a run is ${
        MAX_CONTEXT_BYTES / 1000
      }kB, and every agent is sent all of it.`,
    );
  }
  return normalised;
}

/** The name the carried-forward summary always has, so a third attempt replaces the second. */
const ATTEMPT_FILE = 'previous-attempt.md';

/**
 * What went wrong last time, written for the agents who will try again.
 *
 * Deliberately concrete: which agent stopped, and the words it used. An agent told only
 * "the last run failed" learns nothing it can act on; one told "figma-cli reported no file
 * open" knows to check that first, and to say so if it is still true.
 */
function describeAttempt(run: PipelineRunDetail): string {
  const lines = [
    `The previous attempt at this task (run ${run.id}) ended **${run.status}**`,
    run.outcome !== 'unknown' ? ` and the agents reported it as **${run.outcome}**.` : '.',
    '\n\n',
  ];

  if (run.unmet.length > 0) {
    lines.push('What it did not deliver:\n');
    lines.push(...run.unmet.map((entry) => `- ${entry}\n`));
    lines.push('\n');
  }

  if (run.error) lines.push(`It stopped with: ${run.error}\n\n`);
  if (run.gateStatus === 'failed') {
    lines.push(`The gate failed afterwards: ${run.gateSummary ?? 'no detail'}\n\n`);
  }

  const stumbled = run.steps.filter((step) => step.outcome === 'blocked' || step.outcome === 'partial');
  for (const step of stumbled) {
    lines.push(`### ${step.agentName} — ${step.outcome.toUpperCase()}\n\n`);
    lines.push(`${(step.output ?? '').slice(0, 1500).trim()}\n\n`);
  }

  const questions = run.questions.filter((question) => question.answer);
  for (const question of questions) {
    lines.push(`### Asked last time: ${question.question}\n\n`);
    lines.push(`Answered: ${question.answer}\n\n`);
  }

  lines.push(
    'Do not assume any of this is still true — check. If the same thing blocks you again,',
    ' say so plainly rather than working around it silently.',
  );
  return lines.join('');
}
