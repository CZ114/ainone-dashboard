import { useEffect, useMemo, useRef, useState } from 'react';
import type { ActivePatient } from '../../lib/activePatient';
import { ConditionCardDeck } from '../../features/doctor-evaluation/components/ConditionCardDeck';
import { EvidencePanel } from '../../features/doctor-evaluation/components/EvidencePanel';
import { methodOutputStatusLabel } from '../../features/doctor-evaluation/domain/methodOutput';
import type {
  ConditionDefinition,
  DoctorEvaluationCase,
  MethodRunStatus,
} from '../../features/doctor-evaluation/types';

interface PatientReportAccordionProps {
  patient: ActivePatient;
  studyCase: DoctorEvaluationCase;
  conditions: ConditionDefinition[];
}

const STATUS_TONE: Record<MethodRunStatus, string> = {
  completed: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600',
  partial: 'border-amber-500/30 bg-amber-500/10 text-amber-600',
  failed: 'border-rose-500/30 bg-rose-500/10 text-rose-600',
  unavailable: 'border-card-border bg-card-hover text-text-muted',
};

function formatReportTime(values: Array<string | undefined>): string {
  const latest = values
    .flatMap((value) => {
      if (!value) return [];
      const timestamp = Date.parse(value);
      return Number.isFinite(timestamp) ? [{ value, timestamp }] : [];
    })
    .sort((left, right) => right.timestamp - left.timestamp)[0];

  if (!latest) return 'Time not provided';
  if (/^\d{4}-\d{2}-\d{2}$/.test(latest.value)) {
    return `${latest.value} (date only)`;
  }
  return new Date(latest.timestamp).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function PatientReportAccordion({
  patient,
  studyCase,
  conditions,
}: PatientReportAccordionProps) {
  const [expanded, setExpanded] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const evidencePanelRef = useRef<HTMLDivElement>(null);

  const reportItems = useMemo(
    () =>
      studyCase.conditionOrder.map((conditionId) => ({
        definition: conditions.find((condition) => condition.id === conditionId)!,
        output: studyCase.methodOutputs.find((output) => output.conditionId === conditionId)!,
      })),
    [conditions, studyCase],
  );
  const evidence = studyCase.methodOutputs.find((output) => output.conditionId === 'ours')?.evidence;
  const completedReports = reportItems.filter(({ output }) => output.status === 'completed').length;
  const latestReportTime = formatReportTime(
    reportItems.map(({ output }) => output.provenance.generatedAt),
  );
  const allComplete = completedReports === reportItems.length;

  useEffect(() => {
    if (expanded) return;
    setEvidenceOpen(false);
    audioRef.current?.pause();
  }, [expanded]);

  const toggleEvidence = () => {
    const nextOpen = !evidenceOpen;
    setEvidenceOpen(nextOpen);
    if (nextOpen) {
      window.setTimeout(() => {
        evidencePanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 0);
    }
  };

  const panelId = `patient-report-panel-${patient.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

  return (
    <section className="overflow-hidden rounded-xl border border-card-border bg-card-bg shadow-sm">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((current) => !current)}
        className="grid w-full gap-3 p-4 text-left transition hover:bg-card-hover/50 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto] md:items-center"
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-lg" aria-hidden="true">
            👤
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-text-primary">{patient.name}</span>
            <span className="mt-0.5 block font-mono text-[11px] text-text-muted">Patient ID · {patient.id}</span>
          </span>
        </span>

        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
            allComplete
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600'
              : 'border-amber-500/30 bg-amber-500/10 text-amber-600'
          }`}>
            {allComplete ? 'Reports complete' : 'Generating'} · {completedReports}/{reportItems.length}
          </span>
          <span className="text-[11px] text-text-muted">Latest report: {latestReportTime}</span>
        </span>

        <span className="flex items-center justify-between gap-3 md:justify-end">
          <span className="text-xs font-semibold text-accent">{expanded ? 'Collapse' : 'Expand'}</span>
          <span className={`text-sm text-text-muted transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true">⌄</span>
        </span>
      </button>

      <div className="flex flex-wrap gap-2 border-t border-card-border bg-window-bg/40 px-4 py-2.5">
        {reportItems.map(({ definition, output }) => (
          <span
            key={definition.id}
            className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold ${STATUS_TONE[output.status]}`}
          >
            {definition.blindLabel} · {methodOutputStatusLabel(output.status)}
          </span>
        ))}
        <span className="ml-auto text-[10px] text-text-muted">Frozen research output · not a real-time diagnosis</span>
      </div>

      {expanded && (
        <div id={panelId} className="border-t border-card-border p-4">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-accent">Patient-linked reports</p>
              <h2 className="mt-1 text-base font-semibold text-text-primary">A/B/C three-condition reports</h2>
              <p className="mt-1 text-xs text-text-muted">
                Frozen research case {studyCase.caseId}; the report API is not wired up yet — showing hard-coded results.
              </p>
            </div>
            <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[11px] font-semibold text-amber-600">
              Report API pending
            </span>
          </div>

          <audio
            ref={audioRef}
            className="mb-4 w-full"
            controls
            preload="metadata"
            src={studyCase.audio.src}
          />

          <ConditionCardDeck
            key={`${patient.id}-${studyCase.caseId}`}
            items={reportItems}
            mode="blinded"
            evidenceOpen={evidenceOpen}
            onToggleEvidence={toggleEvidence}
            onActiveConditionChange={(conditionId) => {
              if (conditionId !== 'ours') setEvidenceOpen(false);
            }}
          />

          {evidenceOpen && evidence && (
            <div ref={evidencePanelRef} className="mt-4 scroll-mt-6">
              <EvidencePanel evidence={evidence} audioRef={audioRef} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}