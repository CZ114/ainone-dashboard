/**
 * M2 authz — gateway-side verification of the agent service's signed
 * role tokens.
 *
 * Token format (minted by backend/agent_service/authz.py):
 *   base64url(JSON{role,id,name,exp}) + "." + base64url(HMAC-SHA256(body))
 * Both sides read the SAME secret file (data/agent_service/auth_secret),
 * so a token minted at login verifies here without any cross-service
 * calls. Requests without a valid token resolve to the lowest tier
 * ("patient") — machine callers that only hit consumption routes keep
 * working, while the admin-route allowlist below stays fail-closed.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { serviceKey } from "./agentService.ts";

export type Role = "patient" | "doctor" | "developer";

interface TokenPayload {
  role: Role;
  id: string;
  name: string;
  exp: number;
}

function b64urlDecode(text: string): Buffer {
  const padded = text + "=".repeat((4 - (text.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function b64urlEncode(raw: Buffer): string {
  return raw
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Verify a signed role token; null on any mismatch/expiry/malformation. */
export function verifyToken(token: string): TokenPayload | null {
  const key = serviceKey();
  if (!key) return null; // secret not on disk yet → nothing verifies
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  try {
    const want = b64urlEncode(
      createHmac("sha256", key).update(body, "ascii").digest(),
    );
    const a = Buffer.from(sig, "ascii");
    const b = Buffer.from(want, "ascii");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(b64urlDecode(body).toString("utf-8"));
    if (payload.exp < Date.now() / 1000) return null;
    if (!["patient", "doctor", "developer"].includes(payload.role)) return null;
    return payload as TokenPayload;
  } catch {
    return null;
  }
}

/** Resolve the caller's role from Hono context (X-Auth-Token / Bearer). */
export function roleOf(c: Context): Role {
  const raw =
    c.req.header("x-auth-token") ||
    (c.req.header("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!raw) return "patient";
  return verifyToken(raw)?.role ?? "patient";
}

// ── Admin-route policy ─────────────────────────────────────────────
// Only routes that grant more than consumption are listed; everything
// unlisted stays open to every role (chat/diary read/reply/config are
// the patient's product surface). Mirrors frontend rolePolicy.ts.

const DEV: Role[] = ["developer"];
const STAFF: Role[] = ["doctor", "developer"];

const RULES: Array<{ methods: string[] | null; re: RegExp; roles: Role[] }> = [
  // diary agent + secret CRUD — system prompt / key material
  { methods: null, re: /^\/api\/diary\/secrets/, roles: DEV },
  { methods: ["POST", "DELETE"], re: /^\/api\/diary\/agents\/[^/]+/, roles: DEV },
  // diary entries are care records: replyable, not destroyable
  { methods: ["DELETE"], re: /^\/api\/diary\/entries\//, roles: DEV },
  // project management + native OS pickers
  { methods: ["DELETE"], re: /^\/api\/projects$/, roles: STAFF },
  { methods: null, re: /^\/api\/system\/pick-(folder|file)$/, roles: DEV },
];

/** Roles allowed for a request; null = unlisted (open to all). */
export function requiredRoles(method: string, path: string): Role[] | null {
  for (const rule of RULES) {
    if (rule.methods !== null && !rule.methods.includes(method)) continue;
    if (rule.re.test(path)) return rule.roles;
  }
  return null;
}
