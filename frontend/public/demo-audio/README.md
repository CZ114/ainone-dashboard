# Demo audio drop folder

The `/call` demo plays one MP3 per AI turn instead of running TTS at
runtime. Drop the files here:

```
frontend/public/demo-audio/
├── en/
│   ├── t1.mp3
│   ├── t2.mp3
│   ├── t3.mp3
│   ├── t4.mp3
│   └── t5.mp3
└── zh/
    ├── t1.mp3
    ├── t2.mp3
    ├── t3.mp3
    ├── t4.mp3
    └── t5.mp3
```

## How it works

- The demo player passes each turn's `audioUrl` to `waitForReplyEnd()`.
- That callback creates an `<audio>` element, plays it, and awaits the
  `ended` event before kicking the next turn.
- If a file is missing, the browser fires `error` instead of `ended`
  and the demo falls back to the existing path: live TTS (when 🔊 is
  on) or a char-based reading estimate (when 🔊 is off). So you can
  drop files in incrementally — the demo still runs without all 10.
- Files **must be MP3, WAV, or M4A**. Anything `<audio>` can decode is
  fine. Keep them small (~50 KB each is plenty for these short turns).

## Generating the audio

Use any TTS service you trust — ElevenLabs, OpenAI's `gpt-4o-mini-tts`,
Suno's voice, Cartesia, whatever. For ElevenLabs specifically:

1. Pick a voice that fits a "doctor talking to a patient" persona.
   For en, the `Bella` or `Rachel` defaults work; the multilingual
   models (`eleven_multilingual_v2`) also handle zh-CN well.
2. Paste the plain text below for each turn. **Don't paste the
   `📎` line or the markdown table — those are visual-only on the
   call page; the audio should be just the prose.**
3. Download MP3, rename to `t{N}.mp3`, drop into the corresponding
   `en/` or `zh/` folder.

## Plain text per turn

What to paste into the TTS service. These are exactly what the
existing `preparePlainText()` helper would produce — markdown
stripped, 📎 line stripped, table rows replaced with one summary
sentence so the audio doesn't try to read column headers.

### EN

**t1.mp3** *(thinking ≈ 1.5 s, plus this audio)*
```
Evening. I looked at today's data — your heart rate between 3 and
5 PM ran about 12% above last week's average, and GSR never settled
back to baseline. Ambient light was low across that window, so you
were probably indoors. That combination reads more like emotional
or cognitive load than physical fatigue. What were you doing then?
```

**t2.mp3**
```
Noted. Across the last 14 days, your HRV averages 6 to 8 percent
lower around family video calls, and recovery has been slower too.
Not a medical issue — but your body is reacting. Want to wrap up
tonight's recording a little earlier? I'll log your current state
as an observation in the meantime.
```

**t3.mp3** *(boundary turn — no data files)*
```
No. I can only see your smart glove, the recordings stored on this
machine, and what you tell me directly. If you want to track
something on her side — say, how often she repeats a phrase — record
your calls with her and I'll observe from your side of the line.
```

**t4.mp3** *(skip the table — read this summary instead)*
```
Went through the 7 saved call recordings — pension-related topics
came up 9 times on her side, mostly on Tuesday and Wednesday.
I've flagged it as an observation in the diary, ready to pull up
if you want to share it with a clinician. Remember — this is
observation, not diagnosis.
```

**t5.mp3** *(skip the table — read this summary instead)*
```
Done. Today's three highlights are now in the diary: your load
peak at four PM, your mom's repeated mention of the word pension,
and a suggestion to wrap up tonight's recording 30 minutes early.
I'll push a short summary when you wake up tomorrow. Sleep well.
```

### ZH

**t1.mp3**
```
晚上好。看了今天的数据 — 你下午三点到五点的心率波动比上周平均高了
百分之十二，GSR 也一直没回到基线。环境光那段时间偏暗，应该在室内。
这种组合更像情绪或认知负荷，不是体力疲劳。那段时间你在做什么？
```

**t2.mp3**
```
嗯，记下来了。最近十四天里，你跟家里视频前后 HRV 平均会低
百分之六到八，恢复也变慢。这不是医学问题，但身体确实有反应。
今晚的录音要不要稍微早点收？我先把你当下的状态写进观察。
```

**t3.mp3** *(boundary turn)*
```
看不到。我能看到的只有你这只智能手套、你这台机器上的录音、
和你跟我说的内容。如果你想追踪她的某些方面 — 比如重复某句话
的频率 — 可以把跟她的通话录下来，我从你这一侧去观察。
```

**t4.mp3** *(skip the table — read this summary instead)*
```
翻了一下你保留的七段通话录音，「退休金」相关话题在她那一侧
被重复提了九次，集中在周二和周三。我标了一条观察放进日记，
你后面想拉给医生看可以直接调。但记住 — 这是观察，不是诊断。
```

**t5.mp3** *(skip the table — read this summary instead)*
```
好。今天关键的三件事我已经写进日记：负荷峰值在十六点，心率
高出正常 28%；家里那边重复提到「退休金」一共九次；建议今晚
的录音提前 30 分钟收。明早起床我会推一条简短摘要。晚安。
```

## Tips

- **Keep tone consistent** across all 5 turns — same voice, same
  speaking rate, same recording level. Mid-demo voice changes are
  jarring even if individual turns sound great.
- **Listen end-to-end before committing** — the demo strings them
  together quickly, so a slight glitch in one file is more obvious
  than it would be in isolation.
- **Lean slightly conversational, not performative**. The product
  is "AI talking with you", not "AI delivering a report".

## Reverting

To go back to live TTS, delete (or rename) the MP3s. The fallback
path picks up automatically — no code change needed.

## Gitignore

These files are gitignored by default (large binary blobs we don't
want in version control). If you want to commit them so the demo is
self-contained for other lab members, remove the `demo-audio/*.mp3`
line from the repo root `.gitignore`.
