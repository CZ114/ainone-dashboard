"""agent_service 的初始工具集 — 对标 Claude SDK claude_code 预设里 chat 页实际用到的能力。

read_file / write_file 限制在仓库白名单内 (等价 SDK 的 additionalDirectories 语义,
见 SOD 04 与 dashboard-integration-alignment.md §5.5)。
delegate 是 multi-agent 预留占位, 调用即报错提示未实现。
"""

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
    raise PermissionError(f"路径不在允许范围内 (仅限仓库目录): {path_str}"
                          f"（Path outside the allowed scope — repository directories only）")


def build_registry():
    reg = create_registry()

    @reg.tool(parallel=True, description="读取仓库内的文本文件 (含录音 CSV)。返回内容, 超长截断。")
    def read_file(path: str, max_chars: int = 20000):
        p = _check_whitelist(path)
        if not p.is_file():
            return {"error": f"文件不存在: {path}（File not found）"}
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

    @reg.tool(parallel=True, description="列出最近的传感器录音 session (来自平台录音服务)。"
                                         "可选 patient_id 只列某患者的录音。")
    def list_recordings(patient_id: str = ""):
        try:
            params = {"patient_id": patient_id} if patient_id else None
            r = httpx.get(f"{FASTAPI_BASE_URL}/api/recordings/list",
                          params=params, timeout=4)
            r.raise_for_status()
            data = r.json()
        except Exception as e:
            return {"error": f"录音服务不可用（Recording service unavailable） "
                             f"({FASTAPI_BASE_URL}): {type(e).__name__}: {e}"}
        # 原样透传, 只防超长 (executor 还有 output_limit 兜底)
        return {"ok": True, "recordings": data}

    @reg.tool(parallel=True, output_limit=30000,
              description="读取一段录音的质量摘要与逐通道统计 (时间范围/采样率/缺失/可疑通道/"
                          "min-max-mean)。分析录音数据时优先用它, 而不是直接 read_file 读原始 CSV。"
                          "session_id 形如 20260426_141725; head>0 时附带前 N 行原始数据。")
    def read_recording(session_id: str, head: int = 0):
        out = {}
        try:
            r = httpx.get(f"{FASTAPI_BASE_URL}/api/recordings/quality/{session_id}",
                          timeout=20)  # 首次计算大 CSV 需要时间; 之后走缓存
            r.raise_for_status()
            out = r.json()
        except httpx.HTTPStatusError as e:
            return {"error": f"录音 {session_id} 无 CSV 或 id 非法: {e.response.status_code}"
                             f"（Recording has no CSV or the id is invalid）"}
        except Exception as e:
            return {"error": f"录音服务不可用（Recording service unavailable） "
                             f"({FASTAPI_BASE_URL}): {type(e).__name__}: {e}"}
        if head and head > 0:
            try:
                r = httpx.get(
                    f"{FASTAPI_BASE_URL}/api/recordings/csv/sensor_{session_id}.csv",
                    params={"head": min(int(head), 500)}, timeout=10)
                r.raise_for_status()
                out["head_rows"] = r.text
            except Exception as e:
                out["head_rows_error"] = f"{type(e).__name__}: {e}"
        return out

    # 网络搜索: 直接复用 agent 库自带的 web.py (Tavily 搜索 + trafilatura 正文提取,
    # 用户 Phase 6 external-retrieval 时已写好并配了 TAVILY_API_KEY — 库 import 时
    # 从 agent/.env 自动加载)。key 缺失/依赖缺失时跳过, 不挡服务启动。
    try:
        from agent.tools.web import register_web_tools
        register_web_tools(reg)
    except Exception as e:
        print(f"[agent_service] web 工具未挂载 (可选): {type(e).__name__}: {e}")

    # 对话式启动 multi-agent 工作流 — LLM 判断用户请求匹配某工作流时自主调用。
    # 运行事件进 run_history 活跃追踪 → 聊天页工作流面板轮询发现并自动直播。
    # 工具描述里的清单是本次会话构建时的快照 (新会话自动刷新)。
    def _workflow_catalog_line():
        try:
            from . import workflows_admin
            items = workflows_admin.list_workflows()
            return "; ".join(
                f"{w['id']}(输入: {', '.join(w.get('inputs') or []) or '无'})"
                f" = {w.get('name', '')}"
                for w in items) or "(暂无已定义的工作流)"
        except Exception:
            return "(工作流清单读取失败)"

    @reg.tool(parallel=False, output_limit=30000,
              description="启动一个预定义的多智能体工作流, 等待完成并返回最终输出。"
                          "当用户请求匹配某个工作流的场景时应主动使用, 运行过程会"
                          "实时显示在用户界面的工作流面板里。"
                          f"可用工作流: {_workflow_catalog_line()}。"
                          "inputs 传对象, 键为该工作流的输入名, 值从用户请求中提取。"
                          "为某位患者跑时带上 patient_id (P-xxx), 声明了"
                          " patient_recordings 输入的工作流会自动注入该患者的"
                          "录音质量摘要。")
    def run_workflow(workflow_id: str, inputs: dict, patient_id: str = ""):
        from agent.orchestration import Workflow, WorkflowError

        from . import run_history, workflows_admin
        from .bridge import human_inputs
        from .factory import tracking_build_agent
        try:
            spec = workflows_admin.get_workflow(workflow_id)
            wf = Workflow(spec)
        except (KeyError, Exception) as e:
            return {"error": f"工作流加载失败（Workflow load failed）: {e}"}

        # Phase 3 (gap 7): 声明了 patient_recordings 的工作流注入患者录音质量摘要
        inputs = augment_workflow_inputs(spec, inputs, patient_id or None)

        handle = run_history.start_run(
            workflow_id, spec.get("name") or workflow_id, inputs or {},
            patient_id=(patient_id or None))

        def ask_human(prompt: str) -> str:
            p = human_inputs.create()
            handle.add_event({"type": "human_input_required",
                              "input_id": p.id, "prompt": prompt})
            value = human_inputs.wait(p, 600)
            if value is None:
                raise WorkflowError("等待人工输入超时 (600s)（Timed out waiting for human input）")
            return value

        output = None
        try:
            for kind, payload in wf.run(inputs or {},
                                        build_agent=tracking_build_agent(handle.add_event),
                                        ask_human=ask_human):
                event = {"type": kind, **(payload or {})}
                if kind == "workflow_start":
                    event["run_id"] = handle.run_id
                handle.add_event(event)
                if kind == "workflow_end":
                    output = payload.get("output")
        except WorkflowError as e:
            handle.add_event({"type": "error", "error": str(e)})
            return {"error": str(e), "run_id": handle.run_id}
        finally:
            handle.finish()
        return {"ok": True, "run_id": handle.run_id,
                "output": (output or "")[:8000]}

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


_SUSPECT_REASON_ZH = {
    "all_zero": "全零",
    "flat": "恒定值",
    "missing_gt_5pct": ">5%缺失",
}


def _humanize_age(started_iso):
    """ISO 起始时间 → '3分钟前/5小时前/12天前' + 是否旧数据 (>7 天)。"""
    from datetime import datetime
    try:
        dt = datetime.fromisoformat(started_iso)
        secs = (datetime.now() - dt).total_seconds()
    except (TypeError, ValueError):
        return "时间未知", False
    if secs < 3600:
        return f"{max(1, int(secs // 60))}分钟前", False
    if secs < 86400:
        return f"{int(secs // 3600)}小时前", False
    days = int(secs // 86400)
    return f"{days}天前", days > 7


def _quality_line(sid, quality):
    """一条录音的质量摘要行 (给 provider 注入用, 尽量紧凑)。"""
    if not quality:
        return "    (无 CSV 质量数据)"
    dur = quality.get("duration_s")
    rate = quality.get("sample_rate_hz")
    parts = [
        f"{dur}s" if dur is not None else "时长未知",
        f"@{rate}Hz" if rate is not None else "",
        f"{quality.get('rows')}行/{len(quality.get('channels') or [])}通道",
    ]
    line = "    " + " ".join(p for p in parts if p)
    suspects = quality.get("suspect_channels") or []
    if suspects:
        s = "; ".join(f"{x['name']}{_SUSPECT_REASON_ZH.get(x['reason'], x['reason'])}"
                      for x in suspects[:5])
        line += f"\n    ⚠ 可疑通道: {s} — 分析时勿依赖这些通道"
    exp = quality.get("expected_rate_hz") or 50.0
    if rate is not None and rate < exp * 0.9:
        line += f"\n    ⚠ 采样率低于预期 ({rate} < {exp}Hz), 可能有丢包"
    return line


def _report_context_block(doc):
    """一份报告 → 紧凑注入文本 (确定性字段 + LLM 段落, 每份封顶 ~1500 字)。"""
    lines = [
        f"报告 {doc.get('id')} (v{doc.get('version')}) · 录音 {doc.get('recording_id')}"
        f" · 患者 {doc.get('patient_id') or '未关联'}"
        f" · {str(doc.get('generated_at') or '')[:16]}",
    ]
    if doc.get("narrative"):
        lines.append(f"总述: {doc['narrative'][:400]}")
    for o in (doc.get("observations") or [])[:5]:
        lines.append(f"- 观察: {str(o)[:160]}")
    for f in (doc.get("risk_flags") or [])[:4]:
        if isinstance(f, dict):
            lines.append(f"- 风险[{f.get('severity', '?')}]: "
                         f"{str(f.get('flag') or '')[:120]}"
                         f"{' — ' + str(f.get('basis'))[:80] if f.get('basis') else ''}")
    for r in (doc.get("recommendations") or [])[:3]:
        lines.append(f"- 建议: {str(r)[:160]}")
    for c in (doc.get("quality_caveats") or [])[:4]:
        lines.append(f"- ⚠ {str(c)[:160]}")
    if doc.get("llm_parse_ok") is False:
        lines.append("- ⚠ 该报告 LLM 段落生成失败, 仅含确定性统计")
    text = "\n".join(lines)
    return text[:1500]


def make_reports_context_provider(session_id):
    """ContextManager provider 工厂 (Phase 5 — 报告加入上下文):
    聊天侧边栏为该会话勾选的报告, 每轮以摘要块注入。未勾选返回 None (零成本)。
    勾选状态在 context_reports side-car, 前端 PUT 即改, 下一轮生效。"""
    def provider():
        from . import context_reports, reports
        ids = context_reports.get(session_id)
        if not ids:
            return None
        blocks = []
        for rid in ids:
            try:
                blocks.append(_report_context_block(reports.read_report(rid)))
            except (KeyError, OSError, ValueError):
                continue   # 报告被删/损坏 → 跳过, 不炸整轮注入
        if not blocks:
            return None
        return ("用户选中加入上下文的分析报告 (引用其中数值时注明报告 id)",
                "\n\n".join(blocks))
    return provider


def patient_recordings_block(patient_id, limit=3):
    """患者最近录音的质量摘要文本块 (Phase 3, gap 7 — workflow 变量 {patient_recordings})。
    依赖录制时写入的 patient_id sidecar (决策 B); 服务不可用/无录音时返回说明文字,
    绝不抛异常 (workflow 不应因录音服务离线而失败)。"""
    if not patient_id:
        return "(未指定患者, 无录音数据)"
    try:
        r = httpx.get(f"{FASTAPI_BASE_URL}/api/recordings/list",
                      params={"patient_id": patient_id}, timeout=4)
        r.raise_for_status()
        sessions = r.json().get("sessions") or []
    except Exception as e:
        return f"(录音服务不可用: {type(e).__name__})"
    if not sessions:
        return f"(患者 {patient_id} 暂无录音)"
    blocks = []
    for s in sessions[:limit]:
        sid = s.get("id")
        age, old = _humanize_age(s.get("started_at_iso"))
        head = (f"[{sid}] {age}{' (旧数据)' if old else ''}"
                f" · 音频:{'有' if s.get('audio') else '无'}")
        quality = None
        if s.get("csv"):
            try:
                qr = httpx.get(
                    f"{FASTAPI_BASE_URL}/api/recordings/quality/{sid}", timeout=15)
                if qr.status_code == 200:
                    quality = qr.json().get("quality")
            except Exception:
                pass
        blocks.append(head + "\n" + _quality_line(sid, quality))
    return (f"患者 {patient_id} 最近 {len(blocks)} 条录音 (质量摘要, 引用数值前"
            f"注意可疑通道标记):\n" + "\n".join(blocks))


def augment_workflow_inputs(spec, inputs, patient_id):
    """声明了 `patient_recordings` 输入的工作流 → 自动注入该患者录音质量摘要。

    受控开关 (SOD-07 节点轻量原则): 工作流必须在 inputs 里显式声明才拿得到
    传感器数据, 不给所有节点默认加负担。调用方已显式传入时不覆盖。"""
    if "patient_recordings" not in (spec.get("inputs") or []):
        return inputs or {}
    out = dict(inputs or {})
    if not out.get("patient_recordings"):
        out["patient_recordings"] = patient_recordings_block(patient_id)
    return out


def recordings_context_provider():
    """ContextManager provider (Phase 1, gap 6 — quality-aware context):
    每轮注入最近录音的**质量摘要** (时间范围/新鲜度/采样率/可疑通道),
    而非原始 JSON。质量字段由录音服务预计算并缓存, 这里只取现成的。
    录音服务不在线则静默跳过。"""
    try:
        r = httpx.get(f"{FASTAPI_BASE_URL}/api/recordings/list", timeout=3)
        r.raise_for_status()
        sessions = (r.json().get("sessions") or [])
    except Exception:
        return None
    if not sessions:
        return ("最近录音·质量摘要", "(暂无录音)")

    lines = []
    for s in sessions[:3]:
        sid = s.get("id")
        age, is_old = _humanize_age(s.get("started_at_iso"))
        pat = s.get("patient_id") or "未标注患者"
        head = (f"[{sid}] {pat} · {age}{' (旧数据)' if is_old else ''}"
                f" · 音频:{'有' if s.get('audio') else '无'}")
        quality = None
        if s.get("csv"):
            try:
                qr = httpx.get(
                    f"{FASTAPI_BASE_URL}/api/recordings/quality/{sid}", timeout=15)
                if qr.status_code == 200:
                    quality = qr.json().get("quality")
            except Exception:
                pass
        lines.append(head + "\n" + _quality_line(sid, quality))

    more = len(sessions) - 3
    if more > 0:
        lines.append(f"(还有 {more} 条, 用 list_recordings 查看)")
    lines.append("详情/逐通道统计用 read_recording(session_id); "
                 "带 head 参数可看原始行。引用数值前先核对可疑通道标记。")
    return ("最近录音·质量摘要", "\n".join(lines))
