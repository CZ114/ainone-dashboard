/**
 * Demo-mode detection. Single source of truth so swapping the env var
 * name or wiring (e.g., adding a query-string override) only changes
 * one file. Keep this dependency-free — it's imported by Header which
 * mounts before stores hydrate.
 */
export function isDemoMode(): boolean {
  return import.meta.env.VITE_DEMO_MODE === '1';
}
