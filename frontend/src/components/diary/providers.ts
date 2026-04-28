// Provider registry — every entry is a vendor that exposes a native
// Anthropic-protocol endpoint. With these, Claude CLI talks directly
// to the provider via `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`,
// no claude-code-router / LiteLLM in front.
//
// Confirmed Apr 2026:
//   - Anthropic native:        api.anthropic.com (no BASE_URL)
//   - DeepSeek:                api.deepseek.com/anthropic
//   - MiniMax (intl/cn):       api.minimax.io / api.minimaxi.com  /anthropic
//   - Zhipu Z.ai (intl/cn):    api.z.ai/api/anthropic | open.bigmodel.cn/api/anthropic
//   - Moonshot Kimi:           api.moonshot.ai/anthropic
//   - Alibaba Qwen:            dashscope-intl.aliyuncs.com/apps/anthropic
//   - Ollama (local):          localhost:11434/anthropic
//
// "Custom" is a fall-through for advanced users who want to point at
// a router or any other compatible endpoint.

export interface ProviderModel {
  id: string;        // exact string sent as `--model`
  label: string;     // human display name
  hint?: string;     // tooltip / one-liner
}

export interface Provider {
  id: string;
  label: string;
  /** One-line description shown under the provider name in the picker. */
  shortNote: string;
  /**
   * Value for `ANTHROPIC_BASE_URL`. `null` means leave it unset
   * (Anthropic native uses the default). `'custom'` means the user
   * fills it in manually.
   */
  baseUrl: string | null | 'custom';
  /**
   * Most third-party endpoints prefer `ANTHROPIC_AUTH_TOKEN` over
   * `ANTHROPIC_API_KEY`. Anthropic native accepts either. We use
   * whichever the provider documents.
   */
  authTokenEnvKey: 'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN';
  /** Where the user gets the key. Surfaced as a help link in the form. */
  apiKeyDashboard: string;
  models: ProviderModel[];
  /** Curated default for "Try a model" — typically the cheapest/fastest. */
  defaultModelId: string;
  /** Sensible default agent name when this provider is picked. */
  defaultAgentName: string;
}

export const PROVIDERS: Provider[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    shortNote: 'Native — Claude direct from anthropic.com',
    baseUrl: null,
    authTokenEnvKey: 'ANTHROPIC_API_KEY',
    apiKeyDashboard: 'https://console.anthropic.com/settings/keys',
    defaultModelId: 'claude-haiku-4-5',
    defaultAgentName: 'Claude Observer',
    models: [
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', hint: 'fastest, cheapest' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', hint: 'balanced' },
      { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', hint: 'best quality' },
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    shortNote: 'Anthropic-compatible · ~10× cheaper than Claude',
    baseUrl: 'https://api.deepseek.com/anthropic',
    authTokenEnvKey: 'ANTHROPIC_AUTH_TOKEN',
    apiKeyDashboard: 'https://platform.deepseek.com/api_keys',
    defaultModelId: 'deepseek-v4-flash',
    defaultAgentName: 'DeepSeek Observer',
    models: [
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', hint: 'flagship' },
      { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', hint: 'fast + cheap' },
      { id: 'deepseek-v3.2', label: 'DeepSeek V3.2' },
    ],
  },
  {
    id: 'minimax-intl',
    label: 'MiniMax (国际)',
    shortNote: 'Anthropic-compatible · api.minimax.io',
    baseUrl: 'https://api.minimax.io/anthropic',
    authTokenEnvKey: 'ANTHROPIC_AUTH_TOKEN',
    apiKeyDashboard: 'https://platform.minimax.io/',
    defaultModelId: 'MiniMax-M2.7-Highspeed',
    defaultAgentName: 'MiniMax Observer',
    models: [
      { id: 'MiniMax-M2.7', label: 'MiniMax M2.7', hint: 'flagship' },
      { id: 'MiniMax-M2.7-Highspeed', label: 'MiniMax M2.7 Highspeed', hint: 'fast' },
    ],
  },
  {
    id: 'minimax-cn',
    label: 'MiniMax (国内)',
    shortNote: 'Anthropic-compatible · api.minimaxi.com',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    authTokenEnvKey: 'ANTHROPIC_AUTH_TOKEN',
    apiKeyDashboard: 'https://platform.minimaxi.com/',
    defaultModelId: 'MiniMax-M2.7-Highspeed',
    defaultAgentName: 'MiniMax Observer',
    models: [
      { id: 'MiniMax-M2.7', label: 'MiniMax M2.7' },
      { id: 'MiniMax-M2.7-Highspeed', label: 'MiniMax M2.7 Highspeed' },
    ],
  },
  {
    id: 'zhipu-intl',
    label: 'Zhipu Z.ai (国际)',
    shortNote: 'Anthropic-compatible · api.z.ai',
    baseUrl: 'https://api.z.ai/api/anthropic',
    authTokenEnvKey: 'ANTHROPIC_AUTH_TOKEN',
    apiKeyDashboard: 'https://z.ai/',
    defaultModelId: 'glm-5',
    defaultAgentName: 'GLM Observer',
    models: [
      { id: 'glm-5.1', label: 'GLM 5.1', hint: 'flagship' },
      { id: 'glm-5', label: 'GLM 5' },
      { id: 'glm-4.7', label: 'GLM 4.7' },
    ],
  },
  {
    id: 'zhipu-cn',
    label: 'Zhipu (国内)',
    shortNote: 'Anthropic-compatible · open.bigmodel.cn',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    authTokenEnvKey: 'ANTHROPIC_AUTH_TOKEN',
    apiKeyDashboard: 'https://open.bigmodel.cn/',
    defaultModelId: 'glm-5',
    defaultAgentName: 'GLM Observer',
    models: [
      { id: 'glm-5.1', label: 'GLM 5.1' },
      { id: 'glm-5', label: 'GLM 5' },
      { id: 'glm-4.7', label: 'GLM 4.7' },
    ],
  },
  {
    id: 'moonshot',
    label: 'Moonshot Kimi',
    shortNote: 'Anthropic-compatible · api.moonshot.ai',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    authTokenEnvKey: 'ANTHROPIC_AUTH_TOKEN',
    apiKeyDashboard: 'https://platform.moonshot.ai/',
    defaultModelId: 'kimi-k2.6',
    defaultAgentName: 'Kimi Observer',
    models: [
      { id: 'kimi-k2.6', label: 'Kimi K2.6', hint: 'beta — newest' },
      { id: 'kimi-k2.5', label: 'Kimi K2.5' },
    ],
  },
  {
    id: 'qwen',
    label: 'Alibaba Qwen',
    shortNote: 'Anthropic-compatible · DashScope international',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/apps/anthropic',
    authTokenEnvKey: 'ANTHROPIC_AUTH_TOKEN',
    apiKeyDashboard: 'https://dashscope.console.aliyun.com/',
    defaultModelId: 'qwen3.6-plus',
    defaultAgentName: 'Qwen Observer',
    models: [
      { id: 'qwen3.6-plus', label: 'Qwen 3.6 Plus', hint: 'flagship' },
      { id: 'qwen3.5-coder', label: 'Qwen 3.5 Coder', hint: 'code-focused' },
    ],
  },
  {
    id: 'ollama',
    label: 'Ollama (本地)',
    shortNote: 'Local models · runs on your machine',
    baseUrl: 'http://localhost:11434/anthropic',
    authTokenEnvKey: 'ANTHROPIC_AUTH_TOKEN', // ollama ignores it but sets must be present
    apiKeyDashboard: 'https://ollama.com/',
    defaultModelId: 'qwen3.5',
    defaultAgentName: 'Local Observer',
    models: [
      { id: 'qwen3.5', label: 'Qwen 3.5 (local)' },
      { id: 'glm-5:cloud', label: 'GLM 5' },
      { id: 'kimi-k2.5:cloud', label: 'Kimi K2.5' },
      { id: 'llama3.3', label: 'Llama 3.3' },
    ],
  },
  {
    id: 'custom',
    label: 'Custom',
    shortNote: 'Point at any Anthropic-compatible endpoint (router, etc.)',
    baseUrl: 'custom',
    authTokenEnvKey: 'ANTHROPIC_AUTH_TOKEN',
    apiKeyDashboard: '',
    defaultModelId: '',
    defaultAgentName: 'Custom Agent',
    models: [],
  },
];

export function findProvider(id: string): Provider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/**
 * Best-effort reverse lookup: given an agent's existing env block,
 * which provider does it look like? Used so the editor can pick the
 * right card when re-opening a saved agent.
 */
export function detectProvider(env: Record<string, string>): Provider {
  const baseUrl = env.ANTHROPIC_BASE_URL?.trim();
  if (!baseUrl) return PROVIDERS.find((p) => p.id === 'anthropic')!;
  for (const p of PROVIDERS) {
    if (typeof p.baseUrl === 'string' && p.baseUrl !== 'custom' && p.baseUrl === baseUrl) {
      return p;
    }
  }
  return PROVIDERS.find((p) => p.id === 'custom')!;
}

/**
 * Per-provider canonical secret name. Keeps secret reuse consistent
 * across multiple agents pointed at the same provider.
 */
export function suggestSecretName(provider: Provider): string {
  const map: Record<string, string> = {
    anthropic: 'ANTHROPIC_KEY',
    deepseek: 'DEEPSEEK_KEY',
    'minimax-intl': 'MINIMAX_KEY',
    'minimax-cn': 'MINIMAX_KEY',
    'zhipu-intl': 'ZHIPU_KEY',
    'zhipu-cn': 'ZHIPU_KEY',
    moonshot: 'MOONSHOT_KEY',
    qwen: 'QWEN_KEY',
    ollama: 'OLLAMA_KEY',
    custom: 'CUSTOM_KEY',
  };
  return map[provider.id] ?? provider.id.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_KEY';
}
