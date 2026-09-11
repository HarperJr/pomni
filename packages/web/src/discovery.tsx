import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type AssetKind, type DiscoveredAsset } from './api';
import { Alert, Dialog, errorMessage } from './components';
import { useLanguage, type Key } from './i18n';

const KIND_LABEL: Record<AssetKind, Key> = {
  agent: 'discovery.kind.agent',
  skill: 'discovery.kind.skill',
  command: 'discovery.kind.command',
  rules: 'discovery.kind.rules',
};

const KIND_HINT: Record<AssetKind, Key> = {
  agent: 'discovery.hint.agent',
  skill: 'discovery.hint.skill',
  command: 'discovery.hint.command',
  rules: 'discovery.hint.rules',
};

const ORDER: AssetKind[] = ['agent', 'skill', 'command', 'rules'];

/**
 * What the project's repos already contain.
 *
 * A team using Claude Code has usually written these already; asking them to restate the
 * same descriptions inside Pomni would be busywork, so import instead.
 */
export function DiscoveryPanel({ projectId }: { projectId: string }) {
  const { t } = useLanguage();
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
        {t('discovery.title')}
        <span className="dim" style={{ fontWeight: 400 }}>
          {report.data ? report.data.assets.length : ''}
        </span>
        <div className="spacer" />
        <button onClick={() => setOpen((value) => !value)}>
          {t(open ? 'discovery.hide' : 'discovery.scan')}
        </button>
      </div>

      {!open ? (
        <div className="empty">
          {t('discovery.idle')}
        </div>
      ) : report.isLoading ? (
        <div className="empty">{t('discovery.scanning')}</div>
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
  const { t } = useLanguage();
  // A repo can carry a hundred agents; showing them all makes the page unusable.
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? assets : assets.slice(0, 8);

  return (
    <>
      <div className="row" style={{ paddingTop: 10, paddingBottom: 6 }}>
        <strong>{t(KIND_LABEL[kind])}</strong>
        <span className="dim">{assets.length}</span>
        <span className="dim grow" style={{ fontSize: 12 }}>
          {t(KIND_HINT[kind])}
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
            {t('discovery.showMore', { n: assets.length - shown.length })}
          </button>
        </div>
      )}
    </>
  );
}

function AssetViewer({ asset, onClose }: { asset: DiscoveredAsset; onClose: () => void }) {
  const { t } = useLanguage();
  return (
    <Dialog
      title={asset.name}
      onClose={onClose}
      footer={<button onClick={onClose}>{t('common.close')}</button>}
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
  const { t } = useLanguage();
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
      title={t('discovery.import', { name: asset.name })}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>{t('common.cancel')}</button>
          <button
            className="primary"
            disabled={!workflowId || run.isPending}
            onClick={() => run.mutate()}
          >
            {t('discovery.importGo')}
          </button>
        </>
      }
    >
      <Alert kind="error">{error}</Alert>
      <label>
        <span className="lab">{t('discovery.intoWorkflow')}</span>
        <select value={workflowId} onChange={(event) => setWorkflowId(event.target.value)}>
          <option value="">{t('discovery.choose')}</option>
          {(workflows.data ?? []).map((workflow) => (
            <option key={workflow.id} value={workflow.id}>
              {workflow.name}
            </option>
          ))}
        </select>
        <span className="hint">{t('discovery.importHint')}</span>
      </label>
    </Dialog>
  );
}
