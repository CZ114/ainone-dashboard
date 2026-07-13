// 编排（Orchestration）tab 内的跨面板跳转事件总线 — window CustomEvent，
// 零新依赖。WorkflowsPanel 与 AgentsPanel 同页渲染（OrchestrationPanel），
// 所以监听方始终已挂载：
//
//   WorkflowCanvas（agent 步骤抽屉）──orch:edit-agent──▶ AgentsPanel
//     · agentId 已存在 → 打开该 agent 的编辑器并滚动到位
//     · agentId 不存在 → 打开预填 id 的新建编辑器
//   AgentsPanel（「用于」反向引用 chips）──orch:edit-workflow──▶ WorkflowsPanel
//     · 打开该工作流的画布编辑器并滚动到位

export const ORCH_EDIT_AGENT = 'orch:edit-agent';
export const ORCH_EDIT_WORKFLOW = 'orch:edit-workflow';

export interface EditAgentDetail {
  agentId: string;
}

export interface EditWorkflowDetail {
  workflowId: string;
}

export function dispatchEditAgent(agentId: string): void {
  window.dispatchEvent(
    new CustomEvent<EditAgentDetail>(ORCH_EDIT_AGENT, { detail: { agentId } }),
  );
}

export function dispatchEditWorkflow(workflowId: string): void {
  window.dispatchEvent(
    new CustomEvent<EditWorkflowDetail>(ORCH_EDIT_WORKFLOW, {
      detail: { workflowId },
    }),
  );
}

/** 订阅 orch:edit-agent；返回取消函数（配 useEffect cleanup）。 */
export function onEditAgent(handler: (agentId: string) => void): () => void {
  const h = (e: Event) => {
    const id = (e as CustomEvent<EditAgentDetail>).detail?.agentId;
    if (typeof id === 'string') handler(id);
  };
  window.addEventListener(ORCH_EDIT_AGENT, h);
  return () => window.removeEventListener(ORCH_EDIT_AGENT, h);
}

/** 订阅 orch:edit-workflow；返回取消函数（配 useEffect cleanup）。 */
export function onEditWorkflow(handler: (workflowId: string) => void): () => void {
  const h = (e: Event) => {
    const id = (e as CustomEvent<EditWorkflowDetail>).detail?.workflowId;
    if (typeof id === 'string') handler(id);
  };
  window.addEventListener(ORCH_EDIT_WORKFLOW, h);
  return () => window.removeEventListener(ORCH_EDIT_WORKFLOW, h);
}
