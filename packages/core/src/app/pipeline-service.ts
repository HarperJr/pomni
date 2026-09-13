import {
  assertRunnable,
  isOrchestrator,
  type Agent,
} from '../domain/agent.js';
import {
  COMMENTS_CONTEXT_NAME,
  COMMENT_PROTOCOL,
  parseComments,
  type CommentsSince,
} from '../domain/comment.js';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import { layout } from '../domain/layout.js';
import {
  contextBytes,
  fileUrl,
  HUMAN_AGENT_ID,
  parseVerdict,
  VERDICT_PROTOCOL,
  MAX_CONTEXT_BYTES,
  MAX_CONTEXT_FILE_BYTES,
  HANDOVER_PROTOCOL,
  ORCHESTRATOR_PROTOCOL,
  looksLikeDelegation,
  parseDelegations,
  bytes,
  parseHandover,
  summarise,
  TOUCHED_FILES_CONTEXT_NAME,
  touchedFilesContext,
  withBrief,
  withSiblings,
  withContext,
  type AgentReport,
  type ContextFile,
  type PipelineFilter,
  type PipelineRun,
  type PipelineRunDetail,
  type PipelineStep,
  type PromptParts,
  type Question,
  type Verdict,
} from '../domain/pipeline.js';
import { detectProvider } from '../domain/source.js';
import { findings, signalsFor, type Finding, type Signal } from '../domain/signals.js';
import { toolBriefing } from '../domain/tool.js';
import { ulid } from '../domain/ulid.js';
import { chooseWorkflow, entryAgent, findAgent, rosterFor, type Workflow } from '../domain/workflow.js';
import {
  itemBranch,
  resolveInside,
  runBranch,
  worktreeEligibility,
  type WorktreeProbe,
} from '../domain/worktree.js';
import { KNOWN_EDITORS } from '../domain/config.js';
import { flowOf } from '../domain/project.js';
import type { Artifact, ArtifactDiff } from '../domain/pipeline.js';
import type { ProjectPolicy } from '../domain/project.js';
import type { Provider } from '../domain/provider.js';
import type { ResolvedRepo } from '../domain/repo.js';
import type {
  Clock,
  DesktopPort,
  DocStore,
  EventBus,
  ForgePort,
  FsProbe,
  GitPort,
  MergeRequestRef,
  LlmMessage,
  LlmUsage,
  LlmPort,
  Logger,
  PipelineStore,
} from '../ports/index.js';
import type { BacklogService } from './backlog-service.js';
import type { CommentService } from './comment-service.js';
import type { ProjectService } from './project-service.js';
import type { WorkspaceService } from './workspace-service.js';
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
  /**
   * What asked for this run, when it was not a person asking directly. `flow:ready` is the
   * project's own flow, because an item entered that state.
   */
  startedBy?: string;
  /**
   * Where the previous attempt started, so this one's comments file can say which notes it
   * had already seen. Only `rerun()` sets it; a first attempt has nothing to be since.
   */
  commentsSince?: CommentsSince;
}

export interface StartRunResult {
  run: PipelineRun;
  completion: Promise<PipelineRun>;
  /** Steps a resume answered from the previous attempt instead of running again. */
  reused?: number;
}

/** Where an agent works, and everything else it may read. See `workspace`. */
export interface AgentWorkspace {
  cwd: string | undefined;
  dirs: string[];
  repos: ResolvedRepo[];
}

export interface RunOneAgentInput {
  projectId: string;
  /** Which attached workflow the agent belongs to. Omitted, every attached one is searched. */
  workflowId?: string;
  agentId: string;
  task: string;
  /** A `/skill`'s instructions, loaded for this turn only. */
  skillPrompt?: string;
  providerId?: string;
}

export interface RunOneAgentResult {
  text: string;
  /** The workflow the agent was actually found in — the answer to a bare `@agent`. */
  workflowId: string;
  providerId: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null };
}

/** How many delegate-and-review rounds one orchestrator gets before we stop it. */
/**
 * How many delegate-and-review rounds one orchestrator gets.
 *
 * Lowered from eight after measuring: rounds seven and eight were spent on second and
 * third review passes that changed nothing, and one such run cost $23 against $0.09 for
 * the same class of task done in six steps. A tighter budget is also a clearer
 * instruction — decide, rather than keep looking.
 */
const MAX_ROUNDS = 5;
/**
 * How many times one orchestrator may delegate to the same agent in a run.
 *
 * The ledger already refuses a *word-for-word* repeat, which a model steps around by
 * rephrasing. One run today asked test-author four times, reviewer three, domain-designer
 * three, and ran for 107 minutes without an answer. A cap converts that from an expensive
 * loop into a plain refusal the orchestrator has to deal with.
 */
const MAX_PER_AGENT = 2;

/** What a resumed run already knows: answers by delegation, and how often each agent ran. */
interface Seed {
  answered: Map<string, string>;
  useCount: Map<string, number>;
}

/**
 * What a run has spent so far, against what its project allows.
 *
 * One object for the whole run, passed down the delegation tree rather than kept per agent:
 * `policy.maxTurns` is a limit on the run, which is precisely what makes it a different thing
 * from `Provider.maxTurns` — that one bounds a single agent's session and is enforced by the
 * provider. A tree of agents each staying under its own ceiling is how $5.87 was spent against
 * a $5 project budget with nothing to point at.
 *
 * A resume starts a fresh one at zero. The steps it reuses were paid for by the earlier
 * attempt and are answered from disk without opening a session, so charging them again would
 * stop a resumed run for money it is not spending — and the stop messages tell a person to
 * raise the ceiling and resume, which that would make impossible.
 */
interface RunBudget {
  cost: number;
  /** Agent steps started, all agents together. */
  steps: number;
  /** The sentence explaining the stop, once one has happened. Null while the run may go on. */
  stopped: string | null;
  /**
   * Work the run planned and never did — a delegation block that could not be read.
   *
   * Kept beside the budget because it is the other run-wide fact a step discovers and the
   * finish has to know about. A run carrying one did not pass, whatever its last agent said:
   * the orchestrator asked for something and nothing came back to tell it otherwise.
   */
  dropped: string[];
}
/** How many agents one round may run at once. */
const MAX_PARALLEL = 4;

/**
 * How many agent sessions one run may open in total.
 *
 * The round and per-agent caps bound the shape of the tree; this bounds its size. A run
 * that has opened this many sessions has either done the work or is not going to, and
 * the seventeen-step run that cost $23 is the case this exists to stop.
 */
const MAX_SESSIONS = 12;

/** The most runs any one listing returns, and how many when nobody says. */
const MAX_LISTED = 200;
const DEFAULT_LISTED = 30;
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
    private readonly forge: ForgePort,
    private readonly comments: CommentService,
    private readonly fs: FsProbe,
    private readonly pomni: WorkspaceService,
    private readonly desktop: DesktopPort,
  ) {}

  async start(input: StartRunInput): Promise<StartRunResult> {
    let task = input.task.trim();
    if (!task) throw new ValidationError('a run needs a task');

    await this.projects.getRef(input.projectId);

    // What the item says it changes, given to the agents instead of kept for the scheduler.
    // An author who is not told which files a change is about pays to find them: on the run
    // that produced this, one spent 2.4M input tokens looking for two the item had named.
    const touched = input.itemId ? await this.touchedFiles(input.projectId, input.itemId) : null;

    // What kind of change this is, told to the orchestrator so it can size the team to it.
    // A one-file fix does not want the full roster, and until now nothing said which kind of
    // item a run was for: the task was the item's title and body, and `type` — which every
    // item carries — reached nobody. Composed here rather than in each surface, because the
    // CLI, the browser and the MCP server each built the task themselves and only one of them
    // would ever have been updated.
    const kind = input.itemId ? await this.itemKind(input.projectId, input.itemId) : null;
    if (kind) task = [kind, '', task].join('\n');
    // What people and earlier agents have said about the item since it was specced. Rebuilt
    // from the store on every attempt, never carried: a note written between two attempts must
    // reach the second one, and one deleted between them must not survive in a copy.
    const notes = input.itemId
      ? await this.comments.runContext(
          input.itemId,
          input.commentsSince ? { since: input.commentsSince } : {},
        )
      : undefined;
    // Replaced, never stacked: a rerun carries the previous run's context forward, and that
    // already holds a list under this name. Appending a second one would rename it to
    // `touched-files.md (2)` and charge every agent for both copies of the same paths.
    const context = normaliseContext([
      ...(input.context ?? []).filter(
        (file) =>
          (touched ? file.name !== TOUCHED_FILES_CONTEXT_NAME : true) &&
          file.name !== COMMENTS_CONTEXT_NAME,
      ),
      ...(touched ? [touched] : []),
      ...(notes ? [notes] : []),
    ]);

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

    // Every agent, not just the entry one. Delegation is lazy, so an agent pointed at a
    // provider that is gone, switched off, or cannot hand it the tools its prompt promises
    // would otherwise be found by the orchestrator four steps in — after the run has paid for
    // those steps, and with the failure reported as that agent's finding.
    for (const agent of chosen.agents) {
      await this.providers.assertAgentCanRun(agent, agent.provider ?? provider.id);
    }

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
    // The branch says what the work is: `feature/POMN-1/main`, not a ULID nobody can read.
    // Resolved before the claim so a backlog read cannot happen inside the critical section.
    const branch = await this.branchFor(input.projectId, input.itemId ?? null, runId);

    const { run, taken, workspace } = await this.claim(input.projectId, async () => {
      await this.assertNotInUse(input.projectId, isolated);
      const taken = await this.worktrees.take(input.projectId, runId, isolated, { pid, branch });
      const workspace = this.workspace(usable, taken.dirs, input.repoId);

      const claimed: PipelineRun = {
        id: runId,
        projectId: input.projectId,
        workflowId: chosen.id,
        workflowName: chosen.name,
        providerId: provider.id,
        itemId: input.itemId ?? null,
        rerunOf: input.rerunOf ?? null,
        startedBy: input.startedBy ?? null,
        // Filled in by `deliver()` when there is a commit to point at. Null until then, which
        // is honest: a run that has not committed has no branch worth naming.
        branch: null,
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
        inputTokens: 0,
        outputTokens: 0,
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

  /**
   * Start the workflow a column names, when an item enters it.
   *
   * The board's answer to "every run is launched by a person typing a command, even when the
   * rule is obvious". An item reaching `ready` should be picked up; an item reaching
   * `in_review` should be reviewed. `onEnter` is where a project says so once.
   *
   * Null whenever nothing should start, and each of those cases is a decision:
   *
   * - **The state names no workflow.** The default, and the built-in flow names none anywhere.
   *   An agent run costs real money; starting one has to be something somebody wrote down.
   * - **A run of that same workflow is already going for this item.** An item dragged in and
   *   out of a column must not spawn a run each time. Deliberately *that workflow* rather than
   *   any run: a dev run ending is what moves the item to review, and its row still says
   *   `running` at that moment — a wider guard would break the chain it is meant to protect.
   * - **The workflow is not attached to the project, or is not ready to run.** Reported and
   *   skipped rather than thrown: the move already happened and was correct, and failing it
   *   afterwards would leave the board disagreeing with the flow over something neither did
   *   wrong.
   *
   * The task is the item's own title and body, exactly as a person starting a run from the
   * board would get: one task, composed in one place, whoever asked for it.
   */
  async onItemEntered(
    projectId: string,
    itemId: string,
    to: string,
  ): Promise<StartRunResult | null> {
    const project = await this.projects.getRef(projectId).catch(() => null);
    if (!project) return null;

    const state = flowOf(project.data).states.find((entry) => entry.name === to);
    if (!state?.onEnter) return null;

    const item = await this.backlog.get(projectId, itemId).catch(() => null);
    if (!item) return null;

    const running = await this.store.listRuns({ projectId, status: 'running' });
    if (running.some((run) => run.itemId === itemId && run.workflowId === state.onEnter)) {
      this.logger.debug(
        `'${to}' names ${state.onEnter}, and ${itemId} already has one running — not starting a second`,
      );
      return null;
    }

    try {
      return await this.start({
        projectId,
        itemId,
        workflowId: state.onEnter,
        task: [item.title, '', item.body].join('\n').trim(),
        startedBy: `flow:${to}`,
      });
    } catch (error) {
      // The move stands. A column naming a workflow that cannot run is a configuration
      // problem to fix, not a reason to undo work that was correctly moved.
      this.logger.warn(
        `'${to}' names workflow '${state.onEnter}' but it did not start for ${itemId}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      return null;
    }
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

  /**
   * What one file in a run's artifacts actually changed, as a unified diff.
   *
   * Fetched a file at a time, on request. A run that touched forty files would otherwise put
   * forty diffs on the wire to render a list of forty names, and nobody opens forty of them.
   *
   * Where it comes from depends on whether the run is still going, and the two answers are
   * different things rather than two ways of getting the same one:
   *
   * - **In flight**: the worktree still exists and the change is sitting in it uncommitted.
   *   That is the only place it is, so the diff is the working copy's own.
   * - **Finished**: the worktree has been removed — that is what a clean delivery does — and
   *   the change lives on the branch the run committed it to. `base...branch` is what that
   *   branch added, which is what someone reviewing the run is asking about.
   *
   * A run that committed nothing and has no worktree left has nowhere to answer from, and
   * says so rather than returning an empty diff, which would read as "nothing changed".
   */
  async diff(runId: string, artifactId: string): Promise<ArtifactDiff> {
    const run = await this.get(runId);
    const artifact = run.artifacts.find((entry) => entry.id === artifactId);

    if (!artifact) throw new NotFoundError(`artifact on run ${runId}`, artifactId);
    if (artifact.kind !== 'file' || !artifact.path) {
      throw new ValidationError(`artifact '${artifactId}' is not a file`);
    }

    const repos = (await this.repos.listResolved(run.projectId)).filter(
      (repo) => repo.workingDirExists,
    );

    // Where the same file can be read on the forge, when the run left something there to read.
    // Offered beside the local diff rather than instead of it: one is what this machine has,
    // the other is what everybody else can see.
    const remoteOf = (repo: ResolvedRepo): string | null =>
      repo.source.kind === 'git' ? repo.source.url : (repo.vcs?.remote ?? null);
    const url = fileUrl(repos[0] ? remoteOf(repos[0]) : null, run.branch, artifact.path);
    const editor = await this.editor();
    const about = { path: artifact.path, change: artifact.change, url, editor };

    const held = await this.worktrees.list({ runId: run.id, status: 'active' });
    for (const worktree of held) {
      const diff = await this.git.diff(worktree.path, artifact.path);
      return { ...about, source: 'worktree', ...diff };
    }

    if (!run.branch) {
      throw new ValidationError(
        `run ${runId} has no worktree left and committed nothing, so there is no diff to show` +
          ` for '${artifact.path}'`,
      );
    }

    for (const repo of repos) {
      if (!(await this.git.branchExists(repo.workingDir, run.branch))) continue;

      // Three dots: what the branch added, not everything that has happened on the base since
      // it was cut. A run is answerable for the first and not the second.
      // The branch the run was cut from. `HEAD` is the honest fallback when the repo has
      // never reported one: it diffs against whatever the clone has checked out, which is
      // what a person looking at that directory would compare against themselves.
      const base = repo.vcs?.defaultBranch ?? 'HEAD';
      const diff = await this.git.diff(repo.workingDir, artifact.path, {
        range: `${base}...${run.branch}`,
      });
      return { ...about, source: 'branch', ...diff };
    }

    throw new NotFoundError(
      `a repo holding '${run.branch}', without which there is nowhere to read` +
        ` '${artifact.path}' from`,
      run.projectId,
    );
  }

  /**
   * Open one of a run's files on the machine Pomni is running on.
   *
   * This starts a program, so it is worth being exact about what it will and will not do.
   *
   * The caller names an **artifact**, never a path. The path comes from the run's own record
   * of what it changed, joined to a working directory this project resolved itself. A request
   * cannot ask for a file that is not in a run's artifacts, and cannot describe a file at all.
   *
   * The join is then checked rather than trusted: `..` inside a recorded path would climb out
   * of the repo, and a symlinked working directory would resolve elsewhere, so the resolved
   * result must still sit inside the resolved directory or nothing is opened. That check is
   * the reason this is a method and not three lines in a route.
   *
   * What is opened is the file **as it is on disk now**. For a run still in flight that is
   * exactly what it wrote. For a finished run whose branch is not checked out, it is the base
   * version — or nothing at all, if the run created it — and that says so rather than opening
   * the wrong thing quietly.
   */
  async openArtifact(runId: string, artifactId: string, mode: 'editor' | 'reveal'): Promise<void> {
    const { path } = await this.locate(runId, artifactId);

    if (!(await this.fs.exists(path))) {
      throw new NotFoundError(
        'that file on disk — the run may have created it on a branch that is not checked out',
        path,
      );
    }

    if (mode === 'reveal') {
      await this.desktop.reveal(path);
      return;
    }

    const command = await this.editor();
    if (!command) {
      throw new ValidationError(
        'no editor is configured and none of ' +
          KNOWN_EDITORS.join(', ') +
          " is on PATH. Set one with 'pomni workspace edit --editor <command>'.",
      );
    }

    await this.desktop.open(command, path);
  }

  /**
   * The editor that would be used, or null when there is none.
   *
   * Asked before anything is offered, so the button can say what it will do instead of failing
   * when pressed. A configured command still has to be findable: a setting naming an editor
   * that has since been uninstalled is worth reporting as "no editor", not as an error later.
   */
  private async editor(): Promise<string | null> {
    const configured = (await this.pomni.config()).editor.command;
    if (configured) return (await this.desktop.canRun(configured)) ? configured : null;

    for (const candidate of KNOWN_EDITORS) {
      if (await this.desktop.canRun(candidate)) return candidate;
    }
    return null;
  }

  /**
   * Where one of a run's files is on this machine, and which directory vouches for it.
   *
   * The same two sources as `diff`, in the same order and for the same reason: a run in flight
   * has a worktree and a finished one has only the repo it delivered to.
   */
  private async locate(runId: string, artifactId: string): Promise<{ path: string; dir: string }> {
    const run = await this.get(runId);
    const artifact = run.artifacts.find((entry) => entry.id === artifactId);

    if (!artifact) throw new NotFoundError(`artifact on run ${runId}`, artifactId);
    if (artifact.kind !== 'file' || !artifact.path) {
      throw new ValidationError(`artifact '${artifactId}' is not a file`);
    }

    const held = await this.worktrees.list({ runId: run.id, status: 'active' });
    const repos = (await this.repos.listResolved(run.projectId)).filter(
      (repo) => repo.workingDirExists,
    );

    const dirs = [
      ...held.map((worktree) => worktree.path),
      ...repos.map((repo) => repo.workingDir),
    ];

    for (const dir of dirs) {
      const contained = resolveInside(this.fs.resolve(dir), artifact.path);
      if (contained) return { path: contained, dir };
    }

    throw new ValidationError(
      `'${artifact.path}' does not resolve to somewhere inside a directory this project owns,` +
        ' so it will not be opened',
    );
  }

  /**
   * Runs, newest first, never more than {@link MAX_LISTED} of them.
   *
   * The cap belongs here rather than only on the HTTP route: the route rejected an
   * over-large limit, which is a different thing from bounding the answer, and left the
   * CLI and every other caller unbounded.
   */
  /**
   * What a backlog item has cost, across every run against it.
   *
   * Reruns included, deliberately. One task attempted three times cost the sum of three
   * attempts, and that is the number that answers whether the agents were worth it — the
   * last attempt's figure flatters every task that needed more than one.
   *
   * `costUsd` is null when no run reported one, never 0: a provider that does not report cost
   * is not a provider that ran for free, and a zero here would be read as the second.
   */
  async itemSpend(
    projectId: string,
    itemId: string,
  ): Promise<{ runs: number; inputTokens: number; outputTokens: number; costUsd: number | null }> {
    const runs = await this.store.listRuns({ projectId, itemId, limit: MAX_LISTED });

    let costUsd: number | null = null;
    let inputTokens = 0;
    let outputTokens = 0;

    for (const run of runs) {
      inputTokens += run.inputTokens;
      outputTokens += run.outputTokens;
      if (run.costUsd !== null) costUsd = (costUsd ?? 0) + run.costUsd;
    }

    return { runs: runs.length, inputTokens, outputTokens, costUsd };
  }

  /**
   * What keeps going wrong in a workflow, and what only went wrong once.
   *
   * Reads history rather than instrumenting the future: every fact a signal is built from is
   * already recorded, so this works on the runs that have already happened instead of only on
   * the ones after it ships.
   */
  async signals(
    projectId: string,
    workflowId?: string,
  ): Promise<{ signals: Signal[]; findings: Finding[] }> {
    const runs = await this.store.listRuns({
      projectId,
      ...(workflowId ? { workflowId } : {}),
      limit: MAX_LISTED,
    });

    const all: Signal[] = [];
    for (const run of runs) {
      all.push(...signalsFor(run, await this.store.steps(run.id)));
    }

    return { signals: all, findings: findings(all) };
  }

  async list(filter: PipelineFilter): Promise<PipelineRun[]> {
    return this.store.listRuns({
      ...filter,
      limit: Math.min(filter.limit ?? DEFAULT_LISTED, MAX_LISTED),
    });
  }

  /**
   * The paths an item declares, as a context file the whole run can see.
   *
   * A context file rather than a line assembled onto each prompt: it is then stored with the
   * run, survives a resume, and shows in the console as something a person can read, which is
   * the same treatment the run's other composed information already gets.
   */
  /**
   * One line telling the orchestrator what kind of item this is.
   *
   * Prose rather than a field, because it lands in the brief every agent reads and a bare
   * `type: bug` invites an agent to parse it. What the lead does with it is the lead's spec's
   * business — this only makes the fact available, which it was not before.
   */
  private async itemKind(projectId: string, itemId: string): Promise<string | null> {
    const item = await this.backlog.get(projectId, itemId).catch(() => null);
    if (!item) return null;
    return `This is a **${item.type}** (${item.id}). Size the team to that.`;
  }

  private async touchedFiles(projectId: string, itemId: string): Promise<ContextFile | null> {
    // An item that cannot be read is not a reason to refuse to run: the run has a task, and
    // the list is a head start rather than a requirement.
    const item = await this.backlog.get(projectId, itemId).catch(() => null);
    return touchedFilesContext(item?.touches) ?? null;
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

    // Only what a person attached. An agent's handover was a decision taken inside a run that
    // did not finish; carrying it into the next attempt hands the new agents a conclusion and
    // calls it source material, so the second attempt inherits the first one's mistake and
    // cannot see that it did.
    const carried = previous.context.filter(
      (file) => file.name !== ATTEMPT_FILE && file.origin !== 'handover',
    );

    return this.start({
      projectId: previous.projectId,
      task: previous.task,
      workflowId: previous.workflowId,
      itemId: previous.itemId ?? undefined,
      providerId: previous.providerId,
      rerunOf: previous.id,
      // What the last attempt had in front of it, so a note written since then is presented as
      // new rather than blended in with the ones it already acted on.
      commentsSince: { at: previous.startedAt, runId: previous.id },
      context: [...carried, { name: ATTEMPT_FILE, content: describeAttempt(previous) }],
    });
  }

  /**
   * Carry on a run that was interrupted, without paying for what it already did.
   *
   * Not a second run: the same row, the same tree, the same item. Every delegation that
   * finished is returned from its stored answer, so what gets re-run is the step that was
   * still going when the process died — and the orchestrator's own turns, which are the
   * cheap part.
   *
   * `rerun` remains the other answer: resume says carry on, rerun says try again knowing how
   * that went.
   */
  async resume(runId: string, note?: string): Promise<StartRunResult> {
    const previous = await this.get(runId);

    if (previous.status === 'running') {
      throw new ValidationError('that run is still going');
    }
    if (previous.status === 'passed' && previous.outcome === 'done') {
      throw new ValidationError('that run finished — use `task rerun` to do it again');
    }

    const workflow = (await this.workflows.get(previous.workflowId)) as Workflow;
    this.workflows.assertRunnable(workflow);

    // The same pass as `start`: a provider may have been disabled or removed since the run
    // was interrupted, and resuming into it would fail at the first step that needed it.
    for (const agent of workflow.agents) {
      await this.providers.assertAgentCanRun(agent, agent.provider ?? previous.providerId);
    }

    const seed: Seed = { answered: new Map(), useCount: new Map() };
    const finished: Array<{ agentId: string; task: string }> = [];
    let reused = 0;

    for (const step of previous.steps) {
      // Only completed delegations. The entry orchestrator's own step is the run itself, and
      // a step that was still running never recorded an answer worth keeping.
      if (!step.parentStepId || step.status !== 'done' || !step.output) continue;

      seed.answered.set(memoKey(step.agentId, step.task), step.output);
      seed.useCount.set(step.agentId, (seed.useCount.get(step.agentId) ?? 0) + 1);
      finished.push({ agentId: step.agentId, task: step.task });
      reused += 1;
    }

    // Answers a person already gave are worth more than the tokens: an answered question is
    // returned from the ledger rather than put to them a second time.
    for (const question of previous.questions) {
      if (question.status !== 'answered' || !question.answer) continue;
      seed.answered.set(memoKey(HUMAN_AGENT_ID, question.question), question.answer);
    }

    const usable = (await this.repos.listResolved(previous.projectId)).filter(
      (repo) => repo.workingDirExists,
    );
    // Reclaimed, not taken: this run's answers were written in this run's own worktree, and
    // replaying them anywhere else describes files that are not there.
    const taken = await this.worktrees.reclaim(previous.projectId, previous.id, usable, {
      pid: process.pid,
      branch: await this.branchFor(previous.projectId, previous.itemId, previous.id),
    });

    if (taken.lost.length > 0 && reused > 0) {
      // Name the branches the rows actually hold rather than deriving one: after the rename a
      // run's branch depends on the item it was for, and telling someone to restore a branch
      // that never existed is worse than telling them nothing.
      const lostBranches = (await this.worktrees.list({ runId: previous.id }))
        .filter((worktree) => taken.lost.includes(worktree.repoId))
        .map((worktree) => worktree.branch);

      throw new ValidationError(
        `cannot resume ${runId}: ${taken.lost.join(', ')} lost the worktree this run was` +
          ` working in, so its ${reused} finished step${reused === 1 ? '' : 's'} describe files` +
          ' that are no longer there. Use `task rerun` to start again from the task, or restore' +
          ` ${lostBranches.length > 0 ? `the branch ${lostBranches.join(', ')}` : 'the branch it was on'}` +
          ' and resume once it is back.',
      );
    }

    const workspace = this.workspace(usable, taken.dirs, undefined);

    // What the resume is and what changed since, as a context file: the orchestrator reads it
    // on its first turn, and it is the same chip a person already sees on the run.
    // Recomposed rather than carried: the item may have declared another path since the run
    // was interrupted. Matched by name and replaced, so a resumed run holds one list and not
    // one per resume — every agent in the tree pays for this text.
    const touched = previous.itemId
      ? await this.touchedFiles(previous.projectId, previous.itemId)
      : null;
    const carried = previous.context.filter(
      (file) =>
        file.name !== RESUME_FILE && !(touched && file.name === TOUCHED_FILES_CONTEXT_NAME),
    );
    const reopened: PipelineRun = {
      ...previous,
      context: [
        ...carried,
        ...(touched ? [touched] : []),
        {
          name: RESUME_FILE,
          content: describeResume(finished, taken.reclaimed.length, note),
        },
      ],
      status: 'running',
      pid: process.pid,
      error: null,
      endedAt: null,
      durationMs: null,
      outcome: 'unknown',
      unmet: [],
    };

    await this.store.updateRun(runId, reopened);
    this.owned.add(runId);
    this.logger.info(`resuming ${runId}: ${reused} answered steps reused`);

    this.events.emit({
      type: 'pipeline.started',
      runId,
      projectId: reopened.projectId,
      workflowId: reopened.workflowId,
      task: reopened.task,
    });

    return {
      run: reopened,
      reused,
      completion: this.execute(reopened, workflow, workspace, taken.dirs, usable, seed),
    };
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
      await this.closeStranded(id);

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

  /**
   * Put one question to one agent, and give back what it said.
   *
   * Deliberately not a run: no `PipelineRun` row, no steps, no worktree, no project claim, no
   * backlog move, and no delegation loop even if the agent happens to be an orchestrator. A
   * chat asking `@codebase-scout` where something lives wants an answer, and paying for a
   * run's whole apparatus to get one would also mean claiming repos out from under whatever
   * is actually running in them. Starting a workflow is what `start` is for; the two must not
   * be confused, so this cannot quietly become one.
   *
   * Because there is no run there are no `pipeline.*` events either — nothing is watching a
   * run that does not exist, and the caller announces its own turn.
   *
   * The agent works in the repos' own directories rather than a copy of them, and that is
   * precisely why an agent that can write is refused here. Without a run there is no worktree
   * to contain it, so `files` or `run` from a chat means editing the person's own tree with
   * nothing recording that it happened and nobody having confirmed it — while every other write
   * a chat can reach waits for a confirmation. A chat reads; a run writes. An agent granted
   * either is told to be started as a run instead, which is the surface that has the worktree,
   * the steps and the log for it.
   */
  async runOneAgent(input: RunOneAgentInput): Promise<RunOneAgentResult> {
    const task = input.task.trim();
    if (!task) throw new ValidationError('an agent needs something to do');

    await this.projects.getRef(input.projectId);

    const attached = await this.workflows.forProject(input.projectId);
    if (attached.length === 0) {
      throw new ValidationError(
        `no workflow is attached to '${input.projectId}' — attach one first`,
      );
    }

    const searched = input.workflowId
      ? attached.filter((candidate) => candidate.id === input.workflowId)
      : attached;
    if (searched.length === 0) {
      throw new ValidationError(
        `workflow '${input.workflowId}' is not attached to '${input.projectId}' — attached: ${attached
          .map((candidate) => candidate.id)
          .join(', ')}`,
      );
    }

    // Authority is the project's, never the name that was typed. An agent that exists in some
    // workflow nobody attached here is not an agent of this project, and saying which ones are
    // is more use than saying no.
    const found = searched
      .map((candidate) => ({ workflow: candidate, agent: findAgent(candidate, input.agentId) }))
      .find((entry) => entry.agent !== null);

    if (!found?.agent) {
      const available = searched.flatMap((candidate) =>
        candidate.agents.map((agent) => `${candidate.id}/${agent.id}`),
      );
      throw new ValidationError(
        `'${input.agentId}' is not in any workflow attached to '${input.projectId}'. ` +
          (available.length > 0
            ? `These are: ${available.join(', ')}.`
            : 'None of its workflows has any agents yet.'),
        { projectId: input.projectId, agentId: input.agentId, available },
      );
    }

    // Before the session, not inside it: an agent that may write must not get as far as being
    // handed a working directory. `verify` is left alone — it runs only the checks the repo
    // declares, which is the point of granting it without a shell.
    const writes = found.agent.tools.files
      ? 'change files'
      : found.agent.tools.run
        ? 'run commands with Bash, which changes files just as directly'
        : null;
    if (writes) {
      throw new ValidationError(
        `'${found.agent.name}' can ${writes}, so it cannot be addressed from a chat — a chat ` +
          'has no worktree to write in, and nothing confirming what it writes. Start it as a ' +
          `run on '${input.projectId}' instead. Agents that only read still answer here.`,
        { projectId: input.projectId, agentId: found.agent.id, workflowId: found.workflow.id },
      );
    }

    const usable = (await this.repos.listResolved(input.projectId)).filter(
      (repo) => repo.workingDirExists,
    );
    const workspace = this.workspace(usable, {}, undefined);

    const session = await this.openSession({
      projectId: input.projectId,
      agent: found.agent,
      // The agent's own choice wins here too: where an agent runs is a property of the agent,
      // not of the surface that addressed it.
      providerId: found.agent.provider ?? input.providerId,
      cwd: workspace.cwd,
      workspace,
      skillPrompt: input.skillPrompt,
    });

    const result = await session.port.complete({
      model: session.model,
      system: session.system,
      messages: [{ role: 'user', content: task }],
      adaptiveThinking: session.provider.kind !== 'claude-code',
      effort: 'medium',
      maxTokens: 16_000,
    });

    // The verdict block is part of every agent's prompt and so part of every agent's answer.
    // Reading it off here is what stops a chat reply ending in a lump of json — but stripping
    // the block must not throw away what it said. An agent is told to put what it could not
    // deliver in `unmet` and nowhere else, so a partial answer whose `unmet` was dropped reads
    // in the chat as a complete one.
    const { verdict, prose } = parseVerdict(result.text);
    const shortfall =
      verdict.outcome !== 'done' && verdict.unmet.length > 0
        ? `\n\n_Did not deliver: ${verdict.unmet.join('; ')}_`
        : '';

    return {
      text: `${prose || result.text}${shortfall}`,
      workflowId: found.workflow.id,
      providerId: session.provider.id,
      model: session.model,
      usage: {
        // Cache reads and writes are input, and most of the real volume. Counted the same way
        // a pipeline step counts them, so the two numbers mean the same thing.
        inputTokens:
          result.usage.inputTokens +
          result.usage.cacheReadTokens +
          result.usage.cacheCreationTokens,
        outputTokens: result.usage.outputTokens,
        costUsd: result.costUsd ?? null,
      },
    };
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
    /** Answers this run already has, when it is being resumed rather than started. */
    seed?: Seed,
  ): Promise<PipelineRun> {
    const { cwd } = workspace;
    const started = Date.now();
    const budget: RunBudget = { cost: 0, steps: 0, stopped: null, dropped: [] };
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
        seed,
        budget,
        addCost: (amount) => {
          budget.cost += amount;
        },
      });

      // A run is green only if the agent that did the work says it is. `passed` used to mean
      // no more than "the model returned prose", which is how a run ended green while its
      // own transcript explained the work had not been done.
      const verdict = result.verdict;
      // A run that ran out of budget did not finish the work, whatever its last agent said
      // about the part it did reach. The stop outranks the verdict for that reason.
      const stopped = budget.stopped;
      // Work the run planned and never did. Like a budget stop, it out-ranks the verdict: an
      // orchestrator whose delegation was dropped has no way to know it, so its own account of
      // the run is written without the one fact that matters most about it.
      const dropped = budget.dropped.length > 0 ? budget.dropped.join('; ') : null;

      let finished: PipelineRun = {
        ...run,
        // What agents published during the run. `run` is the object this method was handed
        // and it never learns about handovers — deliberately, since it is passed by reference
        // to every agent still to come. Writing it back unchanged is what silently undid
        // `publish`, which had already put these on the stored run.
        context: this.withHandovers(run),
        status: this.cancelled.has(run.id)
          ? 'cancelled'
          : stopped || dropped || verdict.outcome === 'blocked'
            ? 'failed'
            : 'passed',
        error:
          stopped ??
          dropped ??
          (verdict.outcome === 'blocked' ? verdict.unmet.join('; ') || 'blocked' : null),
        pid: null,
        outcome: stopped || dropped ? 'blocked' : verdict.outcome,
        // The agents' unmet list, after whatever the run already could not give itself —
        // a repo it had to share is as much a shortfall as a job it did not finish.
        unmet: [...run.unmet, ...verdict.unmet, ...(stopped ? [stopped] : []), ...budget.dropped],
        result: result.answer,
        endedAt: this.clock.iso(),
        durationMs: Date.now() - started,
        ...(await this.tally(run.id)),
        // The figure actually reached, not the ceiling: what the money went on is the thing
        // a person deciding whether to raise the limit needs to see.
        costUsd: budget.cost || null,
      };

      await this.captureArtifacts(finished, cwd);

      // The gate below only runs for a passed run, so a budget stop would otherwise leave its
      // item sitting in `in_progress` with nothing working on it.
      if (stopped && finished.itemId) {
        finished = { ...finished, itemStatus: await this.moveItem(finished, 'blocked', stopped) };
      }

      // The gate is what turns "the agents finished" into "the change works". Without it a
      // pipeline can only report its own opinion of itself.
      if (finished.status === 'passed') {
        // The base first, then the gate. Grading the branch alone answers a question nobody
        // has: three branches were each green on their own and merged into a red master.
        const merges = await this.mergeBaseIn(finished);
        finished = { ...finished, unmet: [...finished.unmet, ...merges.notes] };
        finished = await this.runGate(finished, dirOverrides);
        if (finished.itemId) {
          // Whether this run *finished the work* is the pipeline's own judgement and stays here:
          // the gate proves the repo still builds, the verdict says the work was actually done,
          // and a branch that will not merge is not reviewable however green it is on its own.
          // A green gate over an unfinished job is the most dangerous of the three, because it
          // looks like evidence.
          const ready =
            finished.gateStatus !== 'failed' && finished.outcome === 'done' && !merges.conflicted;
          const why = merges.conflicted
            ? `it does not merge onto its base: ${merges.notes.join('; ')}`
            : finished.gateStatus === 'failed'
              ? 'the gate did not pass after the agent run'
              : `the agents reported the work as ${finished.outcome}${
                  finished.unmet.length > 0 ? `: ${finished.unmet.join('; ')}` : ''
                }`;

          // Where the item goes next is the *project's* judgement, and this is where the
          // pipeline stops making it. It reports that the run finished and the gate ran, and
          // the flow decides: on the built-in flow `in_progress -> in_review` is an `auto`
          // arrow requiring the `default` gate, so a passing run still ends in review — as a
          // consequence of the flow, and reachable by a person's drag and by `pomni verify`
          // just the same. A project whose flow makes that arrow manual keeps its item where
          // it is and sees it listed as eligible instead, which is what asking meant.
          const moved = ready
            ? await this.advanceItem(finished)
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
        // A run that ended badly published just as much as one that did not.
        context: this.withHandovers(run),
        status: this.cancelled.has(run.id) ? 'cancelled' : 'failed',
        pid: null,
        error: message,
        endedAt: this.clock.iso(),
        durationMs: Date.now() - started,
        ...(await this.tally(run.id)),
        costUsd: budget.cost || null,
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
    workspace: AgentWorkspace;
    seed?: Seed;
    /** What the agents delegated to earlier in this run already answered. */
    siblings?: AgentReport[];
    /** The whole run's spend and step count. Shared, not per agent. */
    budget: RunBudget;
    addCost: (amount: number) => void;
  }): Promise<{ answer: string; verdict: Verdict }> {
    const {
      run,
      workflow,
      agent,
      task,
      parentStepId,
      depth,
      cwd,
      workspace,
      seed,
      siblings,
      budget,
      addCost,
    } = context;

    const orchestrating = isOrchestrator(agent);
    const roster = orchestrating ? rosterFor(workflow, agent) : [];

    // Resolved before the step is recorded: an agent asking for a tool nobody gave the
    // project should fail as a configuration error, not halfway through a paid session.
    const rosterBlock = [
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
    ].join('\n');

    const session = await this.openSession({
      projectId: run.projectId,
      agent,
      providerId: agent.provider ?? run.providerId,
      cwd,
      workspace,
      protocol: orchestrating ? [ORCHESTRATOR_PROTOCOL, '', rosterBlock].join('\n') : undefined,
      // Handed over separately as well, so the breakdown can say what the roster costs. It is
      // the part that grows with the team rather than with the job, and a lead delegating to
      // eleven agents carries eleven descriptions on every one of its rounds.
      roster: orchestrating ? rosterBlock : undefined,
    });
    const { port, model, provider } = session;

    const step: PipelineStep = {
      id: ulid(this.clock.now().getTime()),
      runId: run.id,
      parentStepId,
      agentId: agent.id,
      agentName: agent.name,
      role: agent.role,
      // The provider that actually ran it, resolved rather than as configured: a run spanning
      // three providers is only readable afterwards if each step says which one it used.
      providerId: provider.id,
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
      cacheCreationTokens: 0,
      promptBytes: session.promptBytes,
      sentBytes: 0,
      promptParts: session.promptParts,
      turns: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      freshInputTokens: 0,
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
      providerId: provider.id,
      model,
      depth,
      task,
    });

    // Counted here, where a step actually begins, so every agent in the tree adds to the same
    // total. Reported straight afterwards on the step's own output channel: a budget nobody
    // can watch approaching is only ever discovered by being over it.
    budget.steps += 1;
    const spend = await this.budgetLine(run, budget);
    this.events.emit({
      type: 'pipeline.step.output',
      runId: run.id,
      stepId: step.id,
      chunk: spend,
    });
    this.logger.info(spend);

    const startedAt = Date.now();
    const actions: PipelineStep['actions'] = [];
    const transcript: string[] = [`# Task\n\n${task}`];
    let inputTokens = 0;
    let stepCost = 0;
    let outputTokens = 0;
    let turns = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let freshInputTokens = 0;
    let sentBytes = 0;
    /** The sentence a mid-turn stop gave, when one happened. Null on every other path. */
    let stoppedMidTurn: string | null = null;

    try {
      const prompt = session.system;

      // What this session may spend before it is cut off, and what a token costs on this
      // model. Both read once, here, because the check they feed has to be synchronous — it
      // runs between two turns of a session that is already going, where there is nowhere to
      // await. The consequence, stated: raising the ceiling mid-step does not reach a step
      // already running, only the checks between steps. That is the smaller surprise.
      const policy = await this.policyNow(run.projectId);
      const rate = await this.store.rate(model);
      const onTurn = this.turnStop(run, budget, {
        ceiling: policy?.maxCostUsd,
        rate,
        maxSessionTurns: policy?.maxSessionTurns,
      });

      // The orchestrator's own turns stay in the conversation. Sending only the latest
      // round back is what made a lead ask the same analyst the same question four times:
      // it could not see what it had already delegated.
      const carried = [...run.context, ...(this.handedOver.get(run.id) ?? [])];
      // The entry agent's task *is* the brief; everyone else is given it alongside their own
      // instruction. Without this the orchestrator had to restate the whole background in
      // every delegation, and it did — 174kB of it across one 22-step run.
      const forAgent =
        depth === 0 ? task : withSiblings(withBrief(task, run.task), siblings ?? []);
      const history: LlmMessage[] = [
        { role: 'user', content: withContext(forAgent, carried) },
      ];
      // An exact repeat is answered from the ledger instead of being run again — a second
      // session for a question already answered costs money and returns the same thing.
      // Seeded when resuming: a delegation whose answer is already on disk is returned from
      // here instead of opening a session for it. The orchestrator asks again and is answered
      // instantly, which is what makes a resumed run cheap.
      const answered = new Map<string, string>(seed?.answered ?? []);
      const useCount = new Map<string, number>(seed?.useCount ?? []);
      // Everything this orchestrator has been told so far, in the order it was told. Passed
      // down rather than kept, so the next delegate starts from what the last one settled.
      const reported: AgentReport[] = [];
      // Where each round's results landed in `history`, and what that round says in short.
      // Used to shrink the rounds nobody is still working from; see `condense`.
      const settled: Array<{ index: number; digest: string }> = [];
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

        // Between rounds, never inside one: the turn about to be paid for is the one we can
        // still decline. An orchestrator that keeps reviewing its own work is the shape that
        // runs the bill up without ever opening another session, so the cost has to be
        // re-checked here and not only where a delegation is decided.
        if (await this.budgetStop(run, budget)) {
          answer = stoppedAnswer(budget.stopped as string);
          break;
        }

        // Older rounds shrink to what they concluded. Every turn pays for the whole
        // conversation again, and a round's full text is only worth that price while the
        // orchestrator is still working from it.
        condense(history, settled);

        // Counted before the call, on exactly what the call is about to carry. Measured here
        // rather than added up from the parts afterwards, so it cannot drift from what was
        // sent — and summed across rounds, because an orchestrator pays for its whole
        // conversation again on every one of them.
        sentBytes +=
          bytes(prompt) + history.reduce((total, message) => total + bytes(message.content), 0);

        const result = await port.complete({
          model,
          system: prompt,
          messages: history,
          adaptiveThinking: provider.kind !== 'claude-code',
          effort: orchestrating ? 'high' : 'medium',
          maxTokens: 16_000,
          onTurn,
        });

        // Cache reads and writes are most of the real volume and were being dropped, so
        // a 21-step run reported 240 input tokens. They are input; count them.
        inputTokens +=
          result.usage.inputTokens +
          result.usage.cacheReadTokens +
          result.usage.cacheCreationTokens;
        // The halves of the same total, off the same usage object in the same iteration, so
        // that `cacheReadTokens + freshInputTokens === inputTokens` holds for every step.
        cacheReadTokens += result.usage.cacheReadTokens;
        cacheCreationTokens += result.usage.cacheCreationTokens;
        freshInputTokens += result.usage.inputTokens + result.usage.cacheCreationTokens;
        outputTokens += result.usage.outputTokens;
        // Summed, not overwritten: an orchestrator's rounds are one session's worth of turns,
        // and 0 from a provider that reports none stays 0 rather than being read as one turn.
        turns += result.turns;
        // A session cut off part-way used what it used, and the frame that carries the cost
        // is the one that never printed. Charged at the same measured rate the stop was
        // decided on, so the ledger and the decision cannot tell different stories about
        // the same turns.
        const charged =
          result.costUsd ??
          (result.stoppedBy && rate !== null ? tokensUsed(result.usage) * rate : 0);
        stepCost += charged;
        addCost(charged);
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

        // Stopped inside the session, not between two of them. Everything after this point
        // in the round reads the reply as an answer — it would parse a verdict out of half a
        // sentence, publish the files it names and let an orchestrator delegate again on the
        // strength of it. What the session had said is kept, and kept labelled.
        if (result.stoppedBy) {
          stoppedMidTurn = result.stoppedBy;
          budget.stopped = result.stoppedBy;
          answer = partialAnswer(result.text, result.stoppedBy);
          break;
        }

        // Notes this agent left. Nothing waits for them: a comment is written and the round
        // carries on in the same turn, which is the whole difference between this and asking
        // a person — that one blocks by design, and this one must never.
        await this.noteComments(run, step, agent, result.text);

        const delegations = orchestrating ? parseDelegations(result.text) : null;
        if (!delegations) {
          answer = result.text;

          // It asked for work and the request could not be read. Silently treating this as
          // "the orchestrator is finished" is what ended runs KF1HCPKF and NSP5X8MW after two
          // steps while reporting passed. Say it, once, where both the run and a person can
          // see it — and let it out-rank the verdict at the finish.
          if (orchestrating && looksLikeDelegation(result.text)) {
            const note =
              `'${agent.name}' asked to delegate and the block could not be read as a` +
              ' delegation, so nothing was run for it';
            budget.dropped.push(note);
            this.logger.warn(note, { runId: run.id, stepId: step.id });
            this.events.emit({
              type: 'pipeline.delegation.dropped',
              runId: run.id,
              stepId: step.id,
              agentName: agent.name,
              reason: note,
            });
          }

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
                const key = memoKey(HUMAN_AGENT_ID, delegation.task);
                const previous = answered.get(key);
                if (previous !== undefined) {
                  this.noteMemo(run, step, 'the person who started this run', delegation.task);
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

              // The same question the caps below answer — may this run open another session —
              // asked of the project's money and turns first. A step already in flight is
              // never touched: what is refused here has not started and has cost nothing.
              const refusal = await this.budgetStop(run, budget, 1);
              if (refusal) {
                return `### ${target.name} (\`${target.id}\`) — no\n\n${refusal}`;
              }

              const opened = [...useCount.values()].reduce((sum, n) => sum + n, 0);
              if (opened >= MAX_SESSIONS) {
                return (
                  `### ${target.name} (\`${target.id}\`) — no` +
                  `\n\nThis run has already opened ${MAX_SESSIONS} agent sessions, which is all it` +
                  ' gets. Answer with what you have, and say plainly what is unfinished.'
                );
              }

              if ((useCount.get(target.id) ?? 0) >= MAX_PER_AGENT) {
                return (
                  `### ${target.name} (\`${target.id}\`) — no` +
                  `\n\nYou have already asked this agent ${MAX_PER_AGENT} times. It has told` +
                  ' you what it knows. Decide with what you have, or ask a different agent,' +
                  ' or ask the person who started this run.'
                );
              }

              // The promise the protocol now makes to the orchestrator, kept: a task already
              // answered comes back from the ledger instead of opening a second session for
              // it. Not silent — a step that never ran is otherwise invisible in the run,
              // and a person reading why a run was cheap has nothing to read.
              const key = memoKey(target.id, delegation.task);
              const previous = answered.get(key);
              if (previous !== undefined) {
                this.noteMemo(run, step, `${target.name} (\`${target.id}\`)`, delegation.task);
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
                  // A batch runs in parallel, so this is what finished before the batch began
                  // — which is the only thing that can honestly be called already decided.
                  siblings: [...reported],
                  budget,
                  addCost,
                });
                answered.set(key, output.answer);
                reported.push({
                  agentId: target.id,
                  agentName: target.name,
                  task: delegation.task,
                  answer: output.answer,
                });
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

        // The batch is what a round costs, and it is only fully paid for now. Answering the
        // orchestrator with these results would buy it another turn on money the project has
        // said it does not have.
        if (await this.budgetStop(run, budget)) {
          answer = stoppedAnswer(budget.stopped as string);
          break;
        }

        const ledger = [...useCount.entries()]
          .map(([id, times]) => `${id} (${times}x)`)
          .join(', ');

        settled.push({ index: history.length, digest: results.map(digest).join('\n\n') });
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
            // Four runs in a row did the work and then spent their last round on another
            // review instead of writing it up, and each was recorded as a failure that
            // had in fact succeeded. An orchestrator cannot count its own rounds; tell
            // it when the budget is nearly gone.
            round >= MAX_ROUNDS - 2
              ? 'This is your last round. Do not delegate again — write your final' +
                ' answer now, including what is unfinished, and end with the verdict block.'
              : 'Delegate again if you still need something new, or answer in prose.',
          ].join('\n'),
        });

        if (round === MAX_ROUNDS - 1) {
          // Not an answer, and it must not read as one: a run that ends here has produced
          // nothing anybody can act on, and used every round doing it.
          answer = [
            'This orchestrator kept delegating and ran out of rounds without answering.',
            '',
            '```json',
            '{"outcome": "blocked", "unmet": ["the orchestrator never gave a final answer"]}',
            '```',
          ].join('\n');
        }
      }

      await this.docs.write(layout.pipelineStepLog(run.id, step.id), transcript.join('\n'));

      const { verdict, prose } = parseVerdict(answer);

      // Published before the step is even written: whatever this agent settled is now the
      // rest of the run's to use, and the next delegation may already be waiting on it.
      //
      // Not from a session cut off part-way. A handover is a file, and a file the session was
      // still writing is truncated — passing it on hands the next agent something that looks
      // finished and is not.
      if (!stoppedMidTurn) await this.publish(run, parseHandover(answer));

      answer = prose || answer;

      const done: PipelineStep = {
        ...step,
        // Cancelled, not done. It was stopped, and a step that says `done` is a step
        // somebody will read as having finished the job it was given.
        status: this.cancelled.has(run.id) || stoppedMidTurn ? 'cancelled' : 'done',
        error: stoppedMidTurn,
        output: answer,
        outcome: verdict.outcome,
        unmet: verdict.unmet,
        actions,
        endedAt: this.clock.iso(),
        durationMs: Date.now() - startedAt,
        turns,
        inputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        freshInputTokens,
        outputTokens,
        sentBytes,
        costUsd: stepCost || null,
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
        // A step that failed mid-way still spent what it spent on the way there.
        turns,
        inputTokens,
        cacheReadTokens,
        freshInputTokens,
        outputTokens,
        sentBytes,
        costUsd: stepCost || null,
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
   * The project's budgets, as they are *right now*.
   *
   * Read again at every check rather than snapshotted when the run started, which is what
   * makes `pomni project edit --max-cost` take effect on a run already going: a person who
   * decides the work is worth another two dollars should not have to stop and resume it. The
   * same call `deliver` makes for the delivery flags, and it fails soft for the same reason —
   * a project that cannot be read is not a reason to kill work in flight.
   */
  private async policyNow(projectId: string): Promise<ProjectPolicy | null> {
    const project = await this.projects.getRef(projectId).catch(() => null);
    return project?.data.policy ?? null;
  }

  /**
   * Whether this run may go on, and the sentence explaining it if not.
   *
   * `upcoming` is how many steps the caller is about to start — one where a delegation is
   * being dispatched, none where the check is between rounds of a step already running. That
   * distinction is the whole of "it stops between steps": a step admitted by this check runs
   * to completion and its cost lands through `addCost` before anything stops.
   *
   * Both limits are guarded on being present. The schema defaults them today, but a policy
   * with no ceiling has to mean no ceiling rather than zero, which would refuse every run.
   */
  private async budgetStop(
    run: PipelineRun,
    budget: RunBudget,
    upcoming = 0,
  ): Promise<string | null> {
    if (budget.stopped) return budget.stopped;

    const policy = await this.policyNow(run.projectId);
    if (!policy) return null;

    if (policy.maxCostUsd !== undefined && budget.cost >= policy.maxCostUsd) {
      budget.stopped =
        `this run has spent $${budget.cost.toFixed(2)} of the $${policy.maxCostUsd.toFixed(2)}` +
        ' its project allows (policy.maxCostUsd), so it stopped before the next step. What it' +
        " had already done is committed. Raise the ceiling with 'pomni project edit --max-cost" +
        " <usd>' and resume the run, or leave it here.";
      return budget.stopped;
    }

    const step = budget.steps + upcoming;
    if (policy.maxTurns !== undefined && step > policy.maxTurns) {
      budget.stopped =
        `this run reached step ${step} of the ${policy.maxTurns} its project allows` +
        ' (policy.maxTurns), so it stopped before running it. What it had already done is' +
        " committed. Raise the ceiling with 'pomni project edit --max-turns <n>' and resume the" +
        ' run, or leave it here.';
      return budget.stopped;
    }

    return null;
  }

  /**
   * The check a session runs against itself, between one turn and the next.
   *
   * `budgetStop` guards the gaps between steps, and for an orchestrator that is most of the
   * spend. For a leaf agent there are no gaps: it is one `complete()` call that drives its
   * own tool loop, and the whole of its cost lands after the fact. Service Author spent
   * $7.77 in one such call on a run that was at $8.12 of $10 when it started, and every
   * check in the system was satisfied at the moment that call was admitted.
   *
   * Two questions, asked on the same turn boundary because they are the same failure seen
   * from two sides. **Money**: what has this run spent, including what this session has run
   * up since it started? **Turns**: how many has this one session taken? Cost tracks turns
   * almost exactly — a turn is billed for about the same amount whatever it does — so the
   * turn count catches a session going nowhere before the estimate has to.
   *
   * What it can promise, exactly: a ceiling is crossed by at most one turn. The turn already
   * in flight when a check goes over cannot be un-taken — the money is spent by the time the
   * provider says it was — so this is "one turn over", never "never over". Anything stronger
   * would need a provider that can be interrupted mid-turn, and none offers that.
   *
   * A provider that reports no turns is never stopped here, because it never calls this. An
   * unmeasured session must not read as an infinite one, and the checks around the step are
   * what bound it instead.
   */
  private turnStop(
    run: PipelineRun,
    budget: RunBudget,
    measure: { ceiling: number | undefined; rate: number | null; maxSessionTurns: number | undefined },
  ): ((used: LlmUsage & { turns: number }) => string | null) | undefined {
    const { ceiling, rate, maxSessionTurns } = measure;
    // Money needs both a ceiling and a rate to measure against: a guess dressed up as a limit
    // is worse than a limit that says it is absent. Turns need neither — they are counted, not
    // estimated — so this is offered whenever either question can be asked.
    const money = ceiling !== undefined && rate !== null;
    if (!money && maxSessionTurns === undefined) return undefined;

    return (used) => {
      if (used.turns <= 0) return null;

      if (maxSessionTurns !== undefined && used.turns >= maxSessionTurns) {
        return (
          `this agent was stopped on its ${used.turns}${nth(used.turns)} turn: its project allows` +
          ` one session ${maxSessionTurns} (policy.maxSessionTurns). Turns are what a run is` +
          ' billed for, so a session that keeps taking them is what runs a budget up. Whatever' +
          ' it had written is in the worktree and is committed with the rest of the run. Raise' +
          " the ceiling with 'pomni project edit --max-session-turns <n>' and resume the run," +
          ' or read what it managed and decide from there.'
        );
      }

      if (!money) return null;

      // `budget.cost` is every turn already paid for anywhere in this run; `used` is this
      // session's own, which is not in it yet.
      const spent = budget.cost + tokensUsed(used) * (rate as number);
      if (spent < (ceiling as number)) return null;

      return (
        `this agent was stopped part-way through its ${used.turns}${nth(used.turns)} turn: the` +
        ` run had reached about $${spent.toFixed(2)} of the $${(ceiling as number).toFixed(2)} its project` +
        " allows (policy.maxCostUsd). The estimate is measured from this model's own recent" +
        ' cost per token, so it is close rather than exact. What the run had already committed' +
        " is committed. Raise the ceiling with 'pomni project edit --max-cost <usd>' and resume" +
        ' the run, or leave it here.'
      );
    };
  }

  /** What a step reports about the run's budget as it starts. */
  private async budgetLine(run: PipelineRun, budget: RunBudget): Promise<string> {
    const policy = await this.policyNow(run.projectId);
    const ceiling =
      policy?.maxCostUsd !== undefined ? `$${policy.maxCostUsd.toFixed(2)}` : 'no ceiling';
    const turns = policy?.maxTurns !== undefined ? String(policy.maxTurns) : 'no ceiling';

    const session =
      policy?.maxSessionTurns !== undefined
        ? `, ${policy.maxSessionTurns} turns a session`
        : '';

    return `Budget: $${budget.cost.toFixed(2)} of ${ceiling}, step ${budget.steps} of ${turns}${session}.`;
  }

  /**
   * Everything one agent needs to take a turn: a port scoped to its tools, the model for its
   * struggle, and the system prompt it runs under.
   *
   * The seam between a pipeline step and a single addressed agent. Both need the same prompt
   * — its own, plus what it may do, plus where the repos are, plus the verdict block — and the
   * same tool scoping, and a second copy of that would be a second place for an agent's grants
   * to drift from what it was actually handed.
   */
  private async openSession(input: {
    projectId: string;
    agent: Agent;
    providerId?: string;
    cwd: string | undefined;
    workspace: AgentWorkspace;
    /** Goes between the agent's own prompt and its tool briefing: the orchestrator protocol. */
    protocol?: string;
    /** The delegation roster, when there is one. Measured apart from the protocol it sits in. */
    roster?: string;
    /** A skill's instructions, put above everything else so they frame the whole turn. */
    skillPrompt?: string;
  }): Promise<{
    port: LlmPort;
    model: string;
    provider: Provider;
    system: string;
    promptBytes: number;
    promptParts: PromptParts;
  }> {
    const { agent, workspace } = input;
    assertRunnable(agent);

    const grants = await this.tools.grantsFor(input.projectId, [
      ...agent.tools.mcp,
      ...agent.tools.cli,
    ]);

    // What the repos say their own checks are. An agent that may verify gets exactly
    // these and no shell, so it can prove a change without being able to undo one.
    const checks = workspace.repos.flatMap((repo) =>
      Object.values(repo.capabilities)
        .map((capability) => capability.cmd)
        .filter((cmd): cmd is string => Boolean(cmd)),
    );

    const { port, model, provider } = await this.providers.portFor(agent.struggle, {
      provider: input.providerId,
      // Only give an agent a working directory when it is allowed to touch files; an
      // orchestrator with a repo tends to start doing the work itself.
      cwd: agent.tools.files || agent.tools.run ? input.cwd : undefined,
      dirs: agent.tools.files || agent.tools.run ? workspace.dirs : [],
      tools: grants,
      files: agent.tools.files,
      run: agent.tools.run,
      // Deliberately not part of the `cwd`/`dirs` gate above: an agent that may search but
      // may not touch files stays text-only and still gets its search tools.
      web: agent.tools.web,
      verify: agent.tools.verify || agent.tools.run ? checks : [],
    });

    // Say what this agent may and may not do. An agent that discovers a refusal by
    // being refused spends turns on it and reports the refusal as its finding — that
    // has cost whole runs here.
    const can = [
      agent.tools.files ? 'read and change files' : null,
      agent.tools.run ? 'run commands with Bash' : null,
      agent.tools.web ? 'search the web and fetch a page' : null,
      !agent.tools.run && agent.tools.verify && checks.length > 0
        ? `run exactly these checks, and nothing else: ${checks.join(', ')}`
        : null,
    ].filter(Boolean);
    const cannot = [
      agent.tools.files ? null : 'change files',
      agent.tools.web ? null : 'search the web or fetch a page',
      agent.tools.run || agent.tools.verify ? null : 'run commands — no build, no tests, no shell',
      !agent.tools.run && agent.tools.verify ? 'run any other command' : null,
    ].filter(Boolean);

    const abilities = [
      '## What you can do',
      '',
      can.length > 0 ? `You can ${can.join(' and ')}.` : 'You can read and think; that is all.',
      cannot.length > 0
        ? `You cannot ${cannot.join(', or ')}. Do not try, and do not report being unable` +
          ' to as a finding — say what you would have run and let whoever can, run it.'
        : '',
      // The grant is an exact string, so a check wrapped in cd, a redirect or a pipe matches
      // nothing and is refused. An agent that learns this by being refused spends three turns
      // on it and then reports a review with no build behind it, which has happened here.
      !agent.tools.run && agent.tools.verify && checks.length > 0
        ? 'Run each check exactly as written above — on its own, with no `cd`, no redirect and' +
          ' no pipe. Your session already starts in the repository, and a command built around' +
          ' a check is a different command, which you may not run.'
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    const briefing = toolBriefing(grants);
    const repos = agent.tools.files || agent.tools.run ? this.repoBriefing(workspace.repos) : null;

    const own = input.protocol ? [agent.prompt, '', input.protocol].join('\n') : agent.prompt;
    // The briefing goes last: an agent's own prompt is what it is, and the tools it was
    // handed are context added on top rather than part of its job description.
    const briefed = briefing ? [own, '', briefing].join('\n') : own;
    // Every agent, orchestrator or not, says what it achieved. Without it a step that
    // explains why it could not do the job is indistinguishable from one that did it.
    const system = [
      briefed,
      '',
      abilities,
      ...(repos ? ['', repos] : []),
      '',
      HANDOVER_PROTOCOL,
      '',
      COMMENT_PROTOCOL,
      '',
      VERDICT_PROTOCOL,
    ].join('\n');

    // A skill goes above the agent's own prompt rather than below it: it is the frame the
    // turn is being asked for, not an extra instruction bolted onto the job description.
    const assembled = input.skillPrompt?.trim()
      ? [input.skillPrompt.trim(), '', system].join('\n')
      : system;

    // Re-assembles the prompt with whichever optional parts survived, in the same order the
    // untrimmed one uses. A second join rather than string surgery on the first: cutting a
    // block out of finished text by matching it is how you eventually cut the wrong one.
    const rebuild = (tools: string | null, repoList: string | null): string => {
      const core = [
        tools ? [own, '', tools].join('\n') : own,
        '',
        abilities,
        ...(repoList ? ['', repoList] : []),
        '',
        HANDOVER_PROTOCOL,
        '',
        COMMENT_PROTOCOL,
        '',
        VERDICT_PROTOCOL,
      ].join('\n');
      return input.skillPrompt?.trim() ? [input.skillPrompt.trim(), '', core].join('\n') : core;
    };

    // Trimmed before it is measured, so the number recorded is the prompt that was actually
    // sent. Order matters and is the whole policy: the tool notes go first because an agent
    // can ask how a tool works, then the repo list because it is told where it is by its own
    // working directory. The agent's own prompt, the verdict protocol and anything a person
    // attached are never cut — losing those changes what the agent was asked to do, which is
    // a worse outcome than a large prompt.
    const budget = (await this.policyNow(input.projectId))?.promptBudget;
    let trimmed = assembled;
    const dropped: string[] = [];
    let briefingSent: string | null = briefing;
    let reposSent: string | null = repos;

    if (budget !== undefined && bytes(trimmed) > budget && briefingSent) {
      dropped.push('the tool usage notes');
      briefingSent = null;
    }
    if (budget !== undefined && reposSent) {
      const withoutTools = rebuild(briefingSent, reposSent);
      if (bytes(withoutTools) > budget) {
        dropped.push('the repo list');
        reposSent = null;
      }
    }
    if (dropped.length > 0) {
      trimmed = [
        rebuild(briefingSent, reposSent),
        '',
        `[${dropped.join(' and ')} ${dropped.length === 1 ? 'was' : 'were'} left out: this` +
          ` prompt was over the ${budget} bytes this project allows one turn to carry` +
          ' (policy.promptBudget). Ask if you need what is missing.]',
      ].join('\n');
    }

    // Over budget with nothing left that may be cut. Said to the person rather than added to
    // the prompt: the agent cannot act on it, and growing the prompt to complain about its
    // size is absurd. Silence here would be the same silence `maxCostUsd` used to keep.
    if (budget !== undefined && bytes(trimmed) > budget) {
      this.logger.warn(
        `'${agent.name}' carries ${bytes(trimmed)} bytes of prompt against a budget of ${budget}` +
          `${dropped.length > 0 ? `, after dropping ${dropped.join(' and ')}` : ''}. What is left` +
          ' is its own prompt and the protocols, which are never cut — shorten the prompt' +
          ' itself, or raise policy.promptBudget.',
      );
    }

    // Measured where the parts are joined rather than estimated from the result: a breakdown
    // computed separately drifts from its total the first time either of them changes.
    const roster = input.roster ?? '';
    const protocolOnly = (input.protocol ?? '').replace(roster, '');
    const promptParts = {
      agent: bytes(agent.prompt) + bytes(input.skillPrompt ?? ''),
      protocol:
        bytes(protocolOnly) +
        bytes(HANDOVER_PROTOCOL) +
        bytes(COMMENT_PROTOCOL) +
        bytes(VERDICT_PROTOCOL) +
        bytes(abilities),
      roster: bytes(roster),
      tools: bytes(briefingSent ?? ''),
      repos: bytes(reposSent ?? ''),
      context: 0,
    };

    return {
      port,
      model,
      provider,
      system: trimmed,
      promptBytes: bytes(trimmed),
      promptParts,
    };
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
  /**
   * Bring each worktree up to its base branch, so the gate that follows grades the merge.
   *
   * The gate has always asked "does this branch pass?" and every branch has answered honestly.
   * Nobody asked "does this branch pass *merged onto its target*", which is the only question
   * the person pressing Merge actually has. Three branches, each green in its own worktree,
   * merged into a master where 44 tests failed — none of them wrong, all of them unmeasured
   * together.
   *
   * Merging here rather than in a scratch tree costs nothing extra: the gate is about to run
   * in this directory anyway, so the merge makes it answer the better question for free.
   *
   * Never throws and never fails a run. A conflict is a fact about two branches — it says the
   * work needs a person before it can land, and that is reported rather than fought.
   */
  private async mergeBaseIn(
    run: PipelineRun,
  ): Promise<{ notes: string[]; conflicted: boolean }> {
    const notes: string[] = [];
    let conflicted = false;

    const worktrees = await this.worktrees
      .list({ runId: run.id, status: 'active' })
      .catch(() => []);

    for (const worktree of worktrees) {
      // Null when the repo was on a detached HEAD when the tree was cut. Nothing to merge onto.
      if (!worktree.baseBranch) continue;

      const repo = await this.repos.get(run.projectId, worktree.repoId).catch(() => null);
      const name = repo?.name ?? worktree.repoId;

      let result: Awaited<ReturnType<GitPort['mergeInto']>>;
      try {
        result = await this.git.mergeInto(worktree.path, worktree.baseBranch);
      } catch (error) {
        notes.push(`'${name}' could not be brought up to ${worktree.baseBranch}: ${firstLine(error)}`);
        continue;
      }

      if (result.status === 'conflict') {
        conflicted = true;
        notes.push(
          `'${name}' ${result.detail}. The gate below graded the branch on its own, which is` +
            ' not the question a merge asks — this needs a person before it can land.',
        );
        continue;
      }

      if (result.status === 'unavailable') {
        notes.push(`'${name}': ${result.detail} — the gate below graded the branch on its own.`);
        continue;
      }

      // `already` is the ordinary case and worth no words; a base that moved under the run is
      // worth saying, because the gate result now covers code the agents never saw.
      if (result.status === 'merged') {
        this.logger.info(`${run.id}: ${name} ${result.detail}`);
      }
    }

    return { notes, conflicted };
  }

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

    if (artifacts.length > 0) await this.store.putArtifacts(artifacts);
  }

  /**
   * Turn what a run wrote into a commit, and — when the project says so — into a branch on
   * the remote with a merge request waiting to be opened against it.
   *
   * This is the step that was missing, and its absence was quiet rather than loud: every run
   * left its work uncommitted in a gitignored directory, the branch never reached the remote,
   * and the merge-request link the run offered pointed at a branch that did not exist.
   *
   * Three rules shape it. A run only ever commits in a worktree of its own — a run that had
   * to share a repo directory is sitting on somebody else's checked-out branch, and committing
   * there writes to a branch nobody offered. Nothing here can fail a run: the work is already
   * done and paid for, and a push that was refused is a sentence to read, not a verdict to
   * overturn. And a push happens only for a run that passed with a gate that did not fail,
   * because publishing a branch is telling other people the work is ready.
   *
   * Returns the sentences to put on the run. Artifacts and the item's branch are written here.
   */
  private async deliver(run: PipelineRun): Promise<{ notes: string[]; branch: string | null }> {
    const notes: string[] = [];
    

    let worktrees: Awaited<ReturnType<WorktreeService['list']>>;
    try {
      worktrees = await this.worktrees.list({ runId: run.id, status: 'active' });
    } catch (error) {
      this.logger.warn(`could not read the worktrees of ${run.id}`, error);
      return { notes, branch: null };
    }
    if (worktrees.length === 0) return { notes, branch: null };

    const project = await this.projects.getRef(run.projectId).catch(() => null);
    const policy = project?.data.policy;
    // Committing is on by default and pushing is not. The asymmetry is the whole point: a
    // commit on the run's own branch, inside a directory Pomni made, cannot overwrite anyone's
    // work — the alternative to it is loose files. A push is outward-facing and stays opt-in.
    const mayCommit = policy?.autoCommit ?? false;
    const mayPush =
      (policy?.autoPush ?? false) && run.status === 'passed' && run.gateStatus !== 'failed';

    const artifacts: Artifact[] = [];
    const branches: string[] = [];

    for (const worktree of worktrees) {
      const repo = await this.repos.get(run.projectId, worktree.repoId).catch(() => null);
      if (!repo) continue;

      let changed: Array<{ path: string; change: string }>;
      try {
        changed = await this.git.changes(worktree.path);
      } catch (error) {
        notes.push(
          `Could not read what '${repo.name}' changed, so nothing was committed: ${firstLine(error)}`,
        );
        continue;
      }
      if (changed.length === 0) continue;

      if (!mayCommit) {
        notes.push(
          `'${repo.name}' has ${changed.length} uncommitted change${
            changed.length === 1 ? '' : 's'
          } on ${worktree.branch}; this project has autoCommit off, so they were left as files.`,
        );
        continue;
      }

      try {
        const committed = await this.git.commit(worktree.path, {
          message: this.commitMessage(run, changed.length),
        });
        if (!committed.committed) continue;
        branches.push(worktree.branch);
        if (committed.identityBorrowed) {
          notes.push(
            `git had no user.name or user.email here, so the commit on ${worktree.branch} is` +
              ' authored as Pomni — set your own identity to have it signed as you.',
          );
        }
      } catch (error) {
        notes.push(`'${repo.name}' could not be committed on ${worktree.branch}: ${firstLine(error)}`);
        continue;
      }

      if (!mayPush) {
        notes.push(
          `The work on '${repo.name}' is committed on ${worktree.branch} but not pushed` +
            `${policy?.autoPush ? '' : ' (this project has autoPush off)'}` +
            ` — push it with: git -C ${worktree.path} push -u origin ${worktree.branch}`,
        );
        continue;
      }

      try {
        await this.git.push(worktree.path, {
          branch: worktree.branch,
          setUpstream: true,
          auth: await this.repos.authForRepo(repo),
        });
      } catch (error) {
        notes.push(
          `'${repo.name}' is committed on ${worktree.branch} but the push was refused:` +
            ` ${firstLine(error)}. The commit is safe; push it when the remote will take it.`,
        );
        continue;
      }

      // Only now is there something to open a merge request against. Offering the link before
      // the push is what made it a link to a page saying the branch does not exist.
      //
      // A linked repo has a remote too — it is somebody's own clone of one — so the remote is
      // read from the source when Pomni cloned it and from git itself when it did not.
      const remote =
        repo.source.kind === 'git' ? repo.source.url : (repo.vcs?.remote ?? null);
      let opened: MergeRequestRef | null = null;
      if (policy?.autoMergeRequest ?? false) {
        try {
          opened = await this.openMergeRequest(
            run,
            repo,
            remote,
            worktree.branch,
            worktree.baseBranch,
          );
        } catch (error) {
          // Soft, but never silent. The branch is pushed and the link below still works; what
          // the person needs is the sentence saying why the automatic half did not happen.
          notes.push(
            `The branch ${worktree.branch} is pushed, but the merge request could not be` +
              ` opened for you: ${firstLine(error)}. Open it from the link on this run.`,
          );
        }
      }
      const url = opened?.url ?? mergeRequestUrl(remote, worktree.branch);

      if (opened) {
        notes.push(
          `${opened.created ? 'Opened' : 'Found'} a merge request for '${repo.name}' on` +
            ` ${worktree.branch}: ${opened.url}`,
        );
      }

      artifacts.push({
        id: ulid(this.clock.now().getTime()),
        runId: run.id,
        stepId: null,
        name: worktree.branch,
        kind: 'report',
        path: url,
        change: url ? 'merge request' : 'pushed',
        bytes: 0,
        createdAt: this.clock.iso(),
      });
    }

    if (artifacts.length > 0) {
      await this.store.putArtifacts(artifacts).catch((error) => {
        this.logger.warn(`could not record the delivery artifacts for ${run.id}`, error);
      });
    }

    // The item points at where its work is. One branch is the ordinary case; a run across two
    // repos genuinely has two, and naming both beats naming whichever came back first.
    const named = [...new Set(branches)].join(', ');

    if (run.itemId && branches.length > 0) {
      await this.backlog
        .update(run.projectId, run.itemId, { branch: named })
        .catch((error) => {
          this.logger.warn(`could not record the branch on ${run.itemId}`, error);
        });
    }

    return { notes, branch: branches.length > 0 ? named : null };
  }

  /**
   * Ask the forge to open the merge request, with the item as its description.
   *
   * Never throws and never fails a run. The item's own Problem and Acceptance criteria are what
   * a reviewer wants first, and they are already written — retyping them into a form is how the
   * description ends up being a sentence long and different every time.
   */
  private async openMergeRequest(
    run: PipelineRun,
    repo: ResolvedRepo,
    remote: string | null,
    branch: string,
    baseBranch: string | null,
  ): Promise<MergeRequestRef | null> {
    if (!remote) return null;

    const item = run.itemId
      ? await this.backlog.get(run.projectId, run.itemId).catch(() => null)
      : null;

    const title = item ? `${item.id}: ${item.title}` : run.task.split('\n')[0]?.trim() || run.id;
    const sections = item?.sections ?? {};
    const description = [
      ...(sections.Problem ? ['## Problem', '', sections.Problem.trim(), ''] : []),
      ...(sections['Acceptance criteria']
        ? ['## Acceptance criteria', '', sections['Acceptance criteria'].trim(), '']
        : []),
      `Opened by the '${run.workflowName}' workflow — Pomni run \`${run.id}\`.`,
    ].join('\n');

    try {
      return await this.forge.openMergeRequest({
        remote,
        // A cloned repo was told which forge hosts it; a linked one has to be read off the url.
        provider: repo.source.kind === 'git' ? repo.source.provider : detectProvider(remote),
        auth: await this.repos.authForRepo(repo),
        sourceBranch: branch,
        targetBranch:
          baseBranch ?? (repo.source.kind === 'git' ? (repo.source.ref ?? null) : null),
        title,
        description,
      });
    } catch (error) {
      // Told to the person, not only to a log. A forge that answered and refused is the case
      // where the run looks as though it never tried — and where the fix is one they can make.
      this.logger.warn(`could not open a merge request for ${branch}`, error);
      throw error;
    }
  }

  /** What the commit says it is. The item id first, because that is what a log is read for. */
  private commitMessage(run: PipelineRun, fileCount: number): string {
    const subject = run.itemId
      ? `${run.itemId}: ${run.task.split('\n')[0]?.trim() ?? 'agent run'}`
      : run.task.split('\n')[0]?.trim() || 'agent run';

    return [
      subject.length > 72 ? `${subject.slice(0, 69)}...` : subject,
      '',
      `${fileCount} file${fileCount === 1 ? '' : 's'} changed by the '${run.workflowName}' workflow.`,
      '',
      `Pomni-Run: ${run.id}`,
      ...(run.itemId ? [`Pomni-Item: ${run.itemId}`] : []),
    ].join('\n');
  }

  /**
   * The branch a run's work goes on, named after the item it delivers.
   *
   * Falls back to naming the run whenever the item cannot be read — a run without one, or a
   * backlog read that failed. A run that cannot name itself after its item still needs a
   * branch, and refusing to start over a name would be the wrong trade.
   */
  private async branchFor(
    projectId: string,
    itemId: string | null,
    runId: string,
  ): Promise<string> {
    if (!itemId) return runBranch(runId);
    try {
      const item = await this.backlog.get(projectId, itemId);
      return itemBranch(item.type, item.id);
    } catch (error) {
      this.logger.debug(`could not read ${itemId} to name a branch`, error);
      return runBranch(runId);
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
   * Write the notes an agent left in its reply.
   *
   * On the backlog item the run started from, not on the run: a reviewer's finding outlives
   * the attempt that found it, and the next attempt reads the item's comments as context. A
   * run with no item has only itself to write on.
   *
   * Never throws. A note is something an agent said in passing, and losing the whole step
   * because a note could not be stored would cost the work to save the remark about it.
   */
  private async noteComments(
    run: PipelineRun,
    step: PipelineStep,
    agent: Agent,
    text: string,
  ): Promise<void> {
    for (const note of parseComments(text)) {
      try {
        const comment = await this.comments.add({
          subject: run.itemId ? 'item' : 'run',
          subjectId: run.itemId ?? run.id,
          projectId: run.projectId,
          // The run and step it was speaking from, so a reader of the item can get back to the
          // transcript that explains the note.
          author: {
            kind: 'agent',
            agentId: agent.id,
            agentName: agent.name,
            runId: run.id,
            stepId: step.id,
          },
          text: note.text,
          addressedTo: note.addressedTo,
        });

        const line = `left a note on ${comment.subjectId}${
          comment.addressedTo ? ` for ${comment.addressedTo}` : ''
        }: ${summarise(comment.text, 120)}`;
        this.events.emit({
          type: 'pipeline.step.output',
          runId: run.id,
          stepId: step.id,
          chunk: line,
        });
        this.logger.info(line);
      } catch (error) {
        this.logger.warn(
          `'${agent.name}' left a note that could not be stored: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /**
   * Say that a delegation was answered from the ledger rather than run.
   *
   * On the asking step's own output channel, which is where the budget line already goes: a
   * session that never opened records no step, so without this the only trace of a repeat is
   * a run that cost less than its transcript suggests it should have.
   */
  private noteMemo(run: PipelineRun, step: PipelineStep, target: string, task: string): void {
    const line = `answered from this run's ledger, no session opened: ${target} — ${summarise(task, 120)}`;
    this.events.emit({
      type: 'pipeline.step.output',
      runId: run.id,
      stepId: step.id,
      chunk: line,
    });
    this.logger.info(line);
  }

  /**
   * Put what an agent decided where every agent after it can see it.
   *
   * The same shelf a person's attachments land on, deliberately: an agent settling the shape
   * of a record and a person attaching a spec are the same kind of fact to whoever is asked
   * next, and one channel means one place to look when something arrives wrong.
   */
  /**
   * The run's context plus everything agents handed over during it.
   *
   * Kept as a merge rather than mutating `run.context`: the run object is passed by reference
   * to every agent still to come, and quietly growing it underneath them is how two versions
   * of the truth appear. Last writer wins on a name, matching `publish`.
   */
  private withHandovers(run: PipelineRun): ContextFile[] {
    const published = this.handedOver.get(run.id) ?? [];
    if (published.length === 0) return run.context;

    const others = run.context.filter((file) => !published.some((added) => added.name === file.name));
    return [...others, ...published];
  }

  private async publish(run: PipelineRun, files: ContextFile[]): Promise<void> {
    if (files.length === 0) return;

    // Clamped, never refused. `normaliseContext` throws, which is right for a person attaching
    // a file — they are told and can attach a smaller one — and wrong here: an agent is
    // mid-run, nobody is reading, and killing the run over an oversized note would throw away
    // work that is otherwise finished. What a handover cannot be is unbounded: it goes into
    // the front of every later agent's session and is therefore re-sent on every one of that
    // agent's internal turns, so its size is multiplied by their turn count, not paid once.
    const { files: clamped, notes } = clampHandover(files);
    for (const note of notes) this.logger.warn(`${run.id}: ${note}`);
    if (clamped.length === 0) return;

    const existing = this.handedOver.get(run.id) ?? [];
    // Last writer wins on a name: an agent correcting itself should replace what it said,
    // not leave two versions for the next agent to choose between.
    const kept = existing.filter((file) => !clamped.some((added) => added.name === file.name));
    const merged = withinBudget([...kept, ...clamped], (dropped) => {
      this.logger.warn(
        `${run.id}: handover '${dropped}' was dropped — the run's context reached the ${
          MAX_CONTEXT_BYTES / 1000
        }kB every later agent carries. The oldest goes first.`,
      );
    });

    this.handedOver.set(run.id, merged);

    const stored = await this.store.getRun(run.id);
    if (!stored) return;

    const others = stored.context.filter((file) => !merged.some((added) => added.name === file.name));
    await this.store.updateRun(run.id, { ...stored, context: [...others, ...merged] });
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

  /**
   * Steps still claiming to run after their run is over.
   *
   * When the process dies the step rows are never written again, so a tree keeps showing an
   * agent as working for hours. Nothing is running; say so.
   */
  private async closeStranded(runId: string): Promise<void> {
    for (const step of await this.store.steps(runId)) {
      if (step.status !== 'running' && step.status !== 'pending') continue;

      await this.store.updateStep(step.id, {
        ...step,
        status: 'cancelled',
        error: step.error ?? 'the process running this step is gone',
        endedAt: this.clock.iso(),
        durationMs: Date.parse(this.clock.iso()) - Date.parse(step.startedAt),
      });
    }
  }

  /** What this run spent, added up from its steps. */
  private async tally(runId: string): Promise<{ inputTokens: number; outputTokens: number }> {
    const steps = await this.store.steps(runId);
    return {
      inputTokens: steps.reduce((sum, step) => sum + step.inputTokens, 0),
      outputTokens: steps.reduce((sum, step) => sum + step.outputTokens, 0),
    };
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

  /**
   * Tell the backlog that this run and its gate finished, and report where the item ended up.
   *
   * The trigger, not the decision: everything an `auto` arrow could be waiting on — the gate
   * runs this run recorded, the agents' edits to the item body — has happened by now, and
   * nothing else re-reads it. What moves the item, if anything moves it, is the project's flow,
   * checked by the same guard a person's drag goes through.
   *
   * An item that does not move is not a failure. It stayed where it is because its flow says a
   * person decides this one, and it now says so on the board.
   */
  private async advanceItem(run: PipelineRun): Promise<string | null> {
    if (!run.itemId) return null;

    try {
      return (await this.backlog.reevaluate(run.projectId, run.itemId)).status;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`could not re-evaluate ${run.itemId}: ${message}`);
      return `could not move: ${message}`;
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
    // Before the release, never after: a worktree that has been given back is a directory
    // that no longer exists, and there is nothing left to commit out of it. This is also the
    // one seam every arm reaches — passed, failed and thrown — so a run that ended badly gets
    // its work committed too, which is exactly the run whose work is easiest to lose.
    const delivered = await this.deliver(run);

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
      unmet: [...stored.unmet, ...delivered.notes, ...notes],
      // The run's own record of where its work went. Read from here rather than from a
      // worktree row, which a clean release deletes at exactly the moment it starts mattering.
      branch: delivered.branch ?? stored.branch,
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
/**
 * An agent's handover, cut down to something every later agent can afford to carry.
 *
 * Truncates rather than refuses, and says so inside the file itself: an agent reading a note
 * that stops mid-sentence should be able to tell that it was cut, not conclude the author
 * stopped writing. Empty and binary handovers are dropped — there is nothing in them to pass on.
 */
export function clampHandover(files: ContextFile[]): { files: ContextFile[]; notes: string[] } {
  const notes: string[] = [];
  const kept: ContextFile[] = [];

  for (const file of files) {
    const name = file.name.split(/[\/]/).pop()?.trim() || 'handover';

    if (file.content.trim().length === 0 || file.content.includes('\u0000')) {
      notes.push(`handover '${name}' was ignored — it is empty or is not text`);
      continue;
    }

    const bytes = Buffer.byteLength(file.content, 'utf8');
    if (bytes <= MAX_CONTEXT_FILE_BYTES) {
      kept.push({ name, content: file.content, origin: 'handover' });
      continue;
    }

    // The note is part of what the file costs, so reserve it before cutting rather than
    // appending it afterwards and going over by its own length.
    const note = `

[cut here: this handover was ${Math.round(bytes / 1000)}kB, over the ${
      MAX_CONTEXT_FILE_BYTES / 1000
    }kB one file may carry. Hand over what was decided, not the material it was decided from.]
`;
    const room = MAX_CONTEXT_FILE_BYTES - Buffer.byteLength(note, 'utf8');

    // Slice the string, not the bytes, so a multi-byte character is never cut in half; then
    // shrink until it fits, because one character is not one byte.
    let cut = file.content.slice(0, Math.floor(file.content.length * (room / bytes)));
    while (cut.length > 0 && Buffer.byteLength(cut, 'utf8') > room) {
      cut = cut.slice(0, Math.max(0, cut.length - 64));
    }

    kept.push({ name, origin: 'handover', content: `${cut}${note}` });
    notes.push(
      `handover '${name}' was ${Math.round(bytes / 1000)}kB and was cut to ${
        MAX_CONTEXT_FILE_BYTES / 1000
      }kB`,
    );
  }

  return { files: kept, notes };
}

/**
 * Everything the run carries, held under the total every later agent pays for.
 *
 * Oldest first when something has to go: the most recent decision is the one the next agent
 * is most likely to need, and an agent that corrected itself replaced its own file already.
 */
export function withinBudget(
  files: ContextFile[],
  onDrop: (name: string) => void,
): ContextFile[] {
  const kept = [...files];
  while (kept.length > 1 && contextBytes(kept) > MAX_CONTEXT_BYTES) {
    const dropped = kept.shift();
    if (dropped) onDrop(dropped.name);
  }
  return kept;
}

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

/**
 * What a delegation is remembered under, so an exact repeat is answered rather than run.
 *
 * Trimmed, lowercased, and runs of whitespace collapsed to one space: a model that rewraps the
 * same paragraph across two lines means the same thing by it, and the protocol promises the
 * orchestrator that re-asking returns the earlier answer. Nothing beyond whitespace and case is
 * normalised — two tasks differing by a word are two tasks, and answering the second from the
 * first would be worse than paying for it.
 *
 * A resume seeds from stored steps through this same function, so an answer written by the
 * earlier attempt is found by the key the new attempt computes.
 */
function memoKey(agentId: string, task: string): string {
  return `${agentId}::${task.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

/** The name a resume's own summary always has, so a second resume replaces the first. */
const RESUME_FILE = 'resumed.md';

/**
 * What a resumed run is carrying, in the words the orchestrator needs on its first turn.
 *
 * Without this it re-reads a plan it has already carried out and cannot tell which parts are
 * already on disk, which is the expensive half of what a resume is meant to avoid.
 */
function describeResume(
  finished: Array<{ agentId: string; task: string }>,
  reclaimed: number,
  note?: string,
): string {
  const lines = [
    '# This run was resumed',
    '',
    `${finished.length} step${finished.length === 1 ? '' : 's'} from the earlier attempt` +
      ` ${finished.length === 1 ? 'is' : 'are'} already finished and already paid for.`,
  ];

  if (reclaimed > 0) {
    lines.push(
      '',
      `The work is where it was left: ${reclaimed} repo${reclaimed === 1 ? '' : 's'} came back` +
        ' with the same worktree, so files an agent has already written are on disk. Look at' +
        ' what is there before writing it again.',
    );
  }

  // The ledger is keyed on the delegation text, so a reworded repeat is a miss and the agent
  // runs — and is charged — a second time. Observed live: a resumed orchestrator helpfully
  // added "this run has been resumed" to the task and paid for the answer it already had.
  // Nothing but the exact words can be reused, so the exact words are what it is given.
  const quoted: string[] = [];
  let budget = MAX_REUSE_BYTES;

  for (const step of finished) {
    const entry = `- \`${step.agentId}\` — ask for exactly this:

  > ${step.task.trim()}`;
    const size = Buffer.byteLength(entry, 'utf8');
    if (size > budget) continue;
    budget -= size;
    quoted.push(entry);
  }

  if (quoted.length > 0) {
    lines.push(
      '',
      '## What you can have for free',
      '',
      'Delegating one of these again, worded exactly as written, returns the answer it already',
      'gave without opening a session. Change so much as a word and it runs again, and costs',
      'again. Do not add a note about this run having been resumed to the task — that is a',
      'reword, and it is the most expensive kind.',
      '',
      ...quoted,
    );
  }

  if (note?.trim()) {
    lines.push('', '## What changed since it stopped', '', note.trim());
  }

  return lines.join('\n');
}

/** How much of the prompt the reusable-task list may take. */
const MAX_REUSE_BYTES = 4000;

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

/**
 * Where a person opens a merge request for a branch that is now on the remote.
 *
 * Built from the remote url rather than by calling the forge: no token is needed, it works
 * against a self-hosted instance, and the page it opens is the one they would have navigated
 * to themselves. Null for an ssh remote or a host with no known shape — a wrong link is worse
 * than none, because it is followed.
 */
function mergeRequestUrl(remote: string | null, branch: string): string | null {
  if (!remote) return null;
  const base = remote.replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return null;

  const encoded = encodeURIComponent(branch);
  return base.includes('github.com')
    ? `${base}/compare/${encoded}?expand=1`
    : `${base}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encoded}`;
}

/**
 * How many rounds of delegation results stay in the conversation word for word.
 *
 * Two, because an orchestrator's next question is nearly always about the round it just got
 * back, and sometimes about the one before. Beyond that it is working from what it concluded,
 * not from the transcript — and it pays for the transcript again on every turn it takes.
 */
const ROUNDS_KEPT_WHOLE = 2;

/**
 * One delegate's answer, shrunk to its heading and its first line.
 *
 * The heading is the part that has to survive: it names the agent and carries the FAILED and
 * unmet flags, which is what stops an orchestrator asking the same agent the same question
 * again. The rest becomes one sentence — the same sentence a person reads in a run listing.
 */
function digest(result: string): string {
  const [heading = '', ...rest] = result.split('\n');
  return `${heading}\n\n${summarise(rest.join('\n'), 240) || '_no answer_'}`;
}

/**
 * Shrink the rounds nobody is still working from.
 *
 * Every turn re-sends the entire conversation, so a lead on its fifth round pays for four
 * rounds of full agent answers in order to ask one new question.
 *
 * Worth being honest about the size of this. Measured over the recorded steps, 96% of what a
 * run is billed for is cached context being re-read, at around 79,000 tokens a turn against
 * 2,500 fresh — and most of that is a session's own reading, which never passes through here.
 * What this reaches is the orchestrator's conversation: real, bounded, and not the main lever.
 * The main lever is how many turns a session takes and how much it reads; see POMN-64.
 *
 * A summary, not a truncation. Cutting old rounds outright is what made a lead ask the same
 * analyst the same question four times: it could not see what it had already delegated. What
 * stays is every heading — who answered, and whether they failed — and one sentence of what
 * each said. Handovers are untouched: those are files, published the moment an agent settles
 * them, and they were never in here.
 *
 * Idempotent, and it only ever shortens: a round already condensed is written the same way the
 * second time, and a round whose digest is not shorter than the round is left alone.
 */
function condense(history: LlmMessage[], settled: Array<{ index: number; digest: string }>): void {
  for (const round of settled.slice(0, Math.max(0, settled.length - ROUNDS_KEPT_WHOLE))) {
    const message = history[round.index];
    if (!message) continue;

    const shorter = [
      'Here is what came back from the agents you delegated to, in short — this round is',
      'settled, so it is kept as what it concluded rather than word for word.',
      '',
      round.digest,
    ].join('\n');

    if (shorter.length < message.content.length) message.content = shorter;
  }
}

/**
 * What an agent stopped by the budget hands back to whoever is waiting on it.
 *
 * Carries a `blocked` verdict, so an orchestrator reading it up the tree sees an agent that
 * did not deliver rather than an answer. `unmet` is left empty on purpose: the run puts the
 * stop sentence on itself once, and repeating it here would have it recorded twice.
 */
function stoppedAnswer(message: string): string {
  return [message, '', '```json', '{"outcome": "blocked", "unmet": []}', '```'].join('\n');
}

/**
 * What a session cut off mid-turn hands back: what it had said, and then why it stops there.
 *
 * `partial` rather than `blocked`. Blocked means an agent could not do the work; this one was
 * doing it. The distinction is what the difference between raising the ceiling and rethinking
 * the task rests on, and the reader making that decision is the person who set the ceiling.
 *
 * The stop sentence goes last, after the prose, so it reads as the note it is rather than as
 * the agent's own conclusion.
 */
function partialAnswer(said: string, message: string): string {
  return [
    said.trim() || '_This agent was stopped before it said anything._',
    '',
    `> ${message}`,
    '',
    '```json',
    '{"outcome": "partial", "unmet": []}',
    '```',
  ].join('\n');
}

/** Every token a turn is billed for. Cache reads and writes are tokens; they are most of them. */
function tokensUsed(usage: LlmUsage): number {
  return (
    usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens + usage.outputTokens
  );
}

/** `1st`, `2nd`, `3rd`, `4th`. Only ever reaches a reader inside a sentence about a turn. */
function nth(count: number): string {
  if (count % 100 >= 11 && count % 100 <= 13) return 'th';
  return ['th', 'st', 'nd', 'rd'][count % 10] ?? 'th';
}

/** git's own first line is what a person needs; the rest of a git failure is noise. */
function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0]?.trim() || message;
}
