// GloveCalibrator — the "已佩戴 / worn" green indicator + a one-time
// self-calibration flow, driven by the gsr_filtered channel.
//
// Why calibrate instead of a fixed threshold: the worn GSR level drifts by
// device / person / session (observed worn means ~1969 / 2404 / 2061), and we
// have no not-worn baseline baked in. So the user captures the value glove-off
// then glove-on; worn = live value is on the "on" side of the midpoint.
// See lib/gloveCalibration.ts + hooks/useGloveWorn.ts.

import { useState } from 'react';
import { useLang } from '../../contexts/LanguageContext';
import { useStore } from '../../store';
import { useGloveWorn } from '../../hooks/useGloveWorn';
import {
  captureGsr,
  setCalib,
  useCalib,
  calibGap,
  useGsrChannel,
  setGsrChannel,
} from '../../lib/gloveCalibration';

const TEXT = {
  zh: {
    label: '佩戴状态',
    worn: '已佩戴',
    notWorn: '未佩戴',
    uncalibrated: '未校准',
    noSignal: '无 GSR 信号',
    calibrate: '校准',
    hide: '收起',
    guide: '按顺序采集：先把手套放桌上采「未佩戴」，再戴上采「已佩戴」。',
    capUnworn: '① 采未佩戴',
    capWorn: '② 采已佩戴',
    capturing: '采集中…（约 1.5 秒，别动）',
    done: (u: number, w: number) => `✓ 已校准 · 未戴≈${u} / 戴上≈${w}`,
    gapWarn: '两次读数太接近，可能没摘或没戴好 —— 建议重采。',
    noData: '现在没有实时 GSR 数据，连上设备再校准。',
    reset: '清除校准',
    live: 'GSR 实时',
    pickPrompt: '没自动认出 GSR 通道。手动指定哪条是 GSR（戴上后大约 1000~3000）：',
    pickPlaceholder: '选择 GSR 通道…',
    noChannels: '没有实时数据 —— 检查设备是否连上、后端是否在推流。',
    clearPick: '改回自动识别',
    needOff: '还差第①步：把手套摘下（放桌上），再点「① 采未佩戴」。两次都采了才算校准好。',
    needOn: '还差第②步：戴上手套，再点「② 采已佩戴」。两次都采了才算校准好。',
  },
  en: {
    label: 'Worn status',
    worn: 'Worn',
    notWorn: 'Not worn',
    uncalibrated: 'Not calibrated',
    noSignal: 'No GSR signal',
    calibrate: 'Calibrate',
    hide: 'Hide',
    guide: 'Capture in order: glove OFF on the table → “not worn”, then ON → “worn”.',
    capUnworn: '① Capture OFF',
    capWorn: '② Capture ON',
    capturing: 'Sampling… (~1.5 s, hold still)',
    done: (u: number, w: number) => `✓ Calibrated · off≈${u} / on≈${w}`,
    gapWarn: 'The two readings are very close — glove maybe not off/on. Re-capture.',
    noData: 'No live GSR data right now. Connect the device, then calibrate.',
    reset: 'Clear calibration',
    live: 'GSR live',
    pickPrompt: 'GSR channel not auto-detected. Pick which channel is GSR (≈1000–3000 when worn):',
    pickPlaceholder: 'Select GSR channel…',
    noChannels: 'No live data — check the device is connected and the backend is streaming.',
    clearPick: 'Back to auto-detect',
    needOff: 'One more — step ①: take the glove OFF (on the table), then tap “① Capture OFF”. Both captures are needed.',
    needOn: 'One more — step ②: put the glove ON, then tap “② Capture ON”. Both captures are needed.',
  },
};

const getChannels = () => useStore.getState().channels;

export function GloveCalibrator() {
  const { lang } = useLang();
  const t = TEXT[lang];
  const { worn, gsr, calibrated, hasGsr } = useGloveWorn();
  const calib = useCalib();
  const channels = useStore((s) => s.channels);
  const gsrChannel = useGsrChannel();
  // Auto-detect only fires when a channel is literally named "gsr…". When it
  // isn't, we keep the manual picker on screen (even after a pick) so a wrong
  // guess can be corrected without first reverting.
  const hasNamedGsr = channels.some((c) => /gsr/i.test(c.name));

  const [open, setOpen] = useState(false);
  const [capUnworn, setCapUnworn] = useState<number | null>(null);
  const [capWorn, setCapWorn] = useState<number | null>(null);
  const [busy, setBusy] = useState<false | 'off' | 'on'>(false);

  async function capture(which: 'off' | 'on') {
    if (busy) return;
    setBusy(which);
    const v = await captureGsr(getChannels, 1500);
    setBusy(false);
    if (v == null) return;
    const u = which === 'off' ? v : capUnworn;
    const w = which === 'on' ? v : capWorn;
    if (which === 'off') setCapUnworn(v);
    else setCapWorn(v);
    if (u != null && w != null) setCalib({ unworn: Math.round(u), worn: Math.round(w), ts: Date.now() });
  }

  function reset() {
    setCalib(null);
    setCapUnworn(null);
    setCapWorn(null);
  }

  // Worn-status pill: color + text
  let dot = 'bg-text-muted';
  let text = t.uncalibrated;
  let textCls = 'text-text-muted';
  if (!hasGsr) {
    dot = 'bg-text-muted';
    text = t.noSignal;
  } else if (!calibrated) {
    dot = 'bg-text-muted';
    text = t.uncalibrated;
  } else if (worn) {
    dot = 'bg-status-connected';
    text = t.worn;
    textCls = 'text-text-primary';
  } else {
    dot = 'bg-status-disconnected';
    text = t.notWorn;
    textCls = 'text-text-muted';
  }

  const gap = calib ? calibGap(calib) : 0;
  const tooClose = calib != null && gap < 30; // physiological GSR gap should be large

  return (
    <div className="pt-2.5 mt-0.5 border-t border-card-border">
      <div className="flex items-center gap-2 text-[13px]">
        <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${dot} ${worn ? 'ring-2 ring-status-connected/30' : ''}`} />
        <span className="text-text-secondary">{t.label}</span>
        <span className={`ml-auto font-medium ${textCls}`}>{text}</span>
      </div>

      <div className="flex items-center justify-between mt-1.5">
        <span className="text-[11px] text-text-muted font-mono">
          {t.live} {gsr != null ? gsr.toFixed(0) : '—'}
          {calib && <span className="opacity-60">{`  (off ${calib.unworn} / on ${calib.worn})`}</span>}
        </span>
        <button
          onClick={() => setOpen((o) => !o)}
          className="text-[11px] px-2 py-0.5 rounded border border-card-border text-text-secondary hover:text-text-primary transition-colors"
        >
          {open ? t.hide : t.calibrate}
        </button>
      </div>

      {open && (
        <div className="mt-2 p-2.5 rounded-lg bg-card-bg border border-card-border">
          {/* Channel picker — shown when no channel auto-matches /gsr/ (live
              frames are often unnamed CH1..CHN). The user reads each channel's
              live value and points us at the one that's GSR. Once a channel is
              named "gsr…" this whole block disappears. */}
          {!hasNamedGsr && channels.length > 0 && (
            <div className="mb-2.5">
              <p className="text-[11px] text-status-disconnected mb-1 leading-relaxed">{t.pickPrompt}</p>
              <select
                value={gsrChannel ?? ''}
                onChange={(e) => setGsrChannel(e.target.value || null)}
                className="w-full bg-window-bg border border-card-border rounded px-2 py-1 text-[12px] text-text-primary"
              >
                <option value="">{t.pickPlaceholder}</option>
                {channels.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name} = {Number.isFinite(c.value) ? c.value.toFixed(0) : '—'}
                  </option>
                ))}
              </select>
            </div>
          )}
          {channels.length === 0 && (
            <p className="text-[11px] text-status-disconnected mb-2">{t.noChannels}</p>
          )}
          {/* Manual override active but a real gsr channel now exists — offer to revert. */}
          {gsrChannel && (
            <button
              onClick={() => setGsrChannel(null)}
              className="mb-2 text-[10.5px] text-text-muted hover:text-text-secondary underline"
            >
              {t.clearPick}
            </button>
          )}

          <p className="text-[11px] text-text-muted mb-2 leading-relaxed">{t.guide}</p>
          <div className="flex gap-2">
            <button
              onClick={() => capture('off')}
              disabled={!hasGsr || busy !== false}
              className="flex-1 text-[11.5px] px-2 py-1 rounded border border-card-border text-text-secondary hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {t.capUnworn}
              {capUnworn != null && <span className="ml-1 font-mono text-status-disconnected">{capUnworn.toFixed(0)}</span>}
            </button>
            <button
              onClick={() => capture('on')}
              disabled={!hasGsr || busy !== false}
              className="flex-1 text-[11.5px] px-2 py-1 rounded border border-card-border text-text-secondary hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {t.capWorn}
              {capWorn != null && <span className="ml-1 font-mono text-status-connected">{capWorn.toFixed(0)}</span>}
            </button>
          </div>

          {busy !== false && <p className="text-[11px] text-accent mt-2">{t.capturing}</p>}
          {/* Partial calibration — exactly one side captured. Spell out which
              step remains so "Not calibrated" never looks like it ignored a tap. */}
          {!calib && busy === false && (capUnworn != null || capWorn != null) && (
            <p className="text-[11px] text-accent mt-2">{capUnworn == null ? t.needOff : t.needOn}</p>
          )}
          {calib && !tooClose && <p className="text-[11px] text-status-connected mt-2">{t.done(calib.unworn, calib.worn)}</p>}
          {tooClose && <p className="text-[11px] text-status-disconnected mt-2">{t.gapWarn}</p>}

          {calib && (
            <button onClick={reset} className="mt-2 text-[10.5px] text-text-muted hover:text-text-secondary underline">
              {t.reset}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
