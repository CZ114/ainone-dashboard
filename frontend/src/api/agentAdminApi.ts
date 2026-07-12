// Agent 管理后台 HTTP client。Mirrors diaryApi.ts conventions: relative
// paths, JSON in/out, throw on non-2xx so panels surface a single error.
//
// /api/agent/* → agent_service (:8100, vite 代理已配置)。
// /api/diary/secrets → Node gateway (:3000)，secret 值只写不读。

// ---------- Wire types -------------------------------------------------------

export interface ProviderInfo {
  name: string;
  keyEnvs: string[];
  keyPresent: boolean;
  defaultModel: string | null;
  baseUrl: string | null;
}

export interface RuntimeConfig {
  provider: string;
  model: string;
  temperature: number;
  embedder: string;
}

export interface AgentConfigResponse {
  config: RuntimeConfig;
  providers: ProviderInfo[];
}

export interface AgentRetrieval {
  collection: string;
  top_k: number;
}

export interface AgentDef {
  id: string;
  builtin: boolean;
  name?: string;
  description?: string;
  provider?: string;
  model?: string;
  system_prompt?: string;
  sampling?: { temperature?: number };
  retrieval?: AgentRetrieval | null;
  env?: Record<string, string>;
}

/** PUT body — replace semantics: omitted fields are cleared server-side. */
export type AgentUpsertBody = Omit<AgentDef, 'id' | 'builtin'>;

export interface AgentTestResult {
  ok: boolean;
  latency_ms: number;
  model?: string;
  provider?: string;
  sample?: string;
  error?: string;
}

export interface RagCollection {
  name: string;
  count: number;
  embedder: string;
}

export interface IngestDocument {
  source: string;
  text: string;
}

export interface IngestResponse {
  collection: string;
  embedder: string;
  added_chunks: number;
  per_source: Record<string, number>;
  total_count: number;
}

export interface RagHit {
  id: string;
  text: string;
  score: number;
  meta: { source: string; chunk: number };
}

export interface SecretEntry {
  name: string;
}

// ---- workflows (声明式多 agent 工作流, SOD 06/07) ----

/** GET /workflows 列表项 — 不含 steps（编辑时再 GET 单个）。 */
export interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
  inputs: string[];
  /** spec 里引用到的 agent id 集合。 */
  agents: string[];
}

/** 单个 step 的形态由服务端校验（六种组件可嵌套）——前端按不透明 JSON 处理。 */
export type WorkflowStep = Record<string, unknown>;

/**
 * PUT body = 完整 spec 字段（id 走 URL）。编辑器是自由 JSON，
 * 额外字段原样透传，服务端负责校验（400 detail 原样展示给用户）。
 */
export interface WorkflowUpsertBody {
  name?: string;
  description?: string;
  inputs?: string[];
  output?: string;
  steps?: WorkflowStep[];
  [extra: string]: unknown;
}

export type WorkflowSpec = WorkflowUpsertBody & { id: string };

/** NDJSON 事件流 — 每行一个 JSON，type 判别。 */
export type WorkflowEvent =
  | {
      type: 'workflow_start';
      workflow: string;
      inputs: Record<string, unknown>;
      /** 关联持久化历史（GET /workflow-runs/{run_id}）。 */
      run_id?: string;
    }
  | { type: 'step_start'; step: string; agent: string; iteration?: number }
  | {
      type: 'step_end';
      step: string;
      agent?: string;
      output: string;
      elapsed_ms: number;
      iteration?: number;
    }
  | { type: 'loop_iter'; loop: string; iteration: number }
  | { type: 'loop_break'; loop: string; reason: string }
  | {
      type: 'route_choice';
      step: string;
      choice: string;
      /** 服务端字段名可能不同版本有出入 — 渲染方取存在的那个。 */
      decision?: string;
      branch?: string;
    }
  | { type: 'human_ask'; step: string; prompt: string; iteration?: number }
  /** 流在此暂停 — 前端渲染输入框，POST /workflows/input 后继续（服务端 600s 超时）。 */
  | { type: 'human_input_required'; input_id: string; prompt: string; step?: string }
  | { type: 'workflow_end'; output: string; context: Record<string, unknown> }
  | { type: 'error'; error: string };

// ---- workflow runs (持久化运行历史) ----

export type WorkflowRunStatus = 'done' | 'error' | 'aborted';

/** GET /workflow-runs 列表项 — 概要，events 走 GET 单个。 */
export interface WorkflowRunSummary {
  run_id: string;
  workflow_id: string;
  name: string;
  status: WorkflowRunStatus;
  started_at: string | number;
  elapsed_ms: number;
  steps: number;
  output_preview: string;
}

/**
 * 回放事件 — 与流式 WorkflowEvent 同形 + t_ms 相对时间戳。字段按
 * 不透明处理（type 判别，渲染方取存在的键）。
 */
export interface WorkflowRunEvent {
  type: string;
  t_ms?: number;
  [extra: string]: unknown;
}

export interface WorkflowRunDetail {
  run_id: string;
  workflow_id: string;
  name: string;
  status: WorkflowRunStatus;
  inputs: Record<string, string>;
  started_at: string | number;
  elapsed_ms: number;
  output: string;
  events: WorkflowRunEvent[];
}

// ---- MCP servers (外部工具源, SOD 07 §3) ----

export type McpTransport = 'stdio' | 'url';

/** 最近一次注册/测试的结果缓存 — status 为 null 表示尚未连接过。 */
export interface McpServerStatus {
  ok: boolean;
  tools: string[];
  error: string | null;
  checked_at: string | number;
}

export interface McpServer {
  name: string;
  transport: McpTransport;
  command?: string;
  url?: string;
  enabled: boolean;
  status: McpServerStatus | null;
}

/** PUT body — stdio 带 command，url 带 url；改动对新聊天会话生效。 */
export interface McpUpsertBody {
  transport: McpTransport;
  command?: string;
  url?: string;
  enabled: boolean;
}

export type McpTestResult =
  | { ok: true; latency_ms: number; tools: string[] }
  | { ok: false; latency_ms: number; error: string };

// ---- Skills (技能库, SOD 07 §4) ----

export interface SkillSummary {
  name: string;
  description: string;
}

export interface SkillDetail extends SkillSummary {
  /** SKILL.md 正文（frontmatter 之后的 markdown 主指令）。 */
  body: string;
  /** 技能目录下的附加文件（references/、scripts/…）— UI 只读展示。 */
  files: string[];
}

export interface SkillUpsertBody {
  description: string;
  body: string;
}

// ---------- Client -----------------------------------------------------------

const API_BASE = '';

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      // agent_service (FastAPI) errors use {detail}; the Node gateway
      // uses {error}. detail can be a pydantic validation array.
      const body = (await res.json()) as { detail?: unknown; error?: unknown };
      if (typeof body?.detail === 'string') detail = body.detail;
      else if (body?.detail != null) detail = JSON.stringify(body.detail);
      else if (typeof body?.error === 'string') detail = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export const agentAdminApi = {
  // ---- runtime config (model routing) ----
  async getConfig(): Promise<AgentConfigResponse> {
    return asJson(await fetch(`${API_BASE}/api/agent/config`));
  },
  async patchConfig(patch: Partial<RuntimeConfig>): Promise<AgentConfigResponse> {
    return asJson(
      await fetch(`${API_BASE}/api/agent/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }),
    );
  },
  /** Can fail 400/502 — caller falls back to manual model input. */
  async listModels(provider: string): Promise<{ provider: string; models: string[] }> {
    return asJson(
      await fetch(
        `${API_BASE}/api/agent/models?provider=${encodeURIComponent(provider)}`,
      ),
    );
  },

  // ---- agents ----
  async listAgents(): Promise<{ agents: AgentDef[] }> {
    return asJson(await fetch(`${API_BASE}/api/agent/agents`));
  },
  async putAgent(id: string, body: AgentUpsertBody): Promise<{ agent: AgentDef }> {
    return asJson(
      await fetch(`${API_BASE}/api/agent/agents/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  },
  async deleteAgent(id: string): Promise<{ ok: boolean }> {
    return asJson(
      await fetch(`${API_BASE}/api/agent/agents/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    );
  },
  /** Real LLM roundtrip — can take 10–30 s. */
  async testAgent(id: string, message?: string): Promise<AgentTestResult> {
    return asJson(
      await fetch(`${API_BASE}/api/agent/agents/${encodeURIComponent(id)}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message ? { message } : {}),
        signal: AbortSignal.timeout(60000),
      }),
    );
  },

  // ---- workflows ----
  async listWorkflows(): Promise<{ workflows: WorkflowSummary[] }> {
    return asJson(await fetch(`${API_BASE}/api/agent/workflows`));
  },
  async getWorkflow(id: string): Promise<{ workflow: WorkflowSpec }> {
    return asJson(
      await fetch(`${API_BASE}/api/agent/workflows/${encodeURIComponent(id)}`),
    );
  },
  async putWorkflow(
    id: string,
    body: WorkflowUpsertBody,
  ): Promise<{ workflow: WorkflowSpec }> {
    return asJson(
      await fetch(`${API_BASE}/api/agent/workflows/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  },
  async deleteWorkflow(id: string): Promise<{ ok: boolean }> {
    return asJson(
      await fetch(`${API_BASE}/api/agent/workflows/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    );
  },
  /**
   * POST /stream 并增量解析 NDJSON（按行切分，同 claudeApi.sendMessage
   * 的读法）。human 步骤会让流暂停 — 收到 human_input_required 后由
   * submitWorkflowInput 唤醒。中断用 AbortController（注意：服务端会
   * 继续跑完当前步骤，abort 只断开浏览器侧）。
   */
  async streamWorkflow(
    id: string,
    inputs: Record<string, string>,
    onEvent: (e: WorkflowEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await fetch(
      `${API_BASE}/api/agent/workflows/${encodeURIComponent(id)}/stream`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs }),
        signal,
      },
    );
    if (!res.ok) {
      await asJson(res); // 复用统一错误路径：抛出带 detail 的 Error
      return;
    }
    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            onEvent(JSON.parse(line) as WorkflowEvent);
          } catch {
            /* 跳过残缺行 */
          }
        }
      }
      if (buffer.trim()) {
        try {
          onEvent(JSON.parse(buffer) as WorkflowEvent);
        } catch {
          /* 跳过残缺行 */
        }
      }
    } finally {
      reader.releaseLock();
    }
  },
  /** 回答 human_input_required：id 是事件里的 input_id（不是 workflow id）。 */
  async submitWorkflowInput(id: string, value: string): Promise<{ ok: boolean }> {
    return asJson(
      await fetch(`${API_BASE}/api/agent/workflows/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, value }),
      }),
    );
  },

  // ---- workflow runs (持久化运行历史) ----
  async listWorkflowRuns(limit = 20): Promise<{ runs: WorkflowRunSummary[] }> {
    return asJson(
      await fetch(
        `${API_BASE}/api/agent/workflow-runs?limit=${encodeURIComponent(limit)}`,
      ),
    );
  },
  async getWorkflowRun(runId: string): Promise<{ run: WorkflowRunDetail }> {
    return asJson(
      await fetch(
        `${API_BASE}/api/agent/workflow-runs/${encodeURIComponent(runId)}`,
      ),
    );
  },
  async deleteWorkflowRun(runId: string): Promise<{ ok: boolean }> {
    return asJson(
      await fetch(
        `${API_BASE}/api/agent/workflow-runs/${encodeURIComponent(runId)}`,
        { method: 'DELETE' },
      ),
    );
  },

  // ---- MCP servers ----
  async listMcpServers(): Promise<{ servers: McpServer[] }> {
    return asJson(await fetch(`${API_BASE}/api/agent/mcp`));
  },
  async putMcpServer(
    name: string,
    body: McpUpsertBody,
  ): Promise<{ server: McpServer }> {
    return asJson(
      await fetch(`${API_BASE}/api/agent/mcp/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  },
  async deleteMcpServer(name: string): Promise<{ ok: boolean }> {
    return asJson(
      await fetch(`${API_BASE}/api/agent/mcp/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      }),
    );
  },
  /** 现场 spawn/连接一次并列工具 — 可达 30 s，超时放宽到 60 s。 */
  async testMcpServer(name: string): Promise<McpTestResult> {
    return asJson(
      await fetch(`${API_BASE}/api/agent/mcp/${encodeURIComponent(name)}/test`, {
        method: 'POST',
        signal: AbortSignal.timeout(60000),
      }),
    );
  },

  // ---- skills ----
  async listSkills(): Promise<{ skills: SkillSummary[] }> {
    return asJson(await fetch(`${API_BASE}/api/agent/skills`));
  },
  async getSkill(name: string): Promise<{ skill: SkillDetail }> {
    return asJson(
      await fetch(`${API_BASE}/api/agent/skills/${encodeURIComponent(name)}`),
    );
  },
  async putSkill(
    name: string,
    body: SkillUpsertBody,
  ): Promise<{ skill: SkillDetail }> {
    return asJson(
      await fetch(`${API_BASE}/api/agent/skills/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  },
  async deleteSkill(name: string): Promise<{ ok: boolean }> {
    return asJson(
      await fetch(`${API_BASE}/api/agent/skills/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      }),
    );
  },

  // ---- RAG ----
  async listCollections(): Promise<{ collections: RagCollection[] }> {
    return asJson(await fetch(`${API_BASE}/api/agent/rag/collections`));
  },
  async createCollection(name: string): Promise<{ collection: RagCollection }> {
    return asJson(
      await fetch(`${API_BASE}/api/agent/rag/collections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }),
    );
  },
  async deleteCollection(name: string): Promise<{ ok: boolean }> {
    return asJson(
      await fetch(
        `${API_BASE}/api/agent/rag/collections/${encodeURIComponent(name)}`,
        { method: 'DELETE' },
      ),
    );
  },
  /**
   * 首次调用会在服务端加载 bge-m3 嵌入模型（60–120s），所以超时放宽到
   * 5 分钟。Re-ingesting the same source REPLACES its old chunks.
   */
  async ingest(
    collection: string,
    documents: IngestDocument[],
  ): Promise<IngestResponse> {
    return asJson(
      await fetch(`${API_BASE}/api/agent/rag/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection, documents }),
        signal: AbortSignal.timeout(300000),
      }),
    );
  },
  async search(
    collection: string,
    query: string,
    topK: number,
  ): Promise<{ hits: RagHit[] }> {
    return asJson(
      await fetch(`${API_BASE}/api/agent/rag/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection, query, top_k: topK }),
      }),
    );
  },

  // ---- secrets (Node gateway; values never returned) ----
  async listSecrets(): Promise<{ secrets: SecretEntry[] }> {
    return asJson(await fetch(`${API_BASE}/api/diary/secrets`));
  },
  async putSecret(name: string, value: string): Promise<{ ok: boolean }> {
    return asJson(
      await fetch(`${API_BASE}/api/diary/secrets/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      }),
    );
  },
  async deleteSecret(name: string): Promise<{ ok: boolean }> {
    return asJson(
      await fetch(`${API_BASE}/api/diary/secrets/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      }),
    );
  },
};
