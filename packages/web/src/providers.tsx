import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  STRUGGLE_LEVELS,
  type ModelMap,
  type ProviderKind,
  type ProviderStatus,
  type Struggle,
} from './api';
import { Alert, Dialog, errorMessage } from './components';
import { useLanguage, type Key } from './i18n';

const KIND_NOTE: Record<ProviderKind, Key> = {
  'claude-code': 'providers.note.claudeCode',
  anthropic: 'providers.note.anthropic',
  openai: 'providers.note.openai',
};

/**
 * Where models run, and which model each struggle level maps to.
 *
 * Agents never name a model — they say how hard the job is. This page is where that becomes
 * concrete, which is what lets the same workflow run against Claude Code, an API key, or a
 * model on localhost without being rewritten.
 */
export function ProvidersPage() {
  const { t } = useLanguage();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ProviderStatus | null>(null);
  const queryClient = useQueryClient();

  const status = useQuery({
    queryKey: ['providers'],
    queryFn: () => api.listProviders(),
  });

  const makeDefault = useMutation({
    mutationFn: (id: string) => api.setDefaultProvider(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['providers'] }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.removeProvider(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['providers'] }),
  });

  return (
    <>
      <div className="page-head">
        <h1>{t('providers.title')}</h1>
        <div className="spacer" />
        <button className="primary" onClick={() => setAdding(true)}>
          {t('providers.add')}
        </button>
      </div>

      <Alert kind="info">
        {t('providers.intro')}
      </Alert>

      {status.isError && <Alert kind="error">{errorMessage(status.error)}</Alert>}

      <div className="card">
        {(status.data?.providers ?? []).map((provider) => (
          <div className="row" key={provider.id}>
            <div className="grow">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <strong>{provider.label}</strong>
                <span className="tag">{provider.kind}</span>
                {status.data?.default === provider.id && <span className="tag">default</span>}
                <span className={`status status-${provider.available ? 'ready' : 'error'}`}>
                  <span className="dot" />
                  {provider.available ? 'ready' : 'unavailable'}
                </span>
              </div>
              <div className="dim mono truncate">{provider.detail}</div>
              <div className="tags" style={{ marginTop: 6 }}>
                {STRUGGLE_LEVELS.map((level) => (
                  <span key={level} className="tag">
                    {level}: {modelAt(provider.models, level) ?? '—'}
                  </span>
                ))}
              </div>
            </div>

            {status.data?.default !== provider.id && (
              <button className="ghost" onClick={() => makeDefault.mutate(provider.id)}>
                {t('providers.makeDefault')}
              </button>
            )}
            <button className="ghost" onClick={() => setEditing(provider)}>
              {t('common.edit')}
            </button>
            <button
              className="ghost danger"
              onClick={() => {
                if (confirm(`Remove provider "${provider.label}"?`)) remove.mutate(provider.id);
              }}
            >
              {t('common.remove')}
            </button>
          </div>
        ))}
      </div>

      {adding && <AddProviderDialog onClose={() => setAdding(false)} />}
      {editing && <EditProviderDialog provider={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

/** New keys first, then the names the levels used to have. */
function modelAt(models: ModelMap, level: Struggle): string | undefined {
  const legacy: Record<Struggle, keyof ModelMap> = {
    low: 'fast',
    medium: 'balanced',
    high: 'deep',
    max: 'max',
  };
  return models[level] ?? models[legacy[level]];
}

function AddProviderDialog({ onClose }: { onClose: () => void }) {
  const { t } = useLanguage();
  const [preset, setPreset] = useState('');
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<ProviderKind>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKeyEnv, setApiKeyEnv] = useState('');
  const [models, setModels] = useState<Partial<Record<Struggle, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const presets = useQuery({ queryKey: ['presets'], queryFn: () => api.providerPresets() });

  const choose = (id: string) => {
    setPreset(id);
    const found = (presets.data?.presets ?? []).find((entry) => entry.id === id);
    if (!found) return;
    setLabel(found.label);
    setKind(found.kind);
    setBaseUrl(found.baseUrl ?? '');
    setApiKeyEnv(found.apiKeyEnv ?? '');
    setModels(found.models as Partial<Record<Struggle, string>>);
  };

  const create = useMutation({
    mutationFn: () =>
      api.createProvider({
        label,
        kind,
        baseUrl: baseUrl || undefined,
        apiKeyEnv: apiKeyEnv || undefined,
        models,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['providers'] });
      onClose();
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  return (
    <Dialog
      title={t('providers.addTitle')}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>{t('common.cancel')}</button>
          <button
            className="primary"
            disabled={!label.trim() || create.isPending}
            onClick={() => create.mutate()}
          >
            {t('common.add')}
          </button>
        </>
      }
    >
      <Alert kind="error">{error}</Alert>

      <label>
        <span className="lab">{t('providers.startFrom')}</span>
        <select value={preset} onChange={(event) => choose(event.target.value)}>
          <option value="">{t('providers.startFromNothing')}</option>
          {(presets.data?.presets ?? []).map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
        {preset && (
          <span className="hint">
            {(presets.data?.presets ?? []).find((entry) => entry.id === preset)?.note}
          </span>
        )}
      </label>

      <ProviderFields
        label={label}
        setLabel={setLabel}
        kind={kind}
        setKind={setKind}
        baseUrl={baseUrl}
        setBaseUrl={setBaseUrl}
        apiKeyEnv={apiKeyEnv}
        setApiKeyEnv={setApiKeyEnv}
        models={models}
        setModels={setModels}
      />
    </Dialog>
  );
}

function EditProviderDialog({
  provider,
  onClose,
}: {
  provider: ProviderStatus;
  onClose: () => void;
}) {
  const { t } = useLanguage();
  const [label, setLabel] = useState(provider.label);
  const [kind, setKind] = useState<ProviderKind>(provider.kind);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? '');
  const [apiKeyEnv, setApiKeyEnv] = useState(provider.apiKeyEnv ?? '');
  const [models, setModels] = useState<Partial<Record<Struggle, string>>>(() =>
    Object.fromEntries(
      STRUGGLE_LEVELS.map((level) => [level, modelAt(provider.models, level) ?? '']),
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const save = useMutation({
    mutationFn: () =>
      api.updateProvider(provider.id, {
        label,
        kind,
        baseUrl: baseUrl || undefined,
        apiKeyEnv: apiKeyEnv || undefined,
        models,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['providers'] });
      onClose();
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  return (
    <Dialog
      title={`Edit ${provider.label}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>{t('common.cancel')}</button>
          <button className="primary" onClick={() => save.mutate()} disabled={save.isPending}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <Alert kind="error">{error}</Alert>
      <ProviderFields
        label={label}
        setLabel={setLabel}
        kind={kind}
        setKind={setKind}
        baseUrl={baseUrl}
        setBaseUrl={setBaseUrl}
        apiKeyEnv={apiKeyEnv}
        setApiKeyEnv={setApiKeyEnv}
        models={models}
        setModels={setModels}
        providerId={provider.id}
      />
    </Dialog>
  );
}

function ProviderFields({
  label,
  setLabel,
  kind,
  setKind,
  baseUrl,
  setBaseUrl,
  apiKeyEnv,
  setApiKeyEnv,
  models,
  setModels,
  providerId,
}: {
  label: string;
  setLabel: (value: string) => void;
  kind: ProviderKind;
  setKind: (value: ProviderKind) => void;
  baseUrl: string;
  setBaseUrl: (value: string) => void;
  apiKeyEnv: string;
  setApiKeyEnv: (value: string) => void;
  models: Partial<Record<Struggle, string>>;
  setModels: (value: Partial<Record<Struggle, string>>) => void;
  providerId?: string;
}) {
  const { t } = useLanguage();
  // What the endpoint actually serves, so a local setup does not need guesswork.
  const available = useQuery({
    queryKey: ['provider-models', providerId],
    queryFn: () => api.providerModels(providerId ?? '').then((result) => result.models),
    enabled: Boolean(providerId) && kind === 'openai',
    retry: false,
  });

  return (
    <>
      <div className="field-row">
        <label>
          <span className="lab">{t('providers.name')}</span>
          <input value={label} onChange={(event) => setLabel(event.target.value)} />
        </label>
        <label>
          <span className="lab">{t('providers.kind')}</span>
          <select value={kind} onChange={(event) => setKind(event.target.value as ProviderKind)}>
            <option value="claude-code">claude-code</option>
            <option value="anthropic">anthropic</option>
            <option value="openai">openai</option>
          </select>
        </label>
      </div>
      <div className="hint" style={{ marginTop: -8, marginBottom: 14 }}>
        {t(KIND_NOTE[kind])}
      </div>

      {kind === 'openai' && (
        <label>
          <span className="lab">{t('providers.baseUrl')}</span>
          <input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="http://localhost:11434/v1"
          />
          <span className="hint">{t('providers.baseUrlHint')}</span>
        </label>
      )}

      {kind !== 'claude-code' && (
        <label>
          <span className="lab">{t('providers.keyVariable')}</span>
          <input
            value={apiKeyEnv}
            onChange={(event) => setApiKeyEnv(event.target.value)}
            placeholder="OPENAI_API_KEY"
          />
          <span className="hint">{t('providers.keyVariableHint')}</span>
        </label>
      )}

      <div className="lab" style={{ marginBottom: 6 }}>
        {t('providers.modelPerLevel')}
      </div>
      {STRUGGLE_LEVELS.map((level) => (
        <label key={level} style={{ marginBottom: 8 }}>
          <span className="lab" style={{ textTransform: 'capitalize' }}>{level}</span>
          <input
            value={models[level] ?? ''}
            onChange={(event) => setModels({ ...models, [level]: event.target.value })}
            list={available.data?.length ? 'provider-model-list' : undefined}
            placeholder={level === 'medium' ? 'the working default' : 'leave blank to fall back'}
          />
        </label>
      ))}

      {available.data && available.data.length > 0 && (
        <datalist id="provider-model-list">
          {available.data.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
      )}

      <span className="hint">
        A level left blank falls back to the nearest one that is set, so one model can cover
        everything.
        {available.data?.length
          ? ` This endpoint reports ${available.data.length} model(s).`
          : ''}
      </span>
    </>
  );
}
