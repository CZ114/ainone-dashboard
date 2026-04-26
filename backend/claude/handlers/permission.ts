import { Context } from "hono";
import type { PermissionResponseRequest } from "../../shared/types.ts";
import { resolvePendingPermission } from "./chat.ts";

export async function handlePermissionResponse(c: Context) {
  let body: PermissionResponseRequest;
  try {
    body = (await c.req.json()) as PermissionResponseRequest;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body || typeof body.id !== "string" || !body.decision) {
    return c.json({ error: "Missing id or decision" }, 400);
  }
  if (
    body.decision.behavior !== "allow" &&
    body.decision.behavior !== "deny"
  ) {
    return c.json({ error: "Unknown decision.behavior" }, 400);
  }

  const ok = resolvePendingPermission(body.id, body.decision);
  if (!ok) {
    // The id may have already been resolved (double-click) or aborted.
    // Both are normal — return 200 with a flag rather than 404 so the
    // frontend doesn't surface a scary error to the user.
    return c.json({ ok: false, reason: "already_resolved_or_unknown" });
  }
  return c.json({ ok: true });
}
