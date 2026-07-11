// 可视化工作流画布（SOD 07 §8）— 结构化垂直流，不是自由节点图。
//
// - 顺序 = 垂直堆叠 + 向下箭头（SVG 连接符本身就是拖放落点 DropZone）
// - loop = 虚线容器（id / max_iters 就地编辑，左缘 ↻ 回环示意）
// - parallel = 容器内水平分列（顶部分叉/底部汇合线；只收 agent 步骤）
// - route = 分支列（键名可改、default 单选、router 自身字段点头部展开）
// - agent/human/break_if = 叶子块，点击展开行内属性抽屉（同一时刻只开一个）
// - 拖拽：HTML5 原生 DnD。块头部整体可拖（application/x-wf-move {path}），
//   组件栏芯片拖入新步骤（application/x-wf-new {type}）；dragover 阶段读不到
//   dataTransfer 数据，所以真实判定走组件内 dragRef，dataTransfer 只作兜底。
// - 所有结构操作走 workflowSpecUtils 的不可变路径工具；单一 spec 状态由
//   父组件（WorkflowsPanel）持有，本组件只上报 onChange。

import { Fragment, createContext, useContext, useRef, useState } from 'react';
import { useT } from '../../contexts/LanguageContext';
import {
  COND_MODES,
  STEP_TYPES,
  asString,
  condOf,
  getAtPath,
  insertAtPath,
  isPathPrefix,
  moveStep,
  newStepTemplate,
  nextBranchKey,
  pathKey,
  removeAtPath,
  renameRouteKey,
  routesOf,
  stepChildren,
  updateAtPath,
  type CondMode,
  type Path,
  type SpecDraft,
  type StepNode,
  type StepType,
} from './workflowSpecUtils';

const MIME_MOVE = 'application/x-wf-move';
const MIME_NEW = 'application/x-wf-new';
const AGENT_DATALIST_ID = 'wf-canvas-agent-options';

const STEP_ICONS: Record<StepType, string> = {
  agent: '🤖',
  human: '🙋',
  break_if: '◇',
  loop: '🔁',
  parallel: '⫲',
  route: '🔀',
};

type ZoneAccepts = 'any' | 'agent';

type DragPayload =
  | { kind: 'move'; path: Path; stepType: string }
  | { kind: 'new'; stepType: StepType };

interface CanvasOps {
  spec: SpecDraft;
  selectedKey: string | null;
  select: (path: Path | null) => void;
  patchStep: (path: Path, patch: Record<string, unknown>) => void;
  deleteStep: (path: Path) => void;
  insertStep: (container: Path, index: number, type: StepType) => void;
  dragActive: boolean;
  dragIsMove: boolean;
  beginMove: (e: React.DragEvent, path: Path, stepType: string) => void;
  beginNew: (e: React.DragEvent, type: StepType) => void;
  endDrag: () => void;
  zoneAccepts: (container: Path, accepts: ZoneAccepts) => boolean;
  dropOn: (e: React.DragEvent, container: Path, index: number, accepts: ZoneAccepts) => void;
  renameBranch: (routePath: Path, oldKey: string, newKey: string) => boolean;
  removeBranch: (routePath: Path, key: string) => void;
  addBranch: (routePath: Path) => void;
  setDefaultBranch: (routePath: Path, key: string) => void;
}

const CanvasCtx = createContext<CanvasOps | null>(null);

function useCanvas(): CanvasOps {
  const ctx = useContext(CanvasCtx);
  if (!ctx) throw new Error('WorkflowCanvas context missing');
  return ctx;
}

// ---------- 根组件 ------------------------------------------------------------

export function WorkflowCanvas({
  spec,
  onChange,
  agents,
}: {
  spec: SpecDraft;
  onChange: (next: SpecDraft) => void;
  agents: string[];
}) {
  const t = useT();
  const tc = t.settings.workflows.canvas;
  const [selected, setSelected] = useState<Path | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const dragRef = useRef<DragPayload | null>(null);

  const patchStep = (path: Path, patch: Record<string, unknown>) => {
    const cur = getAtPath(spec, path);
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return;
    onChange(updateAtPath(spec, path, { ...(cur as StepNode), ...patch }));
  };

  const deleteStep = (path: Path) => {
    const next = removeAtPath(spec, path);
    if (next === spec) return;
    onChange(next);
    setSelected(null); // 后续兄弟序号整体前移 — 一律清空选中，避免指错块
  };

  const insertStep = (container: Path, index: number, type: StepType) => {
    const next = insertAtPath(spec, container, index, newStepTemplate(type, spec.steps));
    if (next === spec) return;
    onChange(next);
    const arr = getAtPath(spec, container);
    const i = Array.isArray(arr) ? Math.max(0, Math.min(index, arr.length)) : 0;
    setSelected([...container, i]); // 新块直接展开抽屉，顺手填字段
  };

  const endDrag = () => {
    dragRef.current = null;
    setDragActive(false);
  };

  const zoneAccepts = (container: Path, accepts: ZoneAccepts): boolean => {
    const d = dragRef.current;
    if (!d) return false;
    if (accepts === 'agent' && d.stepType !== 'agent') return false; // parallel 只收 agent
    if (d.kind === 'move' && isPathPrefix(d.path, container)) return false; // 不进自己后代
    return true;
  };

  const ops: CanvasOps = {
    spec,
    selectedKey: selected ? pathKey(selected) : null,
    select: setSelected,
    patchStep,
    deleteStep,
    insertStep,
    dragActive,
    dragIsMove: dragRef.current?.kind === 'move',
    beginMove: (e, path, stepType) => {
      e.stopPropagation(); // 嵌套块不触发祖先容器的拖拽
      e.dataTransfer.setData(MIME_MOVE, JSON.stringify({ path }));
      e.dataTransfer.effectAllowed = 'move';
      dragRef.current = { kind: 'move', path, stepType };
      setDragActive(true);
    },
    beginNew: (e, type) => {
      e.dataTransfer.setData(MIME_NEW, JSON.stringify({ type }));
      e.dataTransfer.effectAllowed = 'copy';
      dragRef.current = { kind: 'new', stepType: type };
      setDragActive(true);
    },
    endDrag,
    zoneAccepts,
    dropOn: (e, container, index, accepts) => {
      e.preventDefault();
      e.stopPropagation();
      let d = dragRef.current;
      if (!d) {
        // 兜底：dragRef 丢失时从 dataTransfer 复原（drop 阶段可读）
        try {
          const mv = e.dataTransfer.getData(MIME_MOVE);
          const nw = e.dataTransfer.getData(MIME_NEW);
          if (mv) {
            const { path } = JSON.parse(mv) as { path: Path };
            const node = getAtPath(spec, path);
            d = { kind: 'move', path, stepType: asString((node as StepNode | undefined)?.type) };
          } else if (nw) {
            d = { kind: 'new', stepType: (JSON.parse(nw) as { type: StepType }).type };
          }
        } catch {
          d = null;
        }
      }
      const allowed =
        d !== null &&
        (accepts !== 'agent' || d.stepType === 'agent') &&
        !(d.kind === 'move' && isPathPrefix(d.path, container));
      endDrag();
      if (!d || !allowed) return;
      if (d.kind === 'new') {
        insertStep(container, index, d.stepType);
        return;
      }
      const moved = moveStep(spec, d.path, container, index);
      if (moved) {
        onChange(moved.spec);
        setSelected(moved.path);
      }
    },
    renameBranch: (routePath, oldKey, newKey) => {
      const next = renameRouteKey(spec, routePath, oldKey, newKey);
      if (next === null) return false;
      onChange(next);
      if (selected && isPathPrefix([...routePath, 'routes', oldKey], selected)) setSelected(null);
      return true;
    },
    removeBranch: (routePath, key) => {
      const route = getAtPath(spec, routePath);
      if (route === null || typeof route !== 'object' || Array.isArray(route)) return;
      const routes = routesOf(route as StepNode);
      if (!(key in routes)) return;
      if (routes[key].length > 0 && !window.confirm(tc.route.confirmRemoveBranch(key))) return;
      const rest: Record<string, StepNode[]> = {};
      for (const k of Object.keys(routes)) if (k !== key) rest[k] = routes[k];
      const patch: Record<string, unknown> = { routes: rest };
      if (asString((route as StepNode).default) === key) patch.default = undefined;
      patchStep(routePath, patch);
      if (selected && isPathPrefix([...routePath, 'routes', key], selected)) setSelected(null);
    },
    addBranch: (routePath) => {
      const route = getAtPath(spec, routePath);
      if (route === null || typeof route !== 'object' || Array.isArray(route)) return;
      const routes = routesOf(route as StepNode);
      patchStep(routePath, { routes: { ...routes, [nextBranchKey(Object.keys(routes))]: [] } });
    },
    setDefaultBranch: (routePath, key) => patchStep(routePath, { default: key }),
  };

  return (
    <CanvasCtx.Provider value={ops}>
      <div className="rounded-lg border border-card-border bg-window-bg/40">
        <Palette />
        <div className="overflow-x-auto p-3" onClick={() => setSelected(null)}>
          <div className="mx-auto w-full max-w-[520px]">
            <StepList
              container={['steps']}
              steps={spec.steps}
              accepts="any"
              emptyText={tc.emptyCanvas}
            />
          </div>
        </div>
      </div>
      <datalist id={AGENT_DATALIST_ID}>
        {agents.map((a) => (
          <option key={a} value={a} />
        ))}
      </datalist>
    </CanvasCtx.Provider>
  );
}

// ---------- 组件栏（六类型芯片，可拖可点） -------------------------------------

function Palette() {
  const ctx = useCanvas();
  const t = useT();
  const tw = t.settings.workflows;
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-card-border/60 px-3 py-2">
      {STEP_TYPES.map((ty) => (
        <span
          key={ty}
          draggable
          onDragStart={(e) => ctx.beginNew(e, ty)}
          onDragEnd={ctx.endDrag}
          title={tw.cheatsheet.steps[ty]}
          className="cursor-grab select-none rounded-full border border-card-border bg-card-bg px-2 py-0.5 font-mono text-[11px] text-text-secondary hover:border-accent/50"
        >
          {STEP_ICONS[ty]} {ty}
        </span>
      ))}
      <span className="ml-1 text-[11px] text-text-muted">{tw.canvas.paletteHint}</span>
    </div>
  );
}

// ---------- 落点（块间连接符 = DropZone） --------------------------------------

function DropZone({
  container,
  index,
  accepts,
  horizontal = false,
}: {
  container: Path;
  index: number;
  accepts: ZoneAccepts;
  horizontal?: boolean;
}) {
  const ctx = useCanvas();
  const [over, setOver] = useState(false);
  // dragActive 是 state：拖拽一开始就重渲染，本判定在 render 期算一次即可。
  const accepting = ctx.dragActive && ctx.zoneAccepts(container, accepts);
  const highlight = accepting && over;
  const handlers = {
    onDragOver: (e: React.DragEvent) => {
      if (!accepting) return; // 不 preventDefault → 浏览器显示禁止落下
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = ctx.dragIsMove ? 'move' : 'copy';
      setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: React.DragEvent) => {
      setOver(false);
      ctx.dropOn(e, container, index, accepts);
    },
  };
  if (horizontal) {
    // parallel 列间的竖直细条
    return (
      <div {...handlers} className="flex w-3 shrink-0 items-stretch justify-center self-stretch">
        <span
          className={`my-1.5 w-0.5 rounded ${
            highlight ? 'bg-accent' : accepting ? 'bg-accent/25' : 'bg-transparent'
          }`}
        />
      </div>
    );
  }
  // 常规块间连接符：竖线 + 箭头，命中时加粗变色（accent line grows）
  return (
    <div {...handlers} className="flex h-5 shrink-0 items-center justify-center">
      <svg
        viewBox="0 0 12 20"
        className={`h-5 w-3 ${
          highlight ? 'text-accent' : accepting ? 'text-accent/50' : 'text-card-border'
        }`}
      >
        <line
          x1="6"
          y1="1"
          x2="6"
          y2="13"
          stroke="currentColor"
          strokeWidth={highlight ? 2.5 : 1.5}
        />
        <path
          d="M2 12.5 L6 19 L10 12.5"
          fill="none"
          stroke="currentColor"
          strokeWidth={highlight ? 2.5 : 1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

// ---------- 垂直步骤列（容器首/尾/块间都有落点 + 尾部添加菜单） -----------------

function StepList({
  container,
  steps,
  accepts,
  emptyText,
}: {
  container: Path;
  steps: StepNode[];
  accepts: ZoneAccepts;
  emptyText: string;
}) {
  return (
    <div className="flex flex-col">
      {steps.map((s, i) => (
        <Fragment key={i}>
          <DropZone container={container} index={i} accepts={accepts} />
          <StepBlock step={s} path={[...container, i]} />
        </Fragment>
      ))}
      <DropZone container={container} index={steps.length} accepts={accepts} />
      {steps.length === 0 && (
        <p className="py-0.5 text-center text-[11px] italic text-text-muted">{emptyText}</p>
      )}
      <AddStepMenu container={container} index={steps.length} />
    </div>
  );
}

/** 容器尾部的「+ 添加步骤」按钮 + 六类型小菜单（拖拽之外的无障碍插入路径）。 */
function AddStepMenu({ container, index }: { container: Path; index: number }) {
  const ctx = useCanvas();
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="relative self-center">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className="rounded border border-dashed border-card-border px-2 py-0.5 text-[11px] text-text-muted hover:border-accent/50 hover:text-text-primary"
      >
        {t.settings.workflows.canvas.addStep}
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
            }}
          />
          <div className="absolute left-1/2 top-full z-20 mt-1 w-36 -translate-x-1/2 rounded-lg border border-card-border bg-card-bg p-1 shadow-lg">
            {STEP_TYPES.map((ty) => (
              <button
                key={ty}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  ctx.insertStep(container, index, ty);
                }}
                className="w-full rounded px-2 py-1 text-left font-mono text-xs text-text-secondary hover:bg-card-border/40"
              >
                {STEP_ICONS[ty]} {ty}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---------- 块分派 ------------------------------------------------------------

function StepBlock({ step, path }: { step: StepNode; path: Path }) {
  switch (asString(step?.type)) {
    case 'agent':
      return <LeafBlock step={step} path={path} kind="agent" />;
    case 'human':
      return <LeafBlock step={step} path={path} kind="human" />;
    case 'break_if':
      return <BreakIfBlock step={step} path={path} />;
    case 'loop':
      return <LoopBlock step={step} path={path} />;
    case 'parallel':
      return <ParallelBlock step={step} path={path} />;
    case 'route':
      return <RouteBlock step={step} path={path} />;
    default:
      return <UnknownBlock step={step} path={path} />;
  }
}

// ---------- 叶子块：agent / human ----------------------------------------------

function LeafBlock({
  step,
  path,
  kind,
}: {
  step: StepNode;
  path: Path;
  kind: 'agent' | 'human';
}) {
  const ctx = useCanvas();
  const t = useT();
  const tc = t.settings.workflows.canvas;
  const selected = ctx.selectedKey === pathKey(path);
  const isAgent = kind === 'agent';
  const id = asString(step.id);
  const prompt = asString(step.prompt);
  return (
    <div className="min-w-0">
      <div
        draggable
        onDragStart={(e) => ctx.beginMove(e, path, kind)}
        onDragEnd={ctx.endDrag}
        onClick={(e) => {
          e.stopPropagation();
          ctx.select(selected ? null : path);
        }}
        title={t.settings.workflows.cheatsheet.steps[kind]}
        className={`cursor-grab rounded-lg border p-2 ${
          isAgent ? 'bg-card-bg' : 'bg-accent-warm/10'
        } ${
          selected
            ? 'border-accent ring-1 ring-accent'
            : isAgent
              ? 'border-card-border hover:border-accent/40'
              : 'border-accent-warm/40 hover:border-accent-warm'
        }`}
      >
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <span className="shrink-0">{isAgent ? '🤖' : '🙋'}</span>
          {isAgent ? (
            <span className="truncate font-mono font-semibold text-text-primary">
              {asString(step.agent) || '—'}
            </span>
          ) : (
            <span className="truncate font-semibold text-text-primary">{tc.humanLabel}</span>
          )}
          {id && (
            <span className="ml-auto shrink-0 rounded-full border border-accent/30 bg-accent/15 px-1.5 py-0.5 font-mono text-[10px] text-accent-soft">
              {id}
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate text-[11px] text-text-muted">
          {prompt || tc.emptyPrompt}
        </p>
      </div>
      {selected && <LeafDrawer step={step} path={path} showAgent={isAgent} />}
    </div>
  );
}

/** agent/human 的属性抽屉；route 头部也复用（id + agent + prompt）。 */
function LeafDrawer({
  step,
  path,
  showAgent,
}: {
  step: StepNode;
  path: Path;
  showAgent: boolean;
}) {
  const ctx = useCanvas();
  const t = useT();
  const tc = t.settings.workflows.canvas;
  return (
    <div
      className="mt-1 space-y-2 rounded-lg border border-accent/40 bg-card-bg/70 p-2"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex flex-wrap items-end gap-2">
        <MiniField label="id" className="w-32">
          <input
            value={asString(step.id)}
            onChange={(e) => ctx.patchStep(path, { id: e.target.value })}
            className={miniInput + ' font-mono'}
          />
        </MiniField>
        {showAgent && (
          <MiniField label="agent" className="min-w-[130px] flex-1">
            <input
              list={AGENT_DATALIST_ID}
              value={asString(step.agent)}
              onChange={(e) => ctx.patchStep(path, { agent: e.target.value })}
              title={tc.agentHint}
              className={miniInput + ' font-mono'}
            />
          </MiniField>
        )}
        <DeleteBtn onClick={() => ctx.deleteStep(path)} className="mb-0.5 ml-auto" />
      </div>
      <MiniField label="prompt">
        <textarea
          rows={5}
          spellCheck={false}
          value={asString(step.prompt)}
          onChange={(e) => ctx.patchStep(path, { prompt: e.target.value })}
          className={miniInput + ' resize-y font-mono leading-relaxed'}
        />
      </MiniField>
      {showAgent && <p className="text-[10px] text-text-muted">{tc.agentHint}</p>}
    </div>
  );
}

// ---------- break_if 条件块 -----------------------------------------------------

function BreakIfBlock({ step, path }: { step: StepNode; path: Path }) {
  const ctx = useCanvas();
  const t = useT();
  const tc = t.settings.workflows.canvas;
  const selected = ctx.selectedKey === pathKey(path);
  const cond = condOf(step);
  const summary =
    cond.varName || cond.value ? tc.cond[cond.mode](cond.varName, cond.value) : tc.cond.empty;

  const setCond = (patch: Partial<{ varName: string; mode: CondMode; value: string }>) => {
    const c = { ...cond, ...patch };
    ctx.patchStep(path, { when: { var: c.varName, [c.mode]: c.value } });
  };

  return (
    <div className="min-w-0">
      <div
        draggable
        onDragStart={(e) => ctx.beginMove(e, path, 'break_if')}
        onDragEnd={ctx.endDrag}
        onClick={(e) => {
          e.stopPropagation();
          ctx.select(selected ? null : path);
        }}
        title={t.settings.workflows.cheatsheet.steps.break_if}
        className={`mx-auto flex w-fit max-w-full cursor-grab items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] ${
          selected
            ? 'border-accent bg-accent/10 text-text-primary ring-1 ring-accent'
            : 'border-accent-warm/40 bg-accent-warm/10 text-accent-warm hover:border-accent-warm'
        }`}
      >
        <span className="shrink-0">◇</span>
        <span className="truncate font-mono">{summary}</span>
      </div>
      {selected && (
        <div
          className="mt-1 space-y-1.5 rounded-lg border border-accent/40 bg-card-bg/70 p-2"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex flex-wrap items-end gap-2">
            <MiniField label="var" className="w-28">
              <input
                value={cond.varName}
                onChange={(e) => setCond({ varName: e.target.value })}
                className={miniInput + ' font-mono'}
              />
            </MiniField>
            <MiniField label="mode" className="w-28">
              <select
                value={cond.mode}
                onChange={(e) => setCond({ mode: e.target.value as CondMode })}
                className={miniInput}
              >
                {COND_MODES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </MiniField>
            <MiniField label="value" className="min-w-[120px] flex-1">
              <input
                value={cond.value}
                onChange={(e) => setCond({ value: e.target.value })}
                className={miniInput + ' font-mono'}
              />
            </MiniField>
            <DeleteBtn onClick={() => ctx.deleteStep(path)} className="mb-0.5" />
          </div>
          <p className="text-[10px] text-text-muted">{tc.regexHint}</p>
        </div>
      )}
    </div>
  );
}

// ---------- loop 容器 -----------------------------------------------------------

function LoopBlock({ step, path }: { step: StepNode; path: Path }) {
  const ctx = useCanvas();
  const t = useT();
  const tc = t.settings.workflows.canvas;
  const raw = Number(step.max_iters);
  const iters = Number.isFinite(raw) && raw >= 1 ? Math.min(20, Math.round(raw)) : 3;
  return (
    <div className="rounded-lg border border-dashed border-card-border bg-card-bg/40">
      <div className="flex items-center gap-2 border-b border-dashed border-card-border/60 px-2.5 py-1.5 text-xs">
        <span
          draggable
          onDragStart={(e) => ctx.beginMove(e, path, 'loop')}
          onDragEnd={ctx.endDrag}
          title={t.settings.workflows.cheatsheet.steps.loop}
          className="flex shrink-0 cursor-grab items-center gap-1.5"
        >
          <span>🔁</span>
          <span className="font-mono font-semibold text-text-primary">loop</span>
        </span>
        <input
          value={asString(step.id)}
          placeholder="id"
          onClick={(e) => e.stopPropagation()}
          onChange={(e) =>
            ctx.patchStep(path, { id: e.target.value === '' ? undefined : e.target.value })
          }
          className="w-24 rounded border border-card-border bg-window-bg px-1.5 py-0.5 font-mono text-[11px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
        <span className="ml-auto flex shrink-0 items-center gap-1 text-text-muted">
          ×
          <MaxItersInput
            value={iters}
            title={tc.maxItersTitle}
            onCommit={(n) => ctx.patchStep(path, { max_iters: n })}
          />
        </span>
        <DeleteBtn onClick={() => ctx.deleteStep(path)} />
      </div>
      <div className="relative py-1.5 pl-7 pr-2.5">
        {/* 左缘回环示意 — 从底回到顶 */}
        <span
          className="absolute left-1.5 top-1/2 -translate-y-1/2 text-sm text-text-muted"
          aria-hidden
        >
          ↻
        </span>
        <StepList
          container={[...path, 'steps']}
          steps={stepChildren(step)}
          accepts="any"
          emptyText={tc.emptyContainer}
        />
      </div>
    </div>
  );
}

/** max_iters 步进输入：本地草稿 + 合法（1–20）即提交，失焦回落 spec 值。 */
function MaxItersInput({
  value,
  title,
  onCommit,
}: {
  value: number;
  title: string;
  onCommit: (n: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="number"
      min={1}
      max={20}
      title={title}
      value={draft ?? String(value)}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = Math.round(Number(e.target.value));
        if (e.target.value !== '' && Number.isFinite(n) && n >= 1 && n <= 20) onCommit(n);
      }}
      onBlur={() => setDraft(null)}
      className="w-14 rounded border border-card-border bg-window-bg px-1 py-0.5 text-[11px] text-text-primary focus:border-accent focus:outline-none"
    />
  );
}

// ---------- parallel 容器 -------------------------------------------------------

function ParallelBlock({ step, path }: { step: StepNode; path: Path }) {
  const ctx = useCanvas();
  const t = useT();
  const tc = t.settings.workflows.canvas;
  const children = stepChildren(step);
  const container = [...path, 'steps'];
  return (
    <div className="rounded-lg border border-card-border bg-card-bg/40">
      <div className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
        <span
          draggable
          onDragStart={(e) => ctx.beginMove(e, path, 'parallel')}
          onDragEnd={ctx.endDrag}
          title={t.settings.workflows.cheatsheet.steps.parallel}
          className="flex flex-1 cursor-grab items-center gap-1.5"
        >
          <span>⫲</span>
          <span className="font-mono font-semibold text-text-primary">parallel</span>
        </span>
        <DeleteBtn onClick={() => ctx.deleteStep(path)} />
      </div>
      {/* 分叉线 */}
      <div className="mx-5 border-t border-card-border/70" />
      {children.length === 0 ? (
        <div className="px-3 py-1">
          <DropZone container={container} index={0} accepts="agent" />
          <p className="py-0.5 text-center text-[11px] italic text-text-muted">
            {tc.emptyContainer}
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-stretch px-1.5 py-1">
          {children.map((s, i) => (
            <Fragment key={i}>
              <DropZone horizontal container={container} index={i} accepts="agent" />
              <div className="flex min-w-[150px] flex-1 flex-col py-0.5">
                <span className="mx-auto h-2 w-px bg-card-border/70" />
                <StepBlock step={s} path={[...container, i]} />
                <span className="mx-auto mt-auto h-2 w-px bg-card-border/70" />
              </div>
            </Fragment>
          ))}
          <DropZone horizontal container={container} index={children.length} accepts="agent" />
        </div>
      )}
      {/* 汇合线 */}
      <div className="mx-5 border-t border-card-border/70" />
      <div className="flex justify-center py-1.5">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            ctx.insertStep(container, children.length, 'agent');
          }}
          className="rounded border border-dashed border-card-border px-2 py-0.5 text-[11px] text-text-muted hover:border-accent/50 hover:text-text-primary"
        >
          {tc.addBranch}
        </button>
      </div>
    </div>
  );
}

// ---------- route 容器 ----------------------------------------------------------

function RouteBlock({ step, path }: { step: StepNode; path: Path }) {
  const ctx = useCanvas();
  const t = useT();
  const tc = t.settings.workflows.canvas;
  const selected = ctx.selectedKey === pathKey(path);
  const routes = routesOf(step);
  const def = asString(step.default);
  return (
    <div
      className={`rounded-lg border bg-card-bg/40 ${
        selected ? 'border-accent ring-1 ring-accent' : 'border-card-border'
      }`}
    >
      <div
        onClick={(e) => {
          e.stopPropagation();
          ctx.select(selected ? null : path);
        }}
        title={t.settings.workflows.cheatsheet.steps.route}
        className="flex min-w-0 cursor-pointer items-center gap-2 px-2.5 py-1.5 text-xs"
      >
        <span
          draggable
          onDragStart={(e) => ctx.beginMove(e, path, 'route')}
          onDragEnd={ctx.endDrag}
          className="flex shrink-0 cursor-grab items-center gap-1.5"
        >
          <span>🔀</span>
          <span className="font-mono font-semibold text-text-primary">route</span>
        </span>
        <span className="shrink-0 rounded-full border border-accent/30 bg-accent/15 px-1.5 py-0.5 font-mono text-[10px] text-accent-soft">
          {asString(step.id) || '—'}
        </span>
        <span className="shrink-0 font-mono text-text-secondary">{asString(step.agent)}</span>
        <span className="flex-1 truncate text-[11px] text-text-muted">
          {asString(step.prompt) || tc.emptyPrompt}
        </span>
        <DeleteBtn onClick={() => ctx.deleteStep(path)} />
      </div>
      {selected && (
        <div className="px-2 pb-1">
          <LeafDrawer step={step} path={path} showAgent />
        </div>
      )}
      <div className="flex flex-wrap items-stretch gap-2 px-2 pb-2 pt-1">
        {Object.entries(routes).map(([key, branch]) => (
          <RouteBranch
            key={key}
            routePath={path}
            branchKey={key}
            steps={branch}
            isDefault={def === key}
          />
        ))}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            ctx.addBranch(path);
          }}
          className="self-center rounded border border-dashed border-card-border px-2 py-0.5 text-[11px] text-text-muted hover:border-accent/50 hover:text-text-primary"
        >
          {tc.addBranch}
        </button>
      </div>
    </div>
  );
}

function RouteBranch({
  routePath,
  branchKey,
  steps,
  isDefault,
}: {
  routePath: Path;
  branchKey: string;
  steps: StepNode[];
  isDefault: boolean;
}) {
  const ctx = useCanvas();
  const t = useT();
  const tc = t.settings.workflows.canvas;
  return (
    <div className="min-w-[180px] max-w-full flex-1 rounded-lg border border-card-border/70 bg-window-bg/40 p-1.5">
      <div className="flex items-center gap-1.5 pb-1">
        <BranchKeyInput routePath={routePath} branchKey={branchKey} />
        <label
          className="flex shrink-0 cursor-pointer items-center gap-1 text-[10px] text-text-muted"
          title={tc.route.defaultTitle}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="radio"
            checked={isDefault}
            onChange={() => ctx.setDefaultBranch(routePath, branchKey)}
            className="h-3 w-3"
          />
          {tc.route.defaultLabel}
        </label>
        <button
          type="button"
          title={tc.route.removeBranch}
          onClick={(e) => {
            e.stopPropagation();
            ctx.removeBranch(routePath, branchKey);
          }}
          className="ml-auto shrink-0 text-xs text-text-muted hover:text-status-danger"
        >
          ✕
        </button>
      </div>
      <StepList
        container={[...routePath, 'routes', branchKey]}
        steps={steps}
        accepts="any"
        emptyText={tc.emptyContainer}
      />
    </div>
  );
}

/** 分支键输入：本地草稿，失焦/回车才提交重命名（避免中间态合并分支）。 */
function BranchKeyInput({ routePath, branchKey }: { routePath: Path; branchKey: string }) {
  const ctx = useCanvas();
  const t = useT();
  const [draft, setDraft] = useState<string | null>(null);
  const routes = routesOf((getAtPath(ctx.spec, routePath) ?? {}) as StepNode);
  const trimmed = draft?.trim() ?? branchKey;
  const invalid = draft !== null && (trimmed === '' || (trimmed !== branchKey && trimmed in routes));
  const commit = () => {
    if (draft === null) return;
    if (trimmed !== '' && trimmed !== branchKey) ctx.renameBranch(routePath, branchKey, trimmed);
    setDraft(null); // 成功时父级以新 key 重挂载本组件；失败时回落旧 key
  };
  return (
    <input
      value={draft ?? branchKey}
      title={t.settings.workflows.canvas.route.keyTitle}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      }}
      className={`w-16 min-w-0 flex-1 rounded border bg-window-bg px-1.5 py-0.5 font-mono text-[11px] text-text-primary focus:outline-none ${
        invalid ? 'border-status-danger' : 'border-card-border focus:border-accent'
      }`}
    />
  );
}

// ---------- 未知类型兜底（JSON 面板可能写入任何形态） ---------------------------

function UnknownBlock({ step, path }: { step: StepNode; path: Path }) {
  const ctx = useCanvas();
  const t = useT();
  const tc = t.settings.workflows.canvas;
  const selected = ctx.selectedKey === pathKey(path);
  return (
    <div className="min-w-0">
      <div
        draggable
        onDragStart={(e) => ctx.beginMove(e, path, asString(step?.type))}
        onDragEnd={ctx.endDrag}
        onClick={(e) => {
          e.stopPropagation();
          ctx.select(selected ? null : path);
        }}
        className={`cursor-grab rounded-lg border border-dashed p-2 text-xs ${
          selected
            ? 'border-accent ring-1 ring-accent'
            : 'border-status-warning/60 bg-status-warning/5'
        }`}
      >
        <span className="font-mono text-status-warning">⬚ {asString(step?.type) || '?'}</span>
        <p className="mt-0.5 truncate font-mono text-[11px] text-text-muted">
          {JSON.stringify(step)}
        </p>
      </div>
      {selected && (
        <div
          className="mt-1 flex items-center gap-2 rounded-lg border border-accent/40 bg-card-bg/70 p-2"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="flex-1 text-[10px] text-text-muted">{tc.unknownHint}</p>
          <DeleteBtn onClick={() => ctx.deleteStep(path)} />
        </div>
      )}
    </div>
  );
}

// ---------- 小件 ---------------------------------------------------------------

function DeleteBtn({ onClick, className }: { onClick: () => void; className?: string }) {
  const t = useT();
  return (
    <button
      type="button"
      title={t.settings.workflows.canvas.deleteStep}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`shrink-0 text-xs text-text-muted hover:text-status-danger ${className ?? ''}`}
    >
      🗑
    </button>
  );
}

function MiniField({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`flex flex-col gap-0.5 ${className ?? ''}`}>
      <span className="font-mono text-[10px] uppercase tracking-wide text-text-muted">
        {label}
      </span>
      {children}
    </label>
  );
}

const miniInput =
  'w-full rounded border border-card-border bg-window-bg px-1.5 py-1 text-xs text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none';
