// PCM capture worklet — record-side counterpart for the Call page mic.
//
// What it does:
//
//   - Reads Float32 audio from the worklet input (mono first channel).
//   - Maintains a rolling 800 ms preroll ring buffer.
//   - On `command: 'begin'`, snapshots the preroll into an `active`
//     buffer and starts appending live samples to it.
//   - On `command: 'end'`, posts the assembled Int16 PCM back to the
//     main thread via `port.postMessage`. Caller transfers the buffer.
//   - On `command: 'cancel'`, drops the active buffer without posting.
//
// Why a worklet (and not MediaRecorder + WebM/Opus):
//
//   1. ZERO codec hop. Whisper wants 16 kHz mono PCM; we give it
//      exactly that. No pyav, no ffmpeg, no decode latency.
//   2. PREROLL. MediaRecorder.start() has codec-init latency that
//      eats the user's first word. We're always running, so the 800 ms
//      preroll captures the run-up before the user's PTT-down.
//   3. EXACT FRAME ALIGNMENT. WebM/Opus chunks are container-keyframe
//      dependent — slicing them is non-trivial. PCM is sample-level.
//
// Sample rate: the AudioContext is opened at 16000 Hz on the main
// thread, so the browser handles resampling from the input device's
// native rate (usually 48 kHz) before we see the audio. That means
// `globalThis.sampleRate` here equals 16000 and we don't need a
// downsampler. If a future caller ever opens the context at a
// different rate, the preroll length below will silently scale to
// whatever (PREROLL_MS * sampleRate / 1000) lands at.

const PREROLL_MS = 800;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.prerollLen = Math.floor((PREROLL_MS * sampleRate) / 1000);
    this.preroll = new Int16Array(this.prerollLen);
    this.prerollIdx = 0;
    this.prerollFilled = false;

    this.active = false;
    // List of Int16Array chunks, concatenated on `end`. Push-only
    // during recording, no per-frame allocations beyond the chunk
    // itself.
    this.activeChunks = [];

    this.port.onmessage = (e) => {
      const cmd = e.data && e.data.command;
      if (cmd === 'begin') {
        this.activeChunks = [this.snapshotPreroll()];
        this.active = true;
      } else if (cmd === 'end') {
        this.active = false;
        const out = this.flatten(this.activeChunks);
        this.activeChunks = [];
        // Transfer the ArrayBuffer so the main thread takes ownership
        // without a copy. After this line, `out` is detached here.
        this.port.postMessage({ pcm: out.buffer }, [out.buffer]);
      } else if (cmd === 'cancel') {
        this.active = false;
        this.activeChunks = [];
      }
    };
  }

  snapshotPreroll() {
    if (!this.prerollFilled) {
      // Haven't filled the ring yet — only the first prerollIdx
      // samples are valid (the rest are zeros from the initial alloc).
      return this.preroll.slice(0, this.prerollIdx);
    }
    // Filled ring: the oldest sample lives at prerollIdx, walking
    // forward (with wrap) gives chronological order.
    const out = new Int16Array(this.prerollLen);
    const tail = this.prerollLen - this.prerollIdx;
    out.set(this.preroll.subarray(this.prerollIdx), 0);
    out.set(this.preroll.subarray(0, this.prerollIdx), tail);
    return out;
  }

  flatten(chunks) {
    let total = 0;
    for (let i = 0; i < chunks.length; i++) total += chunks[i].length;
    const out = new Int16Array(total);
    let off = 0;
    for (let i = 0; i < chunks.length; i++) {
      out.set(chunks[i], off);
      off += chunks[i].length;
    }
    return out;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input[0];
    if (!ch || ch.length === 0) return true;

    // Float32 [-1, 1] → Int16 [-32768, 32767]. Clamp before scaling
    // because driver-level audio can transiently overshoot ±1.
    const out = new Int16Array(ch.length);
    for (let i = 0; i < ch.length; i++) {
      let s = ch[i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      out[i] = (s * 32767) | 0;
    }

    // Always push to preroll ring — it must reflect the live mic even
    // when not actively recording, so the next `begin` can snapshot it.
    for (let i = 0; i < out.length; i++) {
      this.preroll[this.prerollIdx] = out[i];
      this.prerollIdx++;
      if (this.prerollIdx >= this.prerollLen) {
        this.prerollIdx = 0;
        this.prerollFilled = true;
      }
    }

    if (this.active) {
      this.activeChunks.push(out);
    }

    // `true` = keep me alive across renders. Returning false would let
    // the engine reclaim the processor when there's no input — but our
    // input is a live mic, so we're never silent in the input-less
    // sense; just return true unconditionally.
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
