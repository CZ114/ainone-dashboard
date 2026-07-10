// Diary tab inside SettingsPage. One-stop control for: master enable,
// daily schedule + agent, quiet hours, browser notification opt-in,
// agent CRUD, and secret CRUD.

import { useEffect, useMemo, useState } from 'react';
import { useDiaryStore } from '../../store/diaryStore';
import { AgentEditor } from './AgentEditor';
import { useT } from '../../contexts/LanguageContext';

export function DiarySettingsPanel() {
  const t = useT();
  const config = useDiaryStore((s) => s.config);
  const configLoading = useDiaryStore((s) => s.configLoading);
  const mainProvider = useDiaryStore((s) => s.mainProvider);
  const loadMainProvider = useDiaryStore((s) => s.loadMainProvider);
  const agents = useDiaryStore((s) => s.agents);
  const secrets = useDiaryStore((s) => s.secrets);
  const agentsLoading = useDiaryStore((s) => s.agentsLoading);
  const loadConfig = useDiaryStore((s) => s.loadConfig);
  const loadAgents = useDiaryStore((s) => s.loadAgents);
  const patchConfig = useDiaryStore((s) => s.patchConfig);
  const upsertAgent = useDiaryStore((s) => s.upsertAgent);
  const deleteAgent = useDiaryStore((s) => s.deleteAgent);
  const testAgent = useDiaryStore((s) => s.testAgent);
  const putSecret = useDiaryStore((s) => s.putSecret);
  const deleteSecret = useDiaryStore((s) => s.deleteSecret);
  const pushToast = useDiaryStore((s) => s.pushToast);

  const [editorAgentId, setEditorAgentId] = useState<string | null>(null);
  const [editorIsNew, setEditorIsNew] = useState(false);
  const [secretDraft, setSecretDraft] = useState({ name: '', value: '' });
  const [showSecretValue, setShowSecretValue] = useState(false);
  // Secrets are mostly auto-managed by the AgentEditor's simple mode
  // (one secret per provider, named DEEPSEEK_KEY / MINIMAX_KEY etc.).
  // Hide the raw editor by default — power users who want to share a
  // secret across multiple agents or rotate keys can flip it open.
  const [secretsExpanded, setSecretsExpanded] = useState(false);

  useEffect(() => {
    void loadConfig();
    void loadAgents();
    void loadMainProvider();
  }, [loadConfig, loadAgents, loadMainProvider]);

  const editingAgent = useMemo(() => {
    if (!editorAgentId) return null;
    return agents.find((a) => a.id === editorAgentId) ?? null;
  }, [agents, editorAgentId]);

  const enabled = config?.enabled ?? false;
  const dailyTime = config?.schedule?.daily?.time ?? '';
  const dailyAgentId = config?.schedule?.daily?.agent_id ?? '';
  const quietHours = config?.notification?.quiet_hours;
  const browserNotif = config?.notification?.browser ?? false;
  const dailyQuota = config?.daily_quota ?? 3;

  const requestNotificationPermission = async () => {
    if (typeof Notification === 'undefined') {
      pushToast(t.diary.settingsPanel.toastNotifUnsupported, 'error');
      return;
    }
    if (Notification.permission === 'granted') {
      await patchConfig({ notification: { ...config!.notification, browser: true } });
      return;
    }
    const result = await Notification.requestPermission();
    if (result === 'granted') {
      await patchConfig({ notification: { ...config!.notification, browser: true } });
    } else {
      pushToast(t.diary.settingsPanel.toastNotifDenied, 'error');
    }
  };

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-base font-semibold text-text-primary">{t.diary.settingsPanel.heading}</h2>
        <p className="mt-0.5 text-xs text-text-muted">{t.diary.settingsPanel.tagline}</p>
      </header>

      {configLoading && !config && (
        <div className="rounded border border-card-border p-3 text-xs text-text-muted">
          {t.diary.settingsPanel.loadingConfig}
        </div>
      )}

      {/* Master switch */}
      <section className="rounded-lg border border-card-border bg-card-bg/40 p-4">
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!config}
            onChange={(e) => void patchConfig({ enabled: e.target.checked })}
          />
          <span className="text-sm">
            <span className="font-medium text-text-primary">{t.diary.settingsPanel.enableLabel}</span>{' '}
            <span className="text-text-muted">{t.diary.settingsPanel.enableHint}</span>
          </span>
        </label>
      </section>

      {/* Daily schedule */}
      <section className="rounded-lg border border-card-border bg-card-bg/40 p-4">
        <h3 className="mb-3 text-sm font-semibold text-text-primary">{t.diary.settingsPanel.dailyHeading}</h3>
        <div className="grid grid-cols-1 gap-3 text-sm md:grid-cols-3">
          <Field label={t.diary.settingsPanel.fieldTime}>
            <input
              type="time"
              value={dailyTime || '09:00'}
              disabled={!config}
              onChange={(e) =>
                void patchConfig({
                  schedule: {
                    ...config!.schedule,
                    daily: {
                      time: e.target.value,
                      agent_id: dailyAgentId || agents[0]?.id || 'diary_observer',
                    },
                  },
                })
              }
              className={inputClass}
            />
          </Field>
          <Field label={t.diary.settingsPanel.fieldAgent}>
            <select
              value={dailyAgentId || agents[0]?.id || ''}
              disabled={!config || agents.length === 0}
              onChange={(e) =>
                void patchConfig({
                  schedule: {
                    ...config!.schedule,
                    daily: {
                      time: dailyTime || '09:00',
                      agent_id: e.target.value,
                    },
                  },
                })
              }
              className={inputClass}
            >
              {agents.map(({ id, agent }) => (
                <option key={id} value={id}>
                  {agent.name} ({agent.model})
                </option>
              ))}
            </select>
          </Field>
          <Field label={t.diary.settingsPanel.fieldDailyQuota}>
            <input
              type="number"
              min={1}
              max={20}
              value={dailyQuota}
              disabled={!config}
              onChange={(e) =>
                void patchConfig({ daily_quota: Math.max(1, Number(e.target.value)) })
              }
              className={inputClass}
            />
          </Field>
        </div>
        {config?.last_run?.daily && (
          <p className="mt-2 text-[11px] text-text-muted">
            {t.diary.settingsPanel.lastRun(
              config.last_run.daily.date,
              config.last_run.daily.entry_id,
            )}
          </p>
        )}
      </section>

      {/* Notifications */}
      <section className="rounded-lg border border-card-border bg-card-bg/40 p-4">
        <h3 className="mb-3 text-sm font-semibold text-text-primary">{t.diary.settingsPanel.notificationsHeading}</h3>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={browserNotif}
              disabled={!config}
              onChange={(e) => {
                if (e.target.checked) {
                  void requestNotificationPermission();
                } else {
                  void patchConfig({
                    notification: { ...config!.notification, browser: false },
                  });
                }
              }}
            />
            <span>{t.diary.settingsPanel.browserNotifications}</span>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-text-muted">{t.diary.settingsPanel.quietHours}</span>
            <input
              type="time"
              value={quietHours?.[0] ?? '22:00'}
              disabled={!config}
              onChange={(e) =>
                void patchConfig({
                  notification: {
                    ...config!.notification,
                    quiet_hours: [e.target.value, quietHours?.[1] ?? '08:00'],
                  },
                })
              }
              className={inputClass + ' w-28'}
            />
            <span>–</span>
            <input
              type="time"
              value={quietHours?.[1] ?? '08:00'}
              disabled={!config}
              onChange={(e) =>
                void patchConfig({
                  notification: {
                    ...config!.notification,
                    quiet_hours: [quietHours?.[0] ?? '22:00', e.target.value],
                  },
                })
              }
              className={inputClass + ' w-28'}
            />
          </label>
        </div>
      </section>

      {/* Agents */}
      <section className="rounded-lg border border-card-border bg-card-bg/40 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text-primary">{t.diary.settingsPanel.agentsHeading}</h3>
          <button
            type="button"
            onClick={() => {
              setEditorAgentId('new_agent');
              setEditorIsNew(true);
            }}
            className="rounded border border-card-border px-3 py-1 text-xs text-text-secondary hover:bg-card-border/40"
          >
            {t.diary.settingsPanel.newAgent}
          </button>
        </div>
        {agentsLoading && agents.length === 0 ? (
          <div className="text-xs text-text-muted">{t.diary.settingsPanel.loadingAgents}</div>
        ) : (
          <div className="space-y-2">
            {agents.map(({ id, agent }) => (
              <div
                key={id}
                className="flex items-center justify-between rounded border border-card-border p-2 text-sm"
              >
                <div>
                  <div className="font-medium text-text-primary">
                    {agent.name}{' '}
                    <span className="font-mono text-[11px] text-text-muted">{id}</span>
                  </div>
                  <div className="text-[11px] text-text-muted">{agent.model}</div>
                </div>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      setEditorAgentId(id);
                      setEditorIsNew(false);
                    }}
                    className="rounded border border-card-border px-2 py-1 text-xs text-text-secondary hover:bg-card-border/40"
                  >
                    {t.diary.settingsPanel.edit}
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      const r = await testAgent(id);
                      pushToast(
                        r.ok
                          ? t.diary.settingsPanel.toastTestOk(id, r.latency_ms ?? 0)
                          : t.diary.settingsPanel.toastTestFail(id, r.error ?? ''),
                        r.ok ? 'success' : 'error',
                      );
                    }}
                    className="rounded border border-card-border px-2 py-1 text-xs text-text-secondary hover:bg-card-border/40"
                  >
                    {t.diary.settingsPanel.test}
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      if (!confirm(t.diary.settingsPanel.confirmDeleteAgent(id))) return;
                      try {
                        await deleteAgent(id);
                        pushToast(t.diary.settingsPanel.toastDeleted(id), 'success');
                      } catch (err) {
                        const msg =
                          err instanceof Error ? err.message : String(err);
                        // Backend returns 409 when the agent is wired
                        // into the daily/weekly schedule or event
                        // trigger. Offer to clear those refs and
                        // retry instead of leaving the user stuck.
                        if (msg.includes('referenced by current schedule')) {
                          const ok = confirm(t.diary.settingsPanel.scheduleClearPrompt(id));
                          if (!ok) return;
                          try {
                            await deleteAgent(id, { force: true });
                            pushToast(t.diary.settingsPanel.toastDeletedClearedSchedule(id), 'success');
                          } catch (err2) {
                            pushToast(
                              err2 instanceof Error ? err2.message : String(err2),
                              'error',
                            );
                          }
                        } else {
                          pushToast(msg, 'error');
                        }
                      }
                    }}
                    className="rounded border border-card-border px-2 py-1 text-xs text-text-muted hover:text-status-disconnected"
                  >
                    {t.diary.settingsPanel.delete}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {editorAgentId && (
          <div className="mt-3">
            <AgentEditor
              key={editorAgentId + (editorIsNew ? ':new' : ':edit')}
              agentId={editorAgentId}
              initial={editingAgent?.agent ?? null}
              isNew={editorIsNew}
              availableSecrets={secrets.map((s) => s.name)}
              onIdChange={(next) => setEditorAgentId(next)}
              onSave={async (id, agent) => {
                await upsertAgent(id, agent);
                pushToast(t.diary.settingsPanel.toastSaved(id), 'success');
                setEditorAgentId(null);
                setEditorIsNew(false);
              }}
              onCancel={() => {
                setEditorAgentId(null);
                setEditorIsNew(false);
              }}
              onTest={(id) => testAgent(id)}
              onUpsertSecret={async (n, v) => putSecret(n, v)}
              mainProvider={mainProvider}
            />
          </div>
        )}
      </section>

      {/* Secrets */}
      <section className="rounded-lg border border-card-border bg-card-bg/40 p-4">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-text-primary">
            {t.diary.settingsPanel.secretsHeading} <span className="text-[11px] font-normal text-text-muted">({secrets.length})</span>
          </h3>
          <button
            type="button"
            onClick={() => setSecretsExpanded((v) => !v)}
            className="text-xs text-text-muted hover:text-text-primary"
          >
            {secretsExpanded ? t.diary.settingsPanel.hide : t.diary.settingsPanel.showManage}
          </button>
        </div>
        <p className="mb-3 text-[11px] text-text-muted leading-relaxed">
          <strong>{t.diary.settingsPanel.secretsWhatThisIs}</strong>{' '}
          {t.diary.settingsPanel.secretsDescriptionBefore}
          <code>${'{DEEPSEEK_KEY}'}</code>
          {t.diary.settingsPanel.secretsDescriptionMid1}
          <code>agents.json</code>
          {t.diary.settingsPanel.secretsDescriptionMid2}
          <strong>{t.diary.settingsPanel.secretsDescriptionStrong}</strong>
          {t.diary.settingsPanel.secretsDescriptionMid3}
          <code>backend/data/diary/agents.json</code>
          {t.diary.settingsPanel.secretsDescriptionAfter}
        </p>
        {!secretsExpanded ? (
          secrets.length === 0 ? (
            <div className="text-[11px] italic text-text-muted">
              {t.diary.settingsPanel.secretsEmptyCollapsed}
            </div>
          ) : (
            <div className="text-[11px] text-text-muted">
              {secrets.map((s) => s.name).join(', ')}
            </div>
          )
        ) : (
        <>
        <div className="mb-3 space-y-1 text-sm">
          {secrets.length === 0 && (
            <div className="text-xs text-text-muted">{t.diary.settingsPanel.secretsEmpty}</div>
          )}
          {secrets.map((s) => (
            <div
              key={s.name}
              className="flex items-center justify-between rounded border border-card-border p-2 text-sm"
            >
              <div>
                <span className="font-mono text-text-primary">{s.name}</span>
                <span className="ml-2 text-[11px] text-text-muted">
                  •••• {t.diary.settingsPanel.refCount(s.referenced_by.length)}
                </span>
              </div>
              <button
                type="button"
                onClick={async () => {
                  if (!confirm(t.diary.settingsPanel.confirmDeleteSecret(s.name))) return;
                  try {
                    await deleteSecret(s.name);
                    pushToast(t.diary.settingsPanel.toastDeleted(s.name), 'success');
                  } catch (err) {
                    pushToast(
                      err instanceof Error ? err.message : String(err),
                      'error',
                    );
                  }
                }}
                className="rounded border border-card-border px-2 py-1 text-xs text-text-muted hover:text-status-disconnected"
              >
                {t.diary.settingsPanel.delete}
              </button>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t.diary.settingsPanel.fieldName} className="w-44">
            <input
              value={secretDraft.name}
              onChange={(e) =>
                setSecretDraft((s) => ({ ...s, name: e.target.value.toUpperCase() }))
              }
              placeholder="DEEPSEEK_KEY"
              className={inputClass + ' font-mono text-xs'}
            />
          </Field>
          <Field label={t.diary.settingsPanel.fieldValue} className="flex-1 min-w-[240px]">
            <div className="flex gap-1">
              <input
                type={showSecretValue ? 'text' : 'password'}
                value={secretDraft.value}
                onChange={(e) =>
                  setSecretDraft((s) => ({ ...s, value: e.target.value }))
                }
                placeholder="sk-…"
                className={inputClass + ' font-mono text-xs'}
              />
              <button
                type="button"
                onClick={() => setShowSecretValue((v) => !v)}
                className="rounded border border-card-border px-2 text-xs text-text-muted"
              >
                {showSecretValue ? t.diary.settingsPanel.revealHide : t.diary.settingsPanel.revealShow}
              </button>
            </div>
          </Field>
          <button
            type="button"
            onClick={async () => {
              if (!secretDraft.name || !secretDraft.value) return;
              try {
                await putSecret(secretDraft.name, secretDraft.value);
                pushToast(t.diary.settingsPanel.toastSaved(secretDraft.name), 'success');
                setSecretDraft({ name: '', value: '' });
              } catch (err) {
                pushToast(
                  err instanceof Error ? err.message : String(err),
                  'error',
                );
              }
            }}
            className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90"
          >
            {t.diary.settingsPanel.saveSecret}
          </button>
        </div>
        </>
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
