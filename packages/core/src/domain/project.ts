import { z } from 'zod';
import type { Repo } from './repo.js';

/**
 * A project is a container, not a codebase. It owns the backlog, the gates and the
 * policy; the code lives in its repos. "Acme SaaS" is a project; `acme-web` and
 * `acme-api` are repos inside it.
 */

export const ProjectPolicySchema = z.object({
  autoCommit: z.boolean().default(false),
  autoPush: z.boolean().default(false),
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
export const ProjectGatesSchema = z.object({
  default: z.array(z.string()).default(['typecheck', 'lint', 'test']),
  land: z.array(z.string()).default(['typecheck', 'lint', 'test', 'build']),
});
export type ProjectGates = z.infer<typeof ProjectGatesSchema>;

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string().default(''),
  /** Prefix for backlog ids: ACME-1. Fixed at creation so ids never churn. */
  itemPrefix: z.string().min(1),
  counters: z.object({ nextItem: z.number().int().positive().default(1) }).default({ nextItem: 1 }),
  gates: ProjectGatesSchema.default({}),
  /** Ids of agent workflows attached to this project. A task picks one of them. */
  workflows: z.array(z.string()).default([]),
  policy: ProjectPolicySchema.default({}),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Project = z.infer<typeof ProjectSchema>;

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
  gates: ProjectGatesSchema.partial().optional(),
  policy: ProjectPolicySchema.partial().optional(),
});
export type ProjectPatch = z.infer<typeof ProjectPatchSchema>;
