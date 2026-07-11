// 设置页「Agent 管理」tab — agent_service 的多 agent CRUD + 测试，
// 以及网关侧 secrets 管理（agent env 通过 ${NAME} 引用）。
// default agent 是运行时配置的只读镜像，只能测试，不能编辑/删除。

import { useCallback, useEffect, useState } from 'react';
import {
  agentAdminApi,
  type AgentDef,
  type AgentUpsertBody,
  type ProviderInfo,
  type RagCollection,
  type SecretEntry,
} from '../../api/agentAdminApi';
import { useT } from '../../contexts/LanguageContext';

const ID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;

interface AgentDraft {
  id: string;
  name: string;
  description: string;
  provider: string; // '' = 跟随默认
  model: string; // '' = 跟随默认
  system_prompt: string;
  temperature: string; // '' = 跟随默认
  collection: string; // '' = 不挂载知识库
  topK: string;
  /** 编辑器不暴露 env，但 PUT 是替换语义 — 编辑已有 agent 时原样带回。 */
  env?: Record<string, string>;
}

type TestUiState =
  | { running: true }
  | {
      running: false;
      ok: boolean;
      latencyMs: number;
      sample?: string;
      error?: string;
    };

export function AgentsPanel() {
  const t = useT();
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // providers / collections 仅供编辑器下拉；加载失败时静默降级。
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [collections, setCollections] = useState<RagCollection[]>([]);

  const [testState, setTestState] = useState<Record<string, TestUiState>>({});
  const [editor, setEditor] = useState<{ isNew: boolean; draft: AgentDraft } | null>(
    null,
  );
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorSaving, setEditorSaving] = useState(false);

  // secrets
  const [secrets, setSecrets] = useState<SecretEntry[]>([]);
  const [secretDraft, setSecretDraft] = useState({ name: '', value: '' });
  const [secretError, setSecretError] = useState<string | null>(null);
  const [secretSaving, setSecretSaving] = useState(false);

  const refreshAgents = useCallback(async () => {
    try {
      const r = await agentAdminApi.listAgents();
      setAgents(r.agents);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
    setAgentsLoaded(true);
  }, []);

  const refreshSecrets = useCallback(async () => {
    try {
      const r = await agentAdminApi.listSecrets();
      setSecrets(r.secrets);
    } catch {
      /* 网关未起时留空即可 */
    }
  }, []);

  useEffect(() => {
    void refreshAgents();
    void refreshSecrets();
    void agentAdminApi
      .getConfig()
      .then((r) => setProviders(r.providers))
      .catch(() => {});
    void agentAdminApi
      .listCollections()
      .then((r) => setCollections(r.collections))
      .catch(() => {});
  }, [refreshAgents, refreshSecrets]);

  const handleTest = async (id: string) => {
    setTestState((s) => ({ ...s, [id]: { running: true } }));
    try {
      const r = await agentAdminApi.testAgent(id);
      setTestState((s) => ({
        ...s,
        [id]: {
          running: false,
          ok: r.ok,
          latencyMs: r.latency_ms,
          sample: r.sample,
          error: r.error,
        },
      }));
    } catch (err) {
      setTestState((s) => ({
        ...s,
        [id]: {
          running: false,
          ok: false,
          latencyMs: 0,
          error: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm(t.settings.agents.confirmDelete(id))) return;
    try {
      await agentAdminApi.deleteAgent(id);
      if (editor && !editor.isNew && editor.draft.id === id) setEditor(null);
      await refreshAgents();
    } catch (err) {
      window.alert(
        t.settings.agents.deleteFailed(
          err instanceof Error ? err.message : String(err),
        ),
      );
    }
  };

  const openNew = () => {
    setEditor({
      isNew: true,
      draft: {
        id: '',
        name: '',
        description: '',
        provider: '',
        model: '',
        system_prompt: '',
        temperature: '',
        collection: '',
        topK: '5',
      },
    });
    setEditorError(null);
  };

  const openEdit = (agent: AgentDef) => {
    setEditor({
      isNew: false,
      draft: {
        id: agent.id,
        name: agent.name ?? '',
        description: agent.description ?? '',
        provider: agent.provider ?? '',
        model: agent.model ?? '',
        system_prompt: agent.system_prompt ?? '',
        temperature:
          agent.sampling?.temperature != null
            ? String(agent.sampling.temperature)
            : '',
        collection: agent.retrieval?.collection ?? '',
        topK: String(agent.retrieval?.top_k ?? 5),
        env: agent.env,
      },
    });
    setEditorError(null);
  };

  const patchDraft = (patch: Partial<AgentDraft>) => {
    setEditor((e) => (e ? { ...e, draft: { ...e.draft, ...patch } } : e));
  };

  const handleEditorSave = async () => {
    if (!editor) return;
    const d = editor.draft;
    const id = d.id.trim();
    if (editor.isNew) {
      if (!ID_RE.test(id)) {
        setEditorError(t.settings.agents.editor.idInvalid);
        return;
      }
      if (agents.some((a) => a.id === id)) {
        setEditorError(t.settings.agents.editor.idTaken);
        return;
      }
    }
    const body: AgentUpsertBody = {};
    if (d.name.trim()) body.name = d.name.trim();
    if (d.description.trim()) body.description = d.description.trim();
    if (d.provider) body.provider = d.provider;
    if (d.model.trim()) body.model = d.model.trim();
    if (d.system_prompt.trim()) body.system_prompt = d.system_prompt;
    if (d.temperature.trim() !== '') {
      const temp = Number(d.temperature);
      if (!Number.isFinite(temp) || temp < 0 || temp > 2) {
        setEditorError(t.settings.agents.editor.invalidTemperature);
        return;
      }
      body.sampling = { temperature: temp };
    }
    if (d.collection) {
      const k = Math.floor(Number(d.topK));
      body.retrieval = {
        collection: d.collection,
        top_k: Number.isFinite(k) && k >= 1 ? k : 5,
      };
    }
    if (d.env && Object.keys(d.env).length > 0) body.env = d.env;

    setEditorSaving(true);
    setEditorError(null);
    try {
      await agentAdminApi.putAgent(id, body);
      setEditor(null);
      await refreshAgents();
    } catch (err) {
      setEditorError(
        t.settings.agents.editor.saveFailed(
          err instanceof Error ? err.message : String(err),
        ),
      );
    }
    setEditorSaving(false);
  };

  const handleSecretSave = async () => {
    const name = secretDraft.name.trim();
    if (!name || !secretDraft.value) return;
    setSecretSaving(true);
    setSecretError(null);
    try {
      await agentAdminApi.putSecret(name, secretDraft.value);
      setSecretDraft({ name: '', value: '' });
      await refreshSecrets();
    } catch (err) {
      setSecretError(
        t.settings.agents.secrets.saveFailed(
          err instanceof Error ? err.message : String(err),
        ),
      );
    }
    setSecretSaving(false);
  };

  const handleSecretDelete = async (name: string) => {
    if (!window.confirm(t.settings.agents.secrets.confirmDelete(name))) return;
    try {
      await agentAdminApi.deleteSecret(name);
      await refreshSecrets();
    } catch (err) {
      setSecretError(
        t.settings.agents.secrets.deleteFailed(
          err instanceof Error ? err.message : String(err),
        ),
      );
    }
  };

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-text-primary">
            {t.settings.agents.heading}
          </h2>
          <p className="mt-0.5 text-xs text-text-muted">{t.settings.agents.tagline}</p>
        </div>
        <button
          type="button"
          onClick={openNew}
          className="shrink-0 rounded border border-card-border px-3 py-1.5 text-xs text-text-secondary hover:bg-card-border/40"
        >
          {t.settings.agents.newAgent}
        </button>
      </header>

      {loadError && (
        <div className="p-3 text-xs bg-status-danger/10 border border-status-danger/30 rounded text-status-danger">
          <div className="font-semibold mb-1">{t.settings.agents.loadFailed}</div>
          <div className="break-all">{loadError}</div>
        </div>
      )}

      {!agentsLoaded && !loadError && (
        <div className="rounded border border-card-border p-3 text-xs text-text-muted">
          {t.common.loading}
        </div>
      )}

      {/* Agent cards */}
      <div className="space-y-3">
        {agents.map((agent) => {
          const ts = testState[agent.id];
          const route =
            agent.provider || agent.model
              ? `${agent.provider ?? '—'} / ${agent.model ?? '—'}`
              : t.settings.agents.followDefault;
          return (
            <div
              key={agent.id}
              className="p-4 rounded-lg bg-card-bg border border-card-border"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-sm font-semibold text-text-primary">
                      {agent.name || agent.id}
                    </h3>
                    <span className="text-[11px] font-mono text-text-muted">
                      {agent.id}
                    </span>
                    {agent.builtin && (
                      <span
                        title={t.settings.agents.builtinHint}
                        className="text-[11px] px-2 py-0.5 rounded-full bg-accent/20 text-accent-soft border border-accent/30"
                      >
                        {t.settings.agents.builtinBadge}
                      </span>
                    )}
                    {agent.retrieval && (
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-accent-warm/15 text-accent-warm border border-accent-warm/30">
                        {t.settings.agents.retrievalLabel(agent.retrieval.collection)}
                      </span>
                    )}
                  </div>
                  {agent.description && (
                    <p className="mt-1 text-xs text-text-secondary leading-relaxed">
                      {agent.description}
                    </p>
                  )}
                  <p className="mt-1 text-[11px] text-text-muted font-mono">{route}</p>
                </div>

                <div className="flex gap-1 shrink-0">
                  {!agent.builtin && (
                    <button
                      type="button"
                      onClick={() => openEdit(agent)}
                      className="rounded border border-card-border px-2 py-1 text-xs text-text-secondary hover:bg-card-border/40"
                    >
                      {t.settings.agents.edit}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleTest(agent.id)}
                    disabled={ts?.running === true}
                    className="rounded border border-card-border px-2 py-1 text-xs text-text-secondary hover:bg-card-border/40 disabled:opacity-50"
                  >
                    {ts?.running ? t.settings.agents.testing : t.settings.agents.test}
                  </button>
                  {!agent.builtin && (
                    <button
                      type="button"
                      onClick={() => void handleDelete(agent.id)}
                      className="rounded border border-card-border px-2 py-1 text-xs text-text-muted hover:text-status-danger"
                    >
                      {t.settings.agents.delete}
                    </button>
                  )}
                </div>
              </div>

              {/* Test result — inline under the card */}
              {ts?.running && (
                <div className="mt-2 text-xs text-text-muted animate-pulse">
                  {t.settings.agents.testing}{' '}
                  <span className="text-[11px]">{t.settings.agents.testHint}</span>
                </div>
              )}
              {ts && !ts.running && (
                <div
                  className={`mt-2 text-xs ${
                    ts.ok ? 'text-status-success' : 'text-status-danger'
                  }`}
                >
                  {ts.ok ? (
                    <>
                      {t.settings.agents.testOk(ts.latencyMs)}
                      {ts.sample && (
                        <span className="ml-2 text-text-secondary break-all">
                          “{ts.sample}”
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="break-all">
                      {t.settings.agents.testFailed(ts.error ?? '')}
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Editor — inline expanding panel */}
      {editor && (
        <section className="rounded-lg border border-accent/40 bg-card-bg/40 p-4 space-y-3">
          <h3 className="text-sm font-semibold text-text-primary">
            {editor.isNew
              ? t.settings.agents.editor.titleNew
              : t.settings.agents.editor.titleEdit(editor.draft.id)}
          </h3>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label={t.settings.agents.editor.fieldId}>
              <input
                value={editor.draft.id}
                disabled={!editor.isNew}
                onChange={(e) => patchDraft({ id: e.target.value })}
                placeholder="my_agent"
                className={inputClass + ' font-mono text-xs'}
              />
              <span className="text-[11px] text-text-muted">
                {t.settings.agents.editor.idHint}
              </span>
            </Field>
            <Field label={t.settings.agents.editor.fieldName}>
              <input
                value={editor.draft.name}
                onChange={(e) => patchDraft({ name: e.target.value })}
                className={inputClass}
              />
            </Field>
            <Field
              label={t.settings.agents.editor.fieldDescription}
              className="md:col-span-2"
            >
              <input
                value={editor.draft.description}
                onChange={(e) => patchDraft({ description: e.target.value })}
                className={inputClass}
              />
            </Field>
            <Field label={t.settings.agents.editor.fieldProvider}>
              <select
                value={editor.draft.provider}
                onChange={(e) => patchDraft({ provider: e.target.value })}
                className={inputClass}
              >
                <option value="">{t.settings.agents.followDefault}</option>
                {providers.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t.settings.agents.editor.fieldModel}>
              <input
                value={editor.draft.model}
                onChange={(e) => patchDraft({ model: e.target.value })}
                placeholder={t.settings.agents.editor.followDefaultPlaceholder}
                className={inputClass + ' font-mono text-xs'}
              />
            </Field>
            <Field
              label={t.settings.agents.editor.fieldSystemPrompt}
              className="md:col-span-2"
            >
              <textarea
                rows={6}
                value={editor.draft.system_prompt}
                onChange={(e) => patchDraft({ system_prompt: e.target.value })}
                className={inputClass + ' resize-y font-mono text-xs leading-relaxed'}
              />
            </Field>
            <Field label={t.settings.agents.editor.fieldTemperature}>
              <input
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={editor.draft.temperature}
                onChange={(e) => patchDraft({ temperature: e.target.value })}
                placeholder={t.settings.agents.editor.followDefaultPlaceholder}
                className={inputClass}
              />
            </Field>
            <div className="flex items-end gap-2">
              <Field
                label={t.settings.agents.editor.fieldCollection}
                className="flex-1"
              >
                <select
                  value={editor.draft.collection}
                  onChange={(e) => patchDraft({ collection: e.target.value })}
                  className={inputClass}
                >
                  <option value="">{t.settings.agents.editor.noCollection}</option>
                  {collections.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              {editor.draft.collection && (
                <Field label={t.settings.agents.editor.fieldTopK} className="w-20">
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={editor.draft.topK}
                    onChange={(e) => patchDraft({ topK: e.target.value })}
                    className={inputClass}
                  />
                </Field>
              )}
            </div>
          </div>

          {editorError && (
            <p className="text-xs text-status-danger break-all">{editorError}</p>
          )}

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={() => void handleEditorSave()}
              disabled={editorSaving}
              className="rounded bg-accent px-4 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {t.settings.agents.editor.save}
            </button>
            <button
              type="button"
              onClick={() => setEditor(null)}
              className="rounded border border-card-border px-3 py-1.5 text-xs text-text-secondary hover:bg-card-border/40"
            >
              {t.settings.agents.editor.cancel}
            </button>
          </div>
        </section>
      )}

      {/* Secrets */}
      <section className="rounded-lg border border-card-border bg-card-bg/40 p-4">
        <h3 className="text-sm font-semibold text-text-primary">
          {t.settings.agents.secrets.heading}{' '}
          <span className="text-[11px] font-normal text-text-muted">
            ({secrets.length})
          </span>
        </h3>
        <p className="mt-1 mb-3 text-[11px] text-text-muted leading-relaxed">
          {t.settings.agents.secrets.hint}
        </p>
        <div className="mb-3 space-y-1">
          {secrets.length === 0 && (
            <div className="text-xs text-text-muted">
              {t.settings.agents.secrets.empty}
            </div>
          )}
          {secrets.map((s) => (
            <div
              key={s.name}
              className="flex items-center justify-between rounded border border-card-border p-2 text-sm"
            >
              <span className="font-mono text-xs text-text-primary">
                {s.name} <span className="text-text-muted">••••</span>
              </span>
              <button
                type="button"
                onClick={() => void handleSecretDelete(s.name)}
                className="rounded border border-card-border px-2 py-1 text-xs text-text-muted hover:text-status-danger"
              >
                {t.settings.agents.delete}
              </button>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t.settings.agents.secrets.fieldName} className="w-44">
            <input
              value={secretDraft.name}
              onChange={(e) =>
                setSecretDraft((s) => ({ ...s, name: e.target.value.toUpperCase() }))
              }
              placeholder="DEEPSEEK_API_KEY"
              className={inputClass + ' font-mono text-xs'}
            />
          </Field>
          <Field
            label={t.settings.agents.secrets.fieldValue}
            className="flex-1 min-w-[220px]"
          >
            <input
              type="password"
              value={secretDraft.value}
              onChange={(e) =>
                setSecretDraft((s) => ({ ...s, value: e.target.value }))
              }
              placeholder="sk-…"
              className={inputClass + ' font-mono text-xs'}
            />
          </Field>
          <button
            type="button"
            onClick={() => void handleSecretSave()}
            disabled={secretSaving || !secretDraft.name.trim() || !secretDraft.value}
            className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {t.settings.agents.secrets.save}
          </button>
        </div>
        {secretError && (
          <p className="mt-2 text-xs text-status-danger break-all">{secretError}</p>
        )}
      </section>
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
