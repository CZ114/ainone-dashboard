import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { EvidenceSegment, TraceableEvidence } from '../types';

interface EvidencePanelProps {
  evidence: TraceableEvidence;
  audioRef: RefObject<HTMLAudioElement>;
}

const severityStyle: Record<string, string> = {
  reference_range: 'border-status-success/30 bg-status-success/10 text-status-success',
  borderline_high: 'border-status-warning/30 bg-status-warning/10 text-status-warning',
  abnormal: 'border-status-danger/30 bg-status-danger/10 text-status-danger',
  cohort_low: 'border-blue-400/30 bg-blue-400/10 text-blue-500',
  cohort_mid: 'border-accent/30 bg-accent/10 text-accent',
  cohort_high: 'border-status-danger/30 bg-status-danger/10 text-status-danger',
  ungraded: 'border-card-border bg-card-hover text-text-secondary',
};

const clamp = (value: number) => Math.max(0, Math.min(1, value));

function formatSeconds(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function MetricTrace({
  evidence,
  dimensionId,
  selectedSegmentId,
  onSelect,
}: {
  evidence: TraceableEvidence;
  dimensionId: string;
  selectedSegmentId?: string;
  onSelect: (segment: EvidenceSegment) => void;
}) {
  const dimension = evidence.dimensions.find((item) => item.id === dimensionId) ?? evidence.dimensions[0];
  const points = evidence.segments
    .map((segment) => ({ segment, value: segment.metrics[dimension.metricKey] }))
    .filter((item): item is { segment: EvidenceSegment; value: number } => typeof item.value === 'number');
  const width = 920;
  const height = 250;
  const padX = 54;
  const padY = 28;
  const plotWidth = width - padX * 2;
  const plotHeight = height - padY * 2;
  const maxEnd = Math.max(1, ...evidence.segments.map((segment) => segment.endSeconds));
  const x = (seconds: number) => padX + (seconds / maxEnd) * plotWidth;
  const y = (value: number) => padY + (1 - clamp(value)) * plotHeight;
  const polyline = points
    .map(({ segment, value }) => `${x((segment.startSeconds + segment.endSeconds) / 2)},${y(value)}`)
    .join(' ');
  const reference = dimension.reference;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="font-semibold text-text-primary">{dimension.label}</h4>
          <p className="mt-1 text-xs leading-5 text-text-secondary">{dimension.description || '按语音片段追踪该指标变化。'}</p>
        </div>
        <div className="rounded-lg bg-accent/10 px-3 py-2 text-xs text-accent">
          参考：{reference.populationLabel} · 中位数 {reference.median.toFixed(2)}
        </div>
      </div>
      <div className="overflow-x-auto rounded-xl border border-card-border bg-card-hover/60 p-2">
        {points.length > 0 ? (
          <svg viewBox={`0 0 ${width} ${height}`} className="min-w-[680px]" role="img" aria-label={`${dimension.label}证据轨迹`}>
            {[0, 0.25, 0.5, 0.75, 1].map((value) => (
              <g key={value}>
                <line x1={padX} x2={width - padX} y1={y(value)} y2={y(value)} stroke="currentColor" className="text-card-border" strokeWidth="1" />
                <text x={padX - 12} y={y(value) + 4} textAnchor="end" className="fill-current text-[11px] text-text-muted">
                  {value.toFixed(2)}
                </text>
              </g>
            ))}
            <rect
              x={padX}
              y={y(reference.q3)}
              width={plotWidth}
              height={Math.max(2, y(reference.q1) - y(reference.q3))}
              className="fill-accent/10"
            />
            <line x1={padX} x2={width - padX} y1={y(reference.median)} y2={y(reference.median)} className="stroke-accent/50" strokeDasharray="7 6" />
            {points.length > 1 && <polyline points={polyline} fill="none" className="stroke-accent" strokeWidth="3" strokeLinejoin="round" />}
            {points.map(({ segment, value }) => {
              const cx = x((segment.startSeconds + segment.endSeconds) / 2);
              const cy = y(value);
              const selected = selectedSegmentId === segment.segmentId;
              return (
                <g key={segment.segmentId} className="cursor-pointer" onClick={() => onSelect(segment)}>
                  <circle cx={cx} cy={cy} r={selected ? 10 : 7} className={selected ? 'fill-accent stroke-white' : 'fill-card-bg stroke-accent'} strokeWidth="3" />
                  <text x={cx} y={height - 8} textAnchor="middle" className="fill-current text-[10px] text-text-muted">
                    {formatSeconds(segment.startSeconds)}
                  </text>
                </g>
              );
            })}
          </svg>
        ) : (
          <div className="flex min-h-44 items-center justify-center text-sm text-text-secondary">该维度暂无可绘制数值</div>
        )}
      </div>
    </div>
  );
}

export function EvidencePanel({ evidence, audioRef }: EvidencePanelProps) {
  const [dimensionId, setDimensionId] = useState(evidence.dimensions[0]?.id ?? '');
  const [selectedSegmentId, setSelectedSegmentId] = useState(evidence.segments[0]?.segmentId);
  const playbackTimerRef = useRef<number | null>(null);
  const selectedSegment = useMemo(
    () => evidence.segments.find((segment) => segment.segmentId === selectedSegmentId) ?? evidence.segments[0],
    [evidence.segments, selectedSegmentId],
  );

  const clearPlaybackTimer = () => {
    if (playbackTimerRef.current !== null) {
      window.clearTimeout(playbackTimerRef.current);
      playbackTimerRef.current = null;
    }
  };

  const stopSegment = () => {
    clearPlaybackTimer();
    audioRef.current?.pause();
  };

  const playSegment = () => {
    const audio = audioRef.current;
    if (!audio || !selectedSegment) return;
    clearPlaybackTimer();
    audio.currentTime = selectedSegment.startSeconds;
    void audio.play();
    playbackTimerRef.current = window.setTimeout(() => {
      audio.pause();
      playbackTimerRef.current = null;
    }, Math.max(500, (selectedSegment.endSeconds - selectedSegment.startSeconds) * 1000));
  };

  useEffect(() => () => stopSegment(), []);

  return (
    <section className="overflow-hidden rounded-2xl border border-card-border bg-card-bg shadow-sm">
      <div className="border-b border-card-border px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold text-text-primary">临床状态与对照参考</h3>
            <p className="mt-1 text-xs text-text-secondary">状态卡保留冻结刺激中的原始指标、病例值、参考范围与计算解释。</p>
          </div>
          <span className="rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-xs font-semibold text-accent">Condition C · Evidence trace</span>
        </div>
      </div>

      <div className="p-5">
        <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {evidence.states.map((state) => {
            const value = state.normalizedValue == null ? null : clamp(state.normalizedValue);
            const reference = state.reference;
            const hasRange = Boolean(reference && reference.q3 > reference.q1);
            const rangeLeft = hasRange ? clamp(reference!.q1) * 100 : 0;
            const rangeWidth = hasRange ? Math.max(2, (reference!.q3 - reference!.q1) * 100) : 100;
            const referenceText = state.referenceLabel ?? reference?.populationLabel ?? '缺少可比参考';

            return (
              <article key={state.id} className="rounded-xl border border-card-border bg-card-hover/60 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h4 className="font-semibold text-text-primary">{state.label}</h4>
                    <p className="mt-1 text-xs leading-5 text-text-secondary">{state.description}</p>
                  </div>
                  <span className={`shrink-0 rounded-full border px-2 py-1 text-[11px] font-semibold ${severityStyle[state.severity] ?? severityStyle.ungraded}`}>
                    {state.severityLabel}
                  </span>
                </div>

                <div className="relative mt-4 h-3 rounded-full bg-card-border">
                  <span
                    className="absolute inset-y-0 rounded-full bg-status-success/35"
                    style={{ left: `${rangeLeft}%`, width: `${rangeWidth}%` }}
                  />
                  {value !== null && (
                    <span
                      aria-label="病例状态值"
                      className="absolute top-1/2 h-4 w-1.5 -translate-y-1/2 rounded-full bg-accent shadow-[0_0_0_2px_rgba(255,255,255,0.72)]"
                      style={{ left: `calc(${value * 100}% - 3px)` }}
                    />
                  )}
                </div>

                <div className="mt-3 flex items-end justify-between gap-3">
                  <span className="max-w-[62%] text-[11px] leading-4 text-text-muted">{referenceText}</span>
                  <span className="text-right text-lg font-semibold text-text-primary">{state.valueLabel ?? (value?.toFixed(2) || '暂不估计')}</span>
                </div>

                {state.supportingMetrics.length > 0 && (
                  <details className="mt-3 border-t border-card-border pt-3" open={state.expandMetrics}>
                    <summary className="cursor-pointer text-xs font-semibold text-text-secondary">查看原始指标与计算解释</summary>
                    <div className="mt-3 overflow-x-auto">
                      <table className="min-w-full text-left text-xs">
                        <thead className="border-b border-card-border text-text-muted">
                          <tr>
                            <th className="pb-2 pr-3 font-medium">支持指标</th>
                            <th className="pb-2 pr-3 font-medium">本病例</th>
                            <th className="pb-2 font-medium">参考分布/含义</th>
                          </tr>
                        </thead>
                        <tbody>
                          {state.supportingMetrics.map((metric) => (
                            <tr key={metric.id} className="border-b border-card-border/70 last:border-0">
                              <td className="py-2 pr-3 text-text-secondary">{metric.label}</td>
                              <td className="py-2 pr-3 font-medium text-text-primary">{metric.displayValue ?? metric.value ?? '—'}{metric.unit ? ` ${metric.unit}` : ''}</td>
                              <td className="py-2 leading-5 text-text-muted">{metric.referenceText ?? metric.interpretation ?? '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                )}
              </article>
            );
          })}
        </div>

        <div className="mb-4 border-t border-card-border pt-5">
          <h3 className="font-semibold text-text-primary">片段证据回溯</h3>
          <p className="mt-1 text-xs text-text-secondary">选择状态并点击轨迹点，可检查原始转录、局部计算值与对应音频片段。</p>
        </div>

        {evidence.dimensions.length > 0 && (
          <>
            <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
              {evidence.dimensions.map((dimension) => (
                <button
                  key={dimension.id}
                  type="button"
                  onClick={() => setDimensionId(dimension.id)}
                  className={`whitespace-nowrap rounded-full px-3 py-2 text-xs font-semibold transition ${
                    dimensionId === dimension.id
                      ? 'bg-accent text-white'
                      : 'border border-card-border bg-card-hover text-text-secondary hover:border-accent/50'
                  }`}
                >
                  {dimension.label}
                </button>
              ))}
            </div>
            <MetricTrace
              evidence={evidence}
              dimensionId={dimensionId}
              selectedSegmentId={selectedSegment?.segmentId}
              onSelect={(segment) => setSelectedSegmentId(segment.segmentId)}
            />
          </>
        )}

        {selectedSegment && (
          <div className="mt-5 grid gap-4 rounded-xl border border-accent/25 bg-accent/5 p-4 lg:grid-cols-[180px_1fr]">
            <div>
              <p className="text-xs uppercase tracking-wider text-text-muted">选中片段</p>
              <p className="mt-2 text-lg font-semibold text-text-primary">
                {formatSeconds(selectedSegment.startSeconds)}–{formatSeconds(selectedSegment.endSeconds)}
              </p>
              <p className="mt-1 text-xs text-text-secondary">说话人：{selectedSegment.speakerRole}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={playSegment}
                  className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white"
                >
                  ▶ 开始回听
                </button>
                <button
                  type="button"
                  onClick={stopSegment}
                  className="rounded-lg border border-card-border bg-card-bg px-3 py-2 text-xs font-semibold text-text-secondary hover:bg-card-hover"
                >
                  ■ 停止
                </button>
              </div>
            </div>
            <div>
              <p className="text-sm leading-7 text-text-primary">“{selectedSegment.transcript || '该片段暂无转录文本'}”</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {selectedSegment.coreUnits.map((unit) => (
                  <span key={unit} className="rounded-full border border-card-border bg-card-bg px-2.5 py-1 text-xs text-text-secondary">{unit}</span>
                ))}
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-text-muted">
                <span>原始音频/转录</span><span>→</span><span>局部指标</span><span>→</span><span>临床状态</span><span>→</span><span>报告结论</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}