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

*Last updated: 2026-04-26 (Tool Permissions + Interactive Picker)*
