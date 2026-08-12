"""agent_service — 自研 Agent 的 HTTP 服务 (FastAPI, :8100)。

端点分两组:
- /api/agent/*  : SOD 03 的中立协议 (oneshot 给日记网关, chat 给未来新前端)
- /api/compat/* : 原前端 claude_json 兼容协议 (agent_gateway 纯透传给 React chat 页)

同步 Agent → 异步 HTTP 的桥接: 每个 chat 请求起一个 worker 线程跑 agent.stream(),
事件经 queue 流出; 权限审批经 PermissionBroker 阻塞工具线程等前端 POST;
abort 置 Event, worker 在事件边界退出并修补历史。
"""

import hmac
import json
import os
import queue
import re
import threading
import time
import uuid

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from agent.orchestration import Workflow, WorkflowError

from datetime import datetime

from . import (agents_admin, authdb, authz, config_store, mcp_admin, rag,
               run_history, skills_admin, workflows_admin)
from .agent_tools import build_registry
from .bridge import AbortRegistry, PermissionBroker, human_inputs
from .config import PERMISSION_TIMEOUT_S, REPO_ROOT
from .factory import (build_client, build_oneshot_agent, resolve_agent_config,
                      tracking_build_agent)
from .sessions import SessionManager, repair_history
from .wire import iter_strip_think, new_stream_ctx, serialize, strip_think

HUMAN_INPUT_TIMEOUT_S = 600  # workflow human 步骤等真人回答的上限

app = FastAPI(title="agent_service", version="0.1.0")

broker = PermissionBroker()
aborts = AbortRegistry()
manager = SessionManager()
authdb.init_db()   # 本地身份库 patients.db (建表 + 首启 seed 演示账号)
workflows_admin.ensure_seed()   # 确保 followup_review (照护丝带数据源) 存在
# human_inputs 单例已移至 bridge.py (run_workflow 工具与端点共用)


# ─── M2 authz 中间件 ─────────────────────────────────────────────────
# M1 的前端隐藏只防误触; 这里对每个请求做角色×策略表校验 (fail-closed)。
# 凭据三选一: X-Auth-Token (登录签发) / X-Service-Key (网关内部调用,
# 值=auth_secret 文件内容) / 无凭据=patient 最低档。

# 消费面高频端点不写审计 (聊天流/轮询会刷爆日志), 只审计管理面写操作
_AUDIT_EXEMPT = re.compile(
    r"^/api/(compat/|agent/(chat|permission|abort|voice|oneshot|auth/login"
    r"|workflows/input|sessions))")


@app.middleware("http")
async def authz_middleware(request: Request, call_next):
    path = request.url.path
    method = request.method
    if method == "OPTIONS" or not path.startswith("/api/"):
        return await call_next(request)

    # 1) 凭据 → 角色
    service_key = request.headers.get("x-service-key")
    token = request.headers.get("x-auth-token") or (
        request.headers.get("authorization") or "").removeprefix("Bearer ").strip()
    if service_key and hmac.compare_digest(
            service_key, authz._load_secret().decode("ascii")):
        role, uid = "developer", "gateway"      # 持密钥文件者本就拥有本机
    elif token:
        who = authz.verify_token(token)
        if who is None:
            # 过期/伪造给 401 而非降档 — 前端据此登出重登, 不静默变患者
            return JSONResponse({"detail": "token 无效或已过期, 请重新登录"},
                                status_code=401)
        role, uid = who["role"], who["id"]
    else:
        role, uid = "patient", "anonymous"      # 机器调用按最低权放行消费面

    # 2) 策略表
    roles = authz.allowed_roles(method, path)
    if role not in roles:
        authz.audit(role, uid, method, path, 403)
        return JSONResponse(
            {"detail": f"此操作需要 {'/'.join(roles)} 角色 (当前: {role})",
             "requiredRole": list(roles)},
            status_code=403)

    # 3) 患者档字段级钳制: oneshot/voice 剥离系统提示覆盖 (提示注入面)。
    #    日记网关带 X-Service-Key 不受影响; call 页经网关透传同理。
    if role == "patient" and method == "POST" and path in (
            "/api/agent/oneshot", "/api/agent/voice"):
        raw = await request.body()
        try:
            data = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            data = None
        if isinstance(data, dict) and ("systemPrompt" in data or "system" in data):
            data.pop("systemPrompt", None)
            data.pop("system", None)
            new_body = json.dumps(data).encode("utf-8")

            async def receive():
                return {"type": "http.request", "body": new_body,
                        "more_body": False}
            request = Request(request.scope, receive)
        elif raw:
            # body 已被消费, 必须原样回填, 否则下游 handler 读到空
            async def receive():
                return {"type": "http.request", "body": raw,
                        "more_body": False}
            request = Request(request.scope, receive)

    # 身份挂到 request.state, 供下游端点做数据级归属过滤 (M3)。scope 复用,
    # 即使上面重建过 request, state 仍在同一 scope 里。
    request.state.user_info = {"role": role, "id": uid}
    response = await call_next(request)

    # 4) 管理面写操作审计 (谁/何时/动了什么/结果)
    if method in ("POST", "PUT", "PATCH", "DELETE") and not _AUDIT_EXEMPT.match(path):
        authz.audit(role, uid, method, path, response.status_code)
    return response


# ─── 请求模型 ────────────────────────────────────────────────────────

class ChatBody(BaseModel):
    message: str
    requestId: str | None = None
    sessionId: str | None = None
    agentId: str | None = None
    patientId: str | None = None   # for-whom 患者 (医生切换"当前患者"后新会话带上, 记归属)


class PermissionBody(BaseModel):
    id: str
    decision: str | dict     # neutral: "allow"/"deny"; compat: {behavior, message?}
    message: str | None = None


class OneshotBody(BaseModel):
    message: str
    agentId: str | None = None
    systemPrompt: str | None = None
    lang: str | None = None


class ResetBody(BaseModel):
    scope: str = "messages"


class ConfigPatchBody(BaseModel):
    provider: str | None = None
    model: str | None = None
    temperature: float | None = None
    embedder: str | None = None


class AgentUpsertBody(BaseModel):
    name: str | None = None
    description: str | None = None
    provider: str | None = None
    model: str | None = None
    system_prompt: str | None = None
    sampling: dict | None = None
    retrieval: dict | None = None
    env: dict | None = None


class AgentTestBody(BaseModel):
    message: str | None = None


class CollectionBody(BaseModel):
    name: str
    embedder: str | None = None


class IngestDoc(BaseModel):
    source: str
    text: str


class IngestBody(BaseModel):
    collection: str
    documents: list[IngestDoc]


class RagSearchBody(BaseModel):
    collection: str
    query: str
    top_k: int = 5


class WorkflowUpsertBody(BaseModel):
    name: str | None = None
    description: str | None = None
    inputs: list[str] | None = None
    output: str | None = None
    steps: list[dict]


class WorkflowRunBody(BaseModel):
    inputs: dict = {}
    patientId: str | None = None   # 医生为哪个患者跑 (照护丝带归属)


class WorkflowInputBody(BaseModel):
    id: str
    value: str


class McpUpsertBody(BaseModel):
    transport: str
    command: str | None = None
    url: str | None = None
    enabled: bool = True


class SkillUpsertBody(BaseModel):
    description: str = ""
    body: str


class VoiceBody(BaseModel):
    message: str
    history: list[dict] = []
    system: str | None = None


# ─── 归属过滤 helper (M3) ────────────────────────────────────────────

def _owner_filter(request: Request) -> str | None:
    """患者 → 自己的 id (只见自己的数据); 医生/开发者 → None (见全部)。"""
    ui = getattr(request.state, "user_info", {})
    return ui.get("id") if ui.get("role") == "patient" else None


# ─── chat 流核心 (neutral 与 compat 共用) ────────────────────────────

def _chat_response(body: ChatBody, fmt: str, owner: str | None = None) -> StreamingResponse:
    try:
        # compat: 前端新会话带临时 id ("new-session-*"), 未知 id 视为新建
        session_id, entry = manager.get_or_create(
            body.sessionId, body.agentId, create_if_missing=(fmt == "compat"),
            owner=owner, patient_id=body.patientId)
    except KeyError as e:
        raise HTTPException(404, str(e))
    except NotImplementedError as e:
        raise HTTPException(501, str(e))

    if not entry.lock.acquire(blocking=False):
        raise HTTPException(409, f"session {session_id} 有进行中的请求")

    request_id = body.requestId or uuid.uuid4().hex[:12]
    abort_ev = aborts.register(request_id)
    q: queue.Queue = queue.Queue()
    agent = entry.agent
    worker_started = False

    def approval_cb(name, args, tcid):
        p = broker.create(request_id, name, args, tcid)
        q.put(("permission_request",
               {"id": p.id, "toolName": name, "input": args, "toolUseId": tcid}))
        return broker.wait(p, PERMISSION_TIMEOUT_S)

    agent.approval_callback = approval_cb  # entry.lock 保证同一时刻只有一个请求在写

    def worker():
        try:
            for kind, payload in agent.stream(body.message):
                if abort_ev.is_set():
                    repair_history(agent)
                    q.put(("aborted", None))
                    return
                q.put((kind, payload))
        except Exception as e:
            q.put(("error", f"{type(e).__name__}: {e}"))
        finally:
            entry.last_active = time.time()
            entry.lock.release()
            aborts.unregister(request_id)
            q.put(("__end__", None))

    def gen():
        nonlocal worker_started
        ctx = new_stream_ctx(
            session_id, agent.client.model,
            [t["name"] for t in agent.registry.list_tools()],
        )
        try:
            yield from serialize("session", None, ctx, fmt)
            threading.Thread(target=worker, daemon=True, name=f"chat-{request_id}").start()
            worker_started = True
            while True:
                try:
                    kind, payload = q.get(timeout=0.5)
                except queue.Empty:
                    # worker 卡在 LLM 调用里收不到事件时, abort 也要能即时回给前端
                    if abort_ev.is_set():
                        yield from serialize("aborted", None, ctx, fmt)
                        return
                    continue
                if kind == "__end__":
                    return
                yield from serialize(kind, payload, ctx, fmt)
                if kind == "aborted":
                    return
        finally:
            if not worker_started:
                entry.lock.release()
                aborts.unregister(request_id)
            # 无论流怎么断, 挂起的审批都解除, 防工具线程滞留到超时
            broker.deny_all_for_request(request_id, reason="连接已断开或请求中止")

    return StreamingResponse(gen(), media_type="application/x-ndjson")


def _resolve_permission(body: PermissionBody):
    if isinstance(body.decision, dict):   # compat: {behavior: "allow"|"deny", message?}
        approved = body.decision.get("behavior") == "allow"
        reason = body.decision.get("message") or ""
    else:                                 # neutral: "allow"|"deny"
        approved = body.decision == "allow"
        reason = body.message or ""
    ok = broker.resolve(body.id, approved, reason)
    return {"ok": ok}


# ─── neutral 端点 (/api/agent/*) ─────────────────────────────────────

@app.post("/api/agent/chat")
def agent_chat(body: ChatBody, request: Request):
    owner = getattr(request.state, "user_info", {}).get("id")
    return _chat_response(body, "neutral", owner)


@app.post("/api/agent/permission")
def agent_permission(body: PermissionBody):
    return _resolve_permission(body)


@app.post("/api/agent/abort/{request_id}")
def agent_abort(request_id: str):
    ok = aborts.abort(request_id)
    broker.deny_all_for_request(request_id)
    return {"ok": ok}


@app.post("/api/agent/oneshot")
def agent_oneshot(body: OneshotBody):
    try:
        agent = build_oneshot_agent(body.agentId, body.systemPrompt)
    except KeyError as e:
        raise HTTPException(404, str(e))
    except NotImplementedError as e:
        raise HTTPException(501, str(e))
    started = time.time()
    text = strip_think(agent.send(body.message))
    return {
        "text": text,
        "model": agent.client.model,
        "provider": agent.client.provider,
        "duration_ms": int((time.time() - started) * 1000),
    }


@app.get("/api/agent/sessions")
def agent_sessions(request: Request):
    return {"sessions": manager.list_sessions(_owner_filter(request))}


@app.get("/api/agent/sessions/{session_id}/messages")
def agent_session_messages(session_id: str, request: Request):
    ui = getattr(request.state, "user_info", {})
    if ui.get("role") == "patient" and manager.owner_of(session_id) != ui.get("id"):
        raise HTTPException(403, "无权访问此会话")
    try:
        return {"messages": manager.read_messages(session_id)}
    except KeyError as e:
        raise HTTPException(404, str(e))


@app.post("/api/agent/sessions/{session_id}/reset")
def agent_session_reset(session_id: str, body: ResetBody):
    try:
        manager.reset(session_id, body.scope)
    except KeyError as e:
        raise HTTPException(404, str(e))
    return {"ok": True}


@app.get("/api/agent/health")
def agent_health():
    cfg = config_store.load()
    return {
        "ok": True,
        "provider": cfg["provider"],
        "model": cfg["model"],
        "tools": [t["name"] for t in build_registry().list_tools()],
    }


# ─── 身份与病人档案 (M1: 本地库 patients.db) ─────────────────────────
# 诚实边界: M1 只提供"登录校验 + 档案 CRUD"的事实, 这些端点本身尚无
# HTTP 层鉴权 (前端隐藏只防误触); M2 的 authz 中间件才是真正的门。

class LoginBody(BaseModel):
    id: str                     # 患者编号 P-xxx 或 staff 用户名
    code: str                   # 配对码 / 密码


class PatientBody(BaseModel):
    name: str
    age: int | None = None
    complaint: str = ""
    device: str = ""
    createdBy: str = ""


class PatientPatchBody(BaseModel):
    name: str | None = None
    age: int | None = None
    complaint: str | None = None
    device: str | None = None


@app.post("/api/agent/auth/login")
def auth_login(body: LoginBody):
    who = authdb.login(body.id, body.code)
    if who is None:
        raise HTTPException(401, "编号/用户名或口令不正确")
    # M2: 附签名 token — 前端每个 /api 请求带上, 中间件据此定角色。
    return {"ok": True, **who, "token": authz.mint_token(who)}


@app.get("/api/agent/patients")
def patients_list():
    return {"patients": authdb.list_patients()}


@app.post("/api/agent/patients")
def patients_create(body: PatientBody):
    if not body.name.strip():
        raise HTTPException(422, "姓名不能为空")
    created = authdb.create_patient(
        body.name.strip(), body.age, body.complaint, body.device, body.createdBy)
    # pair_code 明文只出现在这一次响应里 (医生抄给病人), 库里只存哈希
    return {"ok": True, **created}


@app.patch("/api/agent/patients/{pid}")
def patients_update(pid: str, body: PatientPatchBody):
    if not authdb.update_patient(pid, body.model_dump()):
        raise HTTPException(404, f"未知病人: {pid}")
    return {"ok": True}


@app.post("/api/agent/patients/{pid}/reset-code")
def patients_reset_code(pid: str):
    reset = authdb.reset_pair_code(pid)
    if reset is None:
        raise HTTPException(404, f"未知病人: {pid}")
    return {"ok": True, **reset}


# ─── 模型服务商路由 (设置页) ─────────────────────────────────────────

def _provider_catalog():
    """agent 库 PROVIDERS 表 + 本机 key 可用性 (含 config.py 的命名映射后)。"""
    from agent.core import llm
    out = []
    for name, (key_envs, base_url, default_model) in llm.PROVIDERS.items():
        if name == "custom":
            key_present = bool(os.getenv("LLM_BASE_URL"))
        elif name == "ollama":
            key_present = True  # 本地服务不验 key
        else:
            # 只认专属 key — LLM_API_KEY 是全局兜底, 拿来标"可用"会全绿误导
            key_present = bool(llm._first_env(*key_envs))
        out.append({
            "name": name,
            "keyEnvs": list(key_envs),
            "keyPresent": key_present,
            "defaultModel": default_model,
            "baseUrl": base_url,
        })
    return out


@app.get("/api/agent/config")
def get_config():
    return {"config": config_store.load(), "providers": _provider_catalog()}


@app.patch("/api/agent/config")
def patch_config(body: ConfigPatchBody):
    saved = config_store.save(body.model_dump(exclude_none=True))
    return {"config": saved, "providers": _provider_catalog()}


@app.get("/api/agent/models")
def list_models(provider: str | None = None):
    """向服务商实时拉模型列表 (OpenAI 兼容 GET /models)。失败给 502, UI 回退手填。"""
    from agent.core import llm
    p = (provider or config_store.load()["provider"]).lower()
    if p not in llm.PROVIDERS:
        raise HTTPException(404, f"未知 provider: {p}")
    key_envs, base_url, _ = llm.PROVIDERS[p]
    if p == "custom":
        base_url = os.getenv("LLM_BASE_URL")
    api_key = llm._first_env(*key_envs, "LLM_API_KEY") or ("ollama" if p == "ollama" else None)
    if not base_url or not api_key:
        raise HTTPException(400, f"provider '{p}' 缺 key 或 base_url, 无法拉模型列表")
    try:
        r = httpx.get(f"{base_url.rstrip('/')}/models", timeout=10,
                      headers={"Authorization": f"Bearer {api_key}"})
        r.raise_for_status()
        ids = sorted(m.get("id", "") for m in r.json().get("data", []) if m.get("id"))
    except Exception as e:
        raise HTTPException(502, f"拉取模型列表失败 ({p}): {type(e).__name__}: {e}")
    return {"provider": p, "models": ids}


# ─── multi-agent 配置 (设置页 Agents tab; 与日记共享 agents.json) ────

@app.get("/api/agent/agents")
def agents_list():
    return {"agents": agents_admin.list_agents(config_store.load())}


@app.put("/api/agent/agents/{agent_id}")
def agents_upsert(agent_id: str, body: AgentUpsertBody):
    try:
        return {"agent": agents_admin.upsert_agent(agent_id, body.model_dump(exclude_none=True))}
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.delete("/api/agent/agents/{agent_id}")
def agents_delete(agent_id: str):
    try:
        agents_admin.delete_agent(agent_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except KeyError as e:
        raise HTTPException(404, str(e))
    return {"ok": True}


@app.post("/api/agent/agents/{agent_id}/test")
def agents_test(agent_id: str, body: AgentTestBody):
    """跑一次最小 oneshot 验证该 agent 配置可用 (对齐日记的 test 端点语义)。"""
    started = time.time()
    try:
        agent = build_oneshot_agent(agent_id)
        text = agent.send(body.message or "用一句话介绍你自己。")
    except KeyError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        return {"ok": False, "latency_ms": int((time.time() - started) * 1000),
                "error": f"{type(e).__name__}: {e}"}
    return {
        "ok": True,
        "latency_ms": int((time.time() - started) * 1000),
        "model": agent.client.model,
        "provider": agent.client.provider,
        "sample": (text or "")[:300],
    }


# ─── 语音通话 (call 页, SOD M4) ──────────────────────────────────────
# 延迟敏感: AgentDeploy.think() 纯文本流式、无工具、无会话 (历史由前端每轮带上,
# 对齐原 voice_chat 的直连语义)。线协议: {type: delta|done|error(message)}。

DEFAULT_VOICE_PROMPT = (
    "You are talking with the user over a voice interface. Speak naturally — "
    "like a person, not a search engine. Match the depth of the question: a "
    "casual greeting deserves a casual reply; a technical question deserves a "
    "thorough answer. Use markdown structure (lists, tables) only when it "
    "materially helps clarity. Reply in the user's language (中文用户用中文)."
)


@app.post("/api/agent/voice")
def agent_voice(body: VoiceBody):
    cfg = resolve_agent_config(None)   # 跟随设置页的模型路由
    client = build_client(cfg)
    messages = [{"role": "system", "content": body.system or DEFAULT_VOICE_PROMPT}]
    for m in body.history:
        if (m.get("role") in ("user", "assistant")
                and isinstance(m.get("content"), str) and m["content"]):
            messages.append({"role": m["role"], "content": m["content"]})
    messages.append({"role": "user", "content": body.message})

    def gen():
        try:
            # iter_strip_think: 推理模型的 <think> 块在语音场景整段吞掉
            # (没人想听 TTS 朗读推理过程; 代价是开头多等一会儿)
            for piece in iter_strip_think(client.think(messages, max_tokens=1024)):
                yield json.dumps({"type": "delta", "text": piece},
                                 ensure_ascii=False) + "\n"
            yield json.dumps({"type": "done"}) + "\n"
        except Exception as e:
            yield json.dumps({"type": "error",
                              "message": f"{type(e).__name__}: {e}"},
                             ensure_ascii=False) + "\n"

    return StreamingResponse(gen(), media_type="application/x-ndjson")


# ─── multi-agent 工作流 (声明式编排, agent.orchestration) ────────────

def _known_agent_ids():
    return {a["id"] for a in agents_admin.list_agents(config_store.load())} | {"diary_observer"}


@app.get("/api/agent/workflows")
def workflows_list():
    return {"workflows": workflows_admin.list_workflows()}


@app.get("/api/agent/workflows/{wf_id}")
def workflows_get(wf_id: str):
    try:
        return {"workflow": workflows_admin.get_workflow(wf_id)}
    except KeyError as e:
        raise HTTPException(404, str(e))


@app.put("/api/agent/workflows/{wf_id}")
def workflows_upsert(wf_id: str, body: WorkflowUpsertBody):
    try:
        spec = workflows_admin.upsert_workflow(
            wf_id, body.model_dump(exclude_none=True), _known_agent_ids())
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"workflow": spec}


@app.delete("/api/agent/workflows/{wf_id}")
def workflows_delete(wf_id: str):
    try:
        workflows_admin.delete_workflow(wf_id)
    except KeyError as e:
        raise HTTPException(404, str(e))
    return {"ok": True}


def _load_workflow_or_404(wf_id: str) -> Workflow:
    try:
        return Workflow(workflows_admin.get_workflow(wf_id))
    except KeyError as e:
        raise HTTPException(404, str(e))
    except WorkflowError as e:
        raise HTTPException(400, str(e))


@app.post("/api/agent/workflows/{wf_id}/run")
def workflows_run(wf_id: str, body: WorkflowRunBody):
    """阻塞跑完, 返回 {output, context, trace}。节点 = oneshot agent
    (无文件工具; 挂了知识库的节点自动有 retrieve)。"""
    wf = _load_workflow_or_404(wf_id)
    started = time.time()
    try:
        result = wf.run_sync(body.inputs, build_agent=build_oneshot_agent)
    except WorkflowError as e:
        raise HTTPException(400, str(e))
    result["elapsed_ms"] = int((time.time() - started) * 1000)
    return result


@app.post("/api/agent/workflows/{wf_id}/stream")
def workflows_stream(wf_id: str, body: WorkflowRunBody, request: Request):
    """NDJSON 事件流: workflow_start|step_start|step_end|loop_iter|loop_break|
    route_choice|human_ask|human_input_required|workflow_end|error。

    human 步骤: 引擎在 worker 线程里跑, ask_human 先把 human_input_required
    (含 input_id) 推进流, 再阻塞等 POST /api/agent/workflows/input 唤醒
    (与 chat 权限桥同构; 超时 {HUMAN_INPUT_TIMEOUT_S}s = 终止工作流)。

    每次运行全程记录并落盘 (run_history) — 聊天页工作流面板的历史回看数据源。
    """
    wf = _load_workflow_or_404(wf_id)
    q: queue.Queue = queue.Queue()
    # run owner = 发起者 id; patient_id = 服务对象 (医生为谁跑, 照护丝带按它查)。
    _run_owner = getattr(request.state, "user_info", {}).get("id")
    handle = run_history.start_run(
        wf_id, wf.spec.get("name") or wf_id, body.inputs, _run_owner,
        patient_id=body.patientId)

    def ask_human(prompt: str) -> str:
        p = human_inputs.create()
        q.put(("human_input_required", {"input_id": p.id, "prompt": prompt}))
        value = human_inputs.wait(p, HUMAN_INPUT_TIMEOUT_S)
        if value is None:
            raise WorkflowError(f"等待人工输入超时 ({HUMAN_INPUT_TIMEOUT_S}s)")
        return value

    def _emit_ref(ev: dict):
        ev = dict(ev)
        q.put((ev.pop("type"), ev))

    def worker():
        try:
            for kind, payload in wf.run(body.inputs,
                                        build_agent=tracking_build_agent(_emit_ref),
                                        ask_human=ask_human):
                q.put((kind, payload))
        except WorkflowError as e:
            q.put(("error", {"error": str(e)}))
        except Exception as e:
            q.put(("error", {"error": f"{type(e).__name__}: {e}"}))
        finally:
            q.put(("__end__", None))

    def gen():
        threading.Thread(target=worker, daemon=True,
                         name=f"workflow-{wf_id}").start()
        try:
            while True:
                kind, payload = q.get()
                if kind == "__end__":
                    return
                event = {"type": kind, **(payload or {})}
                if kind == "workflow_start":
                    event["run_id"] = handle.run_id   # 前端据此关联历史记录
                handle.add_event(event)   # 活跃追踪 + 归档共用一份
                yield json.dumps(event, ensure_ascii=False, default=str) + "\n"
        finally:
            # 正常结束/客户端断开统一走这里; finish 幂等, 按事件判定状态归档
            handle.finish()

    return StreamingResponse(gen(), media_type="application/x-ndjson")


# ─── workflow 运行历史 (reference 记录 / 结果回看) ───────────────────
# 注意路径避开 /api/agent/workflows/{wf_id} 的通配

@app.get("/api/agent/workflow-runs")
def workflow_runs_list(request: Request, limit: int = 30):
    return {"runs": run_history.list_runs(max(1, min(limit, 100)), _owner_filter(request))}


@app.get("/api/agent/workflow-runs/active")
def workflow_runs_active(request: Request):
    """进行中的运行 (含聊天 agent 经 run_workflow 工具启动的) — 面板轮询用。"""
    return {"active": run_history.list_active(_owner_filter(request))}


@app.get("/api/agent/care-ribbon")
def care_ribbon(request: Request):
    """患者照护丝带: 为该患者跑的 workflow 的 labels.patient 步骤叙事。
    患者查自己 (token id); staff 可 ?patient_id= 查某患者。"""
    ui = getattr(request.state, "user_info", {})
    pid = (ui.get("id") if ui.get("role") == "patient"
           else request.query_params.get("patient_id"))
    return run_history.care_ribbon_for(pid or "")


@app.get("/api/agent/workflow-runs/active/{run_id}")
def workflow_runs_active_get(run_id: str):
    try:
        return {"run": run_history.get_active(run_id)}
    except KeyError as e:
        raise HTTPException(404, str(e))


@app.get("/api/agent/workflow-runs/{run_id}")
def workflow_runs_get(run_id: str):
    try:
        return {"run": run_history.read_run(run_id)}
    except KeyError as e:
        raise HTTPException(404, str(e))


@app.delete("/api/agent/workflow-runs/{run_id}")
def workflow_runs_delete(run_id: str):
    try:
        run_history.delete_run(run_id)
    except KeyError as e:
        raise HTTPException(404, str(e))
    return {"ok": True}


@app.post("/api/agent/workflows/input")
def workflows_input(body: WorkflowInputBody):
    """human_input_required 的回填端点。"""
    return {"ok": human_inputs.resolve(body.id, body.value)}


# ─── MCP 工具源 (Agents tab 分节; SOD 07 §3) ─────────────────────────

@app.get("/api/agent/mcp")
def mcp_list():
    return {"servers": mcp_admin.list_servers()}


@app.put("/api/agent/mcp/{name}")
def mcp_upsert(name: str, body: McpUpsertBody):
    try:
        return {"server": mcp_admin.upsert_server(name, body.model_dump())}
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.delete("/api/agent/mcp/{name}")
def mcp_delete(name: str):
    try:
        mcp_admin.delete_server(name)
    except KeyError as e:
        raise HTTPException(404, str(e))
    return {"ok": True}


@app.post("/api/agent/mcp/{name}/test")
def mcp_test(name: str):
    try:
        return mcp_admin.test_server(name)
    except KeyError as e:
        raise HTTPException(404, str(e))


# ─── Skills 技能库 (Knowledge tab 分节; SOD 07 §4) ───────────────────

@app.get("/api/agent/skills")
def skills_list():
    return {"skills": skills_admin.list_skills()}


@app.get("/api/agent/skills/{name}")
def skills_get(name: str):
    try:
        return {"skill": skills_admin.get_skill(name)}
    except KeyError as e:
        raise HTTPException(404, str(e))


@app.put("/api/agent/skills/{name}")
def skills_upsert(name: str, body: SkillUpsertBody):
    try:
        return {"skill": skills_admin.upsert_skill(name, body.description, body.body)}
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.delete("/api/agent/skills/{name}")
def skills_delete(name: str):
    try:
        skills_admin.delete_skill(name)
    except KeyError as e:
        raise HTTPException(404, str(e))
    return {"ok": True}


# ─── RAG 管理 (SOD 04 预留已兑现) ────────────────────────────────────

@app.get("/api/agent/rag/collections")
def rag_collections():
    return {"collections": rag.list_collections()}


@app.post("/api/agent/rag/collections")
def rag_create_collection(body: CollectionBody):
    try:
        col = rag.create_collection(
            body.name, body.embedder or config_store.load()["embedder"])
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"collection": col}


@app.delete("/api/agent/rag/collections/{name}")
def rag_delete_collection(name: str):
    try:
        rag.delete_collection(name)
    except Exception as e:
        raise HTTPException(404, f"删除失败: {e}")
    return {"ok": True}


@app.post("/api/agent/rag/ingest")
def rag_ingest(body: IngestBody):
    """切块→嵌入→入库。首次调用会加载 embedding 模型 (bge-m3, 可能要几十秒)。"""
    try:
        result = rag.ingest(
            body.collection,
            [d.model_dump() for d in body.documents],
            config_store.load()["embedder"],
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"ingest 失败: {type(e).__name__}: {e}")
    return result


@app.post("/api/agent/rag/search")
def rag_search(body: RagSearchBody):
    try:
        hits = rag.search(body.collection, body.query, body.top_k,
                          config_store.load()["embedder"])
    except Exception as e:
        raise HTTPException(500, f"检索失败: {type(e).__name__}: {e}")
    return {"hits": hits}


# ─── compat 端点 (/api/compat/*, 供 agent_gateway 透传) ──────────────

@app.post("/api/compat/chat")
def compat_chat(body: ChatBody, request: Request):
    owner = getattr(request.state, "user_info", {}).get("id")
    return _chat_response(body, "compat", owner)


@app.post("/api/compat/chat/permission")
def compat_permission(body: PermissionBody):
    return _resolve_permission(body)


@app.post("/api/compat/abort/{request_id}")
def compat_abort(request_id: str):
    return agent_abort(request_id)


def _first_content(messages, role):
    for m in messages:
        if m.get("role") == role and isinstance(m.get("content"), str) and m["content"]:
            return m["content"]
    return ""


@app.get("/api/compat/sessions")
def compat_sessions(request: Request):
    """前端 sidebar 的 SessionSummary shape。"""
    out = []
    for meta in manager.list_sessions(_owner_filter(request)):
        sid = meta["sessionId"]
        try:
            msgs = manager.read_messages(sid)
        except (KeyError, ValueError):
            continue
        chat_msgs = [m for m in msgs if m.get("role") in ("user", "assistant")]
        texts = [m for m in chat_msgs if isinstance(m.get("content"), str) and m["content"]]
        out.append({
            "sessionId": sid,
            "cwd": str(REPO_ROOT),
            "firstMessage": _first_content(msgs, "user"),
            # 摘要是纯文本, 剥掉推理模型的 <think> 块
            "lastMessage": strip_think(texts[-1]["content"]) if texts else "",
            "firstAssistantMessage": strip_think(_first_content(msgs, "assistant")),
            "messageCount": len(chat_msgs),
            "updatedAt": meta["updatedAt"],
            "patientId": meta.get("patientId"),
        })
    return {"sessions": out}


@app.get("/api/compat/sessions/{session_id}/messages")
def compat_session_messages(session_id: str):
    try:
        msgs = manager.read_messages(session_id)
    except KeyError as e:
        raise HTTPException(404, str(e))
    out = [
        {
            "type": "message",
            "role": m["role"],
            # 历史回放是纯文本接口, 画不了思考气泡 — 只回正文
            "content": strip_think(m["content"]) if m["role"] == "assistant" else m["content"],
            "timestamp": m.get("_ts", ""),
        }
        for m in msgs
        if m.get("role") in ("user", "assistant")
        and isinstance(m.get("content"), str) and m["content"]
    ]
    return {"messages": out, "cwd": str(REPO_ROOT)}
