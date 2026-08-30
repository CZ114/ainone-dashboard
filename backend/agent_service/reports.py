"""reports.py — session 级结构化报告: 生成 + 版本 + 持久化 (Phase 4, gap 5)。

MVP 范围 (docs/plans/agent-mvp-completion.md §5 决策 3): 只做 type="session"
(单次录音一份报告); weekly/monthly 排程与正式临床模板缓做。

分工:
- modality_summary / quality_caveats / evidence_refs — **确定性构建**
  (直接来自录音质量元数据, 不经 LLM, 不会被幻觉污染);
- narrative / observations / risk_flags / recommendations — LLM 生成
  (严格 JSON 输出, 解析失败时整体降级进 narrative, 报告仍可用)。

持久化: backend/data/reports/<patient_id|unassigned>/<report_id>.json,
原子写 (tempfile + os.replace, 与 FileMemoryStore 同法); 同一录音重生成
version 递增。研究原型定位: 报告是"数据观察", 非临床诊断 (见 DISCLAIMER)。
"""

import json
import os
import re
import tempfile
import uuid
from datetime import datetime
from pathlib import Path

import httpx

from .config import BACKEND_DIR, FASTAPI_BASE_URL

REPORTS_DIR = BACKEND_DIR / "data" / "reports"
REPORTS_DIR.mkdir(parents=True, exist_ok=True)

DISCLAIMER = ("Research-prototype auto-generated data observation from a single "
              "wearable recording; not a medical diagnosis or clinical advice - "
              "defer to professional clinical judgment.")

_SAFE_SEG = re.compile(r"[^0-9A-Za-z_-]")
_REPORT_ID_RE = re.compile(r"^rpt_[0-9T]+_[0-9a-f]{6}$")

# 报告里通道名 → 人话 (modality_summary 用; 未知通道原名透传)
_CHANNEL_LABELS = {
    "t_ms": "设备时钟 / Device clock",
    "gsr_filtered": "皮电 GSR/EDA",
    "ppg_ir": "PPG 红外原始 / PPG IR raw",
    "hr_bpm_avg": "心率 BPM / Heart rate",
    "imu_ax_mps2": "加速度 X / Accel X",
    "imu_ay_mps2": "加速度 Y / Accel Y",
    "imu_az_mps2": "加速度 Z / Accel Z",
    "imu_steps": "累计步数 / Step count",
    "env_temp_c": "环境温度 ℃ / Ambient temp",
    "env_humidity_rh": "环境湿度 %RH / Humidity",
    "env_pressure_pa": "气压 Pa / Pressure",
    "env_altitude_m": "海拔 m / Altitude",
}


def _seg(value):
    return _SAFE_SEG.sub("_", str(value or "unassigned")) or "unassigned"


def _patient_dir(patient_id):
    d = REPORTS_DIR / _seg(patient_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _atomic_write_json(path: Path, doc: dict):
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, indent=1)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ─── 确定性部分: 质量元数据 → 摘要/告诫 ──────────────────────────────

def fetch_quality(recording_id):
    """录音质量元数据 (Phase 1 端点, 已缓存)。404/异常返回 None。"""
    try:
        r = httpx.get(f"{FASTAPI_BASE_URL}/api/recordings/quality/{recording_id}",
                      timeout=30)
        if r.status_code != 200:
            return None
        return r.json()
    except Exception:
        return None


def build_modality_summary(quality):
    """quality.per_channel → 逐模态状态表 (确定性, 不经 LLM)。"""
    suspects = {s["name"]: s["reason"] for s in quality.get("suspect_channels") or []}
    out = []
    for ch in quality.get("per_channel") or []:
        name = ch.get("name")
        out.append({
            "channel": name,
            "label": _CHANNEL_LABELS.get(name, name),
            "min": ch.get("min"), "max": ch.get("max"), "mean": ch.get("mean"),
            "missing_pct": ch.get("missing_pct"),
            "status": ("suspect:" + suspects[name]) if name in suspects else "ok",
        })
    return out


def build_quality_caveats(quality):
    """可疑通道/低采样率/截断 → 报告级告诫列表 (确定性)。"""
    caveats = []
    reason_zh = {"all_zero": "全零 (可能未佩戴/未检出 / all zeros, possibly not worn)",
                 "flat": "恒定值 (可能失效 / constant, possibly faulty)",
                 "missing_gt_5pct": "缺失超过 5% (>5% missing)"}
    for s in quality.get("suspect_channels") or []:
        caveats.append(f"通道 {s['name']} {reason_zh.get(s['reason'], s['reason'])}"
                       f" — 相关结论不可依赖该通道（conclusions must not rely on this channel）")
    rate, exp = quality.get("sample_rate_hz"), quality.get("expected_rate_hz") or 50.0
    if rate is not None and rate < exp * 0.9:
        caveats.append(f"实际采样率 {rate}Hz 低于预期 {exp}Hz, 可能存在丢包"
                       f"（sample rate below expected — possible packet loss）")
    if quality.get("truncated"):
        caveats.append("CSV 超长, 统计基于截断前的数据（CSV truncated; statistics "
                       "based on pre-truncation data）")
    return caveats


# ─── LLM 部分: 严格 JSON, 失败降级 ───────────────────────────────────

_LLM_SECTIONS_PROMPT = """You are the report-writing assistant of a wearable health-data platform. Using the quality metadata and per-channel statistics of the recording below, produce an objective data-observation report. This is a research prototype: describe data characteristics and trends only, and make no medical diagnosis. A suspect channel (status beginning with "suspect:") must never be used as the basis of an observation - mention it only to state that it is unusable.

Recording quality metadata (JSON):
{quality_json}

Recent recording context for this patient (optional):
{patient_context}

Output strictly in the following JSON format, in English (no markdown code fence, no extra text):
{{"narrative": "2-4 sentence overview",
 "observations": ["observation 1 (cite the specific channel and values)", "..."],
 "risk_flags": [{{"flag": "point needing attention", "severity": "low|medium|high", "basis": "which channel/value it rests on"}}],
 "recommendations": ["recommendation 1 (about data capture, re-measurement or wear position - not clinical management)", "..."]}}"""


def _parse_llm_sections(text):
    """LLM 输出 → dict; 解析失败整体降级进 narrative (报告不因格式翻车)。"""
    fallback = {"narrative": (text or "").strip()[:2000],
                "observations": [], "risk_flags": [], "recommendations": [],
                "llm_parse_ok": False}
    if not text:
        return fallback
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        return fallback
    try:
        data = json.loads(m.group(0))
    except json.JSONDecodeError:
        return fallback
    if not isinstance(data, dict):
        return fallback
    return {
        "narrative": str(data.get("narrative") or "")[:2000],
        "observations": [str(x) for x in (data.get("observations") or [])][:12],
        "risk_flags": [x for x in (data.get("risk_flags") or [])
                       if isinstance(x, dict)][:8],
        "recommendations": [str(x) for x in (data.get("recommendations") or [])][:8],
        "llm_parse_ok": True,
    }


# ─── 生成 + 持久化 ───────────────────────────────────────────────────

def _next_version(pdir: Path, recording_id):
    v = 0
    for p in pdir.glob("rpt_*.json"):
        try:
            doc = json.loads(p.read_text(encoding="utf-8"))
            if doc.get("recording_id") == recording_id:
                v = max(v, int(doc.get("version") or 0))
        except (OSError, ValueError):
            continue
    return v + 1


def latest_recording_for(patient_id):
    """该患者最新一条有 CSV 的录音 id; 无则 None。"""
    try:
        r = httpx.get(f"{FASTAPI_BASE_URL}/api/recordings/list",
                      params={"patient_id": patient_id} if patient_id else None,
                      timeout=5)
        r.raise_for_status()
        for s in r.json().get("sessions") or []:
            if s.get("csv"):
                return s.get("id")
    except Exception:
        pass
    return None


def generate_session_report(recording_id=None, patient_id=None, generated_by=None,
                            agent_id=None):
    """生成并落盘一份 session 报告。返回完整报告 dict。
    recording_id 缺省时取该患者最新一条有 CSV 的录音。

    Raises:
        LookupError: 找不到录音 / 无质量元数据 (无 CSV / 录音服务不可用)
    """
    if not recording_id:
        recording_id = latest_recording_for(patient_id)
        if not recording_id:
            raise LookupError(
                f"患者 {patient_id or '(未指定)'} 没有可用的录音 (无 CSV)"
                f"（No usable recording with CSV for this patient）")
    q = fetch_quality(recording_id)
    if q is None:
        raise LookupError(
            f"录音 {recording_id} 无质量元数据 (无 CSV 或录音服务不可用)"
            f"（Recording has no quality metadata — no CSV, "
            f"or the recording service is unavailable）")
    quality = q.get("quality") or {}
    patient_id = patient_id or q.get("patient_id")   # sidecar 归属兜底

    # LLM 段落 (oneshot; strip_think 已内置)。LLM 不可用时降级为纯确定性报告。
    from .agent_tools import patient_recordings_block
    from .factory import build_oneshot_agent
    llm = {"narrative": "", "observations": [], "risk_flags": [],
           "recommendations": [], "llm_parse_ok": False}
    model_used = None
    llm_error = None
    try:
        agent = build_oneshot_agent(agent_id)
        model_used = f"{agent.client.provider}/{agent.client.model}"
        prompt = _LLM_SECTIONS_PROMPT.format(
            quality_json=json.dumps(
                {**quality, "per_channel": build_modality_summary(quality)},
                ensure_ascii=False),
            patient_context=patient_recordings_block(patient_id) if patient_id
            else "(未关联患者)")
        llm = _parse_llm_sections(agent.send(prompt))
    except Exception as e:
        llm_error = f"{type(e).__name__}: {e}"

    pdir = _patient_dir(patient_id)
    report_id = ("rpt_" + datetime.now().strftime("%Y%m%dT%H%M%S")
                 + "_" + uuid.uuid4().hex[:6])
    doc = {
        "id": report_id,
        "type": "session",
        "version": _next_version(pdir, recording_id),
        "patient_id": patient_id,
        "recording_id": recording_id,
        "source_recordings": [recording_id],
        "generated_at": datetime.now().isoformat(),
        "generated_by": generated_by,
        "model": model_used,
        "recording_started_at": q.get("started_at_iso"),
        "duration_s": quality.get("duration_s"),
        "sample_rate_hz": quality.get("sample_rate_hz"),
        "modality_summary": build_modality_summary(quality),
        "quality_caveats": build_quality_caveats(quality),
        "narrative": llm["narrative"],
        "observations": llm["observations"],
        "risk_flags": llm["risk_flags"],
        "recommendations": llm["recommendations"],
        "llm_parse_ok": llm["llm_parse_ok"],
        "llm_error": llm_error,
        "evidence_refs": [{"source": f"recording:{recording_id}",
                           "preview": f"{quality.get('duration_s')}s "
                                      f"@{quality.get('sample_rate_hz')}Hz, "
                                      f"{quality.get('rows')}行"}],
        "disclaimer": DISCLAIMER,
    }
    _atomic_write_json(pdir / f"{report_id}.json", doc)
    return doc


# ─── 查询 ────────────────────────────────────────────────────────────

def list_reports(patient_id=None, limit=50):
    """按生成时间倒序的报告索引 (不含正文大字段)。patient_id=None → 全部。"""
    dirs = ([_patient_dir(patient_id)] if patient_id
            else [d for d in REPORTS_DIR.iterdir() if d.is_dir()])
    items = []
    for d in dirs:
        for p in d.glob("rpt_*.json"):
            try:
                doc = json.loads(p.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            items.append({k: doc.get(k) for k in (
                "id", "type", "version", "patient_id", "recording_id",
                "generated_at", "generated_by", "model", "duration_s",
                "llm_parse_ok")})
    items.sort(key=lambda x: x.get("generated_at") or "", reverse=True)
    return items[:max(1, min(limit, 200))]


def read_report(report_id):
    """完整报告。不存在 → KeyError。id 需匹配我们自己的命名模式 (防穿越)。"""
    if not _REPORT_ID_RE.match(report_id or ""):
        raise KeyError(f"非法报告 id: {report_id}（Invalid report id）")
    for d in REPORTS_DIR.iterdir():
        if not d.is_dir():
            continue
        p = d / f"{report_id}.json"
        if p.is_file():
            return json.loads(p.read_text(encoding="utf-8"))
    raise KeyError(f"未知报告: {report_id}（Unknown report）")
