"""AgentFactory — 从配置构造 Agent 实例。

multi-agent 预留落点 (SOD 04): agent_id 映射到 backend/data/diary/agents.json 里的定义,
secrets 用 ${NAME} 占位符, 解析链: agents.json secrets 块 > 环境变量。
当前只有 "default" 是保证可用的; agents.json 里的自定义 id 也能解析 (schema 兼容日记系统)。

RAG 预留: cfg 里出现 retrieval 字段时报 NotImplementedError (系统未完善, 接口先占位)。
"""

import json
import os
import re

from agent import Agent, AgentDeploy, AuditLog, create_registry

from .agent_tools import build_registry, recordings_context_provider
from .config import (
    AGENTS_JSON,
    DEFAULT_MODEL,
    DEFAULT_PROVIDER,
    DEFAULT_SYSTEM_PROMPT,
    SESSIONS_DIR,
)

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
    """返回归一化配置 dict: provider/model/api_key/system_prompt/temperature。

    agent_id 为 None/"default" 时用服务默认; 否则查 agents.json (日记系统 schema)。
    """
    if not agent_id or agent_id == "default":
        return {
            "provider": DEFAULT_PROVIDER,
            "model": DEFAULT_MODEL,
            "api_key": None,  # AgentDeploy 走环境变量 (含 config.py 的命名映射)
            "system_prompt": DEFAULT_SYSTEM_PROMPT,
            "temperature": 0.7,
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

    if cfg.get("retrieval"):
        raise NotImplementedError(
            "RAG 尚未接入 — retrieval 字段是预留接口 (SOD 04-reserved-interfaces.md)"
        )

    secrets = doc.get("secrets") or {}
    # env 块解析后注入环境 (agent 库按环境变量找 key); 已存在的变量不覆盖
    for k, v in (cfg.get("env") or {}).items():
        if isinstance(v, str) and not os.getenv(k):
            os.environ[k] = _resolve_secret(v, secrets)

    sampling = cfg.get("sampling") or {}
    return {
        "provider": cfg.get("provider") or DEFAULT_PROVIDER,
        "model": cfg.get("model") or DEFAULT_MODEL,
        "api_key": None,
        "system_prompt": cfg.get("system_prompt") or DEFAULT_SYSTEM_PROMPT,
        "temperature": sampling.get("temperature", 0.7),
    }


def build_client(cfg):
    return AgentDeploy(
        provider=cfg["provider"],
        model=cfg["model"],
        api_key=cfg["api_key"],
        temperature=cfg["temperature"],
    )


def build_chat_agent(session_id, agent_id=None):
    """交互会话 agent: 全套工具 + 录音上下文注入 + AuditLog (both 模式, 供 resume+审计)。"""
    cfg = resolve_agent_config(agent_id)
    audit = AuditLog(
        SESSIONS_DIR / f"{session_id}.jsonl",
        session_id=session_id,
        mode="both",
    )
    return Agent(
        build_client(cfg),
        cfg["system_prompt"],
        registry=build_registry(),
        context_providers=[recordings_context_provider],
        audit_log=audit,
        max_rounds=8,
    )


def build_oneshot_agent(agent_id=None, system_prompt=None):
    """一次性 agent (日记用): 无工具、无审计, prompt 由调用方全权控制。"""
    cfg = resolve_agent_config(agent_id)
    return Agent(
        build_client(cfg),
        system_prompt or cfg["system_prompt"],
        registry=create_registry(),
    )
