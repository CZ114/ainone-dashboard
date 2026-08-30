"""Skills 技能库管理 — data/agent_service/skills/<name>/SKILL.md。

布局与库的 FileSkillStore 完全一致 (frontmatter name/description + 正文主指令)。
UI 只编辑 SKILL.md; references/ 与 scripts/ 目录手动放文件即可被
skill_read_file / skill_run_script 工具使用 (SOD 07 §4)。

生效点: factory.build_chat_agent — 有技能时挂 skill_store (聊天 /名字 展开)
并 register_skills (LLM 自主发现)。改动即时生效 (每次读盘)。
"""

import re
import shutil
import threading

from .config import DATA_DIR

SKILLS_DIR = DATA_DIR / "skills"
SKILLS_DIR.mkdir(parents=True, exist_ok=True)

_lock = threading.Lock()
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,39}$")


def has_skills() -> bool:
    return any((d / "SKILL.md").is_file() for d in SKILLS_DIR.iterdir() if d.is_dir())


def _store():
    from agent import FileSkillStore
    return FileSkillStore(str(SKILLS_DIR))


def list_skills() -> list[dict]:
    if not has_skills():
        return []
    return _store().list()


def get_skill(name: str) -> dict:
    if not _ID_RE.match(name):
        raise KeyError(f"非法技能名: {name}（Invalid skill name）")
    try:
        view = _store().view(name)
    except Exception:
        raise KeyError(f"未知技能: {name}（Unknown skill）")
    # view 的 body 已做 ${SKILL_DIR} 替换 — 编辑器要原文, 重新读原始文件
    raw = (SKILLS_DIR / name / "SKILL.md").read_text(encoding="utf-8")
    body = raw
    if raw.startswith("---\n"):
        end = raw.find("\n---\n", 4)
        if end != -1:
            body = raw[end + 5:].lstrip("\n")
    return {"name": name, "description": view["description"],
            "body": body, "files": view["files"]}


def upsert_skill(name: str, description: str, body: str) -> dict:
    if not _ID_RE.match(name):
        raise ValueError(f"非法技能名: {name!r} (2-40 位小写字母/数字/_/-)"
                         f"（Invalid skill name: 2-40 chars of lowercase letters/digits/_/-）")
    description = " ".join((description or "").split())  # 单行化 (frontmatter 只认单行)
    content = f"---\nname: {name}\ndescription: {description}\n---\n\n{body.strip()}\n"
    with _lock:
        skill_dir = SKILLS_DIR / name
        skill_dir.mkdir(parents=True, exist_ok=True)
        (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")
    return {"name": name, "description": description}


def delete_skill(name: str) -> None:
    if not _ID_RE.match(name):
        raise KeyError(f"非法技能名: {name}（Invalid skill name）")
    skill_dir = SKILLS_DIR / name
    if not (skill_dir / "SKILL.md").is_file():
        raise KeyError(f"未知技能: {name}（Unknown skill）")
    with _lock:
        shutil.rmtree(skill_dir)
