import { z } from 'zod';
import { AgentSchema, isOrchestrator, type Agent } from './agent.js';
import { ValidationError } from './errors.js';

/**
 * A named pipeline: one orchestrator plus the agents it can call.
 *
 * The topology is deliberately not a hand-drawn graph. The orchestrator decides at runtime
 * which agents to call and in what order, which is the whole reason to have an orchestrator
 * — a fixed DAG would just be a script. The edges you watch during a run are the delegations
 * that actually happened, not ones drawn in advance.
 */

export const WorkflowSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string().default(''),
  agents: z.array(AgentSchema).default([]),
  /** Which orchestrator starts the run. Defaults to the only one. */
  entry: z.string().nullable().default(null),
  /**
   * A hint for choosing this workflow for a task — "bug fixes", "new features". Matched
   * loosely when a task does not name a workflow outright.
   */
  suits: z.array(z.string()).default([]),
  /**
   * The workflow that naturally follows this one — discovery hands off to delivery. Drawn as
   * an edge on the overview, and offered when a run finishes.
   */
  handoffTo: z.string().nullable().default(null),
  version: z.number().int().positive().default(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Workflow = z.infer<typeof WorkflowSchema>;

/** The portable form: what export writes and import reads. */
export const WorkflowExportSchema = z.object({
  pomniWorkflow: z.literal(1),
  exportedAt: z.string(),
  workflow: WorkflowSchema.omit({ createdAt: true, updatedAt: true }).extend({
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  }),
});
export type WorkflowExport = z.infer<typeof WorkflowExportSchema>;

export function findAgent(workflow: Workflow, agentId: string): Agent | null {
  return workflow.agents.find((agent) => agent.id === agentId) ?? null;
}

export function orchestrators(workflow: Workflow): Agent[] {
  return workflow.agents.filter(isOrchestrator);
}

/** The orchestrator a run starts from. */
export function entryAgent(workflow: Workflow): Agent {
  const heads = orchestrators(workflow);
  if (heads.length === 0) {
    throw new ValidationError(
      `workflow '${workflow.name}' has no orchestrator — add one, or a run has nobody to plan it`,
    );
  }

  if (workflow.entry) {
    const named = findAgent(workflow, workflow.entry);
    if (!named) throw new ValidationError(`entry agent '${workflow.entry}' is not in this workflow`);
    if (!isOrchestrator(named)) {
      throw new ValidationError(`entry agent '${named.name}' is not an orchestrator`);
    }
    return named;
  }

  if (heads.length > 1) {
    throw new ValidationError(
      `workflow '${workflow.name}' has ${heads.length} orchestrators — set which one starts the run`,
    );
  }
  return heads[0] as Agent;
}

/**
 * Who an orchestrator may call. An empty `delegatesTo` means "everyone else", which is what
 * you want almost always and saves maintaining a roster by hand.
 */
export function rosterFor(workflow: Workflow, orchestrator: Agent): Agent[] {
  const others = workflow.agents.filter((agent) => agent.id !== orchestrator.id);
  if (orchestrator.delegatesTo.length === 0) return others;
  return others.filter((agent) => orchestrator.delegatesTo.includes(agent.id));
}

export interface WorkflowProblem {
  agentId: string | null;
  message: string;
}

/**
 * Everything wrong with a workflow, rather than the first thing — an author fixing a
 * pipeline wants the whole list, not one error at a time.
 */
export function validateWorkflow(workflow: Workflow): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  const heads = orchestrators(workflow);

  if (workflow.agents.length === 0) {
    problems.push({ agentId: null, message: 'the workflow has no agents' });
  }
  if (heads.length === 0 && workflow.agents.length > 0) {
    problems.push({ agentId: null, message: 'no agent has the orchestrator role' });
  }
  if (heads.length > 1 && !workflow.entry) {
    problems.push({
      agentId: null,
      message: `${heads.length} orchestrators but no entry chosen — set which one starts`,
    });
  }

  const ids = new Set<string>();
  for (const agent of workflow.agents) {
    if (ids.has(agent.id)) {
      problems.push({ agentId: agent.id, message: `duplicate agent id '${agent.id}'` });
    }
    ids.add(agent.id);

    if (!agent.prompt.trim()) {
      problems.push({
        agentId: agent.id,
        message: `'${agent.name}' has no prompt — write a spec and generate one`,
      });
    }
    for (const target of agent.delegatesTo) {
      if (!workflow.agents.some((other) => other.id === target)) {
        problems.push({
          agentId: agent.id,
          message: `'${agent.name}' delegates to '${target}', which is not in this workflow`,
        });
      }
    }
    if (!isOrchestrator(agent) && agent.delegatesTo.length > 0) {
      problems.push({
        agentId: agent.id,
        message: `'${agent.name}' is not an orchestrator, so it cannot delegate`,
      });
    }
  }

  // An orchestrator with nobody to call is just an agent with extra steps.
  for (const head of heads) {
    if (rosterFor(workflow, head).length === 0) {
      problems.push({
        agentId: head.id,
        message: `'${head.name}' has no agents to delegate to`,
      });
    }
  }

  return problems;
}

export function isRunnable(workflow: Workflow): boolean {
  return validateWorkflow(workflow).length === 0;
}

/**
 * Pick a workflow for a task. An explicit choice wins; otherwise match the task text against
 * each workflow's `suits` hints; otherwise, if there is exactly one, use it.
 */
export function chooseWorkflow(
  workflows: Workflow[],
  task: string,
  explicitId?: string,
): Workflow | null {
  if (explicitId) return workflows.find((workflow) => workflow.id === explicitId) ?? null;

  const text = task.toLowerCase();
  const scored = workflows
    .map((workflow) => ({
      workflow,
      score: workflow.suits.filter((hint) => hint && text.includes(hint.toLowerCase())).length,
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length > 0) return scored[0]?.workflow ?? null;
  return workflows.length === 1 ? (workflows[0] as Workflow) : null;
}
