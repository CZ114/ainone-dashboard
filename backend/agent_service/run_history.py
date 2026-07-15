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
import threading
import time
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


def list_runs(limit: int = 30, owner=None) -> list[dict]:
    """摘要列表, 最新在前。owner 给定 (患者) → 只返回该 owner 名下的运行;
    owner=None (医生/开发者) → 全部。旧记录无 owner 只对 owner=None 可见。
    先按 owner 过滤再取 limit, 避免最新 limit 个里恰好没有匹配项。"""
    out = []
    files = sorted(RUNS_DIR.glob("*.json"),
                   key=lambda p: p.stat().st_mtime, reverse=True)
    for p in files:
        try:
            r = json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if owner is not None and r.get("owner") != owner:
            continue
        out.append({
            "run_id": r.get("run_id", p.stem),
            "workflow_id": r.get("workflow_id"),
            "name": r.get("name"),
            "owner": r.get("owner"),
            "status": r.get("status"),
            "started_at": r.get("started_at"),
            "elapsed_ms": r.get("elapsed_ms"),
            "steps": sum(1 for e in r.get("events", []) if e.get("type") == "step_end"),
            "output_preview": (str(r.get("output") or "")[:_PREVIEW_CHARS]),
        })
        if len(out) >= limit:
            break
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


# ─── 活跃运行追踪 (对话式自动启动的直播数据源) ───────────────────────
# 聊天 agent 通过 run_workflow 工具启动的运行没有自己的 HTTP 流 —
# 前端工作流面板轮询这里发现"有工作流在跑"并直播其事件。
# /workflows/{id}/stream 手动运行也登记, 两条路径共用一套追踪。

_active: dict = {}
_active_lock = threading.Lock()


class RunHandle:
    """一次运行的追踪句柄: add_event 累积, finish 归档并摘除。"""

    def __init__(self, run_id, workflow_id, name, inputs, owner=None, patient_id=None):
        self.run_id = run_id
        self.workflow_id = workflow_id
        self.name = name
        self.inputs = inputs
        self.owner = owner            # M3 归属: 发起者 (患者编号 / staff 用户名)
        self.patient_id = patient_id  # 服务对象患者 (为谁跑; 照护丝带按它查)
        self.started = time.time()
        self.events: list[dict] = []
        self._lock = threading.Lock()

    def add_event(self, event: dict) -> None:
        with self._lock:
            self.events.append(
                {**event, "t_ms": int((time.time() - self.started) * 1000)})

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "run_id": self.run_id,
                "workflow_id": self.workflow_id,
                "name": self.name,
                "owner": self.owner,
                "patient_id": self.patient_id,
                "status": "running",
                "started_at": datetime.fromtimestamp(self.started).isoformat(),
                "events": list(self.events),
            }

    def finish(self) -> None:
        """按事件判定状态, 落盘, 从活跃表摘除。幂等。"""
        with _active_lock:
            if _active.pop(self.run_id, None) is None:
                return
        status = "error" if any(e["type"] == "error" for e in self.events) else (
            "done" if any(e["type"] == "workflow_end" for e in self.events)
            else "aborted")
        final = next((e for e in self.events if e["type"] == "workflow_end"), {})
        try:
            save_run({
                "run_id": self.run_id,
                "workflow_id": self.workflow_id,
                "name": self.name,
                "owner": self.owner,
                "patient_id": self.patient_id,
                "status": status,
                "inputs": self.inputs,
                "started_at": datetime.fromtimestamp(self.started).isoformat(),
                "elapsed_ms": int((time.time() - self.started) * 1000),
                "output": final.get("output"),
                "events": self.events,
            })
        except Exception:
            pass


def start_run(workflow_id: str, name: str, inputs: dict, owner=None,
              patient_id=None) -> RunHandle:
    h = RunHandle(new_run_id(), workflow_id, name, inputs, owner, patient_id)
    with _active_lock:
        _active[h.run_id] = h
    return h


def list_active(owner=None) -> list[dict]:
    with _active_lock:
        handles = list(_active.values())
    return [{
        "run_id": h.run_id,
        "workflow_id": h.workflow_id,
        "name": h.name,
        "owner": h.owner,
        "started_at": datetime.fromtimestamp(h.started).isoformat(),
        "n_events": len(h.events),
    } for h in handles if owner is None or h.owner == owner]


def get_active(run_id: str) -> dict:
    with _active_lock:
        h = _active.get(run_id)
    if h is None:
        raise KeyError(f"运行不在进行中: {run_id}")
    return h.snapshot()


# ─── 患者照护丝带 (M3 #34) ───────────────────────────────────────────
# 患者今天页把"为他跑的" workflow 运行, 按 step 的 labels.patient 投影成
# 一条护理叙事丝带。只取带 labels.patient 的步骤 (无叙事文案的技术步骤
# 对患者不可见)。

def _ribbon_steps(events: list[dict], running: bool) -> list[dict]:
    """事件序列 → [{label, status}]。只收带 labels.patient 的步骤。
    running 时第一个未完成步骤标 active, 其后 pending; 已结束的 run 全 done。"""
    collected = []          # [(step_id, patient_label)]
    ended = set()
    for e in events:
        lbl = e.get("labels")
        pl = lbl.get("patient") if isinstance(lbl, dict) else None
        if e.get("type") in ("step_start", "human_ask") and pl:
            collected.append((e.get("step"), pl))
        elif e.get("type") == "step_end":
            ended.add(e.get("step"))
    out = []
    active_marked = False
    for sid, label in collected:
        if sid in ended:
            out.append({"label": label, "status": "done"})
        elif running and not active_marked:
            out.append({"label": label, "status": "active"})
            active_marked = True
        else:
            out.append({"label": label, "status": "pending" if running else "done"})
    return out


def care_ribbon_for(patient_id: str) -> dict:
    """某患者的照护丝带: 优先进行中的 run, 否则最近一次为其跑的 run。
    返回 {running, steps:[{label,status}]}。"""
    if not patient_id:
        return {"running": False, "steps": []}
    with _active_lock:
        handles = [h for h in _active.values() if h.patient_id == patient_id]
    if handles:
        h = max(handles, key=lambda x: x.started)
        with h._lock:
            events = list(h.events)
        return {"running": True, "steps": _ribbon_steps(events, True)}
    # 无进行中 → 最近一次为该患者跑完的 run
    files = sorted(RUNS_DIR.glob("*.json"),
                   key=lambda p: p.stat().st_mtime, reverse=True)
    for p in files:
        try:
            r = json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if r.get("patient_id") == patient_id:
            return {"running": False, "steps": _ribbon_steps(r.get("events", []), False)}
    return {"running": False, "steps": []}
