// Chat Messages component - displays all message types with agent states

import { useState } from 'react';
import type { AllMessage, ChatMessage, SystemMessage, ToolMessage, ThinkingMessage, TodoMessage, TodoItem } from '../../store/chatStore';

interface ChatMessagesProps {
  messages: AllMessage[];
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

// Collapsible details component for expandable content
function CollapsibleDetails({
  label,
  details,
  defaultExpanded = false,
  children,
}: {
  label: string;
  details?: string;
  defaultExpanded?: boolean;
  children?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div className="border border-card-border rounded-lg overflow-hidden mb-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2 bg-card-bg hover:bg-card-border/30 text-left flex items-center justify-between text-sm transition-colors"
      >
        <span className="font-medium text-text-secondary">{label}</span>
        <span className="text-text-muted">{expanded ? '▼' : '▶'}</span>
      </button>
      {expanded && (
        <div className="px-3 py-2 bg-window-bg">
          {details && (
            <pre className="text-xs text-text-secondary whitespace-pre-wrap font-mono overflow-x-auto">
              {details}
            </pre>
          )}
          {children}
        </div>
      )}
    </div>
  );
}

// Chat message (user/assistant text)
function ChatMessageComponent({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3`}>
      <div
        className={`max-w-[80%] rounded-lg px-4 py-3 ${
          isUser
            ? 'bg-blue-600 text-white'
            : 'bg-card-bg border border-card-border'
        }`}
      >
        <div className={`text-xs font-semibold mb-1 ${isUser ? 'text-blue-200' : 'text-text-muted'}`}>
          {isUser ? 'You' : 'Claude'}
        </div>
        <pre className="text-sm whitespace-pre-wrap break-words font-sans">
          {message.content}
        </pre>
        <div className={`text-xs mt-1 ${isUser ? 'text-blue-200' : 'text-text-muted'}`}>
          {formatTimestamp(message.timestamp)}
        </div>
      </div>
    </div>
  );
}

// System message (init, result, error)
function SystemMessageComponent({ message }: { message: SystemMessage }) {
  if (message.subtype === 'init') {
    return (
      <div className="mb-3">
        <CollapsibleDetails label="Session Info" details={
          `Model: ${message.model || 'Unknown'}\nSession: ${message.session_id?.slice(0, 8) || 'Unknown'}...\nTools: ${message.tools?.length || 0} available\nCWD: ${message.cwd || 'Unknown'}\nMode: ${message.permissionMode || 'default'}`
        } />
      </div>
    );
  }

  if (message.subtype === 'result') {
    return (
      <div className="mb-3">
        <CollapsibleDetails
          label="Result"
          details={`Duration: ${message.duration_ms}ms | Cost: $${message.total_cost_usd?.toFixed(4) || '0'}`}
          defaultExpanded={false}
        >
          {message.content && (
            <div className="mt-2 text-sm text-text-secondary">
              {message.content}
            </div>
          )}
        </CollapsibleDetails>
      </div>
    );
  }

  if (message.subtype === 'error') {
    return (
      <div className="mb-3 p-3 bg-red-500/20 border border-red-500/50 rounded-lg">
        <div className="text-red-400 text-sm font-medium">Error</div>
        <div className="text-red-300 text-xs mt-1">{message.content}</div>
      </div>
    );
  }

  return null;
}

// Tool message (Claude is using a tool)
function ToolMessageComponent({ message }: { message: ToolMessage }) {
  const inputPreview = message.input
    ? Object.keys(message.input).slice(0, 3).join(', ')
    : '';

  return (
    <div className="flex justify-start mb-3">
      <div className="max-w-[80%] rounded-lg px-4 py-3 bg-emerald-500/10 border border-emerald-500/30">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-lg">🔧</span>
          <span className="font-semibold text-emerald-400">{message.toolName}</span>
        </div>
        {inputPreview && (
          <div className="text-xs text-emerald-300/70 mt-1 ml-7">
            {inputPreview}...
          </div>
        )}
      </div>
    </div>
  );
}

// Thinking message (Claude's reasoning)
function ThinkingMessageComponent({ message }: { message: ThinkingMessage }) {
  return (
    <div className="mb-3">
      <CollapsibleDetails
        label="💭 Reasoning"
        details={message.content}
        defaultExpanded={true}
      />
    </div>
  );
}

// Todo message (TodoWrite tool)
function TodoMessageComponent({ message }: { message: TodoMessage }) {
  const getStatusIcon = (status: TodoItem['status']) => {
    switch (status) {
      case 'completed': return '✅';
      case 'in_progress': return '🔄';
      case 'pending': return '⏳';
    }
  };

  const getStatusColor = (status: TodoItem['status']) => {
    switch (status) {
      case 'completed': return 'text-green-400';
      case 'in_progress': return 'text-blue-400';
      case 'pending': return 'text-gray-400';
    }
  };

  const completed = message.todos.filter(t => t.status === 'completed').length;

  return (
    <div className="mb-3">
      <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-3">
        <div className="text-sm font-semibold text-amber-400 mb-2">
          📋 Todo List ({completed}/{message.todos.length})
        </div>
        <div className="space-y-1">
          {message.todos.map((todo, i) => (
            <div key={i} className="flex items-start gap-2 text-sm">
              <span>{getStatusIcon(todo.status)}</span>
              <span className={getStatusColor(todo.status)}>{todo.content}</span>
              {todo.status === 'in_progress' && todo.activeForm && (
                <span className="text-xs text-amber-300/70 italic">({todo.activeForm})</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Loading indicator
export function LoadingIndicator() {
  return (
    <div className="flex justify-start mb-3">
      <div className="rounded-lg px-4 py-3 bg-card-bg border border-card-border">
        <div className="flex items-center gap-2 text-sm text-text-secondary">
          <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
          <span className="animate-pulse">Claude is thinking...</span>
        </div>
      </div>
    </div>
  );
}

// Main ChatMessages component
export function ChatMessages({ messages }: ChatMessagesProps) {
  if (messages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center">
        <div className="text-6xl mb-4">💬</div>
        <h2 className="text-xl font-semibold text-text-primary mb-2">
          Start a conversation
        </h2>
        <p className="text-text-muted max-w-md">
          Send a message to Claude Code. You can ask questions, request code reviews,
          or get help with your ESP32 sensor project.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {messages.map((msg) => {
        switch (msg.type) {
          case 'chat':
            return <ChatMessageComponent key={msg.id} message={msg} />;
          case 'system':
            return <SystemMessageComponent key={msg.id} message={msg} />;
          case 'tool':
            return <ToolMessageComponent key={msg.id} message={msg} />;
          case 'thinking':
            return <ThinkingMessageComponent key={msg.id} message={msg} />;
          case 'todo':
            return <TodoMessageComponent key={msg.id} message={msg} />;
          default:
            return null;
        }
      })}
    </div>
  );
}
