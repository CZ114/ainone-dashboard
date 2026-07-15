"""multi-agent 工作流定义管理 — data/agent_service/workflows.json。

结构: {"version": 1, "workflows": {id: spec}}
spec 格式见 agent.orchestration.workflow 模块 docstring (五种步骤组件)。
存前用库的 validate_spec 静态校验 + 检查引用的 agent 节点可解析。
"""

import json
import os
import re
import tempfile
import threading

from agent.orchestration import validate_spec

from .config import DATA_DIR

WORKFLOWS_JSON = DATA_DIR / "workflows.json"
_lock = threading.Lock()
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,39}$")


def _load_doc() -> dict:
    try:
        doc = json.loads(WORKFLOWS_JSON.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        doc = {}
    doc.setdefault("version", 1)
    doc.setdefault("workflows", {})
    return doc


def _save_doc(doc: dict) -> None:
    fd, tmp = tempfile.mkstemp(dir=str(DATA_DIR), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, indent=2)
        os.replace(tmp, WORKFLOWS_JSON)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def referenced_agents(spec: dict) -> set:
    """收集 spec 里所有 agent 节点名 (含嵌套), 供存前校验可解析。"""
    names = set()

    def walk(steps):
        for s in steps or []:
            if not isinstance(s, dict):
                continue
            if s.get("type") in ("agent", "route") and s.get("agent"):
                names.add(s["agent"])
            walk(s.get("steps"))
            for branch in (s.get("routes") or {}).values():
                walk(branch)

    walk(spec.get("steps"))
    return names


def list_workflows() -> list[dict]:
    out = []
    for wf_id, spec in _load_doc()["workflows"].items():
        out.append({
            "id": wf_id,
            "name": spec.get("name") or wf_id,
            "description": spec.get("description") or "",
            "inputs": spec.get("inputs") or [],
            "agents": sorted(referenced_agents(spec)),
        })
    return out


def get_workflow(wf_id: str) -> dict:
    spec = _load_doc()["workflows"].get(wf_id)
    if spec is None:
        raise KeyError(f"未知 workflow: {wf_id}")
    return spec


def upsert_workflow(wf_id: str, spec: dict, known_agent_ids: set) -> dict:
    if not _ID_RE.match(wf_id):
        raise ValueError(f"非法 workflow id: {wf_id!r} (2-40 位小写字母/数字/_/-)")
    problems = validate_spec(spec)
    unknown = referenced_agents(spec) - known_agent_ids
    if unknown:
        problems.append(f"引用了未定义的 agent: {sorted(unknown)} (先在 Agents 里创建)")
    if problems:
        raise ValueError("spec 校验失败: " + "; ".join(problems))
    spec = dict(spec)
    spec["id"] = wf_id
    with _lock:
        doc = _load_doc()
        doc["workflows"][wf_id] = spec
        _save_doc(doc)
    return spec


def delete_workflow(wf_id: str) -> None:
    with _lock:
        doc = _load_doc()
        if wf_id not in doc["workflows"]:
            raise KeyError(f"未知 workflow: {wf_id}")
        del doc["workflows"][wf_id]
        _save_doc(doc)


# ─── 种子: followup_review (患者照护丝带默认数据源) ───────────────────
# workflows.json 是运行时数据 (gitignore, 不进 git), 但这个"随访分析"
# workflow 是 M3 医生"为患者发起分析"的目标 + 患者照护丝带的数据源,
# 需保证任何环境都存在 → 首启种子。纯 agent (无 human), 每步带 labels
# 供三镜头投影。引用 triage/doctor/verifier agent (问诊场景已建)。
_SEED_FOLLOWUP = {
    "name": "随访分析 (纯 AI, 无需人工)",
    "description": "医生一键为患者跑: 评估 → 检索知识库诊断 → 核验循环至 PASS。"
                   "无 human 步骤, 后台跑完, 患者照护丝带完整呈现。",
    "inputs": ["complaint"],
    "output": "{diagnosis}",
    "steps": [
        {"type": "agent", "id": "triage", "agent": "triage",
         "prompt": "患者主诉与近期情况:\n{complaint}\n\n请做初步评估, 列出需要关注的要点。",
         "labels": {"patient": "正在了解你的情况…", "doctor": "初诊评估"}},
        {"type": "agent", "id": "diagnosis", "agent": "doctor",
         "prompt": "患者主诉:\n{complaint}\n\n初步评估:\n{triage}\n\n"
                   "请先检索知识库, 再输出诊断分析与随访建议。",
         "labels": {"patient": "正在对照医生留下的资料…", "doctor": "知识库检索与诊断推理"}},
        {"type": "loop", "id": "revise", "max_iters": 3, "steps": [
            {"type": "agent", "id": "review", "agent": "verifier",
             "prompt": "请核验以下诊断分析。\n患者主诉: {complaint}\n\n"
                       "诊断分析:\n{diagnosis}\n\n若无误请回复以 PASS 开头。",
             "labels": {"patient": "医生会亲自确认一遍结果…", "doctor": "诊断复核验证"}},
            {"type": "break_if", "when": {"var": "review", "regex": "^\\s*PASS\\b"}},
            {"type": "agent", "id": "diagnosis", "agent": "doctor",
             "prompt": "核验意见:\n{review}\n\n请逐条回应并输出修订后的完整诊断分析。",
             "labels": {"patient": "医生正在调整诊断结果…", "doctor": "诊断反馈与修订"}},
        ]},
    ],
    "id": "followup_review",
}


def ensure_seed() -> None:
    """首启确保种子 workflow 存在; 已存在则不动 (尊重用户后续修改)。"""
    with _lock:
        doc = _load_doc()
        if "followup_review" not in doc["workflows"]:
            doc["workflows"]["followup_review"] = dict(_SEED_FOLLOWUP)
            _save_doc(doc)
