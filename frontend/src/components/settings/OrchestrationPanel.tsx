// 设置页「编排」tab — Workflows + Agents 合并成一页，让概念链条可见可导航：
//
//   🔁 工作流（编排剧本）──引用→ 🤖 Agent（角色）──挂载→ 📚 知识库
//
// 顶部是常驻图例条（📚 段可点击跳到知识库 tab）；下面依次是 WorkflowsPanel
// 与 AgentsPanel（各自保留原有标题与全部功能），两者之间用一条分隔线。
// 面板间的「编辑此 agent / 用于哪些工作流」跳转走 orchestrationBus 的
// window CustomEvent（见 lib/orchestrationBus.ts）——两个面板同页挂载，
// 监听方始终在场。

import { useT } from '../../contexts/LanguageContext';
import { AgentsPanel } from './AgentsPanel';
import { WorkflowsPanel } from './WorkflowsPanel';

export function OrchestrationPanel({
  onGoToKnowledge,
}: {
  /** 图例末端 📚 段的跳转 — SettingsPage 传 setActiveTab('knowledge')。 */
  onGoToKnowledge?: () => void;
}) {
  const t = useT();
  const to = t.settings.orchestration;
  return (
    <div className="space-y-6">
      {/* 概念链图例 — 常驻单行条（可换行），不是卡片墙 */}
      <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-lg border border-card-border bg-card-bg/40 px-3 py-2 text-xs text-text-muted">
        <span className="whitespace-nowrap">🔁 {to.legendWorkflow}</span>
        <span aria-hidden className="whitespace-nowrap text-text-muted/80">
          ──{to.legendRefs}→
        </span>
        <span className="whitespace-nowrap">🤖 {to.legendAgent}</span>
        <span aria-hidden className="whitespace-nowrap text-text-muted/80">
          ──{to.legendMounts}→
        </span>
        <button
          type="button"
          onClick={onGoToKnowledge}
          title={to.legendKnowledgeTitle}
          className="whitespace-nowrap underline decoration-dotted underline-offset-2 hover:text-text-primary"
        >
          📚 {to.legendKnowledge}
        </button>
      </div>

      <WorkflowsPanel />

      <hr className="border-card-border" />

      <AgentsPanel />
    </div>
  );
}

export default OrchestrationPanel;
