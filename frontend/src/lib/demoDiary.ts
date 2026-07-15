/**
 * Demo diary entries — surfaced on the Diary page when the user is
 * in VITE_DEMO_MODE. Narratively continues the call demo: the AI
 * promises in T5 "I've logged today's three highlights to the diary",
 * and this is that entry. A user running the call demo then opening
 * Diary should see the continuation rather than an empty timeline.
 *
 * Two parallel versions (EN + ZH) so the Diary page matches the
 * active UI language. CallPage picks scripts the same way (via
 * `getDemoConversation(lang)`).
 *
 * Demo entries live entirely client-side — they're prepended to the
 * real entries returned by `/api/diary/entries` inside diaryStore's
 * `loadEntries`. They never persist, never round-trip the backend,
 * and never collide with real entries (their ids are namespaced
 * `demo-...`).
 *
 * Why client-side instead of seeding `backend/data/diary/diary_entries.json`:
 *   - Demo mode is a frontend concept (VITE_DEMO_MODE).
 *   - Seeding the backend file would leak into non-demo runs.
 *   - Client-side prepend is reversible (delete files / restart).
 */

import type { DiaryEntry } from '../api/diaryApi';

// Locked to today's date in the system clock so the entry's
// timestamp matches "just now" for whoever runs the demo, rather
// than being permanently dated 2026-05-08. The Diary page sorts
// newest-first by created_at; this lands at the top of the list.
function todayAtIso(hour: number, minute: number): string {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

// Shared metadata between the EN + ZH variants. Only `title` and
// `body` differ across languages.
function baseEntry(): Omit<DiaryEntry, 'title' | 'body'> {
  return {
    id: 'demo-today-checkin',
    type: 'observation',
    created_at: todayAtIso(21, 5),
    trigger: 'manual',
    agent_id: 'diary_observer',
    model: 'claude-haiku-4-5',
    context_refs: {
      // Recording timestamps in the same `YYYYMMDD_HHMMSS` shape the
      // FastAPI side uses (see `backend/recordings/csv/`).
      recordings: [
        '20260508_153000', // afternoon load peak window
        '20260508_191500', // evening voice session
        '20260507_103000', // Tuesday family call
      ],
    },
    read: false,
    duration_ms: 3200,
    cost_usd: 0.0021,
    tokens: { input: 820, output: 245 },
  };
}

export const DEMO_DIARY_ENTRY_EN: DiaryEntry = {
  ...baseEntry(),
  title: "Today's check-in",
  body:
    'Three things stood out today.\n\n' +
    "**Load peak (16:00)** — HR ran ~12% above last week's average " +
    "between 3 and 5 PM. GSR didn't return to baseline. The window " +
    'aligns with a family video call; reads as emotional load, not ' +
    'physical fatigue.\n\n' +
    '**Repeated phrase from mom** — Across 7 saved recordings this ' +
    'week, *"pension"* came up 9 times on her side, clustered ' +
    'Tuesday and Wednesday. Logged as a trend marker; pull up if ' +
    'you want to share with a clinician.\n\n' +
    '> Reminder: this is observation, not diagnosis.\n\n' +
    "**Rest suggestion** — Tonight's recording is set to end 30 " +
    'minutes earlier; curious whether pre-sleep HRV recovers ' +
    'faster.\n\n' +
    "— *Auto-generated from today's voice session.*",
};

export const DEMO_DIARY_ENTRY_ZH: DiaryEntry = {
  ...baseEntry(),
  title: '今日观察',
  body:
    '今天有三件事值得记一下。\n\n' +
    '**负荷峰值（16:00）** — 下午 3 点到 5 点心率比上周平均高 ~12%，' +
    'GSR 也没回到基线。这一段时间正好和家庭视频通话重合，看起来是情绪/' +
    '认知负荷，不是体力疲劳。\n\n' +
    '**家人那边的重复语** — 翻了本周保留的 7 段通话录音，' +
    '"退休金" 在她那一侧重复了 9 次，集中在周二、周三。' +
    '我把它作为趋势项放进观察了，需要给医生看的话可以直接调出来。\n\n' +
    '> 提醒：这是观察，不是诊断。\n\n' +
    '**休息建议** — 今晚的录音设成提前 30 分钟收，想看看睡前 HRV ' +
    '的恢复会不会更快。\n\n' +
    '— *基于今天的语音会话自动生成。*',
};

/** Pick the demo entry matching the active UI language. */
export function getDemoDiaryEntries(lang: 'en' | 'zh'): DiaryEntry[] {
  return [lang === 'zh' ? DEMO_DIARY_ENTRY_ZH : DEMO_DIARY_ENTRY_EN];
}
