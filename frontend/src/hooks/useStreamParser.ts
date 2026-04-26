// Stream parser hook for Claude chat - handles session continuity and message parsing

import { useCallback } from 'react';
import { useChatStore } from '../store/chatStore';
import { StreamResponse } from '../api/claudeApi';

// SDK message types from Claude Code SDK
interface SDKMessage {
  type: 'system' | 'assistant' | 'user' | 'result' | 'error' | 'thinking' | 'content_block_delta' | 'content_block_stop';
  subtype?: string;
  message?: {
    role?: 'user' | 'assistant';
    content?:
      | string
      | Array<{
          type: string;
          text?: string;
          name?: string;
          input?: unknown;
          thinking?: string;
          tool_use_id?: string;
          id?: string;
          content?: string | Array<{ type: string; text?: string }>;
          is_error?: boolean;
        }>;
    id?: string;
  };
  session_id?: string;
  model?: string;
  tools?: string[];
  cwd?: string;
  permissionMode?: string;
  result?: {
    type?: string;
    content?: string | Array<{ type: string; text?: string }>;
  };
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: { input_tokens: number; output_tokens: number };
  timestamp?: string;
  delta?: { text?: string };
  parentUuid?: string | null;
  uuid?: string;
}

export function useStreamParser() {
  const addMessage = useChatStore((s) => s.addMessage);
  const updateLastMessage = useChatStore((s) => s.updateLastMessage);
  const replaceTemporarySession = useChatStore((s) => s.replaceTemporarySession);
  const temporarySessionId = useChatStore((s) => s.temporarySessionId);
  const setIsLoading = useChatStore((s) => s.setIsLoading);
  const setIsThinking = useChatStore((s) => s.setIsThinking);
  const setError = useChatStore((s) => s.setError);
  const setPermissionDecision = useChatStore((s) => s.setPermissionDecision);
  const messages = useChatStore((s) => s.messages);

  // When the stream ends (done / error / aborted), any permission_request
  // bubble still in 'pending' state will never get answered — the SDK
  // has already moved on (denied internally on the backend's abort path).
  // Mark them aborted so the UI doesn't show a forever-spinning waiter.
  const closeOutstandingPermissions = useCallback(() => {
    const live = useChatStore.getState().messages;
    for (const m of live) {
      if (m.type === 'permission_request' && m.decided.status === 'pending') {
        setPermissionDecision(m.permissionId, { status: 'aborted' });
      }
    }
  }, [setPermissionDecision]);

  const getLastAssistantMessageId = useCallback(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type === 'chat' && (msg as { role?: string }).role === 'assistant') {
        return msg.id;
      }
    }
    return null;
  }, [messages]);

  const processStreamLine = useCallback(
    async function* (
      generator: AsyncGenerator<StreamResponse>,
      requestId?: string,
    ): AsyncGenerator<void> {
      try {
        for await (const chunk of generator) {
          if (chunk.type === 'claude_json' && chunk.data) {
            const data = chunk.data as SDKMessage;

            // System message (init) - when a new session is created
            if (data.type === 'system' && data.subtype === 'init') {
              console.log('[DEBUG] system/init received, session_id:', data.session_id, 'requestId:', requestId);
              if (data.session_id) {
                // Replace temporary session with real session ID from CLI
                // Pass the current requestId to ensure only current request updates session
                replaceTemporarySession(data.session_id, requestId);
              }
              // Add system message showing session info
              addMessage({
                type: 'system',
                subtype: 'init',
                model: data.model,
                session_id: data.session_id,
                tools: data.tools,
                cwd: data.cwd,
                permissionMode: data.permissionMode,
              });
              setIsThinking(true);
              continue;
            }

            // Stream delta - incremental text updates
            if (data.type === 'content_block_delta' && data.delta?.text) {
              const lastMsgId = getLastAssistantMessageId();
              if (lastMsgId) {
                // Append to existing message
                const currentMsg = messages.find(m => m.id === lastMsgId);
                if (currentMsg && currentMsg.type === 'chat') {
                  updateLastMessage(lastMsgId, (currentMsg as { content: string }).content + data.delta.text);
                }
              } else {
                // Create new message if none exists
                addMessage({
                  type: 'chat',
                  role: 'assistant',
                  content: data.delta.text,
                });
              }
              setIsThinking(true);
              continue;
            }

            // Stream end - content block finished
            if (data.type === 'content_block_stop') {
              setIsThinking(false);
              continue;
            }

            // Assistant message (complete message)
            if (data.type === 'assistant' && data.message?.content) {
              const content = data.message.content;

              if (Array.isArray(content)) {
                for (const item of content) {
                  if (item.type === 'thinking' && item.thinking) {
                    // Always create NEW thinking message (separate bubble)
                    addMessage({
                      type: 'thinking',
                      content: item.thinking,
                    });
                    setIsThinking(true);
                  } else if (item.type === 'text' && item.text) {
                    // Create assistant text message
                    addMessage({
                      type: 'chat',
                      role: 'assistant',
                      content: item.text,
                    });
                    setIsThinking(false);
                  } else if (item.type === 'tool_use') {
                    // Tool being used - create new bubble. Keep tool_use_id so
                    // the matching tool_result block can be paired up later.
                    const toolName = item.name || 'Tool';
                    addMessage({
                      type: 'tool',
                      toolName,
                      input: item.input as Record<string, unknown>,
                      toolUseId: item.id,
                    });
                    setIsThinking(true);
                  }
                }
              } else if (typeof content === 'string') {
                addMessage({
                  type: 'chat',
                  role: 'assistant',
                  content,
                });
                setIsThinking(false);
              }
              continue;
            }

            // Result message (end of turn)
            if (data.type === 'result') {
              let resultText = '';
              if (data.result?.content) {
                if (typeof data.result.content === 'string') {
                  resultText = data.result.content;
                } else if (Array.isArray(data.result.content)) {
                  for (const item of data.result.content) {
                    if (item.type === 'text' && item.text) {
                      resultText += item.text;
                    }
                  }
                }
              }

              // Add result as system message
              addMessage({
                type: 'system',
                subtype: 'result',
                content: resultText,
                duration_ms: data.duration_ms,
                total_cost_usd: data.total_cost_usd,
              });
              setIsThinking(false);
              continue;
            }

            // User message — the SDK uses this both for the echoed user
            // prompt (skip; we already showed it locally) and for tool
            // results posted back after a tool_use. Pull the tool_result
            // blocks out so we can render success/error feedback.
            if (data.type === 'user') {
              const content = data.message?.content;
              if (Array.isArray(content)) {
                for (const item of content) {
                  if (item.type !== 'tool_result') continue;
                  let resultText = '';
                  if (typeof item.content === 'string') {
                    resultText = item.content;
                  } else if (Array.isArray(item.content)) {
                    for (const block of item.content) {
                      if (block.type === 'text' && block.text) {
                        resultText += block.text;
                      }
                    }
                  }
                  // Look up the originating tool_use OR permission_request
                  // bubble to label this result with its tool name. Read
                  // from the store directly because the captured `messages`
                  // closure can be stale — the matching tool_use may have
                  // been added in an earlier chunk of this very stream,
                  // after this callback closed.
                  let toolName: string | undefined;
                  if (item.tool_use_id) {
                    const live = useChatStore.getState().messages;
                    for (let i = live.length - 1; i >= 0; i--) {
                      const m = live[i];
                      const candidateId =
                        m.type === 'tool'
                          ? (m as { toolUseId?: string }).toolUseId
                          : m.type === 'permission_request'
                            ? (m as { toolUseId?: string }).toolUseId
                            : undefined;
                      if (candidateId === item.tool_use_id) {
                        toolName =
                          m.type === 'tool'
                            ? (m as { toolName: string }).toolName
                            : (m as { toolName: string }).toolName;
                        break;
                      }
                    }
                  }
                  // AskUserQuestion answers are routed via SDK deny+message
                  // (no first-class "user answered" return), so the SDK
                  // synthesises an is_error tool_result echoing the
                  // answer text. The permission bubble already shows the
                  // answer as "✓ Answered — ..."; rendering this as a
                  // red error bubble is redundant and confusing. Drop it.
                  if (toolName === 'AskUserQuestion') {
                    continue;
                  }
                  addMessage({
                    type: 'tool_result',
                    toolName,
                    toolUseId: item.tool_use_id,
                    content: resultText,
                    isError: item.is_error === true,
                  });
                }
              }
              continue;
            }

            // Error type
            if (data.type === 'error') {
              console.error('[DEBUG] Claude error:', data);
              const errorMsg = typeof data.message === 'string' ? data.message : 'Unknown error';
              setError(errorMsg);
              setIsThinking(false);
              continue;
            }
          } else if (chunk.type === 'permission_request' && chunk.permission) {
            // Tool-use approval prompt from the SDK's canUseTool callback.
            // Render an inline bubble; the bubble's button handler POSTs
            // back to /api/chat/permission to resolve the SDK's Promise.
            const p = chunk.permission;
            addMessage({
              type: 'permission_request',
              permissionId: p.id,
              toolName: p.toolName,
              input: p.input,
              toolUseId: p.toolUseId,
              title: p.title,
              displayName: p.displayName,
              description: p.description,
              decisionReason: p.decisionReason,
              blockedPath: p.blockedPath,
              suggestions: p.suggestions,
              decided: { status: 'pending' },
            });
            // SDK is paused until the user answers — show a clear
            // not-thinking state so the spinner doesn't keep spinning.
            setIsThinking(false);
            continue;
          } else if (chunk.type === 'done') {
            // Stream completed
            setIsLoading(false);
            setIsThinking(false);
            closeOutstandingPermissions();
            yield;
          } else if (chunk.type === 'error') {
            setError(chunk.error || 'Unknown error occurred');
            setIsLoading(false);
            setIsThinking(false);
            closeOutstandingPermissions();
            yield;
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Stream processing error');
        setIsLoading(false);
        setIsThinking(false);
        closeOutstandingPermissions();
      }
    },
    [addMessage, updateLastMessage, replaceTemporarySession, temporarySessionId, setIsLoading, setIsThinking, setError, messages, getLastAssistantMessageId, closeOutstandingPermissions],
  );

  return { processStreamLine };
}
