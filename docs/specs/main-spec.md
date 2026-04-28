---
type: spec
status: active
last_updated: 2026-04-28
tags: [main, dashboard, full-stack, hardware-io, recordings, voice, extensions]
---

# ESP32 Sensor Dashboard — Project Specification

## 1. Overview

**Type**: Full-stack real-time sensor data visualization dashboard
**Core Function**: Receive multi-channel sensor data from ESP32 devices via Serial/BLE/WiFi UDP, visualize waveforms in real-time, and record data to CSV/WAV files.
**Target Users**: Developers and researchers working with ESP32-based sensor platforms (PPG, IMU, GSR, Environment sensors, Audio).

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         ESP32 Device                             │
│  (Serial USB / BLE / WiFi UDP audio stream)                      │
└──────────┬─────────────────────┬───────────────────┬────────────┘
           │ Serial              │ BLE               │ UDP Audio
           ▼                     ▼                   ▼
┌──────────────────────────────────────────────────────────────────┐
│                Backend (FastAPI) - Port 8080                     │
│  ┌─────────────┐  ┌─────────────┐  ┌────────────────────────────┐ │
│  │ SerialBridge│  │ BLEBridge   │  │ AudioBridge (UDP :8888)     │ │
│  └──────┬──────┘  └──────┬──────┘  └──────────────┬─────────────┘ │
│         │                │                        │               │
│         └────────────────┼────────────────────────┘               │
│                          ▼                                        │
│              ┌───────────────────────┐                            │
│              │   DataProcessor       │                            │
│              │ (CSV parsing, stats)  │                            │
│              └───────────┬───────────┘                            │
│                          ▼                                        │
│              ┌───────────────────────┐                            │
│              │  WebSocketManager     │◄──► WebSocket clients      │
│              └───────────┬───────────┘                            │
│                          ▼                                        │
│              ┌───────────────────────┐                            │
│              │  RecordingService     │◄──► CSV / WAV files        │
│              └───────────────────────┘                            │
└──────────────────────────────────────────────────────────────────┘
           │ REST API (port 8080)           │ WebSocket (port 8080)
           ▼                                ▼
┌──────────────────────────────────────────────────────────────────┐
│          Backend (Node.js Hono) - Port 3000                      │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  Claude Code SDK (@anthropic-ai/claude-code)                 │ │
│  │  - POST /api/chat (streaming)                               │ │
│  │  - GET /api/projects                                        │ │
│  │  - POST /api/abort/:requestId                               │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
           │ REST API (port 3000)         │ via Vite proxy
           ▼                                ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Frontend (React + Vite) - Port 5173           │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │  React Router - Client-side routing                         │ │
│  │  /dashboard → ChannelGrid + ConnectionPanel (Sensor View)    │ │
│  │  /chat → Claude Code Chat Page                              │ │
│  └──────────────────────────────────────────────────────────────┘ │
│  ┌─────────────┐  ┌─────────────┐  ┌────────────────────────────┐ │
│  │ Connection  │  │ ChannelGrid │  │ AudioLevelMeter            │ │
│  │ Panel       │  │ (waveforms) │  │                            │ │
│  └─────────────┘  └─────────────┘  └────────────────────────────┘ │
│  ┌─────────────┐  ┌─────────────┐  ┌────────────────────────────┐ │
│  │ Recording   │  │ Display     │  │ ChatPage                   │ │
│  │ Controls    │  │ Settings    │  │ (Claude Code chat)         │ │
│  └─────────────┘  └─────────────┘  └────────────────────────────┘ │
│                      ▲                                             │
│                      │ Zustand Store (AppState + ChatState)       │
└──────────────────────────────────────────────────────────────────┘
```

---

## 3. Technology Stack

### Backend
- **Framework**: FastAPI (Python) with uvicorn
- **WebSocket**: fastapi WebSocket + websockets library
- **Data Validation**: Pydantic v2
- **Serial**: pyserial
- **BLE**: bleak (async)
- **Audio Processing**: numpy
- **Data Formats**: CSV, WAV

### Frontend
- **Framework**: React 18 with TypeScript
- **Build Tool**: Vite 5
- **Routing**: React Router v7
- **State Management**: Zustand (AppState + ChatState)
- **Styling**: Tailwind CSS 3
- **Charts**: recharts (AreaChart for waveforms)
- **Language**: TypeScript 5 (strict mode)

---

## 4. Communication Protocols

### 4.1 REST API Endpoints (Backend :8080)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/serial/ports` | GET | List available serial ports |
| `/api/serial/connect` | POST | Connect to serial port |
| `/api/serial/disconnect` | POST | Disconnect serial |
| `/api/serial/status` | GET | Get serial connection status |
| `/api/ble/scan` | POST | Start BLE scanning |
| `/api/ble/connect` | POST | Connect to BLE device |
| `/api/ble/disconnect` | POST | Disconnect BLE |
| `/api/ble/status` | GET | Get BLE status |
| `/api/audio/start` | POST | Start UDP audio listener |
| `/api/audio/stop` | POST | Stop audio listener |
| `/api/audio/status` | GET | Get audio status |
| `/api/recording/start` | POST | Start recording |
| `/api/recording/stop` | POST | Stop recording |
| `/api/recording/status` | GET | Get recording status |
| `/api/health` | GET | Health check |
| `/ws` | WebSocket | Real-time data streaming |

### 4.2 Claude API Endpoints (Backend :3000)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/chat` | POST | Send chat message with streaming NDJSON response |
| `/api/projects` | GET | List available projects from `~/.claude.json` |
| `/api/abort/:requestId` | POST | Abort ongoing chat request |

**POST /api/chat Request Body:**
```json
{
  "message": "string",
  "requestId": "string (unique ID for this request)",
  "sessionId": "string (optional, for conversation continuity)",
  "allowedTools": ["string"] (optional),
  "workingDirectory": "string (optional)",
  "permissionMode": "default" | "plan" | "acceptEdits" (optional)
}
```

**Response (NDJSON streaming):**
```json
{"type":"claude_json","data": SDKMessage}
{"type":"error","error": "error message"}
{"type":"done"}
```

### 4.3 WebSocket Message Types

#### Server → Client

| Type | Fields | Trigger |
|------|--------|---------|
| `sensor_data` | `timestamp`, `channels`, `values`, `waveforms`, `stats` | When CSV line parsed from serial/BLE |
| `audio_level` | `rms_db`, `peak_db`, `is_recording` | Every 50ms via `_data_loop` |
| `recording_status` | `is_recording`, `elapsed_seconds`, `remaining_seconds`, `csv_path`, `audio_path` | When sensor data arrives OR via `recording_status()` poll |
| `connection_status` | `serial`, `ble`, `audio` | On connection change + via `_data_loop` every 50ms |

#### Client → Server

| Type | Fields | Purpose |
|------|--------|---------|
| `update_display_settings` | `settings: { points_per_channel, cards_per_row }` | Change waveform display |
| `request_status` | — | Request current connection status |

---

## 5. Data Flow Details

### 5.1 Sensor Data Path (Serial/BLE)

```
ESP32 CSV line (e.g., "1623456789,72.5,23.1,45.2")
    │
    ▼
SerialBridge / BLEBridge callback
    │ puts raw string into _data_queue
    ▼
_data_loop (50Hz thread)
    │ dequeues, calls DataProcessor.process_csv_line()
    ▼
DataProcessor
    │ parses CSV, updates ring buffers, computes stats
    ▼
_broadcast_sensor_data_sync()
    │ schedules WebSocket broadcast
    │ writes to RecordingService if recording
    ▼
WebSocketManager → All WS clients
```

### 5.2 Audio Data Path (UDP)

```
ESP32 UDP packet (16-bit mono PCM, 16kHz)
    │
    ▼
AudioBridge._read_loop() [background thread]
    │ receives UDP, processes 256-sample frames
    ▼
_process_audio_frame()
    │ computes RMS dB, Peak dB
    │ calls on_level_update callback
    ▼
on_level_update callback
    │ puts ('audio_level', None) into _broadcast_queue
    ▼
_data_loop (50Hz thread)
    │ dequeues, calls _broadcast_audio_level_sync()
    ▼
WebSocketManager → All WS clients
```

### 5.3 Recording Path

```
recording_start(duration, include_audio)
    │
    ▼
RecordingService.start_recording()
    │ creates CSV file with headers
    │ stores audio_dir path
    │ starts _monitor_recording thread
    │
    ▼
_broadcast_sensor_data_sync() [on each sensor data arrival]
    │ writes row via write_sensor_row()
    │
_broadcast_audio_level_sync() [on each audio frame]
    │ writes audio frame via write_audio_frame()
    │
    ▼
_monitor_recording thread
    │ checks elapsed time every 0.5s
    │ calls stop_recording() when duration reached
    ▼
recording_stop()
    │ finalizes CSV
    │ writes WAV file
    │ returns {elapsed_seconds, csv_path, audio_path}
```

---

## 6. Directory Structure

```
esp32_sensor_dashboard/
├── backend/
│   ├── app/                        # Python FastAPI backend (port 8080)
│   │   ├── api/
│   │   │   ├── serial.py          # GET /api/serial/*
│   │   │   ├── ble.py              # GET/POST /api/ble/*
│   │   │   ├── audio.py            # POST /api/audio/*
│   │   │   ├── recording.py        # POST /api/recording/*
│   │   │   └── websocket.py        # /ws endpoint
│   │   ├── core/
│   │   │   ├── serial_bridge.py    # pyserial read thread
│   │   │   ├── ble_bridge.py       # bleak async BLE
│   │   │   ├── audio_bridge.py     # UDP socket + level calc
│   │   │   └── data_processor.py   # CSV parsing, ring buffer, stats
│   │   ├── services/
│   │   │   ├── connection_manager.py # All bridges coordination
│   │   │   ├── websocket_manager.py  # WS broadcast pool
│   │   │   └── recording_service.py  # CSV/WAV recording
│   │   ├── models/
│   │   │   └── schemas.py          # Pydantic models
│   │   ├── config.py               # Constants (ports, UUIDs, etc.)
│   │   └── main.py                 # FastAPI app + lifespan
│   ├── claude/                     # Node.js Claude backend (port 3000)
│   │   ├── app.ts                  # Hono application factory
│   │   ├── cli/
│   │   │   ├── node.ts             # Node.js CLI entry point
│   │   │   └── validation.ts       # Claude CLI path detection
│   │   ├── handlers/
│   │   │   ├── chat.ts             # POST /api/chat handler
│   │   │   ├── abort.ts            # POST /api/abort handler
│   │   │   └── projects.ts         # GET /api/projects handler
│   │   ├── runtime/
│   │   │   └── node.ts             # Node.js runtime abstraction
│   │   ├── shared/
│   │   │   └── types.ts           # Shared TypeScript types
│   │   ├── package.json
│   │   └── ... (Hono.js backend from claude-code-webui)
│   ├── recordings/
│   │   ├── csv/                    # sensor_YYYYMMDD_HHMMSS.csv
│   │   └── audio/                  # audio_YYYYMMDD_HHMMSS.wav
│   ├── requirements.txt
│   └── run.py
├── frontend/
│   ├── src/
│   │   ├── api/
│   │   │   ├── client.ts           # REST API client (fetch)
│   │   │   ├── websocket.ts        # WS client with auto-reconnect
│   │   │   └── claudeApi.ts       # Claude Code API client
│   │   ├── components/
│   │   │   ├── layout/
│   │   │   │   ├── Header.tsx      # Logo + nav + connection indicators
│   │   │   │   └── ConnectionPanel.tsx # Serial/BLE/Audio connect UI
│   │   │   ├── channels/
│   │   │   │   ├── ChannelGrid.tsx # Responsive grid container
│   │   │   │   ├── ChannelCard.tsx # Single channel display
│   │   │   │   └── WaveformChart.tsx # recharts AreaChart
│   │   │   ├── audio/
│   │   │   │   └── AudioLevelMeter.tsx # RMS/Peak level bars
│   │   │   ├── recording/
│   │   │   │   └── RecordingControls.tsx # Start/stop + duration
│   │   │   ├── settings/
│   │   │   │   └── DisplaySettings.tsx # Points/cards sliders
│   │   │   ├── chat/
│   │   │   │   ├── ChatPage.tsx    # Main chat container
│   │   │   │   ├── ChatMessages.tsx # Message list display
│   │   │   │   └── ChatInput.tsx   # Input textarea + send button
│   │   │   └── Dashboard.tsx      # Sensor dashboard page
│   │   ├── store/
│   │   │   ├── index.ts            # Zustand store (app state)
│   │   │   └── chatStore.ts       # Chat state (messages, session)
│   │   ├── hooks/
│   │   │   └── useStreamParser.ts  # NDJSON stream parser hook
│   │   ├── types/
│   │   │   └── index.ts            # TypeScript interfaces
│   │   ├── App.tsx                 # Root with React Router
│   │   └── main.tsx                # React entry point
│   ├── public/
│   ├── package.json
│   ├── tailwind.config.js
│   └── vite.config.ts             # Vite + proxy config
├── recordings/                     # Symlink or mount point
├── SPEC.md                         # This file
├── README.md
├── start.bat
└── start.sh
```

---

## 7. Key Implementation Details

### 7.1 Multi-threading Model

The backend uses **3+ separate threads**:

1. **Main thread**: uvicorn async event loop (handles HTTP/WS requests)
2. **Serial read thread**: Blocking `readline()` on serial port, callback-based
3. **Audio read thread**: Blocking `recvfrom()` on UDP socket, calculates levels per-frame
4. **`_data_loop` thread**: 50Hz polling loop that:
   - Drains `_data_queue` (serial/BLE CSV data)
   - Drains `_broadcast_queue` (connection changes, audio levels)
   - Broadcasts to WebSocket clients
   - Writes to recording files

Thread-safe communication: `queue.Queue` (FIFO) and `threading.Event` (stop signals).

### 7.2 DataProcessor — Auto Channel Detection

On first CSV line received, `DataProcessor` splits by comma and uses the first row as channel names. Each subsequent row updates corresponding ring buffers. Stats (min/max/avg) are computed over all buffered samples.

### 7.3 Waveform Rendering

Frontend uses `recharts` `<AreaChart>` with a fixed `dataKey` per channel. The `waveform` array in `ChannelData` is a rolling window of the last N sample values (N = `points_per_channel`, default 100).

### 7.4 Audio Level Calculation

```
samples = np.array(struct.unpack(f'{len(frame)//2}h', frame), dtype=np.float32) / 32768.0
rms = np.sqrt(np.mean(samples ** 2))
rms_db = 20 * np.log10(rms + 1e-10)
peak = np.max(np.abs(samples))
peak_db = 20 * np.log10(peak + 1e-10)
```

### 7.5 Recording File Format

- **CSV**: First row = `timestamp,ch1,ch2,...`. Subsequent rows = `ISO timestamp, value1, value2,...`
- **WAV**: 16-bit mono, 16kHz, created by accumulating raw UDP frames

---

## 8. State Management (Frontend — Zustand)

### 8.1 AppState (Sensor Dashboard)

```typescript
interface AppState {
  // Connections
  serial: { connected: boolean; port: string | null; baudRate: number; availablePorts: ... }
  ble: { connected: boolean; deviceName: string | null }
  audio: { connected: boolean; rmsDb: number; peakDb: number }

  // Sensor data
  channels: ChannelData[]          // name, value, waveform[], stats{}, enabled, color
  channelCount: number

  // Recording
  isRecording: boolean
  recordingRemaining: number       // seconds remaining
  recordingElapsed: number         // seconds elapsed

  // Display
  settings: { points_per_channel: number; cards_per_row: number }
}
```

### 8.2 ChatState (Claude Code Chat)

```typescript
interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  toolName?: string
  toolInput?: unknown
  toolResult?: string
  isStreaming?: boolean
}

interface ChatState {
  messages: ChatMessage[]
  input: string
  isLoading: boolean
  sessionId: string | null
  currentRequestId: string | null
  error: string | null
  projects: Array<{ name: string; path: string; encodedName: string }>
  selectedProject: string | null
  permissionMode: 'default' | 'plan' | 'acceptEdits'
}
```

### 8.3 React Router Routes

| Route | Component | Description |
|-------|-----------|-------------|
| `/dashboard` | `Dashboard` | Sensor monitoring dashboard |
| `/chat` | `ChatPage` | Claude Code chat interface |
| `/` | Redirect to `/dashboard` | Default route |

---

## 9. Known Issues / Edge Cases

1. **BLE scan is fire-and-forget**: `ble.start_scan()` is asynchronous with no callback on scan completion. Frontend polls status after 2s delay.
2. **WebSocket reconnect**: Client auto-reconnects with 3s delay, but in-flight messages during disconnect are lost.

---

## 10. Bug Fix Log

All bugs below were found and fixed during the 2026-04-17 / 2026-04-18 development session.

---

### Bug #1: Recording Timer Shows 00:00 and Never Updates

**Files**: `connection_manager.py`, `recording_service.py`
**Symptom**: Clicking "Start Recording" — timer stuck at `00:00 / 00:XX`. Intermittently flashes the correct remaining time every few seconds. No CSV/WAV data written.
**Root Cause**: `recording_status` WebSocket messages were only sent from within `_broadcast_sensor_data_sync()`, which only fires when `_data_queue` receives sensor data from Serial/BLE. With no sensor data arriving, the frontend never receives `recording_status` messages and the timer freezes. Every ~1 second the periodic broadcast fired, briefly updating the UI.
**Fix**:
- Added `_broadcast_recording_status_sync()` method in `ConnectionManager`.
- In `_data_loop`: handles `'recording_status'` message type in `_broadcast_queue`, and fires `recording_status` broadcast every 50 loops (~1 second) via `loop_count % 50 == 0`.
- `recording_start()` and `recording_stop()` immediately trigger `_broadcast_recording_status_sync()`.
- Fixed `recording_service.py`: `.seconds` (loses sub-second precision) → `.total_seconds()`.
- Audio frames wired via `on_audio_data` callback to write directly to `RecordingService.write_audio_frame()` without needing sensor data.

---

### Bug #2: Audio Level Meter Stays at -100 dB Despite "Connected"

**File**: `connection_manager.py`
**Symptom**: Audio shows "● Connected" but the RMS/Peak bars remain at -100 dB and never move.
**Root Cause**: `AudioBridge._process_audio_frame()` correctly calculates RMS/Peak dB and calls `self.on_level_update(...)`, but `on_level_update` was never assigned in `_bind_callbacks()` — it was `None`. Same for `on_audio_data`. `_broadcast_audio_level_sync()` was never triggered.
**Fix**:
```python
# In _bind_callbacks():
def on_audio_level_update(rms_db: float, peak_db: float):
    self._broadcast_queue.put(('audio_level', None))
self.audio_bridge.on_level_update = on_audio_level_update

def on_audio_data(frame: bytes):
    if self.recording_service.is_recording:
        self.recording_service.write_audio_frame(frame)
self.audio_bridge.on_audio_data = on_audio_data
```
In `_data_loop`: handle `'audio_level'` message type.

---

### Bug #3: BLE Status Remains "Connected" After Disconnect

**File**: `ble_bridge.py`
**Symptom**: BLE channel in the UI shows connected even though the device is off, or after stopping BLE. Affects other bridges' connection_status broadcasts.
**Root Cause**: `ble_bridge.stop()` only set `running = False` and `_stop_event.set()`, but never reset `is_connected = False` or called `on_connection_change(False)`. Serial bridge had the correct cleanup; BLE did not.
**Fix**:
```python
def stop(self):
    self.running = False
    self._stop_event.set()
    if self.receive_thread:
        self.receive_thread.join(timeout=2.0)
    self.is_connected = False           # ← added
    if self.on_connection_change:       # ← added
        self.on_connection_change(False)  # ← added
```

---

### Bug #4: "Object of type float32 is not JSON serializable"

**File**: `connection_manager.py`
**Symptom**: Backend console shows `[WS] Processor error: Object of type float32 is not JSON serializable` repeatedly when audio is running.
**Root Cause**: `AudioBridge._process_audio_frame()` computes `rms_db` and `peak_db` as `numpy.float32`. When `_broadcast_audio_level_sync()` read these via `get_levels()` and put them in the message dict, they were still `numpy.float32`. `json.dumps()` cannot serialize numpy types.
**Fix**: Cast to native Python `float` before constructing the message:
```python
message = {
    'type': 'audio_level',
    'rms_db': float(rms_db),   # ← float() conversion
    'peak_db': float(peak_db), # ← float() conversion
    ...
}
```

---

### Bug #5: WebSocket Broadcast Architecture — `call_soon_threadsafe` Instability

**File**: `websocket_manager.py`
**Symptom**: Recording timer freezes. No data reaching frontend despite backend processing correctly. No error messages in console.
**Root Cause (5 iterations)**:

| Attempt | Mechanism | Problem |
|---------|-----------|---------|
| v1 | `_broadcast_thread` with independent `asyncio.new_event_loop()` | `RuntimeError: Event is bound to a different event loop` — WebSocket connections belong to FastAPI's main loop |
| v2 | `call_soon_threadsafe(create_task, _do_broadcast(msg))` | Incorrect API usage — does not schedule a coroutine; silently drops broadcasts |
| v3 | `run_coroutine_threadsafe(...).result(timeout=0.5)` | Blocking the calling thread; `result()` wait causes `_data_loop` to stall; unstable on Windows |
| v4 | `asyncio.to_thread(queue.get, True)` in drain task | Python 3.12: thread-pool blocking `queue.get` cannot be properly awaited by event loop; `asyncio.get_event_loop()` deprecated |
| v5 (final) | Polling drain task | ✅ Stable — no cross-thread asyncio |

**Final Fix**: `_queue_drain_task()` polls the queue every 50ms via `await asyncio.sleep(0.05)`, drains all messages with `queue.get_nowait()`, and broadcasts. `schedule_broadcast()` is pure `queue.put_nowait()` — zero asyncio involvement, instant return. No threads, no `call_soon_threadsafe`, no `run_coroutine_threadsafe`.

```
工作线程 (_data_loop)
  → schedule_broadcast(msg) → queue.put_nowait() ← 立即返回

主 event loop (_queue_drain_task asyncio.Task)
  → await asyncio.sleep(0.05)       # 每50ms唤醒
  → while not queue.empty(): drain + broadcast
```

---

### Bug #6: `recording_start()` Never Sends First `recording_status`

**File**: `connection_manager.py`
**Symptom**: After clicking "Start Recording", the UI briefly shows `00:00 / XX:XX` before settling to correct values. No immediate feedback.
**Root Cause**: `recording_start()` called `recording_service.start_recording()` but did not trigger any WebSocket message. The first `recording_status` arrived only via the next periodic broadcast ~1 second later.
**Fix**: `recording_start()` now calls `_broadcast_recording_status_sync()` immediately after starting the service. Same for `recording_stop()`.

---

## 11. Feature Additions

### Custom Recording Duration
**File**: `frontend/src/components/recording/RecordingControls.tsx`

Changed the duration selector from a fixed `<select>` (30s / 1min / 2min / 5min / 10min) to a free-form number input accepting any integer value in seconds (min: 1, max: 3600). Backend already accepts arbitrary `duration_seconds` with no validation constraints.

UI: number input with "seconds" suffix label. Validation: `min={1} max={3600}`.

---

## 12. Claude Code Chat Integration (2026-04-18)

### Issue #1: Backend Port Conflict

**Symptom**: Claude backend failed to start with `EADDRINUSE: address already in use 127.0.0.1:8080`

**Root Cause**: Claude backend default port was 8080, same as Python FastAPI backend.

**Fix**: Changed default port in `backend/claude/cli/args.ts` from `8080` to `3000`:
```typescript
const defaultPort = parseInt(getEnv("PORT") || "3000", 10);
```

---

### Issue #2: Static File Path Not Found

**Symptom**: Claude backend logged `serveStatic: root path '...\backend\claude\static' is not found` and returned 500 error for `/api/chat`

**Root Cause**: The webui backend was designed to serve its own frontend static files. When integrated with an external frontend (Vite on port 5173), the `static` directory doesn't exist.

**Fix**: Modified `backend/claude/app.ts` to skip static file serving when `staticPath` is empty:
```typescript
if (config.staticPath) {
  // Serve static assets only if path is configured
} else {
  // No static files - just return message for non-API routes
  app.get("*", async (c) => {
    if (c.req.path.startsWith("/api/")) {
      return c.text("Not found", 404);
    }
    return c.text("Claude API Backend - API endpoints: /api/chat, /api/projects, /api/abort/:requestId", 200);
  });
}
```

Also updated `backend/claude/cli/node.ts` to pass empty string for `staticPath`.

---

### Issue #3: TypeScript Compilation Errors

**Symptom**: Build failed with `TS6133: 'xxx' is declared but its value is never read`

**Root Cause**: Strict TypeScript config with `noUnusedLocals: true` and `noUnusedParameters: true`

**Fix**: Removed unused variables/imports:
- `RecordingControls.tsx`: Removed unused `recordingElapsed`
- `chatStore.ts`: Changed `(set, get)` to `(set)`
- `store/index.ts`: Removed unused `ConnectionStatus` import; changed `(set, get)` to `(set)`; changed `(state)` to `()` in functions that didn't use state

---

### Issue #4: Shared Types Import Path

**Symptom**: `Cannot find module '../../shared/types.ts'` errors

**Root Cause**: Copied `shared/` folder into `backend/claude/shared/` but imports expected it at `backend/shared/`

**Fix**: Moved shared folder to correct location:
```bash
mv backend/claude/shared backend/shared
```

Also generated missing `cli/version.ts`:
```bash
node scripts/generate-version.js
```

---

### Architecture Summary

```
┌──────────────────────────────────────────────────────────────┐
│  Frontend (5173) - Vite dev server                          │
│  └── React Router: /dashboard (sensor) | /chat (Claude)    │
│  └── Vite proxy: /api/chat, /api/projects → :3000           │
└────────────────────────────┬─────────────────────────────────┘
                             │
        ┌────────────────────┴────────────────────┐
        ▼                                         ▼
┌─────────────────────────┐         ┌─────────────────────────┐
│ Python Backend (8080)   │         │ Node.js Backend (3000)   │
│ FastAPI                  │         │ Hono.js                  │
│ • Sensor/BLE/Audio       │         │ • Claude Code SDK        │
│ • WebSocket /ws          │         │ • POST /api/chat         │
│                         │         │ • GET /api/projects      │
└─────────────────────────┘         └─────────────────────────┘
```

**Key Files Modified**:
- `backend/claude/cli/args.ts` - Port 3000 default
- `backend/claude/app.ts` - Skip static files
- `backend/claude/cli/node.ts` - Empty staticPath
- `frontend/src/components/recording/RecordingControls.tsx` - Remove unused var
- `frontend/src/store/*.ts` - Remove unused vars
- `backend/shared/types.ts` - Moved from claude/shared/

---

*Last updated: 2026-04-18 (Claude Code Chat Integration)*

---

## 13. Recordings, Voice Input & Extensions Suite (2026-04-24)

Full-day push adding three interlocking features: drag-in recording context,
dual-path voice-to-text (PC mic + ESP32 UDP mic), and a pluggable backend
extension system. Initial requirements in [`RECORDINGS_VOICE_EXTENSIONS_REQUIREMENTS.md`](RECORDINGS_VOICE_EXTENSIONS_REQUIREMENTS.md);
this section is the **authoritative final state**.

### 13.1 Shipped Features

| ID | Feature | Lives in | Requires |
|----|---------|----------|----------|
| F1 | Chat-page right-drawer listing past ESP32 recordings | Frontend | — |
| F2 | Drag a recording into ChatInput → attachment with CSV preview + audio URL | Frontend | — |
| F3 | PC microphone button → browser SpeechRecognition → textarea | Frontend | Chrome/Edge |
| F4 | Settings page `/settings` → Extensions tab | Frontend | — |
| F5 | `whisper-local` extension: 1-click install (pip + model download) + auto-start on boot | Backend + Frontend UI | — |
| F6 | ESP32 microphone button → `/ws/transcribe` → Whisper local inference | Backend + Frontend | F5 enabled |
| F7 | Voice language picker (9 BCP-47 languages) shared by F3 + F6 | Frontend | — |
| F8 | ESP32 audio level meter in chat toolbar | Frontend | UDP listener active |
| F9 | Dashboard: card-size slider with snap points + wheel-zoom sensitivity + resizable channel cards | Frontend | — |

---

### 13.2 New Backend Code

```
backend/
├── app/
│   ├── api/
│   │   ├── recordings.py            # NEW: list/meta/csv/audio endpoints
│   │   ├── extensions.py            # NEW: install/enable/SSE progress
│   │   └── websocket.py             # MODIFIED: /ws/transcribe + bcp47_to_whisper
│   ├── core/
│   │   ├── audio_bridge.py          # MODIFIED: add_audio_consumer / remove_audio_consumer
│   │   └── data_processor.py        # MODIFIED: auto-expand channels + reset()
│   ├── services/
│   │   └── connection_manager.py    # MODIFIED: reset data_processor on serial/BLE disconnect
│   ├── extensions/                  # NEW: entire package
│   │   ├── __init__.py
│   │   ├── base.py                  # Extension + InstallContext
│   │   ├── registry.py              # Hardcoded list of available extensions
│   │   ├── state.py                 # extensions_state.json persistence
│   │   ├── manager.py               # ExtensionManager singleton + InstallJob
│   │   └── whisper_local.py         # First extension
│   └── main.py                      # MODIFIED: register routers + lifespan hooks
└── extensions_state.json            # NEW: runtime state file
```

### 13.3 New Frontend Code

```
frontend/src/
├── api/
│   ├── recordingsApi.ts             # NEW: list/meta/csv/audioUrl
│   └── extensionsApi.ts             # NEW: list/install/SSE stream/enable
├── lib/
│   ├── speechRecognition.ts         # NEW: startSpeechRecognition + preflightMicrophone
│   └── attachments.ts               # MODIFIED: 'recording' kind + buildPromptWithAttachments
├── store/
│   └── chatStore.ts                 # MODIFIED: voiceLang + VOICE_LANGS + pendingAttachments
├── components/
│   ├── chat/
│   │   ├── RecordingsPanel.tsx      # NEW: right drawer
│   │   ├── ChatAudioStatus.tsx      # NEW: compact level meter
│   │   ├── ChatInput.tsx            # MODIFIED: mic/esp32/drag-drop logic
│   │   ├── ChatInputTools.tsx       # MODIFIED: new toolbar elements
│   │   └── ChatPage.tsx             # MODIFIED: mount RecordingsPanel, Settings button
│   └── settings/                    # NEW: entire directory
│       ├── SettingsPage.tsx         # Tabbed settings
│       └── ExtensionCard.tsx        # Install button + SSE progress + runtime stats
└── vite.config.ts                   # MODIFIED: /api/recordings + /api/extensions proxies
```

---

### 13.4 Key Design Decisions

**Why SpeechRecognition for PC mic (not Whisper)**
Zero cost, zero setup, built into Chromium. Downside: needs Google STT reachable
(China-blocked, but user is in UK so OK) and can't be fed non-mic audio streams.

**Why `asyncio.to_thread(subprocess.Popen)` for pip install (not `create_subprocess_exec`)**
`run.py` forces `WindowsSelectorEventLoopPolicy` which on Windows does **not**
support `asyncio.create_subprocess_exec` — it raises `NotImplementedError`.
Thread-based `subprocess.Popen` sidesteps the event-loop policy. Caught in the
wild as "NotImplementedError" surfaced as install failure.

**Why `uv pip install` fallback**
User's `.venv` was created by `uv` and has no `pip` module. `sys.executable -m pip`
fails with `No module named pip`. Fall back to `uv pip install --python <exe>`
which writes into the same venv.

**Why decouple UDP reader thread from model inference**
`_on_frame` runs on the UDP reader thread — must be cheap. It only appends to a
bytearray and, if ≥3s buffered, hands off to the event loop via
`asyncio.run_coroutine_threadsafe`. The event loop then spawns a thread pool job
(`asyncio.to_thread`) for the actual model call. Three layers of isolation keep
UDP, event loop, and CPU-heavy inference from stepping on each other.

**Why skip chunks and drop when busy**
`_transcribe_inflight=True` → incoming chunks are dropped, not queued. Rationale:
if CPU can't keep up, a queue would grow unbounded and the user would see
transcripts arriving minutes late. Skipping gaps is better than lag.

**Why pin transcription language**
`small` model's auto-detect is ~58% confident on noisy 3s chunks — result flips
between en/zh/de/ru every chunk, producing "天天 show with you ты тут все"
hallucinations. Frontend's `voiceLang` → `/ws/transcribe?lang=en-US` →
`bcp47_to_whisper('en-US')='en'` → `model.transcribe(..., language='en')`. Biggest
single quality win.

**Why audio pre-amplification (before model) not input gain (at mic)**
ESP32's physical input gain is fixed. Low-level audio (-55 dB RMS) gets pre-amped
to target peak -3 dBFS before the model sees it. Combined with a -55 dB RMS
silence threshold (skip entirely) this stops Whisper from pattern-matching noise
onto random tokens.

**Why `lastMicWrittenRef` reconciliation**
Without it: user manually corrects the transcript while the session is active →
next SR event rewrites with the old buffer → user's correction vanishes. With it:
pre-write check compares current textarea to "what we last wrote"; if different,
adopt user's version as new base and empty the final buffer.

---

### 13.5 Voice → Text Flow Scenarios

Both paths share the same textarea + `writeMicInput` reconciliation protocol.
Only the upstream audio source differs.

#### 13.5.1 Path A — PC Microphone (browser SpeechRecognition)

1. User selects `🌐 EN` → `chatStore.voiceLang = 'en-US'` → localStorage persisted
2. User clicks 🎤 → `ChatInput.handleMicClick()`
3. **Preflight**: `preflightMicrophone(500)` opens a throwaway `getUserMedia`
   stream, samples 500 ms of audio through an `AnalyserNode`, returns `{ok, rmsDb, deviceLabel}`
   - Permission denied → toast explains (NotAllowedError / NotFoundError / NotReadableError)
   - rmsDb ≤ -80 → warn but continue (surfaces "wrong default mic" bugs)
4. Seed session refs: `micBaseTextRef = input`, `micFinalRef = ''`,
   `lastMicWrittenRef = input`, `pcKeepListeningRef = true`
5. `spawnPcRecognition()` constructs a `webkitSpeechRecognition` with
   `continuous: true`, `interimResults: true`, `lang = voiceLang`
6. Browser → OS mic → Google STT → `onstart` event → UI flips to listening
7. User speaks → `onresult` events arrive with `newFinal` delta + `currentInterim`
8. Each event calls `writeMicInput(interim)`:
   ```
   current = chatStore.getState().input
   if current !== lastMicWrittenRef:
       micBaseTextRef = current        # user edited — adopt their version
       micFinalRef = ''                # forget our stale final buffer
   next = base + sep + final + interim
   lastMicWrittenRef = next
   setInput(next)
   ```
9. User falls silent 5-8s → Google STT emits `no-speech` error + `onend`
10. `onError('no-speech')` is in `SILENT_SPEECH_ERRORS` → ignored (console.log only)
11. `onEnd` → checks `pcKeepListeningRef`:
    - `true` + < 5 rapid restarts → `spawnPcRecognition()` again (seamless)
    - 5+ restarts within 1.5 s each → circuit-break, toast "no audio detected"
    - `false` → `resetVoiceSession()` (flush + clear refs + `setVoiceSource('idle')`)
12. User clicks 🎤 again → `pcKeepListeningRef = false` → `rec.stop()` → onend → reset

Key files: [`speechRecognition.ts`](frontend/src/lib/speechRecognition.ts),
[`ChatInput.tsx`](frontend/src/components/chat/ChatInput.tsx),
[`chatStore.ts`](frontend/src/store/chatStore.ts)

#### 13.5.2 Path B — ESP32 Microphone (Whisper-local)

1. User installed `whisper-local` in Settings → backend loaded `small` model on
   last boot, subscribed to `AudioBridge.add_audio_consumer(_on_frame)`
2. User selects `🌐 en-GB` → `voiceLang = 'en-GB'`
3. User clicks ESP32 button → `ChatInput.handleEsp32MicClick()`
4. Frontend opens WS: `new WebSocket('/ws/transcribe?lang=en-GB')`
   (Vite proxies `/ws/*` → Python :8080)
5. Backend handshake in `transcribe_endpoint`:
   - `bcp47_to_whisper('en-GB')` → `'en'`
   - `ext.set_active_lang('en')` — logs `active transcription language: auto → en`
   - Check if UDP listener up; if not, send `{kind:'notice', message:'...'}`
   - `ext.add_ws_client(ws)`: clear buffer (don't feed stale audio to new client),
     log `ws client connected — total clients=1`
   - Send `{kind:'ready'}`
6. ESP32 → UDP :8888 → `AudioBridge._read_loop` (daemon thread) `recvfrom(4096)`
7. For each 256-byte frame: compute RMS/peak for the level meter, then:
   - `on_audio_data(frame)` → recording service (if recording)
   - Fan out to `_audio_consumers` → **`WhisperLocal._on_frame(frame)`**
8. `_on_frame` on the UDP thread:
   - `if not ws_clients: return` (zero-cost when idle)
   - `buffer.extend(frame)`; `frame_count += 1`
   - Every 200 frames (~3s @ ESP32's 64 fps): heartbeat log `rx frames=200 ...`
   - `len(buffer) ≥ 96000` (3s × 16kHz × 2 bytes)? → slice a chunk
   - If `_transcribe_inflight` → drop chunk + log (CPU can't keep up, lag prevention)
   - Else → `asyncio.run_coroutine_threadsafe(_transcribe_and_broadcast(chunk))`
9. `_transcribe_and_broadcast(chunk)` on the event loop:
   - `_transcribe_inflight = True`; `t0 = perf_counter()`
   - `text = await asyncio.to_thread(self.transcribe_pcm16, chunk)` — thread-pool
10. `transcribe_pcm16(chunk)` on a worker thread:
    - PCM16 → float32 `[-1, 1]` via `np.frombuffer / 32768`
    - Compute `rms_db, peak_db`
    - `rms_db < SILENCE_RMS_DB(-55)` → return `""` (skip noise)
    - `peak < -3 dBFS` → `audio *= gain` (pre-amp quiet audio)
    - `model.transcribe(audio, beam_size=5, language=self._active_lang, vad_filter=True)`
    - Log detected language + probability + char count
    - Return joined text
11. Back in `_transcribe_and_broadcast`:
    - Empty text → `empty_transcribes++`, log, return
    - Non-empty → log `text='...'`, build `{kind:'partial', text}`
    - Fan out: `await ws.send_json(payload)` to every client, stale-collect failures
    - Log `delivered to X/Y clients`
    - `_transcribe_inflight = False`
12. Frontend `ws.onmessage`:
    - `msg.kind === 'partial'` → append `msg.text` to `micFinalRef` with separator
      → `writeMicInput('')` → textarea updates (with the same `lastMicWrittenRef`
      reconciliation as Path A)
    - `msg.kind === 'error'` → toast + close WS
    - `msg.kind === 'notice'` → toast
    - `msg.kind === 'ready' / 'ping'` → no-op
13. User clicks ESP32 again → `ws.close()`
14. Backend `WebSocketDisconnect` → `ext.remove_ws_client(ws)` →
    if no other clients, clear buffer + log
15. Frontend `onclose` → `resetVoiceSession` → UI back to idle

Key files: [`audio_bridge.py`](backend/app/core/audio_bridge.py),
[`whisper_local.py`](backend/app/extensions/whisper_local.py),
[`websocket.py`](backend/app/api/websocket.py),
[`ChatInput.tsx`](frontend/src/components/chat/ChatInput.tsx)

#### 13.5.3 Shared Invariants

- **Single active voice source**: `voiceSource: 'idle' | 'pc' | 'esp32'`. Starting
  one path auto-stops the other.
- **`lastMicWrittenRef === input`** ⇒ last setInput was ours. User edit breaks
  this equality → next SR/WS event reconciles.
- **Never auto-submit**: both paths only mutate the textarea; user must press
  Enter to send. Protects against misrecognition auto-firing to Claude.

---

### 13.6 Whisper Tuning Knobs (`whisper_local.py` class constants)

| Constant | Default | Meaning |
|----------|---------|---------|
| `DEFAULT_MODEL` | `"small"` | HuggingFace model ID. `tiny`/`base`/`small`/`medium`/`large-v3` |
| `SAMPLE_RATE` | 16000 | Must match ESP32 UDP stream |
| `CHUNK_SECONDS` | 3.0 | Transcribe every N seconds of buffered audio |
| `SILENCE_RMS_DB` | -55.0 | RMS below this → skip chunk entirely (no model call) |
| `TARGET_PEAK_DBFS` | -3.0 | Pre-amp target for quiet audio |
| `BEAM_SIZE` | 5 | Decoder beam search width. Higher = better quality, slower |

Changing any constant requires a backend restart (class is loaded at module
import time). `_active_lang` is set live via the WS `?lang=` query param.

### 13.7 Dashboard UX Refinements (same session)

| Area | Change | Rationale |
|------|--------|-----------|
| Serial port `<select>` | `min-w-0 + truncate` + `title` tooltip; 38-char option clip; baud `<select>` → `shrink-0` | Long device descriptions blew out the flex row |
| DisplaySettings | Added Card Size slider (0.6-2.1×, magnetic snaps at 0.7/0.85/1.0/1.25/1.5/2.0) | User-controllable "zoom" over all cards |
| DisplaySettings | Added Wheel Zoom Step slider (2-40%, snaps 5/10/15/20/30) | Tunable wheel zoom sensitivity |
| DisplaySettings | `<datalist>` tick marks + label row under every snap slider | Makes snap positions discoverable |
| ChannelCard | Wheel zoom uses native `addEventListener('wheel', {passive:false})` instead of React `onWheel` | React's passive listener can't `preventDefault()`, so page scrolled alongside |
| ChannelCard | Double-click chart → reset to auto; `↺ auto` pill in corner when manually zoomed | Without reset entry point, user got stuck |
| ChannelCard | Dimensions (padding/value font/chart height/margins) = `ref × cardScale` inline style | All cards resize in lockstep when slider moves |
| `data_processor.py` | Auto-grow `channel_names` when wider row arrives; reset on serial/BLE disconnect | Cold-start truncated first packet was locking channel count at 2 forever |

### 13.8 Bug Fix Log (2026-04-24)

| # | Component | Symptom | Root cause | Fix |
|---|-----------|---------|-----------|-----|
| B1 | Dashboard | Only 2 channels rendering, serial data has more | First CSV line came in partial; `data_processor` locked `channel_names = ['CH1','CH2']`; subsequent rows truncated to 2 | `data_processor.process_csv_line` now appends `CH{N}` entries when a wider row arrives (capped at `max_channels`); `reset()` clears state on serial/BLE disconnect |
| B2 | Whisper install | "Last error: NotImplementedError()" on every Install click | `run.py` set `WindowsSelectorEventLoopPolicy`; `asyncio.create_subprocess_exec` is not supported → raises `NotImplementedError` | Rewrote `_run_and_stream` to use `asyncio.to_thread(subprocess.Popen)` + thread-based stdout pump |
| B3 | Whisper install | pip install fails with "No module named pip" in uv-managed venv | `uv venv` doesn't install pip by default | Added `uv pip install --python sys.executable` fallback after pip failure detection |
| B4 | Whisper install | Stale "NotImplementedError" in `extensions_state.json` survived restart | Old backend process kept running in background; `state.json` carries the error from the last failed attempt | Manager now clears `last_error` at install **start**, not just on success |
| B5 | Backend diagnostics | `print()` output invisible on Windows | Default stdout line-buffering | Launch backend with `python -u`; all extension logs use `print(..., flush=True)` via `_log()` helper |
| B6 | PC mic | Spammy `no-speech` alert every 5-8 s | Continuous mode auto-fires `no-speech` on silence; our code `window.alert`'d every one | Introduced `SILENT_SPEECH_ERRORS`; those codes now `console.log`-only |
| B7 | PC mic | Session silently stops after silence | Chrome ends continuous recognition on no-speech error | Auto-restart: `pcKeepListeningRef` + `spawnPcRecognition()` from `onEnd` if still wanted, with 5-restart-in-1.5s circuit breaker |
| B8 | PC mic | User edits to textarea get overwritten by next SR event | SR events rebuilt from `base + final` even after user diverged | `lastMicWrittenRef` reconciliation: if current input differs from last write, adopt current as new base |
| B9 | PC mic | "没声音" / wrong device | Browser picked "Steam Streaming Microphone" virtual device (-200 dB) | `preflightMicrophone()` surfaces device name + RMS before SR starts, so users see which mic is actually selected |
| B10 | PC mic | `alert()` popups could block Chrome's mic-permission dialog | `window.alert` steals focus | Replaced with `onModeChangeAnnounce` toast (non-blocking) |
| B11 | Whisper transcription | Quality poor, multi-language hallucinations ("天天 show with you ты тут...") | Auto-detect per 3s chunk unstable on noisy audio at 0.58 confidence | Frontend passes `voiceLang` → backend `set_active_lang()` pins `language=...` on model |
| B12 | Whisper transcription | Model hallucinates text from pure noise | Chunks with RMS=-55 dB got fed to the model | `SILENCE_RMS_DB = -55.0` threshold skip before `model.transcribe` |
| B13 | Whisper transcription | Quiet audio under-recognized | Model trained on normalized audio; raw input too quiet | Pre-amp to `TARGET_PEAK_DBFS = -3` before transcribe |

### 13.9 Diagnostics

**Whisper extension runtime stats** (visible in `/settings` → Extensions card
runtime panel, or via `GET /api/extensions/whisper-local`):

```json
{
  "model_name": "small",
  "model_loaded": true,
  "active_lang": "en",
  "beam_size": 5,
  "ws_clients": 1,
  "frames_received": 12345,
  "buffer_bytes": 18432,
  "chunks_dispatched": 42,
  "chunks_dropped_busy": 3,
  "transcribe_count": 39,
  "empty_transcribes": 12,
  "last_transcribe_ms": 458.2,
  "last_text_preview": "hello world ...",
  "last_frame_age_sec": 0.03
}
```

**Backend log prefixes** (`python -u run.py` for live stdout):

- `[whisper] ...` — Whisper extension lifecycle, UDP frame heartbeat, transcribe start/end
- `[Audio] ...` — UDP listener lifecycle
- `[Extensions] ...` — Extension manager actions
- `[DataProcessor] ...` — Channel auto-grow, state reset

**Frontend console prefixes**:

- `[speech] ...` — Browser SpeechRecognition lifecycle (all levels `console.log` so Verbose filter not required)
- `[mic] ...` — ChatInput mic session state, preflight results, auto-restart decisions

### 13.10 Testing Checklist

**Path A: PC mic → textarea**

- [ ] `🌐` picker shows 9 languages; select persists to localStorage
- [ ] 🎤 first click → Chrome mic permission prompt → allow
- [ ] Console shows `[speech] preflight got stream from device: ... RMS=-XXdB`
- [ ] Speaking "hello world" → textarea updates live
- [ ] Manually edit textarea → speak more → edit preserved + new speech appended
- [ ] 8s silence → `[mic] silent end — auto-restart #1` → red dot stays on
- [ ] Click 🎤 again → red dot clears, no more restarts
- [ ] Enter sends message

**Path B: ESP32 mic → textarea**

- [ ] Dashboard Audio Connect → `[Audio] UDP listener started on port 8888`
- [ ] Chat toolbar shows ChatAudioStatus green dot + live dB
- [ ] Select `🌐 en-GB`
- [ ] Click ESP32 → backend logs `ws client connected`, `active transcription language: auto → en`
- [ ] Speak to ESP32 mic → backend log chain:
    - `rx frames=200 buffer=... ws_clients=1`
    - `dispatch chunk #N`
    - `transcribe start: ... RMS=-XXdB peak=-XXdB`
    - `→ pre-amp gain +XX.XdB` (when applicable)
    - `transcribe model result: lang=en (0.98), pinned=en, chars=N`
    - `transcribe done in XXXXms → text='...'`
- [ ] Textarea fills with transcription
- [ ] `GET /api/extensions/whisper-local` shows live runtime counters

**Cross-path**

- [ ] PC listening → click ESP32 → PC auto-stops, ESP32 starts
- [ ] ESP32 listening → click PC → ESP32 auto-stops, PC starts
- [ ] Any path listening → manually edit textarea → next chunk appends to edited text

---

## 14. Tool Permissions & Interactive Picker (2026-04-26)

> Wraps the SDK's `canUseTool` callback into an inline Web-chat experience.
> Two interaction surfaces ship together: a generic Allow / Deny / custom-reply
> bubble for any tool, plus a VS-Code-style numbered picker that takes over
> when the tool is `AskUserQuestion`. The user can drive everything from the
> keyboard.

### 14.1 Shipped Features

- **Five permission modes** wired through the toolbar pill (cycle):
  `Ask before edit` (`default`), `Edit auto` (`acceptEdits`), `Bypass`
  (`bypassPermissions`), `Plan` (`plan`), `Auto` (`auto` — SDK's built-in
  classifier picks per tool).
- **Inline Allow / Deny bubble** for every prompted tool call. Three primary
  choices: `Allow once`, `Allow always` (when the SDK supplies suggestions),
  `Deny` → opens a textarea so the user can write a reason that's fed back
  to Claude verbatim.
- **VS-Code-style picker** for `AskUserQuestion`: numbered rows, ↑↓
  navigation across all questions, `1`–`9` jump-pick, `Space` toggle,
  `Tab` to Submit, `Cmd/Ctrl+Enter` send. Free-text textarea below
  overrides the picks.
- **Decision is recorded in chat history**: the bubble collapses to a one-line
  status (`✓ Allowed`, `✓ Answered — 开发工具: …`, `✗ Denied — <reason>`)
  so the user can scroll back and audit what they approved.
- **Abort safety**: when the user aborts mid-turn, all outstanding permission
  Promises resolve with deny so the SDK unwinds cleanly; outstanding bubbles
  flip to "Request was no longer pending".

### 14.2 Architecture — How a Tool Call Reaches the User

```
Claude SDK iterates …
   │ wants to run Bash("rm -rf foo")
   ▼
canUseTool(toolName, input, opts)         ← backend callback
   │ creates permissionId = uuid()
   │ pendingPermissions.set(id, {resolve, requestId, originalInput})
   │ pushes StreamResponse{type: 'permission_request', permission: {…}}
   │ awaits Promise<PermissionResult>
   ▼  (chunk flows through NDJSON to frontend)
useStreamParser sees 'permission_request'
   │ addMessage({type: 'permission_request', decided: {status: 'pending'}, …})
   ▼
ChatMessages renders <PermissionRequestComponent>
   │ user clicks Allow / Deny / submits picker answers
   │ POST /api/chat/permission { id, decision: {behavior, …} }
   ▼
handlePermissionResponse → resolvePendingPermission(id, decision)
   │ builds SDK PermissionResult (fills updatedInput on allow)
   │ entry.resolve(result)  ← un-blocks canUseTool
   ▼
SDK proceeds with the (allowed/denied) tool call
```

The whole loop is single-stream: the same NDJSON connection that delivers
assistant text also carries permission prompts. The frontend just adds a new
`StreamResponse.type` and a new message kind in the store.

### 14.3 Backend — Async Queue Model

The original `executeClaudeCommand` was a one-line generator:

```ts
for await (const m of query(opts)) yield {type:"claude_json", data:m};
```

That can't host a `canUseTool` callback because the callback needs to push
events onto the same outbound stream while the SDK is still pulling. The
refactor flips the producer from "directly yields" to "pushes into a queue
that the outer generator drains":

```ts
const queue: StreamResponse[] = [];
let waker: (() => void) | null = null;
let producerDone = false;

const push = (chunk: StreamResponse) => { queue.push(chunk); waker?.(); waker = null; };

const canUseTool: CanUseTool = (toolName, input, opts) => new Promise(resolve => {
  const id = randomUUID();
  pendingPermissions.set(id, {resolve, requestId, originalInput: input});
  push({type: "permission_request", permission: {id, toolName, input, …}});
  opts.signal.addEventListener("abort", () => {
    if (pendingPermissions.delete(id)) resolve({behavior:"deny", message:"aborted"});
  });
});

(async () => {
  try {
    for await (const sdkMessage of query({...opts, canUseTool})) {
      push({type: "claude_json", data: sdkMessage});
    }
  } finally { producerDone = true; abortPendingPermissionsForRequest(requestId); waker?.(); }
})();

while (!producerDone || queue.length) {
  if (queue.length) yield queue.shift()!;
  else await new Promise<void>(r => waker = r);
}
yield {type: "done"};
```

Two invariants the queue model preserves:

1. **Order**: the user always sees `permission_request` before any subsequent
   `claude_json` because both go through the same FIFO queue.
2. **No leaks on abort**: `abortPendingPermissionsForRequest` runs in
   `finally` AND in the catch block AND in the outer try's finally — three
   chances to release every Promise so the SDK can unwind without hanging.

### 14.4 SDK Schema Trap — Allow Requires `updatedInput`

The TS type says `updatedInput?: Record<string, unknown>` but the runtime Zod
schema rejects `undefined`. Sending `{behavior: "allow"}` blows up with:

```
ZodError: ["updatedInput"] expected record, received undefined
```

Fix: stash the original tool input alongside the resolver and default
`updatedInput` to it on plain allow. The user can still customise input by
sending `decision.updatedInput` from the frontend (not exposed in the UI yet,
but the wire shape supports it).

### 14.5 Frontend — Bubble Anatomy

```
┌────────────────────────────────────────────────┐
│ ┃ 🔐  Claude wants to run Bash                  │   ← ┃ = 2px amber
│ ┃    rm -rf foo                                 │       (or blue for
│ ┃    ▶ Show full input                          │       AskUserQuestion)
│ ──────────────────────────────────────────────  │
│   [Allow once]  [Allow always]  [Deny]   …     │
└────────────────────────────────────────────────┘
                   after answer
┌────────────────────────────────────────────────┐
│ ┃ 🔐  Claude wants to run Bash                  │
│   ✓ Allowed                          19:03:38  │
└────────────────────────────────────────────────┘
```

The bubble uses neutral `card-bg` / `card-border` so it visually matches
other chat bubbles. The 2px coloured left rule is the only intent cue —
amber for permission prompts, blue for the question picker.

### 14.6 AskUserQuestion Picker — Keyboard Map

| Key                | Action                                                    |
| ------------------ | --------------------------------------------------------- |
| `↑` / `↓`          | Move cursor; wraps across questions at edges              |
| `1`–`9`            | Pick option N in the active question (toggle for multi)   |
| `Space`            | Toggle option at cursor (multi-select)                    |
| `Enter`            | Pick + advance to next question (single-select)           |
| `Tab` / `Shift+Tab`| Native focus through textarea → Submit button             |
| `Cmd/Ctrl+Enter`   | Submit from anywhere                                      |
| `Esc` (in textarea)| Bail back to the option list                              |

The picker auto-focuses on mount so the user can answer without ever touching
the mouse. The textarea below the options is a fallback: typing anything
non-empty there overrides selections and the typed text is sent verbatim as
the answer.

### 14.7 Wire Format

**Stream chunk** (backend → frontend):

```ts
{
  type: "permission_request",
  permission: {
    id: "uuid",                          // permission resolution key
    toolName: "Bash" | "AskUserQuestion" | …,
    input: Record<string, unknown>,      // tool's args verbatim
    toolUseId: string,                   // SDK's tool_use id (for pairing)
    title?: string,                      // pre-rendered prompt from SDK
    displayName?: string, description?: string,
    decisionReason?: string, blockedPath?: string,
    suggestions?: PermissionSuggestion[],// "always allow" rules to echo back
  }
}
```

**Decision response** (`POST /api/chat/permission`):

```ts
{
  id: string,
  decision:
    | { behavior: "allow", updatedInput?: …, acceptedSuggestions?: … }
    | { behavior: "deny",  message: string }
}
```

`AskUserQuestion` answers go through `behavior: "deny"` with the formatted
answer string in `message` — the SDK has no first-class "user answered"
return shape, so the deny channel doubles as the reply path. The frontend
suppresses the resulting `is_error: true` tool_result for `AskUserQuestion`
so the chat history isn't littered with red ⚠️ bubbles.

### 14.8 New Files / Touched Files

**Backend** (Hono + agent SDK):

- `backend/shared/types.ts` — `StreamResponse.type` extended; new
  `PermissionRequestPayload`, `PermissionDecisionWire`, `PermissionSuggestion`.
- `backend/claude/handlers/chat.ts` — async-queue refactor + `canUseTool`
  + `pendingPermissions` map + `resolvePendingPermission` exported.
- `backend/claude/handlers/permission.ts` — new file; one-handler module
  for `POST /api/chat/permission`.
- `backend/claude/app.ts` — registers the new route.

**Frontend** (React + Zustand):

- `frontend/src/store/chatStore.ts` — `PermissionModeValue` adds `'auto'`;
  new `PermissionRequestMessage` type with `decided` discriminated union;
  `setPermissionDecision` action.
- `frontend/src/api/claudeApi.ts` — `StreamResponse` adds `permission_request`;
  new `respondPermission(id, decision)` method; `permissionMode` accepts `'auto'`.
- `frontend/src/hooks/useStreamParser.ts` — handles `permission_request`
  chunks; suppresses AskUserQuestion tool_results; closes outstanding
  pending bubbles when the stream ends.
- `frontend/src/components/chat/ChatInputTools.tsx` — adds `'auto'` to the
  permission cycle + relabels (`Ask before edit` / `Edit auto` / `Bypass` /
  `Plan` / `Auto`).
- `frontend/src/components/chat/ChatMessages.tsx` — `PermissionRequestComponent`
  + `AskUserQuestionPicker` + the existing `summarizeToolInput` helper.

### 14.9 Bug Fix Log (2026-04-26)

#### Bug #1: Tool bubbles can't be expanded — but only in release dir

**Symptom**: User reports clicking the green Bash/Read/Write tool bubbles does
nothing — no expand, no detail. Other collapsibles (Session Info, 💭 Reasoning)
work fine.

**Wrong assumption (mine)**: the React click handler is broken. Investigated
event bubbling, parent `pointer-events`, nested-button issues. Found nothing.

**Real cause**: I had been editing `d:/Imperial/individual/ainone-dashboard-v1.0.0`
(the release packaging dir) the entire session, while the user was running the
dev server out of `d:/Imperial/individual/esp32_sensor_dashboard`. Vite was
hot-reloading the *dev* dir's old code; my new code only existed in release.

**Diagnostic that broke the assumption**: "Other collapsibles work" — same
React pattern, same browser, same tab. So the bundle DID have working
collapsibles. The new tool-bubble code just wasn't in this bundle. Conclusion:
the running dev server has different source than the files I'm editing.

**Fix**: reverted release with `git checkout -- <files>`, copied the edits
from release → dev, pinned all future work to the dev folder.

**Lesson**: when the user lists multiple working directories in `cwd`s, the
*first* listed one is canonical for `cd`-less commands but the user's actual
project may be elsewhere. Always confirm by reading `git status` against the
suspected dev dir before editing.

#### Bug #2: ZodError on `Allow once`

**Symptom**: Clicking Allow → backend logs `ZodError: ["updatedInput"]
expected record, received undefined` → tool fails → red Tool error bubble.

**Wrong assumption (mine)**: SDK type says `updatedInput?` is optional; my wire
shape `{behavior: 'allow'}` should be fine.

**Reality**: the SDK's *runtime* Zod validator is stricter than the TS type —
`updatedInput` is required (as a record) on every `allow` reply, even when
unchanged.

**Fix**: store the original tool input in `pendingPermissions` so
`resolvePendingPermission` can default `updatedInput` to the unchanged input.
Permission-decision builder moved out of `permission.ts` (which had no access
to the input) and into `chat.ts` where the canUseTool closure has it.

**Lesson**: don't trust TS optionality when there's a runtime Zod schema
behind it. Quick check: search the SDK source for `z.record` / `z.object` and
see whether `.optional()` is applied. Or just send a probe and read the error.

#### Bug #3: Picker is too heavy / amber background hard to read in light mode

**Symptom**: User: "做的太复杂了 … 琥珀色在浅色模式下看不清". Each option
was a fat card with description below; whole bubble was filled amber.

**First simplification (rejected)**: kept the cards, just darkened amber for
light mode. User clarified: they wanted **VS-Code-style** — compact rows,
number shortcuts, free-text fallback.

**Final design**:

- One option = one row (label + dim description inline).
- Number chip on the left; selection turns it into ✓.
- Cursor row gets a subtle `card-hover` background, no bold colour.
- Card body uses `card-bg` (theme-aware) — amber/blue is now just a 2px left
  rule, an intent hint, not the dominant fill.
- Submit button uses `bg-blue-600` (interactive primary), reserves green
  exclusively for the "✓ Answered" / "✓ Allowed" status.

**Lesson**: when the user says "VS Code style" they mean *terminal-shaped*:
flat rows, keyboard-first, no decorative chrome.

#### Bug #4: Can't reach Submit with the keyboard

**Symptom**: User can navigate options with ↑↓ but Tab is intercepted to
cycle questions, so focus never reaches Submit, so `Enter` on Submit doesn't
work.

**Fix**: drop the custom Tab handler entirely. `↑/↓` now wraps across
questions at the edges (Q1 last → Q2 first), so cross-question nav stays in
the option list. Tab is left to the browser, which moves focus naturally:
picker root → textarea → Submit button. `focus:ring-2` on the button gives
a visible cue when it's the active focus target.

**Lesson**: don't fight the platform's focus model unless there's a real
reason. Native `Tab` ordering already does the right thing once the elements
are arranged in DOM order.

---

## 15. Whisper Streaming Quality, GPU Acceleration & Config Framework (2026-04-27)

This section documents the dev-branch Whisper overhaul. It rebuilds the
local-STT pipeline around streaming dedup + GPU acceleration, adds a
generic per-extension config + cache UI, and introduces a supervisor
process so model swaps that can't run in-place still feel like a single
click. The narrative-form debug journey lives in
[`POST_V1_0_0_DEBUG_JOURNEY.md`](POST_V1_0_0_DEBUG_JOURNEY.md) and
[`WHISPER_LOCAL_DEBUG_JOURNEY.md`](WHISPER_LOCAL_DEBUG_JOURNEY.md).

### 15.1 Shipped Features

| ID  | Feature                                                                    | Lives in                                    |
| --- | -------------------------------------------------------------------------- | ------------------------------------------- |
| W1  | Sliding-window streaming with overlap dedup + cross-window prompt          | Backend (`whisper_local.py`)                |
| W2  | CUDA auto-detection + float16 GPU / int8 CPU fallback + warmup pass        | Backend                                     |
| W3  | Smart per-platform default model (CUDA → turbo, Apple Silicon → small, …) | Backend                                     |
| W4  | Windows CUDA DLL path injection (PATH + `os.add_dll_directory`)            | Backend                                     |
| W5  | Project-local model cache under `VoiceModel/` (instead of HF default)      | Backend + `.gitignore`                      |
| W6  | Async background model load (lifespan no longer blocks on 1.5 GB download) | Backend                                     |
| W7  | Generic extension config schema + `on_config_change` hook + REST endpoint  | Backend (`base.py`, `manager.py`)           |
| W8  | Schema-driven settings UI (select / slider widgets + dirty-diff Apply)     | Frontend (`ExtensionConfigPanel.tsx`)       |
| W9  | "Restart required" badge + 3-min restart-poll state machine                | Frontend                                    |
| W10 | Cache management — list cached models + per-row delete                     | Backend + Frontend (`ExtensionCachePanel.tsx`) |
| W11 | Heavyweight-load (GPU tier) confirm dialog before save                     | Frontend                                    |
| W12 | Backend supervisor (`run.py`) + `POST /api/system/restart` (exit code 42)  | Backend                                     |
| W13 | Audio-file batch transcription on the Recordings drawer                    | Backend + Frontend                          |

In-process model swap is **disabled** — see § 15.7.

### 15.2 New / Modified Files

**Backend**

| File                                                                                            | Change                                                                                  |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [`backend/app/extensions/whisper_local.py`](backend/app/extensions/whisper_local.py)            | Rewritten: streaming dedup, GPU detect, async load, config schema, cache enumeration, file batch transcribe |
| [`backend/app/extensions/base.py`](backend/app/extensions/base.py)                              | New `get_config_schema`, `on_config_change`, `delete_cache_entry` hooks                 |
| [`backend/app/extensions/manager.py`](backend/app/extensions/manager.py)                        | `update_config(ext_id, patch)`, `delete_cache_entry`; config applied **before** `on_start` in both `init_from_state` and `enable` |
| [`backend/app/api/extensions.py`](backend/app/api/extensions.py)                                | `POST /api/extensions/{id}/config`, `POST /api/extensions/{id}/cache/delete`            |
| [`backend/app/api/recordings.py`](backend/app/api/recordings.py)                                | `POST /api/recordings/transcribe/{filename}` (batch transcribe a saved WAV)             |
| [`backend/app/api/system.py`](backend/app/api/system.py)                                        | **New file** — `POST /api/system/restart` returns 200, then `os._exit(42)` after 1 s    |
| [`backend/app/main.py`](backend/app/main.py)                                                    | Registers the `system` router                                                           |
| [`backend/run.py`](backend/run.py)                                                              | Replaced with supervisor: spawns `python -m uvicorn` as a subprocess and respawns on exit code 42 |

**Frontend**

| File                                                                                                                            | Change                                                  |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| [`frontend/src/components/settings/ExtensionConfigPanel.tsx`](frontend/src/components/settings/ExtensionConfigPanel.tsx)        | **New file** — generic select/slider widget renderer    |
| [`frontend/src/components/settings/ExtensionCachePanel.tsx`](frontend/src/components/settings/ExtensionCachePanel.tsx)          | **New file** — per-cache delete buttons + total size    |
| [`frontend/src/components/settings/ExtensionCard.tsx`](frontend/src/components/settings/ExtensionCard.tsx)                      | Mounts the new panels when the schema / cache list is non-empty |
| [`frontend/src/components/chat/RecordingsPanel.tsx`](frontend/src/components/chat/RecordingsPanel.tsx)                          | New `AudioRow` sub-component — Transcribe button, animated transcript panel via `grid-template-rows`, idle/loading/done/error states, Re-transcribe + dismiss |
| [`frontend/src/api/extensionsApi.ts`](frontend/src/api/extensionsApi.ts)                                                        | `updateConfig`, `deleteCache`, `restartBackend`         |
| [`frontend/src/api/recordingsApi.ts`](frontend/src/api/recordingsApi.ts)                                                        | `transcribeAudio(filename)`                             |
| [`frontend/vite.config.ts`](frontend/vite.config.ts)                                                                            | `/api/system` proxy (port 8080) added                   |
| [`.gitignore`](.gitignore)                                                                                                      | `VoiceModel/` and `extensions_state.json` excluded      |

### 15.3 Streaming Pipeline — Sliding-Window Dedup + Prompt Continuity

Defaults changed: `CHUNK_SECONDS 3.0 → 1.5`, `OVERLAP_SECONDS 0.5 → 0.3`.
Smaller windows lower latency (one transcribe arrives ~every 1.2 s of
real time instead of every 2.5 s) at the cost of less acoustic context
per decode — which the next two mechanisms restore.

**Two distinct text buffers** —
[`whisper_local.py:275-283`](backend/app/extensions/whisper_local.py#L275-L283):

- `_last_raw_text` — verbatim model output of the previous chunk. Fed
  back into the next call as `initial_prompt` (truncated to the trailing
  ~120 chars to fit Whisper's ~224-token prompt slot) so the decoder
  carries linguistic context across the overlap region.
- `_last_text` — what the user has actually seen, after dedup. Never
  fed back to the model.

**Overlap dedup** —
[`whisper_local.py:1200-1220`](backend/app/extensions/whisper_local.py#L1200-L1220).
Static helper `_strip_overlap_prefix(prev, new)` finds the longest `k`
where `prev[-k:] == new[:k]`, with a 4-char minimum and a 60-char cap.
Char-level (not word-level) so the same code path works for CJK and
space-separated languages. If the entire new chunk is already covered
by the overlap, broadcast is skipped but `_last_raw_text` is still
updated so the next chunk's prompt and dedup reference stays current —
[`whisper_local.py:1044-1053`](backend/app/extensions/whisper_local.py#L1044-L1053).

**Window advance** —
[`whisper_local.py:952-969`](backend/app/extensions/whisper_local.py#L952-L969).
Buffer is sliced to the full chunk size, then trimmed by `chunk - overlap`
(not by the full chunk). The trailing `OVERLAP_SECONDS` of audio stays
in the buffer to become the leading audio of the next chunk, so a word
that straddles a boundary appears whole in at least one chunk.

### 15.4 GPU Acceleration

**Auto-detect** —
[`whisper_local.py:506-539`](backend/app/extensions/whisper_local.py#L506-L539).
`ctranslate2.get_cuda_device_count() > 0` selects CUDA + `float16`;
construction failure falls back to CPU + `int8`. Float16 is the sweet
spot on Ada/Ampere — half the memory bandwidth of float32, natively
accelerated by tensor cores. `int8_float16` is ~10 % faster but slightly
less robust on noisy audio, so the default is plain `float16`.

**Smart default model** —
[`whisper_local.py:100-126`](backend/app/extensions/whisper_local.py#L100-L126).

| Platform                 | Default model    | Rationale                                                              |
| ------------------------ | ---------------- | ---------------------------------------------------------------------- |
| Windows / Linux + CUDA   | `large-v3-turbo` | Near-large-v3 quality, ~6× faster on tensor cores                      |
| Apple Silicon (arm64)    | `small`          | faster-whisper has no MPS support — CPU only; small is the largest snappy size |
| Intel Mac                | `base`           | Older hardware, conservative                                           |
| Plain CPU (no CUDA)      | `small`          | Acceptable on modern x86; users can downgrade to `base`/`tiny`         |
| Pre-install (no CT2 yet) | `base`           | Failure-tolerant fallback; corrected by `on_config_change` post-install |

**Warmup pass** —
[`whisper_local.py:547-591`](backend/app/extensions/whisper_local.py#L547-L591).
Right after model load, one dummy transcribe is driven through the
freshly-loaded model with low-amplitude white noise (not pure silence,
which the VAD might swallow). This forces CUDA kernel JIT, cuDNN handle
init, and CT2 internal allocators all to happen at boot instead of
during the user's first real chunk. Costs ~3-8 s on a 4060, ~1-2 s on
CPU, paid once.

**Windows CUDA DLL injection** —
[`whisper_local.py:467-491`](backend/app/extensions/whisper_local.py#L467-L491).
This is the highest-impact line of code in the rewrite. CT2 can construct
a CUDA model using just `nvcuda.dll` (already in `C:\Windows\System32`),
so model load misleadingly succeeds even when the cuBLAS DLLs aren't
discoverable. The first matmul then needs `cublas64_12.dll`, which lives
inside the `nvidia-cublas-cu12` pip wheel at
`<venv>/Lib/site-packages/nvidia/cublas/bin/`. Without that path on the
DLL search order, CT2's internal generator iteration **hangs forever**
instead of raising — see § 2 of `WHISPER_LOCAL_DEBUG_JOURNEY.md`.

The fix prepends every `nvidia/*/bin` directory to **both** `os.environ["PATH"]`
and `os.add_dll_directory`. `os.add_dll_directory` alone is insufficient
because CT2's native code uses bare `LoadLibrary`, which only consults
the legacy DLL search order (PATH being the last entry). macOS / Linux
skip this entirely — CT2 ships `.dylib` / `.so` bundled inside the
`ctranslate2` wheel, and the dynamic loader resolves them via
`@rpath` / RPATH.

### 15.5 Project-Local Model Cache

[`whisper_local.py:86`](backend/app/extensions/whisper_local.py#L86) —
`MODELS_DIR = BASE_DIR / "VoiceModel"` (`BASE_DIR` resolves to the
project root, not `backend/`). Passed through as
`WhisperModel(..., download_root=str(MODELS_DIR))`. The HF cache layout
is preserved (`models--<org>--<repo>/snapshots/...`) so faster-whisper
resolves paths normally; only the parent dir is overridden. Effects:

- Models stay inside the repo — easier to back up, ship to a
  collaborator, or wipe when iterating.
- `VoiceModel/` is in `.gitignore` (per-model size 75 MB to 3 GB; not
  committable).
- The currently-cached set on this machine is `base`, `small`,
  `large-v3-turbo` (~2 GB total). Other models are downloaded on first
  use.

### 15.6 Async Background Model Load

[`whisper_local.py:595-619`](backend/app/extensions/whisper_local.py#L595-L619).
`on_start` no longer awaits `_load_model_blocking` — it subscribes to
`AudioBridge` first (so future arrivals are at least seen), then spawns
`_load_model_async` as `asyncio.create_task`. FastAPI's lifespan
completes in seconds even when the model needs a 1.5 GB download.

Three guards in `_on_frame` prevent crashes during the load window —
[`whisper_local.py:976-987`](backend/app/extensions/whisper_local.py#L976-L987):

- Model not loaded yet → drop chunk, increment `_not_ready_drop_count`,
  log every 20th drop.
- Previous transcribe still in-flight → drop chunk, increment
  `_drop_count`, log immediately.
- No event loop → log warning, return.

`on_stop` cancels any in-flight load before tearing down state —
[`whisper_local.py:660-684`](backend/app/extensions/whisper_local.py#L660-L684).
Otherwise the load task could finish AFTER on_stop returns and leak a
CUDA context with no owner.

### 15.7 In-Process Model Swap is Disabled

[`whisper_local.py:828-862`](backend/app/extensions/whisper_local.py#L828-L862).
Two attempts (sync reload + `gc.collect`, async load + `gc.collect`)
both crashed CT2 native code on the Windows + CUDA combination — the
CUDA destructor of the outgoing model can segfault when a fresh
allocation runs nearby, and Python can't catch it. The whole backend
process goes down with no traceback.

The runtime branch of `on_config_change` for `model_name` therefore:

1. Persists the new value via `manager.update_config` (already done by
   the manager before this hook is called).
2. Logs the deferral.
3. **Reverts the in-memory mirror** (`self._model_name`) back to the
   running model, so `status()` reflects what's actually loaded. The
   persisted config keeps the new value — `init_from_state` at next
   boot calls `on_config_change` *before* `on_start`, so the fresh
   process loads the new model directly.

The `requires_reload: true` schema flag on `model_name` surfaces this
in the UI as an amber "Restart required" badge plus a "Restart now"
button (see § 15.10).

**Disable also can't drop the model (v1.1.2).** Same destructor, same
crash class. Before the fix, toggling Whisper's enable switch off ran
`on_stop`, which set `self._model = None`; the local `inst` ref then
fell out of scope at the end of `manager.disable()`, GC ran the CT2
CUDA destructor, and the backend exited with `0xC0000409`
(`STATUS_STACK_BUFFER_OVERRUN`). The supervisor only respawns on exit
code 42, so it shut down too — leaving the user with HTTP 500 from
the frontend.

Fix is two-sided:

- `Extension` gains a `release_on_stop: bool = True` class attribute;
  `WhisperLocalExtension` overrides it to `False`.
- `ExtensionManager` keeps a parallel `_retained_instances` dict.
  `disable()` parks any `release_on_stop = False` instance there
  *after* `on_stop`; `enable()` pops it back, so the already-loaded
  model survives the toggle. `on_stop` itself no longer touches
  `self._model`.

Re-enable is essentially free: `on_start` already short-circuits the
load when `self._model is not None`, so the audio bridge resubscribes
and the existing CUDA model takes the next chunk. True VRAM release
still requires a backend restart — same rule as the swap path.

### 15.8 Configuration Framework

**Schema declaration on the class** —
[`base.py:64-93`](backend/app/extensions/base.py#L64-L93).
`Extension.get_config_schema()` returns a list of field descriptors:

```python
{
  "key":   "model_name",
  "type":  "select" | "slider",
  "label": "Model",
  "default": <any>,
  "options" / "option_groups": [...],   # for select
  "min" / "max" / "step": ...,          # for slider
  "requires_reload": bool,
  "help": "..."
}
```

`option_groups` is the grouped form (`<optgroup>` in the UI) —
Whisper's groups are `CPU-friendly` (`tiny`, `base`, `small`) and
`GPU recommended` (`medium`, `large-v3`, `large-v3-turbo`,
`distil-large-v3`).

**Whisper config fields** —
[`whisper_local.py:155-227`](backend/app/extensions/whisper_local.py#L155-L227):

| Key               | Type   | Range / options                  | Default                         | Reload? |
| ----------------- | ------ | -------------------------------- | ------------------------------- | ------- |
| `model_name`      | select | 7 models in 2 option groups      | platform-smart                  | yes     |
| `chunk_seconds`   | slider | 0.8 – 5.0, step 0.1              | 1.5                             | no      |
| `overlap_seconds` | slider | 0.0 – 1.0, step 0.05             | 0.3                             | no      |
| `beam_size`       | slider | 1 – 10, step 1                   | 5                               | no      |

`on_config_change` —
[`whisper_local.py:787-868`](backend/app/extensions/whisper_local.py#L787-L868).
Hot fields (chunk / overlap / beam) are simple field assignments that
the next dispatched chunk picks up — no downtime. `overlap` is clamped
to `< chunk - 0.1` so the buffer always advances. `beam` is clamped to
`>= 1`.

**Manager glue** —
[`manager.py:246-280`](backend/app/extensions/manager.py#L246-L280).
`update_config(ext_id, patch)` does a shallow merge into the persisted
state, **then** calls the running instance's `on_config_change` (if
any). Persistence happens before the hook so a config write survives
even if the subsystem reload fails. Returns the full merged config so
the API caller doesn't need a re-read.

**Init order** —
[`manager.py:62-88`](backend/app/extensions/manager.py#L62-L88) and
[`manager.py:192-211`](backend/app/extensions/manager.py#L192-L211).
Both `init_from_state` (lifespan startup) and `enable` (user toggled
on) now run `on_config_change(persisted_config)` **before** `on_start`.
This is what lets the freshly-spawned process boot directly into the
user's chosen model — no double-load.

**REST surface** —
[`extensions.py:130-173`](backend/app/api/extensions.py#L130-L173):

- `POST /api/extensions/{id}/config` — body is a partial patch; merges
  into persisted config and returns the full merged config.
- `POST /api/extensions/{id}/cache/delete` — body `{"key": "<name>"}`;
  401 → 400/404/501 mapping documented in the route docstring.

### 15.9 Schema-Driven Settings UI

[`ExtensionConfigPanel.tsx`](frontend/src/components/settings/ExtensionConfigPanel.tsx).
Generic — no per-extension code. Each schema entry's `type` selects the
widget and the rest parameterises it.

- **Dirty-diff Apply** — `pending` state tracks user edits;
  `dirtyKeys = schema.filter(f => pending[f.key] !== currentConfig[f.key])`.
  Apply sends only the dirty keys (so the backend's shallow merge doesn't
  overwrite values we never touched).
- **Reset to defaults** — sets `pending` to `Object.fromEntries(schema.map(f => [f.key, f.default]))`,
  not back to `currentConfig`. Distinct from "discard edits" — the more
  useful escape hatch.
- **Heavyweight-load warning** — before save, every dirty `select` field
  whose new value sits in an `option_groups` entry whose label matches
  `/gpu/i` triggers a `window.confirm`. Generic on the schema; any
  extension can opt-in by labelling a group `GPU recommended`.
  [`ExtensionConfigPanel.tsx:124-142`](frontend/src/components/settings/ExtensionConfigPanel.tsx#L124-L142).
- **Restart-required badge** — visible when at least one
  `requires_reload` field is dirty OR has been applied but the running
  `runtime[key]` still differs from the configured value. The badge
  must stay visible **after** Apply because in-process model swap is
  disabled — the user still has work to do until they restart.
  [`ExtensionConfigPanel.tsx:108-117`](frontend/src/components/settings/ExtensionConfigPanel.tsx#L108-L117).

### 15.10 Restart Flow

```
User clicks "Restart now"
   │
   ▼
ConfigPanel: POST /api/system/restart           ← restartPhase: 'requesting'
   │
   ▼
Backend (system.py): respond 200, then
   asyncio.create_task(_delayed_exit())
   await asyncio.sleep(1)
   os._exit(42)
   │
   ▼
run.py supervisor: child exit code 42 → respawn ← restartPhase: 'polling'
   │
   ▼
Frontend: poll /api/extensions every 1.5 s,
   timeout 3 min                                ← typical 10-30 s,
                                                   longer if Whisper
                                                   fresh-downloads
   │
   ▼
First successful poll → onChanged() refreshes  ← restartPhase: 'idle'
   parent so currentConfig matches runtime
```

[`ExtensionConfigPanel.tsx:160-205`](frontend/src/components/settings/ExtensionConfigPanel.tsx#L160-L205)
holds the polling state machine. 3 min timeout covers the worst case
(fresh `large-v3` download) without hanging the UI forever if the
supervisor itself was killed.

### 15.11 Cache Management

[`whisper_local.py:699-785`](backend/app/extensions/whisper_local.py#L699-L785).
`_enumerate_cached_models()` walks `MODELS_DIR` for any
`models--*--faster-whisper-*` directory and returns
`{name, size_bytes, size_human, is_active}`. The split happens on the
literal `--faster-whisper-` substring so model names containing dashes
(`large-v3`, `distil-large-v3`) survive intact.

`delete_cache_entry(key)` refuses to delete the live model (`key ==
self._model_name and self._model is not None`). The frontend disables
the delete button on the active row instead of letting the request hit
the server; the backend guard is a defence-in-depth.

`runtime.cached_models` is exposed via `status()` —
[`whisper_local.py:884-887`](backend/app/extensions/whisper_local.py#L884-L887) —
and rendered in
[`ExtensionCachePanel.tsx`](frontend/src/components/settings/ExtensionCachePanel.tsx)
as a list with per-row delete buttons and a total-size header.

### 15.12 Audio File Batch Transcription

[`whisper_local.py:1125-1198`](backend/app/extensions/whisper_local.py#L1125-L1198) —
`transcribe_audio_file(path)`. Three deliberate differences from the
streaming path (`transcribe_pcm16`):

1. **No silence gate / pre-amp** — offline audio is trusted to be
   well-recorded.
2. **No `initial_prompt` continuity** — each file is independent;
   carrying state from the live stream would pollute results.
3. **Single decode pass** — faster-whisper handles long audio
   internally via its own VAD-driven segmentation; chunking would
   actively hurt accuracy.

Returns `{text, language, language_probability, duration_seconds, transcribe_ms}`.

[`recordings.py:176-227`](backend/app/api/recordings.py#L176-L227) —
`POST /api/recordings/transcribe/{filename}`. Status code map:

| Code | Reason                                                          |
| ---- | --------------------------------------------------------------- |
| 400  | Filename doesn't match writer's regex / WAV format unexpected   |
| 404  | File doesn't exist on disk                                      |
| 503  | Whisper extension not enabled / model still loading             |
| 500  | Unexpected failure inside the model                             |

Frontend UI lives in `RecordingsPanel.tsx` as the new `AudioRow`
sub-component
([`RecordingsPanel.tsx:348-460+`](frontend/src/components/chat/RecordingsPanel.tsx#L348-L460)).
Highlights:

- Per-session transcript state stored in a `Map<sessionId, TranscriptEntry>`
  so clicking Transcribe on one row doesn't reset another's state.
- Animated transcript panel uses `display: grid` with
  `grid-template-rows` transitioning from `0fr` to `1fr` — the modern
  way to animate to/from intrinsic content height. No `max-height`
  guess, no abrupt collapse on long content.
- Three states: `idle` (Transcribe button), `loading` (animated dot +
  filename), `done` (transcript text + language + decode time +
  Re-transcribe button), `error` (red message + dismiss).

### 15.13 Backend Supervisor

[`backend/run.py`](backend/run.py) is now ~90 lines. The supervisor:

- Spawns `python -m uvicorn app.main:app --host 0.0.0.0 --port 8080` as
  a child via `subprocess.Popen`.
- Blocks on `proc.wait()`.
- On exit code 42 (`RESTART_EXIT_CODE`), respawns after a 1 s sleep.
- On any other code, exits with the child's code (preserves signal /
  error semantics).
- On `KeyboardInterrupt`, terminates the child gracefully (5 s timeout
  → kill), exits cleanly with the child's code.

Why subprocess instead of `os.execv`: on Windows `os.execv` is actually
`_spawnv`, which detaches stdout/stderr from the original terminal and
the supervisor's logs vanish. `subprocess.Popen` inherits parent file
handles cleanly on both Unix and Windows.

Why `os._exit(42)` not `sys.exit(42)` —
[`system.py:36-43`](backend/app/api/system.py#L36-L43) — `os._exit`
bypasses Python's atexit hooks, which can hang on background threads or
asyncio loops with pending tasks. The supervisor + OS clean up file
handles and sockets at process death; we don't need polite tear-down.

### 15.14 Diagnostic Counters

`status()` now exposes —
[`whisper_local.py:870-911`](backend/app/extensions/whisper_local.py#L870-L911):

```json
{
  "model_name": "large-v3-turbo",
  "model_loaded": true,
  "model_loading": false,
  "ws_clients": 1,
  "active_lang": "en",
  "chunk_seconds": 1.5,
  "overlap_seconds": 0.3,
  "beam_size": 5,
  "silence_rms_db": -55.0,
  "cached_models": [
    {"name": "base", "size_bytes": ..., "size_human": "...", "is_active": false},
    ...
  ],
  "frames_received": 12345,
  "buffer_bytes": 18432,
  "chunks_dispatched": 42,
  "chunks_dropped_busy": 3,
  "chunks_dropped_not_ready": 8,
  "transcribe_count": 39,
  "empty_transcribes": 12,
  "last_transcribe_ms": 458.2,
  "last_text_preview": "...",
  "last_frame_age_sec": 0.03
}
```

`chunks_dropped_not_ready` is new (chunks discarded while the async
load was still in flight); typically nonzero only during the first few
seconds after backend boot.

---

## 16. Cross-Session Search, Markdown Chat & Theme Overhaul (2026-04-28)

This section documents the v1.1.1 release. It adds a cross-session
full-text search surface inside the chat sidebar, ships markdown
rendering for chat message bodies, replaces the old paired drawers
with a single resizable two-pane layout, embeds an inline audio
preview on every recording row, fixes the session-summary extractor
that was silently dropping Claude's substantive replies, centres the
empty / loading states properly, and runs a top-to-bottom theme
overhaul (warm-charcoal chrome + clay-tan accent + sage; CSS-var
ladder; custom scrollbars; xterm palette themed; mass blue→accent
migration). Channel-trace colors are deliberately kept hard-coded so
chart legends stay readable across themes.

### 16.1 Shipped Features

| ID  | Feature                                                                          | Lives in                                       |
| --- | -------------------------------------------------------------------------------- | ---------------------------------------------- |
| R1  | `GET /api/sessions/search` — substring search across every `.jsonl` message      | Backend (`sessions.ts`)                        |
| R2  | Sidebar-embedded search input with debounce + keyboard nav                       | Frontend (`ChatSidebar.tsx`)                   |
| R3  | `firstAssistantMessage` second line in the session list                          | Backend + Frontend                             |
| R4  | `extractText` rewrite — concatenates all text blocks, surfaces `[tool: <name>]`  | Backend (`sessions.ts`)                        |
| R5  | Two-pane resizable layout (`react-resizable-panels` v4) replaces drawer toggles  | Frontend (`ChatPage.tsx`)                      |
| R6  | Inline `<audio>` preview on every recording row                                  | Frontend (`RecordingsPanel.tsx`)               |
| R7  | Markdown rendering for chat bodies via `react-markdown` + `remark-gfm`           | Frontend (`MessageMarkdown.tsx`)               |
| R8  | Empty + loading states centred to a `min-h-[60vh]` wrapper                       | Frontend (`ChatMessages.tsx`, `ChatPage.tsx`)  |
| R9  | Warm-charcoal + clay-tan + sage theme; CSS-var token ladder                      | Frontend (`index.css`, `tailwind.config.js`)   |
| R10 | Custom scrollbars matched to the warm palette (WebKit + Firefox)                 | Frontend (`index.css`)                         |
| R11 | xterm.js terminal palette themed to the warm-charcoal chrome                     | Frontend (`EmbeddedTerminal.tsx`)              |
| R12 | Connect / Scan / Start* → `bg-accent`; stop / disconnect → `bg-status-danger`    | Frontend (multiple components)                 |

### 16.2 New / Modified Files

**Backend**

| File                                                                                                  | Change                                                                                       |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [`backend/claude/handlers/sessions.ts`](backend/claude/handlers/sessions.ts)                          | New `handleSessionSearch`; rewritten `extractText`; `firstAssistantMessage` on summaries     |
| [`backend/claude/app.ts`](backend/claude/app.ts)                                                      | Registers `GET /api/sessions/search`                                                         |

**Frontend**

| File                                                                                                                         | Change                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [`frontend/src/components/chat/MessageMarkdown.tsx`](frontend/src/components/chat/MessageMarkdown.tsx)                       | **New file** — themed markdown renderer for chat bodies                                      |
| [`frontend/src/components/chat/ChatMessages.tsx`](frontend/src/components/chat/ChatMessages.tsx)                             | Mounts `<MessageMarkdown>`; centres empty state to `min-h-[60vh]`                            |
| [`frontend/src/components/chat/ChatPage.tsx`](frontend/src/components/chat/ChatPage.tsx)                                     | Two-pane `PanelGroup`; right panel collapsible; loading state centred                        |
| [`frontend/src/components/chat/ChatSidebar.tsx`](frontend/src/components/chat/ChatSidebar.tsx)                               | Inline search input + `SearchResultsView`; debounce + arrow-key nav                          |
| [`frontend/src/components/chat/RecordingsPanel.tsx`](frontend/src/components/chat/RecordingsPanel.tsx)                       | Inline `<audio controls preload="none">` per row                                             |
| [`frontend/src/api/claudeApi.ts`](frontend/src/api/claudeApi.ts)                                                             | `searchSessions()`; `SearchHit` type; `firstAssistantMessage` field on `SessionSummary`      |
| [`frontend/src/store/chatStore.ts`](frontend/src/store/chatStore.ts)                                                         | `firstAssistantMessage` field on `SessionSummary`                                            |
| [`frontend/src/components/shell/EmbeddedTerminal.tsx`](frontend/src/components/shell/EmbeddedTerminal.tsx)                   | xterm `DARK_THEME` / `LIGHT_THEME` palettes, sage green / muted ANSI, theme-reactive         |
| [`frontend/src/index.css`](frontend/src/index.css)                                                                           | Warm-charcoal + light-cream CSS-var ladder; custom scrollbars                                |
| [`frontend/tailwind.config.js`](frontend/tailwind.config.js)                                                                 | Token names — `accent` / `accent-hover` / `accent-soft` / `accent-warm`; channel colors stay |
| [`frontend/src/components/layout/ConnectionPanel.tsx`](frontend/src/components/layout/ConnectionPanel.tsx)                   | Connect / Scan / Start → `bg-accent`; disconnect / Stop → `bg-status-danger`                 |
| [`frontend/src/components/recording/RecordingControls.tsx`](frontend/src/components/recording/RecordingControls.tsx)         | Start Recording → `bg-accent`; Stop Recording → `bg-status-danger`                           |
| [`frontend/package.json`](frontend/package.json)                                                                             | Added `react-markdown`, `remark-gfm`, `react-resizable-panels` v4                            |

Other touched components (`Toast.tsx`, `ChannelCard.tsx`, `ChannelGrid.tsx`,
`ChatAudioStatus.tsx`, `ChatInput.tsx`, `ChatInputTools.tsx`,
`NewProjectDialog.tsx`, `SlashCommandMenu.tsx`, `Header.tsx`,
`DisplaySettings.tsx`, `ExtensionCachePanel.tsx`, `ExtensionCard.tsx`,
`ExtensionConfigPanel.tsx`, `SettingsPage.tsx`) are blue→accent migrations.

### 16.3 Cross-Session Full-Text Search

**Backend route** —
[`sessions.ts:374-475`](backend/claude/handlers/sessions.ts#L374-L475).
`handleSessionSearch` walks every `.jsonl` under `~/.claude/projects`,
running a case-insensitive substring scan (`text.toLowerCase().indexOf(lowerQ)`)
against every `user` / `assistant` message. Each match becomes a hit:

```ts
{ sessionId, cwd, messageRole, snippet, matchStart, matchEnd, timestamp }
```

Hits carry a ±150-char snippet with leading / trailing `…` markers when
truncated, and `matchStart` / `matchEnd` indexed **into the snippet**
(not the source message) so the frontend can highlight without
recomputing offsets. Default `limit=50`, hard cap 200; minimum query
length 2 chars (queries shorter than that short-circuit to an empty
result set instead of returning everything). Hits are sorted
newest-first by `timestamp`, and `took_ms` is reported in the
response. Brute-force is fine up to ~10k messages — see the file
docstring's note on switching to SQLite FTS5 if/when this gets slow.

Registered in [`app.ts:88`](backend/claude/app.ts#L88).

**Frontend client** —
[`claudeApi.ts:445-475`](frontend/src/api/claudeApi.ts#L445-L475).
`searchSessions(q, limit=50)` returns `{ hits, total, took_ms, error }`.
Errors are folded into the same shape so the caller doesn't need a
try/catch — the UI just inspects `error`. The shared `SearchHit` type
lives at [`claudeApi.ts:113-121`](frontend/src/api/claudeApi.ts#L113-L121).

**Sidebar UI** —
[`ChatSidebar.tsx:184-228`](frontend/src/components/chat/ChatSidebar.tsx#L184-L228)
holds the state machine; the input lives at
[`ChatSidebar.tsx:339-394`](frontend/src/components/chat/ChatSidebar.tsx#L339-L394).
Tunings:

| Constant                  | Value | Why                                                            |
| ------------------------- | ----- | -------------------------------------------------------------- |
| `SEARCH_DEBOUNCE_MS`      | 220   | One request per natural typing pause, not per keystroke         |
| `SEARCH_MIN_QUERY_LEN`    | 2     | "a" / "i" would match almost everything; not useful            |
| `SEARCH_RESULT_LIMIT`     | 50    | More wouldn't fit on screen anyway and starts feeling sluggish |

The search input is the same component as the project list — they
share the scroll container so the user's eye stays in one place when
the active query toggles between modes
([`ChatSidebar.tsx:401-411`](frontend/src/components/chat/ChatSidebar.tsx#L401-L411)).
Stale-response protection uses a monotonic `searchSeqRef`
([`ChatSidebar.tsx:198-228`](frontend/src/components/chat/ChatSidebar.tsx#L198-L228))
so a slow request that arrives after the user has already typed
something newer is dropped. Keyboard nav: ↑↓ moves through hits, Enter
opens the selected session, Escape clears the query.

### 16.4 Session Summary Improvements

**`extractText` rewrite** —
[`sessions.ts:78-98`](backend/claude/handlers/sessions.ts#L78-L98).
The old extractor only returned `blocks[0].text`. Claude's typical
turn is `[text, tool_use, text]` — so the actual answer (the second
text block, after the tool call) was being silently dropped. The
session list looked like Claude only ever said one short sentence.

The rewrite:

- Concatenates all `text` blocks with newline separators.
- Surfaces `tool_use` as `[tool: <name>]` so the reader knows there
  was a tool step, without dumping JSON params into the summary.
- Recurses into `tool_result.content` (which is itself a block list).

The same function powers the search snippet extractor
([`sessions.ts:434`](backend/claude/handlers/sessions.ts#L434)), so
search now sees Claude's full reply text instead of just the first
fragment.

**`firstAssistantMessage` on summaries** —
[`sessions.ts:202-209`](backend/claude/handlers/sessions.ts#L202-L209)
captures Claude's first **substantive** reply (text-bearing, not
tool-only) for each session and adds it to the summary alongside
`firstMessage` and `lastMessage`. Truncated to 140 chars at
[`sessions.ts:229`](backend/claude/handlers/sessions.ts#L229). The
sidebar uses this as a 2nd preview line so the user sees both their
question and Claude's take without having to open the session. The
substantive-reply guard is what prevents a tool-only first turn from
locking in `[tool: Read]` as the summary.

Plumbed through:
[`claudeApi.ts:113-121`](frontend/src/api/claudeApi.ts#L113-L121),
[`chatStore.ts:157`](frontend/src/store/chatStore.ts#L157).

### 16.5 Two-Pane Resizable Layout

[`ChatPage.tsx:854-980`](frontend/src/components/chat/ChatPage.tsx#L854-L980).
The old design had two independent drawer toggles ("Recordings"
button + "History" button), each opening its own slide-out panel.
v1.1.1 replaces both with a single horizontally-resizable
`PanelGroup` from `react-resizable-panels` v4:

```
+------------------------+ + +------------------+
|                        | | |  History (top)   |
|  Chat / Terminal       | | +------------------+
|  (left, ≥40%, 70% def) | | |  Recordings      |
|                        | | |  (bottom)        |
+------------------------+ + +------------------+
```

Both vertical panes inside the right column are independently
resizable too
([`ChatPage.tsx:960-978`](frontend/src/components/chat/ChatPage.tsx#L960-L978)),
so the user can grow whichever half is busier. The right panel is
**collapsible** — the `Focus mode` button in the header
([`ChatPage.tsx:823-843`](frontend/src/components/chat/ChatPage.tsx#L823-L843))
calls `rightPanelRef.current?.collapse()`, and the collapsed state is
persisted to `localStorage` under `chat-right-panel-collapsed`. On
first mount, if the stored value is `1`, the panel is collapsed via a
`queueMicrotask` so the imperative ref has registered by the time we
call it
([`ChatPage.tsx:121-128`](frontend/src/components/chat/ChatPage.tsx#L121-L128)).

API note: this uses v4 names — `Group` / `Panel` / `Separator` (not
the v3 `PanelGroup` / `PanelResizeHandle`). The aliases at the import
site keep the JSX readable
([`ChatPage.tsx:14-19`](frontend/src/components/chat/ChatPage.tsx#L14-L19)).

The drag handle is a 4 px line that turns accent-coloured on hover so
the user gets affordance feedback before clicking
([`ChatPage.tsx:945`](frontend/src/components/chat/ChatPage.tsx#L945)).
The inner cap (`max-w-4xl`) on the messages region was deliberately
removed because the panel layout already constrains width via the
user-resizable boundary; an inner cap would just re-introduce the
empty whitespace
([`ChatPage.tsx:874-878`](frontend/src/components/chat/ChatPage.tsx#L874-L878)).

### 16.6 Inline Audio Preview

[`RecordingsPanel.tsx:407-419`](frontend/src/components/chat/RecordingsPanel.tsx#L407-L419).
Every recording row now embeds a native `<audio controls>` element
streaming from `/api/recordings/audio/<filename>`:

```tsx
<audio controls preload="none" src={recordingsApi.audioUrl(audioFilename)} ... />
```

`preload="none"` is critical — without it the browser would `HEAD` /
prefetch metadata for every WAV in the list as soon as the panel
mounts. With it, metadata + buffering only kick in when the user
actually hits play. The user can listen to a recording before
deciding whether to attach it to chat or run Whisper transcription on
it, which used to require dragging into chat first or running
transcription blind.

### 16.7 Markdown Rendering for Chat Messages

[`MessageMarkdown.tsx`](frontend/src/components/chat/MessageMarkdown.tsx).
Replaces the old `<pre>` plaintext fallback. Claude's responses are
heavily markdown-formatted (headings, code fences, lists, tables,
**bold**, links) and were rendering as one long monospace blob.

Stack: `react-markdown` + `remark-gfm`. Choices:

- `react-markdown` is the de-facto standard renderer, explicitly
  designed against XSS (no `innerHTML`, no raw HTML pass-through
  unless opted in).
- `remark-gfm` adds GitHub-Flavored extensions — tables, task lists,
  strikethrough, autolinks — that Claude uses constantly.
- **No syntax highlighting** (e.g. `react-syntax-highlighter`). It's
  200 KB+ and the readability win from monospace + background already
  covers ~90% of the value
  ([`MessageMarkdown.tsx:17-20`](frontend/src/components/chat/MessageMarkdown.tsx#L17-L20)).
- **No `@tailwindcss/typography`**. The host app already has a dark-
  theme palette (`text-text-primary` etc.) the prose plugin doesn't
  know about; matching colours via the plugin would mean ejecting its
  config or fighting `!important` defaults
  ([`MessageMarkdown.tsx:22-26`](frontend/src/components/chat/MessageMarkdown.tsx#L22-L26)).

A `variant: 'user' | 'assistant'` prop tunes colours so links / code
/ tables render correctly on user-blue vs assistant-neutral bubbles.
The `code` component splits inline (`x`) from fenced (` ```x``` `) by
checking `\n` in `children` plus `language-` in `className` —
react-markdown v9 dropped the `inline` prop, so a content heuristic
is required
([`MessageMarkdown.tsx:113-146`](frontend/src/components/chat/MessageMarkdown.tsx#L113-L146)).

Mounted at
[`ChatMessages.tsx:89-92`](frontend/src/components/chat/ChatMessages.tsx#L89-L92).

### 16.8 Empty / Loading State Centring

[`ChatMessages.tsx:1003-1019`](frontend/src/components/chat/ChatMessages.tsx#L1003-L1019).
The empty state now lives inside a `min-h-[60vh] flex flex-col
items-center justify-center` wrapper. The previous version relied on
`h-full` cascading down from the parent, but the actual `ChatPage`
parent is a block-level wrapper without `h-full`, so the centring
silently broke and the placeholder hugged the top of the panel.
`min-h-[60vh]` gives the empty state a definite height regardless of
parent layout.

The history-loading spinner uses the same `min-h-[60vh]` wrapper
([`ChatPage.tsx:884-887`](frontend/src/components/chat/ChatPage.tsx#L884-L887))
so loading and empty states feel like the same kind of UI rather
than a tiny spinner adrift at the top.

### 16.9 Theme Overhaul

**Palette intent.** Warm-charcoal chrome (no blue anywhere except the
hard-coded brand channel colours); clay-tan / sienna primary accent
pulled away from coral toward a softer ceramic-tan; sage green as the
secondary character colour for recording indicators and key
transitions. Light mode is cream / parchment with the same accent
family pulled toward muted clay-tan so buttons don't burn against the
warm white.

**CSS-var token ladder** —
[`index.css:42-110`](frontend/src/index.css#L42-L110). Each colour is
declared as an RGB triplet so Tailwind's `rgb(var(...) / <alpha>)`
syntax keeps alpha modifiers (`bg-card-bg/50` etc.) working against
var-backed colours. Two palettes: `:root, html.dark` and `html.light`.
The strategy is documented at
[`index.css:14-22`](frontend/src/index.css#L14-L22):

- `.dark` on `<html>` → dark palette
- `.light` on `<html>` → light palette
- no class on `<html>` → fall back to dark

Token families:

| Family       | Tokens                                                              |
| ------------ | ------------------------------------------------------------------- |
| Surfaces     | `window-bg`, `card-bg`, `card-border`, `card-hover`                 |
| Text         | `text-primary`, `text-secondary`, `text-muted`                      |
| Accent       | `accent`, `accent-hover`, `accent-soft`, `accent-deep`, `accent-warm` |
| Status       | `status-success`, `status-warning`, `status-danger`                 |
| Channels     | `ch-ppg`, `ch-imu`, `ch-env`, `ch-gsr`, `ch-audio`, `ch-ble`        |

**Channel colours stay hard-coded** —
[`tailwind.config.js:55-62`](frontend/tailwind.config.js#L55-L62).
PPG = red, IMU = blue, ENV = green, etc. They're semantic brand
identities for chart legends; theming them would break data-viz
continuity across light/dark.

**Legacy aliases** —
[`tailwind.config.js:64-67`](frontend/tailwind.config.js#L64-L67).
`status-connected` / `status-disconnected` point at the new
CSS-var-driven tokens so any unmigrated component still renders
correctly during the transition.

**Custom scrollbars** —
[`index.css:130-178`](frontend/src/index.css#L130-L178). Without
this, browsers fall back to the OS default — light-grey track on
Windows, translucent grey on Mac — both of which read as "white
stripe" against the warm-charcoal dark theme and broke the design
mood every time a list overflowed. Strategy: thumb = `card-border`,
track = `window-bg`. WebKit gets pseudo-element styles; Firefox uses
the standardised `scrollbar-color` / `scrollbar-width` properties.
Both are themed via the same CSS variables so light / dark swap
automatically. The 2 px `border` between thumb and track makes the
thumb feel "set into" the rail rather than painted on top — same
trick native macOS / VSCode use.

**Terminal palette themed** —
[`EmbeddedTerminal.tsx:42-94`](frontend/src/components/shell/EmbeddedTerminal.tsx#L42-L94).
xterm.js wants concrete hex values (it doesn't read CSS vars), so
each value is duplicated per resolved theme. Background / foreground
/ cursor / selection match the chrome (`#181614` window-bg, `#E8E4DE`
text-primary in dark; `#FCFAF6` card-bg, `#28221C` text-primary in
light). ANSI colours stay close to VSCode defaults **except**:

- `green` pulled toward sage (`#7E9A6B` dark / `#5A7E48` light) so
  `ls --color` highlighting and "OK" build output don't spike out of
  the warm palette every line.
- `yellow` desaturated to mustard-amber.
- `blue` pulled to muted slate so `info:` lines fit the chrome.
- `magenta` / `cyan` softened.

The theme reapplies on `useTheme().resolvedTheme` change at
[`EmbeddedTerminal.tsx:108-114`](frontend/src/components/shell/EmbeddedTerminal.tsx#L108-L114) —
xterm.js re-renders on the next write.

**Mass blue→accent migration.** Every `bg-blue-*` / `text-blue-*` /
`border-blue-*` reference in chrome components was replaced with the
themed `accent` family. Channel-trace colours (`ch-imu` is still blue
by brand) and the lone ThemeToggle icon are the only intentional
blue references remaining.

### 16.10 Unified Button Colour Rules

The connection / scanning / recording buttons follow a single rule
throughout the app:

| Action                                          | Class                 |
| ----------------------------------------------- | --------------------- |
| Primary CTA in idle state (Connect / Scan /     | `bg-accent`           |
| Start / Start Recording)                        | `hover:opacity-90`    |
| Destructive / undo (Disconnect / Stop / Stop    | `bg-status-danger`    |
| Recording)                                      | `hover:opacity-90`    |

Implementations:

- Serial Connect / Disconnect —
  [`ConnectionPanel.tsx:251-256`](frontend/src/components/layout/ConnectionPanel.tsx#L251-L256).
- BLE Scan / Disconnect —
  [`ConnectionPanel.tsx:294-299`](frontend/src/components/layout/ConnectionPanel.tsx#L294-L299).
- Audio Start / Stop —
  [`ConnectionPanel.tsx:344-348`](frontend/src/components/layout/ConnectionPanel.tsx#L344-L348).
- Start Recording —
  [`RecordingControls.tsx:208`](frontend/src/components/recording/RecordingControls.tsx#L208).
- Stop Recording —
  [`RecordingControls.tsx:239`](frontend/src/components/recording/RecordingControls.tsx#L239).

`hover:opacity-90` instead of a hand-tuned hover colour token — the
single rule covers both light and dark since `accent-hover` is darker
than `accent` in dark mode but lighter relative to `accent` in light
mode, while opacity-90 reads as "pressed" in both directions
uniformly.

---

*Last updated: 2026-04-28 (cross-session search, markdown chat, two-pane layout, theme overhaul)*
