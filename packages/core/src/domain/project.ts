import { z } from 'zod';
import { DEFAULT_FLOW, FlowSchema } from './flow.js';
import type { Flow } from './flow.js';
import type { Repo } from './repo.js';

/**
 * A project is a container, not a codebase. It owns the backlog, the gates and the
 * policy; the code lives in its repos. "Acme SaaS" is a project; `acme-web` and
 * `acme-api` are repos inside it.
 */

export const ProjectPolicySchema = z.object({
  /**
   * Whether a run commits what it wrote, on its own branch, before giving its worktree back.
   *
   * On by default, and `autoPush` beside it is not, which is the asymmetry that matters. A
   * commit lands on a branch this run created, inside a directory Pomni made: it cannot
   * overwrite anyone's work, and the only alternative to it is loose files in a gitignored
   * directory that nothing downstream can review, merge or even name. A push is outward-facing
   * — it tells other people the work is ready — so it stays something a project opts into.
   */
  autoCommit: z.boolean().default(true),
  autoPush: z.boolean().default(false),
  /**
   * Whether a pushed branch also gets a merge request opened for it, through the forge's API.
   *
   * Separate from `autoPush` because it needs something more: a credential with API scope, not
   * only git access. When it is off, or the forge cannot be reached, the run still offers the
   * url a person opens themselves — the link is the fallback, not the failure.
   */
  autoMergeRequest: z.boolean().default(false),
  requireGreenGate: z.boolean().default(true),
  maxTurns: z.number().int().positive().default(200),
  maxCostUsd: z.number().positive().default(5),
});
export type ProjectPolicy = z.infer<typeof ProjectPolicySchema>;

/**
 * Gates name capabilities that must pass before a transition. They are resolved against
 * every repo that declares the capability, so a project-level gate fans out across repos
 * and a repo without `e2e` simply does not contribute one.
 */
export const ProjectGatesSchema = z
  .object({
    default: z.array(z.string()).default(['typecheck', 'lint', 'test']),
    land: z.array(z.string()).default(['typecheck', 'lint', 'test', 'build']),
  })
  // A flow may name any gate it likes, so gates beyond the two built-ins are kept rather
  // than stripped. `gates.release: [test, build, e2e]` is a gate a transition can require.
  .catchall(z.array(z.string()));
export type ProjectGates = z.infer<typeof ProjectGatesSchema>;

export const ProjectSchema = z
  .object({
    id: z.string(),
    name: z.string().min(1),
    description: z.string().default(''),
    /** Prefix for backlog ids: ACME-1. Fixed at creation so ids never churn. */
    itemPrefix: z.string().min(1),
    counters: z
      .object({ nextItem: z.number().int().positive().default(1) })
      .default({ nextItem: 1 }),
    gates: ProjectGatesSchema.default({}),
    /**
     * How backlog items move. `null` means "this project made no choice" and it runs on
     * `DEFAULT_FLOW` — which is not the same as writing the built-in flow out by hand, since
     * a project that made no choice follows the built-in flow as it evolves. Read it through
     * {@link flowOf}, never as `project.taskFlow` directly.
     */
    taskFlow: FlowSchema.nullable().default(null),
    /** Ids of agent workflows attached to this project. A task picks one of them. */
    workflows: z.array(z.string()).default([]),
    /** Ids of tools available to this project's agents. An agent still opts in to each. */
    tools: z.array(z.string()).default([]),
    policy: ProjectPolicySchema.default({}),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .superRefine((project, ctx) => {
    // A transition requiring a gate this project does not define can never pass, and would
    // otherwise fail as "gate has no runs" forever. Catch the typo where it was written.
    if (!project.taskFlow) return;
    project.taskFlow.transitions.forEach((transition, index) => {
      const gate = transition.requires.gate;
      if (gate !== null && !(gate in project.gates)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['taskFlow', 'transitions', index, 'requires', 'gate'],
          message: `no gate named '${gate}' on this project — declared gates: ${
            Object.keys(project.gates).join(', ') || 'none'
          }`,
        });
      }
    });
  });

export type Project = z.infer<typeof ProjectSchema>;

/** The flow a project runs on. The only correct way to read `taskFlow`. */
export function flowOf(project: Pick<Project, 'taskFlow'>): Flow {
  return project.taskFlow ?? DEFAULT_FLOW;
}

/** What list views need: the project plus a cheap summary of its repos. */
export interface ProjectSummary extends Project {
  repoCount: number;
  repos: Array<Pick<Repo, 'id' | 'name' | 'role' | 'status' | 'stack'>>;
}

export interface ProjectDetail extends Project {
  repos: Repo[];
}

/** Fields a caller is allowed to change directly. Counters and timestamps are not among them. */
export const ProjectPatchSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  /**
   * The key future items are numbered under, and the middle segment of every branch name.
   *
   * Changing it never renumbers the items already written: their ids are in commit messages,
   * branch names and prose, and rewriting them would break every one of those references to
   * make the backlog look tidy. Upper-cased and letters-only, because it has to survive being
   * put in a git ref.
   */
  itemPrefix: z
    .string()
    .trim()
    .min(1)
    .max(10)
    .regex(/^[A-Za-z][A-Za-z0-9]*$/, 'an item prefix is letters and digits, starting with a letter')
    .transform((value) => value.toUpperCase())
    .optional(),
  gates: ProjectGatesSchema.partial().optional(),
  /**
   * Replaced wholesale, never merged. A flow is a graph: merging arrays of states and arrows
   * by index produces a graph nobody wrote and that may still validate. `null` clears the
   * project back to the built-in flow; omitting the key leaves the flow untouched.
   */
  taskFlow: FlowSchema.nullable().optional(),
  policy: ProjectPolicySchema.partial().optional(),
});
export type ProjectPatch = z.infer<typeof ProjectPatchSchema>;
