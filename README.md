# AinOne Dashboard

A full-stack real-time sensor dashboard with AI chat integration built with:
- **Python Backend**: FastAPI — serial/BLE/audio data acquisition, WebSocket streaming
- **Node.js Backend**: Hono — Claude Code CLI integration with streaming chat
- **Frontend**: React + TypeScript + Tailwind CSS — real-time visualization

## Features

- Real-time multi-channel waveform visualization from ESP32 via Serial, BLE, or WiFi UDP
- Dual voice input: PC microphone or ESP32 UDP microphone with Whisper local inference
- AI chat with Claude Code CLI — slash commands, file attachments, thinking/effort controls
- Sensor session recordings to CSV + WAV with drag-and-drop into chat
- Pluggable extension system (e.g. Whisper) with 1-click install UI

## Project Structure

```
ainone-dashboard/
├── backend/                    # FastAPI backend
│   ├── app/
│   │   ├── api/               # REST API routes
│   │   ├── core/              # Business logic (serial, BLE, audio bridges)
│   │   ├── models/            # Pydantic schemas
│   │   ├── services/          # WebSocket, Recording services
│   │   └── main.py            # FastAPI application
│   ├── recordings/            # Output directory for recordings
│   └── requirements.txt
│
└── frontend/                   # React frontend
    ├── src/
    │   ├── api/               # REST + WebSocket clients
    │   ├── components/        # React components
    │   ├── store/             # Zustand state management
    │   └── types/             # TypeScript types
    ├── package.json
    └── tailwind.config.js
```

## Quick Start

### 1. Backend Setup

```bash
cd backend

# Create virtual environment (recommended)
python -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Run the backend
python -u run.py
```

Backend will start at `http://localhost:8080`

### 2. Claude Backend

```bash
cd backend/claude
npm install
node scripts/generate-version.js
npm run dev
```

Claude backend starts at `http://localhost:3000`

### 3. Frontend Setup

```bash
cd frontend

# Install dependencies
npm install

# Run development server
npm run dev
```

Frontend starts at `http://localhost:5173`

### 3. Connect ESP32

1. Connect ESP32 via USB and select the serial port
2. Or connect via BLE (device name: ESP32-S3-MultiSensor)
3. Data will appear automatically when the ESP32 sends CSV data

## ESP32 Data Format

The dashboard expects CSV data from ESP32:

```
# With header (recommended)
timestamp,ch1_temp,ch2_hr,ch3_gsr,ch4_ax
0,25.5,72,2048,0.52

# Without header (auto-detected as CH1, CH2, ...)
0,25.5,72,2048,0.52
```

## API Documentation

Once the backend is running, visit:
- Swagger UI: http://localhost:8080/docs
- ReDoc: http://localhost:8080/redoc

## WebSocket Protocol

Connect to `ws://localhost:8080/ws` for real-time data.

### Server → Client Messages

```json
{
  "type": "sensor_data",
  "timestamp": "2026-04-12T10:30:45.123Z",
  "channels": ["temp", "hr", "gsr", "ax"],
  "values": [25.6, 72, 2048, 0.523],
  "waveforms": [[25.1,25.2,...], [70,71,...], ...],
  "stats": { "min": [20.0,...], "max": [30.0,...], "avg": [25.5,...] }
}
```

## License

MIT