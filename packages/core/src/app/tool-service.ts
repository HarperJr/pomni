import { assertSlug, deriveId } from '../domain/ids.js';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import { layout } from '../domain/layout.js';
import {
  assertUsableTool,
  ToolSchema,
  ToolsFileSchema,
  validateTool,
  type Tool,
  type ToolGrant,
  type ToolKind,
  type ToolsFile,
} from '../domain/tool.js';
import type { Clock, DocStore, EventBus, Executor, Logger } from '../ports/index.js';
import type { CredentialService } from './credential-service.js';
import type { ProjectService } from './project-service.js';

export interface CreateToolInput {
  name: string;
  kind: ToolKind;
  id?: string;
  description?: string;
  usage?: string;
  bin?: string;
  transport?: Tool['transport'];
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  envFrom?: string[];
  credential?: string | null;
  credentialEnv?: string | null;
  check?: string | null;
}

export type UpdateToolInput = Partial<CreateToolInput> & { enabled?: boolean };

/** Config plus whether it is currently usable. */
export interface ToolStatus extends Tool {
  problems: string[];
  usable: boolean;
  /** Projects this tool is attached to. */
  projects: string[];
}

export interface ToolCheckResult {
  id: string;
  name: string;
  /** `ok` ran and succeeded, `failed` ran and did not, `skipped` has no check command. */
  status: 'ok' | 'failed' | 'skipped';
  detail: string;
}

/**
 * The registry of things agents can use besides a model.
 *
 * A tool is registered once for the workspace and attached to the projects that may use it,
 * the same shape workflows have. The second gate — an agent naming the tool — is what stops
 * a Figma server attached to a project from turning up in the prompt of every agent in it.
 */
export class ToolService {
  constructor(
    private readonly docs: DocStore,
    private readonly projects: ProjectService,
    private readonly credentials: CredentialService,
    private readonly executor: Executor,
    private readonly clock: Clock,
    private readonly events: EventBus,
    private readonly logger: Logger,
  ) {}

  async list(): Promise<ToolStatus[]> {
    const attached = await this.attachments();
    const tools = (await this.load()).tools;

    return tools
      .map((tool) => this.status(tool, attached.get(tool.id) ?? []))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<ToolStatus> {
    const tool = (await this.load()).tools.find((candidate) => candidate.id === id);
    if (!tool) throw new NotFoundError('tool', id);
    return this.status(tool, (await this.attachments()).get(id) ?? []);
  }

  async create(input: CreateToolInput): Promise<Tool> {
    const name = input.name.trim();
    if (!name) throw new ValidationError('a tool needs a name');

    const id = input.id?.trim() || deriveId(name, 'tool');
    assertSlug(id, 'tool id');

    const file = await this.load();
    if (file.tools.some((tool) => tool.id === id)) {
      throw new ConflictError(`tool '${id}' already exists`);
    }
    if (input.credential) await this.credentials.get(input.credential);

    const now = this.clock.iso();
    const tool = ToolSchema.parse({
      ...this.fields(input),
      id,
      name,
      kind: input.kind,
      createdAt: now,
      updatedAt: now,
    });

    await this.save({ ...file, tools: [...file.tools, tool] });
    this.events.emit({ type: 'tool.changed', toolId: id });
    return tool;
  }

  async update(id: string, input: UpdateToolInput): Promise<Tool> {
    const file = await this.load();
    const current = file.tools.find((tool) => tool.id === id);
    if (!current) throw new NotFoundError('tool', id);
    if (input.credential) await this.credentials.get(input.credential);

    const next = ToolSchema.parse({
      ...current,
      ...this.fields(input),
      ...(input.name?.trim() ? { name: input.name.trim() } : {}),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      updatedAt: this.clock.iso(),
    });

    await this.save({
      ...file,
      tools: file.tools.map((tool) => (tool.id === id ? next : tool)),
    });
    this.events.emit({ type: 'tool.changed', toolId: id });
    return next;
  }

  async remove(id: string): Promise<void> {
    const file = await this.load();
    if (!file.tools.some((tool) => tool.id === id)) throw new NotFoundError('tool', id);

    // Leave no project pointing at a tool that is gone.
    for (const projectId of await this.projects.listIds()) {
      const project = await this.projects.getRef(projectId);
      if (project.data.tools.includes(id)) {
        await this.projects.setTools(
          projectId,
          project.data.tools.filter((toolId) => toolId !== id),
        );
      }
    }

    await this.save({ ...file, tools: file.tools.filter((tool) => tool.id !== id) });
    this.events.emit({ type: 'tool.changed', toolId: id });
  }

  async attach(projectId: string, toolId: string): Promise<string[]> {
    await this.get(toolId);
    const project = await this.projects.getRef(projectId);

    if (project.data.tools.includes(toolId)) return project.data.tools;
    return this.projects.setTools(projectId, [...project.data.tools, toolId]);
  }

  async detach(projectId: string, toolId: string): Promise<string[]> {
    const project = await this.projects.getRef(projectId);
    return this.projects.setTools(
      projectId,
      project.data.tools.filter((id) => id !== toolId),
    );
  }

  async forProject(projectId: string): Promise<ToolStatus[]> {
    const project = await this.projects.getRef(projectId);
    const all = await this.list();
    return project.data.tools
      .map((id) => all.find((tool) => tool.id === id))
      .filter((tool): tool is ToolStatus => tool !== undefined);
  }

  /**
   * What an agent asked for, resolved and ready to hand to a session.
   *
   * Both gates are enforced here: the tool must exist and be usable, and the project must
   * have it attached. An agent naming a tool nobody gave the project is a mistake worth a
   * clear error rather than a session that silently lacks what its prompt promises.
   */
  async grantsFor(projectId: string, ids: string[]): Promise<ToolGrant[]> {
    if (ids.length === 0) return [];

    const project = await this.projects.getRef(projectId);
    const available = await this.list();
    const grants: ToolGrant[] = [];

    for (const id of ids) {
      const tool = available.find((candidate) => candidate.id === id);
      if (!tool) {
        throw new ValidationError(`no tool '${id}' — register it with 'pomni tool add' first`);
      }
      if (!project.data.tools.includes(id)) {
        throw new ValidationError(
          `tool '${id}' is not attached to '${projectId}' — run 'pomni tool attach ${id} -p ${projectId}'`,
        );
      }
      assertUsableTool(tool);

      grants.push({ tool, secret: await this.secretFor(tool) });
    }
    return grants;
  }

  /** Run each tool's check command. The only way to know a tool works is to use it. */
  async check(ids?: string[]): Promise<ToolCheckResult[]> {
    const tools = (await this.list()).filter((tool) => !ids?.length || ids.includes(tool.id));
    const results: ToolCheckResult[] = [];

    for (const tool of tools) {
      if (tool.problems.length > 0) {
        results.push({
          id: tool.id,
          name: tool.name,
          status: 'failed',
          detail: tool.problems.join('; '),
        });
        continue;
      }
      if (!tool.check?.trim()) {
        results.push({
          id: tool.id,
          name: tool.name,
          status: 'skipped',
          detail: 'no check command',
        });
        continue;
      }

      let output = '';
      const result = await this.executor.run({
        cmd: tool.check,
        cwd: this.docs.root,
        timeoutMs: 60_000,
        onOutput: (chunk) => {
          output += chunk;
        },
      });

      results.push({
        id: tool.id,
        name: tool.name,
        status: result.exitCode === 0 ? 'ok' : 'failed',
        detail: lastLine(output) || (result.timedOut ? 'timed out' : `exit ${result.exitCode}`),
      });
    }
    return results;
  }

  // -------------------------------------------------------------------------

  private status(tool: Tool, projects: string[]): ToolStatus {
    const problems = validateTool(tool);
    return { ...tool, problems, usable: problems.length === 0 && tool.enabled, projects };
  }

  /** Which projects reference which tool. One pass, rather than one read per tool. */
  private async attachments(): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();

    for (const projectId of await this.projects.listIds()) {
      const project = await this.projects.getRef(projectId);
      for (const toolId of project.data.tools) {
        map.set(toolId, [...(map.get(toolId) ?? []), projectId]);
      }
    }
    return map;
  }

  private async secretFor(tool: Tool): Promise<string | null> {
    if (!tool.credential) return null;

    const secret = await this.credentials.secretFor(tool.credential);
    if (!secret) {
      throw new ValidationError(
        `tool '${tool.id}' needs credential '${tool.credential}', which has no secret available`,
      );
    }
    return secret;
  }

  /** The subset of an input that maps straight onto the schema. */
  private fields(input: CreateToolInput | UpdateToolInput): Record<string, unknown> {
    const fields: Record<string, unknown> = {};

    for (const key of [
      'description',
      'usage',
      'bin',
      'transport',
      'command',
      'args',
      'url',
      'headers',
      'env',
      'envFrom',
      'credential',
      'credentialEnv',
      'check',
    ] as Array<keyof CreateToolInput>) {
      if (input[key] !== undefined) fields[key] = input[key];
    }
    return fields;
  }

  private async load(): Promise<ToolsFile> {
    const ref = await this.docs.read(layout.tools, ToolsFileSchema);
    return ref?.data ?? ToolsFileSchema.parse({});
  }

  private async save(file: ToolsFile): Promise<void> {
    await this.docs.write(layout.tools, file);
    this.logger.debug('tools written', file.tools.length);
  }
}

function lastLine(output: string): string {
  return output.trim().split('\n').filter(Boolean).pop()?.trim().slice(0, 200) ?? '';
}
