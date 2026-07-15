"""运行时配置存储 — 设置页"模型服务商路由"的后端。

与 config.py 的关系: config.py 是进程启动期的 env 默认值; 本模块把
provider/model/temperature/embedder 变成运行时可改 (存 data/agent_service/config.json,
目录已 gitignore), UI PATCH 后立即对新会话生效, 无需重启。
"""

import json
import os
import tempfile
import threading

from .config import DATA_DIR, DEFAULT_MODEL, DEFAULT_PROVIDER

CONFIG_PATH = DATA_DIR / "config.json"
_lock = threading.Lock()

DEFAULTS = {
    "provider": DEFAULT_PROVIDER,
    "model": DEFAULT_MODEL,
    "temperature": 0.7,
    # 跟 Music!!! agent 库同一约定 (retrieval/embed.py 也读 EMBED_MODEL_NAME)
    "embedder": os.getenv("EMBED_MODEL_NAME", "BAAI/bge-m3"),
}


def load() -> dict:
    cfg = dict(DEFAULTS)
    try:
        saved = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        cfg.update({k: v for k, v in saved.items() if k in DEFAULTS})
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    return cfg


def save(patch: dict) -> dict:
    """合并 patch 并原子落盘。只认 DEFAULTS 里的键, 其余忽略。"""
    with _lock:
        cfg = load()
        for k, v in patch.items():
            if k not in DEFAULTS or v is None:
                continue
            if k == "temperature":
                v = max(0.0, min(2.0, float(v)))
            elif not isinstance(v, str) or not v.strip():
                continue
            cfg[k] = v
        fd, tmp = tempfile.mkstemp(dir=str(DATA_DIR), suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(cfg, f, ensure_ascii=False, indent=2)
            os.replace(tmp, CONFIG_PATH)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        return cfg
