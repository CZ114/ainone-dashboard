export interface StreamResponse {
  type: "claude_json" | "error" | "done" | "aborted";
  data?: unknown; // SDKMessage object for claude_json type
  error?: string;
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
  permissionMode?: "default" | "plan" | "acceptEdits" | "bypassPermissions";
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
