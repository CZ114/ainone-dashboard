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
  scan: () => fetchJson('/ble/scan', { method: 'POST' }),

  connect: () => fetchJson('/ble/connect', { method: 'POST' }),

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

// Recording API
export const recordingApi = {
  start: (durationSeconds: number = 60, includeAudio: boolean = true) =>
    fetchJson('/recording/start', {
      method: 'POST',
      body: JSON.stringify({
        duration_seconds: durationSeconds,
        include_audio: includeAudio,
      }),
    }),

  stop: () => fetchJson('/recording/stop', { method: 'POST' }),

  getStatus: () => fetchJson('/recording/status'),
};

// Health check
export const healthApi = {
  check: () => fetchJson('/health'),
};