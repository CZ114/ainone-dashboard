/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Set to "1" by start.bat when the user picks the Demo entry. Read
   * via `isDemoMode()` from `frontend/src/lib/demoMode.ts` rather than
   * inline `import.meta.env.VITE_DEMO_MODE === '1'` checks, so demo
   * detection lives in exactly one place.
   */
  readonly VITE_DEMO_MODE?: string;
  /**
   * Optional origin/base path for the ADvoice report-chat service.
   * Leave empty for the handover's same-origin /api/* contract.
   * In the fused local stack, point this at a non-sensor port such as
   * http://127.0.0.1:8081 because :8080 belongs to the sensor backend.
   */
  readonly VITE_DOCTOR_CHAT_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
