import { Link } from 'react-router-dom';
import type { Agent, WorkflowDetail } from './api';

const NODE_W = 156;
const NODE_H = 54;
const GAP_X = 18;
const GAP_Y = 72;
const PAD = 16;

interface Placed {
  agent: Agent;
  x: number;
  y: number;
  depth: number;
  /** Agents this one delegates to, already placed. */
  children: Placed[];
  /** True when the agent also appears under another orchestrator. */
  shared: boolean;
}

/** Who an orchestrator may call. Empty means everyone else, as in the domain. */
function rosterOf(workflow: WorkflowDetail, agent: Agent): Agent[] {
  if (agent.role !== 'orchestrator') return [];
  const others = workflow.agents.filter((other) => other.id !== agent.id);
  if (agent.delegatesTo.length === 0) return others;
  return others.filter((other) => agent.delegatesTo.includes(other.id));
}

/**
 * Tidy tree layout: lay each subtree out side by side, then centre the parent over its
 * children.
 *
 * A layered layout would put all thirteen delivery agents in one row and lose which lead
 * owns which — the grouping is the information worth showing.
 */
function layout(workflow: WorkflowDetail): { nodes: Placed[]; width: number; height: number } {
  const entry =
    workflow.agents.find((agent) => agent.id === workflow.entry) ??
    workflow.agents.find((agent) => agent.role === 'orchestrator');

  if (!entry) return { nodes: [], width: 0, height: 0 };

  // An agent can sit in several rosters; it is drawn once, under the first orchestrator that
  // claims it, and marked so the duplication is not silently hidden.
  const claimed = new Set<string>([entry.id]);
  let cursor = PAD;

  const place = (agent: Agent, depth: number): Placed => {
    const roster = rosterOf(workflow, agent).filter((child) => {
      if (claimed.has(child.id)) return false;
      claimed.add(child.id);
      return true;
    });

    const children = roster.map((child) => place(child, depth + 1));
    const y = PAD + depth * (NODE_H + GAP_Y);

    if (children.length === 0) {
      const node: Placed = { agent, x: cursor, y, depth, children: [], shared: false };
      cursor += NODE_W + GAP_X;
      return node;
    }

    const first = children[0] as Placed;
    const last = children[children.length - 1] as Placed;
    const x = (first.x + last.x) / 2;

    return { agent, x, y, depth, children, shared: false };
  };

  const root = place(entry, 0);

  const flatten = (node: Placed): Placed[] => [node, ...node.children.flatMap(flatten)];
  const nodes = flatten(root);

  // Anything never claimed is unreachable from the entry — worth drawing, and worth the
  // gap that says so.
  const orphans = workflow.agents.filter((agent) => !claimed.has(agent.id));
  const orphanRow = Math.max(...nodes.map((node) => node.depth)) + 1;

  for (const agent of orphans) {
    nodes.push({
      agent,
      x: cursor,
      y: PAD + orphanRow * (NODE_H + GAP_Y),
      depth: orphanRow,
      children: [],
      shared: true,
    });
    cursor += NODE_W + GAP_X;
  }

  const width = Math.max(cursor, PAD * 2 + NODE_W);
  const height = PAD * 2 + (Math.max(...nodes.map((node) => node.depth)) + 1) * (NODE_H + GAP_Y);
  return { nodes, width, height };
}

/** The delegation hierarchy of one workflow. */
export function WorkflowGraph({
  workflow,
  onSelect,
}: {
  workflow: WorkflowDetail;
  onSelect?: (agentId: string) => void;
}) {
  const { nodes, width, height } = layout(workflow);
  if (nodes.length === 0) {
    return <div className="empty">Add an orchestrator and the graph appears here.</div>;
  }

  const edges = nodes.flatMap((node) =>
    node.children.map((child) => ({ from: node, to: child, key: `${node.agent.id}-${child.agent.id}` })),
  );

  return (
    <div className="graph-scroll">
      <svg width={width} height={height} className="graph" role="img" aria-label="Workflow graph">
        {edges.map((edge) => {
          const x1 = edge.from.x + NODE_W / 2;
          const y1 = edge.from.y + NODE_H;
          const x2 = edge.to.x + NODE_W / 2;
          const y2 = edge.to.y;
          const mid = (y1 + y2) / 2;

          return (
            <path
              key={edge.key}
              d={`M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`}
              className="graph-edge"
            />
          );
        })}

        {nodes.map((node) => {
          const isEntry = node.agent.id === workflow.entry;
          const isOrchestrator = node.agent.role === 'orchestrator';

          return (
            <g
              key={node.agent.id}
              transform={`translate(${node.x}, ${node.y})`}
              className={`graph-node${onSelect ? ' clickable' : ''}`}
              onClick={() => onSelect?.(node.agent.id)}
            >
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={8}
                className={[
                  'graph-box',
                  isOrchestrator ? 'orchestrator' : 'agent',
                  node.agent.prompt ? '' : 'unprompted',
                  node.shared ? 'detached' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              />
              {isEntry && <circle cx={10} cy={10} r={3} className="graph-entry" />}
              <text x={12} y={22} className="graph-name">
                {truncate(node.agent.name, 20)}
              </text>
              <text x={12} y={39} className="graph-meta">
                {isOrchestrator ? 'orchestrator' : 'agent'} · {node.agent.struggle}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/**
 * How workflows connect. Each is a node; a handoff is an edge — discovery produces a spec
 * that delivery consumes, and that relationship is otherwise only in someone's head.
 */
export function WorkflowMap({ workflows }: { workflows: WorkflowDetail[] }) {
  if (workflows.length === 0) return null;

  const columns = Math.max(1, Math.min(workflows.length, 3));
  const boxW = 190;
  const boxH = 62;
  const gapX = 48;
  const gapY = 56;

  const at = (index: number) => ({
    x: PAD + (index % columns) * (boxW + gapX),
    y: PAD + Math.floor(index / columns) * (boxH + gapY),
  });

  const index = new Map(workflows.map((workflow, position) => [workflow.id, position]));
  const width = PAD * 2 + columns * boxW + (columns - 1) * gapX;
  const rows = Math.ceil(workflows.length / columns);
  const height = PAD * 2 + rows * boxH + (rows - 1) * gapY;

  const edges = workflows
    .filter((workflow) => workflow.handoffTo && index.has(workflow.handoffTo))
    .map((workflow) => ({
      key: `${workflow.id}->${workflow.handoffTo}`,
      from: at(index.get(workflow.id) as number),
      to: at(index.get(workflow.handoffTo as string) as number),
    }));

  return (
    <div className="graph-scroll">
      <svg width={width} height={height} className="graph" role="img" aria-label="Workflow map">
        <defs>
          <marker
            id="handoff-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" className="graph-arrow" />
          </marker>
        </defs>

        {edges.map((edge) => {
          const sameRow = edge.from.y === edge.to.y;
          const x1 = sameRow ? edge.from.x + boxW : edge.from.x + boxW / 2;
          const y1 = sameRow ? edge.from.y + boxH / 2 : edge.from.y + boxH;
          const x2 = sameRow ? edge.to.x : edge.to.x + boxW / 2;
          const y2 = sameRow ? edge.to.y + boxH / 2 : edge.to.y;

          return (
            <path
              key={edge.key}
              d={
                sameRow
                  ? `M ${x1} ${y1} C ${x1 + 24} ${y1}, ${x2 - 24} ${y2}, ${x2} ${y2}`
                  : `M ${x1} ${y1} C ${x1} ${y1 + 24}, ${x2} ${y2 - 24}, ${x2} ${y2}`
              }
              className="graph-edge handoff"
              markerEnd="url(#handoff-arrow)"
            />
          );
        })}

        {workflows.map((workflow, position) => {
          const point = at(position);
          const orchestrators = workflow.agents.filter(
            (agent) => agent.role === 'orchestrator',
          ).length;

          return (
            <g key={workflow.id} transform={`translate(${point.x}, ${point.y})`}>
              <a href={`/w/${workflow.id}`}>
                <rect
                  width={boxW}
                  height={boxH}
                  rx={10}
                  className={`graph-box workflow${workflow.runnable ? '' : ' unprompted'}`}
                />
                <text x={14} y={25} className="graph-name">
                  {truncate(workflow.name, 22)}
                </text>
                <text x={14} y={44} className="graph-meta">
                  {workflow.agents.length} agents · {orchestrators} orchestrators
                </text>
              </a>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Choose which workflow this one hands off to. */
export function HandoffPicker({
  workflow,
  workflows,
  onChange,
}: {
  workflow: WorkflowDetail;
  workflows: WorkflowDetail[];
  onChange: (handoffTo: string | null) => void;
}) {
  return (
    <label style={{ margin: 0 }}>
      <span className="lab">Hands off to</span>
      <select
        value={workflow.handoffTo ?? ''}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">Nothing — this is the end</option>
        {workflows
          .filter((candidate) => candidate.id !== workflow.id)
          .map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
      </select>
      <span className="hint">
        The pipeline that naturally follows. Discovery produces a spec; delivery consumes it.
      </span>
    </label>
  );
}

export function WorkflowMapLink() {
  return (
    <Link to="/w" className="dim">
      all workflows
    </Link>
  );
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
