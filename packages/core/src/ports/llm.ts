/**
 * Talking to a model.
 *
 * Deliberately narrow: a completion, and a loop that lets the caller answer tool calls.
 * Everything Pomni-specific — which agent, which workflow, what to record — stays in the
 * application layer, so a different provider or a fake in tests is a small class.
 */

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface LlmRequest {
  /** Concrete model id. Resolved from an agent's model scale by the caller. */
  model: string;
  system?: string;
  messages: LlmMessage[];
  maxTokens?: number;
  effort?: Effort;
  /** Off for models that do not support it; the adapter also guards. */
  adaptiveThinking?: boolean;
  signal?: AbortSignal;
}

export interface LlmToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

/**
 * One thing the session did on its way to an answer: a command, a file it changed, a skill
 * it invoked, an MCP tool it called.
 *
 * Providers that run their own tool loop do the work out of sight; without this the only
 * record of a fifteen-minute session is the paragraph it ended with.
 */
export interface AgentAction {
  /** The tool's own name — `Bash`, `Edit`, `Skill`, `mcp__figma__get_design_context`. */
  tool: string;
  /** The part worth reading: the command, the path, the skill. */
  detail: string;
}

export interface LlmResult {
  text: string;
  stopReason: string;
  usage: LlmUsage;
  /** Turns taken, counting the first. Only interesting for the tool loop. */
  turns: number;
  /** What the session did, when the provider reports it. */
  actions?: AgentAction[];
}

export interface ToolLoopHooks {
  /** Answer a tool call. The returned string is handed back to the model verbatim. */
  onTool(call: LlmToolCall): Promise<string>;
  /** Anything the model said before deciding to call a tool. */
  onText?(text: string): void;
  /** Stop the loop early — the model is told the run was cut short. */
  shouldStop?(): boolean;
}

export interface LlmPort {
  /** One request, one answer. */
  complete(request: LlmRequest): Promise<LlmResult>;

  /**
   * Run until the model stops asking for tools. This is the orchestration loop: each tool
   * call is a delegation, which is exactly the granularity a live view wants.
   */
  runWithTools(
    request: LlmRequest & { tools: LlmToolSpec[]; maxTurns?: number },
    hooks: ToolLoopHooks,
  ): Promise<LlmResult>;

  /** Whether credentials resolve. Never throws. */
  isConfigured(): Promise<boolean>;

  /** Human-readable description of where credentials came from, for diagnostics. */
  describeAuth(): Promise<string>;
}
