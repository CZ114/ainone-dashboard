"""agent_service 配置 — 路径、env 装载、key 命名映射、默认 provider/model。

设计文档: docs/agent-migration-sod/ (02-migration-plan.md M1)
"""

import os
from pathlib import Path

from dotenv import load_dotenv

SERVICE_DIR = Path(__file__).resolve().parent
BACKEND_DIR = SERVICE_DIR.parent
REPO_ROOT = BACKEND_DIR.parent

# dashboard 惯例: .env 在仓库根 / backend/ (对齐 backend/claude/cli/node.ts loadEnvFiles)
# 注意 agent 库 import 时还会自己加载 Music!!!/project/agent/.env (VENICE_API_KEY 来自那里)
load_dotenv(REPO_ROOT / ".env")
load_dotenv(BACKEND_DIR / ".env")

# dashboard 的 key 命名惯例 → agent 库 (core/llm.py PROVIDERS 表) 期望的命名
KEY_ALIASES = {
    "DEEPSEEK_KEY": "DEEPSEEK_API_KEY",
    "MOONSHOT_KEY": "MOONSHOT_API_KEY",
    "QWEN_KEY": "DASHSCOPE_API_KEY",
    "ZHIPU_KEY": "ZHIPU_API_KEY",
    "VENICE_KEY": "VENICE_API_KEY",
}
for _alias, _canonical in KEY_ALIASES.items():
    if os.getenv(_alias) and not os.getenv(_canonical):
        os.environ[_canonical] = os.environ[_alias]

# 默认 provider/model。注意 agent/.env 里 LLM_PROVIDER=custom 但没配 LLM_BASE_URL,
# 所以这里必须显式 provider, 永远不依赖库的自动检测。
DEFAULT_PROVIDER = os.getenv("AGENT_PROVIDER", "venice")
DEFAULT_MODEL = os.getenv("AGENT_MODEL", "deepseek-v4-flash")

FASTAPI_BASE_URL = os.getenv("FASTAPI_BASE_URL", "http://localhost:8080")

DATA_DIR = BACKEND_DIR / "data" / "agent_service"
SESSIONS_DIR = DATA_DIR / "sessions"
SESSIONS_DIR.mkdir(parents=True, exist_ok=True)

# 复用日记系统的 agent 定义 + secrets (multi-agent 预留的落点)
AGENTS_JSON = BACKEND_DIR / "data" / "diary" / "agents.json"

# 文件工具白名单: 只允许读写仓库内 (含 recordings/)
FS_WHITELIST = [REPO_ROOT]

PERMISSION_TIMEOUT_S = int(os.getenv("AGENT_PERMISSION_TIMEOUT", "120"))
SESSION_TTL_S = int(os.getenv("AGENT_SESSION_TTL", "1800"))

DEFAULT_SYSTEM_PROMPT = """\
你是 ESP32 传感器平台 (AinOne Dashboard) 的内置 AI 助手。

平台功能: ESP32 硬件通过串口/BLE 采集生理传感器数据 (PPG/IMU/音频), 用户可录制 \
session (CSV + WAV), 在 dashboard 查看波形, 和你对话分析数据。

可用工具: read_file(读仓库内文件, 含录音 CSV), write_file(写文件, 需用户批准), \
list_recordings(列最近录音)。

规则:
- 引用数据时给出具体数值, 绝不编造; 文件读不到就直说。
- 不做医疗诊断或健康结论 (可以描述数据特征, 不可下临床判断)。
- 用用户使用的语言回复 (中文用户用中文)。
"""
