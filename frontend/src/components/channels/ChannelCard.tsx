// ChannelCard — one sensor channel: header, big value, waveform.
//
// Interactivity inside the chart area:
//   - Wheel: zoom Y-axis (deltaY>0 → wider view, deltaY<0 → narrower).
//     Centered on the current view midpoint so the user keeps context.
//   - Double-click: reset to auto-scale, resuming live min/max tracking.
//   - Manual zoom state is LOCAL to the card; other cards are unaffected.
//
// Why a native wheel listener (addEventListener) instead of React's
// onWheel: React attaches wheel as a passive listener, which makes
// `e.preventDefault()` a no-op. Without preventDefault, scrolling the
// chart also scrolls the page, which fights the user. Registering the
// listener ourselves with `{ passive: false }` fixes this.

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { WaveformChart } from './WaveformChart';
import { useStore } from '../../store';
import { ChannelData } from '../../types';

interface ChannelCardProps {
  channel: ChannelData;
  index: number;
  onToggle: (index: number) => void;
  onZoom: (index: number, yMin: number, yMax: number) => void;
}

// Reference card geometry at scale=1.0. Everything else is linear off these.
const REF_PADDING_PX = 16;             // Tailwind p-4
const REF_VALUE_FONT_PX = 30;          // Tailwind text-3xl
const REF_CHART_HEIGHT_PX = 80;        // Tailwind h-20
const REF_HEADER_GAP_PX = 8;           // Tailwind mb-2
const REF_VALUE_MARGIN_PX = 12;        // Tailwind mb-3

export function ChannelCard({ channel, index, onToggle, onZoom }: ChannelCardProps) {
  const cardScale = useStore((state) => state.settings.card_scale);
  const wheelSensitivity = useStore(
    (state) => state.settings.wheel_zoom_sensitivity,
  );

  const [yAutoScale, setYAutoScale] = useState(true);
  const [yRange, setYRange] = useState<[number, number]>([0, 1]);

  const chartHostRef = useRef<HTMLDivElement | null>(null);

  // --- Wheel zoom (native listener for passive:false) -----------------

  // We stash the latest zoom inputs in refs so the effect below can use
  // a STABLE handler — re-attaching on every state tick would cause
  // events to be missed at worst and be wasteful at best.
  const autoRef = useRef(yAutoScale);
  const rangeRef = useRef(yRange);
  const statsRef = useRef(channel.stats);
  const sensRef = useRef(wheelSensitivity);
  autoRef.current = yAutoScale;
  rangeRef.current = yRange;
  statsRef.current = channel.stats;
  sensRef.current = wheelSensitivity;

  useEffect(() => {
    const el = chartHostRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      // Only act when the pointer is genuinely over our chart (element
      // we bound to). preventDefault stops the page from scrolling.
      e.preventDefault();

      const isAuto = autoRef.current;
      const stats = statsRef.current;
      const currentMin = isAuto ? stats.min : rangeRef.current[0];
      const currentMax = isAuto ? stats.max : rangeRef.current[1];
      if (!Number.isFinite(currentMin) || !Number.isFinite(currentMax)) return;

      const center = (currentMin + currentMax) / 2;
      const range = currentMax - currentMin || 1;

      // deltaY > 0 means wheel rolled DOWN (ctrl-scroll out / zoom out).
      // Factor > 1 expands the visible range; < 1 tightens it. The
      // sensitivity is live-read from DisplaySettings — users can tune
      // it at any time without re-opening the chart.
      const sens = Math.max(1.001, sensRef.current);
      const factor = e.deltaY > 0 ? sens : 1 / sens;
      const newRange = Math.max(1e-6, range * factor);

      const newMin = center - newRange / 2;
      const newMax = center + newRange / 2;

      setYAutoScale(false);
      setYRange([newMin, newMax]);
      onZoom(index, newMin, newMax);
    };

    // passive: false required so preventDefault actually stops page scroll.
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
    };
  }, [index, onZoom]);

  const handleDoubleClick = useCallback(() => {
    // Resume live tracking.
    setYAutoScale(true);
  }, []);

  const handleResetClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setYAutoScale(true);
  }, []);

  // --- Y-axis range computation -------------------------------------

  const { yMin, yMax, dataMin, dataMax } = useMemo(() => {
    if (yAutoScale && channel.waveform.length > 0) {
      let dataMin = Infinity;
      let dataMax = -Infinity;
      for (const v of channel.waveform) {
        if (v < dataMin) dataMin = v;
        if (v > dataMax) dataMax = v;
      }
      const range = dataMax - dataMin || 1;
      const margin = range * 0.1;
      return {
        yMin: dataMin - margin,
        yMax: dataMax + margin,
        dataMin,
        dataMax,
      };
    }
    return {
      yMin: yRange[0],
      yMax: yRange[1],
      dataMin: channel.stats.min,
      dataMax: channel.stats.max,
    };
  }, [yAutoScale, yRange, channel.waveform, channel.stats.min, channel.stats.max]);

  const formatValue = (value: number) => {
    if (Math.abs(value) >= 10000) return value.toFixed(0);
    return value.toFixed(2);
  };

  // --- Scale-derived dimensions -------------------------------------

  const padding = REF_PADDING_PX * cardScale;
  const valueFontSize = REF_VALUE_FONT_PX * cardScale;
  const chartHeight = REF_CHART_HEIGHT_PX * cardScale;
  const headerGap = REF_HEADER_GAP_PX * cardScale;
  const valueMargin = REF_VALUE_MARGIN_PX * cardScale;

  return (
    <div
      className={`
        bg-card-bg rounded-xl border border-card-border
        transition-all duration-200
        ${channel.enabled ? 'opacity-100' : 'opacity-40'}
      `}
      style={{ padding: `${padding}px` }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between"
        style={{ marginBottom: `${headerGap}px` }}
      >
        <button
          onClick={() => onToggle(index)}
          className="flex items-center gap-2 hover:opacity-80 transition-opacity min-w-0"
        >
          <span
            className="text-lg shrink-0"
            style={{ color: channel.enabled ? channel.color : undefined }}
          >
            {channel.enabled ? '●' : '○'}
          </span>
          <span
            className="font-semibold text-sm truncate"
            style={{ color: channel.enabled ? channel.color : '#64748B' }}
          >
            {channel.name}
          </span>
        </button>
        {/* Reset-zoom pill — only visible when the user has manually
            zoomed. Single click restores auto-scale. */}
        {!yAutoScale && (
          <button
            onClick={handleResetClick}
            className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-accent/20 text-accent-soft hover:bg-accent/30 transition-colors font-mono"
            title="Reset Y-axis zoom (or double-click the chart)"
          >
            ↺ auto
          </button>
        )}
      </div>

      {/* Value display */}
      <div
        className="flex items-baseline justify-between"
        style={{ marginBottom: `${valueMargin}px` }}
      >
        <span
          className="font-bold text-text-primary font-mono"
          style={{ fontSize: `${valueFontSize}px`, lineHeight: 1.1 }}
        >
          {channel.enabled ? formatValue(channel.value) : '--'}
        </span>
      </div>

      {/* Waveform wrapper — this is the zoom/reset target. The ref is
          attached HERE so wheel events anywhere over the chart region
          (including min/max labels) count. */}
      <div
        ref={chartHostRef}
        onDoubleClick={handleDoubleClick}
        style={{ height: `${chartHeight}px` }}
        // Subtle cursor hint that this region is interactive.
        className="cursor-ns-resize"
        title="Scroll to zoom Y-axis · Double-click to reset"
      >
        {channel.enabled && channel.waveform.length > 0 ? (
          <WaveformChart
            data={channel.waveform}
            color={channel.color}
            yMin={yMin}
            yMax={yMax}
            dataMin={dataMin}
            dataMax={dataMax}
            height={chartHeight}
          />
        ) : (
          <div className="h-full flex items-center justify-center text-text-muted text-sm">
            No data
          </div>
        )}
      </div>
    </div>
  );
}
