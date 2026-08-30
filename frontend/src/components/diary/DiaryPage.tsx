// /diary timeline page. Renders entries (newest first), a "Generate
// now" button, the in-flight chunk preview, and a toast that picks up
// signals from the global diary store.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDiaryStore } from '../../store/diaryStore';
import { Header } from '../layout/Header';
import { Toast, type ToastMessage } from '../Toast';
import { EntryCard } from './EntryCard';
import { MessageMarkdown } from '../chat/MessageMarkdown';
import type { DiaryEntry } from '../../api/diaryApi';
import { useT } from '../../contexts/LanguageContext';
import { useCan } from '../../contexts/RoleContext';
import { useActivePatient } from '../../lib/activePatient';
import { doctorEvaluationMockStudy } from '../../features/doctor-evaluation/mockStudy';
import { studyCaseForPatientId } from '../../features/doctor-evaluation/patientCase';
import { researchPatientsFromStudy } from '../../features/doctor-evaluation/researchPatients';
import { PatientReportAccordion } from './PatientReportAccordion';

// Per-entry sessionStorage key. Picked up by ChatPage on /chat mount to
// build the pinned context card and inject the diary entry as the
// FIRST send's additionalSystemPrompt.
export const DIARY_HANDOFF_PREFIX = 'diary-handoff:';

export interface DiaryHandoff {
  entry_id: string;
  cwd: string;
  // DEAD CODE — see docs/specs/diary.md "Dead code / debt".
  additional_system_prompt: string;
  // Persisted so ChatPage can render the pinned card without an
  // extra fetch round-trip.
  entry_title: string;
  entry_body: string;
  entry_created_at: string;
  entry_agent_id: string;
  entry_model: string;
}

export default function DiaryPage() {
  const navigate = useNavigate();
  const t = useT();
  const can = useCan();
  const activePatient = useActivePatient();
  const researchPatients = useMemo(
    () => researchPatientsFromStudy(doctorEvaluationMockStudy),
    [],
  );
  const activeResearchPatient = activePatient
    ? researchPatients.find((patient) => patient.id === activePatient.id) ?? null
    : null;
  const reportPatientRows = useMemo(() => {
    const orderedPatients = activeResearchPatient
      ? [
          activeResearchPatient,
          ...researchPatients.filter((patient) => patient.id !== activeResearchPatient.id),
        ]
      : researchPatients;

    return orderedPatients.flatMap((patient) => {
      const studyCase = studyCaseForPatientId(patient.id, doctorEvaluationMockStudy);
      return studyCase
        ? [{ patient: { id: patient.id, name: patient.name }, studyCase }]
        : [];
    });
  }, [activeResearchPatient, researchPatients]);
  const entries = useDiaryStore((s) => s.entries);
  const loading = useDiaryStore((s) => s.loading);
  const generating = useDiaryStore((s) => s.generating);
  const inFlight = useDiaryStore((s) => s.inFlight);
  const error = useDiaryStore((s) => s.error);
  const toastSignal = useDiaryStore((s) => s.toastSignal);
  const consumeToast = useDiaryStore((s) => s.consumeToast);
  const loadEntries = useDiaryStore((s) => s.loadEntries);
  const triggerNow = useDiaryStore((s) => s.triggerNow);
  const abortGenerating = useDiaryStore((s) => s.abortGenerating);
  const markRead = useDiaryStore((s) => s.markRead);
  const deleteEntry = useDiaryStore((s) => s.deleteEntry);
  const reply = useDiaryStore((s) => s.reply);
  const clearError = useDiaryStore((s) => s.clearError);
  // Pull config + agents so the "Generate now" button respects the
  // user's configured schedule + shows a picker for explicit choice.
  const config = useDiaryStore((s) => s.config);
  const agents = useDiaryStore((s) => s.agents);
  const loadAgents = useDiaryStore((s) => s.loadAgents);
  const loadConfig = useDiaryStore((s) => s.loadConfig);


  const [toast, setToast] = useState<ToastMessage | null>(null);
  // Which agent should "Generate now" use? Defaults to the daily
  // schedule's agent (or first available, or hardcoded fallback).
  const [pickedAgentId, setPickedAgentId] = useState<string | null>(null);

  // Mirror store toast signals into the local <Toast> component.
  useEffect(() => {
    if (!toastSignal) return;
    setToast({ id: toastSignal.id, text: toastSignal.text, kind: toastSignal.kind });
    consumeToast();
  }, [toastSignal, consumeToast]);

  // Refresh on mount in case AppBridge hasn't run yet.
  useEffect(() => {
    void loadEntries();
    void loadAgents();
    void loadConfig();
  }, [loadEntries, loadAgents, loadConfig]);


  // Initialise the agent picker once config + agents are loaded.
  // Priority: schedule.daily.agent_id > first user-defined agent > null
  // (which means "let backend pick its hardcoded fallback").
  useEffect(() => {
    if (pickedAgentId !== null) return;
    const fromSchedule = config?.schedule?.daily?.agent_id;
    if (fromSchedule && agents.some((a) => a.id === fromSchedule)) {
      setPickedAgentId(fromSchedule);
      return;
    }
    if (agents.length > 0) {
      setPickedAgentId(agents[0].id);
    }
  }, [config, agents, pickedAgentId]);

  const handleReply = async (entry: DiaryEntry) => {
    const res = await reply(entry.id);
    if (!res) return;
    const handoff: DiaryHandoff = {
      entry_id: res.entry_id,
      cwd: res.cwd,
      additional_system_prompt: res.additional_system_prompt,
      entry_title: entry.title,
      entry_body: entry.body,
      entry_created_at: entry.created_at,
      entry_agent_id: entry.agent_id,
      entry_model: entry.model,
    };
    try {
      sessionStorage.setItem(
        DIARY_HANDOFF_PREFIX + entry.id,
        JSON.stringify(handoff),
      );
    } catch {
      /* private mode / quota — chat will still work, just no card */
    }
    if (!entry.read) void markRead(entry.id);
    // No session id yet — chat handler assigns one on first send. The
    // sidebar will then surface the new chat under the diary-replies
    // project group automatically.
    navigate(`/chat?from=diary&entryId=${encodeURIComponent(entry.id)}`);
  };

  const handleSettings = () => navigate('/settings?tab=diary');

  const inFlightAgent = useMemo(() => inFlight?.agentId, [inFlight]);

  return (
    <div className="flex min-h-screen flex-col bg-window-bg text-text-primary">
      <Header />
      <Toast message={toast} onDismiss={() => setToast(null)} />

      <main className="mx-auto flex w-full max-w-[1680px] flex-1 flex-col gap-4 overflow-y-auto px-6 py-6">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold flex items-center gap-2">
              📓 {t.diary.page.heading}
            </h1>
            <p className="text-xs text-text-muted">{t.diary.page.tagline}</p>
          </div>
          <div className="flex items-center gap-2">
            {/* Agent picker — drives which agent "Generate now" fires.
                Without this, the backend defaults to the hardcoded
                `diary_observer` fallback even when the user has
                configured another agent for the daily cron. */}
            {agents.length > 0 && (
              <select
                value={pickedAgentId ?? ''}
                onChange={(e) => setPickedAgentId(e.target.value || null)}
                disabled={generating}
                title={t.diary.page.agentPickerTitle}
                className="rounded-lg border border-card-border bg-window-bg px-2 py-2 text-xs text-text-secondary"
              >
                {agents.map(({ id, agent }) => (
                  <option key={id} value={id}>
                    {agent.name} · {agent.model}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              onClick={handleSettings}
              className="rounded-lg border border-card-border px-3 py-2 text-xs text-text-secondary hover:bg-card-border/40"
            >
              {t.diary.page.settings}
            </button>
            {activeResearchPatient ? (
              <span className="rounded-lg border border-accent/30 bg-accent/10 px-4 py-2 text-sm font-medium text-accent">
                A/B/C reports loaded
              </span>
            ) : generating ? (
              <button
                type="button"
                onClick={() => void abortGenerating()}
                className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-300 hover:bg-red-500/20"
                title={t.diary.page.cancelTitle}
              >
                {t.diary.page.cancel}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void triggerNow(pickedAgentId ?? undefined)}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90"
              >
                {t.diary.page.generateNow}
              </button>
            )}
          </div>
        </div>

        <section className="space-y-3" aria-labelledby="patient-report-list-title">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="patient-report-list-title" className="text-sm font-semibold text-text-primary">Patient evaluation reports</h2>
              <p className="mt-0.5 text-xs text-text-muted">
                All frozen research cases; the active research patient is pinned to the top — regular demo patients do not generate research reports
              </p>
            </div>
            <span className="text-[11px] text-text-muted">{reportPatientRows.length} patients</span>
          </div>
          {reportPatientRows.map(({ patient, studyCase }) => (
            <PatientReportAccordion
              key={`${patient.id}-${studyCase.caseId}`}
              patient={patient}
              studyCase={studyCase}
              conditions={doctorEvaluationMockStudy.conditions}
            />
          ))}
        </section>

        {error && (
          <div
            role="alert"
            className="flex items-start justify-between gap-3 rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300"
          >
            <span className="whitespace-pre-wrap">{error}</span>
            <button
              type="button"
              onClick={clearError}
              className="rounded border border-red-400/40 px-2 text-xs"
            >
              {t.diary.page.dismiss}
            </button>
          </div>
        )}

        {!activeResearchPatient && inFlight && inFlight.partial && (
          <article className="rounded-lg border border-accent/40 bg-accent/5 p-4 text-sm text-text-primary">
            <header className="mb-2 text-xs text-text-muted">
              ✨ {inFlightAgent} {t.diary.page.writing}
            </header>
            <MessageMarkdown content={inFlight.partial} variant="assistant" />
          </article>
        )}

        {!activeResearchPatient && (
          loading && entries.length === 0 ? (
            <div className="rounded border border-dashed border-card-border p-8 text-center text-sm text-text-muted">
              {t.diary.page.loading}
            </div>
          ) : entries.length === 0 ? (
            <div className="rounded border border-dashed border-card-border p-8 text-center text-sm text-text-muted">
              <p className="mb-2 text-base text-text-secondary">{t.diary.page.emptyTitle}</p>
              <p>
                {t.diary.page.emptyBefore}
                <strong>{t.diary.page.emptyAction}</strong>
                {t.diary.page.emptyAfter}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {entries.map((entry) => (
                <EntryCard
                  key={entry.id}
                  entry={entry}
                  onReply={handleReply}
                  onMarkRead={(item) => void markRead(item.id)}
                  onDelete={can('diary.delete') ? (item) => {
                    if (!window.confirm(t.diary.page.confirmDelete(item.title))) return;
                    void deleteEntry(item.id);
                  } : undefined}
                />
              ))}
            </div>
          )
        )}
      </main>
    </div>
  );
}

