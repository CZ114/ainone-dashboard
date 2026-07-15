/**
 * PcmCapture — Web Audio + AudioWorklet wrapper that gives the Call
 * page mic the same record-then-transcribe shape as the ESP32 path.
 *
 * Pipeline:
 *
 *   getUserMedia (channelCount=1, AGC/NS/EC on)
 *      ↓
 *   AudioContext { sampleRate: 16000 }   ← browser does HQ resampling
 *      ↓
 *   MediaStreamSourceNode → AudioWorkletNode("pcm-capture")
 *
 * The worklet (frontend/public/pcm-capture-worklet.js) runs always-on:
 * it keeps a rolling 800 ms preroll ring buffer of recent PCM16
 * samples, and on `begin` snapshots it as the head of the active
 * recording. On `end`, it ships the assembled Int16 PCM back to the
 * main thread via a transferable ArrayBuffer.
 *
 * Why this shape (vs MediaRecorder + WebM/Opus):
 *
 *   1. Zero codec hop — Whisper wants 16 kHz mono PCM and that's
 *      exactly what we send. No pyav decode on the backend.
 *   2. Preroll captures the user's first word — MediaRecorder.start()
 *      has 50–200 ms of codec-init delay that swallowed it before.
 *   3. Same backend code path as the ESP32 mode (transcribe_pcm_clip).
 *
 * Lifecycle: `init()` → `begin()`/`end()` per turn (any number of
 * times) → `dispose()` on unmount or source switch. `init` is
 * idempotent; calling it twice is a no-op the second time.
 */

const WORKLET_URL = '/pcm-capture-worklet.js';
const WORKLET_NAME = 'pcm-capture';
const TARGET_SAMPLE_RATE = 16000;

export class PcmCapture {
  private ctx: AudioContext | null = null;
  private worklet: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  private resolveEnd: ((data: Int16Array) => void) | null = null;

  /**
   * Acquire mic, open the 16 kHz AudioContext, load the worklet, and
   * wire the graph. Throws if getUserMedia is denied or the browser
   * doesn't support AudioWorklet.
   */
  async init(): Promise<void> {
    if (this.ctx) return;

    // Open the context at 16 kHz so the browser's high-quality
    // resampler does the rate conversion for us; the worklet sees
    // exactly what Whisper expects.
    type ACCtor = typeof AudioContext;
    const AC: ACCtor =
      window.AudioContext ||
      ((window as unknown as { webkitAudioContext?: ACCtor }).webkitAudioContext as ACCtor);
    if (!AC) {
      throw new Error('Web Audio is not available in this browser.');
    }
    const ctx = new AC({ sampleRate: TARGET_SAMPLE_RATE });

    // addModule must finish before constructing the AudioWorkletNode.
    // It's safe to call before getUserMedia — the worklet doesn't run
    // until we connect a source.
    await ctx.audioWorklet.addModule(WORKLET_URL);

    // Echo cancel + noise suppression + AGC on so the user's environment
    // doesn't poison Whisper. channelCount=1 because mono is what we
    // post anyway (and what every Whisper code path expects).
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const source = ctx.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(ctx, WORKLET_NAME);
    source.connect(worklet);
    // Deliberately NOT connecting worklet → ctx.destination — we don't
    // want the user's mic playing back through their speakers.

    worklet.port.onmessage = (e: MessageEvent<{ pcm?: ArrayBuffer }>) => {
      if (!e.data || !e.data.pcm) return;
      const data = new Int16Array(e.data.pcm);
      const resolve = this.resolveEnd;
      this.resolveEnd = null;
      if (resolve) resolve(data);
    };

    this.ctx = ctx;
    this.stream = stream;
    this.source = source;
    this.worklet = worklet;
  }

  /** Mark a turn's start. Worklet snapshots the 800 ms preroll into
   *  the active buffer and starts appending live samples. */
  begin(): void {
    if (!this.worklet) {
      throw new Error('PcmCapture not initialised — call init() first.');
    }
    this.worklet.port.postMessage({ command: 'begin' });
  }

  /** Mark a turn's end. Resolves with the assembled PCM16 (preroll +
   *  live samples). Empty Int16Array if the user pressed PTT for so
   *  short a moment that no samples landed. */
  end(): Promise<Int16Array> {
    if (!this.worklet) {
      return Promise.reject(
        new Error('PcmCapture not initialised — call init() first.'),
      );
    }
    return new Promise((resolve) => {
      // Replace any prior pending end() — should never happen in the
      // normal Call page flow, but defensive against rapid begin/end.
      this.resolveEnd = resolve;
      this.worklet!.port.postMessage({ command: 'end' });
    });
  }

  /** Drop an in-progress recording without posting anything. Use when
   *  the page is unmounted mid-turn or the user switches audio source. */
  cancel(): void {
    this.worklet?.port.postMessage({ command: 'cancel' });
    this.resolveEnd = null;
  }

  /** Tear everything down. Stops the mic stream, closes the context,
   *  and zeroes refs. Safe to call multiple times. */
  async dispose(): Promise<void> {
    try {
      this.source?.disconnect();
    } catch {
      /* already disconnected */
    }
    try {
      this.worklet?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.ctx && this.ctx.state !== 'closed') {
      try {
        await this.ctx.close();
      } catch {
        /* ignore */
      }
    }
    this.ctx = null;
    this.worklet = null;
    this.source = null;
    this.stream = null;
    this.resolveEnd = null;
  }

  /** True once init() has finished and a new turn can begin. */
  get ready(): boolean {
    return this.worklet !== null;
  }
}
