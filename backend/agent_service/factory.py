"""AgentFactory — 从配置构造 Agent 实例。

multi-agent 落点 (SOD 04 已兑现): agent_id 映射到 backend/data/diary/agents.json 里的
定义 (与日记系统共享), secrets 用 ${NAME} 占位符, 解析链: agents.json secrets 块 > 环境变量。
"default" 跟随运行时配置 (config_store, 设置页可改); 自定义 agent 缺省字段回落到运行时默认。

RAG (SOD 04 已兑现): cfg.retrieval = {collection, top_k} 时挂载 ChromaStore + embedder,
agent 库自动注册 retrieve 工具。
"""

import json
import os
import re

from agent import Agent, AgentDeploy, AuditLog, create_registry

from . import config_store
from .agent_tools import build_registry, recordings_context_provider
from .config import AGENTS_JSON, DEFAULT_SYSTEM_PROMPT, SESSIONS_DIR

_SECRET_REF = re.compile(r"\$\{(\w+)\}")


def _load_agents_json():
    try:
        return json.loads(AGENTS_JSON.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {"secrets": {}, "agents": {}}


def _resolve_secret(value, secrets):
    """把 "${NAME}" 占位符替换成实际值; 解析链: secrets 块 > 环境变量。"""
    def sub(m):
        name = m.group(1)
        resolved = secrets.get(name) or os.getenv(name)
        if resolved is None:
            raise ValueError(f"secret 未配置: ${{{name}}} (agents.json secrets 块或环境变量)")
        return resolved
    return _SECRET_REF.sub(sub, value)


def resolve_agent_config(agent_id=None):
    """返回归一化配置 dict:
    provider/model/api_key/system_prompt/temperature/retrieval/embedder。

    agent_id 为 None/"default" 时用运行时默认 (config_store);
    否则查 agents.json (与日记系统同一 schema), 缺省字段回落到运行时默认。
    """
    runtime = config_store.load()

    if not agent_id or agent_id == "default":
        return {
            "provider": runtime["provider"],
            "model": runtime["model"],
            "api_key": None,  # AgentDeploy 走环境变量 (含 config.py 的命名映射)
            "system_prompt": DEFAULT_SYSTEM_PROMPT,
            "temperature": runtime["temperature"],
            "retrieval": None,
            "embedder": runtime["embedder"],
        }

    doc = _load_agents_json()
    cfg = (doc.get("agents") or {}).get(agent_id)
    if cfg is None:
        # diary_observer 是日记系统的内置 id — agents.json 没定义时网关会动态合成,
        # 这里对应地回落到服务默认配置 (对齐原版 agentStore.ts 的行为)
        if agent_id == "diary_observer":
            return resolve_agent_config("default")
        known = ["default", "diary_observer", *(doc.get("agents") or {}).keys()]
        raise KeyError(f"未知 agent_id: {agent_id}; 可用: {known}")

    secrets = doc.get("secrets") or {}
    # env 块解析后注入环境 (agent 库按环境变量找 key); 已存在的变量不覆盖
    for k, v in (cfg.get("env") or {}).items():
        if isinstance(v, str) and not os.getenv(k):
            os.environ[k] = _resolve_secret(v, secrets)

    sampling = cfg.get("sampling") or {}
    retrieval = cfg.get("retrieval") or None
    if retrieval and not retrieval.get("collection"):
        retrieval = None
    return {
        "provider": cfg.get("provider") or runtime["provider"],
        "model": cfg.get("model") or runtime["model"],
        "api_key": None,
        "system_prompt": cfg.get("system_prompt") or DEFAULT_SYSTEM_PROMPT,
        "temperature": sampling.get("temperature", runtime["temperature"]),
        "retrieval": retrieval,
        "embedder": runtime["embedder"],
    }


def _retrieval_kwargs(cfg):
    """cfg.retrieval → Agent(retrieval=, embedder=) 参数对; 未挂载则空 dict。"""
    if not cfg.get("retrieval"):
        return {}
    from . import rag  # 延迟 import — 不用 RAG 时不碰 chromadb
    collection = cfg["retrieval"]["collection"]
    emb_name = rag.collection_embedder_name(collection, cfg["embedder"])
    return {
        "retrieval": rag.get_store(collection),
        "embedder": rag.get_embedder(emb_name),
    }


def build_client(cfg):
    return AgentDeploy(
        provider=cfg["provider"],
        model=cfg["model"],
        api_key=cfg["api_key"],
        temperature=cfg["temperature"],
    )


def build_chat_agent(session_id, agent_id=None):
    """交互会话 agent: 全套工具 + 录音上下文注入 + AuditLog (both 模式, 供 resume+审计)。
    cfg.retrieval 存在时自动挂知识库; MCP 工具源与 Skills 技能库全局挂载
    (仅 chat agent — oneshot/工作流节点保持轻量, SOD 07)。"""
    cfg = resolve_agent_config(agent_id)
    audit = AuditLog(
        SESSIONS_DIR / f"{session_id}.jsonl",
        session_id=session_id,
        mode="both",
    )
    reg = build_registry()

    # MCP 工具源 — 逐 server 隔离失败 (状态进 mcp_admin 缓存, 不拖垮聊天)
    from . import mcp_admin
    mcp_admin.apply_to_registry(reg)

    # Skills 技能库 — 有技能才挂 (聊天 /名字 展开 + LLM 自主发现两条路)
    skill_store = None
    from . import skills_admin
    if skills_admin.has_skills():
        from agent import FileSkillStore
        from agent.tools.skills import register_skills
        skill_store = FileSkillStore(str(skills_admin.SKILLS_DIR))
        register_skills(reg, str(skills_admin.SKILLS_DIR))

    return Agent(
        build_client(cfg),
        cfg["system_prompt"],
        registry=reg,
        context_providers=[recordings_context_provider],
        audit_log=audit,
        skill_store=skill_store,
        max_rounds=8,
        **_retrieval_kwargs(cfg),
    )


def build_oneshot_agent(agent_id=None, system_prompt=None):
    """一次性 agent (日记/测试/工作流节点用): 无文件工具、无审计。
    挂了知识库的 agent 仍有 retrieve 工具 (Agent.send 自带工具循环)。

    send 包了一层 strip_think: 这些场景的输出都是"最终文本消费方"
    (日记正文/工作流变量池/测试样例), 推理模型的 <think> 块只会污染下游
    — 聊天页的思考渲染走的是 wire.split_think, 与此无关。"""
    cfg = resolve_agent_config(agent_id)
    agent = Agent(
        build_client(cfg),
        system_prompt or cfg["system_prompt"],
        registry=create_registry(),
        **_retrieval_kwargs(cfg),
    )
    from .wire import strip_think
    _raw_send = agent.send
    agent.send = lambda text: strip_think(_raw_send(text))
    return agent
