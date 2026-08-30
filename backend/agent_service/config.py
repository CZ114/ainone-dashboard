"""agent_service 配置 — 路径、env 装载、key 命名映射、默认 provider/model。

设计文档: docs/agent-migration-sod/ (02-migration-plan.md M1)
"""

# ── WMI 规避 (必须在任何三方库 import 前执行) ────────────────────────
# openai SDK 构建请求头时调 platform.platform(), Python 3.12 在 Windows 上
# 经 WMI 查询 (uname 的 machine/processor 等字段); WMI 服务僵死时该调用无限
# 阻塞, 所有 LLM 请求挂死 (2026-07-11 实况: py-spy 抓到 chat 线程卡在
# platform._wmi_query / processor 懒属性)。
# 把 _wmi_query 打成立即抛 OSError — 标准库自身就有 "WMI 失败 → 回退
# PROCESSOR_* 环境变量" 的设计路径, 等于强制走官方降级通道。WMI 正常时
# 也无害 (信息略糙, 但没人消费它)。
import platform as _platform


def _wmi_query_disabled(*_args, **_kwargs):
    raise OSError("WMI query disabled by agent_service (WMI 僵死规避, 见 config.py)")


_platform._wmi_query = _wmi_query_disabled

import os
from pathlib import Path

from dotenv import load_dotenv

# 内存自保: OpenBLAS/torch 会按核数开线程、每线程预留大块缓冲 — 这台机器
# 内存紧张 (实测 bge-m3 加载时 OpenBLAS 分配失败直接崩进程), 线程压到 4。
# 必须在 numpy/torch 首次 import 之前设置才生效。
for _tv in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_tv, "4")

SERVICE_DIR = Path(__file__).resolve().parent
BACKEND_DIR = SERVICE_DIR.parent
REPO_ROOT = BACKEND_DIR.parent

# dashboard 惯例: .env 在仓库根 / backend/ (对齐 backend/claude/cli/node.ts loadEnvFiles)
# 注意 agent 库 import 时还会自己加载 Music!!!/project/agent/.env (VENICE_API_KEY 来自那里)
load_dotenv(REPO_ROOT / ".env")
load_dotenv(BACKEND_DIR / ".env")

# 设置页 Agents tab 的 Secrets (agents.json secrets 块, UI 粘贴的 key) 也作为
# 全局环境变量生效 — 否则那里存的 key 只能被 agent env 块的 ${NAME} 引用,
# 不能当 provider key 用。真实环境变量优先, 不覆盖。
import json as _json

try:
    _secrets = _json.loads(
        (BACKEND_DIR / "data" / "diary" / "agents.json").read_text(encoding="utf-8")
    ).get("secrets", {})
    for _k, _v in _secrets.items():
        if isinstance(_v, str) and _v and not os.getenv(_k):
            os.environ[_k] = _v
except (FileNotFoundError, ValueError):
    pass

# dashboard 的 key 命名惯例 → agent 库 (core/llm.py PROVIDERS 表) 期望的命名
KEY_ALIASES = {
    "DEEPSEEK_KEY": "DEEPSEEK_API_KEY",
    "MOONSHOT_KEY": "MOONSHOT_API_KEY",
    "QWEN_KEY": "DASHSCOPE_API_KEY",
    "ZHIPU_KEY": "ZHIPU_API_KEY",
    "VENICE_KEY": "VENICE_API_KEY",
    "MINIMAX_KEY": "MINIMAX_API_KEY",
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

# Phase 0 (gap 9): Agent 跨会话长期记忆根目录。按 <agent_id>/<patient_id> 分域
# (决策见 docs/plans/agent-mvp-completion.md §5)。与日记不同: 日记写给用户看,
# 这里的 memory 写给 agent 自己用 (Tier-1 摘要自动注入 + remember/recall 工具)。
AGENT_MEMORY_DIR = BACKEND_DIR / "data" / "agent_memory"
AGENT_MEMORY_DIR.mkdir(parents=True, exist_ok=True)

# Phase 0 (gap 8): 上下文压缩 (TokenBudgetCompactor)。半窗触发。各 provider 真实
# 窗口不同, 取偏小的安全默认 (compact 只在超阈值时才跑, 宁可略早也别撑爆)。
# 需要时经 env 覆盖; 后续可升级为按 model 查表 (见 plan Phase 0 风险条)。
COMPACT_CONTEXT_WINDOW = int(os.getenv("AGENT_COMPACT_WINDOW", "32000"))
COMPACT_THRESHOLD_RATIO = float(os.getenv("AGENT_COMPACT_THRESHOLD", "0.5"))

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

可用工具: read_recording(录音质量摘要+逐通道统计, 分析录音首选), \
read_file(读仓库内文件), write_file(写文件, 需用户批准), \
list_recordings(列最近录音, 可按患者过滤), web_search(联网搜索), web_fetch(抓取网页正文), \
run_workflow(启动多智能体工作流), delegate(委派给其他 agent), \
remember/recall_memory/list_memories(跨会话长期记忆)。\
需要时效性信息或仓库外的知识时主动用 web_search; 用户请求匹配某个预定义工作流场景 \
(见 run_workflow 工具描述里的清单) 时主动用 run_workflow, 并把其输出融入你的回答。

规则:
- 引用数据时给出具体数值, 绝不编造; 文件读不到就直说。
- 不做医疗诊断或健康结论 (可以描述数据特征, 不可下临床判断)。
- 遇到该用户/患者的稳定事实或值得跨会话保留的观察, 用 remember 记下 (会自动按患者归档); \
下次可用 recall_memory 取回。每轮开头会注入已有记忆的类目摘要。
- 用用户使用的语言回复 (中文用户用中文)。
"""
