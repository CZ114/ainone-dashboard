/**
 * Demo conversation script — played on the /call page when the user
 * is in VITE_DEMO_MODE and clicks "Play demo". Bypasses mic capture,
 * Whisper, and the /api/voice-chat round-trip; the player just feeds
 * scripted turns into the same `turns` state + phase machine the live
 * path uses, so every visual component (orb morph, AssistantBubble,
 * convergeWords, ThinkingLoader) renders identically to a real call.
 *
 * Two parallel scripts — `DEMO_CONVERSATION_ZH` and
 * `DEMO_CONVERSATION_EN`. CallPage picks one based on the live UI
 * language via `useLang()` so the demo respects whatever the user
 * has selected from the LanguageToggle.
 *
 * Tone choices baked into the script (per product spec):
 *   - Each AI reply opens with a 📎 line listing the data files the
 *     answer is grounded in, rendered with markdown inline-code so
 *     they look like real artefacts. Reads as "this isn't stock
 *     phrasing — Claude actually pulled these files." The privacy-
 *     boundary turn intentionally has NO 📎 header (the AI explains
 *     it can't see anything) so the affordance stays meaningful.
 *   - AI cites concrete numbers (12%, 9 times, 7 recordings) so it
 *     reads as data-driven, not stock phrasing.
 *   - Three explicit boundary callouts ("not a medical issue",
 *     "I can't see her side", "observation, not diagnosis") keep the
 *     early-AD framing honest.
 *   - Final turn lands in the diary, surfacing the third product
 *     pillar (report generation) without belabouring it.
 *
 * Per-turn timings are tuned to feel paced for a watcher rather than
 * a participant — slightly faster than a real conversation, but not
 * so fast that the orb states blur into each other. Adjust here if
 * the demo lands too snappy / too slow.
 */

/** Specification for the inline line chart attached to a turn.
 *  Rendered below the AI bubble via <MiniLineChart>. */
export interface DemoChartSpec {
  caption?: string;
  data: number[];
  labels?: string[];
  unit?: string;
  baseline?: number;
  highlight?: number[];
}

export interface DemoTurn {
  user: string;
  ai: string;
  /** Files the AI claims to have consulted for this turn. Surfaced by
   *  the ReadingDataLoader during the 'thinking' phase, then echoed in
   *  the AI reply's 📎 header as durable citation. Empty/undefined for
   *  the boundary turn (where the AI explains it CAN'T see anything). */
  files?: string[];
  /** Optional inline line chart shown below the AI bubble. Used on
   *  turns where a trend visualisation says more than the prose. */
  chart?: DemoChartSpec;
  /** Pre-recorded audio for this turn's AI reply, served from
   *  `frontend/public/demo-audio/{lang}/`. CallPage plays this via an
   *  `<audio>` element when the assistant turn lands and awaits its
   *  `ended` event before kicking the next turn. Missing files are
   *  gracefully handled — `error` resolves the wait too, falling back
   *  to live TTS or char-time. See `frontend/public/demo-audio/README.md`
   *  for the recording workflow. */
  audioUrl?: string;
  /** Time the orb shows 'recording' before the user transcript lands. */
  recordMs: number;
  /** Time the orb shows 'transcribing' before the user bubble lands. */
  transcribeMs: number;
  /** Time spent in 'thinking' (ThinkingLoader visible) before AI reply. */
  thinkMs: number;
  /** Pause after the AI reply finishes before kicking the next turn. */
  postReplyPauseMs: number;
}

const T1_FILES = [
  'ppg_2026-05-08_15-17.csv',
  'gsr_2026-05-08_15-17.csv',
  'env_light_2026-05-08.csv',
];
const T2_FILES = [
  'hrv_trend_2026-04-24_to_05-08.csv',
  'family_call_log.json',
];
const T4_FILES = [
  'audio_calls_2026-05-01_to_05-07.json',
  'keyword_repetition_pension.csv',
];
const T5_FILES = ['diary/2026-05-08.md'];

// T1 chart — heart rate across the 15:00–17:00 window. Dashed
// baseline at 72 bpm = the user's last-week average. The bump
// around 16:00 is the "video call with mom" moment; the chart
// gives the watcher a visual receipt for the AI's "+12% above
// last week's average" claim. Data shape: 13 points × 10 min.
const T1_CHART: DemoChartSpec = {
  caption: 'Heart rate · 15:00–17:00',
  data: [68, 70, 71, 72, 75, 82, 90, 95, 92, 88, 80, 75, 70],
  labels: ['15:00', '', '', '', '16:00', '', '', '', '', '', '', '', '17:00'],
  unit: 'bpm',
  baseline: 72,
};

// T2 chart — 14-day HRV trend, with markers on days the user had
// a family video call. The dips on days 4, 9, 14 visually back
// the AI's "6–8% lower around family calls" line.
const T2_CHART: DemoChartSpec = {
  caption: 'HRV · last 14 days · ⬤ family calls',
  data: [68, 70, 72, 65, 64, 71, 70, 67, 63, 60, 70, 71, 65, 63],
  labels: ['1', '', '', '', '5', '', '', '', '', '10', '', '', '', '14'],
  unit: 'ms',
  highlight: [3, 8, 13],
};

export const DEMO_CONVERSATION_ZH: DemoTurn[] = [
  {
    user: '今天感觉脑子有点闷，能帮我看看是不是哪里不对？（EN: My head feels a bit foggy today — can you check if something\'s off?）',
    files: T1_FILES,
    chart: T1_CHART,
    audioUrl: '/demo-audio/zh/t1.mp3',
    ai:
      '📎 `ppg_2026-05-08_15-17.csv` · `gsr_2026-05-08_15-17.csv` · `env_light_2026-05-08.csv`\n\n' +
      '晚上好。看了今天的数据 — 你下午 3 点到 5 点的心率波动比上周平均高了 12%，' +
      'GSR 也一直没回到基线。环境光那段时间偏暗，应该在室内。' +
      '这种组合更像情绪/认知负荷，不是体力疲劳。那段时间你在做什么？\n\n' +
      '（EN: Your 3–5 PM heart rate ran ~12% above last week\'s average and GSR never ' +
      'settled back to baseline; ambient light was low, so likely indoors. That reads ' +
      'more like emotional/cognitive load than physical fatigue — what were you doing then?）',
    // ~800 ms per file × 3 files. ReadingDataLoader steps once per
    // file with equal share, and the third file stays ◇ until the
    // bubble lands — reads as "Claude is still on the last source".
    recordMs: 1200,
    transcribeMs: 450,
    thinkMs: 2400,
    postReplyPauseMs: 1200,
  },
  {
    user: '在跟我妈视频，她又把同一件事问了三遍。（EN: On a video call with my mom — she asked me the same thing three times again.）',
    files: T2_FILES,
    chart: T2_CHART,
    audioUrl: '/demo-audio/zh/t2.mp3',
    ai:
      '📎 `hrv_trend_2026-04-24_to_05-08.csv` · `family_call_log.json`\n\n' +
      '嗯，记下来了。最近 14 天里，你跟家里视频前后 HRV 平均会低 6–8%，恢复也变慢。' +
      '这不是医学问题，但身体确实有反应。今晚的录音要不要稍微早点收？' +
      '我先把你当下的状态写进观察。\n\n' +
      '（EN: Noted. Over the last 14 days your HRV averages 6–8% lower around family ' +
      'video calls, with slower recovery. Not a medical issue, but your body is reacting — ' +
      'want to end tonight\'s recording a little earlier? I\'ll log your current state as an observation.）',
    recordMs: 1000,
    transcribeMs: 400,
    // ~900 ms per file × 2.
    thinkMs: 1800,
    postReplyPauseMs: 1100,
  },
  {
    // No files here — this turn is about what the AI can NOT see.
    // The thinking phase falls back to the generic ThinkingLoader so
    // the boundary message lands without a contradictory "Reading…"
    // panel above it.
    user: '你这边能看到她那边的数据吗？（EN: Can you see anything from her side?）',
    audioUrl: '/demo-audio/zh/t3.mp3',
    ai:
      '看不到。我能看到的只有你这只智能手套、你这台机器上的录音、和你跟我说的内容。' +
      '如果你想追踪她的某些方面 — 比如重复某句话的频率 — 可以把跟她的通话录下来，' +
      '我从你这一侧去观察。\n\n' +
      '（EN: No — I can only see your smart glove, the recordings on this machine, and ' +
      'what you tell me. To track something on her side — say, how often she repeats a ' +
      'phrase — record your calls with her and I\'ll observe from your side of the line.）',
    recordMs: 900,
    transcribeMs: 380,
    thinkMs: 850,
    postReplyPauseMs: 800,
  },
  {
    user: '她最近一周问我退休金的事问了多少次？（EN: How many times has she asked me about her pension this past week?）',
    files: T4_FILES,
    audioUrl: '/demo-audio/zh/t4.mp3',
    ai:
      '📎 `audio_calls_2026-05-01_to_05-07.json` · `keyword_repetition_pension.csv`\n\n' +
      "翻了一下你保留的 7 段通话录音，「退休金」相关话题在她那一侧被重复提了 9 次：\n\n" +
      '| 日期 | 周一 | 周二 | 周三 | 周四 | 周五 | 周六 | 周日 |\n' +
      '|---|---|---|---|---|---|---|---|\n' +
      '| 提及次数 | 0 | 4 | 3 | 1 | 1 | 0 | 0 |\n\n' +
      '集中在周二、周三。我标了一条观察放进日记，你后面想拉给医生看可以直接调。' +
      '但记住 — 这是观察，不是诊断。\n\n' +
      '（EN: Across your 7 saved call recordings, "pension" came up 9 times on her side — ' +
      'clustered on Tue/Wed (table: mentions per weekday, Mon–Sun). Logged as a diary ' +
      'observation you can pull up for a clinician. Remember — observation, not diagnosis.）',
    recordMs: 1000,
    transcribeMs: 450,
    // ~900 ms per file × 2.
    thinkMs: 1800,
    // More dwell — the table needs a beat to read.
    postReplyPauseMs: 1500,
  },
  {
    user: '嗯，那今天就这样吧。（EN: OK — that\'s it for today.）',
    files: T5_FILES,
    audioUrl: '/demo-audio/zh/t5.mp3',
    ai:
      '📎 `diary/2026-05-08.md`\n\n' +
      '好。今天关键的三件事我已经写进日记：\n\n' +
      '| 项目 | 状态 |\n' +
      '|---|---|\n' +
      '| 负荷峰值 | 16:00 心率 +28% |\n' +
      '| 家人那边的重复语 | 「退休金」× 9 |\n' +
      '| 休息建议 | 今晚录音提前 30 分钟收 |\n\n' +
      '明早起床我会推一条简短摘要。晚安。\n\n' +
      '（EN: Done — today\'s three highlights are in the diary: load peak (16:00, HR +28%), ' +
      'repeated phrase from mom ("pension" × 9), and ending tonight\'s recording 30 min early. ' +
      'I\'ll push a short summary tomorrow morning. Sleep well.）',
    recordMs: 800,
    transcribeMs: 350,
    // Single file — ~1.1 s of "writing to diary" feels like a real
    // append-and-flush vs the previous 800 ms which read as instant.
    thinkMs: 1100,
    postReplyPauseMs: 0,
  },
];

export const DEMO_CONVERSATION_EN: DemoTurn[] = [
  {
    user: "My head feels a bit foggy today — can you check if something's off?",
    files: T1_FILES,
    chart: T1_CHART,
    // Flat layout — user dropped t1..t5.mp3 directly under
    // public/demo-audio/, not the nested en/ subdir the README
    // suggests. Single-language demos don't need the nesting; if ZH
    // audio gets added later, either flatten ZH too or move EN into
    // /demo-audio/en/ for symmetry.
    audioUrl: '/demo-audio/t1.mp3',
    ai:
      '📎 `ppg_2026-05-08_15-17.csv` · `gsr_2026-05-08_15-17.csv` · `env_light_2026-05-08.csv`\n\n' +
      "Evening. I looked at today's data — your heart rate between 3 and " +
      "5 PM ran about 12% above last week's average, and GSR never settled " +
      'back to baseline. Ambient light was low across that window, so you ' +
      'were probably indoors. That combination reads more like emotional ' +
      'or cognitive load than physical fatigue. What were you doing then?',
    // Timings stay close to the zh version — English is only marginally
    // faster to read aloud than Chinese for these lengths, and matching
    // pacing makes the bilingual demos feel like the same product.
    // ~800 ms per file × 3 = 2400 ms of read time.
    recordMs: 1200,
    transcribeMs: 450,
    thinkMs: 2400,
    postReplyPauseMs: 1200,
  },
  {
    user: 'On a video call with my mom — she asked me the same thing three times again.',
    files: T2_FILES,
    chart: T2_CHART,
    audioUrl: '/demo-audio/t2.mp3',
    ai:
      '📎 `hrv_trend_2026-04-24_to_05-08.csv` · `family_call_log.json`\n\n' +
      'Noted. Across the last 14 days, your HRV averages 6–8% lower around ' +
      'family video calls, and recovery has been slower too. Not a medical ' +
      "issue — but your body is reacting. Want to wrap up tonight's recording " +
      "a little earlier? I'll log your current state as an observation in " +
      'the meantime.',
    recordMs: 1000,
    transcribeMs: 400,
    // ~900 ms per file × 2.
    thinkMs: 1800,
    postReplyPauseMs: 1100,
  },
  {
    user: 'Can you see anything from her side?',
    audioUrl: '/demo-audio/t3.mp3',
    ai:
      'No. I can only see your smart glove, the recordings stored on this ' +
      'machine, and what you tell me directly. If you want to track ' +
      'something on her side — say, how often she repeats a phrase — record ' +
      "your calls with her and I'll observe from your side of the line.",
    recordMs: 900,
    transcribeMs: 380,
    thinkMs: 850,
    postReplyPauseMs: 800,
  },
  {
    user: 'How many times has she asked me about her pension this past week?',
    files: T4_FILES,
    audioUrl: '/demo-audio/t4.mp3',
    ai:
      '📎 `audio_calls_2026-05-01_to_05-07.json` · `keyword_repetition_pension.csv`\n\n' +
      'Went through the 7 saved call recordings — "pension"-related topics ' +
      'came up 9 times on her side:\n\n' +
      '| Day | Mon | Tue | Wed | Thu | Fri | Sat | Sun |\n' +
      '|---|---|---|---|---|---|---|---|\n' +
      '| Mentions | 0 | 4 | 3 | 1 | 1 | 0 | 0 |\n\n' +
      'Clustered on Tuesday and Wednesday. ' +
      "I've flagged it as an observation in the diary, ready to pull up if " +
      'you want to share with a clinician. Remember — this is observation, ' +
      'not diagnosis.',
    recordMs: 1000,
    transcribeMs: 450,
    // ~900 ms per file × 2.
    thinkMs: 1800,
    postReplyPauseMs: 1500,
  },
  {
    user: "OK — that's it for today.",
    files: T5_FILES,
    audioUrl: '/demo-audio/t5.mp3',
    ai:
      '📎 `diary/2026-05-08.md`\n\n' +
      "Done. Today's three highlights are now in the diary:\n\n" +
      '| Item | Status |\n' +
      '|---|---|\n' +
      '| Load peak | 16:00 · HR +28% |\n' +
      '| Repeated phrase (mom) | "pension" × 9 |\n' +
      "| Rest suggestion | End tonight's recording 30 min early |\n\n" +
      "I'll push a short summary when you wake up tomorrow. Sleep well.",
    recordMs: 800,
    transcribeMs: 350,
    thinkMs: 1100,
    postReplyPauseMs: 0,
  },
];

/** Pick the script matching the active UI language. CallPage calls
 *  this with `useLang().lang`. Falls back to zh on any unexpected
 *  value so a future language addition doesn't crash the demo. */
export function getDemoConversation(lang: 'en' | 'zh'): DemoTurn[] {
  return lang === 'en' ? DEMO_CONVERSATION_EN : DEMO_CONVERSATION_ZH;
}
