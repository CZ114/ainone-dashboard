// 工作流 spec 的纯函数层 — WorkflowCanvas（可视化编辑器）的树操作工具。
//
// spec 是严格的「顺序 + 嵌套」树（SOD 07 §8）：steps 数组顺序执行，
// loop/parallel 经 `steps`、route 经 `routes[key]` 嵌套子数组。画布里的
// 每个块由**树路径**定位（如 ['steps',1,'steps',0]、['steps',2,'routes','医疗',0]），
// 所有编辑 = 对单一 spec 状态做不可变更新（structuredClone）。
//
// 数据可能来自右侧 JSON 面板的自由编辑，所以 StepNode 按不透明
// Record 处理，访问一律走防御性读取（asString / stepChildren / routesOf）。
// 本文件不 import React —— 方便单独做 node 侧的行为验证。

export type Path = (string | number)[];

/** 六种步骤组件（服务端 validate_spec 的词汇表，SOD 06）。 */
export type StepType = 'agent' | 'human' | 'break_if' | 'loop' | 'parallel' | 'route';

export const STEP_TYPES: readonly StepType[] = [
  'agent',
  'human',
  'break_if',
  'loop',
  'parallel',
  'route',
];

export type CondMode = 'contains' | 'regex' | 'equals';

export const COND_MODES: readonly CondMode[] = ['contains', 'regex', 'equals'];

/** 单个步骤 — 形态由服务端校验，前端按不透明 JSON 处理（可含未知字段）。 */
export type StepNode = Record<string, unknown>;

/** 画布编辑的顶层 spec（id 不在其中 — 由 URL/独立字段承载）。 */
export interface SpecDraft {
  name: string;
  description: string;
  inputs: string[];
  output?: string;
  steps: StepNode[];
  [extra: string]: unknown;
}

// ---------- 防御性读取 --------------------------------------------------------

export function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/** loop/parallel 的子步骤数组（缺失/非数组 → []）。 */
export function stepChildren(step: StepNode): StepNode[] {
  return Array.isArray(step.steps) ? (step.steps as StepNode[]) : [];
}

/** route 的分支表（缺失/非法 → {}；非数组分支值按空分支展示）。 */
export function routesOf(step: StepNode): Record<string, StepNode[]> {
  const r = step.routes;
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return {};
  const out: Record<string, StepNode[]> = {};
  for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
    out[k] = Array.isArray(v) ? (v as StepNode[]) : [];
  }
  return out;
}

/** break_if 条件三件套（contains/regex/equals 三选一）— 总是给出可编辑的形态。 */
export function condOf(step: StepNode): { varName: string; mode: CondMode; value: string } {
  const raw = step.when;
  const w =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const varName = asString(w.var);
  for (const mode of COND_MODES) {
    if (typeof w[mode] === 'string') return { varName, mode, value: w[mode] as string };
  }
  return { varName, mode: 'contains', value: '' };
}

// ---------- 路径工具 ----------------------------------------------------------

export function pathKey(path: Path): string {
  return JSON.stringify(path);
}

export function pathsEqual(a: Path, b: Path): boolean {
  return a.length === b.length && a.every((seg, i) => seg === b[i]);
}

/** prefix 是否为 path 的前缀（含相等）— 用于「不可拖进自己后代」守卫。 */
export function isPathPrefix(prefix: Path, path: Path): boolean {
  return prefix.length <= path.length && prefix.every((seg, i) => seg === path[i]);
}

export function getAtPath(root: unknown, path: Path): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (Array.isArray(cur) && typeof seg === 'number') {
      cur = cur[seg];
    } else if (cur !== null && typeof cur === 'object' && typeof seg === 'string') {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * 不可变地把 path 处的值整体替换为 value（value 也会被 clone）。
 * 父节点不存在/类型不符 → 原样返回 root（调用方可用引用相等判断失败）。
 */
export function updateAtPath(root: SpecDraft, path: Path, value: unknown): SpecDraft {
  if (path.length === 0) return structuredClone(value) as SpecDraft;
  const next = structuredClone(root);
  const parent = getAtPath(next, path.slice(0, -1));
  const last = path[path.length - 1];
  if (Array.isArray(parent) && typeof last === 'number') {
    if (last < 0 || last >= parent.length) return root;
    parent[last] = structuredClone(value);
  } else if (parent !== null && typeof parent === 'object' && typeof last === 'string') {
    (parent as Record<string, unknown>)[last] = structuredClone(value);
  } else {
    return root;
  }
  return next;
}

/** 不可变删除：数组尾段 → splice；字符串尾段 → delete（如删除 route 分支键）。 */
export function removeAtPath(root: SpecDraft, path: Path): SpecDraft {
  if (path.length === 0) return root;
  const next = structuredClone(root);
  const parent = getAtPath(next, path.slice(0, -1));
  const last = path[path.length - 1];
  if (Array.isArray(parent) && typeof last === 'number') {
    if (last < 0 || last >= parent.length) return root;
    parent.splice(last, 1);
  } else if (parent !== null && typeof parent === 'object' && typeof last === 'string') {
    if (!(last in (parent as Record<string, unknown>))) return root;
    delete (parent as Record<string, unknown>)[last];
  } else {
    return root;
  }
  return next;
}

/** 不可变插入：containerPath 必须指向数组；index 自动夹取到 [0, len]。 */
export function insertAtPath(
  root: SpecDraft,
  containerPath: Path,
  index: number,
  value: unknown,
): SpecDraft {
  const next = structuredClone(root);
  const arr = getAtPath(next, containerPath);
  if (!Array.isArray(arr)) return root;
  const i = Math.max(0, Math.min(index, arr.length));
  arr.splice(i, 0, structuredClone(value));
  return next;
}

/** from 被移除后，修正共享同一祖先数组的路径（前方兄弟被删 → 序号 -1）。 */
function adjustPathAfterRemoval(path: Path, removed: Path): Path {
  const parent = removed.slice(0, -1);
  const removedIndex = removed[removed.length - 1];
  if (typeof removedIndex !== 'number') return path;
  if (path.length <= parent.length || !isPathPrefix(parent, path)) return path;
  const seg = path[parent.length];
  if (typeof seg === 'number' && seg > removedIndex) {
    const out = [...path];
    out[parent.length] = seg - 1;
    return out;
  }
  return path;
}

/**
 * 拖拽移动语义：源路径摘除 → 目标 (containerPath, index) 插入。
 * - 同容器且 sourceIndex < targetIndex → 目标序号先 -1（移除让后面整体前移）；
 * - 跨容器但目标容器路径途经源的**后方兄弟** → 该段序号 -1（同一原因）；
 * - 目标容器在源的子树内（拖进自己后代）→ 拒绝，返回 null；
 * - 任何一步失败 → null（root 不变，调用方直接忽略本次拖放）。
 * 成功返回新 spec 与被移动块的新路径（用于保持选中态）。
 */
export function moveStep(
  root: SpecDraft,
  from: Path,
  toContainer: Path,
  toIndex: number,
): { spec: SpecDraft; path: Path } | null {
  if (from.length === 0) return null;
  if (isPathPrefix(from, toContainer)) return null; // 拖进自己/自己的后代
  const fromIndex = from[from.length - 1];
  if (typeof fromIndex !== 'number') return null;
  const node = getAtPath(root, from);
  if (node === undefined) return null;

  let insertIndex = toIndex;
  if (pathsEqual(from.slice(0, -1), toContainer) && fromIndex < toIndex) insertIndex -= 1;

  const without = removeAtPath(root, from);
  if (without === root) return null;
  const container = adjustPathAfterRemoval(toContainer, from);
  const arr = getAtPath(without, container);
  if (!Array.isArray(arr)) return null;
  const clamped = Math.max(0, Math.min(insertIndex, arr.length));
  const spec = insertAtPath(without, container, clamped, node);
  if (spec === without) return null;
  return { spec, path: [...container, clamped] };
}

// ---------- id / 分支键 / 模板 -------------------------------------------------

/** 收集整棵树里出现过的步骤 id（含 loop/parallel/route 的嵌套子树）。 */
export function collectIds(steps: StepNode[], into: Set<string> = new Set()): Set<string> {
  for (const s of steps) {
    if (s === null || typeof s !== 'object') continue;
    if (typeof s.id === 'string' && s.id) into.add(s.id);
    if (Array.isArray(s.steps)) collectIds(s.steps as StepNode[], into);
    if (s.routes !== null && typeof s.routes === 'object' && !Array.isArray(s.routes)) {
      for (const branch of Object.values(s.routes as Record<string, unknown>)) {
        if (Array.isArray(branch)) collectIds(branch as StepNode[], into);
      }
    }
  }
  return into;
}

/** base + 自增序号，避开整棵树里已有的 id（step1, step2, …）。 */
export function autoId(base: string, steps: StepNode[]): string {
  const ids = collectIds(steps);
  let n = 1;
  while (ids.has(`${base}${n}`)) n += 1;
  return `${base}${n}`;
}

/** route 新分支键：A…Z 里第一个空闲的，用完退到 branch1, branch2…。 */
export function nextBranchKey(existing: string[]): string {
  const used = new Set(existing);
  for (let i = 0; i < 26; i++) {
    const k = String.fromCharCode(65 + i);
    if (!used.has(k)) return k;
  }
  let n = 1;
  while (used.has(`branch${n}`)) n += 1;
  return `branch${n}`;
}

/** 从组件栏拖入/点击插入时的新步骤模板；id 用 autoId 全树去重。 */
export function newStepTemplate(type: StepType, allSteps: StepNode[]): StepNode {
  switch (type) {
    case 'agent':
      return { type: 'agent', id: autoId('step', allSteps), agent: 'default', prompt: '{task}' };
    case 'human':
      return { type: 'human', id: autoId('ask', allSteps), prompt: '' };
    case 'break_if':
      return { type: 'break_if', when: { var: '', contains: '' } };
    case 'loop':
      return { type: 'loop', max_iters: 3, steps: [] };
    case 'parallel':
      return { type: 'parallel', steps: [] };
    case 'route':
      return {
        type: 'route',
        id: autoId('route', allSteps),
        agent: 'default',
        prompt: '',
        routes: { A: [], B: [] },
        default: 'A',
      };
  }
}

/** 重命名 route 分支键：保持分支顺序，default 指向旧键时一并改。失败 → null。 */
export function renameRouteKey(
  root: SpecDraft,
  routePath: Path,
  oldKey: string,
  newKey: string,
): SpecDraft | null {
  if (!newKey) return null;
  if (newKey === oldKey) return root;
  const route = getAtPath(root, routePath);
  if (route === null || typeof route !== 'object' || Array.isArray(route)) return null;
  const routes = (route as StepNode).routes;
  if (routes === null || typeof routes !== 'object' || Array.isArray(routes)) return null;
  const table = routes as Record<string, unknown>;
  if (!(oldKey in table) || newKey in table) return null;

  const next = structuredClone(root);
  const r = getAtPath(next, routePath) as StepNode;
  const old = r.routes as Record<string, unknown>;
  const rebuilt: Record<string, unknown> = {};
  for (const k of Object.keys(old)) rebuilt[k === oldKey ? newKey : k] = old[k];
  r.routes = rebuilt;
  if (r.default === oldKey) r.default = newKey;
  return next;
}

// ---------- spec ⇄ JSON -------------------------------------------------------

/** 把任意 JSON 对象整形成画布可编辑的 SpecDraft（剔除 id；额外字段透传）。 */
export function normalizeSpec(raw: Record<string, unknown>): SpecDraft {
  const spec = structuredClone(raw) as SpecDraft;
  delete (spec as Record<string, unknown>).id; // id 由 URL/独立字段承载
  if (typeof spec.name !== 'string') spec.name = '';
  if (typeof spec.description !== 'string') spec.description = '';
  spec.inputs = Array.isArray(spec.inputs)
    ? (spec.inputs as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  if (!Array.isArray(spec.steps)) spec.steps = [];
  if (typeof spec.output !== 'string') delete spec.output;
  return spec;
}

export type SpecParseResult =
  | { ok: true; spec: SpecDraft }
  | { ok: false; notObject: boolean; message: string };

/** 侧栏 JSON → spec：语法错/非对象都以结构化结果返回（错误文案由调用方 i18n）。 */
export function parseSpecJson(text: string): SpecParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      notObject: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, notObject: true, message: '' };
  }
  return { ok: true, spec: normalizeSpec(parsed as Record<string, unknown>) };
}

/** spec → 侧栏 JSON 文本（spec 本身不含 id；undefined 值的键自然省略）。 */
export function specToJson(spec: SpecDraft): string {
  return JSON.stringify(spec, null, 2);
}

/** 逗号分隔的 inputs 字段 → string[]（去空白、丢空段）。 */
export function parseInputsList(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 新建工作流的最小可运行示例（与旧 JSON 模板一致）。 */
export function newSpecTemplate(): SpecDraft {
  return {
    name: '',
    description: '',
    inputs: ['task'],
    steps: [{ type: 'agent', id: 'draft', agent: 'writer', prompt: '{task}' }],
  };
}
