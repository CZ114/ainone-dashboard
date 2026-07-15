// 设置页「模型路由」tab — agent_service 的运行时默认配置
// (provider / model / temperature / embedder)。保存走 PATCH，
// 只对新的聊天会话生效。

import { useEffect, useMemo, useState } from 'react';
import {
  agentAdminApi,
  type AgentConfigResponse,
} from '../../api/agentAdminApi';
import { useT } from '../../contexts/LanguageContext';

export function ModelRoutingPanel() {
  const t = useT();
  const [data, setData] = useState<AgentConfigResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 表单草稿 — 从后端 config 初始化，点保存前不回写。
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [temperature, setTemperature] = useState('0.7');
  const [embedder, setEmbedder] = useState('');

  // 模型列表按需加载；失败时保留手动输入并内联展示错误。
  const [models, setModels] = useState<string[] | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await agentAdminApi.getConfig();
        if (cancelled) return;
        setData(r);
        setProvider(r.config.provider);
        setModel(r.config.model);
        setTemperature(String(r.config.temperature));
        setEmbedder(r.config.embedder);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const providerInfo = useMemo(
    () => data?.providers.find((p) => p.name === provider) ?? null,
    [data, provider],
  );

  const handleProviderChange = (name: string) => {
    setProvider(name);
    // 切换提供商时预填其默认模型，并作废上一家的模型列表。
    const info = data?.providers.find((p) => p.name === name);
    setModel(info?.defaultModel ?? '');
    setModels(null);
    setModelsError(null);
    setSaveMsg(null);
  };

  const handleLoadModels = async () => {
    setModelsLoading(true);
    setModelsError(null);
    try {
      const r = await agentAdminApi.listModels(provider);
      setModels(r.models);
    } catch (err) {
      setModels(null);
      setModelsError(err instanceof Error ? err.message : String(err));
    }
    setModelsLoading(false);
  };

  const handleSave = async () => {
    const temp = Number(temperature);
    if (temperature.trim() === '' || !Number.isFinite(temp) || temp < 0 || temp > 2) {
      setSaveMsg({ ok: false, text: t.settings.model.invalidTemperature });
      return;
    }
    setSaving(true);
    setSaveMsg(null);
    try {
      const r = await agentAdminApi.patchConfig({
        provider,
        model: model.trim(),
        temperature: temp,
        embedder: embedder.trim(),
      });
      setData(r);
      setSaveMsg({ ok: true, text: t.settings.model.saved });
    } catch (err) {
      setSaveMsg({
        ok: false,
        text: t.settings.model.saveFailed(
          err instanceof Error ? err.message : String(err),
        ),
      });
    }
    setSaving(false);
  };

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-base font-semibold text-text-primary">
          {t.settings.model.heading}
        </h2>
        <p className="mt-0.5 text-xs text-text-muted">{t.settings.model.tagline}</p>
      </header>

      {loadError && (
        <div className="p-3 text-xs bg-status-danger/10 border border-status-danger/30 rounded text-status-danger">
          <div className="font-semibold mb-1">{t.settings.model.loadFailed}</div>
          <div className="break-all">{loadError}</div>
        </div>
      )}

      {!data && !loadError && (
        <div className="rounded border border-card-border p-3 text-xs text-text-muted">
          {t.common.loading}
        </div>
      )}

      {data && (
        <section className="rounded-lg border border-card-border bg-card-bg/40 p-4 space-y-4">
          {/* Provider + key badge */}
          <div>
            <div className="flex items-end gap-2">
              <Field label={t.settings.model.fieldProvider} className="w-56">
                <select
                  value={provider}
                  onChange={(e) => handleProviderChange(e.target.value)}
                  className={inputClass}
                >
                  {data.providers.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              {providerInfo && (
                <span
                  className={`mb-1 shrink-0 text-[11px] px-2 py-0.5 rounded-full border ${
                    providerInfo.keyPresent
                      ? 'bg-status-success/20 text-status-success border-status-success/30'
                      : 'bg-status-warning/20 text-status-warning border-status-warning/30'
                  }`}
                >
                  {providerInfo.keyPresent
                    ? t.settings.model.keyPresent
                    : t.settings.model.keyMissing}
                </span>
              )}
            </div>
            {providerInfo && providerInfo.keyEnvs.length > 0 && (
              <p className="mt-1 text-[11px] text-text-muted font-mono">
                {t.settings.model.keyEnvHint(providerInfo.keyEnvs.join(' / '))}
              </p>
            )}
            {providerInfo && !providerInfo.keyPresent && (
              <p className="mt-2 text-xs text-status-warning">
                {t.settings.model.keyMissingWarning(
                  providerInfo.keyEnvs.join(' / ') || '—',
                )}
              </p>
            )}
          </div>

          {/* Model — text input + optional datalist from the provider */}
          <div>
            <div className="flex items-end gap-2">
              <Field label={t.settings.model.fieldModel} className="flex-1">
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  list={models ? 'model-routing-model-options' : undefined}
                  placeholder={providerInfo?.defaultModel ?? ''}
                  className={inputClass + ' font-mono text-xs'}
                />
              </Field>
              <button
                type="button"
                onClick={() => void handleLoadModels()}
                disabled={modelsLoading}
                className="shrink-0 rounded border border-card-border px-3 py-1.5 text-xs text-text-secondary hover:bg-card-border/40 disabled:opacity-50"
              >
                {modelsLoading
                  ? t.settings.model.loadingModels
                  : t.settings.model.loadModels}
              </button>
            </div>
            {models && (
              <datalist id="model-routing-model-options">
                {models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            )}
            <p className="mt-1 text-[11px] text-text-muted">
              {models
                ? t.settings.model.modelsLoaded(models.length)
                : t.settings.model.modelHint}
            </p>
            {modelsError && (
              <p className="mt-1 text-[11px] text-status-danger break-all">
                {t.settings.model.modelsLoadFailed(modelsError)}
              </p>
            )}
          </div>

          {/* Temperature + embedder */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Field label={t.settings.model.fieldTemperature}>
              <input
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
                className={inputClass}
              />
              <span className="text-[11px] text-text-muted">
                {t.settings.model.temperatureHint}
              </span>
            </Field>
            <Field label={t.settings.model.fieldEmbedder} className="md:col-span-2">
              <input
                value={embedder}
                onChange={(e) => setEmbedder(e.target.value)}
                className={inputClass + ' font-mono text-xs'}
              />
              <span className="text-[11px] text-text-muted">
                {t.settings.model.embedderHint}
              </span>
            </Field>
          </div>

          {/* Save */}
          <div className="flex items-center gap-3 pt-1">
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving}
              className="rounded bg-accent px-4 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? t.settings.model.saving : t.settings.model.save}
            </button>
            {saveMsg && (
              <span
                className={`text-xs break-all ${
                  saveMsg.ok ? 'text-status-success' : 'text-status-danger'
                }`}
              >
                {saveMsg.text}
              </span>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`flex flex-col gap-1 ${className ?? ''}`}>
      <span className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
        {label}
      </span>
      {children}
    </label>
  );
}

const inputClass =
  'w-full rounded border border-card-border bg-window-bg px-2 py-1 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none disabled:opacity-50';
