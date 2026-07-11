// 设置页「工作流」tab — agent_service 声明式多 agent 工作流：
// 列表 CRUD（JSON spec 编辑器 + 六组件速查卡，保存时服务端校验、
// 400 detail 原样展示）+ 流式运行面板（NDJSON 事件直播；human 步骤
// 让流暂停，内联输入框提交后继续）。状态全部留在本组件（useState）。

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  agentAdminApi,
  type WorkflowEvent,
  type WorkflowSummary,
  type WorkflowUpsertBody,
} from '../../api/agentAdminApi';
import { useT } from '../../contexts/LanguageContext';

const ID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;

/** 新建工作流时预填的最小可运行示例。 */
const NEW_WORKFLOW_TEMPLATE = JSON.stringify(
  {
    name: '',
    description: '',
    inputs: ['task'],
    steps: [{ type: 'agent', id: 'draft', agent: 'writer', prompt: '{task}' }],
  },
  null,
  2,
);

/** 速查卡的一行式 JSON 示例 — 语言无关；说明文字走 i18n（cheatsheet.steps）。 */
const CHEAT_STEPS = [
  {
    name: 'agent',
    json: '{"type":"agent","id":"draft","agent":"writer","prompt":"{task}"}',
  },
  { name: 'loop', json: '{"type":"loop","id":"revise","max_iters":3,"steps":[…]}' },
  {
    name: 'break_if',
    json: '{"type":"break_if","when":{"var":"review","regex":"^\\\\s*APPROVED\\\\b"}}',
  },
  { name: 'parallel', json: '{"type":"parallel","steps":[…]}' },
  {
    name: 'route',
    json: '{"type":"route","id":"kind","agent":"router","prompt":"…","routes":{"a":[…]},"default":"a"}',
  },
  { name: 'human', json: '{"type":"human","id":"pick","prompt":"{plan}"}' },
] as const;

// ---------- 运行面板的事件日志模型 ------------------------------------------

type StepItem = {
  kind: 'step';
  key: string;
  step: string;
  agent: string;
  iteration?: number;
  running: boolean;
  output?: string;
  elapsedMs?: number;
};

type HumanItem = {
  kind: 'human';
  key: string;
  inputId: string;
  prompt: string;
  value: string;
  submitting: boolean;
  submitted: boolean;
  error?: string;
};

type LogItem =
  | { kind: 'info'; key: string; text: string }
  | StepItem
  | { kind: 'loop_iter'; key: string; loop: string; iteration: number }
  | { kind: 'loop_break'; key: string; loop: string; reason: string }
  | { kind: 'route'; key: string; step: string; choice: string }
  | HumanItem
  | { kind: 'end'; key: string; output: string }
  | { kind: 'error'; key: string; error: string };

interface RunState {
  workflowId: string;
  workflowName: string;
  inputKeys: string[];
  inputValues: Record<string, string>;
  running: boolean;
  events: LogItem[];
}

export function WorkflowsPanel() {
  const t = useT();
  const tw = t.settings.workflows;

  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [editor, setEditor] = useState<{
    isNew: boolean;
    id: string;
    json: string;
  } | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorOpening, setEditorOpening] = useState<string | null>(null);

  const [run, setRun] = useState<RunState | null>(null);
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);
  const keyRef = useRef(0);

  // 离开设置页时断开流（服务端仍会跑完当前步骤）。
  useEffect(() => () => abortRef.current?.abort(), []);

  const refresh = useCallback(async () => {
    try {
      const r = await agentAdminApi.listWorkflows();
      setWorkflows(r.workflows);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ---- 编辑器 ----

  const openNew = () => {
    setEditor({ isNew: true, id: '', json: NEW_WORKFLOW_TEMPLATE });
    setEditorError(null);
  };

  const openEdit = async (id: string) => {
    setEditorOpening(id);
    try {
      const r = await agentAdminApi.getWorkflow(id);
      // id 由 URL/独立字段承载 — textarea 只放 body 字段。
      const body: Record<string, unknown> = { ...r.workflow };
      delete body.id;
      setEditor({ isNew: false, id, json: JSON.stringify(body, null, 2) });
      setEditorError(null);
    } catch (err) {
      window.alert(
        tw.loadOneFailed(err instanceof Error ? err.message : String(err)),
      );
    }
    setEditorOpening(null);
  };

  const handleEditorSave = async () => {
    if (!editor) return;
    const id = editor.id.trim();
    if (editor.isNew) {
      if (!ID_RE.test(id)) {
        setEditorError(tw.editor.idInvalid);
        return;
      }
      if (workflows.some((w) => w.id === id)) {
        setEditorError(tw.editor.idTaken);
        return;
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(editor.json);
    } catch (err) {
      setEditorError(
        tw.editor.jsonInvalid(err instanceof Error ? err.message : String(err)),
      );
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setEditorError(tw.editor.jsonNotObject);
      return;
    }
    const body: WorkflowUpsertBody = { ...(parsed as Record<string, unknown>) };
    delete body.id; // 正文里的 id 与 URL 冲突时以 URL 为准 — 直接剔除
    setEditorSaving(true);
    setEditorError(null);
    try {
      await agentAdminApi.putWorkflow(id, body);
      setEditor(null);
      await refresh();
    } catch (err) {
      // 服务端 400 detail（如「spec 校验失败: …」）原样展示。
      setEditorError(
        tw.editor.saveFailed(err instanceof Error ? err.message : String(err)),
      );
    }
    setEditorSaving(false);
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm(tw.confirmDelete(id))) return;
    try {
      await agentAdminApi.deleteWorkflow(id);
      if (editor && !editor.isNew && editor.id === id) setEditor(null);
      if (run && run.workflowId === id && !run.running) setRun(null);
      await refresh();
    } catch (err) {
      window.alert(
        tw.deleteFailed(err instanceof Error ? err.message : String(err)),
      );
    }
  };

  // ---- 运行面板 ----

  const nextKey = () => String(++keyRef.current);

  const appendItem = (item: LogItem) => {
    setRun((r) => (r ? { ...r, events: [...r.events, item] } : r));
  };

  const openRun = (w: WorkflowSummary) => {
    if (run?.running) return; // 按钮已禁用，双保险
    setRun({
      workflowId: w.id,
      workflowName: w.name || w.id,
      inputKeys: w.inputs,
      inputValues: Object.fromEntries(w.inputs.map((k) => [k, ''])),
      running: false,
      events: [],
    });
    setExpandedSteps(new Set());
  };

  const applyEvent = (e: WorkflowEvent) => {
    switch (e.type) {
      case 'workflow_start':
        appendItem({
          kind: 'info',
          key: nextKey(),
          text: tw.runPanel.workflowStarted(e.workflow),
        });
        break;
      case 'step_start':
        appendItem({
          kind: 'step',
          key: nextKey(),
          step: e.step,
          agent: e.agent,
          iteration: e.iteration,
          running: true,
        });
        break;
      case 'human_ask':
        // human 步骤的「step_start」— 之后的 step_end 会填充这张卡；
        // 可交互的输入框由紧随其后的 human_input_required 渲染。
        appendItem({
          kind: 'step',
          key: nextKey(),
          step: e.step,
          agent: 'human',
          iteration: e.iteration,
          running: true,
        });
        break;
      case 'step_end': {
        const fallbackKey = nextKey();
        setRun((r) => {
          if (!r) return r;
          const events = [...r.events];
          let idx = -1;
          for (let i = events.length - 1; i >= 0; i--) {
            const it = events[i];
            // parallel 分支的 step_end 乱序到达也没关系 — step id 互不相同。
            if (it.kind === 'step' && it.running && it.step === e.step) {
              idx = i;
              break;
            }
          }
          if (idx >= 0) {
            const it = events[idx] as StepItem;
            events[idx] = {
              ...it,
              running: false,
              output: e.output,
              elapsedMs: e.elapsed_ms,
            };
          } else {
            events.push({
              kind: 'step',
              key: fallbackKey,
              step: e.step,
              agent: e.agent ?? '',
              iteration: e.iteration,
              running: false,
              output: e.output,
              elapsedMs: e.elapsed_ms,
            });
          }
          return { ...r, events };
        });
        break;
      }
      case 'loop_iter':
        appendItem({
          kind: 'loop_iter',
          key: nextKey(),
          loop: e.loop,
          iteration: e.iteration,
        });
        break;
      case 'loop_break':
        appendItem({
          kind: 'loop_break',
          key: nextKey(),
          loop: e.loop,
          reason: e.reason,
        });
        break;
      case 'route_choice':
        appendItem({ kind: 'route', key: nextKey(), step: e.step, choice: e.choice });
        break;
      case 'human_input_required':
        appendItem({
          kind: 'human',
          key: nextKey(),
          inputId: e.input_id,
          prompt: e.prompt,
          value: '',
          submitting: false,
          submitted: false,
        });
        break;
      case 'workflow_end':
        appendItem({ kind: 'end', key: nextKey(), output: e.output });
        break;
      case 'error':
        appendItem({ kind: 'error', key: nextKey(), error: e.error });
        break;
    }
  };

  const startRun = async () => {
    const current = run;
    if (!current || current.running) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRun((r) => (r ? { ...r, running: true, events: [] } : r));
    setExpandedSteps(new Set());
    try {
      await agentAdminApi.streamWorkflow(
        current.workflowId,
        current.inputValues,
        applyEvent,
        controller.signal,
      );
    } catch (err) {
      if (controller.signal.aborted) {
        appendItem({ kind: 'info', key: nextKey(), text: tw.runPanel.stoppedNote });
      } else {
        appendItem({
          kind: 'error',
          key: nextKey(),
          error: tw.runPanel.startFailed(
            err instanceof Error ? err.message : String(err),
          ),
        });
      }
    }
    setRun((r) => (r ? { ...r, running: false } : r));
  };

  const stopRun = () => abortRef.current?.abort();

  const patchHuman = (key: string, patch: Partial<HumanItem>) => {
    setRun((r) =>
      r
        ? {
            ...r,
            events: r.events.map((it) =>
              it.kind === 'human' && it.key === key ? { ...it, ...patch } : it,
            ),
          }
        : r,
    );
  };

  const submitHuman = async (item: HumanItem) => {
    if (item.submitting || item.submitted) return;
    patchHuman(item.key, { submitting: true, error: undefined });
    try {
      await agentAdminApi.submitWorkflowInput(item.inputId, item.value);
      patchHuman(item.key, { submitting: false, submitted: true });
    } catch (err) {
      patchHuman(item.key, {
        submitting: false,
        error: tw.runPanel.humanSubmitFailed(
          err instanceof Error ? err.message : String(err),
        ),
      });
    }
  };

  const toggleStep = (key: string) => {
    setExpandedSteps((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // ---- 事件日志渲染 ----

  const renderLogItem = (item: LogItem) => {
    switch (item.kind) {
      case 'info':
        return (
          <div key={item.key} className="text-[11px] text-text-muted">
            {item.text}
          </div>
        );
      case 'step': {
        const isOpen = expandedSteps.has(item.key);
        return (
          <div
            key={item.key}
            className="rounded border border-card-border bg-card-bg p-2"
          >
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <span className="font-mono font-semibold text-text-primary">
                {item.step}
              </span>
              <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-accent/15 text-accent-soft border border-accent/30">
                {item.agent}
              </span>
              {item.iteration != null && (
                <span className="text-[11px] font-mono text-text-muted">
                  #{item.iteration}
                </span>
              )}
              <span className="ml-auto text-[11px]">
                {item.running ? (
                  <span className="text-text-muted animate-pulse">
                    ⏳ {tw.runPanel.stepRunning}
                  </span>
                ) : (
                  <span className="text-status-success">
                    {tw.runPanel.stepDone(item.elapsedMs ?? 0)}
                  </span>
                )}
              </span>
              {!item.running && item.output && (
                <button
                  type="button"
                  onClick={() => toggleStep(item.key)}
                  className="text-[11px] text-text-muted hover:text-text-primary"
                >
                  {isOpen ? tw.runPanel.collapse : tw.runPanel.expand}
                </button>
              )}
            </div>
            {item.output != null && item.output !== '' && (
              <p
                className={`mt-1 text-xs text-text-secondary whitespace-pre-wrap break-words ${
                  isOpen ? '' : 'line-clamp-3'
                }`}
              >
                {item.output}
              </p>
            )}
          </div>
        );
      }
      case 'loop_iter':
        return (
          <div
            key={item.key}
            className="flex items-center gap-2 text-[11px] text-text-muted"
          >
            <span className="h-px flex-1 bg-card-border" />
            <span>{tw.runPanel.loopRound(item.loop, item.iteration)}</span>
            <span className="h-px flex-1 bg-card-border" />
          </div>
        );
      case 'loop_break':
        return (
          <div key={item.key} className="text-[11px]">
            <span className="inline-block px-2 py-0.5 rounded-full bg-accent-warm/15 text-accent-warm border border-accent-warm/30 break-all">
              {tw.runPanel.loopBreak(item.loop, item.reason)}
            </span>
          </div>
        );
      case 'route':
        return (
          <div key={item.key} className="text-[11px]">
            <span className="inline-block px-2 py-0.5 rounded-full bg-accent/15 text-accent-soft border border-accent/30 font-mono break-all">
              {item.step} {tw.runPanel.routeChoice(item.choice)}
            </span>
          </div>
        );
      case 'human':
        return (
          <div
            key={item.key}
            className="rounded-lg border border-accent bg-accent/5 p-3 space-y-2"
          >
            <div className="text-xs font-semibold text-text-primary">
              🙋 {tw.runPanel.humanTitle}
            </div>
            <p className="text-xs text-text-secondary whitespace-pre-wrap break-words">
              {item.prompt}
            </p>
            <textarea
              rows={3}
              value={item.value}
              disabled={item.submitted || item.submitting}
              onChange={(e) => patchHuman(item.key, { value: e.target.value })}
              placeholder={tw.runPanel.humanPlaceholder}
              className={inputClass + ' resize-y text-xs'}
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void submitHuman(item)}
                disabled={item.submitted || item.submitting || !item.value.trim()}
                className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
              >
                {tw.runPanel.humanSubmit}
              </button>
              {item.submitted && (
                <span className="text-[11px] text-status-success">
                  {tw.runPanel.humanSubmitted}
                </span>
              )}
            </div>
            {item.error && (
              <p className="text-xs text-status-danger break-all">{item.error}</p>
            )}
          </div>
        );
      case 'end':
        return (
          <div
            key={item.key}
            className="rounded-lg border border-status-success/50 bg-status-success/5 p-3"
          >
            <div className="text-xs font-semibold text-status-success mb-1">
              ✅ {tw.runPanel.finalOutput}
            </div>
            <p className="text-xs text-text-primary whitespace-pre-wrap break-words">
              {item.output}
            </p>
          </div>
        );
      case 'error':
        return (
          <div
            key={item.key}
            className="rounded-lg border border-status-danger/50 bg-status-danger/10 p-3"
          >
            <div className="text-xs font-semibold text-status-danger mb-1">
              {tw.runPanel.errorTitle}
            </div>
            <p className="text-xs text-status-danger whitespace-pre-wrap break-all">
              {item.error}
            </p>
          </div>
        );
    }
  };

  // ---- 页面 ----

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-text-primary">
            {tw.heading}
          </h2>
          <p className="mt-0.5 text-xs text-text-muted">{tw.tagline}</p>
        </div>
        <button
          type="button"
          onClick={openNew}
          className="shrink-0 rounded border border-card-border px-3 py-1.5 text-xs text-text-secondary hover:bg-card-border/40"
        >
          {tw.newWorkflow}
        </button>
      </header>

      {loadError && (
        <div className="p-3 text-xs bg-status-danger/10 border border-status-danger/30 rounded text-status-danger">
          <div className="font-semibold mb-1">{tw.loadFailed}</div>
          <div className="break-all">{loadError}</div>
        </div>
      )}

      {!loaded && !loadError && (
        <div className="rounded border border-card-border p-3 text-xs text-text-muted">
          {t.common.loading}
        </div>
      )}

      {loaded && !loadError && workflows.length === 0 && (
        <div className="text-center text-xs text-text-muted py-8">{tw.empty}</div>
      )}

      {/* Workflow cards */}
      <div className="space-y-3">
        {workflows.map((w) => (
          <div
            key={w.id}
            className="p-4 rounded-lg bg-card-bg border border-card-border"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-sm font-semibold text-text-primary">
                    {w.name || w.id}
                  </h3>
                  <span className="text-[11px] font-mono text-text-muted">
                    {w.id}
                  </span>
                </div>
                {w.description && (
                  <p className="mt-1 text-xs text-text-secondary leading-relaxed">
                    {w.description}
                  </p>
                )}
                {(w.inputs.length > 0 || w.agents.length > 0) && (
                  <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                    {w.inputs.length > 0 && (
                      <span className="text-[11px] text-text-muted">
                        {tw.inputsLabel}:
                      </span>
                    )}
                    {w.inputs.map((k) => (
                      <span
                        key={`in-${k}`}
                        className="text-[11px] px-2 py-0.5 rounded-full bg-accent/15 text-accent-soft border border-accent/30 font-mono"
                      >
                        {'{'}
                        {k}
                        {'}'}
                      </span>
                    ))}
                    {w.agents.length > 0 && (
                      <span className="ml-1 text-[11px] text-text-muted">
                        {tw.agentsLabel}:
                      </span>
                    )}
                    {w.agents.map((a) => (
                      <span
                        key={`ag-${a}`}
                        className="text-[11px] px-2 py-0.5 rounded-full bg-accent-warm/15 text-accent-warm border border-accent-warm/30"
                      >
                        🤖 {a}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => openRun(w)}
                  disabled={run?.running === true}
                  className="rounded border border-card-border px-2 py-1 text-xs text-text-secondary hover:bg-card-border/40 disabled:opacity-50"
                >
                  {tw.run}
                </button>
                <button
                  type="button"
                  onClick={() => void openEdit(w.id)}
                  disabled={editorOpening === w.id}
                  className="rounded border border-card-border px-2 py-1 text-xs text-text-secondary hover:bg-card-border/40 disabled:opacity-50"
                >
                  {tw.edit}
                </button>
                <button
                  type="button"
                  onClick={() => void handleDelete(w.id)}
                  className="rounded border border-card-border px-2 py-1 text-xs text-text-muted hover:text-status-danger"
                >
                  {tw.delete}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Editor — inline expanding panel（同 AgentsPanel） */}
      {editor && (
        <section className="rounded-lg border border-accent/40 bg-card-bg/40 p-4 space-y-3">
          <h3 className="text-sm font-semibold text-text-primary">
            {editor.isNew ? tw.editor.titleNew : tw.editor.titleEdit(editor.id)}
          </h3>

          <div className="max-w-xs">
            <Field label={tw.editor.fieldId}>
              <input
                value={editor.id}
                disabled={!editor.isNew}
                onChange={(e) =>
                  setEditor((ed) => (ed ? { ...ed, id: e.target.value } : ed))
                }
                placeholder="my_workflow"
                className={inputClass + ' font-mono text-xs'}
              />
              {editor.isNew && (
                <span className="text-[11px] text-text-muted">
                  {tw.editor.idHint}
                </span>
              )}
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <Field label={tw.editor.fieldSpec}>
              <textarea
                rows={18}
                value={editor.json}
                spellCheck={false}
                onChange={(e) =>
                  setEditor((ed) => (ed ? { ...ed, json: e.target.value } : ed))
                }
                className={inputClass + ' resize-y font-mono text-xs leading-relaxed'}
              />
              <span className="text-[11px] text-text-muted">
                {tw.editor.specHint}
              </span>
            </Field>
            <CheatSheet />
          </div>

          {editorError && (
            <p className="text-xs text-status-danger break-all whitespace-pre-wrap">
              {editorError}
            </p>
          )}

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={() => void handleEditorSave()}
              disabled={editorSaving}
              className="rounded bg-accent px-4 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {tw.editor.save}
            </button>
            <button
              type="button"
              onClick={() => setEditor(null)}
              className="rounded border border-card-border px-3 py-1.5 text-xs text-text-secondary hover:bg-card-border/40"
            >
              {tw.editor.cancel}
            </button>
          </div>
        </section>
      )}

      {/* Run panel — 事件流直播 */}
      {run && (
        <section className="rounded-lg border border-accent/40 bg-card-bg/40 p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-text-primary">
              {tw.runPanel.heading(run.workflowName)}
            </h3>
            <button
              type="button"
              onClick={() => setRun(null)}
              disabled={run.running}
              className="rounded border border-card-border px-2 py-1 text-xs text-text-muted hover:text-text-primary disabled:opacity-50"
            >
              {tw.runPanel.close}
            </button>
          </div>

          {run.inputKeys.length === 0 ? (
            <p className="text-xs text-text-muted">{tw.runPanel.noInputs}</p>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {run.inputKeys.map((k) => (
                <Field key={k} label={`{${k}}`}>
                  <input
                    value={run.inputValues[k] ?? ''}
                    disabled={run.running}
                    onChange={(e) =>
                      setRun((r) =>
                        r
                          ? {
                              ...r,
                              inputValues: { ...r.inputValues, [k]: e.target.value },
                            }
                          : r,
                      )
                    }
                    className={inputClass + ' font-mono text-xs'}
                  />
                </Field>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void startRun()}
              disabled={run.running}
              className="rounded bg-accent px-4 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {run.running ? tw.runPanel.running : tw.runPanel.start}
            </button>
            {run.running && (
              <button
                type="button"
                onClick={stopRun}
                className="rounded border border-status-danger/50 px-3 py-1.5 text-xs text-status-danger hover:bg-status-danger/10"
              >
                {tw.runPanel.stop}
              </button>
            )}
          </div>

          {run.events.length > 0 && (
            <div className="space-y-2 pt-1">{run.events.map(renderLogItem)}</div>
          )}
        </section>
      )}
    </div>
  );
}

/** 六种步骤组件的速查卡 — 静态、紧凑，说明文字走 i18n。 */
function CheatSheet() {
  const t = useT();
  const cs = t.settings.workflows.cheatsheet;
  return (
    <div className="self-start rounded border border-card-border bg-window-bg/60 p-3 text-[11px] leading-relaxed">
      <div className="mb-2 font-semibold uppercase tracking-wide text-text-muted">
        {cs.heading}
      </div>
      <div className="space-y-2">
        {CHEAT_STEPS.map((s) => (
          <div key={s.name}>
            <div>
              <span className="font-mono font-semibold text-text-primary">
                {s.name}
              </span>
              <span className="ml-1.5 text-text-muted">{cs.steps[s.name]}</span>
            </div>
            <code className="block font-mono text-[10px] text-text-secondary break-all">
              {s.json}
            </code>
          </div>
        ))}
      </div>
      <p className="mt-3 text-text-muted">{cs.conditionsNote}</p>
      <p className="mt-1.5 text-text-muted">{cs.templateNote}</p>
    </div>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`flex flex-col gap-1 ${className ?? ''}`}>
      <span className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
        {label}
      </span>
      {children}
    </label>
  );
}

const inputClass =
  'w-full rounded border border-card-border bg-window-bg px-2 py-1 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none disabled:opacity-50';
