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
