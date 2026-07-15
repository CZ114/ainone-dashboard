"""authz — M2 后端强制层: 签名 token + 角色×前缀策略表 (fail-closed)。

M1 的前端隐藏只防误触; 这里才是门 —— 绕过 UI 直接 curl 也会被拒。

Token: base64url(json{role,id,name,exp}).hmac_sha256 —— 服务端密钥签名,
客户端只能持有不能伪造。密钥持久化在 data/agent_service/auth_secret
(首启随机生成), node 网关读同一文件做同源校验, 两端策略同一事实源。

角色解析规则:
- 无 token 请求 = patient 档 (最低权)。刻意如此: 日记网关等机器调用
  只打消费面端点 (oneshot/compat/voice), 按最低权放行即可不受影响。
- 带 token 且验签通过 = token 里的角色。验签失败 = 401 (给前端登出信号)。

策略表: 顺序匹配, 首条命中生效; 全表不中 = fail-closed 仅 developer。
新端点忘登记时宁可误伤开发者, 也不放行患者。

诚实边界: :8080 传感器后端是原版代码 (用户明确不动), 未纳入本策略;
它已绑 127.0.0.1, 局域网不可达, 但本机进程仍可直连 — 记录在案。
"""

import base64
import hashlib
import hmac
import json
import logging
import re
import secrets as _secrets
import time

from .config import DATA_DIR

logger = logging.getLogger(__name__)

SECRET_PATH = DATA_DIR / "auth_secret"
TOKEN_TTL_S = 12 * 3600          # 12h — 单机场景够一整天门诊, 过期重登

_audit_path = DATA_DIR / "authz_audit.jsonl"


def _load_secret() -> bytes:
    """密钥懒加载 + 首启生成。文件共享给 node 网关 (同仓库同机)。"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not SECRET_PATH.exists():
        SECRET_PATH.write_text(_secrets.token_hex(32), encoding="ascii")
        logger.info("authz: generated new auth secret at %s", SECRET_PATH)
    return SECRET_PATH.read_text(encoding="ascii").strip().encode("ascii")


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64d(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def mint_token(who: dict) -> str:
    """{role,id,name} → 签名 token (exp 由服务端定)。"""
    payload = {**who, "exp": time.time() + TOKEN_TTL_S}
    body = _b64e(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
    sig = _b64e(hmac.new(_load_secret(), body.encode("ascii"),
                         hashlib.sha256).digest())
    return f"{body}.{sig}"


def verify_token(token: str) -> dict | None:
    """token → {role,id,name} | None (验签失败/过期/畸形)。"""
    try:
        body, sig = token.split(".", 1)
        want = _b64e(hmac.new(_load_secret(), body.encode("ascii"),
                              hashlib.sha256).digest())
        if not hmac.compare_digest(sig, want):
            return None
        payload = json.loads(_b64d(body))
        if payload.get("exp", 0) < time.time():
            return None
        if payload.get("role") not in ("patient", "doctor", "developer"):
            return None
        return payload
    except Exception:
        return None


# ─── 策略表 ──────────────────────────────────────────────────────────
# (methods | None=全部, path regex, allowed roles)。顺序匹配首条生效。
# 镜像自 frontend/src/lib/rolePolicy.ts — 两表同改, About 页留了说明。

PATIENT = ("patient", "doctor", "developer")
STAFF = ("doctor", "developer")
DEV = ("developer",)

POLICY: list[tuple[frozenset[str] | None, re.Pattern, tuple[str, ...]]] = [
    # 公共: 登录本身
    (None, re.compile(r"^/api/agent/auth/login$"), PATIENT),

    # ── 消费面 (患者档即可) ──
    (None, re.compile(r"^/api/compat/"), PATIENT),
    (None, re.compile(r"^/api/agent/(chat|permission|abort|voice|oneshot)"), PATIENT),
    (None, re.compile(r"^/api/agent/sessions"), PATIENT),          # 历史读/清空 (owner 过滤是 M3)
    ({"GET"}, re.compile(r"^/api/agent/workflow-runs/active"), PATIENT),  # 照护丝带轮询
    ({"POST"}, re.compile(r"^/api/agent/workflows/input$"), PATIENT),     # human 问题卡作答

    # ── 医生档 ──
    ({"GET"}, re.compile(r"^/api/agent/(health|config)$"), STAFF),
    ({"GET"}, re.compile(r"^/api/agent/workflows"), STAFF),
    ({"POST"}, re.compile(r"^/api/agent/workflows/[^/]+/(run|stream)$"), STAFF),
    ({"GET"}, re.compile(r"^/api/agent/workflow-runs"), STAFF),
    ({"GET"}, re.compile(r"^/api/agent/(agents|skills)"), STAFF),  # 只读: 聊天选 agent / 浏览技能
    ({"GET", "POST"}, re.compile(r"^/api/agent/rag/(collections|search|ingest)"), STAFF),
    (None, re.compile(r"^/api/agent/patients"), STAFF),            # 病人档案工作台

    # ── 开发者档 (显式列出高危, 也被 fail-closed 兜底) ──
    (None, re.compile(r"^/api/agent/mcp"), DEV),                   # stdio=RCE 级
    (None, re.compile(r"^/api/agent/(agents|skills|workflows)"), DEV),  # 写删测
    (None, re.compile(r"^/api/agent/(config|models)"), DEV),       # PATCH 路由/拉模型
    (None, re.compile(r"^/api/agent/rag/"), DEV),                  # DELETE 整库等
    (None, re.compile(r"^/api/agent/workflow-runs/"), DEV),        # DELETE 审计记录
]


def allowed_roles(method: str, path: str) -> tuple[str, ...]:
    for methods, pattern, roles in POLICY:
        if methods is not None and method not in methods:
            continue
        if pattern.match(path):
            return roles
    return DEV     # fail-closed: 没登记的端点只有 developer 能碰


def audit(role: str, uid: str, method: str, path: str, status: int) -> None:
    """写操作审计行 (谁/何时/动了什么/放行与否)。best-effort, 不阻塞请求。"""
    try:
        with _audit_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps({
                "ts": time.time(), "role": role, "id": uid,
                "method": method, "path": path, "status": status,
            }, ensure_ascii=False) + "\n")
    except OSError:
        pass
