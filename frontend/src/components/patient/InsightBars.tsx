// InsightBars — "right now" condition bars derived from live sensors.
//
// Honesty: labelled 实时·此刻 / Right now, NOT "today's average" — the
// pipeline has no daily aggregation. Heart rate is a real value; the
// activity bar is derived accelerometer volatility shown qualitatively
// (resting/light/active), never claimed as a calibrated goal percentage.

import { useLang } from '../../contexts/LanguageContext';
import type { PatientInsights } from '../../hooks/usePatientInsights';

const TEXT = {
  zh: {
    title: '此刻状态',
    live: '实时',
    demo: '演示',
    hr: '心率', activity: '活动', ambient: '环境', voice: '说话声音',
    hrNormal: '正常', hrHigh: '偏快', hrLow: '偏慢',
    resting: '静息', light: '轻度活动', active: '活跃',
    temp: '温度', humidity: '湿度',
    noData: '连接设备后，这里会显示你此刻的身体数据',
    quiet: '安静', speaking: '说话中',
  },
  en: {
    title: 'Right now',
    live: 'live',
    demo: 'demo',
    hr: 'Heart rate', activity: 'Activity', ambient: 'Ambient', voice: 'Voice',
    hrNormal: 'normal', hrHigh: 'fast', hrLow: 'slow',
    resting: 'resting', light: 'light', active: 'active',
    temp: 'Temp', humidity: 'Humidity',
    noData: 'Connect your device to see your live readings here',
    quiet: 'quiet', speaking: 'speaking',
  },
};

// A single labelled bar. `tone` picks a theme-safe colour.
function Bar({
  label, valueText, fill, tone = 'accent',
}: {
  label: string; valueText: string; fill: number; tone?: 'accent' | 'warn' | 'sage';
}) {
  const toneClass =
    tone === 'warn' ? 'bg-status-disconnected'
    : tone === 'sage' ? 'bg-accent-soft'
    : 'bg-accent';
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[12.5px] text-text-secondary">{label}</span>
        <span className="text-[12.5px] font-medium text-text-primary">{valueText}</span>
      </div>
      <div className="h-2 rounded-full bg-card-hover overflow-hidden">
        <div
          className={`h-full rounded-full ${toneClass} transition-all duration-500`}
          style={{ width: `${Math.min(100, Math.max(4, fill * 100))}%` }}
        />
      </div>
    </div>
  );
}

export function InsightBars({ insights }: { insights: PatientInsights }) {
  const { lang } = useLang();
  const t = TEXT[lang];
  const { heartRate, heartRateBand, activity, ambient, voiceLevel, hasData } = insights;

  return (
    <div className="bg-card-bg border border-card-border rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-text-primary">{t.title}</h3>
        <span className="text-[10px] font-medium text-accent bg-accent/10 rounded-full px-2 py-0.5 uppercase tracking-wide">
          ● {insights.isDemo ? t.demo : t.live}
        </span>
      </div>

      {!hasData ? (
        <p className="text-[12.5px] text-text-muted py-4 text-center">{t.noData}</p>
      ) : (
        <div className="flex flex-col gap-3.5">
          {heartRate !== null && (
            <Bar
              label={`❤️ ${t.hr}`}
              valueText={`${heartRate} bpm · ${
                heartRateBand === 'high' ? t.hrHigh : heartRateBand === 'low' ? t.hrLow : t.hrNormal
              }`}
              // Map 50–110 bpm onto the bar; colour warns outside 55–100.
              fill={(heartRate - 50) / 60}
              tone={heartRateBand === 'normal' ? 'accent' : 'warn'}
            />
          )}
          {activity && (
            <Bar
              label={`🏃 ${t.activity}`}
              valueText={
                activity.level === 'active' ? t.active
                : activity.level === 'light' ? t.light : t.resting
              }
              fill={activity.score / 100}
              tone="sage"
            />
          )}
          {ambient && (ambient.temp !== null || ambient.humidity !== null) && (
            <div className="flex gap-4 pt-0.5">
              {ambient.temp !== null && (
                <div className="text-[12.5px] text-text-secondary">
                  🌡️ {t.temp} <span className="font-medium text-text-primary">{ambient.temp}°C</span>
                </div>
              )}
              {ambient.humidity !== null && (
                <div className="text-[12.5px] text-text-secondary">
                  💧 {t.humidity} <span className="font-medium text-text-primary">{ambient.humidity}%</span>
                </div>
              )}
            </div>
          )}
          <Bar
            label={`🎙️ ${t.voice}`}
            valueText={voiceLevel > 0.15 ? t.speaking : t.quiet}
            fill={voiceLevel}
            tone="accent"
          />
        </div>
      )}
    </div>
  );
}
