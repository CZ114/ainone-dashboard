// TodayPage — the patient's home. Same data as /dashboard and /diary,
// re-told as care: a breathing ring + right-now bars (sensor data
// reduced to something a patient reads at a glance), a letter-style
// latest diary entry, wearable status in plain words, and a big voice
// orb to talk. No waveforms, no agent/model metadata, no jargon.

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Header } from '../layout/Header';
import { MessageMarkdown } from '../chat/MessageMarkdown';
import { useAuth } from '../../contexts/RoleContext';
import { useLang } from '../../contexts/LanguageContext';
import { usePatientInsights } from '../../hooks/usePatientInsights';
import { useDiaryStore } from '../../store/diaryStore';
import { BreathingRing } from './BreathingRing';
import { InsightBars } from './InsightBars';
import { DeviceStatusCard } from './DeviceStatusCard';
import { CareRibbon } from './CareRibbon';

const TEXT = {
  zh: {
    greetMorning: '早上好', greetAfternoon: '下午好', greetEvening: '晚上好',
    obsStable: '你的身体状态很平稳，继续保持。',
    obsHigh: '你的心率有点快，先坐下来慢慢呼吸一会儿。',
    obsNoData: '戴上你的手套，我就能陪着你、看着你的状态。',
    letterFrom: '你的健康助手',
    today: '今天早上', yesterday: '昨天', noLetter: '今天还没有新的来信，晚些时候我会为你写一篇。',
    reply: '回复 →',
    orbHint: '想聊聊吗？轻点这里跟我说话',
  },
  en: {
    greetMorning: 'Good morning', greetAfternoon: 'Good afternoon', greetEvening: 'Good evening',
    obsStable: 'Your readings look steady — keep it up.',
    obsHigh: 'Your heart rate is a little fast; sit down and breathe slowly for a bit.',
    obsNoData: 'Put on your glove and I can keep you company and watch your readings.',
    letterFrom: 'Your health companion',
    today: 'this morning', yesterday: 'yesterday', noLetter: 'No new note yet today — I will write you one later.',
    reply: 'Reply →',
    orbHint: 'Want to talk? Tap here to speak with me',
  },
};

function greetingFor(hour: number, t: (typeof TEXT)['zh']): string {
  if (hour < 12) return t.greetMorning;
  if (hour < 18) return t.greetAfternoon;
  return t.greetEvening;
}

// created_at ISO → coarse relative label (patient never sees a timestamp).
function relativeDay(iso: string, t: (typeof TEXT)['zh']): string {
  const then = new Date(iso);
  const now = new Date();
  const sameDay = then.toDateString() === now.toDateString();
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (sameDay) return t.today;
  if (then.toDateString() === yest.toDateString()) return t.yesterday;
  return then.toLocaleDateString();
}

export default function TodayPage() {
  const navigate = useNavigate();
  const { auth } = useAuth();
  const { lang } = useLang();
  const t = TEXT[lang];
  const insights = usePatientInsights();
  const entries = useDiaryStore((s) => s.entries);
  const loadEntries = useDiaryStore((s) => s.loadEntries);

  useEffect(() => {
    void loadEntries();
  }, [loadEntries]);

  const latest = entries[0] ?? null;
  const hour = new Date().getHours();
  const observation = !insights.hasData
    ? t.obsNoData
    : insights.heartRateBand === 'high'
    ? t.obsHigh
    : t.obsStable;

  return (
    <div className="min-h-screen bg-window-bg">
      <Header />

      <style>{`
        @keyframes patientOrbPulse {
          0%, 100% { transform: scale(0.94); box-shadow: 0 0 34px rgb(var(--color-accent) / 0.30); }
          50%      { transform: scale(1.04); box-shadow: 0 0 52px rgb(var(--color-accent) / 0.45); }
        }
      `}</style>

      <main className="max-w-5xl mx-auto px-4 py-6">
        {/* Greeting */}
        <div className="mb-5">
          <h1 className="text-xl font-bold text-text-primary">
            {greetingFor(hour, t)}，{auth.name} 👋
          </h1>
          <p className="text-[13.5px] text-text-secondary mt-1">{observation}</p>
        </div>

        {/* Insight (left) + latest letter (right) */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex flex-col gap-4">
            <div className="bg-card-bg border border-card-border rounded-xl">
              <BreathingRing bpm={insights.heartRate} />
            </div>
            <InsightBars insights={insights} />
          </div>

          <div className="flex flex-col gap-4">
            {/* Letter-style latest diary entry */}
            <div className="bg-card-bg border-l-4 border-accent border-y border-r border-card-border rounded-xl p-4">
              {latest ? (
                <>
                  <div className="text-[11.5px] text-text-muted mb-2">
                    🌿 {t.letterFrom} · {relativeDay(latest.created_at, t)}
                    {!latest.read && (
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent ml-2 align-middle" />
                    )}
                  </div>
                  <div className="text-[13.5px] text-text-primary">
                    <MessageMarkdown content={latest.body} variant="assistant" />
                  </div>
                  <button
                    onClick={() => navigate('/chat')}
                    className="mt-3 text-[13px] text-accent hover:text-accent-hover font-medium"
                  >
                    {t.reply}
                  </button>
                </>
              ) : (
                <p className="text-[13px] text-text-muted py-4">{t.noLetter}</p>
              )}
            </div>

            {/* Care-in-progress ribbon — patient lens of a workflow run
                a doctor started for them (labels.patient narrative). */}
            <CareRibbon />

            {/* Wearable status in plain words */}
            <DeviceStatusCard device={insights.device} />
          </div>
        </div>

        {/* Voice orb CTA */}
        <div className="flex flex-col items-center mt-8">
          <button
            aria-label={t.orbHint}
            onClick={() => navigate('/call')}
            className="rounded-full"
            style={{
              width: 96,
              height: 96,
              background: 'radial-gradient(circle at 34% 30%, rgb(var(--color-accent-soft)), rgb(var(--color-accent)) 60%, rgb(var(--color-accent-hover)))',
              animation: 'patientOrbPulse 3.6s ease-in-out infinite',
            }}
          />
          <p className="text-[13px] text-text-secondary mt-4">{t.orbHint}</p>
        </div>
      </main>
    </div>
  );
}
