// activePatient — the app-wide "current patient" context (staff workflow).
//
// A doctor picks the patient they're working with ONCE; from then on both new
// recordings and new chat sessions auto-attribute to that patient. Kept as a
// tiny external store (localStorage-persisted) so any component can read/write
// it without prop-drilling or touching the big Zustand store. Patients still
// only ever see their own data via the backend owner-filter; this context is a
// staff convenience for organising work by patient.

import { useSyncExternalStore } from 'react';

export interface ActivePatient {
  id: string;   // P-xxx
  name: string;
}

const LS_KEY = 'app.activePatient.v1';

function load(): ActivePatient | null {
  try {
    const s = localStorage.getItem(LS_KEY);
    return s ? (JSON.parse(s) as ActivePatient) : null;
  } catch {
    return null;
  }
}

let active: ActivePatient | null = load();
const listeners = new Set<() => void>();

export function getActivePatient(): ActivePatient | null {
  return active;
}

export function setActivePatient(p: ActivePatient | null): void {
  active = p;
  try {
    if (p) localStorage.setItem(LS_KEY, JSON.stringify(p));
    else localStorage.removeItem(LS_KEY);
  } catch {
    /* localStorage unavailable — in-memory only */
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Reactive hook: the current active patient, shared across all components. */
export function useActivePatient(): ActivePatient | null {
  return useSyncExternalStore(subscribe, getActivePatient, getActivePatient);
}
