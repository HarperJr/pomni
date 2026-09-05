import {
  assertRunnable,
  isOrchestrator,
  type Agent,
} from '../domain/agent.js';
import { NotFoundError, ValidationError } from '../domain/errors.js';
import { layout } from '../domain/layout.js';
import {
  ORCHESTRATOR_PROTOCOL,
  parseDelegations,
  summarise,
  type PipelineFilter,
  type PipelineRun,
  type PipelineRunDetail,
  type PipelineStep,
} from '../domain/pipeline.js';
import { ulid } from '../domain/ulid.js';
import { chooseWorkflow, entryAgent, findAgent, rosterFor, type Workflow } from '../domain/workflow.js';
import type { Artifact } from '../domain/pipeline.js';
import type { Clock, DocStore, EventBus, GitPort, Logger, PipelineStore } from '../ports/index.js';
import type { BacklogService } from './backlog-service.js';
import type { ProjectService } from './project-service.js';
import type { RunService } from './run-service.js';
import type { ProviderService } from './provider-service.js';
import type { RepoService } from './repo-service.js';
import type { WorkflowService } from './workflow-service.js';

export interface StartRunInput {
  projectId: string;
  task: string;
  workflowId?: string;
  itemId?: string;
  /** Repo whose working directory agents run in. Defaults to the project's first repo. */
  repoId?: string;
  providerId?: string;
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

  constructor(
    private readonly docs: DocStore,
    private readonly store: PipelineStore,
    private readonly projects: ProjectService,
    private readonly workflows: WorkflowService,
    private readonly repos: RepoService,
    private readonly providers: ProviderService,
    private readonly backlog: BacklogService,
    private readonly runs: RunService,
    private readonly git: GitPort,
    private readonly clock: Clock,
    private readonly events: EventBus,
    private readonly logger: Logger,
  ) {}

  async start(input: StartRunInput): Promise<StartRunResult> {
    const task = input.task.trim();
    if (!task) throw new ValidationError('a run needs a task');

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
    const cwd = await this.workingDir(input.projectId, input.repoId);

    const run: PipelineRun = {
      id: ulid(this.clock.now().getTime()),
      projectId: input.projectId,
      workflowId: chosen.id,
      workflowName: chosen.name,
      providerId: provider.id,
      itemId: input.itemId ?? null,
      task,
      status: 'running',
      result: null,
      error: null,
      gateStatus: 'skipped',
      gateSummary: null,
      itemStatus: null,
      startedAt: this.clock.iso(),
      endedAt: null,
      durationMs: null,
      costUsd: null,
    };

    await this.docs.ensureDir(layout.pipelineDir(run.id));
    await this.store.insertRun(run);

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
      await this.moveItem(run, 'in_progress', 'agent run started');
    }

    return { run, completion: this.execute(run, chosen, cwd) };
  }

  async get(id: string): Promise<PipelineRunDetail> {
    const run = await this.store.getRun(id);
    if (!run) throw new NotFoundError('run', id);
    return {
      ...run,
      steps: await this.store.steps(id),
      artifacts: await this.store.artifacts(id),
    };
  }

  async list(filter: PipelineFilter): Promise<PipelineRun[]> {
    return this.store.listRuns(filter);
  }

  /** Ask a run to stop. In-flight agents finish; nothing new is delegated. */
  async cancel(id: string): Promise<PipelineRun> {
    const run = await this.store.getRun(id);
    if (!run) throw new NotFoundError('run', id);
    if (run.status !== 'running') return run;

    this.cancelled.add(id);
    this.events.emit({ type: 'pipeline.cancelling', runId: id });
    return run;
  }

  // -------------------------------------------------------------------------

  private async execute(
    run: PipelineRun,
    workflow: Workflow,
    cwd: string | undefined,
  ): Promise<PipelineRun> {
    const started = Date.now();
    let cost = 0;

    try {
      const entry = entryAgent(workflow);
      const result = await this.runAgent({
        run,
        workflow,
        agent: entry,
        task: run.task,
        parentStepId: null,
        depth: 0,
        cwd,
        addCost: (amount) => {
          cost += amount;
        },
      });

      let finished: PipelineRun = {
        ...run,
        status: this.cancelled.has(run.id) ? 'cancelled' : 'passed',
        result,
        endedAt: this.clock.iso(),
        durationMs: Date.now() - started,
        costUsd: cost || null,
      };

      await this.captureArtifacts(finished, cwd);

      // The gate is what turns "the agents finished" into "the change works". Without it a
      // pipeline can only report its own opinion of itself.
      if (finished.status === 'passed') {
        finished = await this.runGate(finished);
        if (finished.itemId) {
          const moved =
            finished.gateStatus === 'failed'
              ? await this.moveItem(finished, 'blocked', 'the gate did not pass after the agent run')
              : await this.moveItem(finished, 'in_review', 'agent run finished and the gate passed');
          finished = { ...finished, itemStatus: moved };
        }
      }

      await this.store.updateRun(run.id, finished);
      this.finish(finished);
      return finished;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.debug(`pipeline ${run.id} failed`, message);

      const failed: PipelineRun = {
        ...run,
        status: this.cancelled.has(run.id) ? 'cancelled' : 'failed',
        error: message,
        endedAt: this.clock.iso(),
        durationMs: Date.now() - started,
        costUsd: cost || null,
      };

      if (failed.itemId) {
        failed.itemStatus = await this.moveItem(failed, 'blocked', `agent run failed: ${message}`);
      }

      await this.store.updateRun(run.id, failed);
      this.finish(failed);
      return failed;
    } finally {
      this.cancelled.delete(run.id);
    }
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
    addCost: (amount: number) => void;
  }): Promise<string> {
    const { run, workflow, agent, task, parentStepId, depth, cwd, addCost } = context;
    assertRunnable(agent);

    const orchestrating = isOrchestrator(agent);
    const roster = orchestrating ? rosterFor(workflow, agent) : [];

    const { port, model, provider } = await this.providers.portFor(agent.struggle, {
      provider: run.providerId,
      // Only give an agent a working directory when it is allowed to touch files; an
      // orchestrator with a repo tends to start doing the work itself.
      cwd: agent.tools.files || agent.tools.run ? cwd : undefined,
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
    const transcript: string[] = [`# Task\n\n${task}`];
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      const system = orchestrating
        ? [
            agent.prompt,
            '',
            ORCHESTRATOR_PROTOCOL,
            '',
            '## Agents you can delegate to',
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

      let conversation = task;
      let answer = '';

      for (let round = 0; round < (orchestrating ? MAX_ROUNDS : 1); round += 1) {
        if (this.cancelled.has(run.id)) {
          answer = answer || 'The run was cancelled before this agent finished.';
          break;
        }

        const result = await port.complete({
          model,
          system,
          messages: [{ role: 'user', content: conversation }],
          adaptiveThinking: provider.kind !== 'claude-code',
          effort: orchestrating ? 'high' : 'medium',
          maxTokens: 16_000,
        });

        inputTokens += result.usage.inputTokens;
        outputTokens += result.usage.outputTokens;
        transcript.push(`\n# Reply (round ${round + 1})\n\n${result.text}`);

        this.events.emit({
          type: 'pipeline.step.output',
          runId: run.id,
          stepId: step.id,
          chunk: result.text,
        });

        const delegations = orchestrating ? parseDelegations(result.text) : null;
        if (!delegations) {
          answer = result.text;
          break;
        }

        // Run this round's delegations, bounded — an orchestrator that asks for twelve
        // agents at once should not open twelve sessions.
        const results: string[] = [];
        for (let index = 0; index < delegations.length; index += MAX_PARALLEL) {
          const batch = delegations.slice(index, index + MAX_PARALLEL);

          const settled = await Promise.all(
            batch.map(async (delegation) => {
              const target = findAgent(workflow, delegation.agent);
              if (!target || !roster.some((candidate) => candidate.id === target.id)) {
                return `### ${delegation.agent}\n\nThere is no such agent in your roster. Delegate only to the ids listed above.`;
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
                  addCost,
                });
                return `### ${target.name} (\`${target.id}\`)\n\n${output}`;
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

        conversation = [
          'Here is what came back from the agents you delegated to.',
          '',
          ...results,
          '',
          'Delegate again if you still need something, or give your final answer as prose.',
        ].join('\n');

        if (round === MAX_ROUNDS - 1) {
          answer = 'This orchestrator kept delegating and ran out of rounds without answering.';
        }
      }

      await this.docs.write(layout.pipelineStepLog(run.id, step.id), transcript.join('\n'));

      const done: PipelineStep = {
        ...step,
        status: this.cancelled.has(run.id) ? 'cancelled' : 'done',
        output: answer,
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

      return answer;
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
   * Run the project's gate against whatever the agents changed.
   *
   * Deliberately after the pipeline rather than inside it: an orchestrator asked to verify
   * its own work grades itself, and the run store already knows how to answer the question
   * properly.
   */
  private async runGate(run: PipelineRun): Promise<PipelineRun> {
    try {
      const report = await this.runs.gate(run.projectId, 'default', {});

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
      this.logger.debug(`could not move ${run.itemId} to ${to}`, error);
      return null;
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

  private async workingDir(projectId: string, repoId?: string): Promise<string | undefined> {
    const repos = await this.repos.listResolved(projectId);
    const usable = repos.filter((repo) => repo.workingDirExists);
    if (usable.length === 0) return undefined;

    if (repoId) {
      const named = usable.find((repo) => repo.id === repoId);
      if (!named) throw new ValidationError(`repo '${repoId}' has no working copy`);
      return named.workingDir;
    }
    return usable[0]?.workingDir;
  }
}
