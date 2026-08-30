---
type: journey
status: active
last_updated: 2026-08-21
tags: [bugs, whisper, cuda, extensions, windows]
---

# Whisper CUDA "loads fine, dies on decode" — missing cuBLAS fallback

> TL;DR: `WhisperModel(device="cuda")` can **construct successfully** on a machine
> whose CUDA runtime is incomplete (no `cublas64_12.dll`), so the existing
> constructor try/except never fires — then every real transcription (and the boot
> warmup) throws `RuntimeError: Library cublas64_12.dll is not found`. Fixed by
> making `_warmup_blocking()` return success/failure and demoting to CPU int8 when
> the GPU-path warmup decode fails.

## Symptom

During the 2026-08-21 platform-validation run (headless batch transcription of the
packaged patient recordings), boot log showed:

```
[whisper] loaded on CUDA (float16) — model=large-v3-turbo
[whisper] warmup transcribe failed (non-fatal): RuntimeError: Library cublas64_12.dll is not found or cannot be loaded
[whisper] Model 'large-v3-turbo' loaded in 4893 ms — transcription is now ready
```

"transcription is now ready" was a lie — any `POST /api/recordings/transcribe/<wav>`
would have raised the same cublas error. (Also note `faster-whisper` was missing
from `backend/.venv` entirely and had to be `uv pip install faster-whisper`-ed —
the extension's pip-install flow had never run in this venv.)

## Root cause

ctranslate2 only loads cuBLAS/cuDNN kernels at **inference** time, not at model
construction. The load path in `whisper_local.py` guarded only the constructor:
CUDA construct OK → `loaded = True` → CPU fallback skipped → warmup failure logged
as "non-fatal" and swallowed.

## Fix

`_warmup_blocking()` now returns `True/False`. In `_load_model_blocking`, a failed
warmup after a successful CUDA construct rebuilds the model on CPU int8 and
re-warms:

```
[whisper] warmup transcribe failed (non-fatal): RuntimeError: Library cublas64_12.dll ...
[whisper] CUDA warmup decode failed — rebuilding on CPU int8 so transcription stays usable
[whisper] loaded on CPU (int8) — model=large-v3-turbo
[whisper] warmup transcribe complete in 18916 ms — kernels primed ...
```

Verified: 16 recorded WAVs batch-transcribed through the endpoint afterwards
(zh + en speech recovered; silent clips return empty text as expected).

## Landmines for future readers

- A CUDA `WhisperModel` that constructs is **not** evidence the GPU path works —
  only a decode is. Any future device probing must run one.
- Proper GPU fix (out of scope here): install matching `nvidia-cublas-cu12` /
  `nvidia-cudnn-cu12` wheels and put their `bin` dirs on PATH before ctranslate2
  loads, or ship CUDA via the extension installer.
- CPU int8 large-v3-turbo throughput observed ≈ 0.35–2× realtime on this machine —
  fine for batch, marginal for live streaming.
