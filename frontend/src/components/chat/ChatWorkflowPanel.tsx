// Chat 右栏「工作流」折叠面板 — 多 agent 工作流的现场运行（NDJSON 直播）
// + 每步消息传递回看（step_end 的完整 output 可展开）+ 持久化运行历史。
//
// 视觉语言完全复用 ChatMessages 的 Codex 式活动时间线原语
// （ActivityRow / Reveal / Chevron）；接口复用 agentAdminApi（与设置页
// WorkflowsPanel 同一套 streamWorkflow 流式读法）。状态自持（useState），
// 不进全局 store。面板窄（右栏 ~300-380px），文字走 11-12px、激进截断。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  agentAdminApi,
  type WorkflowEvent,
  type WorkflowRunEvent,
  type WorkflowRunSummary,
  type WorkflowSummary,
} from '../../api/agentAdminApi';
import { ActivityRow, Chevron, Reveal } from './ChatMessages';
import { useT } from '../../contexts/LanguageContext';

const OPEN_KEY = 'chat-workflow-panel-open';

// ---------- 事件 → 时间线行 的映射（直播与历史回放共用） ------------------

/** 时间线行模型 — variant 'human' 渲染成带琥珀左边线的输入卡。 */
interface TimelineRowModel {
  key: string;
  variant: 'row' | 'human';
  icon: string;
  iconClass?: string;
  title: string;
  titleClass?: string;
  meta?: string;
  detailText?: string;
  defaultOpen?: boolean;
  /** step_start 后、step_end 前为 true；仅在 live 模式下呈现脉动。 */
  pulse?: boolean;
  // variant === 'human'
  inputId?: string;
  prompt?: string;
}

interface TimelineLabels {
  run: string;
  done: string;
  failed: string;
  loopBreak: string;
  aborted: string;
}

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  return String(v);
}

function firstLine(s: string): string {
  const l = s.split('\n').find((x) => x.trim().length > 0) ?? '';
  return l.length > 80 ? l.slice(0, 79) + '…' : l;
}

/**
 * 把事件序列映射成时间线行。step_start 先落一行脉动占位（按 step id
 * 记账），对应的 step_end 到达时原位「落定」为 ✓ + 首行摘要 + 可展开的
 * 完整 output（消息传递回看）。key 复用占位行的 key，React 保持组件
 * 身份、展开状态不丢。历史回放传同一批事件即可复用（无 live 交互）。
 */
function eventsToRows(
  events: WorkflowRunEvent[],
  labels: TimelineLabels,
): TimelineRowModel[] {
  const rows: TimelineRowModel[] = [];
  // step id → 未落定占位行的下标。parallel 分支 step id 互不相同，
  // 乱序 step_end 也能各自命中。
  const openSteps = new Map<string, number>();
  let seq = 0;
  for (const e of events) {
    const key = `e${seq++}`;
    switch (e.type) {
      case 'workflow_start':
        rows.push({
          key,
          variant: 'row',
          icon: '·',
          title: labels.run,
          titleClass: 'text-text-muted',
          meta: str(e.run_id) || str(e.workflow) || undefined,
        });
        break;
      case 'step_start':
      case 'human_ask': {
        const step = str(e.step);
        rows.push({
          key,
          variant: 'row',
          icon: '→',
          iconClass: 'text-accent-soft',
          title: step,
          meta: `(${e.type === 'human_ask' ? 'human' : str(e.agent)})`,
          pulse: true,
        });
        openSteps.set(step, rows.length - 1);
        break;
      }
      case 'step_end': {
        const step = str(e.step);
        const output = str(e.output);
        const idx = openSteps.get(step);
        const settled: TimelineRowModel = {
          key: idx != null ? rows[idx].key : key,
          variant: 'row',
          icon: '✓',
          iconClass: 'text-emerald-600',
          title: step,
          meta: firstLine(output) || undefined,
          detailText: output || undefined,
        };
        if (idx != null) {
          rows[idx] = settled;
          openSteps.delete(step);
        } else {
          rows.push(settled);
        }
        break;
      }
      case 'loop_iter':
        rows.push({
          key,
          variant: 'row',
          icon: '↻',
          iconClass: 'text-sky-500',
          title: `${str(e.loop)} #${str(e.iteration)}`,
          titleClass: 'text-text-muted',
        });
        break;
      case 'loop_break': {
        const loop = str(e.loop);
        const reason = str(e.reason);
        rows.push({
          key,
          variant: 'row',
          icon: '↳',
          title: labels.loopBreak,
          titleClass: 'text-text-muted',
          meta: [loop, reason].filter(Boolean).join(' · ') || undefined,
        });
        break;
      }
      case 'route_choice': {
        // 字段名各版本有出入 — 取存在的那个。
        const decision = str(e.decision) || str(e.choice) || str(e.branch);
        rows.push({
          key,
          variant: 'row',
          icon: '🔀',
          title: decision || 'route',
          meta: str(e.step) || undefined,
        });
        break;
      }
      case 'human_input_required':
        rows.push({
          key,
          variant: 'human',
          icon: '🙋',
          title: '',
          inputId: str(e.input_id),
          prompt: str(e.prompt),
        });
        break;
      case 'workflow_end': {
        const output = str(e.output);
        rows.push({
          key,
          variant: 'row',
          icon: '✓',
          iconClass: 'text-emerald-600',
          title: labels.done,
          meta: firstLine(output) || undefined,
          detailText: output || undefined,
        });
        break;
      }
      case 'error':
        rows.push({
          key,
          variant: 'row',
          icon: '✗',
          iconClass: 'text-red-500',
          title: labels.failed,
          titleClass: 'text-red-500',
          detailText: str(e.error) || undefined,
          defaultOpen: true,
        });
        break;
      case 'aborted':
        // 前端合成事件 — 用户点了停止（服务端记为 aborted 局部运行）。
        rows.push({
          key,
          variant: 'row',
          icon: '⏸',
          title: labels.aborted,
          titleClass: 'text-text-muted',
        });
        break;
      default:
        break; // 未知事件类型 — 静默跳过
    }
  }
  return rows;
}

function useTimelineLabels(): TimelineLabels {
  const t = useT();
  const tw = t.chat.workflowPanel;
  return useMemo(
    () => ({
      run: tw.runLabel,
      done: tw.done,
      failed: tw.failed,
      loopBreak: tw.loopBreak,
      aborted: tw.aborted,
    }),
    [tw],
  );
}

// ---------- 时间线渲染（直播 = 可交互 human；回放 = 只读） ------------------

interface HumanRowState {
  value: string;
  submitting: boolean;
  submitted: boolean;
  error?: string;
}

function TimelineView({
  rows,
  active = false,
  humanStates,
  onHumanChange,
  onHumanSubmit,
}: {
  rows: TimelineRowModel[];
  /** 直播且仍在运行 — 未落定的 step 行显示脉动。 */
  active?: boolean;
  humanStates?: Record<string, HumanRowState>;
  onHumanChange?: (inputId: string, value: string) => void;
  onHumanSubmit?: (inputId: string) => void;
}) {
  const t = useT();
  const tw = t.chat.workflowPanel;
  return (
    <div>
      {rows.map((row) => {
        if (row.variant === 'human') {
          const interactive = onHumanSubmit != null && !!row.inputId;
          const st = row.inputId ? humanStates?.[row.inputId] : undefined;
          return (
            <div
              key={row.key}
              className="mb-1 ml-[13px] space-y-1.5 border-l-2 border-amber-500 py-1 pl-2"
            >
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                <span aria-hidden>🙋</span>
                <span>{tw.humanTitle}</span>
                {st?.submitted && <span className="text-emerald-600">✓</span>}
              </div>
              <p className="whitespace-pre-wrap break-words text-[11px] text-text-secondary">
                {row.prompt}
              </p>
              {interactive && !st?.submitted && (
                <>
                  <textarea
                    rows={2}
                    value={st?.value ?? ''}
                    disabled={st?.submitting}
                    onChange={(e) => onHumanChange?.(row.inputId!, e.target.value)}
                    placeholder={tw.humanPlaceholder}
                    className="w-full rounded border border-card-border bg-window-bg p-1.5 font-mono text-[11px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none disabled:opacity-50"
                  />
                  <button
                    type="button"
                    disabled={st?.submitting || !(st?.value ?? '').trim()}
                    onClick={() => onHumanSubmit?.(row.inputId!)}
                    className="rounded bg-accent px-2 py-1 text-[11px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                  >
                    {tw.submit}
                  </button>
                </>
              )}
              {st?.submitted && (
                <p className="text-[11px] text-emerald-600">{tw.submitted}</p>
              )}
              {st?.error && (
                <p className="break-all text-[11px] text-red-500">{st.error}</p>
              )}
            </div>
          );
        }
        const pulseCls = row.pulse && active ? ' animate-pulse' : '';
        return (
          <ActivityRow
            key={row.key}
            icon={row.icon}
            iconClass={row.iconClass}
            title={row.title}
            titleClass={(row.titleClass ?? 'text-text-secondary') + pulseCls}
            meta={row.meta}
            defaultOpen={row.defaultOpen}
            detail={
              row.detailText != null ? (
                <pre className="max-h-64 overflow-x-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-text-muted">
                  {row.detailText}
                </pre>
              ) : undefined
            }
          />
        );
      })}
    </div>
  );
}

// ---------- 历史运行行 — 展开时才拉取详情，回放同一套时间线映射 -----------

const STATUS_ICON: Record<string, { icon: string; cls: string }> = {
  done: { icon: '✓', cls: 'text-emerald-600' },
  error: { icon: '✗', cls: 'text-red-500' },
  aborted: { icon: '⏸', cls: 'text-text-muted' },
};

function formatRunTime(startedAt: string | number): string {
  let d: Date;
  if (typeof startedAt === 'number') {
    // epoch 秒 vs 毫秒的启发式：1e12 之前当秒。
    d = new Date(startedAt < 1e12 ? startedAt * 1000 : startedAt);
  } else {
    d = new Date(startedAt);
  }
  if (Number.isNaN(d.getTime())) return String(startedAt);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function HistoryRunRow({
  run,
  onDeleted,
}: {
  run: WorkflowRunSummary;
  onDeleted: () => void;
}) {
  const t = useT();
  const tw = t.chat.workflowPanel;
  const labels = useTimelineLabels();
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<WorkflowRunEvent[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && events === null && !loading) {
      setLoading(true);
      agentAdminApi
        .getWorkflowRun(run.run_id)
        .then((r) => {
          setEvents(r.run.events);
          setError(null);
        })
        .catch((err) =>
          setError(err instanceof Error ? err.message : String(err)),
        )
        .finally(() => setLoading(false));
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(tw.confirmDelete(run.name || run.workflow_id))) return;
    try {
      await agentAdminApi.deleteWorkflowRun(run.run_id);
      onDeleted();
    } catch (err) {
      window.alert(
        tw.deleteFailed(err instanceof Error ? err.message : String(err)),
      );
    }
  };

  const rows = useMemo(
    () => (events ? eventsToRows(events, labels) : []),
    [events, labels],
  );

  const status = STATUS_ICON[run.status] ?? STATUS_ICON.done;
  const meta = tw.stepsMeta(
    run.steps,
    (run.elapsed_ms / 1000).toFixed(1),
    formatRunTime(run.started_at),
  );

  return (
    <div className="mb-0.5">
      <div className="group flex w-full items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-card-border/25">
        <button
          type="button"
          onClick={toggle}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
        >
          <span
            className={`w-4 shrink-0 text-center font-mono text-[12px] leading-none ${status.cls}`}
          >
            {status.icon}
          </span>
          <span className="min-w-0 shrink truncate font-mono text-[12px] text-text-secondary">
            {run.name || run.workflow_id}
          </span>
          <span className="min-w-0 truncate font-mono text-[11px] text-text-muted">
            {meta}
          </span>
        </button>
        <button
          type="button"
          onClick={() => void handleDelete()}
          title={tw.deleteTitle}
          className="shrink-0 text-[11px] text-text-muted opacity-0 transition-opacity hover:text-red-500 focus:opacity-100 group-hover:opacity-100"
        >
          🗑
        </button>
        <button type="button" onClick={toggle} className="shrink-0">
          <Chevron open={open} />
        </button>
      </div>
      <Reveal open={open}>
        <div className="my-1 ml-[13px] border-l-2 border-card-border pl-2">
          {loading && (
            <p className="text-[11px] text-text-muted">{tw.historyLoading}</p>
          )}
          {error && (
            <p className="break-all text-[11px] text-red-500">
              {tw.detailLoadFailed(error)}
            </p>
          )}
          {events && <TimelineView rows={rows} />}
        </div>
      </Reveal>
    </div>
  );
}

// ---------- 面板本体 ---------------------------------------------------------

type PanelStatus = 'idle' | 'running' | 'done' | 'error';

/** 现场时间线的来源 — 手动流式 vs 对话触发（轮询发现）；同时至多一条。 */
type LiveSource = 'manual' | 'auto' | null;

export function ChatWorkflowPanel() {
  const t = useT();
  const tw = t.chat.workflowPanel;
  const labels = useTimelineLabels();

  // 展开状态 — localStorage 持久化。
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(OPEN_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggleOpen = () => {
    setOpen((v) => {
      const next = !v;
      try {
        localStorage.setItem(OPEN_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  };
  /** 程序化展开 + 持久化 — 自动发现对话触发的运行时用。 */
  const openPanel = useCallback(() => {
    setOpen(true);
    try {
      localStorage.setItem(OPEN_KEY, '1');
    } catch {
      /* ignore */
    }
  }, []);

  // ---- 工作流列表 + 运行入参 ----
  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const selected = workflows?.find((w) => w.id === selectedId) ?? null;

  // ---- 现场运行 ----
  const [status, setStatus] = useState<PanelStatus>('idle');
  const [runName, setRunName] = useState('');
  const [liveEvents, setLiveEvents] = useState<WorkflowRunEvent[]>([]);
  const [humanStates, setHumanStates] = useState<Record<string, HumanRowState>>(
    {},
  );
  const abortRef = useRef<AbortController | null>(null);
  const running = status === 'running';

  // ---- 现场时间线来源（手动/自动）----
  // ref 与 state 同步写：轮询回调里读 ref（不受闭包过期影响），渲染用 state。
  const [liveSource, setLiveSourceState] = useState<LiveSource>(null);
  const liveSourceRef = useRef<LiveSource>(null);
  const setLiveSource = useCallback((v: LiveSource) => {
    liveSourceRef.current = v;
    setLiveSourceState(v);
  }, []);
  /** 手动运行的 run_id（来自流的 workflow_start）— 自动发现时跳过，防双显。 */
  const manualRunIdRef = useRef<string | null>(null);
  /** 当前追踪的对话触发运行 — state 驱动 2s 事件轮询 effect 的建/拆。 */
  const [autoRunId, setAutoRunId] = useState<string | null>(null);

  // ---- 历史运行 ----
  const [runs, setRuns] = useState<WorkflowRunSummary[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const refreshHistory = useCallback(async () => {
    try {
      const r = await agentAdminApi.listWorkflowRuns(20);
      setRuns(r.runs);
      setHistoryError(null);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // 首次展开时懒加载：工作流列表 + 历史。
  useEffect(() => {
    if (!open) return;
    if (workflows === null) {
      agentAdminApi
        .listWorkflows()
        .then((r) => {
          setWorkflows(r.workflows);
          setLoadError(null);
          if (r.workflows.length > 0) {
            setSelectedId((cur) => cur || r.workflows[0].id);
            setInputValues((cur) =>
              Object.keys(cur).length > 0
                ? cur
                : Object.fromEntries(r.workflows[0].inputs.map((k) => [k, ''])),
            );
          }
        })
        .catch((err) =>
          setLoadError(err instanceof Error ? err.message : String(err)),
        );
    }
    if (runs === null) void refreshHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 卸载时断开直播流（服务端把局部运行记为 aborted）。
  useEffect(() => () => abortRef.current?.abort(), []);

  // ---- 自动发现：对话 agent 在服务端启动的运行（浏览器侧没有流）----
  // 面板挂载期间每 2.5s 轮一次 active 列表；已有现场时间线（手动优先）或
  // 页面不可见时跳过；in-flight 防重入；卸载清 interval。
  useEffect(() => {
    let disposed = false;
    let inflight = false;
    const tick = async () => {
      if (inflight || document.hidden) return;
      if (liveSourceRef.current !== null) return; // 至多一条现场时间线
      inflight = true;
      try {
        const r = await agentAdminApi.listActiveWorkflowRuns();
        if (disposed || liveSourceRef.current !== null) return;
        // 跳过自己手动跑的（含 abort 后服务端仍在收尾的那条）；
        // 多条并发只取第一条，其余结束后进历史。
        const found = r.active.find((a) => a.run_id !== manualRunIdRef.current);
        if (!found) return;
        setLiveSource('auto');
        setAutoRunId(found.run_id);
        setStatus('running');
        setRunName(found.name || found.workflow_id);
        setLiveEvents([]);
        setHumanStates({});
        openPanel(); // 对话触发 — 自动展开面板让用户看见
      } catch {
        /* 轮询失败静默 — 下一轮再试 */
      } finally {
        inflight = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 2500);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [openPanel, setLiveSource]);

  // ---- 自动运行直播：每 2s 全量重拉事件（事件量小，整拉即可）；
  //      404 = 运行已结束 → 拉一次终态记录落定时间线并刷新历史。
  useEffect(() => {
    if (!autoRunId) return;
    let disposed = false;
    let inflight = false;
    const settle = async () => {
      try {
        const r = await agentAdminApi.getWorkflowRun(autoRunId);
        if (disposed) return;
        setLiveEvents(r.run.events);
        setStatus(r.run.status === 'error' ? 'error' : 'done');
      } catch {
        if (disposed) return;
        setStatus('done'); // 终态记录暂不可得 — 保留已拉到的事件
      }
      setAutoRunId(null);
      setLiveSource(null);
      void refreshHistory();
    };
    const tick = async () => {
      if (inflight || document.hidden) return;
      inflight = true;
      try {
        const r = await agentAdminApi.getActiveWorkflowRun(autoRunId);
        if (disposed) return;
        if (r === null) {
          await settle(); // 404 — 运行已结束
          return;
        }
        setLiveEvents(r.run.events);
      } catch {
        /* 网络抖动 — 保留现有时间线，下一轮再试 */
      } finally {
        inflight = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 2000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [autoRunId, refreshHistory, setLiveSource]);

  // done 徽标短暂显示后自动归位（✓ 一闪即收）。
  useEffect(() => {
    if (status !== 'done') return;
    const timer = setTimeout(
      () => setStatus((s) => (s === 'done' ? 'idle' : s)),
      4000,
    );
    return () => clearTimeout(timer);
  }, [status]);

  const handleSelect = (id: string) => {
    setSelectedId(id);
    const w = workflows?.find((x) => x.id === id);
    setInputValues(
      w ? Object.fromEntries(w.inputs.map((k) => [k, ''])) : {},
    );
  };

  const startRun = async () => {
    if (!selected || running) return;
    const controller = new AbortController();
    abortRef.current = controller;
    manualRunIdRef.current = null;
    setLiveSource('manual'); // 手动优先 — 发现轮询在此期间不认领新运行
    setStatus('running');
    setRunName(selected.name || selected.id);
    setLiveEvents([]);
    setHumanStates({});
    let sawError = false;
    try {
      await agentAdminApi.streamWorkflow(
        selected.id,
        inputValues,
        (e: WorkflowEvent) => {
          // 记下自己的 run_id — 发现轮询据此跳过本条（防双显）。
          if (e.type === 'workflow_start' && e.run_id) {
            manualRunIdRef.current = e.run_id;
          }
          if (e.type === 'error') sawError = true;
          setLiveEvents((prev) => [...prev, e as WorkflowRunEvent]);
        },
        controller.signal,
      );
      setStatus(sawError ? 'error' : 'done');
    } catch (err) {
      if (controller.signal.aborted) {
        setLiveEvents((prev) => [...prev, { type: 'aborted' }]);
        setStatus('idle');
      } else {
        setLiveEvents((prev) => [
          ...prev,
          { type: 'error', error: err instanceof Error ? err.message : String(err) },
        ]);
        setStatus('error');
      }
    }
    abortRef.current = null;
    setLiveSource(null); // 手动流结束 — 发现轮询恢复认领
    // 直播结束（含中止/失败）→ 刷新历史列表，新纪录立刻可见。
    void refreshHistory();
  };

  const stopRun = () => abortRef.current?.abort();

  const patchHuman = (inputId: string, patch: Partial<HumanRowState>) => {
    setHumanStates((prev) => {
      const base: HumanRowState =
        prev[inputId] ?? { value: '', submitting: false, submitted: false };
      return { ...prev, [inputId]: { ...base, ...patch } };
    });
  };

  const submitHuman = async (inputId: string) => {
    const st = humanStates[inputId];
    if (st?.submitting || st?.submitted) return;
    patchHuman(inputId, { submitting: true, error: undefined });
    try {
      await agentAdminApi.submitWorkflowInput(inputId, st?.value ?? '');
      // 提交成功 — 服务端自动继续跑，流会接着推事件。
      patchHuman(inputId, { submitting: false, submitted: true });
    } catch (err) {
      patchHuman(inputId, {
        submitting: false,
        error: tw.submitFailed(err instanceof Error ? err.message : String(err)),
      });
    }
  };

  const liveRows = useMemo(
    () => eventsToRows(liveEvents, labels),
    [liveEvents, labels],
  );

  const inputClass =
    'w-full rounded border border-card-border bg-window-bg px-2 py-1 font-mono text-[11px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none disabled:opacity-50';

  return (
    <div className="shrink-0 border-b border-card-border bg-card-bg/60">
      {/* Header — 常显；点击折叠/展开，状态徽标随运行状态变化 */}
      <button
        type="button"
        onClick={toggleOpen}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-card-border/25"
      >
        <span aria-hidden className="text-[13px] leading-none">
          🔁
        </span>
        <span className="shrink-0 text-xs font-semibold text-text-primary">
          {tw.title}
        </span>
        {status === 'running' && (
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-amber-500">
            <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-500" />
            <span className="truncate font-mono">{runName}</span>
            {liveSource === 'auto' && (
              <span className="shrink-0 rounded bg-amber-500/15 px-1 text-[10px] leading-4">
                {tw.autoTag}
              </span>
            )}
          </span>
        )}
        {status === 'done' && (
          <span className="text-[11px] text-emerald-600">✓</span>
        )}
        {status === 'error' && <span className="text-[11px] text-red-500">✗</span>}
        <span className="ml-auto shrink-0">
          <Chevron open={open} />
        </span>
      </button>

      <Reveal open={open}>
        <div className="max-h-[45vh] space-y-3 overflow-y-auto px-3 pb-3">
          {/* Run section — 工作流选择 + 每个 spec 输入一个文本框 */}
          <div className="space-y-1.5">
            {loadError && (
              <p className="break-all text-[11px] text-red-500">
                {tw.loadFailed(loadError)}
              </p>
            )}
            <select
              value={selectedId}
              disabled={running}
              onChange={(e) => handleSelect(e.target.value)}
              className="w-full rounded border border-card-border bg-window-bg px-2 py-1 text-[12px] text-text-primary focus:border-accent focus:outline-none disabled:opacity-50"
            >
              <option value="">{tw.selectPlaceholder}</option>
              {(workflows ?? []).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name || w.id}
                </option>
              ))}
            </select>
            {selected && selected.inputs.length === 0 && (
              <p className="text-[11px] text-text-muted">{tw.noInputs}</p>
            )}
            {selected?.inputs.map((k) => (
              <label key={k} className="block">
                <span className="mb-0.5 block font-mono text-[11px] text-text-muted">
                  {k}
                </span>
                <input
                  value={inputValues[k] ?? ''}
                  disabled={running}
                  onChange={(e) =>
                    setInputValues((prev) => ({ ...prev, [k]: e.target.value }))
                  }
                  className={inputClass}
                />
              </label>
            ))}
            <div className="flex gap-2 pt-0.5">
              <button
                type="button"
                onClick={() => void startRun()}
                disabled={!selected || running}
                className="rounded bg-accent px-3 py-1 text-[11px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
              >
                {running ? tw.running : tw.run}
              </button>
              {running && liveSource === 'manual' && (
                <button
                  type="button"
                  onClick={stopRun}
                  className="rounded border border-red-500/50 px-2.5 py-1 text-[11px] text-red-500 hover:bg-red-500/10"
                >
                  {tw.stop}
                </button>
              )}
            </div>
          </div>

          {/* Live timeline — 事件直播；step 行脉动直至 step_end 落定 */}
          {liveRows.length > 0 && (
            <TimelineView
              rows={liveRows}
              active={running}
              humanStates={humanStates}
              onHumanChange={(id, value) => patchHuman(id, { value })}
              onHumanSubmit={(id) => void submitHuman(id)}
            />
          )}

          {/* History — 持久化历史；展开某条运行时才拉详情做只读回放 */}
          <div className="space-y-1 border-t border-card-border pt-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
                {tw.history}
              </span>
              <button
                type="button"
                onClick={() => void refreshHistory()}
                className="text-[11px] text-text-muted hover:text-text-primary"
              >
                {tw.refresh}
              </button>
            </div>
            {historyError && (
              <p className="break-all text-[11px] text-red-500">{historyError}</p>
            )}
            {runs === null && !historyError && (
              <p className="text-[11px] text-text-muted">{tw.historyLoading}</p>
            )}
            {runs !== null && runs.length === 0 && (
              <p className="text-[11px] text-text-muted">{tw.historyEmpty}</p>
            )}
            {runs?.map((r) => (
              <HistoryRunRow
                key={r.run_id}
                run={r}
                onDeleted={() => void refreshHistory()}
              />
            ))}
          </div>
        </div>
      </Reveal>
    </div>
  );
}
