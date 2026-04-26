export interface StreamResponse {
  type:
    | "claude_json"
    | "error"
    | "done"
    | "aborted"
    | "permission_request";
  data?: unknown; // SDKMessage object for claude_json type
  error?: string;
  // Populated when type === "permission_request". The id is what the
  // frontend echoes back via POST /api/chat/permission to resolve the
  // matching SDK callback.
  permission?: PermissionRequestPayload;
}

// Lightweight subset of the SDK's PermissionUpdate, just what we need to
// surface "always allow" suggestions to the UI without leaking the full
// SDK type into shared/types.
export interface PermissionSuggestion {
  type: string;
  behavior?: "allow" | "deny" | "ask";
  destination?: string;
  // Original suggestion blob — the frontend echoes it back unmodified
  // when the user picks "Allow always", and the backend forwards it to
  // the SDK as `updatedPermissions`. Keeps wire schema decoupled.
  raw: unknown;
}

export interface PermissionRequestPayload {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  toolUseId: string;
  // Pre-rendered prompt strings the SDK supplies when available — use
  // these when present rather than reconstructing from toolName/input.
  title?: string;
  displayName?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  suggestions?: PermissionSuggestion[];
}

// What the user's choice looks like on the wire. Mirrors the SDK's
// PermissionResult variants. The backend serialises this into a
// PermissionResult before handing it back to the SDK.
export type PermissionDecisionWire =
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      // When the user picked "Allow always" the frontend echoes back the
      // suggestions that were attached to the request.
      acceptedSuggestions?: PermissionSuggestion[];
    }
  | {
      behavior: "deny";
      message: string;
    };

export interface PermissionResponseRequest {
  id: string;
  decision: PermissionDecisionWire;
}

// Effort level maps directly onto the agent SDK's EffortLevel type.
// Client may omit the field (equivalent to model default).
export type EffortLevelWire = "low" | "medium" | "high" | "xhigh" | "max";

// Thinking config — the wire equivalent of the SDK's ThinkingConfig union.
// Client omits the field to let the SDK pick a default (adaptive on Opus 4.6+).
export type ThinkingConfigWire =
  | { type: "enabled"; budgetTokens: number }
  | { type: "disabled" }
  | { type: "adaptive" };

export interface ChatRequest {
  message: string;
  sessionId?: string;
  requestId: string;
  allowedTools?: string[];
  workingDirectory?: string;
  permissionMode?:
    | "default"
    | "plan"
    | "acceptEdits"
    | "bypassPermissions"
    | "auto";
  // Optional SDK knobs exposed from the frontend toolbar.
  effort?: EffortLevelWire;
  thinking?: ThinkingConfigWire;
}

export interface AbortRequest {
  requestId: string;
}

export interface ProjectInfo {
  path: string;
  encodedName: string;
}

export interface ProjectsResponse {
  projects: ProjectInfo[];
}

// Conversation history types
export interface ConversationSummary {
  sessionId: string;
  startTime: string;
  lastTime: string;
  messageCount: number;
  lastMessagePreview: string;
}

export interface HistoryListResponse {
  conversations: ConversationSummary[];
}

// Conversation history types
// Note: messages are typed as unknown[] to avoid frontend/backend dependency issues
// Frontend should cast to TimestampedSDKMessage[] (defined in frontend/src/types.ts)
export interface ConversationHistory {
  sessionId: string;
  messages: unknown[]; // TimestampedSDKMessage[] in practice, but avoiding frontend type dependency
  metadata: {
    startTime: string;
    endTime: string;
    messageCount: number;
  };
}
