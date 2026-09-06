import { z } from 'zod';
import { ValidationError } from './errors.js';

/**
 * An agent in a workflow.
 *
 * Two roles, and the difference is what they are allowed to do rather than how they are
 * built: an **orchestrator** plans and delegates to the agents in its roster and reads their
 * results; an **agent** is a single node that does one job and returns.
 *
 * The `spec` is what a human writes — a plain description of the job. The `prompt` is the
 * system prompt the model actually receives, and it is generated from the spec. Keeping the
 * two separate means you can regenerate the prompt after editing the spec without losing
 * the intent, and you can hand-edit the prompt without the spec silently overwriting it.
 */

export const AgentRoleSchema = z.enum(['orchestrator', 'agent']);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

/**
 * How hard the model should work on this agent's job.
 *
 * An agent never names a model. It says how much effort the work deserves, and the active
 * provider decides what that means — which is what lets one workflow run on Claude Code, on
 * an API key, or against a model on localhost without being rewritten.
 */
export const StruggleSchema = z.enum(['low', 'medium', 'high', 'max']);
export type Struggle = z.infer<typeof StruggleSchema>;

export const STRUGGLE_LEVELS: Struggle[] = ['low', 'medium', 'high', 'max'];

export interface StruggleInfo {
  level: Struggle;
  label: string;
  note: string;
}

export const STRUGGLE: Record<Struggle, StruggleInfo> = {
  low: {
    level: 'low',
    label: 'Low',
    note: 'Quick and cheap. Extraction, formatting, narrow lookups.',
  },
  medium: {
    level: 'medium',
    label: 'Medium',
    note: 'The working default. Most agents belong here.',
  },
  high: {
    level: 'high',
    label: 'High',
    note: 'Planning, judgement, anything where being wrong is expensive.',
  },
  max: {
    level: 'max',
    label: 'Max',
    note: 'Longest thinking on the strongest model. Reserve it for genuinely hard work.',
  },
};

/**
 * The old field named a model tier directly. Read those values as the level they meant, so
 * workflows written before the rename keep working.
 */
const LEGACY_SCALE: Record<string, Struggle> = {
  fast: 'low',
  balanced: 'medium',
  deep: 'high',
  max: 'max',
};

export const AgentSchema = z
  .object({
    id: z.string(),
    name: z.string().min(1),
    role: AgentRoleSchema.default('agent'),
    /** What a human wrote: the job, in prose. */
    spec: z.string().default(''),
    /** The system prompt the model receives. Generated from the spec, or hand-written. */
    prompt: z.string().default(''),
    /** True once the prompt was generated and the spec has not changed since. */
    promptGeneratedAt: z.string().nullable().default(null),
    struggle: StruggleSchema.default('medium'),
    /**
     * Orchestrators only: which agents this one may delegate to. Empty means every other
     * agent in the workflow, which is the usual case and saves wiring a roster by hand.
     */
    delegatesTo: z.array(z.string()).default([]),
    /** What this agent is expected to produce. Shown to the orchestrator when delegating. */
    outputs: z.string().default(''),
    /**
     * What this agent may use. `files` and `run` are the built-in abilities; `mcp` and `cli`
     * name tools from the registry, which must also be attached to the project.
     */
    tools: z
      .object({
        files: z.boolean().default(false),
        run: z.boolean().default(false),
        /**
         * May run the repos' own declared checks — `test`, `build`, `lint`, `typecheck` —
         * and nothing else. An agent that has to judge a change needs to build it; almost
         * none of them needs a shell that can also delete, push or install.
         */
        verify: z.boolean().default(false),
        mcp: z.array(z.string()).default([]),
        cli: z.array(z.string()).default([]),
      })
      .default({}),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .and(z.object({}).passthrough())
  .transform((value) => {
    const raw = value as Record<string, unknown> & { struggle: Struggle };
    const legacy = typeof raw.modelScale === 'string' ? LEGACY_SCALE[raw.modelScale] : undefined;
    const { modelScale: _dropped, ...rest } = raw;
    return { ...rest, struggle: legacy ?? raw.struggle } as Agent;
  });

export interface Agent {
  id: string;
  name: string;
  role: AgentRole;
  spec: string;
  prompt: string;
  promptGeneratedAt: string | null;
  struggle: Struggle;
  delegatesTo: string[];
  outputs: string;
  tools: { files: boolean; run: boolean; verify: boolean; mcp: string[]; cli: string[] };
  createdAt: string;
  updatedAt: string;
}

export function isOrchestrator(agent: Agent): boolean {
  return agent.role === 'orchestrator';
}

/** The prompt is stale when the spec changed after the prompt was generated. */
export function promptIsStale(agent: Agent): boolean {
  if (!agent.prompt) return Boolean(agent.spec);
  if (!agent.promptGeneratedAt) return false;
  return agent.updatedAt > agent.promptGeneratedAt;
}

export function assertRunnable(agent: Agent): void {
  if (!agent.prompt.trim()) {
    throw new ValidationError(
      `agent '${agent.name}' has no prompt yet — write a spec and generate one, or type the prompt directly`,
    );
  }
}
