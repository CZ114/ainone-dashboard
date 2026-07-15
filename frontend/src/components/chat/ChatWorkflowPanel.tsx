// Chat 右栏「工作流」折叠面板 — 分区原则: 侧栏 = 状态指示器, 聊天 = 交互与产出。
//
// 面板保留: 运行控制(选择/输入/Run/Stop) + 迷你流程图(照搬 spec 定义的
// 结构, 事件点亮当前步骤) + 持久化运行历史(回放仍用旧时间线行)。
// 事件的「内容」不再留在面板: human 追问、step 产出、知识库引用、终态
// 一行, 统一由转发器推成 WorkflowChatMessage 进聊天流(ChatMessages 渲染)。
//
// 视觉语言复用 ChatMessages 的 Codex 式原语(ActivityRow / Reveal / Chevron);
// 接口复用 agentAdminApi; 流程图的 spec 读取复用 workflowSpecUtils 的
// 防御性读取(不复用设置页编辑器本体)。面板窄(~300-380px), 文字走
// 10-12px、激进截断。

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  agentAdminApi,
  type WorkflowEvent,
  type WorkflowRunEvent,
  type WorkflowRunSummary,
  type WorkflowSpec,
  type WorkflowSummary,
} from '../../api/agentAdminApi';
import { useAuth } from '../../contexts/RoleContext';
import type { Role } from '../../lib/rolePolicy';
import {
  asString,
  condOf,
  routesOf,
  stepChildren,
  type StepNode,
} from '../settings/workflowSpecUtils';
import { useChatStore } from '../../store/chatStore';
import { ActivityRow, Chevron, Reveal } from './ChatMessages';
import { useT } from '../../contexts/LanguageContext';

const OPEN_KEY = 'chat-workflow-panel-open';

// ---------- 事件 → 时间线行 的映射（仅历史回放使用） --------------------------

/** 时间线行模型 — variant 'human' 渲染成带琥珀左边线的只读提示卡。 */
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
  // variant === 'human'
  prompt?: string;
}

interface TimelineLabels {
  run: string;
  done: string;
  failed: string;
  loopBreak: string;
  aborted: string;
  references: (agent: string) => string;
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
 * 三镜头投影: 医生看 labels.doctor 的临床叙事替代 step id, 开发者(及缺省)
 * 看原始 step。患者不用此面板(照护丝带在 TodayPage), role 仍完整传入。
 */
function projectStepTitle(e: WorkflowRunEvent, step: string, role: Role): string {
  if (role === 'doctor') {
    const lbl = (e as { labels?: unknown }).labels;
    if (lbl && typeof lbl === 'object') {
      const d = (lbl as Record<string, unknown>).doctor;
      if (typeof d === 'string' && d) return d;
    }
  }
  return step;
}

/**
 * 把事件序列映射成时间线行(历史回放)。step_start 先落占位行(按 step id
 * 记账)，对应的 step_end 到达时原位「落定」为 ✓ + 首行摘要 + 可展开的
 * 完整 output。key 复用占位行的 key，React 保持组件身份、展开状态不丢。
 */
function eventsToRows(
  events: WorkflowRunEvent[],
  labels: TimelineLabels,
  role: Role,
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
          title: projectStepTitle(e, step, role),
          meta: `(${e.type === 'human_ask' ? 'human' : str(e.agent)})`,
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
          title: projectStepTitle(e, step, role),
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
      case 'references': {
        // 引用依据 — agent 检索命中的知识库来源。历史回放里也要显示，
        // 否则医生审核过往运行时看不到结论的知识库溯源（audit trail 缺口）。
        const hits = Array.isArray(e.hits) ? (e.hits as Array<Record<string, unknown>>) : [];
        if (hits.length === 0) break;
        const detail = hits
          .map((h) => {
            const src = str(h.source) || '—';
            const score = typeof h.score === 'number' ? ` · ${h.score.toFixed(2)}` : '';
            const prev = str(h.preview);
            return `📄 ${src}${score}${prev ? `\n${prev}` : ''}`;
          })
          .join('\n\n');
        rows.push({
          key,
          variant: 'row',
          icon: '📚',
          iconClass: 'text-accent-soft',
          title: labels.references(str(e.agent)),
          titleClass: 'text-text-muted',
          meta: [str(e.query) ? firstLine(str(e.query)) : '', String(hits.length)]
            .filter(Boolean)
            .join(' · ') || undefined,
          detailText: detail,
        });
        break;
      }
      default:
        break; // 未知事件类型 — 回放里静默跳过
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
      references: tw.refsTitle,
    }),
    [tw],
  );
}

// ---------- 时间线渲染（只读 — 历史回放） -------------------------------------

function TimelineView({ rows }: { rows: TimelineRowModel[] }) {
  const t = useT();
  const tw = t.chat.workflowPanel;
  return (
    <div>
      {rows.map((row) => {
        if (row.variant === 'human') {
          return (
            <div
              key={row.key}
              className="mb-1 ml-[13px] space-y-1.5 border-l-2 border-amber-500 py-1 pl-2"
            >
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                <span aria-hidden>🙋</span>
                <span>{tw.humanTitle}</span>
              </div>
              <p className="whitespace-pre-wrap break-words text-[11px] text-text-secondary">
                {row.prompt}
              </p>
            </div>
          );
        }
        return (
          <ActivityRow
            key={row.key}
            icon={row.icon}
            iconClass={row.iconClass}
            title={row.title}
            titleClass={row.titleClass ?? 'text-text-secondary'}
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

// ---------- 迷你流程图 — 只读、纵向、紧凑; 事件点亮节点状态 --------------------
//
// 「照搬定义的流程图」: 递归渲染 spec.steps(与设置页画布同一棵树, 但
// 只画不编辑)。状态映射: pending(默认静音) / running(accent 描边 + 脉动
// = 运行特效; human 步骤为琥珀) / done(✓ 绿边) / error(红边)。loop 容器
// 迭代时挂 #n 徽标; route 高亮已选分支。

type NodeStatus = 'pending' | 'running' | 'done' | 'error';

interface DiagramRunState {
  /** step id → 节点状态（step_start/human_ask → running; step_end → done）。 */
  statuses: Record<string, NodeStatus>;
  /** loop id → 当前迭代序号（loop_iter）。 */
  iterations: Record<string, number>;
  /** route step id → 已选分支键（route_choice）。 */
  choices: Record<string, string>;
}

function deriveDiagramState(events: WorkflowRunEvent[]): DiagramRunState {
  const statuses: Record<string, NodeStatus> = {};
  const iterations: Record<string, number> = {};
  const choices: Record<string, string> = {};
  for (const e of events) {
    const step = str(e.step);
    switch (e.type) {
      case 'step_start':
      case 'human_ask':
      case 'human_input_required':
        if (step) statuses[step] = 'running';
        break;
      case 'step_end':
        if (step) statuses[step] = 'done';
        break;
      case 'loop_iter': {
        const loop = str(e.loop);
        const n = Number(e.iteration);
        if (loop && Number.isFinite(n)) iterations[loop] = n;
        break;
      }
      case 'route_choice': {
        const decision = str(e.decision) || str(e.choice) || str(e.branch);
        if (step && decision) choices[step] = decision;
        break;
      }
      case 'error':
        // 出错时把仍在跑的节点标红（通常只有一个）。
        for (const k of Object.keys(statuses)) {
          if (statuses[k] === 'running') statuses[k] = 'error';
        }
        break;
      default:
        break;
    }
  }
  return { statuses, iterations, choices };
}

function nodeChipCls(status: NodeStatus, human: boolean): string {
  const base =
    'inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5';
  const tint = human ? ' bg-amber-500/5' : '';
  switch (status) {
    case 'running':
      // 运行特效: accent/琥珀描边 + ring + 脉动。
      return human
        ? base + ' animate-pulse border-amber-500 bg-amber-500/10 ring-1 ring-amber-400/40'
        : base + ' animate-pulse border-accent bg-accent/5 ring-1 ring-accent/40';
    case 'done':
      return base + tint + ' border-emerald-500/60';
    case 'error':
      return base + tint + ' border-red-500';
    default:
      return (
        base +
        (human ? ' border-amber-500/40 bg-amber-500/5' : ' border-card-border') +
        ' opacity-75'
      );
  }
}

function StatusTick({ status }: { status: NodeStatus }) {
  if (status === 'done') {
    return (
      <span className="shrink-0 text-[10px] leading-none text-emerald-600">✓</span>
    );
  }
  if (status === 'error') {
    return <span className="shrink-0 text-[10px] leading-none text-red-500">✗</span>;
  }
  return null;
}

/** agent/human/route 通用节点芯片; retrieval 有值时挂 📚 {collection} 微徽标。 */
function DiagramChip({
  icon,
  id,
  agentName,
  collection,
  status,
  human = false,
}: {
  icon: string;
  id: string;
  agentName?: string;
  collection?: string;
  status: NodeStatus;
  human?: boolean;
}) {
  return (
    <div className={nodeChipCls(status, human)}>
      <span aria-hidden className="shrink-0 text-[11px] leading-none">
        {icon}
      </span>
      <span className="min-w-0 truncate font-mono text-[11px] leading-4 text-text-secondary">
        {id}
      </span>
      {agentName && (
        <span className="shrink-0 text-[10px] leading-none text-text-muted">
          ({agentName})
        </span>
      )}
      {collection && (
        <span className="shrink-0 rounded bg-sky-500/10 px-1 text-[9.5px] leading-4 text-sky-600 dark:text-sky-400">
          📚 {collection}
        </span>
      )}
      <StatusTick status={status} />
    </div>
  );
}

/** 兄弟节点之间的 1px 竖线连接（无需箭头 — 尺寸太小）。 */
function Connector() {
  return <div aria-hidden className="ml-3 h-2 w-px bg-card-border" />;
}

function MiniStepNode({
  step,
  run,
  retrieval,
}: {
  step: StepNode;
  run: DiagramRunState;
  retrieval: Record<string, string>;
}) {
  const type = asString(step.type);
  const id = asString(step.id);
  const status: NodeStatus = (id && run.statuses[id]) || 'pending';

  switch (type) {
    case 'agent': {
      const agentName = asString(step.agent);
      return (
        <DiagramChip
          icon="🤖"
          id={id || 'agent'}
          agentName={agentName || undefined}
          collection={agentName ? retrieval[agentName] : undefined}
          status={status}
        />
      );
    }
    case 'human':
      return <DiagramChip icon="🙋" id={id || 'human'} status={status} human />;
    case 'break_if': {
      const cond = condOf(step);
      return (
        <div className="flex items-center gap-1 px-0.5 text-[10.5px] text-text-muted">
          <span aria-hidden>◇</span>
          <span className="truncate font-mono">{cond.varName || 'break_if'}</span>
        </div>
      );
    }
    case 'loop': {
      const iter = id ? run.iterations[id] : undefined;
      const maxIters =
        typeof step.max_iters === 'number' || typeof step.max_iters === 'string'
          ? String(step.max_iters)
          : '?';
      return (
        <div className="rounded-md border border-dashed border-card-border p-1.5">
          <div className="mb-1 flex items-center gap-1.5 text-[10.5px] text-text-muted">
            <span aria-hidden>🔁</span>
            <span className="font-mono">×{maxIters}</span>
            {iter != null && (
              <span className="rounded bg-sky-500/15 px-1 font-mono text-[10px] leading-4 text-sky-600 dark:text-sky-400">
                #{iter}
              </span>
            )}
          </div>
          <MiniStepList steps={stepChildren(step)} run={run} retrieval={retrieval} />
        </div>
      );
    }
    case 'parallel':
      return (
        <div className="rounded-md border border-card-border/70 p-1.5">
          <div aria-hidden className="mb-1 text-[10.5px] leading-none text-text-muted">
            ⫲
          </div>
          <div className="flex flex-wrap gap-1">
            {stepChildren(step).map((child, i) => (
              <MiniStepNode key={i} step={child} run={run} retrieval={retrieval} />
            ))}
          </div>
        </div>
      );
    case 'route': {
      const agentName = asString(step.agent);
      const chosen = id ? run.choices[id] : undefined;
      const def = asString(step.default);
      return (
        <div className="rounded-md border border-card-border p-1.5">
          <DiagramChip
            icon="🔀"
            id={id || 'route'}
            agentName={agentName || undefined}
            collection={agentName ? retrieval[agentName] : undefined}
            status={status}
          />
          {Object.entries(routesOf(step)).map(([key, children]) => (
            <div key={key} className="mt-1">
              <div
                className={`flex items-center gap-1 font-mono text-[10px] ${
                  chosen === key ? 'font-semibold text-accent' : 'text-text-muted'
                }`}
              >
                <span aria-hidden>{chosen === key ? '➤' : '·'}</span>
                <span className="truncate">{key}</span>
                {def === key && <span className="shrink-0 opacity-70">*</span>}
              </div>
              {children.length > 0 && (
                <div className="ml-1.5 mt-0.5 border-l border-card-border pl-1.5">
                  <MiniStepList steps={children} run={run} retrieval={retrieval} />
                </div>
              )}
            </div>
          ))}
        </div>
      );
    }
    default:
      return null;
  }
}

function MiniStepList({
  steps,
  run,
  retrieval,
}: {
  steps: StepNode[];
  run: DiagramRunState;
  retrieval: Record<string, string>;
}) {
  return (
    <div>
      {steps.map((s, i) => (
        <Fragment key={i}>
          {i > 0 && <Connector />}
          <MiniStepNode step={s} run={run} retrieval={retrieval} />
        </Fragment>
      ))}
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

  const { auth } = useAuth();
  const rows = useMemo(
    () => (events ? eventsToRows(events, labels, auth.role) : []),
    [events, labels, auth.role],
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

/** 现场事件的来源 — 手动流式 vs 对话触发（轮询发现）；同时至多一条。 */
type LiveSource = 'manual' | 'auto' | null;

export function ChatWorkflowPanel() {
  const t = useT();
  const tw = t.chat.workflowPanel;
  const labels = useTimelineLabels();
  const addMessage = useChatStore((s) => s.addMessage);

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
  const abortRef = useRef<AbortController | null>(null);
  const running = status === 'running';

  // ---- 现场事件来源（手动/自动）----
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

  // ---- 事件 → 聊天转发（手动流与自动轮询共用同一 liveEvents 通道）----
  // 按 run 记「已转发到第几条」做去重：liveEvents 追加(手动)或整拉替换
  // (自动轮询/终态落定，均为同序超集)时只转发 [count, len) 的新尾巴。
  const forwardedCountRef = useRef(0);
  /** 转发消息挂的 runId — 手动先用本地键占位, workflow_start 到达换真 id。 */
  const chatRunIdRef = useRef('');
  const runNameRef = useRef('');

  /** 开始一条新的现场运行：重置事件通道 + 转发游标 + 名称。 */
  const beginLiveRun = useCallback((name: string, runKey: string) => {
    setRunName(name);
    runNameRef.current = name;
    chatRunIdRef.current = runKey;
    forwardedCountRef.current = 0;
    setLiveEvents([]);
  }, []);

  // ---- 迷你流程图：运行开始时拉全量 spec + agent 检索配置（KB 徽标）----
  const [spec, setSpec] = useState<WorkflowSpec | null>(null);
  const [retrievalByAgent, setRetrievalByAgent] = useState<Record<string, string>>(
    {},
  );
  const agentsRequestedRef = useRef(false);

  const loadDiagram = useCallback((workflowId: string) => {
    setSpec((cur) => (cur && cur.id === workflowId ? cur : null));
    agentAdminApi
      .getWorkflow(workflowId)
      .then((r) => setSpec(r.workflow))
      .catch(() => {
        /* 图拿不到就不画 — 运行本身不受影响 */
      });
    if (!agentsRequestedRef.current) {
      agentsRequestedRef.current = true;
      agentAdminApi
        .listAgents()
        .then((r) => {
          const map: Record<string, string> = {};
          for (const a of r.agents) {
            if (a.retrieval?.collection) map[a.id] = a.retrieval.collection;
          }
          setRetrievalByAgent(map);
        })
        .catch(() => {
          agentsRequestedRef.current = false; // 失败下次再试
        });
    }
  }, []);

  /** 事件 → 节点状态点亮（statuses/iterations/choices）。 */
  const diagramState = useMemo(() => deriveDiagramState(liveEvents), [liveEvents]);

  // 转发器：liveEvents 新尾巴 → WorkflowChatMessage。只转 4 类
  // （human_input_required / step_end / references / 终态），
  // step_start、loop_iter 等只点亮流程图，不进聊天。
  useEffect(() => {
    if (liveEvents.length <= forwardedCountRef.current) return;
    const start = forwardedCountRef.current;
    forwardedCountRef.current = liveEvents.length;
    const workflowName = runNameRef.current || undefined;
    for (let i = start; i < liveEvents.length; i++) {
      const e = liveEvents[i];
      const runId = chatRunIdRef.current || 'run';
      switch (e.type) {
        case 'human_input_required':
          addMessage({
            type: 'workflow',
            subtype: 'human_ask',
            runId,
            workflowName,
            step: str(e.step) || undefined,
            content: str(e.prompt),
            inputId: str(e.input_id),
          });
          break;
        case 'step_end':
          addMessage({
            type: 'workflow',
            subtype: 'output',
            runId,
            workflowName,
            step: str(e.step) || undefined,
            agent: str(e.agent) || undefined,
            content: str(e.output),
          });
          break;
        case 'references': {
          const rawHits = Array.isArray(e.hits) ? (e.hits as unknown[]) : [];
          const refs = rawHits.map((h) => {
            const o = (
              h !== null && typeof h === 'object' ? h : {}
            ) as Record<string, unknown>;
            return {
              source: typeof o.source === 'string' ? o.source : undefined,
              score: typeof o.score === 'number' ? o.score : undefined,
              preview: typeof o.preview === 'string' ? o.preview : undefined,
            };
          });
          addMessage({
            type: 'workflow',
            subtype: 'references',
            runId,
            workflowName,
            agent: str(e.agent) || undefined,
            query: str(e.query) || undefined,
            content: str(e.query),
            refs,
          });
          break;
        }
        case 'workflow_end':
          // 不重复完整输出 — 对话 agent 的回复/step_end 已经带了。
          addMessage({
            type: 'workflow',
            subtype: 'status',
            runId,
            workflowName,
            content: `✓ ${labels.done}`,
          });
          break;
        case 'error':
          addMessage({
            type: 'workflow',
            subtype: 'status',
            runId,
            workflowName,
            content: `✗ ${str(e.error) || labels.failed}`,
          });
          break;
        case 'aborted':
          addMessage({
            type: 'workflow',
            subtype: 'status',
            runId,
            workflowName,
            content: `⏸ ${labels.aborted}`,
          });
          break;
        default:
          break;
      }
    }
  }, [liveEvents, addMessage, labels]);

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
  // 面板挂载期间每 2.5s 轮一次 active 列表；已有现场运行（手动优先）或
  // 页面不可见时跳过；in-flight 防重入；卸载清 interval。
  useEffect(() => {
    let disposed = false;
    let inflight = false;
    const tick = async () => {
      if (inflight || document.hidden) return;
      if (liveSourceRef.current !== null) return; // 至多一条现场运行
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
        beginLiveRun(found.name || found.workflow_id, found.run_id);
        loadDiagram(found.workflow_id);
        openPanel(); // 对话触发 — 自动展开面板让用户看见流程图
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
  }, [beginLiveRun, loadDiagram, openPanel, setLiveSource]);

  // ---- 自动运行直播：每 2s 全量重拉事件（事件量小，整拉即可）；
  //      404 = 运行已结束 → 拉一次终态记录落定并刷新历史。
  //      整拉替换 liveEvents（同序超集）— 转发器按游标只转新尾巴。
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
        /* 网络抖动 — 保留现有事件，下一轮再试 */
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
    beginLiveRun(selected.name || selected.id, `manual-${Date.now()}`);
    loadDiagram(selected.id);
    let sawError = false;
    try {
      await agentAdminApi.streamWorkflow(
        selected.id,
        inputValues,
        (e: WorkflowEvent) => {
          // 记下自己的 run_id — 发现轮询据此跳过本条（防双显）；
          // 聊天转发消息也换用真实 run_id。
          if (e.type === 'workflow_start' && e.run_id) {
            manualRunIdRef.current = e.run_id;
            chatRunIdRef.current = e.run_id;
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

  const inputClass =
    'w-full rounded border border-card-border bg-window-bg px-2 py-1 font-mono text-[11px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none disabled:opacity-50';

  const specSteps: StepNode[] =
    spec && Array.isArray(spec.steps) ? (spec.steps as StepNode[]) : [];

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

          {/* Mini diagram — 动态状态指示器: spec 结构 + 事件点亮当前步骤。
              追问/产出/引用都在聊天里, 这里只看「跑到哪了」。 */}
          {spec !== null && (running || liveEvents.length > 0) && (
            <div className="rounded-md border border-card-border/60 bg-window-bg/40 p-2">
              <div className="mb-1.5 truncate text-[10.5px] font-medium uppercase tracking-wide text-text-muted">
                {asString(spec.name) || spec.id}
              </div>
              <MiniStepList
                steps={specSteps}
                run={diagramState}
                retrieval={retrievalByAgent}
              />
            </div>
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
