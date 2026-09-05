import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type AssetKind, type DiscoveredAsset } from './api';
import { Alert, Dialog, errorMessage } from './components';

const KIND_LABEL: Record<AssetKind, string> = {
  agent: 'Agents',
  skill: 'Skills',
  command: 'Commands',
  rules: 'House rules',
};

const KIND_HINT: Record<AssetKind, string> = {
  agent: 'Subagent definitions already checked into the repo. Import one and its own text becomes the prompt.',
  skill: 'Packaged instructions the repo already carries. Useful context when writing an agent that works there.',
  command: 'Slash commands defined in the repo.',
  rules: "The repo's own CLAUDE.md or AGENTS.md — the house style an agent working there should follow.",
};

const ORDER: AssetKind[] = ['agent', 'skill', 'command', 'rules'];

/**
 * What the project's repos already contain.
 *
 * A team using Claude Code has usually written these already; asking them to restate the
 * same descriptions inside Pomni would be busywork, so import instead.
 */
export function DiscoveryPanel({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState<DiscoveredAsset | null>(null);
  const [importing, setImporting] = useState<DiscoveredAsset | null>(null);

  const report = useQuery({
    queryKey: ['discover', projectId],
    queryFn: () => api.discover(projectId).then((result) => result.report),
    enabled: open,
  });

  const counts = new Map<AssetKind, number>();
  for (const asset of report.data?.assets ?? []) {
    counts.set(asset.kind, (counts.get(asset.kind) ?? 0) + 1);
  }

  return (
    <div className="card">
      <div className="card-head">
        In the repos
        <span className="dim" style={{ fontWeight: 400 }}>
          {report.data ? report.data.assets.length : ''}
        </span>
        <div className="spacer" />
        <button onClick={() => setOpen((value) => !value)}>
          {open ? 'Hide' : 'Scan'}
        </button>
      </div>

      {!open ? (
        <div className="empty">
          Scan the project's repos for agent definitions, skills, commands and house rules that
          are already checked in.
        </div>
      ) : report.isLoading ? (
        <div className="empty">Scanning…</div>
      ) : report.isError ? (
        <div className="row">
          <Alert kind="error">{errorMessage(report.error)}</Alert>
        </div>
      ) : (
        <>
          <div className="row">
            <div className="grow dim mono">
              {(report.data?.scanned ?? [])
                .map((entry) => `${entry.repoId}: ${entry.found}`)
                .join('  ·  ')}
            </div>
          </div>

          {ORDER.filter((kind) => (counts.get(kind) ?? 0) > 0).map((kind) => (
            <AssetGroup
              key={kind}
              kind={kind}
              assets={(report.data?.assets ?? []).filter((asset) => asset.kind === kind)}
              onView={setViewing}
              onImport={setImporting}
            />
          ))}

          {(report.data?.assets ?? []).length === 0 && (
            <div className="empty">
              Nothing found. Pomni looks for <span className="mono">.claude/agents</span>,{' '}
              <span className="mono">.claude/skills</span>,{' '}
              <span className="mono">.claude/commands</span> and{' '}
              <span className="mono">CLAUDE.md</span>.
            </div>
          )}
        </>
      )}

      {viewing && <AssetViewer asset={viewing} onClose={() => setViewing(null)} />}
      {importing && (
        <ImportAgentDialog
          projectId={projectId}
          asset={importing}
          onClose={() => setImporting(null)}
        />
      )}
    </div>
  );
}

function AssetGroup({
  kind,
  assets,
  onView,
  onImport,
}: {
  kind: AssetKind;
  assets: DiscoveredAsset[];
  onView: (asset: DiscoveredAsset) => void;
  onImport: (asset: DiscoveredAsset) => void;
}) {
  // A repo can carry a hundred agents; showing them all makes the page unusable.
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? assets : assets.slice(0, 8);

  return (
    <>
      <div className="row" style={{ paddingTop: 10, paddingBottom: 6 }}>
        <strong>{KIND_LABEL[kind]}</strong>
        <span className="dim">{assets.length}</span>
        <span className="dim grow" style={{ fontSize: 12 }}>
          {KIND_HINT[kind]}
        </span>
      </div>

      {shown.map((asset) => (
        <div className="row" key={`${asset.repoId}-${asset.path}`} style={{ paddingLeft: 32 }}>
          <div className="grow">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <strong>{asset.name}</strong>
              <span className="tag">{asset.repoId}</span>
              {asset.struggle && <span className="tag">{asset.struggle}</span>}
            </div>
            <div className="dim truncate">{asset.description || asset.path}</div>
          </div>
          <button className="ghost" onClick={() => onView(asset)}>
            View
          </button>
          {asset.kind === 'agent' && (
            <button className="ghost" onClick={() => onImport(asset)}>
              Import
            </button>
          )}
        </div>
      ))}

      {assets.length > shown.length && (
        <div className="row" style={{ paddingLeft: 32 }}>
          <button className="ghost" onClick={() => setExpanded(true)}>
            Show {assets.length - shown.length} more
          </button>
        </div>
      )}
    </>
  );
}

function AssetViewer({ asset, onClose }: { asset: DiscoveredAsset; onClose: () => void }) {
  return (
    <Dialog
      title={asset.name}
      onClose={onClose}
      footer={<button onClick={onClose}>Close</button>}
    >
      <div className="detect-box" style={{ marginBottom: 14 }}>
        <div className="mono">
          {asset.repoId}:{asset.path}
        </div>
        {asset.tools.length > 0 && (
          <div className="dim" style={{ marginTop: 4 }}>
            tools: {asset.tools.join(', ')}
          </div>
        )}
      </div>
      {asset.description && <p>{asset.description}</p>}
      <pre className="log" style={{ maxHeight: 420 }}>
        {asset.body}
      </pre>
    </Dialog>
  );
}

function ImportAgentDialog({
  projectId,
  asset,
  onClose,
}: {
  projectId: string;
  asset: DiscoveredAsset;
  onClose: () => void;
}) {
  const [workflowId, setWorkflowId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const workflows = useQuery({
    queryKey: ['workflows'],
    queryFn: () => api.listWorkflows().then((result) => result.workflows),
  });

  const run = useMutation({
    mutationFn: () => api.importDiscovered(projectId, { workflowId, assetId: asset.id }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['workflow', workflowId] });
      await queryClient.invalidateQueries({ queryKey: ['workflows'] });
      onClose();
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  return (
    <Dialog
      title={`Import ${asset.name}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={!workflowId || run.isPending}
            onClick={() => run.mutate()}
          >
            Import
          </button>
        </>
      }
    >
      <Alert kind="error">{error}</Alert>
      <label>
        <span className="lab">Into which workflow</span>
        <select value={workflowId} onChange={(event) => setWorkflowId(event.target.value)}>
          <option value="">Choose…</option>
          {(workflows.data ?? []).map((workflow) => (
            <option key={workflow.id} value={workflow.id}>
              {workflow.name}
            </option>
          ))}
        </select>
        <span className="hint">
          The definition's own text becomes the agent's prompt, and its description becomes the
          spec — so you can regenerate later without losing what it was for.
        </span>
      </label>
    </Dialog>
  );
}
