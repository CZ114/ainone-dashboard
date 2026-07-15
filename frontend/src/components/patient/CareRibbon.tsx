// CareRibbon — the patient's "care in progress" narrative. Same workflow
// run a doctor watches as a triage→diagnose→verify flowchart, re-told for
// the patient as gentle sentences ("getting to know how you've been…").
//
// Data source: GET /api/agent/care-ribbon returns the patient-labelled
// steps of workflow runs whose patient_id == this patient (runs a doctor
// started *for them*). The engine carries step labels.patient (lib
// workflow.py); the backend projects them into {label, status} here.
//
// Demo mode: with no real run, synthesises a looping 3-step ribbon so the
// patient still sees the "someone is caring for me" surface. When there's
// neither real nor demo data, renders nothing (no empty box).

import { useEffect, useState } from 'react';
import { useLang } from '../../contexts/LanguageContext';
import { isDemoMode } from '../../lib/demoMode';

type StepStatus = 'done' | 'active' | 'pending';
interface RibbonStep {
  label: string;
  status: StepStatus;
}
interface RibbonState {
  running: boolean;
  steps: RibbonStep[];
}

const DEMO_STEPS = {
  zh: ['正在了解你最近的情况…', '正在对照医生留下的资料…', '医生会亲自确认一遍结果'],
  en: [
    'Getting to know how you’ve been…',
    'Checking against your doctor’s notes…',
    'Your doctor will confirm the results',
  ],
};

const TITLE = { zh: '照护进行中', en: 'Care in progress' };

function useCareRibbon(): RibbonState {
  const { lang } = useLang();
  const [state, setState] = useState<RibbonState>({ running: false, steps: [] });
  const [demoTick, setDemoTick] = useState(0);
  const demo = isDemoMode();

  useEffect(() => {
    if (demo) {
      const id = setInterval(() => setDemoTick((t) => t + 1), 1600);
      return () => clearInterval(id);
    }
    // Real mode: poll the care-ribbon endpoint (patient identity via the
    // X-Auth-Token fetch wrapper). Endpoint 404/empty → stays not-running.
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch('/api/agent/care-ribbon');
        if (r.ok && alive) setState((await r.json()) as RibbonState);
      } catch {
        /* backend down / endpoint absent — degrade to nothing */
      }
    };
    void poll();
    const id = setInterval(poll, 4000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [demo]);

  if (demo) {
    const labels = DEMO_STEPS[lang];
    // Sweep an "active" cursor across the steps (…→done→done→loop).
    const cursor = demoTick % (labels.length + 1);
    return {
      running: true,
      steps: labels.map((label, i) => ({
        label,
        status: i < cursor ? 'done' : i === cursor ? 'active' : 'pending',
      })),
    };
  }
  return state;
}

function Dot({ status }: { status: StepStatus }) {
  if (status === 'active') {
    return (
      <span className="relative flex items-center justify-center w-2 h-2 shrink-0">
        <span className="w-2 h-2 rounded-full bg-accent" />
        <span className="absolute w-2 h-2 rounded-full bg-accent animate-ping opacity-75" />
      </span>
    );
  }
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${
        status === 'done' ? 'bg-status-connected' : 'bg-card-hover'
      }`}
    />
  );
}

export function CareRibbon() {
  const { lang } = useLang();
  const { running, steps } = useCareRibbon();
  if (!running || steps.length === 0) return null;

  return (
    <div className="bg-card-bg border border-card-border rounded-xl p-4">
      <div className="text-[12px] text-text-secondary mb-2.5">🤍 {TITLE[lang]}</div>
      <div className="flex flex-col gap-2">
        {steps.map((s, i) => (
          <div
            key={i}
            className={`flex items-center gap-2 text-[13px] transition-colors ${
              s.status === 'pending' ? 'text-text-muted' : 'text-text-secondary'
            }`}
          >
            <Dot status={s.status} />
            <span>{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
