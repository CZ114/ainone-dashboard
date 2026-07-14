"""authdb — 本地身份库 (SQLite, 零外部依赖)。

M1 身份分级的数据面:
- patients 表: 患者账号 (编号 P-xxx + 配对码), 由医生端"新建病人"创建。
  patient_id 是贯穿三端的归属键 (患者登录用它, 医生档案按它组织,
  M3 的会话/日记/运行 owner 过滤也认它)。
- staff 表: 医生/开发者账号 (用户名+密码)。首次启动 seed 演示账号并打日志。

口令存储: sha256(salt + code), 每行独立随机盐。不是对抗级 KDF —— 本地
单机库 + M2 会加 HTTP 层 authz, 这里挡的是"翻到 db 文件直接读出明文"。

并发: 每次操作独立连接 (FastAPI 线程池里最省心的 sqlite 用法, 库很小)。

诚实边界: M1 阶段这些端点本身还没有 HTTP 鉴权 (M2 的 authz 中间件才是门),
本模块只提供"账号是否存在/口令是否正确"的事实。
"""

import hashlib
import logging
import secrets
import sqlite3
import time

from .config import DATA_DIR

logger = logging.getLogger(__name__)

DB_PATH = DATA_DIR / "patients.db"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS patients (
    id          TEXT PRIMARY KEY,          -- P-001 …
    name        TEXT NOT NULL,
    age         INTEGER,
    complaint   TEXT DEFAULT '',           -- 主诉/随访事由 (医生填)
    device      TEXT DEFAULT '',           -- 绑定的采集设备名
    code_salt   TEXT NOT NULL,
    code_hash   TEXT NOT NULL,             -- sha256(salt + 配对码)
    created_by  TEXT DEFAULT '',           -- 建号的 staff 用户名
    created_at  REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS staff (
    username    TEXT PRIMARY KEY,
    role        TEXT NOT NULL CHECK (role IN ('doctor', 'developer')),
    pw_salt     TEXT NOT NULL,
    pw_hash     TEXT NOT NULL,
    created_at  REAL NOT NULL
);
"""


def _hash(salt: str, secret: str) -> str:
    return hashlib.sha256((salt + secret).encode("utf-8")).hexdigest()


def _conn() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    """建表 + 首启 seed 演示账号 (库已有内容则不动)。"""
    with _conn() as conn:
        conn.executescript(_SCHEMA)
        if conn.execute("SELECT COUNT(*) FROM staff").fetchone()[0] == 0:
            for username, role in (("doctor", "doctor"), ("dev", "developer")):
                salt = secrets.token_hex(8)
                conn.execute(
                    "INSERT INTO staff VALUES (?,?,?,?,?)",
                    (username, role, salt, _hash(salt, "1234"), time.time()),
                )
            logger.warning(
                "authdb: seeded demo staff accounts doctor/1234 and dev/1234 "
                "— change these before any multi-user deployment"
            )
        if conn.execute("SELECT COUNT(*) FROM patients").fetchone()[0] == 0:
            for pid, name, age, complaint, device in (
                ("P-001", "陈阿姨", 68, "夜间胸闷 · 呼吸节律随访", "ESP32-A3"),
                ("P-002", "王叔叔", 72, "睡眠呼吸监测", "ESP32-B1"),
            ):
                salt = secrets.token_hex(8)
                conn.execute(
                    "INSERT INTO patients VALUES (?,?,?,?,?,?,?,?,?)",
                    (pid, name, age, complaint, device,
                     salt, _hash(salt, "1234"), "seed", time.time()),
                )
            logger.info("authdb: seeded demo patients P-001/P-002 (配对码 1234)")


# ─── 登录 ────────────────────────────────────────────────────────────

def login(user_id: str, secret: str) -> dict | None:
    """患者编号或 staff 用户名 + 口令 → {role, id, name} | None。

    患者编号统一大写比对 (登录框输 p-001 也认)。
    """
    uid = user_id.strip()
    with _conn() as conn:
        row = conn.execute(
            "SELECT * FROM patients WHERE id = ?", (uid.upper(),)
        ).fetchone()
        if row and _hash(row["code_salt"], secret) == row["code_hash"]:
            return {"role": "patient", "id": row["id"], "name": row["name"]}
        row = conn.execute(
            "SELECT * FROM staff WHERE username = ?", (uid,)
        ).fetchone()
        if row and _hash(row["pw_salt"], secret) == row["pw_hash"]:
            return {"role": row["role"], "id": row["username"],
                    "name": row["username"]}
    return None


# ─── 病人档案 (医生/开发者用) ────────────────────────────────────────

def list_patients() -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT id, name, age, complaint, device, created_by, created_at "
            "FROM patients ORDER BY id"
        ).fetchall()
    return [dict(r) for r in rows]


def create_patient(name: str, age: int | None, complaint: str,
                   device: str, created_by: str) -> dict:
    """新建病人: 自动分配下一个 P-xxx 编号 + 生成 6 位数字配对码。

    配对码明文只在本次返回值里出现一次 (打印给病人), 库里只存哈希。
    """
    code = f"{secrets.randbelow(1_000_000):06d}"
    salt = secrets.token_hex(8)
    with _conn() as conn:
        seq = conn.execute(
            "SELECT COALESCE(MAX(CAST(SUBSTR(id, 3) AS INTEGER)), 0) "
            "FROM patients WHERE id LIKE 'P-%'"
        ).fetchone()[0]
        pid = f"P-{seq + 1:03d}"
        conn.execute(
            "INSERT INTO patients VALUES (?,?,?,?,?,?,?,?,?)",
            (pid, name, age, complaint, device,
             salt, _hash(salt, code), created_by, time.time()),
        )
    return {"id": pid, "name": name, "pair_code": code}


def reset_pair_code(pid: str) -> dict | None:
    """重置配对码 (病人忘码时医生一键操作), 返回一次性明文新码。"""
    code = f"{secrets.randbelow(1_000_000):06d}"
    salt = secrets.token_hex(8)
    with _conn() as conn:
        cur = conn.execute(
            "UPDATE patients SET code_salt = ?, code_hash = ? WHERE id = ?",
            (salt, _hash(salt, code), pid.upper()),
        )
        if cur.rowcount == 0:
            return None
    return {"id": pid.upper(), "pair_code": code}


def update_patient(pid: str, fields: dict) -> bool:
    """改档案基本项 (name/age/complaint/device), 不碰口令。"""
    allowed = {k: v for k, v in fields.items()
               if k in ("name", "age", "complaint", "device") and v is not None}
    if not allowed:
        return False
    sets = ", ".join(f"{k} = ?" for k in allowed)
    with _conn() as conn:
        cur = conn.execute(
            f"UPDATE patients SET {sets} WHERE id = ?",
            (*allowed.values(), pid.upper()),
        )
        return cur.rowcount > 0
