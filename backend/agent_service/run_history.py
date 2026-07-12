"""workflow 运行历史 — reference 记录层。

每次流式运行的完整事件序列落盘 (data/agent_service/workflow_runs/<run_id>.json,
目录随 data/agent_service 已 gitignore), 供聊天页工作流面板"结果回看":
- 每个 step_end 的完整输出 = 节点间消息传递的原文
- workflow_end 的 context = 变量池终态
- 时间戳相对 run 起点 (t_ms), 可还原节奏

SOD 07 §7 曾把"运行历史持久化"列为不做 — 2026-07-12 用户点名要, 兑现。
"""

import json
import os
import tempfile
import uuid
from datetime import datetime

from .config import DATA_DIR

RUNS_DIR = DATA_DIR / "workflow_runs"
RUNS_DIR.mkdir(parents=True, exist_ok=True)

_KEEP_RUNS = 200          # 磁盘自保: 超出后删最旧
_PREVIEW_CHARS = 120


def new_run_id() -> str:
    return datetime.now().strftime("%Y%m%dT%H%M%S") + "_" + uuid.uuid4().hex[:6]


def save_run(record: dict) -> None:
    """原子落盘 + 滚动清理。"""
    path = RUNS_DIR / f"{record['run_id']}.json"
    fd, tmp = tempfile.mkstemp(dir=str(RUNS_DIR), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(record, f, ensure_ascii=False, default=str)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    _prune()


def _prune() -> None:
    files = sorted(RUNS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime)
    for p in files[:-_KEEP_RUNS]:
        try:
            p.unlink()
        except OSError:
            pass


def list_runs(limit: int = 30) -> list[dict]:
    """摘要列表, 最新在前。逐文件读但只取摘要字段 (文件都很小)。"""
    out = []
    files = sorted(RUNS_DIR.glob("*.json"),
                   key=lambda p: p.stat().st_mtime, reverse=True)
    for p in files[:limit]:
        try:
            r = json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        out.append({
            "run_id": r.get("run_id", p.stem),
            "workflow_id": r.get("workflow_id"),
            "name": r.get("name"),
            "status": r.get("status"),
            "started_at": r.get("started_at"),
            "elapsed_ms": r.get("elapsed_ms"),
            "steps": sum(1 for e in r.get("events", []) if e.get("type") == "step_end"),
            "output_preview": (str(r.get("output") or "")[:_PREVIEW_CHARS]),
        })
    return out


def read_run(run_id: str) -> dict:
    path = RUNS_DIR / f"{run_id}.json"
    if not path.is_file():
        raise KeyError(f"未知运行记录: {run_id}")
    return json.loads(path.read_text(encoding="utf-8"))


def delete_run(run_id: str) -> None:
    path = RUNS_DIR / f"{run_id}.json"
    if not path.is_file():
        raise KeyError(f"未知运行记录: {run_id}")
    path.unlink()
