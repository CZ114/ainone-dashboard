// REST API client

const API_BASE = '/api';

async function fetchJson(url: string, options?: RequestInit) {
  const response = await fetch(`${API_BASE}${url}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error || `HTTP ${response.status}`);
  }

  return response.json();
}

// Serial API
export const serialApi = {
  listPorts: () => fetchJson('/serial/ports'),

  connect: (port: string, baudRate: number = 115200) =>
    fetchJson('/serial/connect', {
      method: 'POST',
      body: JSON.stringify({ port, baud_rate: baudRate }),
    }),

  disconnect: () => fetchJson('/serial/disconnect', { method: 'POST' }),

  getStatus: () => fetchJson('/serial/status'),
};

// BLE API
export const bleApi = {
  // deviceName is optional — when omitted, the backend uses whatever
  // target the bridge already has (initialised from config). When
  // supplied, it re-targets the bridge for this and future scans.
  scan: (deviceName?: string) =>
    fetchJson('/ble/scan', {
      method: 'POST',
      body: JSON.stringify(
        deviceName && deviceName.trim()
          ? { device_name: deviceName.trim() }
          : {},
      ),
    }),

  connect: (deviceName?: string) =>
    fetchJson('/ble/connect', {
      method: 'POST',
      body: JSON.stringify(
        deviceName && deviceName.trim()
          ? { device_name: deviceName.trim() }
          : {},
      ),
    }),

  disconnect: () => fetchJson('/ble/disconnect', { method: 'POST' }),

  getStatus: () => fetchJson('/ble/status'),
};

// Audio API
export const audioApi = {
  start: (port: number = 8888) =>
    fetchJson('/audio/start', {
      method: 'POST',
      body: JSON.stringify({ port }),
    }),

  stop: () => fetchJson('/audio/stop', { method: 'POST' }),

  getStatus: () => fetchJson('/audio/status'),
};

// Live-stream ownership — which patient the single connected device streams for.
// A patient claims the stream on connect; the dashboard reads it to avoid
// showing one patient's live data under another patient's name.
export interface LiveOwner {
  patient_id: string;
  patient_name: string;
}

export const liveApi = {
  getOwner: (): Promise<{ owner: LiveOwner | null }> => fetchJson('/live/owner'),

  setOwner: (patientId: string, patientName: string) =>
    fetchJson('/live/owner', {
      method: 'POST',
      body: JSON.stringify({ patient_id: patientId, patient_name: patientName }),
    }),

  clearOwner: () => fetchJson('/live/owner', { method: 'DELETE' }),
};

// Recording API
export const recordingApi = {
  start: (
    durationSeconds: number = 60,
    includeAudio: boolean = true,
    patientId: string | null = null,
    patientName: string | null = null,
  ) =>
    fetchJson('/recording/start', {
      method: 'POST',
      body: JSON.stringify({
        duration_seconds: durationSeconds,
        include_audio: includeAudio,
        patient_id: patientId,
        patient_name: patientName,
      }),
    }),

  stop: () => fetchJson('/recording/stop', { method: 'POST' }),

  getStatus: () => fetchJson('/recording/status'),
};

// Health check
export const healthApi = {
  check: () => fetchJson('/health'),
};