// Schema-driven configuration UI for an installed+enabled extension.
//
// Rendered inside ExtensionCard whenever the extension declares a
// non-empty config_schema (see backend/app/extensions/base.py). The
// panel is generic: each field's `type` selects the widget and the
// rest of the schema entry parameterises it. No per-extension code
// here, so adding a new configurable extension on the backend
// automatically gets a working UI.
//
// State model: `pending` is what the user is editing locally. Apply
// computes the diff against `currentConfig` and POSTs only the
// changed keys (so the backend's shallow merge doesn't overwrite
// keys we never touched). On success we call `onChanged` to refetch
// the extension status — that re-renders us with the new
// currentConfig and pending stays in sync via the effect.

import { useEffect, useMemo, useState } from 'react';
import {
  extensionsApi,
  restartBackend,
  type ExtensionConfigField,
} from '../../api/extensionsApi';

interface ExtensionConfigPanelProps {
  extensionId: string;
  schema: ExtensionConfigField[];
  currentConfig: Record<string, unknown>;
  // Live runtime values reported by the extension (e.g.
  // runtime.model_name = the model that's actually loaded in memory,
  // which may differ from currentConfig.model_name if the user has
  // saved a new value but not yet restarted the backend). Used to
  // surface "configured X / running Y" mismatches in the UI.
  runtime?: Record<string, unknown>;
  onChanged: () => void;
}

// Resolve the value to render for a field: persisted config wins,
// schema default is the fallback. Centralised so dirty-checking and
// reset use the same source of truth.
function resolveValue(
  field: ExtensionConfigField,
  config: Record<string, unknown>,
): unknown {
  return field.key in config ? config[field.key] : field.default;
}

// Slider step like 0.05 should display as 0.05, not 0.05000000007.
// Pull decimal precision off the schema step so we don't hard-code.
function formatSliderValue(value: number, step: number | undefined): string {
  if (!step) return String(value);
  const stepStr = String(step);
  const dot = stepStr.indexOf('.');
  const decimals = dot < 0 ? 0 : stepStr.length - dot - 1;
  return value.toFixed(decimals);
}

export function ExtensionConfigPanel({
  extensionId,
  schema,
  currentConfig,
  runtime,
  onChanged,
}: ExtensionConfigPanelProps) {
  const [pending, setPending] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(schema.map((f) => [f.key, resolveValue(f, currentConfig)])),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastApplied, setLastApplied] = useState<number | null>(null);
  // Restart state machine: idle → triggered (200 from /restart) →
  // polling (waiting for backend to come back up) → idle (success).
  // We render a different UI on each step so the user can tell what's
  // happening through the ~30 s downtime.
  const [restartPhase, setRestartPhase] =
    useState<'idle' | 'requesting' | 'polling'>('idle');

  // Re-sync pending when currentConfig changes from outside (e.g. the
  // parent refetched after another tab's apply). Keeps fields the user
  // is currently editing locally vs. picking up server-side updates.
  useEffect(() => {
    setPending(
      Object.fromEntries(
        schema.map((f) => [f.key, resolveValue(f, currentConfig)]),
      ),
    );
  }, [currentConfig, schema]);

  // A field is dirty if its pending value differs from the value the
  // server currently has (or would default to). Apply is gated on at
  // least one being dirty.
  const dirtyKeys = useMemo(
    () =>
      schema
        .filter((f) => pending[f.key] !== resolveValue(f, currentConfig))
        .map((f) => f.key),
    [schema, pending, currentConfig],
  );

  // Restart-required state: true when at least one requires_reload
  // field is either dirty (about to be applied) OR already applied
  // but the running runtime value still differs (user clicked Apply
  // but hasn't restarted the backend yet).
  //
  // Why we need both conditions: in-process model swap is disabled
  // (CT2 + CUDA on Windows segfaults), so a saved change only takes
  // effect on the next backend boot. The badge must stay visible
  // AFTER Apply so the user knows there's still work to do.
  const requiresRestart = schema.some((f) => {
    if (!f.requires_reload) return false;
    if (dirtyKeys.includes(f.key)) return true;
    if (runtime && f.key in runtime) {
      const live = runtime[f.key];
      const configured = resolveValue(f, currentConfig);
      return live !== configured;
    }
    return false;
  });

  const handleApply = async () => {
    // Heavyweight-load warning: any dirty select field whose new value
    // sits in an option group whose label mentions GPU triggers an
    // extra confirmation. The check is generic on the schema (any
    // extension can opt-in by labelling a group "GPU recommended"),
    // so this code doesn't grow per-extension.
    for (const k of dirtyKeys) {
      const f = schema.find((s) => s.key === k);
      if (!f || f.type !== 'select' || !f.option_groups) continue;
      const newVal = String(pending[k]);
      const heavyGroup = f.option_groups.find((g) =>
        /gpu/i.test(g.label),
      );
      if (heavyGroup && heavyGroup.options.includes(newVal)) {
        const ok = window.confirm(
          `'${newVal}' is in the "${heavyGroup.label}" tier.\n\n` +
            `First load can take several minutes (downloads up to ~3 GB) ` +
            `and the backend MUST restart to actually swap models — ` +
            `in-process swap can crash CUDA on Windows.\n\n` +
            `Click OK to save the value, then use "Restart now" to apply.`,
        );
        if (!ok) return;
      }
    }

    setSaving(true);
    setError(null);
    // Send only the dirty keys. The backend's update_config does a
    // shallow merge, so untouched keys keep their persisted values.
    const patch: Record<string, unknown> = {};
    for (const k of dirtyKeys) patch[k] = pending[k];
    const r = await extensionsApi.updateConfig(extensionId, patch);
    setSaving(false);
    if (r.error) {
      setError(r.error);
      return;
    }
    setLastApplied(Date.now());
    onChanged();
  };

  const handleRestart = async () => {
    if (
      !window.confirm(
        `Restart the backend now?\n\n` +
          `Saved config will be applied. Brief downtime (~10-30 s for ` +
          `cached models, longer if a fresh download is needed). The ` +
          `frontend will auto-reconnect when the backend is back.`,
      )
    ) {
      return;
    }
    setRestartPhase('requesting');
    setError(null);
    const r = await restartBackend();
    if (r.error) {
      setError(`Restart failed: ${r.error}`);
      setRestartPhase('idle');
      return;
    }
    // Backend now exiting; switch to polling phase.
    setRestartPhase('polling');
    // Poll every 1.5 s for up to 3 minutes. Whisper's first-time
    // download can take a couple of minutes; idle giveup at 3 min
    // covers the worst case without hanging the UI forever if the
    // user's supervisor isn't actually restarting.
    const start = Date.now();
    const POLL_MS = 1500;
    const TIMEOUT_MS = 3 * 60 * 1000;
    while (Date.now() - start < TIMEOUT_MS) {
      await new Promise((res) => setTimeout(res, POLL_MS));
      const probe = await extensionsApi.list();
      if (!probe.error) {
        // Backend is reachable again — refresh the parent so the new
        // status (config matched against runtime) is reflected.
        setRestartPhase('idle');
        onChanged();
        return;
      }
    }
    setError(
      'Backend did not come back within 3 minutes. ' +
        'Check the supervisor terminal — it may be downloading a ' +
        'model or the supervisor process itself was killed.',
    );
    setRestartPhase('idle');
  };

  const handleReset = () => {
    // Reset to schema defaults — different from "discard edits"
    // (which would mean "back to currentConfig"). Reset is the more
    // useful escape hatch when the user has tuned themselves into a
    // bad spot and just wants the recommended baseline back.
    setPending(Object.fromEntries(schema.map((f) => [f.key, f.default])));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">
          Configuration
        </h4>
        {requiresRestart && restartPhase === 'idle' && (
          <div className="flex items-center gap-2">
            <span
              title="Saving applies the value to disk, but loading a different model in-process can crash CUDA. Restart the backend to actually swap."
              className="text-[10px] px-1.5 py-0.5 rounded bg-status-warning/20 text-status-warning border border-status-warning/30"
            >
              Restart required
            </span>
            <button
              onClick={handleRestart}
              disabled={saving}
              className="px-2 py-0.5 text-[11px] rounded bg-status-warning hover:opacity-90 text-white font-medium disabled:opacity-50"
            >
              Restart now
            </button>
          </div>
        )}
        {restartPhase === 'requesting' && (
          <span className="text-[11px] text-status-warning">
            Sending restart signal…
          </span>
        )}
        {restartPhase === 'polling' && (
          <span className="text-[11px] text-status-warning animate-pulse">
            ⏳ Backend restarting — waiting for it to come back…
          </span>
        )}
      </div>

      {schema.map((field) => (
        <ConfigField
          key={field.key}
          field={field}
          value={pending[field.key]}
          onChange={(v) =>
            setPending((prev) => ({ ...prev, [field.key]: v }))
          }
        />
      ))}

      <div className="flex items-center gap-2 pt-2">
        <button
          onClick={handleApply}
          disabled={dirtyKeys.length === 0 || saving}
          className="px-3 py-1.5 text-xs rounded bg-accent hover:bg-accent-hover disabled:bg-card-border disabled:text-text-muted disabled:cursor-not-allowed text-white font-medium"
        >
          {saving
            ? 'Applying…'
            : dirtyKeys.length > 0
              ? `Apply (${dirtyKeys.length} change${dirtyKeys.length === 1 ? '' : 's'})`
              : 'Apply'}
        </button>
        <button
          onClick={handleReset}
          disabled={saving}
          className="px-3 py-1.5 text-xs rounded text-text-secondary hover:bg-card-border disabled:opacity-50"
        >
          Reset to defaults
        </button>
        {lastApplied && !saving && dirtyKeys.length === 0 && !error && (
          <span className="text-[11px] text-status-success">
            ✓ Applied
          </span>
        )}
      </div>

      {error && (
        <p className="text-xs text-status-danger">
          Apply failed: <code className="break-all">{error}</code>
        </p>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------
// Per-field renderer. Splitting it out keeps the diff for a new
// widget type small (add one branch here, no schema-loop changes).

interface ConfigFieldProps {
  field: ExtensionConfigField;
  value: unknown;
  onChange: (value: unknown) => void;
}

function ConfigField({ field, value, onChange }: ConfigFieldProps) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <label className="text-xs font-medium text-text-primary">
          {field.label}
        </label>
        {field.type === 'slider' && (
          <span className="text-[11px] font-mono text-text-secondary tabular-nums">
            {formatSliderValue(Number(value), field.step)}
          </span>
        )}
      </div>

      {field.type === 'select' && (
        <select
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-2 py-1.5 text-xs rounded bg-black/30 border border-card-border text-text-primary focus:outline-none focus:border-accent"
        >
          {/* Prefer option_groups for the visual divider; fall back to
              flat options for older backends or simple fields. */}
          {field.option_groups
            ? field.option_groups.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.options.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </optgroup>
              ))
            : (field.options ?? []).map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
        </select>
      )}

      {field.type === 'slider' && (
        <input
          type="range"
          min={field.min}
          max={field.max}
          step={field.step}
          value={Number(value)}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="w-full accent-accent"
        />
      )}

      {field.help && (
        <p className="mt-1 text-[11px] text-text-muted leading-snug">
          {field.help}
        </p>
      )}
    </div>
  );
}
