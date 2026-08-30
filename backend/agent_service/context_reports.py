"""session → 选中报告 ids 的 side-car 存储 (报告上下文注入, Phase 5)。

聊天侧边栏勾选"加入上下文"的报告按会话记录在这里;
`make_reports_context_provider(session_id)` 每轮读取并注入报告内容。
与 sessions.py 的 _owners/_patients side-car 同法: 单 JSON 文件, 幂等覆盖写。
"""

import json
import threading

from .config import DATA_DIR

_PATH = DATA_DIR / "session_context_reports.json"
_lock = threading.Lock()
_MAX_PER_SESSION = 3   # 注入是每轮都发生的 token 成本, 封顶 3 份


def _load() -> dict:
    try:
        return json.loads(_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def get(session_id) -> list:
    """该会话选中的报告 id 列表 (无记录 → [])。"""
    if not session_id:
        return []
    return list(_load().get(session_id) or [])


def set_for(session_id, report_ids) -> list:
    """整体替换该会话的选中集 (幂等)。返回实际存储的列表 (截断到上限)。"""
    ids = [str(r) for r in (report_ids or [])][:_MAX_PER_SESSION]
    with _lock:
        data = _load()
        if ids:
            data[session_id] = ids
        else:
            data.pop(session_id, None)
        try:
            _PATH.write_text(json.dumps(data, ensure_ascii=False),
                             encoding="utf-8")
        except OSError:
            pass
    return ids
