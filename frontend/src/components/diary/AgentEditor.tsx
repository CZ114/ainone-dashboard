// Agent editor — two modes:
//
//  Simple (default): pick provider + model, paste API key, set name +
//    description. The editor fills in the right ANTHROPIC_BASE_URL /
//    ANTHROPIC_AUTH_TOKEN env block behind the scenes and
//    auto-creates a per-provider secret (e.g. DEEPSEEK_KEY) so the
//    agent.json holds `${DEEPSEEK_KEY}` not the raw key.
//
//  Advanced: full env-rows editor + system prompt + sampling. Used
//    when the user wants to point at a router, share a secret across
//    multiple agents, or tune the system prompt.

import { useEffect, useMemo, useState } from 'react';
import type { AgentConfig, TestAgentResponse } from '../../api/diaryApi';
import {
  PROVIDERS,
  type Provider,
  detectProvider,
  findProvider,
  suggestSecretName,
} from './providers';
import type { MainProviderInfo } from '../../api/diaryApi';

interface AgentEditorProps {
  agentId: string;
  initial: AgentConfig | null;
  isNew: boolean;
  availableSecrets: string[];
  onSave: (id: string, agent: AgentConfig) => Promise<void>;
  onCancel: () => void;
  onTest: (id: string) => Promise<TestAgentResponse>;
  onIdChange?: (next: string) => void;
  /** Backed by diaryStore.putSecret. Lets simple-mode auto-create the
   *  per-provider secret so the user never has to touch the Secrets UI. */
  onUpsertSecret: (name: string, value: string) => Promise<void>;
  /**
   * Main-agent provider info from `~/.claude/settings.json`. When set,
   * the editor LOCKS the provider picker to the matching family — diary
   * agents cannot use a different API than the main chat. Prevents
   * silent auth conflicts (e.g. Anthropic key reaching MiniMax). When
   * null (loading or detection failed), the picker is unlocked.
   */
  mainProvider: MainProviderInfo | null;
}

// Match a main-provider base_url to one of our PROVIDERS entries.
// Used to figure out which provider card to lock to. Returns the
// provider id, or null if we can't match (rare custom router etc).
function lockedProviderIdFor(main: MainProviderInfo | null): string | null {
  if (!main) return null;
  // Anthropic native (no BASE_URL)
  if (!main.base_url) return 'anthropic';
  // Reuse providers.ts's reverse-lookup logic
  const detected = detectProvider({ ANTHROPIC_BASE_URL: main.base_url });
  return detected.id;
}

interface EnvRow {
  key: string;
  value: string;
}

const DEFAULT_SYSTEM_PROMPT =
  "You are an observation assistant for a wearable sensor dashboard. " +
  "Write short, plain-spoken markdown notes about patterns in the user's " +
  "recent recordings — like a lab assistant leaving a sticky note, not a " +
  "doctor writing a chart. Lead with the observation, two to four short " +
  "bullets, optional gentle closing question. No diagnostic language.";

function envObjToRows(env: Record<string, string>): EnvRow[] {
  return Object.entries(env).map(([key, value]) => ({ key, value }));
}

function rowsToEnv(rows: EnvRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    if (r.key.trim().length > 0) out[r.key.trim()] = r.value;
  }
  return out;
}

const inputClass =
  'w-full rounded border border-card-border bg-window-bg px-2 py-1 text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none disabled:opacity-50';

export function AgentEditor({
  agentId,
  initial,
  isNew,
  availableSecrets,
  onSave,
  onCancel,
  onTest,
  onIdChange,
  onUpsertSecret,
  mainProvider,
}: AgentEditorProps) {
  // Provider lock — when the dashboard knows which provider the
  // user's main chat targets, all NEW diary agents must match. Saved
  // agents inherit whatever provider they were created with (so an
  // older agent from when the main chat was Anthropic doesn't
  // disappear when the user switches main to DeepSeek), but the
  // editor still locks the picker so any save respects the current
  // main provider.
  const lockedProviderId = useMemo(
    () => lockedProviderIdFor(mainProvider),
    [mainProvider],
  );

  // ---- Simple-mode state ------------------------------------------------
  const detectedProvider = useMemo<Provider>(() => {
    if (initial) return detectProvider(initial.env);
    // For a brand-new agent, default to the locked provider when known.
    if (lockedProviderId) {
      return findProvider(lockedProviderId) ?? PROVIDERS[0];
    }
    return PROVIDERS[0];
  }, [initial, lockedProviderId]);

  const [providerId, setProviderId] = useState<string>(detectedProvider.id);
  const provider = useMemo(
    () => findProvider(providerId) ?? PROVIDERS[0],
    [providerId],
  );

  // If main provider becomes known AFTER the editor mounted (race with
  // store loading), snap providerId to the lock for new agents.
  useEffect(() => {
    if (!isNew) return;
    if (!lockedProviderId) return;
    if (providerId !== lockedProviderId) {
      setProviderId(lockedProviderId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lockedProviderId]);

  const [modelId, setModelId] = useState<string>(
    initial?.model ?? detectedProvider.defaultModelId ?? PROVIDERS[0].defaultModelId,
  );
  // API key — empty if the existing env uses a ${SECRET} reference (we
  // don't have the actual secret value at edit time; the user can leave
  // this blank and we'll keep the existing reference).
  const [apiKey, setApiKey] = useState<string>('');
  const [apiKeyTouched, setApiKeyTouched] = useState(false);
  // Custom-only fields surfaced when provider === 'custom'
  const [customBaseUrl, setCustomBaseUrl] = useState<string>(
    initial?.env.ANTHROPIC_BASE_URL ?? '',
  );

  // ---- Shared state -----------------------------------------------------
  const [id, setId] = useState(agentId);
  const [name, setName] = useState(
    initial?.name ?? detectedProvider.defaultAgentName,
  );
  const [description, setDescription] = useState(initial?.description ?? '');
  const [systemPrompt, setSystemPrompt] = useState(
    initial?.system_prompt ?? DEFAULT_SYSTEM_PROMPT,
  );
  const [envRows, setEnvRows] = useState<EnvRow[]>(
    initial ? envObjToRows(initial.env) : [],
  );
  const [maxTokens, setMaxTokens] = useState(
    initial?.sampling?.max_tokens ?? 800,
  );
  const [temperature, setTemperature] = useState(
    initial?.sampling?.temperature ?? 0.5,
  );

  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestAgentResponse | null>(null);

  useEffect(() => onIdChange?.(id), [id, onIdChange]);

  // When the user picks a different provider in simple mode, auto-set
  // model + agent name to that provider's defaults.
  useEffect(() => {
    if (advanced) return;
    if (provider.models.length > 0 && !provider.models.find((m) => m.id === modelId)) {
      setModelId(provider.defaultModelId);
    }
    if (isNew) {
      setName((current) => {
        // If the name still matches the previously-selected provider's
        // default, swap to the new one. Otherwise leave the user's
        // typed name alone.
        const fromAnyProvider = PROVIDERS.some(
          (p) => p.defaultAgentName === current,
        );
        return fromAnyProvider ? provider.defaultAgentName : current;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, advanced]);

  // Build the env block the simple-mode form should produce. This is
  // the single source of truth for what gets saved when not in
  // Advanced mode.
  function buildSimpleEnv(): { env: Record<string, string>; secretRef: string | null; secretName: string | null } {
    const env: Record<string, string> = {};
    if (provider.id === 'anthropic') {
      // Native Anthropic — no BASE_URL needed.
    } else if (provider.id === 'custom') {
      if (customBaseUrl.trim()) env.ANTHROPIC_BASE_URL = customBaseUrl.trim();
    } else if (typeof provider.baseUrl === 'string' && provider.baseUrl !== 'custom') {
      env.ANTHROPIC_BASE_URL = provider.baseUrl;
    }

    const secretName = suggestSecretName(provider);
    const secretRef = `\${${secretName}}`;
    env[provider.authTokenEnvKey] = secretRef;
    return { env, secretRef, secretName };
  }

  const handleSave = async () => {
    if (saving) return;
    if (isNew && !/^[a-z0-9_-]+$/i.test(id)) {
      setError('Agent ID must be alphanumeric / underscore / dash');
      return;
    }
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    if (!modelId.trim()) {
      setError('Model is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      let envForSave: Record<string, string>;
      if (advanced) {
        envForSave = rowsToEnv(envRows);
      } else {
        const { env, secretName } = buildSimpleEnv();
        envForSave = env;
        // If the user typed a fresh API key, save it as a secret so
        // the env reference resolves at runtime. Skip if untouched —
        // the existing secret value is preserved.
        if (apiKeyTouched && apiKey.trim().length > 0 && secretName) {
          await onUpsertSecret(secretName, apiKey.trim());
        }
      }
      const agent: AgentConfig = {
        name: name.trim(),
        description: description.trim() || undefined,
        model: modelId.trim(),
        env: envForSave,
        system_prompt: systemPrompt,
        sampling: { max_tokens: maxTokens, temperature },
      };
      await onSave(id, agent);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      const r = await onTest(id);
      setTestResult(r);
    } catch (err) {
      setTestResult({
        ok: false,
        latency_ms: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  };

  // ---- render -----------------------------------------------------------

  const promptCharCount = systemPrompt.length;
  const tokenEstimate = Math.round(promptCharCount / 4);

  // Shows one line under the API key input letting the user know what
  // we'll do with it (auto-secret-create) or that they can leave it
  // alone (existing secret reused / .env fallback).
  const apiKeyHint = (() => {
    if (provider.id === 'custom') return 'Stored as ANTHROPIC_AUTH_TOKEN env in this agent.';
    const sname = suggestSecretName(provider);
    const exists = availableSecrets.includes(sname);
    if (apiKeyTouched && apiKey.length > 0) {
      return `Will be saved as secret ${sname}${exists ? ' (overwrites existing).' : '.'}`;
    }
    if (exists) {
      return `Reusing existing secret ${sname}. Leave blank to keep it; type a new key to overwrite.`;
    }
    // No secret saved AND user hasn't pasted — surface the .env path.
    return `Will be saved as secret ${sname}. Or leave blank and put \`${sname}=your_key\` in <repo>/.env (then restart backend).`;
  })();

  return (
    <div className="rounded-lg border border-accent/40 bg-card-bg p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-text-primary">
          {isNew ? 'New agent' : `Edit ${id}`}
        </h3>
        <div className="flex items-center gap-3 text-xs">
          <button
            type="button"
            onClick={() => setAdvanced((v) => !v)}
            className="text-text-muted hover:text-text-primary"
            title="Toggle raw env / system prompt / sampling editor"
          >
            {advanced ? '← Simple' : 'Advanced ▸'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="text-text-muted hover:text-text-primary"
          >
            Cancel
          </button>
        </div>
      </div>

      {/* Step 1 — Provider picker. Hidden in Advanced (user is doing
          their own env). When mainProvider is known, the picker is
          LOCKED to that family — diary agents must share the API
          family of the user's main chat to avoid auth conflicts. */}
      {!advanced && (
        <section className="mb-4">
          <h4 className="mb-1 flex items-center gap-2 text-xs font-medium text-text-secondary">
            <span>1. Provider</span>
            {lockedProviderId && (
              <span
                className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-normal text-accent"
                title="Diary is locked to your main chat's provider family. Change ~/.claude/settings.json's ANTHROPIC_BASE_URL to switch."
              >
                🔒 locked to {findProvider(lockedProviderId)?.label}
              </span>
            )}
          </h4>
          {lockedProviderId && (
            <p className="mb-2 text-[11px] text-text-muted leading-snug">
              Locked to your main chat's provider so diary runs share
              the same API family. Switching would mix credentials and
              produce silent auth failures. To change: edit{' '}
              <code className="rounded bg-card-border/40 px-1">~/.claude/settings.json</code>{' '}
              and restart the backend.
            </p>
          )}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {PROVIDERS.map((p) => {
              const active = p.id === providerId;
              const allowed = !lockedProviderId || p.id === lockedProviderId;
              const onClick = () => {
                if (!allowed) return;
                setProviderId(p.id);
              };
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={onClick}
                  disabled={!allowed}
                  title={
                    allowed
                      ? p.shortNote
                      : `Locked: main chat is on ${findProvider(lockedProviderId)?.label}. Edit ~/.claude/settings.json to switch.`
                  }
                  className={`rounded border p-2 text-left text-xs transition-colors ${
                    active
                      ? 'border-accent bg-accent/15 text-text-primary'
                      : allowed
                      ? 'border-card-border bg-window-bg/50 text-text-secondary hover:bg-card-border/40'
                      : 'border-card-border bg-window-bg/30 text-text-muted opacity-40 cursor-not-allowed'
                  }`}
                >
                  <div className="font-medium">{p.label}</div>
                  <div className="text-[10px] text-text-muted leading-snug">
                    {p.shortNote}
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* Step 2 — Model picker. */}
      {!advanced && (
        <section className="mb-4">
          <h4 className="mb-1 text-xs font-medium text-text-secondary">
            2. Model
          </h4>
          {provider.id === 'custom' ? (
            <div className="space-y-2">
              <input
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                placeholder="model-id passed verbatim to --model"
                className={inputClass + ' font-mono text-xs'}
              />
              <input
                value={customBaseUrl}
                onChange={(e) => setCustomBaseUrl(e.target.value)}
                placeholder="ANTHROPIC_BASE_URL — e.g. http://localhost:3456"
                className={inputClass + ' font-mono text-xs'}
              />
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {provider.models.map((m) => {
                const active = m.id === modelId;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setModelId(m.id)}
                    className={`flex items-baseline justify-between gap-2 rounded border px-2 py-1.5 text-left text-xs transition-colors ${
                      active
                        ? 'border-accent bg-accent/15 text-text-primary'
                        : 'border-card-border bg-window-bg/50 text-text-secondary hover:bg-card-border/40'
                    }`}
                  >
                    <span className="font-mono">{m.label}</span>
                    {m.hint && (
                      <span className="text-[10px] text-text-muted">{m.hint}</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* Step 3 — API key. */}
      {!advanced && (
        <section className="mb-4">
          <h4 className="mb-1 text-xs font-medium text-text-secondary">
            3. API key
            {provider.apiKeyDashboard && (
              <>
                {' — '}
                <a
                  href={provider.apiKeyDashboard}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent-soft underline"
                >
                  get one
                </a>
              </>
            )}
          </h4>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              setApiKeyTouched(true);
            }}
            placeholder={
              provider.id === 'anthropic'
                ? 'sk-ant-…'
                : provider.id === 'ollama'
                ? 'any string (Ollama ignores it)'
                : 'sk-…'
            }
            className={inputClass + ' font-mono text-xs'}
            autoComplete="off"
          />
          <p className="mt-1 text-[11px] text-text-muted">{apiKeyHint}</p>
        </section>
      )}

      {/* Step 4 — Name + description. */}
      {!advanced && (
        <section className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="4. Agent name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={provider.defaultAgentName}
              className={inputClass + ' text-sm'}
            />
          </Field>
          <Field label="Description (optional)">
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Short description shown in the picker"
              className={inputClass + ' text-sm'}
            />
          </Field>
          {isNew && (
            <Field label="ID (slug, internal)" colSpan={2}>
              <input
                value={id}
                onChange={(e) => setId(e.target.value)}
                placeholder="diary_observer"
                className={inputClass + ' font-mono text-xs'}
              />
            </Field>
          )}
        </section>
      )}

      {/* Advanced — full editor surfaces */}
      {advanced && (
        <>
          <div className="mb-3 rounded border border-card-border bg-window-bg/40 p-3 text-[11px] text-text-muted">
            <strong className="text-text-secondary">Advanced mode.</strong>{' '}
            Edit env rows / system prompt / sampling directly. Useful for
            routers (claude-code-router, LiteLLM), shared secrets across
            agents, or tuning the diary system prompt. The simple form
            above writes to the same fields — you can flip back any time
            without losing data.
          </div>

          <details className="mb-4 rounded border border-card-border bg-window-bg p-3 text-xs">
            <summary className="cursor-pointer text-text-secondary">
              🛠 How these fields map to <code>claude</code> CLI
            </summary>
            <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px] text-text-muted">
{`claude -p "<context>" --output-format stream-json --verbose \\
  --model           ${modelId || '<MODEL>'} \\
  --append-system-prompt "<SYSTEM PROMPT>" \\
  --tools "" --no-session-persistence

# Process env (lower → higher precedence):
#   process.env  <  ~/.claude/settings.json  <  agent.env (below)
# Provider routing is decided 100% by env. There's no --provider flag.`}
            </pre>
          </details>

          <div className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
            {isNew && (
              <Field label="ID">
                <input
                  value={id}
                  onChange={(e) => setId(e.target.value)}
                  className={inputClass}
                  placeholder="diary_observer"
                />
              </Field>
            )}
            <Field label="Display name">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={inputClass}
                placeholder="Daily Observer"
              />
            </Field>
            <Field label="Model — passed as --model" colSpan={2}>
              <input
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                className={inputClass + ' font-mono text-xs'}
                placeholder="claude-haiku-4-5"
              />
            </Field>
            <Field label="Description (optional)" colSpan={2}>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className={inputClass}
                placeholder="Short description shown in the picker"
              />
            </Field>
          </div>

          <div className="mt-4">
            <h4 className="mb-1 text-xs font-medium text-text-secondary">
              Provider env — merged into the CLI's process env
            </h4>
            <p className="mb-2 text-[11px] text-text-muted">
              Use{' '}
              <code className="mx-1 rounded bg-card-border/40 px-1">${'{NAME}'}</code>
              to reference a secret. Available:{' '}
              {availableSecrets.length === 0
                ? '(none yet — add one under Secrets)'
                : availableSecrets.map((s) => `\${${s}}`).join(', ')}
            </p>
            <div className="mb-2 flex flex-wrap gap-1">
              {[
                { key: 'ANTHROPIC_API_KEY', hint: 'Anthropic native' },
                { key: 'ANTHROPIC_AUTH_TOKEN', hint: 'Most third-party providers' },
                { key: 'ANTHROPIC_BASE_URL', hint: 'Override endpoint' },
                { key: 'ANTHROPIC_MODEL', hint: 'Default model (overridden by --model)' },
              ].map(({ key, hint }) => {
                const already = envRows.some((r) => r.key === key);
                return (
                  <button
                    key={key}
                    type="button"
                    disabled={already}
                    title={already ? `${key} already added` : hint}
                    onClick={() => setEnvRows((rs) => [...rs, { key, value: '' }])}
                    className="rounded border border-card-border px-2 py-0.5 text-[10px] font-mono text-text-secondary hover:bg-card-border/40 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    + {key}
                  </button>
                );
              })}
            </div>
            <div className="space-y-1">
              {envRows.map((row, idx) => (
                <div key={idx} className="flex gap-2">
                  <input
                    value={row.key}
                    onChange={(e) =>
                      setEnvRows((rs) =>
                        rs.map((r, i) => (i === idx ? { ...r, key: e.target.value } : r)),
                      )
                    }
                    placeholder="ANTHROPIC_API_KEY"
                    className={inputClass + ' w-1/3 font-mono text-xs'}
                  />
                  <input
                    value={row.value}
                    onChange={(e) =>
                      setEnvRows((rs) =>
                        rs.map((r, i) => (i === idx ? { ...r, value: e.target.value } : r)),
                      )
                    }
                    placeholder="${DEEPSEEK_KEY} or literal value"
                    className={inputClass + ' flex-1 font-mono text-xs'}
                  />
                  <button
                    type="button"
                    onClick={() => setEnvRows((rs) => rs.filter((_, i) => i !== idx))}
                    className="rounded border border-card-border px-2 text-xs text-text-muted hover:text-status-disconnected"
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setEnvRows((rs) => [...rs, { key: '', value: '' }])}
                className="rounded border border-card-border px-2 py-1 text-[11px] text-text-secondary hover:bg-card-border/40"
              >
                + add row
              </button>
            </div>
          </div>

          <div className="mt-4">
            <h4 className="mb-1 text-xs font-medium text-text-secondary">
              System prompt — passed as --append-system-prompt
            </h4>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={8}
              className={inputClass + ' font-mono text-xs leading-snug'}
              placeholder="You are a careful observation assistant…"
            />
            <p className="mt-1 text-[11px] text-text-muted">
              ~{tokenEstimate} tokens
            </p>
          </div>

          <div className="mt-4 rounded border border-amber-500/30 bg-amber-500/5 p-3">
            <div className="mb-2 flex items-center gap-2 text-[11px] text-amber-300">
              <span aria-hidden>⚠</span>
              <span>
                <strong>Sampling — stored, not applied.</strong>{' '}
                The <code>claude</code> CLI doesn't expose <code>--temperature</code>
                {' '}or <code>--max-tokens</code> flags, so these sit in the JSON
                for forward compat but don't affect runs today.
              </span>
            </div>
            <div className="grid grid-cols-2 gap-4 text-sm opacity-80">
              <Field label={`Temperature (${temperature.toFixed(2)})`}>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={temperature}
                  onChange={(e) => setTemperature(Number(e.target.value))}
                />
              </Field>
              <Field label={`Max tokens (${maxTokens})`}>
                <input
                  type="range"
                  min={100}
                  max={4000}
                  step={100}
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(Number(e.target.value))}
                />
              </Field>
            </div>
          </div>
        </>
      )}

      {error && (
        <p className="mt-3 rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300">
          {error}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleTest}
          disabled={testing || isNew}
          title={isNew ? 'Save first to test' : 'Run a 1-token ping with current saved config'}
          className="rounded border border-card-border px-3 py-1.5 text-xs text-text-secondary hover:bg-card-border/40 disabled:opacity-50"
        >
          {testing ? 'Testing…' : 'Test'}
        </button>
        {testResult && (
          <span
            className={`rounded px-2 py-1 text-[11px] ${
              testResult.ok
                ? 'bg-emerald-500/20 text-emerald-300'
                : 'bg-red-500/20 text-red-300'
            }`}
          >
            {testResult.ok
              ? `✓ OK · ${testResult.latency_ms} ms` +
                (testResult.sample ? ` · "${testResult.sample.slice(0, 30)}"` : '')
              : `✗ ${testResult.error}`}
          </span>
        )}

        <div className="ml-auto flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-card-border px-3 py-1.5 text-xs text-text-secondary hover:bg-card-border/40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className={`rounded px-3 py-1.5 text-xs font-medium ${
              saving
                ? 'cursor-not-allowed bg-accent/40 text-white/70'
                : 'bg-accent text-white hover:bg-accent/90'
            }`}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
  colSpan,
}: {
  label: string;
  children: React.ReactNode;
  colSpan?: number;
}) {
  return (
    <label
      className={`flex flex-col gap-1 ${colSpan === 2 ? 'sm:col-span-2 md:col-span-2' : ''}`}
    >
      <span className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
        {label}
      </span>
      {children}
    </label>
  );
}
