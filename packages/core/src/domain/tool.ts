import { z } from 'zod';
import { ValidationError } from './errors.js';

/**
 * Something an agent can use that is not a model: an MCP server, or a command-line program.
 *
 * Pomni already knows how to run *capabilities* — a repo's own `test` or `build` command,
 * run by Pomni itself and recorded. A tool is the other direction: it is not run by Pomni at
 * all. It is handed to an agent's session so the agent can decide to use it, which is why it
 * lives outside a repo and is granted per agent rather than per project.
 *
 * The two kinds differ only in how they reach the session. An `mcp` tool becomes a generated
 * MCP config file; a `cli` tool becomes a permission to run one binary. Both also become a
 * paragraph in the agent's system prompt, and that half is not optional: an agent allowed to
 * run `figma-cli` but never told it exists will never run it.
 */

export const ToolKindSchema = z.enum(['mcp', 'cli']);
export type ToolKind = z.infer<typeof ToolKindSchema>;

/** How an MCP server is reached. `stdio` spawns it; the other two dial it. */
export const McpTransportSchema = z.enum(['stdio', 'http', 'sse']);
export type McpTransport = z.infer<typeof McpTransportSchema>;

export const ToolSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  kind: ToolKindSchema,
  /** One line: what the tool is for. The agent reads this to decide whether it wants it. */
  description: z.string().default(''),
  /**
   * How to drive it, in the agent's terms — the subcommands that matter, the order they go
   * in, what to do first. A CLI with forty subcommands is unusable from a one-line summary.
   */
  usage: z.string().default(''),

  /** `cli`: the executable, as it is spelled on the PATH. */
  bin: z.string().nullable().default(null),

  /** `mcp`: how to reach the server. */
  transport: McpTransportSchema.nullable().default(null),
  /** `mcp` over stdio: the command to spawn, and its arguments. */
  command: z.string().nullable().default(null),
  args: z.array(z.string()).default([]),
  /** `mcp` over http or sse: the endpoint. */
  url: z.string().nullable().default(null),
  headers: z.record(z.string()).default({}),

  /** Literal environment for the server process. Never a secret — this file is tracked. */
  env: z.record(z.string()).default({}),
  /** Names of environment variables forwarded from Pomni's own process, by name only. */
  envFrom: z.array(z.string()).default([]),
  /** Credential whose secret is resolved at run time and set as `credentialEnv`. */
  credential: z.string().nullable().default(null),
  credentialEnv: z.string().nullable().default(null),

  /** A command that proves the tool works, e.g. `figma-cli status`. Run by `tool check`. */
  check: z.string().nullable().default(null),

  enabled: z.boolean().default(true),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Tool = z.infer<typeof ToolSchema>;

export const ToolsFileSchema = z.object({
  version: z.literal(1).default(1),
  tools: z.array(ToolSchema).default([]),
});
export type ToolsFile = z.infer<typeof ToolsFileSchema>;

/** What an agent asked for, resolved against the registry. */
export interface ToolGrant {
  tool: Tool;
  /** The secret to inject, already resolved. Null when the tool needs none. */
  secret: string | null;
}

/**
 * Why this tool cannot be used, or an empty list.
 *
 * Kept as data rather than thrown so a `tool list` can show a half-configured tool as broken
 * instead of refusing to list anything.
 */
export function validateTool(tool: Tool): string[] {
  const problems: string[] = [];

  if (tool.kind === 'cli') {
    if (!tool.bin?.trim()) problems.push('no binary — say which program to run');
  } else {
    if (!tool.transport) problems.push('no transport — stdio, http or sse');
    if (tool.transport === 'stdio' && !tool.command?.trim()) {
      problems.push('stdio needs a command to spawn');
    }
    if ((tool.transport === 'http' || tool.transport === 'sse') && !tool.url?.trim()) {
      problems.push(`${tool.transport} needs a url`);
    }
  }

  if (tool.credential && !tool.credentialEnv?.trim()) {
    problems.push('a credential needs the variable to put it in (--credential-env)');
  }
  return problems;
}

export function assertUsableTool(tool: Tool): void {
  const problems = validateTool(tool);
  if (problems.length > 0) {
    throw new ValidationError(`tool '${tool.id}' is not usable: ${problems.join('; ')}`);
  }
  if (!tool.enabled) {
    throw new ValidationError(`tool '${tool.id}' is disabled`);
  }
}

/**
 * The `mcpServers` entry for one tool, in the shape `claude --mcp-config` expects.
 *
 * The secret arrives resolved and goes into the process environment. It is never written to
 * `tools.yaml` — the generated config file is a temporary one, outside the workspace, and is
 * deleted as soon as the session ends.
 */
export function mcpServerEntry(grant: ToolGrant): Record<string, unknown> {
  const { tool, secret } = grant;

  const env: Record<string, string> = { ...tool.env };
  for (const name of tool.envFrom) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  if (secret && tool.credentialEnv) env[tool.credentialEnv] = secret;

  if (tool.transport === 'stdio') {
    return {
      type: 'stdio',
      command: tool.command,
      args: tool.args,
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }

  const headers = { ...tool.headers };
  // An http server takes its secret as a header; there is no process to give an env var to.
  if (secret && tool.credentialEnv) headers[tool.credentialEnv] = secret;

  return {
    type: tool.transport,
    url: tool.url,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

/** The whole `--mcp-config` document for a set of grants. */
export function mcpConfig(grants: ToolGrant[]): { mcpServers: Record<string, unknown> } {
  const mcpServers: Record<string, unknown> = {};
  for (const grant of grants) {
    if (grant.tool.kind === 'mcp') mcpServers[grant.tool.id] = mcpServerEntry(grant);
  }
  return { mcpServers };
}

/**
 * Permission patterns for `--allowedTools`.
 *
 * These pre-approve; they do not restrict. A session already able to edit files keeps that
 * ability when a grant is added, which is what makes it safe to append them per agent.
 */
export function toolGrants(grants: ToolGrant[]): string[] {
  return grants.flatMap(({ tool }) =>
    tool.kind === 'mcp' ? [`mcp__${tool.id}__*`] : [`Bash(${tool.bin}:*)`],
  );
}

/** The section appended to an agent's system prompt, or null when it has no tools. */
export function toolBriefing(grants: ToolGrant[]): string | null {
  if (grants.length === 0) return null;

  const lines = ['## Tools you have', ''];

  for (const { tool } of grants) {
    const how =
      tool.kind === 'mcp'
        ? `Its tools are available to you directly, named \`mcp__${tool.id}__*\`.`
        : `Run it with the Bash tool as \`${tool.bin}\`.`;

    lines.push(`### ${tool.name}`, '');
    if (tool.description.trim()) lines.push(tool.description.trim(), '');
    lines.push(how, '');
    if (tool.usage.trim()) lines.push(tool.usage.trim(), '');
  }

  lines.push(
    'These are yours to use when they help. Nothing obliges you to use one, but do not',
    'claim you cannot do something these tools can do.',
  );
  return lines.join('\n');
}
