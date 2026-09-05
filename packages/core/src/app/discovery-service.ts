import type { Struggle } from '../domain/agent.js';
import { NotFoundError } from '../domain/errors.js';
import type { FsProbe } from '../ports/index.js';
import type { RepoService } from './repo-service.js';
import type { WorkflowService } from './workflow-service.js';

/**
 * Finds the agent definitions, skills and commands that already live inside a project's
 * repos, so a workflow can reuse them instead of restating them.
 *
 * A team that works with Claude Code already has `.claude/agents/*.md` and
 * `.claude/skills/<name>/SKILL.md` checked in. Those are exactly the descriptions Pomni wants for
 * its own agents, written by the people who know the codebase — asking them to write it all
 * again in a different box would be a poor trade.
 */

export type AssetKind = 'agent' | 'skill' | 'command' | 'rules';

export interface DiscoveredAsset {
  kind: AssetKind;
  /** Slug taken from the frontmatter name, else the filename. */
  id: string;
  name: string;
  description: string;
  /** Which repo it came from, and where. */
  repoId: string;
  path: string;
  /** Model named in the frontmatter, if any — mapped onto a Pomni scale where possible. */
  struggle: Struggle | null;
  /** Tools the definition allows, verbatim. */
  tools: string[];
  /** The body: the agent's prompt, or the skill's instructions. */
  body: string;
}

export interface DiscoveryReport {
  projectId: string;
  scanned: Array<{ repoId: string; workingDir: string; found: number }>;
  assets: DiscoveredAsset[];
}

const MAX_BODY = 60_000;

export class DiscoveryService {
  constructor(
    private readonly repos: RepoService,
    private readonly workflows: WorkflowService,
    private readonly fs: FsProbe,
  ) {}

  async scan(projectId: string, options: { repoId?: string } = {}): Promise<DiscoveryReport> {
    const all = await this.repos.listResolved(projectId);
    const targets = options.repoId ? all.filter((repo) => repo.id === options.repoId) : all;

    const report: DiscoveryReport = { projectId, scanned: [], assets: [] };

    for (const repo of targets) {
      if (!repo.workingDirExists) {
        report.scanned.push({ repoId: repo.id, workingDir: repo.workingDir, found: 0 });
        continue;
      }

      const found = [
        ...(await this.scanAgents(repo.id, repo.workingDir)),
        ...(await this.scanSkills(repo.id, repo.workingDir)),
        ...(await this.scanCommands(repo.id, repo.workingDir)),
        ...(await this.scanRules(repo.id, repo.workingDir)),
      ];

      report.assets.push(...found);
      report.scanned.push({
        repoId: repo.id,
        workingDir: repo.workingDir,
        found: found.length,
      });
    }

    return report;
  }

  /**
   * Import a discovered agent into a workflow. Its body becomes the prompt directly — it was
   * written to be a prompt — and its description becomes the spec, so regenerating later
   * still has something to work from.
   */
  async importAgent(
    projectId: string,
    workflowId: string,
    assetId: string,
    options: { repoId?: string } = {},
  ): Promise<{ agentId: string }> {
    const report = await this.scan(projectId, options);
    const asset = report.assets.find(
      (candidate) => candidate.id === assetId && candidate.kind === 'agent',
    );
    if (!asset) throw new NotFoundError('discovered agent', assetId);

    const created = await this.workflows.addAgent(workflowId, {
      name: asset.name,
      role: 'agent',
      spec: asset.description || `Imported from ${asset.repoId}:${asset.path}`,
      prompt: asset.body,
      struggle: asset.struggle ?? 'medium',
      tools: { files: asset.tools.length === 0 || hasFileTools(asset.tools), run: hasRunTools(asset.tools) },
    });

    return { agentId: created.id };
  }

  // -------------------------------------------------------------------------

  private async scanAgents(repoId: string, dir: string): Promise<DiscoveredAsset[]> {
    const base = `${dir}/.claude/agents`;
    const assets: DiscoveredAsset[] = [];

    for (const file of await this.fs.listNames(base)) {
      if (!file.endsWith('.md')) continue;
      const raw = await this.fs.readText(`${base}/${file}`);
      if (!raw) continue;

      const { frontmatter, body } = splitFrontmatter(raw);
      assets.push({
        kind: 'agent',
        id: slug(frontmatter.name ?? file.replace(/\.md$/, '')),
        name: frontmatter.name ?? file.replace(/\.md$/, ''),
        description: frontmatter.description ?? '',
        repoId,
        path: `.claude/agents/${file}`,
        struggle: scaleFromModel(frontmatter.model),
        tools: splitList(frontmatter.tools),
        body: body.slice(0, MAX_BODY),
      });
    }

    return assets;
  }

  private async scanSkills(repoId: string, dir: string): Promise<DiscoveredAsset[]> {
    const base = `${dir}/.claude/skills`;
    const assets: DiscoveredAsset[] = [];

    for (const entry of await this.fs.listNames(base)) {
      // Two shapes in the wild: a directory holding SKILL.md, and a flat `<name>.md`.
      // Only reading the first misses whole libraries of skills.
      const isFlat = entry.endsWith('.md');
      const path = isFlat ? `.claude/skills/${entry}` : `.claude/skills/${entry}/SKILL.md`;

      const raw = await this.fs.readText(`${dir}/${path}`);
      if (!raw) continue;

      const fallbackName = isFlat ? entry.replace(/\.md$/, '') : entry;
      const { frontmatter, body } = splitFrontmatter(raw);

      assets.push({
        kind: 'skill',
        id: slug(frontmatter.name ?? fallbackName),
        name: frontmatter.name ?? fallbackName,
        description: frontmatter.description ?? firstLine(body),
        repoId,
        path,
        struggle: null,
        tools: splitList(frontmatter['allowed-tools']),
        body: body.slice(0, MAX_BODY),
      });
    }

    return assets;
  }

  private async scanCommands(repoId: string, dir: string): Promise<DiscoveredAsset[]> {
    const base = `${dir}/.claude/commands`;
    const assets: DiscoveredAsset[] = [];

    for (const file of await this.fs.listNames(base)) {
      if (!file.endsWith('.md')) continue;
      const raw = await this.fs.readText(`${base}/${file}`);
      if (!raw) continue;

      const { frontmatter, body } = splitFrontmatter(raw);
      const name = file.replace(/\.md$/, '');
      assets.push({
        kind: 'command',
        id: slug(name),
        name: `/${name}`,
        description: frontmatter.description ?? '',
        repoId,
        path: `.claude/commands/${file}`,
        struggle: null,
        tools: splitList(frontmatter['allowed-tools']),
        body: body.slice(0, MAX_BODY),
      });
    }

    return assets;
  }

  /** A repo's own CLAUDE.md is the house style; an agent working there should see it. */
  private async scanRules(repoId: string, dir: string): Promise<DiscoveredAsset[]> {
    for (const name of ['CLAUDE.md', 'AGENTS.md']) {
      const raw = await this.fs.readText(`${dir}/${name}`);
      if (!raw) continue;

      return [
        {
          kind: 'rules',
          id: slug(`${repoId}-${name}`),
          name,
          description: firstLine(raw),
          repoId,
          path: name,
          struggle: null,
          tools: [],
          body: raw.slice(0, MAX_BODY),
        },
      ];
    }
    return [];
  }
}

// ---------------------------------------------------------------------------

/**
 * Minimal frontmatter reader: flat `key: value` pairs, which is all these files use.
 * Deliberately not a YAML parser — a malformed agent file should yield a thin result, never
 * fail a scan of the whole project.
 */
export function splitFrontmatter(raw: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { frontmatter: {}, body: raw.trim() };

  const frontmatter: Record<string, string> = {};
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!pair) continue;
    frontmatter[pair[1] as string] = (pair[2] ?? '').trim().replace(/^["']|["']$/g, '');
  }

  return { frontmatter, body: raw.slice(match[0].length).trim() };
}

/** Map a model named in a definition onto a Pomni scale, by family rather than exact id. */
export function scaleFromModel(model: string | undefined): Struggle | null {
  if (!model) return null;
  const value = model.toLowerCase();
  if (value.includes('haiku')) return 'low';
  if (value.includes('sonnet')) return 'medium';
  if (value.includes('fable') || value.includes('mythos')) return 'max';
  if (value.includes('opus')) return 'high';
  // `inherit` and anything unrecognised: let the caller choose a default.
  return null;
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function hasFileTools(tools: string[]): boolean {
  return tools.some((tool) => /^(Read|Write|Edit|Glob|Grep|NotebookEdit)$/i.test(tool));
}

function hasRunTools(tools: string[]): boolean {
  return tools.some((tool) => /^(Bash|PowerShell)$/i.test(tool));
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.replace(/^#+\s*/, '').trim())
      .find((line) => line.length > 0) ?? ''
  );
}
