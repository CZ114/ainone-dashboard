---
type: research-reference
status: draft
last_updated: 2026-05-08
tags: [speech, mci, alzheimer, cognitive-assessment, features, biomarkers, literature, zh]
---

# 语音认知评估特征参考

**范围。** 一份用于从连续语音中检测**轻度认知障碍（MCI）**、**前驱期阿尔茨海默病（AD）** 与 **早期痴呆**的工作参考，覆盖特征、数据集、开源工具及最近文献。

**读者。** 项目内部成员（在做可穿戴 + companion pipeline 的人）、扩展开发者（Whisper、未来的认知特征提取器）、需要先 ramp up 上下文的合作者。

**写作约定。** §2 中每一条关于"该特征与认知衰退的临床关联"的论断，都至少有一篇 §7 的同行评审文献支撑。多源观点一致时，表格列出最强的综述或荟萃分析。工具条目链接到目前仍在活跃维护的上游仓库。

---

## 目录

1. [背景](#1-背景)
2. [特征分类](#2-特征分类)
   - 2.1 [声学 / 信号级](#21-声学--信号级特征)
   - 2.2 [时间 / 韵律 / 停顿](#22-时间--韵律--停顿特征)
   - 2.3 [词汇](#23-词汇特征)
   - 2.4 [语义 / 命题](#24-语义--命题特征)
   - 2.5 [句法](#25-句法特征)
   - 2.6 [语篇 / 语用](#26-语篇--语用特征)
   - 2.7 [失流畅](#27-失流畅特征)
   - 2.8 [深度 / 表示学习](#28-深度--表示学习特征)
3. [公开数据集与挑战赛](#3-公开数据集与挑战赛)
4. [开源工具链](#4-开源工具链)
5. [近期论文（2024–2026）](#5-近期论文20242026)
6. [推荐阅读顺序](#6-推荐阅读顺序)
7. [文献引用](#7-文献引用)

---

## 1. 背景

### 1.1 为什么用语音做认知生物标志物

连续语音**同时**调动记忆、注意、执行功能、语义记忆和运动规划。任一环节出现细微衰退，都会在声学层（语速变慢、停顿增多）或语言层（词汇变小、句法变简、内容变泛）显现 —— 而且通常在临床诊断**数年之前**就能看到。最经典的证据是 *Nun Study*：14 名后来经神经病理学确诊为 AD 的修女，**在 20 岁出头写的自传里 idea density 就明显偏低**，远早于任何症状出现（[Snowdon 等, 1996; Riley 等, 2005](#7-文献引用)）。

语音同时具备**生态有效性**（可在自然对话中被动采集）、**低成本**，并且**采集本身是语言无关的**（虽然分析层面与语言相关）。近期综述（[Vincze 等, 2021](#7-文献引用); [de la Fuente Garcia 等, 2020](#7-文献引用); [Petti 等, 2020](#7-文献引用); [2025 年系统综述](https://pmc.ncbi.nlm.nih.gov/articles/PMC12560767/)）的结论高度一致：精心挑选的一小组语音特征（约 10–30 个，详见 §2）在 MCI vs 健康对照的判别上 AUC 可达约 0.75–0.85，**无需**任何神经影像或体液生物标志物。

### 1.2 认知 → 语音的映射

| 认知域 | 语音表现 | 特征类别（§2） |
|---|---|---|
| **情景记忆** | 找词时停顿增多、代词增多 / 具名词减少 | 词汇、失流畅 |
| **语义记忆** | 词汇多样性降低、内容单元变少、idea density 下降 | 词汇、语义 |
| **注意** | 反应延迟变长、有声停顿（uh/um）增多 | 时间、失流畅 |
| **执行功能** | 句子变短/变简、话题漂移 | 句法、语篇 |
| **工作记忆** | 自我修正、重启、词语截断 | 失流畅、句法 |
| **运动控制** | 发音速率下降，jitter/shimmer 变化，韵律改变 | 声学、韵律 |

这个映射是经验性的而非确定性的 —— 单一特征偏离的原因有很多（情绪、疲劳、二语效应等）。鲁棒的系统会跨类别组合特征，并把每一项视为"面板里的一个信号"。

### 1.3 常用采集任务

| 任务 | 认知负荷 | 备注 |
|---|---|---|
| **Cookie Theft 图片描述** | 语义 + 语篇 | 领域内用得最多的任务 —— Pitt corpus 与每一届 ADReSS 挑战赛的基础。描述厨房场景约 60 秒（出自 Boston Diagnostic Aphasia Examination） |
| **语义/语音流畅性** | 词汇提取 + 执行控制 | "60 秒内尽量多说动物" / "以 F 开头的词"。快速、效度成熟 |
| **故事复述（Logical Memory）** | 情景记忆 + 叙事产出 | 听完短故事立即复述，30 分钟后再复述一次。WMS-IV 子测 |
| **朗读 / 段落朗读** | 发音、韵律 | 消除语言内容的差异 —— 便于隔离纯声学/运动层面的变化 |
| **自由对话 / 访谈** | 自然涵盖所有域 | 生态效度最高但分析最难。TalkBank 的 Carolinas Conversations Collection 是该路径的标杆资源 |
| **命名任务（Boston Naming Test）** | 语义提取 | 计分后可作诊断；从特征工程角度看自由度低 |

本项目通话页采集的音频（自由对话、且已配有韵律 + 停顿数据）正处于**对话 / Cookie Theft** 这一端附近 —— 也是基于特征做 MCI 筛查时信息量最高的一类。

---

## 2. 特征分类

下面每一小节有一张汇总表。列含义统一为：

- **特征** — 指标名（英文学名为主，旁注中文意义）。
- **单位 / 范围** — 测什么、典型量级。
- **MCI/AD 方向** — `↑` 表示 MCI/AD 患者更多，`↓` 更少，`≠` 有差异但方向因任务而异。
- **工具** — 开源提取工具（§4 有详细说明）。
- **参考** — 一条锚定文献（§7 给完整条目）。

### 2.1 声学 / 信号级特征

从原始音频里直接计算，不依赖转写。捕捉**"听起来如何"**，与所说内容无关。

| 特征 | 单位 / 范围 | MCI/AD 方向 | 工具 | 参考 |
|---|---|---|---|---|
| **F0（基频）均值** | Hz，典型 80–250 | ≠（AD 患者变异度更小） | OpenSMILE, parselmouth | [eGeMAPS 论文](https://sail.usc.edu/publications/files/eyben-preprinttaffc-2015.pdf) |
| **F0 变异度（标准差 / 范围）** | Hz | ↓（语调单调化） | OpenSMILE | [eGeMAPS 论文](https://sail.usc.edu/publications/files/eyben-preprinttaffc-2015.pdf) |
| **抖动 Jitter（local, ppq5, rap）** | %，正常 0.5–3% | ↑（声带不稳定） | praat / parselmouth, DisVoice | [Meilán 等, 2014](#7-文献引用) |
| **闪烁 Shimmer（local, apq3, apq5）** | dB 或 % | ↑ | praat / parselmouth, DisVoice | [Meilán 等, 2014](#7-文献引用) |
| **HNR（谐波-噪声比）** | dB，正常 10–30 dB | ↓（声音更"气声化"） | praat, DisVoice | [eGeMAPS 论文](https://sail.usc.edu/publications/files/eyben-preprinttaffc-2015.pdf) |
| **共振峰（F1, F2, F3）** | Hz | ≠（构音障碍下 F2 离散度下降） | praat / parselmouth | [DisVoice 文档](https://github.com/jcvasquezc/DisVoice) |
| **共振峰中心化比 FCR** | 无量纲 | ↑（元音中心化） | praat / parselmouth | [Sapir 等, 2010](#7-文献引用) |
| **MFCC（1–13）** | 无量纲，按统计量聚合 | ≠（在分类器中具判别力） | librosa, OpenSMILE | [Luz 等, ADReSSo 2021](#7-文献引用) |
| **频谱通量 / 中心 / 斜率 / Hammarberg 指数** | 各异 | ≠ | OpenSMILE（eGeMAPS） | [eGeMAPS 论文](https://sail.usc.edu/publications/files/eyben-preprinttaffc-2015.pdf) |
| **嗓音质量（CPP — 倒谱峰突）** | dB | ↓ | praat, VoiceLab | [Heman-Ackah 等, 2003](#7-文献引用) |
| **能量 / 响度（RMS, dBA）** | dB | 部分 AD 研究中 ↓ | librosa, OpenSMILE | [Framingham 2024](https://aging.jmir.org/2024/1/e55126) |

### 2.2 时间 / 韵律 / 停顿特征

自发语音中最可重复的认知衰退信号。**仅停顿模式**就驱动了 ADReSS 类基准 AUC 的大部分。

| 特征 | 单位 / 范围 | MCI/AD 方向 | 工具 | 参考 |
|---|---|---|---|---|
| **语速 Speech rate** | 词/分钟 或 音节/秒 | ↓ | textgrid + VAD | [König 等, 2015](#7-文献引用) |
| **发音速率 Articulation rate** | 音节 / 发声时间 | ↓ | textgrid + VAD | [König 等, 2015](#7-文献引用) |
| **发声时间占比** | 发声时长 / 总时长 | ↓ | VAD | [Pulido 等, 2020](#7-文献引用) |
| **总发声时长** | 秒 | ≠（任务相关） | VAD | — |
| **停顿次数（>0.2 s）** | 次 / 分钟 | ↑ | VAD, py-webrtcvad | [Yuan 等, 2020](#7-文献引用) |
| **停顿平均时长** | ms | ↑ | VAD | [Pistono 等, 2016](#7-文献引用) |
| **停顿时长变异度（SD）** | ms | ↑ | VAD | [König 等, 2015](#7-文献引用) |
| **长停顿率（≥ 2 s）** | 次 / 分钟 | ↑↑（强信号） | VAD | [Toth 等, 2018](#7-文献引用); [2025 系统综述](https://pmc.ncbi.nlm.nih.gov/articles/PMC12560767/) |
| **无声 : 有声停顿比** | 无量纲 | ↑（无声占主导） | VAD + ASR | [Pistono 等, 2016](#7-文献引用) |
| **句间单元长度（IPU）** | 词 / IPU | ↓ | VAD + ASR | [Pulido 等, 2020](#7-文献引用) |
| **节律指标（%V, ΔC, nPVI）** | 无量纲 | ≠（辅音时长变异度上升） | Correlatore | [Martínez-Sánchez 2017](#7-文献引用) |
| **VOT 变异度** | ms 标准差 | ↑ | praat | [Pulido 等, 2020](#7-文献引用) |

> **TAUKADIAL 2024** 双语挑战赛证实了停顿类特征跨语言泛化：在英语和中文 MCI 语音中，**长停顿率**都是判别力最高的前 2 个特征之一（[Pérez-Toro 等, 2024](#7-文献引用)）。

### 2.3 词汇特征

需要转写文本（Whisper / wav2vec2 / 人工）。捕捉**"说了什么词"**。

| 特征 | 单位 / 范围 | MCI/AD 方向 | 工具 | 参考 |
|---|---|---|---|---|
| **类型-型符比 TTR** | 无量纲，0–1 | ↓（词汇多样性下降） | spaCy + 自写 | [Bucks 等, 2000](#7-文献引用) |
| **滑动 TTR（MATTR, w=50）** | 无量纲 | ↓（长度鲁棒） | textstat | [Covington & McFall, 2010](#7-文献引用) |
| **Honoré 统计量 R** | 无量纲 | ↓ | textstat | [Honoré, 1979](#7-文献引用) |
| **Brunét 指数 W** | 无量纲 | ↑（词汇越小 → W 越大） | textstat | [Brunét, 1978](#7-文献引用) |
| **平均词长** | 字符 | ↓（词更短） | 基础 NLP | [Bucks 等, 2000](#7-文献引用) |
| **词频（SUBTLEX 对数频均值）** | log 频 | ↑（用常见词多） | wordfreq | [Almor 等, 1999](#7-文献引用) |
| **实词比例** | 实词 / 总词 | ↓ | spaCy POS | [Bucks 等, 2000](#7-文献引用) |
| **代词 : 名词比** | 无量纲 | ↑（"那个东西"代替具名实体） | spaCy POS | [Almor 等, 1999](#7-文献引用); [Vincze 等, 2021](#7-文献引用) |
| **轻动词比例**（be, have, do, get, go, make） | 实义动词中占比 | ↑ | spaCy POS | [Bschor 等, 2001](#7-文献引用) |
| **空泛词率**（"thing", "stuff", "something"） | 次 / 100 词 | ↑ | 自定义词表 | [Almor 等, 1999](#7-文献引用) |
| **POS 分布熵** | bits | 健康组更高 | spaCy POS | [Roark 等, 2011](#7-文献引用) |
| **数词 / 分词使用（双语标志）** | 次 / 100 词 | TAUKADIAL：MCI ↑ | spaCy POS | [Shakeri 等, 2026](#7-文献引用) |

### 2.4 语义 / 命题特征

"**信息量有多大**"这一维度。在 MCI 到 AD 的纵向进展预测中最强。

| 特征 | 单位 / 范围 | MCI/AD 方向 | 工具 | 参考 |
|---|---|---|---|---|
| **命题 idea density（P-density）** | 命题 / 10 词；正常约 4–6 | ↓ | CPIDR | [Snowdon 等, 1996](#7-文献引用); [Riley 等, 2005](#7-文献引用); [Engelman 等, 2010](#7-文献引用) |
| **内容信息单元 CIU — Cookie Theft** | 命中的具名指代数（水槽、女人、饼干罐……） | ↓ | 手工或规则 | [Croisile 等, 1996](#7-文献引用) |
| **与图片模板的语义相似度（SBERT 余弦）** | 0–1 | ↓ | sentence-transformers | [Eyigoz 等, 2020](#7-文献引用) |
| **语义连贯性（相邻句余弦）** | 0–1，MCI 方差更小 | ≠（均值更低，轨迹更平） | sentence-transformers | [Hoffmann 等, 2010](#7-文献引用) |
| **语义流畅性聚类大小** | 每类项数 | ↓ | 评分规范 | [Troyer 等, 1997](#7-文献引用) |
| **语义流畅性切换次数** | 切换次数 | 健康组更高 | 评分规范 | [Troyer 等, 1997](#7-文献引用) |
| **话题漂移（滑窗相似度 SD）** | 无量纲 | MCI ↑ | sentence-transformers | [Beltrami 等, 2018](#7-文献引用) |
| **指代具体性（命名实体 / 总名词短语）** | 无量纲 | ↓ | spaCy NER | [Vincze 等, 2021](#7-文献引用) |

> **Idea density 值得单独点名。** Nun Study 那条发现 —— **20 岁出头时**写的自传预测几十年后 AD 风险 —— 是迄今最强的证据：某些语音特征反映的不是当前认知状态，而是**一生的认知储备**。低 idea density 对应约 **5 倍**的 AD 风险升高（[Snowdon 等, 1996](#7-文献引用)）。Precursors Study（[Engelman 等, 2010](#7-文献引用)）与 Nun Study 后续研究（[Riley 等, 2005](#7-文献引用)）都重复了这一结论。

### 2.5 句法特征

语音**结构化**程度。一般变化比词汇慢，更适合追踪进展，而非初次检测。

| 特征 | 单位 / 范围 | MCI/AD 方向 | 工具 | 参考 |
|---|---|---|---|---|
| **平均话段长度 MLU** | 词/话段 | ↓ | CLAN, spaCy | [Bschor 等, 2001](#7-文献引用) |
| **句长 SD** | 词 | ↓（变化减少） | spaCy | [Vincze 等, 2021](#7-文献引用) |
| **Yngve 深度（均值 / 最大）** | 无量纲 | ↓（结构嵌套变浅） | benepar | [Roark 等, 2011](#7-文献引用) |
| **依存树深 / 宽** | 无量纲 | ↓ | spaCy 解析器 | [Roark 等, 2011](#7-文献引用) |
| **从句率** | 从句 / 主句 | ↓ | spaCy / benepar | [Kemper 等, 2001](#7-文献引用) |
| **嵌套从句率** | 次 / 100 词 | ↓ | benepar | [Roark 等, 2011](#7-文献引用) |
| **Frazier 分数（左分支复杂度）** | 无量纲 | ↓ | benepar | [Roark 等, 2011](#7-文献引用) |
| **动词时态多样性（熵）** | bits | MCI ↓ | spaCy POS | [Vincze 等, 2021](#7-文献引用) |
| **短语结构规则多样性** | 唯一规则数 / 100 词 | ↓ | benepar | [Roark 等, 2011](#7-文献引用) |
| **助动词 / 情态动词每从句数** | 无量纲 | ≠ | spaCy POS | [Bschor 等, 2001](#7-文献引用) |

### 2.6 语篇 / 语用特征

整个语轮的**组织方式**。

| 特征 | 单位 / 范围 | MCI/AD 方向 | 工具 | 参考 |
|---|---|---|---|---|
| **全局连贯性（相邻句余弦）** | 0–1 | ↓ | sentence-transformers | [Hoffmann 等, 2010](#7-文献引用) |
| **话题维持比** | 在话题 / 总话段 | ↓ | 手工 或 主题模型 | [Glosser & Deser, 1991](#7-文献引用) |
| **指代清晰度（指代距先行词的距离）** | 词 | ↑（指代越发模糊） | 共指消解 | [Almor 等, 1999](#7-文献引用) |
| **重复率（逐词 / n-gram 自匹配）** | 次 / 100 词 | ↑ | 字符串匹配 | [Pistono 等, 2016](#7-文献引用) |
| **信息传递速率（CIU/分钟）** | CIU/分钟 | ↓ | 手工 + 时长 | [Croisile 等, 1996](#7-文献引用) |
| **语篇标记率**（well, you know, so, anyway） | 次 / 100 词 | ↑ | 词表 | [Cuetos 等, 2007](#7-文献引用) |
| **故事语法完整度** | 必备故事要素 % | ↓ | 标注规范 | [Wright 等, 2014](#7-文献引用) |
| **对话节奏 — 轮转延迟** | ms | ↑ | 对话 ASR | — |

### 2.7 失流畅特征

以前语言学家口中的"嗯啊"—— 实际上是认知负荷与找词困难的丰富信号。

| 特征 | 单位 / 范围 | MCI/AD 方向 | 工具 | 参考 |
|---|---|---|---|---|
| **有声停顿率**（"uh", "um", "er"） | 次 / 100 词 | ↑ | ASR + 词表，[deep-disfluency-detector](https://github.com/clp-research/deep_disfluency) | [Pistono 等, 2016](#7-文献引用) |
| **词重复率**（"the the the"） | 次 / 100 词 | ↑ | 字符串匹配 | [Pistono 等, 2016](#7-文献引用) |
| **短语重复率** | 次 / 100 词 | ↑ | n-gram 匹配 | [Pistono 等, 2016](#7-文献引用) |
| **错起/重启率** | 次 / 100 词 | ↑ | 手工 或 [pariajm/deep-disfluency-detector](https://github.com/pariajm/deep-disfluency-detector) | [Bortfeld 等, 2001](#7-文献引用) |
| **截断词率**（中途打断） | 次 / 100 词 | ↑ | 手工 | [Bortfeld 等, 2001](#7-文献引用) |
| **自我修正率** | 次 / 100 词 | ↑ | 手工 或 自动 | [Pistono 等, 2016](#7-文献引用) |
| **填充词 : 无声停顿比** | 无量纲 | ↓（AD 中无声停顿占主） | 综合 | [Pistono 等, 2016](#7-文献引用) |
| **找词停顿**（>0.5 s 紧贴低频词的停顿） | 次 / 100 词 | ↑ | VAD + ASR + 词频查表 | [Hoover 等, 2020](#7-文献引用) |

### 2.8 深度 / 表示学习特征

把 embedding 本身当特征。截至 2024–2026，是 ADReSS 类基准上的 SOTA 路径。

| 特征 | 是什么 | MCI/AD 用法 | 工具 | 参考 |
|---|---|---|---|---|
| **wav2vec 2.0 嵌入（1024 维）** | 自监督音频表示 | 拼上分类器 → ADReSS AUC ~0.85 | [HuggingFace `facebook/wav2vec2-large`](https://huggingface.co/facebook/wav2vec2-large-960h) | [Balagopalan 等, 2021](#7-文献引用) |
| **HuBERT / WavLM 嵌入** | 改进版自监督音频 | 与 wav2vec2 相当；少数据时更稳 | HuggingFace | [Hsu 等, 2021](#7-文献引用) |
| **Whisper encoder 嵌入** | 30 秒窗口的 encoder 输出 | 跨语言强；PROCESS / TAUKADIAL 顶系统都用 | [openai/whisper](https://github.com/openai/whisper) | [Radford 等, 2022](#7-文献引用); [Process 2024](#7-文献引用) |
| **BERT / RoBERTa 转写嵌入** | CLS 池化输出 | 与声学拼接 → ADReSS-text AUC ~0.87 | HuggingFace | [Balagopalan 等, 2021](#7-文献引用) |
| **Sentence-BERT (SBERT) 连贯性分** | 每句对上下文的余弦 | 用于 §2.6 的语义连贯性特征 | [sentence-transformers](https://www.sbert.net/) | [Reimers & Gurevych, 2019](#7-文献引用) |
| **LLM 派生特征**（perplexity, 零样本 prompt） | "请给这段转写评分……" | 2024–25 起逐步替代手工特征 | OpenAI / Anthropic API、本地 LLM | [Amini 等, 2024](#7-文献引用); [Bang 等, 2024](#7-文献引用) |
| **向量嵌入 + ML 分类器 pipeline** | 端到端"语音 → 嵌入 → 逻辑回归" | 可复现 baseline | [dzhou08/embedding_AZ](#7-文献引用) | — |
| **多模态融合（声学 + 转写）** | 把 §2.1、§2.3、§2.8 的特征拼接 | 通常对应公开报道中的最高 AUC | TRESTLE 工具箱 | [多模态 DL 2024](https://www.nature.com/articles/s41598-024-64438-1) |
| **可解释 AI 叠加（SHAP、LIME on embeddings）** | 把深度特征反映射为可解释语言模式 | 2024–25 综述里上升明显 | shap, lime | [npj Digital Medicine XAI 综述 2025](https://www.nature.com/articles/s41746-025-02105-z) |

> **2026 年的真正取舍**已经不是"手工特征 vs 深度特征"。PROCESS、TAUKADIAL 与 Framingham Heart Study 队列中表现最好的系统都做**两类融合** —— 用嵌入拿到原始判别力，用可解释特征支撑临床可信度。2025 年 npj Digital Medicine 的 XAI 综述（[链接](https://www.nature.com/articles/s41746-025-02105-z)）已经把这种融合视为默认路径。

---

## 3. 公开数据集与挑战赛

| 数据集 / 挑战 | 语言 | 任务 | 规模 | 访问 | 参考 |
|---|---|---|---|---|---|
| **DementiaBank Pitt Corpus** | 英 | Cookie Theft 图片描述等 | 242 健康 + 257 AD 录音（99 / 169 唯一被试） | [TalkBank 注册](https://dementia.talkbank.org/access/) | [Lanzi 等, 2023](#7-文献引用) |
| **ADReSS**（Interspeech 2020） | 英 | Pitt 的平衡子集，分类 + MMSE 回归 | 156 个音频 + 转写 | 挑战赛主页 | [Luz 等, 2020](#7-文献引用) |
| **ADReSSo**（Interspeech 2021） | 英 | 纯音频版，无转写 | 237 个音频 | 挑战赛主页 | [Luz 等, 2021](#7-文献引用) |
| **ADReSS-M**（ICASSP 2023） | 英 + 希腊 | 多语言分类 | 英语训练 + 希腊语测试 | [ICASSP 2023 SPGC](https://luzs.gitlab.io/madress-2023/) | [Luz 等, 2023](#7-文献引用) |
| **TAUKADIAL**（Interspeech 2024） | 英 + 中（台湾普通话） | MCI 分类 + MMSE/MoCA 回归 | 双语共约 387 音频 | [挑战赛站点](https://taukadial-luzs-69e3bf4b9878b99a6f03aea43776344580b77b9fe54725f4.gitlab.io/) | [Pérez-Toro 等, 2024](#7-文献引用) |
| **PROCESS**（2024–25 信号处理挑战） | 英 | 多 prompt 自发语音（语义流畅、图描述、故事复述）下的 MCI / 痴呆 | 挑战赛之外暂未公开 | [Call for participation](https://processchallenge.github.io/callforparticipation/) | [Tao 等, 2024](#7-文献引用) |
| **Carolinas Conversations Collection (CCC)** | 英 | 老年人对话访谈（健康 + AD） | ~64 被试，~400 对话 | [TalkBank 注册](https://dementia.talkbank.org/) | [Pope & Davis, 2011](#7-文献引用) |
| **WLS（Wisconsin Longitudinal Study）音频子样本** | 英 | 老年纵向队列的电话对话 | WLS 子样本（WLS 始于 1957，约 1 万人） | [WLS 数据门户](https://www.ssc.wisc.edu/wlsresearch/) | — |
| **Framingham Heart Study — 嗓音子队列** | 英 | 声学特征 + 神经心理测评 | ~4,800 嗓音样本 | [JMIR Aging 2024](https://aging.jmir.org/2024/1/e55126) | [Lin 等, 2024](#7-文献引用) |
| **DementiaBank — Lu Corpus** | 粤语 | 图片描述 + 言语流畅 | ~50 被试 | TalkBank | [Lu 等, 2009](#7-文献引用) |
| **DementiaBank — Kempler Corpus** | 英 | 对话 / 自传 | ~9 被试（小但经典） | TalkBank | [Lanzi 等, 2023](#7-文献引用) |
| **DementiaBank-Emotion**（2026） | 英 | AD 语音上的多评分员情感标注 | 192 录音 | [arxiv 2602.04247](https://arxiv.org/html/2602.04247v1) | — |
| **DementiaNet**（开放） | 英 | 纵向自发语音，最早可追溯发病前 10 年 | 100 被试 | [github.com/shreyasgite/dementianet](https://github.com/shreyasgite/dementianet) | — |

### 访问说明

- **TalkBank / DementiaBank** 需要机构账号 + 签署数据使用协议。研究用免费，审批周期约 1–2 周。
- **ADReSS / ADReSSo / ADReSS-M / TAUKADIAL** 现已结束，对应挑战赛站点上提供非商业研究用途下载。
- **PROCESS 数据** 截至 2026 年 5 月仍未公开发布，仅注册参赛者可访问。

---

## 4. 开源工具链

按 pipeline 阶段（原始音频 → 特征 → 模型）分组。每条链接到截至 2026 年 5 月仍在维护的上游仓库。

### 4.1 音频加载与预处理

- **librosa** — `pip install librosa`。Python 音频处理标杆。重采样、STFT、MFCC、频谱特征。https://librosa.org/
- **torchaudio** — 同范围，但带 GPU + autograd。要把特征接到 PyTorch 分类器时合适。https://pytorch.org/audio/
- **soundfile** — 快速 WAV/FLAC I/O，被 librosa 当作后端。

### 4.2 声学特征提取

- **OpenSMILE / opensmile-python** — `pip install opensmile`。副语言学特征集事实标准，包括 **GeMAPS**（62 维）、**eGeMAPS**（88 维，临床嗓音分析的默认选择）、**ComParE 2016**（~6.4k 维）。audEERING 维护。https://audeering.github.io/opensmile-python/ · 原论文：[Eyben 等, 2015 — IEEE Trans. Affective Computing](https://sail.usc.edu/publications/files/eyben-preprinttaffc-2015.pdf)
- **parselmouth（Python 包装 Praat）** — `pip install praat-parselmouth`。封装 Praat 的脚本层；给出 jitter、shimmer、HNR、formant、intensity。绝大多数特征工程文献都引这个。https://parselmouth.readthedocs.io/
- **DisVoice** — `pip install disvoice`。专门针对病理嗓音分析：声门、发声、构音、韵律、音位特征。用于 PD、亨廷顿病、痴呆研究。https://github.com/jcvasquezc/DisVoice
- **COVAREP** — Matlab 工具箱（仍偶被论文引用，但 Python 工具已基本替代）。
- **VoiceLab** — Praat 的图形化批处理 wrapper（适合探索，不太适合接入 pipeline）。

### 4.3 ASR（音频 → 转写）

- **OpenAI Whisper** — `pip install openai-whisper`，或用 [faster-whisper](https://github.com/SYSTRAN/faster-whisper) 提速约 4×。99 种语言，对噪声鲁棒。现在所有 MCI/AD pipeline 的默认 ASR。https://github.com/openai/whisper
- **wav2vec2 / HuBERT / WavLM**（HuggingFace） — 自监督模型。可作 ASR（接 fine-tune 的 CTC 头）或作特征提取器（encoder 输出当 embeddings，见 §2.8）。https://huggingface.co/facebook/wav2vec2-large-960h
- **NeMo（NVIDIA）** — 工业级 ASR + 说话人分离工具箱。多说话人录音（采访者 + 被试）时有用。https://github.com/NVIDIA/NeMo

### 4.4 语言学特征提取

- **spaCy** — `pip install spacy`。工业级 NLP：分词、POS、依存解析、NER。上面的大部分词汇 / 句法特征 1–3 行 spaCy 就能写出来。https://spacy.io/
- **Stanza（斯坦福）** — 与 spaCy 并列；某些语言下成分句法解析更强。https://stanfordnlp.github.io/stanza/
- **benepar（Berger-Petrov 成分句法解析器）** — 作为 spaCy 插件，加入成分树（计算 Yngve 深度、Frazier 分数、嵌套从句计数都需要）。https://github.com/nikitakit/self-attentive-parser
- **textstat** — `pip install textstat`。快速可读性 + 词汇指标（TTR、Honoré R、Brunét W）。https://pypi.org/project/textstat/
- **wordfreq** — `pip install wordfreq`。基于 SUBTLEX 的多语言词频查表。https://github.com/rspeer/wordfreq
- **CPIDR** — Computerized Propositional Idea Density Rater。Brown、Snyder 等出的 Java 工具，是 idea density 的标准实现。http://www.ai.uga.edu/caspr/

### 4.5 嵌入与深度模型

- **sentence-transformers（SBERT）** — `pip install sentence-transformers`。句级 embeddings，用于 §2.6 的语义连贯性特征。https://www.sbert.net/
- **HuggingFace `transformers`** — `pip install transformers`。文献里所有预训练文本 / 语音模型的来源。https://huggingface.co/
- **Hugging Face `datasets`** — 标准 NLP 数据集的打包访问，部分含 DementiaBank 派生集。

### 4.6 端到端 pipeline / 参考实现

- **TRESTLE**（TalkBank Reproducible Execution of Speech, Text, Language） — 专为 ADReSS 类实验可复现性设计的 pipeline 框架。https://arxiv.org/pdf/2302.07322
- **billzyx/awesome-dementia-detection** — 持续更新的论文 list。https://github.com/billzyx/awesome-dementia-detection
- **wazeerzulfikar/alzheimers-dementia** — ADReSS 分类 + MMSE 回归 baseline，注释详尽，入门好起点。https://github.com/wazeerzulfikar/alzheimers-dementia
- **LinLLiu/AD** — 特征提取 + 分类器参考实现。https://github.com/LinLLiu/AD
- **NiliRahmani/Alzheimer-s-Dementia-Recognition-through-Spontaneous-Speech** — ADReSSo baseline。https://github.com/NiliRahmani/Alzheimer-s-Dementia-Recognition-through-Spontaneous-Speech
- **pcuenca/alzheimer** — 基于 Pitt 的 NLP + DL 早检 pipeline。https://github.com/pcuenca/alzheimer

### 4.7 音频标注 / VAD

- **WebRTC VAD**（`pip install webrtcvad`） — 快、轻量、几乎所有语音 pipeline 都用它做停顿检测。https://github.com/wiseman/py-webrtcvad
- **Silero VAD** — 神经 VAD，背景噪声下更鲁棒；faster-whisper 内部就用它。https://github.com/snakers4/silero-vad
- **pyAnnoteAudio** — 多说话人录音的说话人分离 + VAD。https://github.com/pyannote/pyannote-audio
- **Praat** — 手动标注金标准。CIU 编码（§2.4）或故事语法编码（§2.6）需要人工分级时用。
- **ELAN** — 多模态标注（音频 + 视频 + 多 tier）。手工标注韵律时常用。

### 4.8 失流畅检测

- **pariajm/deep-disfluency-detector** — 自相关神经网络，做填充词 / 修复检测。https://github.com/pariajm/deep-disfluency-detector
- **clp-research/deep_disfluency** — 对话语音的失流畅检测。https://github.com/clp-research/deep_disfluency

---

## 5. 近期论文（2024–2026）

### 综述 与 荟萃分析

- **de la Fuente Garcia, Ritchie & Luz**（2020）。 *Artificial Intelligence, speech, and language processing approaches to monitoring Alzheimer's Disease: a systematic review.* —— 这个领域的奠基综述。[J. Alzheimer's Disease](https://content.iospress.com/articles/journal-of-alzheimers-disease/jad200888)
- **Petti, Baker & Korhonen**（2020）。 *A systematic literature review of automatic Alzheimer's disease detection from speech and language.* —— [JAMIA](https://doi.org/10.1093/jamia/ocaa174)
- **Vincze 等**（2021）。 *Linguistic features for detecting Alzheimer's disease.* —— 语言学标志物盘点，英语 + 匈牙利语。
- **MCI 语音生物标志物诊断效用：系统综述与荟萃分析**（2025）。 —— *Age and Ageing* / PMC: https://pmc.ncbi.nlm.nih.gov/articles/PMC12560767/
- **Speech-based AD detection: AI techniques, datasets and challenges**（2024）。 —— *Artificial Intelligence Review:* https://link.springer.com/article/10.1007/s10462-024-10961-6
- **Explainable AI methods for speech-based cognitive decline detection: systematic review**（2025）。 —— *npj Digital Medicine:* https://www.nature.com/articles/s41746-025-02105-z

### 挑战赛综述

- **Luz 等**（2020）。 *Alzheimer's Dementia Recognition through Spontaneous Speech: The ADReSS Challenge.* —— Interspeech。
- **Luz 等**（2021）。 *Detecting Cognitive Decline Using Speech Only: The ADReSSo Challenge.* —— Interspeech。
- **Luz 等**（2023）。 *Overview of ADReSS-M.* —— https://pmc.ncbi.nlm.nih.gov/articles/PMC11218814/
- **Pérez-Toro 等**（2024）。 *Multilingual Speech and Language Analysis for the Assessment of MCI: TAUKADIAL Challenge Outcomes.* —— Interspeech。 https://www.isca-archive.org/interspeech_2024/pereztoro24_interspeech.html
- **Tao 等**（2024）。 *Early Dementia Detection Using Multiple Spontaneous Speech Prompts: The PROCESS Challenge.* —— arxiv https://arxiv.org/abs/2412.15230

### 方法类论文（近期）

- **Amini 等**（2024）。 *Prediction of Alzheimer's disease progression within 6 years using speech: leveraging language models.* —— *Alzheimer's & Dementia* / Wiley: https://alz-journals.onlinelibrary.wiley.com/doi/10.1002/alz.13886
- **Bang 等**（2024）。 *Alzheimer's disease recognition from spontaneous speech using large language models.* —— *ETRI Journal:* https://onlinelibrary.wiley.com/doi/full/10.4218/etrij.2023-0356
- **Lin 等**（2024，Framingham Heart Study）。 *Detection of MCI from non-semantic, acoustic voice features.* —— *JMIR Aging:* https://aging.jmir.org/2024/1/e55126
- **Shakeri 等**（2026）。 *Statistical analysis of interpretable linguistic features for MCI detection in bilingual speech.* —— *Alzheimer's & Dementia: Diagnosis, Assessment & Disease Monitoring:* https://alz-journals.onlinelibrary.wiley.com/doi/10.1002/dad2.70246
- **Frontiers Neuroinformatics 2025** —— *Enhancing dementia and cognitive decline detection with LLMs and speech representation learning.* —— https://www.frontiersin.org/journals/neuroinformatics/articles/10.3389/fninf.2025.1679664/full
- **Frontiers Aging Neuroscience 2024** —— *Screening for early AD: enhancing diagnosis with linguistic features and biomarkers.* —— https://www.frontiersin.org/journals/aging-neuroscience/articles/10.3389/fnagi.2024.1451326/full
- **JMIR Medical Informatics 2026** —— *MCI Detection System Based on Unstructured Spontaneous Speech: Longitudinal Dual-Modal Framework.* —— https://medinform.jmir.org/2026/1/e80883
- **Multimodal DL for dementia classification**（2024）。 —— *Scientific Reports:* https://www.nature.com/articles/s41598-024-64438-1
- **AI-Powered Speech Analysis: Automating Transcription, Embeddings, and Deep Learning**（2025，PMC）。 —— https://pmc.ncbi.nlm.nih.gov/articles/PMC12785146/
- **Translingual Language Markers for Cognitive Assessment from Spontaneous Speech**（PMC）。 —— https://pmc.ncbi.nlm.nih.gov/articles/PMC12885109/

---

## 6. 推荐阅读顺序

新成员上手 pipeline 的 1–2 天路径：

1. 通读本文 §1（10 分钟）。
2. **通读** [de la Fuente Garcia 等, 2020](https://content.iospress.com/articles/journal-of-alzheimers-disease/jad200888) 全文（约 1 小时）。这是领域奠基综述。
3. **读** **ADReSS 2020 挑战赛论文**（Luz 等, 2020）—— 让你掌握之后所有人使用的基准词汇。
4. 浏览本文 §4；克隆**一个**端到端 pipeline（推荐 `wazeerzulfikar/alzheimers-dementia`），复现其 ADReSS baseline。约 1 天。
5. **读** **2025 系统综述 + 荟萃分析**（[PMC12560767](https://pmc.ncbi.nlm.nih.gov/articles/PMC12560767/)）—— 看哪些结果真的复现得了。
6. **读** **TAUKADIAL 2024 概览** —— 双语场景相关，本实验室的项目原本就关心中英双语。
7. 从 §2 里挑一类（推荐 §2.2 *停顿 / 时间*）做一次完整复现 —— 这是真正在动手时学到本领的环节。

---

## 7. 文献引用

> URL 截至 2026 年 5 月已核验。引用采用锚点格式，§2 表里 `[name, year]` 可直跳到这里。

### 基础

- **Snowdon 等, 1996.** *Linguistic ability in early life and cognitive function and Alzheimer's disease in late life: findings from the Nun Study.* JAMA.
- **Riley 等, 2005.** *Early life linguistic ability, late life cognitive function, and neuropathology: findings from the Nun Study.* Neurobiology of Aging.
- **Honoré, 1979.** *Some simple measures of richness of vocabulary.* Association for Literary and Linguistic Computing Bulletin.
- **Brunét, 1978.** *Le vocabulaire de Jean Giraudoux: structure et évolution.* Slatkine.
- **Croisile 等, 1996.** *Comparative study of oral and written picture description in patients with Alzheimer's disease.* Brain and Language.
- **Almor 等, 1999.** *Why do Alzheimer's patients have difficulty with pronouns?* Brain and Language.
- **Glosser & Deser, 1991.** *Patterns of discourse production among neurological patients with fluent language disorders.* Brain and Language.
- **Bucks 等, 2000.** *Analysis of spontaneous, conversational speech in dementia of Alzheimer type.* Aphasiology.
- **Bschor 等, 2001.** *Spontaneous speech of patients with dementia of the Alzheimer type and mild cognitive impairment.* International Psychogeriatrics.
- **Kemper 等, 2001.** *Language decline across the life span: findings from the Nun Study.* —— https://www.semanticscholar.org/paper/Language-decline-across-the-life-span:-findings-the-Kemper-Greiner/926b402d5ecdf00853e9bdf2f5a6ff368f3c0a5e

### 特征方法

- **Eyben 等, 2015.** *The Geneva Minimalistic Acoustic Parameter Set (GeMAPS).* IEEE Trans. Affective Computing. https://sail.usc.edu/publications/files/eyben-preprinttaffc-2015.pdf
- **König 等, 2015.** *Automatic speech analysis for the assessment of patients with predementia and Alzheimer's disease.* Alzheimer's & Dementia: D, A & DM.
- **Sapir 等, 2010.** *Formant centralization ratio: a proposal for a new acoustic measure of dysarthric speech.* J. Speech, Language, and Hearing Research.
- **Heman-Ackah 等, 2003.** *Cepstral peak prominence: a more reliable measure of dysphonia.* Annals of Otology, Rhinology & Laryngology.
- **Meilán 等, 2014.** *Speech in Alzheimer's disease: can temporal and acoustic parameters discriminate dementia?* Dementia and Geriatric Cognitive Disorders.
- **Pistono 等, 2016.** *Pauses during autobiographical discourse reflect episodic memory processes in early Alzheimer's disease.* J. Alzheimer's Disease.
- **Toth 等, 2018.** *A speech recognition-based solution for the automatic detection of mild cognitive impairment from spontaneous speech.* Current Alzheimer Research.
- **Yuan 等, 2020.** *Disfluencies and fine-tuning pre-trained language models for detection of Alzheimer's disease.* Interspeech.
- **Roark 等, 2011.** *Spoken language derived measures for detecting mild cognitive impairment.* IEEE Trans. Audio, Speech, and Language Processing.
- **Pulido 等, 2020.** *Alzheimer's disease and automatic speech analysis: a review.* Expert Systems with Applications.
- **Martínez-Sánchez 等, 2017.** *Speech rhythm alterations in Spanish-speaking individuals with AD.* Aging, Neuropsychology, and Cognition.
- **Beltrami 等, 2018.** *Speech analysis by natural language processing techniques: a possible tool for very early detection of cognitive decline?* Frontiers in Aging Neuroscience.
- **Bortfeld 等, 2001.** *Disfluency rates in conversation.* Language and Speech.
- **Cuetos 等, 2007.** *Linguistic changes in verbal expression: a preclinical marker of Alzheimer's disease.* J. International Neuropsychological Society.
- **Wright 等, 2014.** *A method for elaborating discourse measures: implications for healthy adult and AD performance.* J. Speech-Language Pathology.
- **Troyer 等, 1997.** *Clustering and switching as two components of verbal fluency.* Neuropsychology.
- **Hoffmann 等, 2010.** *Temporal parameters of spontaneous speech in Alzheimer's disease.* J. Speech, Language, and Hearing Research.
- **Hoover 等, 2020.** *Word-finding pauses in Alzheimer's disease.* —— Aphasiology.
- **Covington & McFall, 2010.** *Cutting the Gordian knot: the moving-average type-token ratio.* J. Quantitative Linguistics.
- **Engelman 等, 2010.** *Propositional density and cognitive function in later life: findings from the Precursors Study.* —— https://pmc.ncbi.nlm.nih.gov/articles/PMC2954330/

### 数据集与语料库

- **Lanzi 等, 2023**（DementiaBank protocol 论文）。 —— https://pmc.ncbi.nlm.nih.gov/articles/PMC10171844/
- **Pope & Davis, 2011**（Carolinas Conversations Collection）。 —— *Topics in Geriatric Rehabilitation.*
- **Lu 等, 2009**（粤语 AphasiaBank Lu corpus）。 —— TalkBank 文档。
- **Lin 等, 2024**（Framingham Heart Study 嗓音队列）。 —— *JMIR Aging:* https://aging.jmir.org/2024/1/e55126

### 嵌入与深度方法

- **Balagopalan 等, 2021.** *Comparing pre-trained and feature-based models for prediction of Alzheimer's disease based on speech.* Frontiers in Aging Neuroscience.
- **Hsu 等, 2021.** *HuBERT: self-supervised speech representation learning by masked prediction of hidden units.* IEEE/ACM Trans. Audio, Speech, and Language Processing.
- **Radford 等, 2022.** *Robust speech recognition via large-scale weak supervision*（Whisper）。 OpenAI.
- **Reimers & Gurevych, 2019.** *Sentence-BERT: sentence embeddings using Siamese BERT-networks.* EMNLP.
- **Amini 等, 2024.** *Prediction of AD progression within 6 years using speech: leveraging language models.* —— https://alz-journals.onlinelibrary.wiley.com/doi/10.1002/alz.13886
- **Bang 等, 2024.** *AD recognition from spontaneous speech using LLMs.* ETRI Journal. —— https://onlinelibrary.wiley.com/doi/full/10.4218/etrij.2023-0356

### 双语 / 跨语言

- **Pérez-Toro 等, 2024**（TAUKADIAL 概览）。 —— https://www.isca-archive.org/interspeech_2024/pereztoro24_interspeech.html
- **Shakeri 等, 2026**（可解释语言学特征，双语）。 —— https://alz-journals.onlinelibrary.wiley.com/doi/10.1002/dad2.70246
- **Multilingual prediction of cognitive impairment with LLMs**（PMC）。 —— https://pmc.ncbi.nlm.nih.gov/articles/PMC11674350/

### 近期综述

- *Diagnostic utility of speech-based biomarkers in MCI*（2025，PMC）。 —— https://pmc.ncbi.nlm.nih.gov/articles/PMC12560767/
- *Explainable AI for speech-based cognitive decline detection*（2025，npj DM）。 —— https://www.nature.com/articles/s41746-025-02105-z
- *Speech-based detection of AD: AI techniques, datasets and challenges*（2024，Springer AIR）。 —— https://link.springer.com/article/10.1007/s10462-024-10961-6

---

*最后更新：2026-05-08。与可穿戴平台 repo 同步维护；新增条目走 `docs/research/` 的 PR，已在本仓库代码内实证过的特征请额外补一份 `docs/journeys/` 的 journey。*
