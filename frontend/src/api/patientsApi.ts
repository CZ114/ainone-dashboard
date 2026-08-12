// Shared patient-roster client (agent_service /api/agent/patients, port 8100).
// The global authToken fetch wrapper injects X-Auth-Token, so a plain fetch
// here is already authenticated. Used by the recording flow to attribute a
// capture to a patient (auto-match by device name, with manual override).

export interface Patient {
  id: string;          // P-xxx
  name: string;
  age: number | null;
  complaint: string;
  device: string;      // bound capture-device name (matched against live device)
  created_by: string;
  created_at: number;  // epoch seconds
}

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const patientsApi = {
  async list(): Promise<Patient[]> {
    const { patients } = await asJson<{ patients: Patient[] }>(
      await fetch('/api/agent/patients'),
    );
    return patients;
  },
};

/** Case-insensitive match of a live device identifier to a patient's bound device. */
export function matchPatientByDevice(
  patients: Patient[],
  deviceId: string | null | undefined,
): Patient | undefined {
  const d = (deviceId ?? '').trim().toLowerCase();
  if (!d) return undefined;
  const hits = patients.filter((p) => p.device && p.device.trim().toLowerCase() === d);
  return hits.length === 1 ? hits[0] : undefined; // only auto-bind on an unambiguous match
}
