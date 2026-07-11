"""agent_service 的初始工具集 — 对标 Claude SDK claude_code 预设里 chat 页实际用到的能力。

read_file / write_file 限制在仓库白名单内 (等价 SDK 的 additionalDirectories 语义,
见 SOD 04 与 dashboard-integration-alignment.md §5.5)。
delegate 是 multi-agent 预留占位, 调用即报错提示未实现。
"""

import json
from pathlib import Path

import httpx

from agent import create_registry

from .config import FASTAPI_BASE_URL, FS_WHITELIST


def _check_whitelist(path_str):
    """返回 resolve 后的 Path; 不在白名单内则 raise (executor 会包成 error 给模型看)。

    相对路径锚定到仓库根 (而不是服务进程的 CWD) — 模型给的路径几乎都是仓库相对路径。
    """
    p = Path(path_str).expanduser()
    if not p.is_absolute():
        p = FS_WHITELIST[0] / p
    p = p.resolve()
    for root in FS_WHITELIST:
        try:
            p.relative_to(Path(root).resolve())
            return p
        except ValueError:
            continue
    raise PermissionError(f"路径不在允许范围内 (仅限仓库目录): {path_str}")


def build_registry():
    reg = create_registry()

    @reg.tool(parallel=True, description="读取仓库内的文本文件 (含录音 CSV)。返回内容, 超长截断。")
    def read_file(path: str, max_chars: int = 20000):
        p = _check_whitelist(path)
        if not p.is_file():
            return {"error": f"文件不存在: {path}"}
        text = p.read_text(encoding="utf-8", errors="replace")
        truncated = len(text) > max_chars
        return {
            "path": str(p),
            "size_chars": len(text),
            "truncated": truncated,
            "content": text[:max_chars],
        }

    @reg.tool(parallel=False, requires_approval=True,
              description="在仓库内写入/覆盖一个文本文件。高风险操作, 需要用户批准。")
    def write_file(path: str, content: str):
        p = _check_whitelist(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        return {"ok": True, "path": str(p), "written_chars": len(content)}

    @reg.tool(parallel=True, description="列出最近的传感器录音 session (来自平台录音服务)。")
    def list_recordings():
        try:
            r = httpx.get(f"{FASTAPI_BASE_URL}/api/recordings/list", timeout=4)
            r.raise_for_status()
            data = r.json()
        except Exception as e:
            return {"error": f"录音服务不可用 ({FASTAPI_BASE_URL}): {type(e).__name__}: {e}"}
        # 原样透传, 只防超长 (executor 还有 output_limit 兜底)
        return {"ok": True, "recordings": data}

    @reg.tool(parallel=False, output_limit=20000,
              description="把子任务委派给另一个已配置的 agent 并返回其回答。"
                          "适合需要专门能力的子问题 (如挂载知识库的 agent)。"
                          "agent_id 用设置页 Agents 里的 id。")
    def delegate(agent_id: str, task: str):
        # 延迟 import 防循环 (factory 顶层 import 本模块的 build_registry)。
        # 子 agent 用 oneshot 构造 — registry 为空(仅自动注册的 retrieve 等),
        # 天然没有 delegate 工具 → 委派深度恒为 1, 无递归风险。
        from .factory import build_oneshot_agent
        try:
            sub = build_oneshot_agent(agent_id)
        except KeyError as e:
            return {"error": str(e)}
        answer = sub.send(task)
        return {"ok": True, "agent": agent_id, "model": sub.client.model,
                "answer": answer}

    return reg


def recordings_context_provider():
    """ContextManager provider: 每轮注入最近录音概况; 录音服务不在线则静默跳过。"""
    try:
        r = httpx.get(f"{FASTAPI_BASE_URL}/api/recordings/list", timeout=3)
        r.raise_for_status()
        data = r.json()
    except Exception:
        return None
    text = json.dumps(data, ensure_ascii=False)
    if len(text) > 1500:
        text = text[:1500] + "…[截断, 完整列表用 list_recordings 工具]"
    return ("最近录音 (raw, 来自 /api/recordings/list)", text)
