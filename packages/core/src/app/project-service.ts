import { z } from 'zod';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import { assertSlug, deriveId, deriveItemPrefix } from '../domain/ids.js';
import { layout } from '../domain/layout.js';
import {
  ProjectSchema,
  type Project,
  type ProjectDetail,
  type ProjectPatch,
  type ProjectSummary,
} from '../domain/project.js';
import { RepoSchema, type Repo } from '../domain/repo.js';
import type { Clock, DocRef, DocStore, EventBus } from '../ports/index.js';

export interface CreateProjectInput {
  name: string;
  id?: string;
  description?: string;
}

export class ProjectService {
  constructor(
    private readonly docs: DocStore,
    private readonly clock: Clock,
    private readonly events: EventBus,
  ) {}

  async create(input: CreateProjectInput): Promise<Project> {
    const name = input.name.trim();
    if (!name) throw new ValidationError('project name is required');

    const id = input.id?.trim() || deriveId(name, 'project');
    assertSlug(id, 'project id');

    if (await this.docs.exists(layout.project(id))) {
      throw new ConflictError(`project '${id}' already exists`);
    }

    const now = this.clock.iso();
    const project = ProjectSchema.parse({
      id,
      name,
      description: input.description?.trim() ?? '',
      itemPrefix: deriveItemPrefix(id),
      counters: { nextItem: 1 },
      gates: {},
      policy: {},
      createdAt: now,
      updatedAt: now,
    });

    await this.docs.ensureDir(layout.reposDir(id));
    await this.docs.ensureDir(layout.backlogDir(id));
    await this.docs.write(layout.project(id), project, { mustNotExist: true });

    this.events.emit({ type: 'project.created', projectId: id });
    return project;
  }

  /** Derived by scanning the projects directory — there is no index file to drift. */
  async list(): Promise<ProjectSummary[]> {
    const ids = await this.listIds();
    const summaries = await Promise.all(
      ids.map(async (id) => {
        const ref = await this.docs.read(layout.project(id), ProjectSchema);
        if (!ref) return null;
        const repos = await this.listRepos(id);
        return {
          ...ref.data,
          repoCount: repos.length,
          repos: repos.map((repo) => ({
            id: repo.id,
            name: repo.name,
            role: repo.role,
            status: repo.status,
            stack: repo.stack,
          })),
        } satisfies ProjectSummary;
      }),
    );

    return summaries
      .filter((summary): summary is ProjectSummary => summary !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async listIds(): Promise<string[]> {
    const entries = await this.docs.list(layout.projectsDir);
    const ids: string[] = [];
    for (const entry of entries) {
      if (await this.docs.exists(layout.project(entry))) ids.push(entry);
    }
    return ids.sort();
  }

  async getRef(id: string): Promise<DocRef<Project>> {
    const ref = await this.docs.read(layout.project(id), ProjectSchema);
    if (!ref) throw new NotFoundError('project', id);
    return ref;
  }

  async get(id: string): Promise<ProjectDetail> {
    const ref = await this.getRef(id);
    return { ...ref.data, repos: await this.listRepos(id) };
  }

  async update(id: string, patch: ProjectPatch, ifMatch?: string): Promise<Project> {
    const ref = await this.getRef(id);
    const next = ProjectSchema.parse({
      ...ref.data,
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      // Assigned whole, never merged: a graph merged per-key by index is a graph nobody
      // wrote. `null` is a value here — it clears the project back to the built-in flow —
      // so presence of the key, not truthiness, decides.
      ...(patch.taskFlow !== undefined ? { taskFlow: patch.taskFlow } : {}),
      gates: { ...ref.data.gates, ...(patch.gates ?? {}) },
      policy: { ...ref.data.policy, ...(patch.policy ?? {}) },
      updatedAt: this.clock.iso(),
    });

    await this.docs.write(layout.project(id), next, { ifMatch: ifMatch ?? ref.rev });
    this.events.emit({ type: 'project.updated', projectId: id });
    return next;
  }

  /**
   * Removing a project always drops its Pomni-side records. `purge` additionally deletes
   * cloned working copies — linked local repos are never touched, because Pomni does not
   * own that code.
   */
  async remove(id: string, options: { purge?: boolean } = {}): Promise<void> {
    await this.getRef(id);
    if (options.purge) {
      await this.docs.removeDir(layout.workspaceProject(id));
    }
    await this.docs.removeDir(layout.projectDir(id));
    this.events.emit({ type: 'project.removed', projectId: id });
  }

  /**
   * Allocate the next backlog id and advance the counter. Callers hold the item lock — this
   * is a read-modify-write across two files once the item itself is written.
   */
  async nextItemId(id: string): Promise<string> {
    const ref = await this.getRef(id);
    const n = ref.data.counters.nextItem;
    await this.bumpItemCounter(id);
    return `${ref.data.itemPrefix}-${n}`;
  }

  /** Replace the list of workflows attached to this project. */
  async setWorkflows(id: string, workflows: string[]): Promise<string[]> {
    const ref = await this.getRef(id);
    const next = ProjectSchema.parse({
      ...ref.data,
      workflows: [...new Set(workflows)],
      updatedAt: this.clock.iso(),
    });
    await this.docs.write(layout.project(id), next, { ifMatch: ref.rev });
    this.events.emit({ type: 'project.updated', projectId: id });
    return next.workflows;
  }

  async setTools(id: string, tools: string[]): Promise<string[]> {
    const ref = await this.getRef(id);
    const next = ProjectSchema.parse({
      ...ref.data,
      tools: [...new Set(tools)],
      updatedAt: this.clock.iso(),
    });
    await this.docs.write(layout.project(id), next, { ifMatch: ref.rev });
    this.events.emit({ type: 'project.updated', projectId: id });
    return next.tools;
  }

  /** Advance the item counter without allocating. Used after the item file is written. */
  async bumpItemCounter(id: string): Promise<number> {
    const ref = await this.getRef(id);
    const n = ref.data.counters.nextItem;
    const next = ProjectSchema.parse({
      ...ref.data,
      counters: { nextItem: n + 1 },
      updatedAt: this.clock.iso(),
    });
    await this.docs.write(layout.project(id), next, { ifMatch: ref.rev });
    return n + 1;
  }

  private async listRepos(projectId: string): Promise<Repo[]> {
    const files = await this.docs.list(layout.reposDir(projectId));
    const repos: Repo[] = [];
    for (const file of files) {
      if (!file.endsWith('.yaml')) continue;
      const ref = await this.docs.read(
        `${layout.reposDir(projectId)}/${file}`,
        RepoSchema as z.ZodType<Repo>,
      );
      if (ref) repos.push(ref.data);
    }
    return repos.sort((a, b) => a.name.localeCompare(b.name));
  }
}
