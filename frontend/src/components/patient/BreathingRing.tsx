// BreathingRing — the /dashboard waveform wall "reduced to one calming
// symbol". A slow expand/contract ring the patient can breathe along
// with (guide value, independent of live data), with the real-time
// heart rate shown at its centre.
//
// Honesty: the ring animation is a fixed ~8 s calm-breathing GUIDE, not
// a readout of the patient's actual respiratory rate (the pipeline
// doesn't extract one). The centre number IS a real channel value (HR).

import { useLang } from '../../contexts/LanguageContext';

const TEXT = {
  zh: { bpm: 'bpm', hr: '心率', guide: '跟着圆环 · 慢慢吸气、呼气', waiting: '连接后显示' },
  en: { bpm: 'bpm', hr: 'Heart rate', guide: 'Breathe with the ring — in… out…', waiting: 'shown once connected' },
};

export function BreathingRing({ bpm }: { bpm: number | null }) {
  const { lang } = useLang();
  const t = TEXT[lang];

  return (
    <div className="flex flex-col items-center py-4">
      {/* Scoped keyframes — one instance on the page, unique names. */}
      <style>{`
        @keyframes patientBreathe {
          0%, 100% { transform: scale(0.86); }
          50%      { transform: scale(1.08); }
        }
        @keyframes patientBreatheInner {
          0%, 100% { transform: scale(1.06); opacity: .55; }
          50%      { transform: scale(0.9);  opacity: .9; }
        }
      `}</style>

      <div className="relative flex items-center justify-center" style={{ width: 168, height: 168 }}>
        <div
          className="absolute rounded-full border-[3px] border-accent"
          style={{
            width: 168,
            height: 168,
            boxShadow: '0 0 28px rgb(var(--color-accent) / 0.22) inset',
            animation: 'patientBreathe 8s ease-in-out infinite',
          }}
        />
        <div
          className="absolute rounded-full border border-accent-soft"
          style={{
            width: 120,
            height: 120,
            animation: 'patientBreatheInner 8s ease-in-out infinite',
          }}
        />
        <div className="relative z-[1] text-center">
          {bpm === null ? (
            <div className="text-3xl font-bold text-text-muted">—</div>
          ) : (
            <>
              <div className="text-4xl font-bold leading-none text-accent">{bpm}</div>
              <div className="text-[11px] text-text-muted mt-1">{t.bpm} · {t.hr}</div>
            </>
          )}
        </div>
      </div>

      <div className="text-[13px] text-text-secondary mt-3">{bpm === null ? t.waiting : t.guide}</div>
    </div>
  );
}
