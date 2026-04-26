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
    content?: string | Array<{ type: string; text?: string; name?: string; input?: unknown; thinking?: string; tool_use_id?: string }>;
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
  const messages = useChatStore((s) => s.messages);

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
                    // Tool being used - create new bubble
                    const toolName = item.name || 'Tool';
                    addMessage({
                      type: 'tool',
                      toolName,
                      input: item.input as Record<string, unknown>,
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

            // User message echo - skip (already added before sending)
            if (data.type === 'user') {
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
          } else if (chunk.type === 'done') {
            // Stream completed
            setIsLoading(false);
            setIsThinking(false);
            yield;
          } else if (chunk.type === 'error') {
            setError(chunk.error || 'Unknown error occurred');
            setIsLoading(false);
            setIsThinking(false);
            yield;
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Stream processing error');
        setIsLoading(false);
        setIsThinking(false);
      }
    },
    [addMessage, updateLastMessage, replaceTemporarySession, temporarySessionId, setIsLoading, setIsThinking, setError, messages, getLastAssistantMessageId],
  );

  return { processStreamLine };
}
