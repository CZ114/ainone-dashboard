// authToken — M2 token plumbing, decoupled from React so main.tsx can
// install the fetch patch before the app tree exists.
//
// The signed role token (minted by /api/agent/auth/login) lives inside
// the persisted `app.auth` blob. Every same-origin /api request carries
// it as X-Auth-Token via a window.fetch wrapper — chosen over touching
// the dozens of scattered fetch call sites; zero-invasive and covers
// future call sites automatically.

const STORAGE_KEY = 'app.auth';

export function getToken(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed.token === 'string' ? parsed.token : null;
  } catch {
    return null;
  }
}

/** Install the X-Auth-Token fetch wrapper. Call once at boot. */
export function installAuthFetch(): void {
  const rawFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // Same-origin API calls only — never leak the token cross-origin.
    const isApi = url.startsWith('/api/') || url.startsWith(`${location.origin}/api/`);
    const token = isApi ? getToken() : null;
    if (!token) return rawFetch(input, init);

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has('X-Auth-Token')) headers.set('X-Auth-Token', token);
    const response = await rawFetch(input, { ...init, headers });

    // Expired/forged token → backend answers 401. Clear the stale
    // identity and reload into the login gate instead of leaving the
    // app half-broken. (Login failures don't land here: no token is
    // attached while logged out.)
    if (response.status === 401) {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* ignore */
      }
      location.reload();
    }
    return response;
  };
}
