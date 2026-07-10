/**
 * TTS — Edge-TTS via the FastAPI backend, with a Web Speech fallback.
 *
 * Path of least surprise:
 *   1. POST /api/tts/synthesize → MP3 stream
 *   2. Wrap in a Blob URL, hand to a fresh `<audio>`, play
 *   3. On `ended` (or `error`, or our `stop()`), revoke the URL
 *
 * Why Edge-TTS over the previous Web Speech API path: Web Speech
 * voices vary wildly by OS and most ship a flat, robotic prosody
 * that the user called out as "听起来太 AI". Microsoft's Edge voices
 * (Aria for en-US, Xiaoxiao for zh-CN) read with natural intonation,
 * pauses, and emotion — same engine that powers the Edge browser's
 * Read Aloud feature. They're fetched via a free undocumented
 * websocket API, no key required.
 *
 * Web Speech is kept as a graceful fallback: when the backend is
 * unreachable (FastAPI down, Edge-TTS package not installed, network
 * blocked, etc.) we still produce some audio rather than going
 * silent. Tradeoff: lower quality, but the demo doesn't lock up
 * waiting for an `onEnd` that will never come.
 *
 * Cancellation:
 *   - `speak()` cancels any prior in-flight utterance, server fetch
 *     OR audio element. Two utterances overlapping would be jarring.
 *   - `stop()` on the returned handle cancels just this one.
 *   - Both fire the caller's `onEnd` so any awaiting Promise resolves.
 */

export interface SpeakOptions {
  /** UI language hint. Backend maps to Aria / Xiaoxiao defaults. */
  lang?: 'en' | 'zh';
  /** Explicit Edge voice override, e.g. "en-GB-RyanNeural". Ignored
   *  in the Web Speech fallback. */
  voice?: string;
  /** Fired exactly once when playback ends — naturally, on error,
   *  or when the caller calls stop(). Lets the demo player await
   *  TTS completion before kicking the next user turn. */
  onEnd?: () => void;
}

export interface SpeakHandle {
  stop: () => void;
}

const NOOP_HANDLE: SpeakHandle = { stop: () => {} };

// Module-level state — one in-flight utterance at a time. The /call
// page only ever has one bubble talking; layering multiple is jarring
// and would also leak Blob URLs.
let currentAudio: HTMLAudioElement | null = null;
let currentObjectUrl: string | null = null;
let currentAbort: AbortController | null = null;

export function isTtsAvailable(): boolean {
  // We can always try the backend; the fallback uses Web Speech.
  // Effectively this is "do we have any path to audio output?"
  return typeof window !== 'undefined' && typeof Audio !== 'undefined';
}

function cancelCurrent(): void {
  if (currentAbort) {
    try {
      currentAbort.abort();
    } catch {
      /* ignore */
    }
    currentAbort = null;
  }
  if (currentAudio) {
    try {
      currentAudio.pause();
      // Detach the source so the browser releases the underlying
      // network/decoder resources promptly.
      currentAudio.src = '';
      currentAudio.load();
    } catch {
      /* ignore */
    }
    currentAudio = null;
  }
  if (currentObjectUrl) {
    try {
      URL.revokeObjectURL(currentObjectUrl);
    } catch {
      /* ignore */
    }
    currentObjectUrl = null;
  }
  // Also drain any queued Web Speech fallback.
  if (
    typeof window !== 'undefined' &&
    typeof window.speechSynthesis !== 'undefined'
  ) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
  }
}

export function speak(text: string, opts: SpeakOptions = {}): SpeakHandle {
  if (!isTtsAvailable() || !text.trim()) return NOOP_HANDLE;

  cancelCurrent();

  let endedFired = false;
  const fireEnd = () => {
    if (endedFired) return;
    endedFired = true;
    try {
      opts.onEnd?.();
    } catch {
      /* don't let a buggy caller poison the audio path */
    }
  };

  const abort = new AbortController();
  currentAbort = abort;

  void (async () => {
    try {
      const res = await fetch('/api/tts/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          lang: opts.lang ?? 'en',
          voice: opts.voice,
        }),
        signal: abort.signal,
      });
      if (abort.signal.aborted) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      if (abort.signal.aborted) return;

      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      currentAudio = audio;
      currentObjectUrl = url;

      audio.onended = () => {
        if (currentObjectUrl === url) {
          URL.revokeObjectURL(url);
          currentObjectUrl = null;
        }
        if (currentAudio === audio) currentAudio = null;
        fireEnd();
      };
      audio.onerror = () => fireEnd();

      try {
        await audio.play();
      } catch (e) {
        // Autoplay rejection (user hasn't interacted yet) lands here.
        // Most call-page users HAVE clicked "Play demo" before this
        // runs, so it's rare; but if it fires, fall through to the
        // end so the demo timeline doesn't hang forever.
        console.warn('[tts] audio.play() rejected:', e);
        fireEnd();
      }
    } catch (e) {
      if (abort.signal.aborted) {
        // Caller cancelled — they expect end to fire (so awaits resolve).
        fireEnd();
        return;
      }
      console.warn(
        '[tts] backend synth failed, falling back to Web Speech:',
        e,
      );
      // Web Speech fallback. Quality drop, but better than silence
      // and the awaiting Promise still resolves cleanly.
      if (
        typeof window !== 'undefined' &&
        typeof window.speechSynthesis !== 'undefined' &&
        typeof window.SpeechSynthesisUtterance !== 'undefined'
      ) {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = opts.lang === 'zh' ? 'zh-CN' : 'en-US';
        u.onend = fireEnd;
        u.onerror = () => fireEnd();
        window.speechSynthesis.speak(u);
      } else {
        fireEnd();
      }
    }
  })();

  return {
    stop: () => {
      cancelCurrent();
      fireEnd();
    },
  };
}

/**
 * Strip markdown + 📎 + structured noise so the TTS engine reads
 * prose, not literal "pipe pipe table separator pipe". The output
 * is plain text suitable for `speak()`.
 *
 * What gets stripped:
 *   - The `📎 ...` citation line (filenames don't read well aloud).
 *   - Markdown tables (entire `| col | col |` rows + the `|---|`
 *     separator). Reading a table aloud is tedious and confusing.
 *   - Code fences and inline backticks (the content is kept; the
 *     backticks are dropped).
 *   - Bold/italic markers (`**x**` → `x`, `*x*` → `x`).
 *   - Heading hashes (`## x` → `x`).
 *   - Markdown link syntax (`[text](url)` → `text`).
 *
 * Multiple consecutive blank lines collapse to a single newline so
 * the engine's internal pause logic doesn't go quiet for too long.
 */
export function preparePlainText(input: string): string {
  let out = input;

  // Drop the leading 📎 citation line (one line, including its
  // trailing newlines). Match the emoji literally; some markdown
  // pipelines re-encode it but our scripted text uses the bare char.
  out = out.replace(/^\s*📎[^\n]*\n+/, '');

  // Drop fenced code blocks entirely — speaking source code is noise.
  out = out.replace(/```[\s\S]*?```/g, '');

  // Drop markdown table separator rows like |---|---|
  out = out.replace(/^\s*\|[\s\-:|]+\|\s*$\n?/gm, '');

  // Drop markdown table content rows (any line that starts with `|`
  // and ends with `|`, not already removed above).
  out = out.replace(/^\s*\|[^\n]*\|\s*$\n?/gm, '');

  // Inline code: keep the content, drop the backticks.
  out = out.replace(/`([^`]+)`/g, '$1');

  // Bold / italic: keep content, drop markers.
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
  out = out.replace(/\*([^*]+)\*/g, '$1');

  // Headings: drop the leading hashes.
  out = out.replace(/^#{1,6}\s+/gm, '');

  // Markdown links: keep the visible text, drop the URL.
  out = out.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // Collapse runs of blank lines.
  out = out.replace(/\n{3,}/g, '\n\n');

  return out.trim();
}
