import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Header } from '../../components/layout/Header';
import { useAuth } from '../../contexts/RoleContext';
import { useLang } from '../../contexts/LanguageContext';

import { setActivePatient, useActivePatient } from '../../lib/activePatient';
import { doctorEvaluationMockStudy } from './mockStudy';
import { studyCaseForPatientId, studyCaseIndexForId } from './patientCase';
import { researchPatientForCase } from './researchPatients';
import type {
  CaseRatingAnswers,
  ConditionId,
  DoctorEvaluationResponse,
  DoctorEvaluationStudyBundle,
  StudyMode,
} from './types';
import { CompactDoctorAgent } from './components/CompactDoctorAgent';
import {
  ComparativeMetricsForm,
  type EvaluationAnswers,
} from './components/ComparativeMetricsForm';
import { ConditionCardDeck } from './components/ConditionCardDeck';
import { EvidencePanel } from './components/EvidencePanel';
import { OverallEvaluationForm } from './components/OverallEvaluationForm';
import {
  emptyOverallDraft,
  overallResponseFromDraft,
  type OverallEvaluationDraft,
  type ScalarAnswer,
} from './domain/evaluationExport';
interface EvaluationSession {
  responseId: string;
  startedAt: string;
  answers: Record<string, EvaluationAnswers>;
  submitted: Record<string, boolean>;
  chatPrompts: Record<string, string[]>;
  chatStartedAt: Record<string, string>;
  chatEndedAt: Record<string, string>;
  caseOpenedAt: Record<string, string>;
  phaseOpenedAt: Record<string, string>;
  caseSubmittedAt: Record<string, string>;
  overall: OverallEvaluationDraft;
}

const STORAGE_KEY = 'advoice.doctor-evaluation.fused.v3';

const initialSession = (): EvaluationSession => ({
  responseId: `doctor-eval-${Date.now().toString(36)}`,
  startedAt: new Date().toISOString(),
  answers: {},
  submitted: {},
  chatPrompts: {},
  chatStartedAt: {},
  chatEndedAt: {},
  caseOpenedAt: {},
  phaseOpenedAt: {},
  caseSubmittedAt: {},
  overall: emptyOverallDraft(),
});

function loadSession(): EvaluationSession {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialSession();
    const parsed = JSON.parse(raw) as Partial<EvaluationSession>;
    return {
      ...initialSession(),
      ...parsed,
      caseOpenedAt: { ...(parsed.caseOpenedAt ?? {}) },
      phaseOpenedAt: { ...(parsed.phaseOpenedAt ?? {}) },
      caseSubmittedAt: { ...(parsed.caseSubmittedAt ?? {}) },
      overall: { ...emptyOverallDraft(), ...(parsed.overall ?? {}) },
    };
  } catch {
    return initialSession();
  }
}

function ratingKey(caseId: string, conditionId: ConditionId) {
  return `case.${caseId}.${conditionId}`;
}

function comparisonKey(caseId: string) {
  return `case.${caseId}.comparison`;
}

function toCaseRating(answers: EvaluationAnswers): CaseRatingAnswers {
  return answers as CaseRatingAnswers;
}

function elapsedMs(openedAt?: string, submittedAt?: string): number | undefined {
  if (!openedAt || !submittedAt) return undefined;
  const elapsed = Date.parse(submittedAt) - Date.parse(openedAt);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : undefined;
}

function toResponse(
  session: EvaluationSession,
  mode: StudyMode,
  bundle: DoctorEvaluationStudyBundle,
  participantCode: string,
  locale: string,
  exportedAt: string,
): DoctorEvaluationResponse {
  const requiredCaseFields = bundle.forms.caseRatingFields.filter((field) => field.required);
  const submittedCases = Object.fromEntries(
    bundle.cases.map((studyCase) => {
      const ratingsComplete = studyCase.conditionOrder.every((conditionId) => {
        const rating = session.answers[ratingKey(studyCase.caseId, conditionId)] ?? {};
        return requiredCaseFields.every((field) => rating[field.id] !== undefined && rating[field.id] !== '');
      });
      return [studyCase.caseId, Boolean(session.submitted[comparisonKey(studyCase.caseId)]) && ratingsComplete];
    }),
  ) as Record<string, boolean>;
  const allCasesSubmitted = bundle.cases.every((studyCase) => submittedCases[studyCase.caseId]);
  const overall = overallResponseFromDraft(session.overall, bundle.forms);
  const requiredOverallComplete = bundle.forms.overallFields
    .filter((field) => field.required)
    .every((field) => session.overall.answers[field.id] !== undefined && session.overall.answers[field.id] !== '');
  const overallComplete =
    requiredOverallComplete &&
    overall.susAnswers.length === 10 &&
    overall.clinicalEvidenceSafetyAnswers.length === 6;
  const sessionSubmitted = allCasesSubmitted && session.overall.submitted && overallComplete;

  return {
    schemaVersion: '1.1.0',
    studyId: bundle.study.id,
    responseId: session.responseId,
    status: sessionSubmitted ? 'submitted' : 'draft',
    participant: {
      participantCode,
      languages: [locale],
    },
    session: {
      locale,
      startedAt: session.startedAt,
      completedAt: sessionSubmitted ? session.overall.submittedAt : undefined,
      exportedAt,
      initialMode: mode,
    },
    reveal: mode === 'researcher' ? { methodsRevealedAt: new Date().toISOString() } : {},
    caseResponses: bundle.cases.map((studyCase) => {
      const submitted = submittedCases[studyCase.caseId];
      const openedAt = session.caseOpenedAt[studyCase.caseId];
      const submittedAt = submitted ? session.caseSubmittedAt[studyCase.caseId] : undefined;
      return {
        caseId: studyCase.caseId,
        status: submitted ? ('submitted' as const) : ('draft' as const),
        openedAt,
        submittedAt,
        durationMs: elapsedMs(openedAt, submittedAt),
        phases: studyCase.conditionOrder.map((conditionId, index) => {
          const key = ratingKey(studyCase.caseId, conditionId);
          const prompts = session.chatPrompts[key] ?? [];
          const phaseOpenedAt = session.phaseOpenedAt[key];
          return {
            phaseId: conditionId,
            conditionId,
            presentationOrder: index + 1,
            status: submitted ? ('submitted' as const) : ('draft' as const),
            openedAt: phaseOpenedAt,
            submittedAt,
            durationMs: elapsedMs(phaseOpenedAt, submittedAt),
            rating: toCaseRating(session.answers[key] ?? {}),
            reportChat:
              conditionId === 'ours'
                ? {
                    used: prompts.length > 0,
                    questionCount: prompts.length,
                    promptIds: prompts,
                    startedAt: session.chatStartedAt[key],
                    endedAt: session.chatEndedAt[key],
                  }
                : undefined,
          };
        }),
      };
    }),
    overall: {
      ...overall,
      openedAt: session.overall.openedAt,
      submittedAt: sessionSubmitted ? session.overall.submittedAt : undefined,
      durationMs: elapsedMs(
        session.overall.openedAt,
        sessionSubmitted ? session.overall.submittedAt : undefined,
      ),
    },
  };
}

function downloadJson(value: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export interface DoctorEvaluationPageProps {
  studyBundle?: DoctorEvaluationStudyBundle;
}

export default function DoctorEvaluationPage({
  studyBundle = doctorEvaluationMockStudy,
}: DoctorEvaluationPageProps) {
  const bundle = studyBundle;
  const { auth } = useAuth();
  const { lang } = useLang();
  const activePatient = useActivePatient();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const requestedCaseIndex = studyCaseIndexForId(searchParams.get('caseId'), bundle);
  const activeStudyCase = activePatient
    ? studyCaseForPatientId(activePatient.id, bundle)
    : null;
  const patientCaseIndex = activeStudyCase
    ? studyCaseIndexForId(activeStudyCase.caseId, bundle)
    : null;
  const initialCaseIndex = requestedCaseIndex ?? patientCaseIndex ?? 0;
  const [caseIndex, setCaseIndex] = useState(initialCaseIndex);
  // This route is the doctor-facing blind evaluation surface. Research reveal
  // belongs to a separately authorised data workflow, not browser state here.
  const mode: StudyMode = 'blinded';
  const [session, setSession] = useState<EvaluationSession>(loadSession);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [audioUnavailable, setAudioUnavailable] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const evidencePanelRef = useRef<HTMLDivElement>(null);
  const currentCase = bundle.cases[caseIndex];
  const currentResearchPatient = researchPatientForCase(currentCase);
  const [activeCondition, setActiveCondition] = useState<ConditionId>(currentCase.conditionOrder[0]);

  // Explicit research-patient IDs may select a case. Ordinary platform/demo
  // patients never resolve to frozen fixtures.
  useEffect(() => {
    setCaseIndex(initialCaseIndex);
  }, [initialCaseIndex]);
  const orderedConditions = useMemo(
    () =>
      currentCase.conditionOrder.map((conditionId) => ({
        definition: bundle.conditions.find((condition) => condition.id === conditionId)!,
        output: currentCase.methodOutputs.find((output) => output.conditionId === conditionId)!,
      })),
    [bundle.conditions, currentCase],
  );
  const oursOutput = currentCase.methodOutputs.find((output) => output.conditionId === 'ours');
  const caseSubmitted = Boolean(session.submitted[comparisonKey(currentCase.caseId)]);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  }, [session]);

  useEffect(() => {
    setActivePatient({ id: currentResearchPatient.id, name: currentResearchPatient.name });
    const initialCondition = currentCase.conditionOrder[0];
    const openedAt = new Date().toISOString();
    setSession((current) => {
      const caseOpenedAt = current.caseOpenedAt[currentCase.caseId] ?? openedAt;
      const phaseOpenedAt = { ...current.phaseOpenedAt };
      for (const conditionId of currentCase.conditionOrder) {
        const key = ratingKey(currentCase.caseId, conditionId);
        phaseOpenedAt[key] = phaseOpenedAt[key] ?? caseOpenedAt;
      }
      return {
        ...current,
        caseOpenedAt: {
          ...current.caseOpenedAt,
          [currentCase.caseId]: caseOpenedAt,
        },
        phaseOpenedAt,
      };
    });
    setActiveCondition(initialCondition);
    setEvidenceOpen(initialCondition === 'ours');
    setAudioUnavailable(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [currentCase]);

  const completedCases = bundle.cases.filter(
    (studyCase) => session.submitted[comparisonKey(studyCase.caseId)],
  ).length;
  const casesComplete = completedCases === bundle.cases.length;

  const answersFor = (conditionId: ConditionId) =>
    session.answers[ratingKey(currentCase.caseId, conditionId)] ?? {};

  const setAnswer = (conditionId: ConditionId, fieldId: string, value: string | number) => {
    const key = ratingKey(currentCase.caseId, conditionId);
    setSession((current) => ({
      ...current,
      answers: {
        ...current.answers,
        [key]: { ...(current.answers[key] ?? {}), [fieldId]: value },
      },
      submitted: { ...current.submitted, [comparisonKey(currentCase.caseId)]: false },
    }));
  };

  const submitComparison = () => {
    const submittedAt = new Date().toISOString();
    setSession((current) => ({
      ...current,
      submitted: { ...current.submitted, [comparisonKey(currentCase.caseId)]: true },
      caseSubmittedAt: {
        ...current.caseSubmittedAt,
        [currentCase.caseId]: submittedAt,
      },
    }));
  };

  const setOverallAnswer = (fieldId: string, value: ScalarAnswer) => {
    setSession((current) => ({
      ...current,
      overall: {
        ...current.overall,
        openedAt: current.overall.openedAt ?? new Date().toISOString(),
        answers: { ...current.overall.answers, [fieldId]: value },
        submitted: false,
      },
    }));
  };

  const setQuestionnaireAnswer = (
    questionnaireId: 'sus' | 'clinical_evidence_safety',
    itemId: string,
    value: number,
  ) => {
    setSession((current) => ({
      ...current,
      overall: {
        ...current.overall,
        openedAt: current.overall.openedAt ?? new Date().toISOString(),
        ...(questionnaireId === 'sus'
          ? { susAnswers: { ...current.overall.susAnswers, [itemId]: value } }
          : { clinicalAnswers: { ...current.overall.clinicalAnswers, [itemId]: value } }),
        submitted: false,
      },
    }));
  };

  const setClinicalComment = (value: string) => {
    setSession((current) => ({
      ...current,
      overall: {
        ...current.overall,
        openedAt: current.overall.openedAt ?? new Date().toISOString(),
        clinicalComment: value,
        submitted: false,
      },
    }));
  };

  const submitOverallAndExport = () => {
    const submittedAt =
      session.overall.submitted && session.overall.submittedAt
        ? session.overall.submittedAt
        : new Date().toISOString();
    const nextSession: EvaluationSession = {
      ...session,
      overall: {
        ...session.overall,
        openedAt: session.overall.openedAt ?? submittedAt,
        submittedAt,
        submitted: true,
      },
    };
    setSession(nextSession);
    const response = toResponse(
      nextSession,
      mode,
      bundle,
      auth.id,
      lang === 'zh' ? 'zh-CN' : 'en-GB',
      new Date().toISOString(),
    );
    downloadJson(response, `${response.responseId}.json`);
  };

  const trackQuestion = (promptId: string) => {
    const key = ratingKey(currentCase.caseId, 'ours');
    setSession((current) => ({
      ...current,
      chatPrompts: {
        ...current.chatPrompts,
        [key]: [...(current.chatPrompts[key] ?? []), promptId],
      },
      chatStartedAt: {
        ...current.chatStartedAt,
        [key]: current.chatStartedAt[key] ?? new Date().toISOString(),
      },
    }));
  };

  const trackChatSettled = () => {
    const key = ratingKey(currentCase.caseId, 'ours');
    setSession((current) => ({
      ...current,
      chatEndedAt: {
        ...current.chatEndedAt,
        [key]: new Date().toISOString(),
      },
    }));
  };

  const revealEvidence = () => {
    setEvidenceOpen(true);
    window.setTimeout(() => {
      evidencePanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 0);
  };

  const goToCase = (nextIndex: number) => {
    setCaseIndex(Math.max(0, Math.min(bundle.cases.length - 1, nextIndex)));
  };

  return (
    <div className="min-h-screen bg-window-bg text-text-primary">
      <Header />

      <div className="border-b border-card-border bg-card-bg px-4 py-3 md:px-6">
        <div className="mx-auto flex max-w-[1680px] flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent text-xs font-black text-white">AD</div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="font-semibold text-text-primary">Doctor Cognitive Screening Workbench</h1>
                <span className="rounded bg-card-hover px-2 py-0.5 text-[10px] font-semibold text-text-muted">Research evaluation mode</span>
              </div>
              <p className="truncate text-xs text-text-muted">
                {`Current research patient: ${currentResearchPatient.name} · ${currentResearchPatient.id}`}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 rounded-lg border border-card-border bg-window-bg px-2 py-1.5">
              <span className="text-[11px] text-text-muted">Case</span>
              <select
                value={caseIndex}
                onChange={(event) => goToCase(Number(event.target.value))}
                className="bg-transparent text-xs font-semibold text-text-primary outline-none"
              >
                {bundle.cases.map((studyCase, index) => (
                  <option key={studyCase.caseId} value={index}>Case {index + 1} · {studyCase.task}</option>
                ))}
              </select>
            </div>
            {currentResearchPatient && (
              <button
                type="button"
                onClick={() => navigate('/diary')}
                className="rounded-lg border border-accent px-3 py-2 text-xs font-semibold text-accent hover:bg-accent/10"
              >
                View patient Diary reports
              </button>
            )}
          </div>
        </div>
      </div>

      <main className="mx-auto max-w-[1680px] space-y-4 px-4 py-5 md:px-6">
        <section className="overflow-hidden rounded-xl border border-card-border bg-card-bg shadow-sm">
          <div className="grid gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_420px]">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
                <span>Study case {caseIndex + 1}/{bundle.cases.length}</span>
                <span>·</span><span>{currentCase.source.dataset}</span>
                <span>·</span><span>{currentCase.source.language}</span>
                {caseSubmitted && <span className="rounded bg-status-success/15 px-2 py-0.5 font-semibold text-status-success">Scored</span>}
              </div>
              <h2 className="mt-2 text-2xl font-semibold text-text-primary">{currentCase.task}</h2>
              <p className="mt-2 max-w-4xl text-sm leading-6 text-text-secondary">{currentCase.taskDescription}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <span className="rounded-full bg-card-hover px-3 py-1 text-xs text-text-muted">Protocol: {currentCase.source.protocol}</span>
                <span className="rounded-full bg-card-hover px-3 py-1 text-xs text-text-muted">Duration: {Math.round(currentCase.audio.durationSeconds)} s</span>
                <span className="rounded-full bg-card-hover px-3 py-1 text-xs text-text-muted">{currentCase.roleHandling.description}</span>
              </div>
            </div>

            <div className="min-w-0 rounded-lg border border-card-border bg-card-hover/60 p-3">
              <div className="mb-2 flex items-center justify-between text-xs">
                <span className="font-semibold text-text-secondary">Case audio</span>
                <span className="text-text-muted">Shared by results & evidence playback</span>
              </div>
              <audio
                key={currentCase.caseId}
                ref={audioRef}
                className="w-full max-w-full"
                controls
                preload="metadata"
                src={currentCase.audio.src}
                onError={() => setAudioUnavailable(true)}
              />
              {audioUnavailable && (
                <p className="mt-2 text-[11px] leading-5 text-status-warning">Study audio assets not migrated yet; the A/B/C results, agent chat, and rating flow remain available.</p>
              )}
            </div>
          </div>
          <div className="h-1 bg-card-hover">
            <div className="h-full bg-accent transition-all" style={{ width: `${(completedCases / bundle.cases.length) * 100}%` }} />
          </div>
        </section>

        <div className="min-w-0 space-y-4">
          <section>
            <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-accent">Clinical results</p>
                <h2 className="mt-1 text-lg font-semibold text-text-primary">A/B/C result card deck</h2>
              </div>
              <p className="text-xs text-text-muted">Switch between results · body reuses the platform Diary component</p>
            </div>
            <ConditionCardDeck
              key={currentCase.caseId}
              items={orderedConditions}
              mode={mode}
              evidenceOpen={evidenceOpen}
              onToggleEvidence={revealEvidence}
              evidenceActionLabel="View clinical states & evidence trace"
              onActiveConditionChange={(conditionId) => {
                setActiveCondition(conditionId);
                setEvidenceOpen(conditionId === 'ours');
              }}
            />
          </section>

          {activeCondition === 'ours' && (
            <div className="space-y-4">
              <CompactDoctorAgent
                key={currentCase.caseId}
                studyCase={currentCase}
                onQuestionAsked={trackQuestion}
                onResponseSettled={trackChatSettled}
              />

              {evidenceOpen && oursOutput?.evidence && (
                <div ref={evidencePanelRef} className="scroll-mt-6">
                  <EvidencePanel evidence={oursOutput.evidence} audioRef={audioRef} />
                </div>
              )}
            </div>
          )}
        </div>

        <ComparativeMetricsForm
          key={currentCase.caseId}
          caseId={currentCase.caseId}
          conditions={bundle.conditions}
          conditionOrder={currentCase.conditionOrder}
          mode={mode}
          fields={bundle.forms.caseRatingFields}
          answersByCondition={Object.fromEntries(
            currentCase.conditionOrder.map((conditionId) => [conditionId, answersFor(conditionId)]),
          ) as Record<ConditionId, EvaluationAnswers>}
          submitted={caseSubmitted}
          onAnswer={setAnswer}
          onSubmit={submitComparison}
        />

        <OverallEvaluationForm
          forms={bundle.forms}
          draft={session.overall}
          casesComplete={casesComplete}
          onAnswer={setOverallAnswer}
          onQuestionnaireAnswer={setQuestionnaireAnswer}
          onClinicalComment={setClinicalComment}
          onSubmit={submitOverallAndExport}
        />
        <div className="flex flex-wrap items-center justify-between gap-3 pb-6">
          <button
            type="button"
            onClick={() => goToCase(caseIndex - 1)}
            disabled={caseIndex === 0}
            className="rounded-lg border border-card-border bg-card-bg px-4 py-2.5 text-sm font-semibold text-text-secondary disabled:opacity-40"
          >
            ← Previous case
          </button>
          <p className="text-xs text-text-muted">{completedCases}/{bundle.cases.length} cases completed</p>
          {caseIndex < bundle.cases.length - 1 ? (
            <button
              type="button"
              onClick={() => goToCase(caseIndex + 1)}
              className="rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent-hover"
            >
              Next case →
            </button>
          ) : (
            <button
              type="button"
              onClick={() => document.getElementById('overall-evaluation')?.scrollIntoView({ behavior: 'smooth' })}
              className="rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent-hover"
            >
              Overall evaluation ↓
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
