# Collaborator Plugin Spec — 让你的仓直接插进 ainone-dashboard

**Audience**: Jewelina95（以及任何要把模块挂进 dashboard 的协作者）
**Goal**: 你写完自己的仓 → 我们这边写薄 wrapper（一两百行）→ 用户在 Settings 页"安装"按钮一点就跑起来。**你不需要改 dashboard 一行代码。**

> 前提阅读：[`LAB_PROJECT_INTEGRATION_PLAN.md`](./LAB_PROJECT_INTEGRATION_PLAN.md) §3（house+plugin 模型）和 ainone-dashboard 仓的 `ARCHITECTURE.md` §7（Extension System）。

---

## 0. 整合模型一句话

**dashboard 是 host，你的三个仓是 plugin**。每个仓被包成一个 dashboard "Extension"——dashboard 已经实现了完整的 install / enable / start / stop / uninstall 生命周期 + SSE 进度流 + 状态持久化（参考 `backend/app/extensions/whisper_local.py`）。

你**不写** Extension 类。**我们这边写一个薄 wrapper Extension** 来包你的仓。但你必须让你的仓**可被薄薄地包住**——这就是这份 spec 的内容。

---

## 1. 通用契约（三个仓都要遵守）

### 1.1 提供一个 importable Python 入口（不是脚本）

❌ 现状：`mind-pipeline` 是 8 个编号脚本，靠 `subprocess.run` 串起来；`synthetic-generator` 是单文件靠 `if __name__ == "__main__":` 跑。

✅ 要做：把核心逻辑暴露成**可被 import 的函数 / class**：

```python
# 你的仓:  mind_pipeline/__init__.py  (或类似)
def run(bundle_path: Path, output_path: Path, **kwargs) -> RunResult:
    """One-shot 调用入口。从 bundle_path 读输入,写到 output_path,返回结果对象。"""
    ...
```

`if __name__ == "__main__":` CLI 可以保留——但只能是 `run()` 的薄包装，不能反过来。

**为什么**：wrapper 要在同一个 Python 进程里调你的代码，subprocess 调用能跑但额外失败模式太多（路径、权限、env、stdout 解析）。在同一进程 `import + run()` 是最稳的。

### 1.2 不要硬编码绝对路径

❌ 现状（所有 3 个仓都犯）：
```python
DATA_DIR = Path("/Users/wenshaoyue/Desktop/research/AD MIND/data_v2")
sys.path.insert(0, "/Users/wenshaoyue/Desktop/research/AD")
```

✅ 要做：所有路径都**作为参数传入**：

```python
def run(
    bundle_path: Path,        # 输入 bundle 在哪
    output_path: Path,        # 输出写到哪
    knowledge_dir: Optional[Path] = None,  # 知识库（可选,见 §1.6）
    config: Optional[dict] = None,
) -> RunResult:
    ...
```

如果你需要"内部资源"（提示词、模板、参考分布），把它们放进**你自己仓的 package 内**（比如 `mind_pipeline/resources/`），用 `importlib.resources` 或 `Path(__file__).parent / "resources"` 来定位——**绝不**走绝对路径。

### 1.3 不要在 import 时做副作用

❌ 不要：
```python
# mind_pipeline/some_module.py 顶层
DATA = pd.read_csv("/some/path")  # import 这个模块就会读盘 → 不行
shutil.rmtree(OUT_DIR)            # import 时清空目录 → 灾难
```

✅ 副作用（读盘、写盘、连网、调 API）只在 `run()` 内部发生。`import your_package` 必须**纯净**。

**特别提醒 synthetic-generator**：现在 `main()` 一上来就 `shutil.rmtree(OUT_DIR)`。这要拿掉。改成 `output_path` 参数指向调用方传入的、调用方负责清理的目录。

### 1.4 配置参数化，不要靠 env var 暗暗读

❌ 不要：
```python
client = anthropic.Anthropic()  # 从 env 读 ANTHROPIC_API_KEY,但你不文档化
```

✅ 要做：明确声明依赖什么 env / config，并允许调用方注入：

```python
def run(
    ...,
    anthropic_api_key: Optional[str] = None,  # None → 回退到 env var
    model: str = "claude-sonnet-4-6",
    ...
):
    api_key = anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise ValueError("anthropic_api_key 未提供且 ANTHROPIC_API_KEY env 未设")
    client = anthropic.Anthropic(api_key=api_key)
```

### 1.5 进度反馈 — 用 callback,不要靠 print

dashboard 会把"安装中"和"运行中"的进度通过 SSE 推到前端。你的 `run()` 应该接受可选的 `progress_cb`：

```python
def run(
    ...,
    progress_cb: Optional[Callable[[str, float], None]] = None,
) -> RunResult:
    """progress_cb(message: str, pct: float in [0,1]) 每个阶段调一次。"""

    def _tick(msg: str, pct: float):
        if progress_cb:
            progress_cb(msg, pct)

    _tick("Loading bundle", 0.0)
    bundle = load_bundle(bundle_path)
    _tick("Computing features (Analyzer)", 0.20)
    facts = analyze(bundle)
    _tick("Querying knowledge", 0.40)
    knowledge = query_kb(facts)
    _tick("Running clinical agent", 0.60)
    insights = run_agents(facts, knowledge)
    _tick("Synthesizing narrative", 0.85)
    report = narrate(insights)
    _tick("Writing output", 0.95)
    write_output(report, output_path)
    _tick("Done", 1.0)
    return RunResult(...)
```

**额外**：内部的 `print(...)` 改成 `logger`（Python `logging` 模块），这样 wrapper 能捕获到日志流。

### 1.6 知识库访问 — 通过我们提供的 HTTP 接口（不要自己实现）

我们这边会提供（见 §6）：

```
GET  /api/knowledge/search?q=<query>&tags=<t1,t2>&status=<...>
GET  /api/knowledge/get/<id>
GET  /api/knowledge/list?type=<concept|method|agent|synthesis|dataset>
```

返回的对象 schema：
```typescript
{
  id: string,                  // file slug, e.g. "iaboni_2022_hrv_ad"
  title: string,               // from front-matter
  body: string,                // markdown body
  front_matter: {
    type: string,
    status: "settled" | "draft" | "working_hypothesis" | "open_question",
    sources: string[],
    last_updated: string,
    ...
  },
  links: string[]              // relative links to other pages
}
```

❌ **不要**：在 mind-pipeline 内部 `from knowledge.knowledge_store import KnowledgeStore`（现在的硬阻塞）
✅ **要**：通过参数接收一个**函数式接口**，wrapper 会注入实现：

```python
# 你的仓里只声明这个 protocol
from typing import Protocol, Optional

class KnowledgeBackend(Protocol):
    def search(self, query: str, tags: list[str] = None) -> list[dict]: ...
    def get(self, id: str) -> Optional[dict]: ...

def run(..., knowledge: Optional[KnowledgeBackend] = None) -> RunResult:
    if knowledge is None:
        knowledge = NoOpKnowledge()  # 有 fallback,这样 standalone 也能跑
    ...
```

wrapper 会传一个调用 dashboard `/api/knowledge/search` 的实现进去。你**自己**也可以提供一个读本地 markdown 文件夹的 fallback 实现，方便 standalone 测试。

### 1.7 元信息 — `pyproject.toml` 必须有

每个仓都要有一份基本的 `pyproject.toml`（现在三个仓都没有）：

```toml
[project]
name = "ad-mind-pipeline"
version = "0.1.0"
description = "Stats-first clinical report pipeline for AD early prediction"
requires-python = ">=3.10"
dependencies = [
    "pandas>=2.0",
    "numpy>=1.24",
    "scipy>=1.10",
    "anthropic>=0.40",
]

[project.optional-dependencies]
dev = ["pytest", "ruff"]

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"
```

这样 wrapper 装你的仓就是 `pip install git+https://github.com/Jewelina95/ad-mind-pipeline@<sha>`，全自动。

### 1.8 测试 — 至少一个 smoke test

每个仓提供一个 smoke test，证明 `run()` 在**空数据**或**最小 fixture** 上跑得通：

```python
# tests/test_smoke.py
def test_run_with_minimal_bundle(tmp_path):
    bundle = build_minimal_fixture(tmp_path / "bundle")
    result = run(bundle_path=bundle, output_path=tmp_path / "out")
    assert result.success
    assert (tmp_path / "out" / "report.md").exists()
```

Mock 掉 LLM 调用：用一个 `model_backend` 参数（同 §1.6 思路），默认 anthropic SDK，测试时传一个返回固定 JSON 的 fake。

---

## 2. 仓特定契约：`ad-mind-pipeline`

### 2.1 入口

```python
# mind_pipeline/__init__.py
from mind_pipeline.runner import run, RunResult
```

### 2.2 函数签名

```python
def run(
    bundle_path: Path,
    output_path: Path,
    *,
    scope: Literal["session", "weekly", "monthly"] = "session",
    knowledge: Optional[KnowledgeBackend] = None,
    model_backend: Optional[ModelBackend] = None,  # 默认 anthropic SDK
    anthropic_api_key: Optional[str] = None,
    config: Optional[dict] = None,
    progress_cb: Optional[Callable[[str, float], None]] = None,
) -> RunResult: ...
```

### 2.3 输入 — Patient-Day Bundle (或 Patient-Range Bundle)

```
bundle_path/
  ├── persona.json
  ├── progression.csv
  ├── ema.jsonl
  ├── surveys.jsonl
  ├── notes.jsonl
  ├── bpsd_events.jsonl
  └── sensor/
      ├── day01_walking_normal.csv
      ├── day01_balance_standing.csv
      └── ...
```

`scope=session` 时，`sensor/` 下只有该 session 的 csv。
`scope=weekly` 时，`sensor/` 包含 7 天的 csv，所有 sidecar 也涵盖该 7 天。
`scope=monthly` 时，30 天。

**新工作量**（这是要 Jewelina 加的）：
- `scope=weekly/monthly` 时跑**聚合层**：日级 HRV 中位数、BPSD 事件计数、夜起次数、睡眠时长、各任务异常次数
- 跑**对比层**：weekly 对比上周；monthly 对比上月或基线
- 不同 scope 用不同的 prompt template（不同的叙述粒度）

> 谈判筹码：你给 Jewelina `/api/knowledge/search` 接口（解她 `KnowledgeStore` 硬阻塞），她给你 `scope` 参数支持。

### 2.4 输出

```
output_path/
  ├── meta.json           # {patient_id, scope, generated_at, version, ...}
  ├── facts.json          # Analyzer 阶段的确定性统计
  ├── insights/
  │   ├── physio.json
  │   ├── behavior.json
  │   └── clinical.json
  ├── dashboard.json      # 前端 widget 数据 (~4KB,见 §2.5)
  └── report.md           # 主报告 (markdown)
```

### 2.5 `dashboard.json` schema（前端要消费）

⚠️ 这部分需要锁死，因为 dashboard 前端要直接渲染。建议：

```typescript
{
  "version": "1.0",
  "patient_id": "P01",
  "scope": "weekly",
  "period": { "start": "2026-04-19", "end": "2026-04-26" },
  "summary": {
    "headline": "本周整体平稳,夜起次数显著上升",
    "risk_score": { "value": 0.42, "delta_vs_prev": +0.05, "level": "moderate" }
  },
  "cards": [
    {
      "id": "hrv_trend",
      "type": "timeseries",
      "title": "HRV 日中位数",
      "data": [{ "x": "2026-04-19", "y": 32.1 }, ...],
      "annotations": [{ "x": "2026-04-22", "label": "异常下降" }],
      "supporting_facts": ["fact_hrv_decline_w1"],
      "knowledge_refs": ["iaboni_2022_hrv_ad"]
    },
    ...
  ],
  "alerts": [
    { "level": "warn", "message": "夜起次数 12 次,比上周多 4 次", "evidence_card_id": "nocturnal_wake" }
  ]
}
```

`type` 至少支持：`timeseries | bar | metric | text | evidence_card`。每张卡都要有 `supporting_facts` + `knowledge_refs` 做 traceability（沿用你现在的 citation-strict 风格）。

### 2.6 `RunResult` 对象

```python
@dataclass
class RunResult:
    success: bool
    output_path: Path
    report_path: Path           # = output_path / "report.md"
    dashboard_path: Path        # = output_path / "dashboard.json"
    duration_sec: float
    llm_calls: int
    llm_tokens: dict            # {"input": ..., "output": ..., "cache_read": ...}
    errors: list[str]           # 非致命错误（某个 agent 失败但其他成功）
```

---

## 3. 仓特定契约：`ad-synthetic-generator`

### 3.1 入口

```python
# ad_synthetic_generator/__init__.py
from ad_synthetic_generator.api import generate, GenerateResult
```

### 3.2 函数签名

```python
def generate(
    output_dir: Path,                 # 调用方传入并负责清理 — 你不要 rmtree!
    *,
    n_patients: int = 10,
    n_days: int = 30,
    progression_pattern: Literal["linear", "stepwise", "rapid", "stable", "fluctuating"] = "linear",
    cognitive_reserve: Literal["low", "medium", "high"] = "medium",
    seed: Optional[int] = None,       # 同种子 → 同输出,方便 reproducibility
    baseline_data_dir: Optional[Path] = None,  # 真实基线 CSV 在哪
    progress_cb: Optional[Callable[[str, float], None]] = None,
) -> GenerateResult: ...
```

### 3.3 关键改动：**不要** `shutil.rmtree(output_dir)`

现在 `main()` 第一行清空目录。这要拿掉。改成：

```python
def generate(output_dir: Path, ...):
    output_dir.mkdir(parents=True, exist_ok=True)
    # 假设 output_dir 是空的或调用方接受叠加;不要清空
```

如果非要清空，加一个**显式**参数：`overwrite: bool = False`，且默认 False。

### 3.4 输出 schema

保持你现在的双视图：

```
output_dir/
  ├── manifest.json
  ├── by_patient/
  │   └── P01/
  │       ├── persona.json
  │       ├── progression.csv
  │       ├── ema.jsonl
  │       ├── surveys.jsonl
  │       ├── notes.jsonl
  │       ├── bpsd_events.jsonl
  │       └── sensor/
  │           └── day01_walking_normal.csv
  └── by_task/
      └── walking_normal/
          └── P01_day01.csv
```

**Sensor CSV 列**（已经对齐你的 wearable，不要改）：
```
timestamp, gsr_filtered, ppg_ir, hr_bpm_avg,
imu_ax_mps2, imu_ay_mps2, imu_az_mps2, svm, jerk,
hr_valid_flag, label, subject_id
```

`subject_id` 命名建议改成 `synth_<patient_id>_<day>_<task>`，避免和真实患者撞 ID。

### 3.5 `GenerateResult`

```python
@dataclass
class GenerateResult:
    success: bool
    output_dir: Path
    n_patients_generated: int
    n_files_written: int
    total_size_bytes: int
    manifest_path: Path
    warnings: list[str]    # e.g. "P03: hand_fine_motor task missing in baseline (S02_junkai),fell back to 6 tasks"
```

### 3.6 Voice modality（占位）

现在 voice 是 `not_synthesized`。短期接受现状——在 `manifest.json` 里如实写 `"voice": null` 即可，不要伪造数据。

---

## 4. 仓特定契约：`ad-wiki-pages`

### 4.1 这个仓**不需要 plugin 化**

它是知识内容仓，不是可执行模块。dashboard 这边会：

1. 通过 **git submodule** 把 `ad-wiki-pages` 拉进 `domain/ad-early-prediction/knowledge/`
2. 启动时扫 `wiki/**/*.md`，解 YAML front-matter，建全文索引（不需要向量库，60 篇 markdown 走 SQLite FTS5 或 Whoosh 完全够）
3. 通过 `/api/knowledge/search` 暴露给 chat 和 mind-pipeline

### 4.2 Jewelina 这边需要做的

**保持你现在的 front-matter 规范不变**，只是把它当成 stable 契约，不要随便改：

```yaml
---
title: HRV decline as early AD marker
type: concept | method | agent | synthesis | dataset | open_question
status: settled | draft | working_hypothesis | open_question
sources:
  - "Iaboni et al. 2022, J. Geriatr. Psychiatry"
  - "..."
last_updated: 2026-04-25
tags: [hrv, ans, biomarker, sensor]
---

# Body markdown...
```

**新加的字段**：`tags: [...]`（数组）。这个是搜索性能的关键——现在没有 tags，搜索只能全文，未来 60→500 篇时 tags 是过滤主力。

### 4.3 关于私有的 implementation 仓

那个有 7/8 stub agent 的私有仓：**先不要**集成。chat 已经有 claude-agent-sdk 跑通的 agent 路径，wiki-pages 描述的"`claude -p` subprocess pattern"先按下不表。等私有仓真的有 ≥3 个 agent 跑通了再讨论怎么接。

---

## 5. 开发→集成 工作流

```
┌─────────────────────────────────────────────────────────────┐
│  Jewelina 这边                                              │
│  ────────────────                                           │
│  1. 在你自己仓里实现 §2 / §3 的 run() / generate() 接口     │
│  2. 加 pyproject.toml 和 smoke test                         │
│  3. 拿掉硬编码路径、import 副作用、rmtree                   │
│  4. tag 一个 v0.1.0 release                                 │
│  5. 通知 CZ114                                              │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│  CZ114 这边                                                  │
│  ──────────                                                  │
│  6. 在 ainone-dashboard/backend/app/extensions/ 写薄 wrapper │
│       e.g. report_pipeline.py                                │
│  7. 注册到 registry.py                                       │
│  8. 验收 smoke test 通过                                     │
│  9. 用户在 Settings 页一键安装                               │
└─────────────────────────────────────────────────────────────┘
```

第 6 步的 wrapper 长这样（仅供 Jewelina 参考，**你不用写**）：

<details>
<summary>Wrapper 大致样貌（点开看示例）</summary>

```python
# backend/app/extensions/report_pipeline.py
from app.extensions.base import Extension, InstallContext

class ReportPipelineExtension(Extension):
    id = "report-pipeline"
    name = "Report Pipeline"
    description = "AD 临床报告生成 (单次/周报/月报)"
    version = "0.1.0"

    async def on_install(self, ctx: InstallContext) -> None:
        await ctx.log("Installing ad-mind-pipeline...")
        await self._pip_install(ctx, ["git+https://github.com/Jewelina95/ad-mind-pipeline@v0.1.0"])
        await ctx.progress(1.0)

    async def on_start(self, app):
        from mind_pipeline import run as _run   # 你提供的入口
        self._run = _run

    async def generate_report(self, bundle_path, output_path, scope="session"):
        # 注入 dashboard 这边的 KnowledgeBackend 实现
        kb = DashboardKnowledgeBackend(base_url="http://localhost:8080")
        return await asyncio.to_thread(
            self._run,
            bundle_path=bundle_path,
            output_path=output_path,
            scope=scope,
            knowledge=kb,
            progress_cb=self._on_progress,  # SSE 推到前端
        )
```

</details>

---

## 6. CZ114 这边会提供的支持

| # | 提供物 | 解锁 | 何时给 |
|---|--------|------|--------|
| 1 | `/api/knowledge/search` HTTP 接口 + Python client lib | 解 mind-pipeline `KnowledgeStore` 硬阻塞 | **优先做** (P0) |
| 2 | `KnowledgeBackend` Protocol + 一个本地 fallback 实现 | 你 standalone 也能跑 | 同上 |
| 3 | 一份 minimal bundle fixture（fake P01）放在共享位置 | 你写 smoke test 用 | 同上 |
| 4 | `dashboard.json` schema 的 JSON Schema 文件 + 1 个 example | 锁死前端契约 | P1 |
| 5 | wrapper extension 模板 (`report_pipeline.py.template`) | 你想本地预览能跑通的样子 | P1 |
| 6 | dashboard 的 Recordings 库写入 API（给 synthetic-generator 用） | data-factory wrapper 不用读你的目录,用我们的 API | P1 |

---

## 7. 验收清单（必须全过才能 plug-in）

### 通用
- [ ] 没有任何硬编码的 `/Users/...` 或 `C:\...` 路径
- [ ] 没有 `sys.path.insert`
- [ ] `import <package>` 是纯净的（无副作用）
- [ ] 有 `pyproject.toml`，`pip install git+<url>` 能装
- [ ] 至少一个 smoke test，CI 通过

### `ad-mind-pipeline` 专属
- [ ] `from mind_pipeline import run, RunResult` 可工作
- [ ] `run()` 接受 §2.2 全部参数
- [ ] 支持 `scope=session|weekly|monthly` 三种
- [ ] 输出目录结构符合 §2.4
- [ ] `dashboard.json` 符合 §2.5 schema
- [ ] LLM API key 通过参数注入，不强依赖 env var
- [ ] `KnowledgeBackend` 通过参数注入，有 NoOp fallback

### `ad-synthetic-generator` 专属
- [ ] `from ad_synthetic_generator import generate, GenerateResult` 可工作
- [ ] `generate()` 接受 §3.2 全部参数
- [ ] **不**调 `shutil.rmtree(output_dir)`
- [ ] `subject_id` 改成 `synth_*` 前缀避免撞真实 ID
- [ ] 同 `seed` 产出可复现

### `ad-wiki-pages` 专属
- [ ] 所有 markdown 有完整 YAML front-matter
- [ ] `tags: [...]` 字段加上
- [ ] 不再修改 front-matter 字段名（=锁定契约）

---

## 8. 常见坑 / FAQ

**Q: 我能不能保留 CLI 入口？**
A: 能。只要 `run()` 是 importable 的就行，CLI 当成 thin wrapper 调它即可。

**Q: 我的 dependencies 有原生扩展（torch、scipy），装起来慢/容易失败？**
A: 提前分两类：核心依赖 vs 可选依赖。在 `pyproject.toml` 用 `[project.optional-dependencies]` 把重的推到 optional，wrapper 安装时按需选。

**Q: 我想在生成报告时实时往前端推中间结果（不等全部跑完）？**
A: `progress_cb` 第一版只支持 `(msg, pct)`。如果你需要推**结构化中间事件**（比如 "Analyzer 阶段完成,这是 facts.json 预览"），告诉 CZ114，我们扩成 `event_cb(event: dict)` 形式。

**Q: 我的 prompts / templates 想热更新（不用重装 extension）？**
A: 把 prompts/templates 设计成可被 `domain pack` 覆盖（dashboard 这边的 `domain/ad-early-prediction/prompts/` 优先于你仓内置的）。`run()` 加一个 `prompts_dir: Optional[Path] = None` 参数。

**Q: 测试时怎么 mock LLM？**
A: 加一个 `ModelBackend` Protocol（同 §1.6 KnowledgeBackend 思路），默认 anthropic SDK 实现，测试传 fake。

---

## 9. 发布节奏建议

- **v0.1.0** — 本 spec 全部满足，但 mind-pipeline 只支持 `scope=session`。先拉通整条链路。
- **v0.2.0** — mind-pipeline 加 `scope=weekly`。
- **v0.3.0** — mind-pipeline 加 `scope=monthly` + 跨期对比。
- **v0.4.0** — synthetic-generator 加更多 progression patterns / cohort generation 模式。

每个版本都打 tag，wrapper 锁版本，避免 main 分支变化破坏 dashboard。

---

## 10. 联系 / Issue 追踪

- 接口/schema 不清楚 → 在 ainone-dashboard 仓开 issue，标 `integration`
- 改本 spec → PR 到 `esp32_sensor_dashboard` 仓改这个文件，CZ114 review
- 紧急阻塞 → 直接 IM

---

*本 spec 与 `LAB_PROJECT_INTEGRATION_PLAN.md` 配套使用。后者讲"为什么这么设计"，本文件讲"具体怎么做"。*
