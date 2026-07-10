/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Set to "1" by start.bat when the user picks the Demo entry. Read
   * via `isDemoMode()` from `frontend/src/lib/demoMode.ts` rather than
   * inline `import.meta.env.VITE_DEMO_MODE === '1'` checks, so demo
   * detection lives in exactly one place.
   */
  readonly VITE_DEMO_MODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
