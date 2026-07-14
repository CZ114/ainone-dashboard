// rolePolicy — 功能 × 角色 的唯一事实源 (M1 前端投影)。
//
// 三视角分级方案 (docs/proposals/role-tiered-ui-demo.html) 的代码形态:
// 每个可见性决策都查这张表, 组件里不散落 if (role === ...) 判断。
// M2 落地后, 后端 authz 策略表以这张表为镜像源 (fail-closed)。
//
// 诚实边界: 这张表只是前端渲染开关 — 防误触, 不防越权。改 localStorage
// 或直接 curl 仍可绕过, 真正的门是 M0 (后端绑 127.0.0.1) + M2 (authz)。

export type Role = 'patient' | 'doctor' | 'developer';

export type FeatureKey =
  // 顶级路由
  | 'route.today'            // 患者首页 (数据 insight + 日记 + 语音入口)
  | 'route.dashboard'        // 传感器监测 (波形墙/录制/回放)
  | 'route.chat'
  | 'route.call'
  | 'route.diary'
  | 'route.patients'         // 病人档案 (新, 医生工作台)
  | 'route.settings'
  // Header
  | 'nav.statusLights'       // Serial/BLE/Audio 状态灯 + 通道数 + 录制指示
  // Chat 页内部机关
  | 'chat.terminal'          // 内嵌 PTY 终端
  | 'chat.pills'             // 权限 Mode / Thinking / Effort 循环药丸
  | 'chat.slash'             // 斜杠命令菜单
  | 'chat.agentPreset'       // Agent 预设选择药丸
  | 'chat.workflowPanel'     // 右栏工作流运行面板
  | 'chat.recordings'        // 录音数据抽屉 (拖拽附件)
  | 'chat.sidebarProjects'   // 项目管理 (新建/删除项目、跨项目会话)
  | 'chat.openInTerminal'    // "在系统终端打开" (spawn CLI)
  | 'chat.rawActivity'       // tool/thinking 原样渲染; 关 = 聚合为"正在为你处理…"状态行
  // Settings 各 tab
  | 'settings.tab.extensions'
  | 'settings.tab.model'
  | 'settings.tab.orchestration'
  | 'settings.tab.knowledge'
  | 'settings.tab.diary'
  | 'settings.tab.appearance'
  | 'settings.tab.about'
  // 日记页 / 日记设置内部
  | 'diary.admin'            // diary-agent CRUD + 密钥 CRUD (设置页折叠区)
  | 'diary.delete'           // 删除日记条目 (病程记录: 患者可回复不可销毁)
  // 病人档案
  | 'patients.manage';       // 新建病人 / 重置配对码 / 改档案

const ALL: Role[] = ['patient', 'doctor', 'developer'];
const STAFF: Role[] = ['doctor', 'developer'];
const DEV: Role[] = ['developer'];

/** 功能 → 允许的角色。缺表条目按 fail-closed 处理 (只有 developer 可见)。 */
export const FEATURES: Record<FeatureKey, Role[]> = {
  'route.today':              ['patient'],
  'route.dashboard':          STAFF,
  'route.chat':               ALL,
  'route.call':               ALL,
  'route.diary':              ALL,
  'route.patients':           STAFF,
  'route.settings':           ALL,

  'nav.statusLights':         STAFF,

  'chat.terminal':            DEV,
  'chat.pills':               DEV,
  'chat.slash':               DEV,
  'chat.agentPreset':         DEV,
  'chat.workflowPanel':       STAFF,
  'chat.recordings':          STAFF,
  'chat.sidebarProjects':     STAFF,
  'chat.openInTerminal':      DEV,
  'chat.rawActivity':         STAFF,

  'settings.tab.extensions':  DEV,
  'settings.tab.model':       DEV,
  'settings.tab.orchestration': DEV,
  'settings.tab.knowledge':   STAFF,
  'settings.tab.diary':       ALL,     // 患者只见提醒子集 (diary.admin 再裁)
  'settings.tab.appearance':  ALL,
  'settings.tab.about':       DEV,

  'diary.admin':              DEV,
  'diary.delete':             DEV,

  'patients.manage':          STAFF,
};

export function can(role: Role | null, feature: FeatureKey): boolean {
  if (role === null) return false;
  const allowed = FEATURES[feature];
  // fail-closed: 新功能忘登记时宁可只给开发者, 也不泄漏给患者
  if (!allowed) return role === 'developer';
  return allowed.includes(role);
}

/** 各角色的落地页 — `/` 重定向 & 越权访问的退路。 */
export function homeOf(role: Role): string {
  return role === 'patient' ? '/today' : '/dashboard';
}
