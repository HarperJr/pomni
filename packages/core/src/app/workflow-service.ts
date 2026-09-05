import { z } from 'zod';
import {
  AgentSchema,
  STRUGGLE,
  STRUGGLE_LEVELS,
  type Agent,
  type AgentRole,
  type Struggle,
} from '../domain/agent.js';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import { assertSlug, deriveId, uniqueId } from '../domain/ids.js';
import { layout } from '../domain/layout.js';
import {
  WorkflowExportSchema,
  WorkflowSchema,
  entryAgent,
  findAgent,
  rosterFor,
  validateWorkflow,
  type Workflow,
  type WorkflowProblem,
} from '../domain/workflow.js';
import type { Clock, DocRef, DocStore, EventBus } from '../ports/index.js';
import type { ProjectService } from './project-service.js';
import type { ProviderService } from './provider-service.js';

export interface CreateWorkflowInput {
  name: string;
  id?: string;
  description?: string;
  suits?: string[];
}

export interface CreateAgentInput {
  name: string;
  id?: string;
  role?: AgentRole;
  spec?: string;
  prompt?: string;
  struggle?: Struggle;
  outputs?: string;
  delegatesTo?: string[];
  tools?: { files?: boolean; run?: boolean };
}

export type UpdateAgentInput = Partial<CreateAgentInput>;

export interface WorkflowDetail extends Workflow {
  problems: WorkflowProblem[];
  runnable: boolean;
}

/**
 * Authoring pipelines: workflows, the agents inside them, and the prompts those agents run.
 *
 * Workflows live outside any project (`.pomni/workflows/`) so one can be attached to several
 * projects and shared as a file. A project references them by id.
 */
export class WorkflowService {
  constructor(
    private readonly docs: DocStore,
    private readonly projects: ProjectService,
    private readonly providers: ProviderService,
    private readonly clock: Clock,
    private readonly events: EventBus,
  ) {}

  // -- workflows ------------------------------------------------------------

  async create(input: CreateWorkflowInput): Promise<Workflow> {
    const name = input.name.trim();
    if (!name) throw new ValidationError('a workflow needs a name');

    const id = input.id?.trim() || deriveId(name, 'workflow');
    assertSlug(id, 'workflow id');

    if (await this.docs.exists(layout.workflow(id))) {
      throw new ConflictError(`workflow '${id}' already exists`);
    }

    const now = this.clock.iso();
    const workflow = WorkflowSchema.parse({
      id,
      name,
      description: input.description ?? '',
      suits: input.suits ?? [],
      agents: [],
      entry: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });

    await this.docs.ensureDir(layout.workflowsDir);
    await this.docs.write(layout.workflow(id), workflow, { mustNotExist: true });
    this.events.emit({ type: 'workflow.changed', workflowId: id });
    return workflow;
  }

  async list(): Promise<WorkflowDetail[]> {
    const files = await this.docs.list(layout.workflowsDir);
    const workflows: WorkflowDetail[] = [];

    for (const file of files) {
      if (!file.endsWith('.yaml')) continue;
      const ref = await this.read(file.replace(/\.yaml$/, ''));
      if (ref) workflows.push(this.detail(ref.data));
    }
    return workflows.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<WorkflowDetail> {
    return this.detail((await this.getRef(id)).data);
  }

  async getRef(id: string): Promise<DocRef<Workflow>> {
    const ref = await this.read(id);
    if (!ref) throw new NotFoundError('workflow', id);
    return ref;
  }

  async update(
    id: string,
    patch: {
      name?: string;
      description?: string;
      suits?: string[];
      entry?: string | null;
      handoffTo?: string | null;
    },
    ifMatch?: string,
  ): Promise<Workflow> {
    const ref = await this.getRef(id);
    const next = WorkflowSchema.parse({
      ...ref.data,
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.suits !== undefined ? { suits: patch.suits } : {}),
      ...(patch.entry !== undefined ? { entry: patch.entry } : {}),
      ...(patch.handoffTo !== undefined ? { handoffTo: patch.handoffTo } : {}),
      updatedAt: this.clock.iso(),
    });
    return this.save(next, ifMatch ?? ref.rev);
  }

  async remove(id: string): Promise<void> {
    await this.getRef(id);

    const attached: string[] = [];
    for (const projectId of await this.projects.listIds()) {
      const project = await this.projects.getRef(projectId);
      if (project.data.workflows.includes(id)) attached.push(projectId);
    }
    if (attached.length > 0) {
      throw new ConflictError(
        `workflow '${id}' is attached to ${attached.join(', ')} — detach it first`,
        { projects: attached },
      );
    }

    await this.docs.delete(layout.workflow(id));
    this.events.emit({ type: 'workflow.changed', workflowId: id });
  }

  // -- agents ---------------------------------------------------------------

  async addAgent(workflowId: string, input: CreateAgentInput): Promise<Agent> {
    const ref = await this.getRef(workflowId);
    const name = input.name.trim();
    if (!name) throw new ValidationError('an agent needs a name');

    const id = uniqueId(
      input.id?.trim() || deriveId(name, 'agent'),
      ref.data.agents.map((agent) => agent.id),
    );
    assertSlug(id, 'agent id');

    const role = input.role ?? 'agent';
    const now = this.clock.iso();
    const agent = AgentSchema.parse({
      id,
      name,
      role,
      spec: input.spec ?? '',
      prompt: input.prompt ?? '',
      promptGeneratedAt: null,
      // An orchestrator is doing the planning, so it works harder by default.
      struggle: input.struggle ?? (role === 'orchestrator' ? 'high' : 'medium'),
      outputs: input.outputs ?? '',
      delegatesTo: input.delegatesTo ?? [],
      tools: input.tools ?? {},
      createdAt: now,
      updatedAt: now,
    });

    const next = WorkflowSchema.parse({
      ...ref.data,
      agents: [...ref.data.agents, agent],
      // First orchestrator added becomes the entry point without being asked.
      entry: ref.data.entry ?? (role === 'orchestrator' ? id : null),
      updatedAt: now,
    });

    await this.save(next, ref.rev);
    return agent;
  }

  async updateAgent(
    workflowId: string,
    agentId: string,
    patch: UpdateAgentInput,
  ): Promise<Agent> {
    const ref = await this.getRef(workflowId);
    const current = findAgent(ref.data, agentId);
    if (!current) throw new NotFoundError('agent', `${workflowId}/${agentId}`);

    const updated = AgentSchema.parse({
      ...current,
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.role !== undefined ? { role: patch.role } : {}),
      ...(patch.spec !== undefined ? { spec: patch.spec } : {}),
      ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
      ...(patch.struggle !== undefined ? { struggle: patch.struggle } : {}),
      ...(patch.outputs !== undefined ? { outputs: patch.outputs } : {}),
      ...(patch.delegatesTo !== undefined ? { delegatesTo: patch.delegatesTo } : {}),
      ...(patch.tools !== undefined ? { tools: { ...current.tools, ...patch.tools } } : {}),
      updatedAt: this.clock.iso(),
    });

    await this.replaceAgent(ref, updated);
    return updated;
  }

  async removeAgent(workflowId: string, agentId: string): Promise<void> {
    const ref = await this.getRef(workflowId);
    if (!findAgent(ref.data, agentId)) {
      throw new NotFoundError('agent', `${workflowId}/${agentId}`);
    }

    const next = WorkflowSchema.parse({
      ...ref.data,
      agents: ref.data.agents
        .filter((agent) => agent.id !== agentId)
        // Leaving a dangling roster entry would silently shrink an orchestrator's options.
        .map((agent) => ({
          ...agent,
          delegatesTo: agent.delegatesTo.filter((target) => target !== agentId),
        })),
      entry: ref.data.entry === agentId ? null : ref.data.entry,
      updatedAt: this.clock.iso(),
    });

    await this.save(next, ref.rev);
  }

  // -- prompt generation ----------------------------------------------------

  /**
   * Turn a human-written spec into the system prompt the agent will run.
   *
   * The generator is given the workflow around the agent — its role, its roster, what the
   * other agents produce — because a prompt written without that context tends to duplicate
   * a neighbour's job or invent a handoff that does not exist.
   */
  async generatePrompt(workflowId: string, agentId: string): Promise<Agent> {
    const ref = await this.getRef(workflowId);
    const agent = findAgent(ref.data, agentId);
    if (!agent) throw new NotFoundError('agent', `${workflowId}/${agentId}`);

    if (!agent.spec.trim()) {
      throw new ValidationError(
        `'${agent.name}' has no spec yet — describe the job first, then generate the prompt`,
      );
    }

    // Writing a good prompt is judgement work, so this is not the place to economise —
    // whichever provider is in use, ask for its strongest tier.
    const { port, model, provider } = await this.providers.portFor('high');

    const result = await port.complete({
      model,
      // Claude Code drives its own thinking; the flag is for the direct API path.
      adaptiveThinking: provider.kind !== 'claude-code',
      effort: 'high',
      maxTokens: 4000,
      system: PROMPT_WRITER_SYSTEM,
      messages: [{ role: 'user', content: this.promptBrief(ref.data, agent) }],
    });

    const prompt = stripFence(result.text);
    if (!prompt) throw new ValidationError('the model returned an empty prompt — try again');

    const now = this.clock.iso();
    const updated = AgentSchema.parse({
      ...agent,
      prompt,
      promptGeneratedAt: now,
      updatedAt: now,
    });

    await this.replaceAgent(ref, updated);
    return updated;
  }

  private promptBrief(workflow: Workflow, agent: Agent): string {
    const roster = agent.role === 'orchestrator' ? rosterFor(workflow, agent) : [];
    const lines = [
      `# Workflow: ${workflow.name}`,
      workflow.description ? workflow.description : null,
      '',
      `# Agent to write a prompt for`,
      `Name: ${agent.name}`,
      `Role: ${agent.role}`,
      `Effort: ${STRUGGLE[agent.struggle].label} — ${STRUGGLE[agent.struggle].note}`,
      agent.outputs ? `Expected output: ${agent.outputs}` : null,
      '',
      '## What the author wrote about this agent',
      agent.spec,
    ].filter((line): line is string => line !== null);

    if (agent.role === 'orchestrator') {
      lines.push(
        '',
        '## Agents this orchestrator can delegate to',
        roster.length === 0
          ? '(none yet)'
          : roster
              .map(
                (other) =>
                  `- ${other.name} (id \`${other.id}\`): ${other.spec.split('\n')[0] ?? ''}${
                    other.outputs ? ` Produces: ${other.outputs}` : ''
                  }`,
              )
              .join('\n'),
        '',
        'It delegates by calling a `delegate` tool with an agent id and a task description,',
        'and receives that agent\'s final answer as the tool result.',
      );
    } else {
      const peers = workflow.agents.filter((other) => other.id !== agent.id);
      if (peers.length > 0) {
        lines.push(
          '',
          '## Other agents in the workflow (for context; this agent does not call them)',
          peers.map((other) => `- ${other.name}: ${other.spec.split('\n')[0] ?? ''}`).join('\n'),
        );
      }
    }

    return lines.join('\n');
  }

  // -- export / import ------------------------------------------------------

  async export(id: string): Promise<string> {
    const { data } = await this.getRef(id);
    const payload = {
      pomniWorkflow: 1 as const,
      exportedAt: this.clock.iso(),
      workflow: data,
    };
    return `${JSON.stringify(payload, null, 2)}\n`;
  }

  /**
   * Import a previously exported workflow. Ids collide across machines, so a clash renames
   * rather than refusing — losing an import because a name was taken is worse than a suffix.
   */
  async import(raw: string, options: { id?: string } = {}): Promise<Workflow> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ValidationError('that is not valid JSON — expected a Pomni workflow export');
    }

    const result = WorkflowExportSchema.safeParse(parsed);
    if (!result.success) {
      throw new ValidationError(
        'that JSON is not a Pomni workflow export',
        result.error.format(),
      );
    }

    const incoming = result.data.workflow;
    const existing = (await this.list()).map((workflow) => workflow.id);
    const id = uniqueId(options.id?.trim() || incoming.id, existing);
    assertSlug(id, 'workflow id');

    const now = this.clock.iso();
    const workflow = WorkflowSchema.parse({
      ...incoming,
      id,
      createdAt: incoming.createdAt ?? now,
      updatedAt: now,
    });

    await this.docs.ensureDir(layout.workflowsDir);
    await this.docs.write(layout.workflow(id), workflow, { mustNotExist: true });
    this.events.emit({ type: 'workflow.changed', workflowId: id });
    return workflow;
  }

  // -- attaching to projects ------------------------------------------------

  async attach(projectId: string, workflowId: string): Promise<string[]> {
    await this.getRef(workflowId);
    const project = await this.projects.getRef(projectId);

    if (project.data.workflows.includes(workflowId)) return project.data.workflows;
    const next = [...project.data.workflows, workflowId];
    await this.projects.setWorkflows(projectId, next);
    return next;
  }

  async detach(projectId: string, workflowId: string): Promise<string[]> {
    const project = await this.projects.getRef(projectId);
    const next = project.data.workflows.filter((id) => id !== workflowId);
    await this.projects.setWorkflows(projectId, next);
    return next;
  }

  async forProject(projectId: string): Promise<WorkflowDetail[]> {
    const project = await this.projects.getRef(projectId);
    const all = await this.list();
    return project.data.workflows
      .map((id) => all.find((workflow) => workflow.id === id))
      .filter((workflow): workflow is WorkflowDetail => workflow !== undefined);
  }

  /** The struggle levels, so a UI does not hardcode them. */
  scales(): Array<{ struggle: Struggle; label: string; note: string }> {
    return STRUGGLE_LEVELS.map((struggle) => ({
      struggle,
      label: STRUGGLE[struggle].label,
      note: STRUGGLE[struggle].note,
    }));
  }

  // -------------------------------------------------------------------------

  private detail(workflow: Workflow): WorkflowDetail {
    const problems = validateWorkflow(workflow);
    return { ...workflow, problems, runnable: problems.length === 0 };
  }

  /** Throws with the reason when the workflow cannot run. Used before starting a task. */
  assertRunnable(workflow: Workflow): void {
    const problems = validateWorkflow(workflow);
    if (problems.length > 0) {
      throw new ValidationError(
        `workflow '${workflow.name}' is not ready:\n  ${problems
          .map((problem) => problem.message)
          .join('\n  ')}`,
      );
    }
    entryAgent(workflow);
  }

  private async replaceAgent(ref: DocRef<Workflow>, agent: Agent): Promise<void> {
    const next = WorkflowSchema.parse({
      ...ref.data,
      agents: ref.data.agents.map((other) => (other.id === agent.id ? agent : other)),
      updatedAt: this.clock.iso(),
    });
    await this.save(next, ref.rev);
  }

  private async save(workflow: Workflow, ifMatch: string): Promise<Workflow> {
    await this.docs.write(layout.workflow(workflow.id), workflow, { ifMatch });
    this.events.emit({ type: 'workflow.changed', workflowId: workflow.id });
    return workflow;
  }

  private async read(id: string): Promise<DocRef<Workflow> | null> {
    return this.docs.read(layout.workflow(id), WorkflowSchema as z.ZodType<Workflow>);
  }
}

/**
 * The prompt-writer's own prompt.
 *
 * The instructions it is told to avoid — role-play preambles, "you are an expert", threats
 * and flattery — are cargo from older models that current ones do not need and that crowd
 * out the actual job description.
 */
const PROMPT_WRITER_SYSTEM = `You write system prompts for agents in an automated software pipeline.

You will be given a workflow, one agent in it, and the author's description of that agent's
job. Return the system prompt for that agent — the text the model will receive — and nothing
else. No preamble, no explanation, no markdown fences around it.

What makes a good prompt here:

- State the job plainly in the first line or two. What this agent is for, and what it returns.
- Be concrete about the output: its shape, and what must be in it for the caller to use it.
  The caller is usually another agent, not a person, so say what it needs mechanically.
- Name the boundaries. What is out of scope, and what it should hand back rather than guess at.
- Prefer describing the goal over enumerating steps. Give a procedure only where order
  genuinely matters or a step is easy to miss.
- If the agent is an orchestrator, say how to decide which agent to delegate to, what a good
  task description to a sub-agent looks like, and what to do when one fails or returns
  something unusable. It should synthesise the results, not just concatenate them.
- If the agent can read or run things, say when to and when not to.

What to leave out:

- "You are an expert/world-class/senior…" framing, and any role-play preamble.
- Emotional pressure, threats, rewards, or insistence on being thorough.
- Instructions about how much to think, or told-you-so reminders to double-check.
- Restating what the model already does well; only say what is specific to this job.
- Any mention of these instructions.

Write in the second person, addressed to the agent. Use short paragraphs, and lists only
where the content is genuinely a list. Aim for the shortest prompt that fully specifies the
job — usually 150-400 words.`;

/** Models sometimes wrap a prompt in a fence despite being asked not to. */
function stripFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:[a-zA-Z]*)\n([\s\S]*?)\n```$/.exec(trimmed);
  return (fenced ? (fenced[1] ?? '') : trimmed).trim();
}
