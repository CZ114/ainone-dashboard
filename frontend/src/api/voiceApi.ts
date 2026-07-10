/**
 * Voice STT API — wraps `POST /api/voice/transcribe`.
 *
 * The endpoint accepts ANY audio container faster-whisper / pyav can
 * decode (WebM/Opus, OGG, WAV, MP3 …). Browser MediaRecorder defaults
 * to WebM/Opus on Chromium and Firefox; that's what we send.
 *
 * No multipart wrapping — the body is the raw bytes, simpler than
 * FormData and saves a base64 round-trip.
 */

export interface TranscribeResult {
  text: string;
  language: string | null;
  language_probability: number;
  duration_seconds: number;
  transcribe_ms: number;
}

async function readJsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (typeof j.detail === 'string') detail = j.detail;
    } catch {
      /* not JSON; keep status */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export const voiceApi = {
  /**
   * Mic path — ship a recorded audio container (WebM/Opus / OGG /
   * MP4 / WAV) and let pyav decode. Used as a fallback for browsers
   * that don't support AudioWorklet; the live mic path now prefers
   * `transcribePcm` below.
   *
   * @param lang BCP-47; empty/undefined = server falls back to the
   *   extension's pinned language.
   */
  async transcribe(blob: Blob, lang?: string): Promise<TranscribeResult> {
    const url = lang
      ? `/api/voice/transcribe?lang=${encodeURIComponent(lang)}`
      : '/api/voice/transcribe';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      body: blob,
    });
    return readJsonOrThrow<TranscribeResult>(res);
  },

  /**
   * Mic path (preferred) — ship raw PCM16 mono 16 kHz captured by the
   * AudioWorklet. Body is the Int16 buffer's bytes verbatim, no
   * container, no codec. Hits the same backend transcribe_pcm_clip
   * code path as the ESP32 source so latency / accuracy match.
   *
   * @param pcm  Int16Array buffer or matching ArrayBuffer.
   * @param lang BCP-47; empty/undefined = server falls back to the
   *   extension's pinned language.
   */
  async transcribePcm(
    pcm: Int16Array,
    lang?: string,
  ): Promise<TranscribeResult> {
    const url = lang
      ? `/api/voice/transcribe-pcm?lang=${encodeURIComponent(lang)}`
      : '/api/voice/transcribe-pcm';
    // TS 5.x widens TypedArray#buffer to `ArrayBufferLike` (covers
    // SharedArrayBuffer), which Blob/fetch reject. We always allocate
    // PCM via `new Int16Array(n)` in the worklet so the runtime type
    // is always ArrayBuffer; cast through unknown to satisfy the lib
    // without copying.
    const buf = pcm.buffer as unknown as ArrayBuffer;
    const body = new Blob([buf], { type: 'application/octet-stream' });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
    });
    return readJsonOrThrow<TranscribeResult>(res);
  },

  /**
   * ESP32 path — record-then-transcribe via server-side buffer.
   * Pair `clipStart()` with `clipStop()`; the server buffers UDP
   * audio between the two calls and transcribes the whole clip on
   * stop. More accurate than the live /ws/transcribe partial path.
   */
  async clipStart(): Promise<void> {
    const res = await fetch('/api/voice/clip/start', { method: 'POST' });
    await readJsonOrThrow<{ ok: true }>(res);
  },

  async clipStop(lang?: string): Promise<TranscribeResult> {
    const url = lang
      ? `/api/voice/clip/stop?lang=${encodeURIComponent(lang)}`
      : '/api/voice/clip/stop';
    const res = await fetch(url, { method: 'POST' });
    return readJsonOrThrow<TranscribeResult>(res);
  },
};
