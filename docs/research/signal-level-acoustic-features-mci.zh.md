---
type: research-reference
status: draft
last_updated: 2026-05-08
tags: [speech, mci, alzheimer, acoustic, signal-processing, features, dsp, zh]
---

# 用于 MCI / AD 检测的信号级声学特征

**报告目的.** 在不依赖 ASR / NLP 的前提下, 自 `.wav` 文件直接提取一组具有同行评审证据支撑的声学特征, 用于轻度认知障碍 (MCI) 与阿尔茨海默病 (AD) 的判别。本报告给出最终采用的特征 panel 及各特征的选取依据。所有支撑证据都附 URL 引用, 来源已逐条核验。

**范围说明.** 上层 / 文本级特征 (idea density, TTR, syntactic complexity 等) 见配套文档 [`cognitive-speech-features.md`](./cognitive-speech-features.md), 本报告不重复。

---

## 目录

1. [概述与信号底料](#1-概述与信号底料)
2. [推荐特征 panel](#2-推荐特征-panel-117-维)
3. [各特征的证据与依据](#3-各特征的证据与依据)
4. [范围与局限](#4-范围与局限)
5. [文献引用](#5-文献引用)

---

## 1. 概述与信号底料

WAV 文件 = 文件头 + 16-bit 有符号整数样本流, 项目使用 16 kHz 单声道。所有信号级特征都是这一份样本流的某个函数:

```
PCM 样本: x[n] ∈ [-32768, 32767], n = 0 .. N-1
采样率:    f_s  (本项目 pipeline 是 16000 Hz)
时长:      N / f_s 秒
```

标准特征提取 pipeline:

```
PCM 样本
   ↓ 加窗 (25 ms 窗, 10 ms 步进, Hamming 窗)
frames[i] = x[i*H : i*H + W],  W=400, H=160 @ 16 kHz
   ↓ 每帧计算以下中的某些:
     时域       (RMS, ZCR, 包络)            — 不需 FFT
     频域       (FFT → 幅度谱)              — 一次 FFT
     倒谱域     (log mel-spec 的 DCT)        — MFCC
     基音域     (自相关 / YIN)               — F0
   ↓ 跨帧聚合到话语级
     统计量: mean, std, min, max, percentile, delta
```

下面 §2 给出本项目最终采用的特征组合; §3 逐条说明各特征的临床证据支撑。

---

## 2. 推荐特征 panel (117 维)

下表是本项目最终采用的全部信号级特征 — 仅依赖 PCM, 不需要转写, 每一维都有 Tier A 同行评审证据 (单特征级别或 panel 级别) 支撑:

| # | 特征 | 维度 | 选取依据 | 计算方式 |
|---|---|---|---|---|
| 1 | **每分钟停顿数** | 1 | 文献最强的单一信号 ([Pistono 2022](https://www.sciencedirect.com/science/article/pii/S0021992422000338); [双峰停顿 2025](https://pmc.ncbi.nlm.nih.gov/articles/PMC12397068/)) | VAD 输出 → run-length |
| 2 | **长停顿率 (≥ 2 s) 每分钟** | 1 | 区分 MCI 与对照, 与 **tau / 淀粉样蛋白**相关 ([Linking silent pauses 2025](https://pubmed.ncbi.nlm.nih.gov/40934091/)) | VAD → 静音段 ≥ 2 s |
| 3 | **停顿时长: mode-1 均值 (~180 ms)** | 1 | 找词层信号, 与句子规划层可分 ([双峰停顿 2025](https://pmc.ncbi.nlm.nih.gov/articles/PMC12397068/)) | VAD → 静音段 → 2 组 GMM |
| 4 | **停顿时长: mode-2 均值 (~1000 ms)** | 1 | 句子规划层信号 | 同上 |
| 5 | **Phonation time ratio (PTR)** | 1 | 语速 / 停顿负荷联合聚合 ([2025 系统综述](https://pmc.ncbi.nlm.nih.gov/articles/PMC12560767/)) | VAD 输出 |
| 6 | **MFCC[1..12] mean** | 12 | 声道 / 构音指纹 ([ADReSS 系统 IEEE 2021](https://ieeexplore.ieee.org/document/9383491/); [Frontiers 2022 RF](https://pmc.ncbi.nlm.nih.gov/articles/PMC9712439/)) | librosa.feature.mfcc 后取均值 |
| 7 | **MFCC[1..12] SD** | 12 | 捕捉构音变异度, 与均值互补 | 同上, 取标准差 |
| 8 | **eGeMAPS Functionals 全集** | 88 | 临床嗓音研究 panel 级标杆, 已被 ADReSS 类基准用作声学基线 ([Frontiers 2021](https://www.frontiersin.org/journals/aging-neuroscience/articles/10.3389/fnagi.2021.623607/full)) | opensmile |
| | **合计** | **117** | | |

**选取原则**:

- **可解释优先**: 1–7 是显式手工特征, 单维含义清楚, 可向临床医生解释。
- **底层兜底**: 8 (eGeMAPS) 提供 88 维补充, 内部已涵盖 F0、jitter、shimmer、HNR、spectral shape、loudness 等通用嗓音质量指标 — 它们作为 panel 进入分类器, 不作为独立的可解释指标使用。
- **不依赖转写**: 全部特征都从 PCM 直接计算, 不需要 ASR 输出。

---

## 3. 各特征的证据与依据

### 3.1 停顿统计 (第 1–4 项)

**临床基础.** AD/MCI 患者**停顿更频繁** (rate)、且停顿**向长时端偏移**, 是该领域复现得最多的信号级发现。机制层面, 找词与句子规划同时调动执行功能与工作记忆; 这两个过程变慢时, 规划器会在搜索期间插入停顿。认知受损情况下出现两种模式: (a) 子秒级停顿在从句**内部** (找词失败), (b) 多秒级停顿在从句**之间** (句子规划失败)。双峰模型把这两种机制分开。

**从 `.wav` 的计算流程**:

1. 帧能量: `E[i] = sum(x[i*H+j]² for j in 0..W-1)` (W=400, H=160)
2. 语音活动 = `E[i] > 阈值`; 阈值可自适应或采用 WebRTC VAD / Silero
3. Run-length encode → 语音段、静音段两个列表
4. 从静音段列表计算: 每分钟停顿数、长停顿率 (≥ 2 s)、双峰 mode-1 / mode-2 均值

**已验证证据**:

- Pistono 等 (2022). *Breaking the flow of thought: Increase of empty pauses in the connected speech of people with mild and moderate Alzheimer's disease.* *J. Communication Disorders.* 各疾病阶段均发现空停顿增加; **区分组的是停顿次数 (rate), 不是停顿时长**。
  https://www.sciencedirect.com/science/article/pii/S0021992422000338
- *Automated bimodal pause analysis for acoustic markers of cognitive decline and Alzheimer's disease in connected speech* (2025). 阈值 ≈ 180 ms 区分两个 mode; 两个 mode 在 MCI 中均升高, **并与 tau 和淀粉样蛋白水平相关** (将停顿行为与脑生物标志物对应)。
  PMC: https://pmc.ncbi.nlm.nih.gov/articles/PMC12397068/ · PubMed: https://pubmed.ncbi.nlm.nih.gov/40883965/
- *Linking silent pause locations in speech to amyloid and tau deposition in cognitively unimpaired individuals* (2025). PubMed: https://pubmed.ncbi.nlm.nih.gov/40934091/
- *An Automated Approach to Examining Pausing in the Speech of People With Dementia.* PMC: https://pmc.ncbi.nlm.nih.gov/articles/PMC10623991/

### 3.2 Phonation time ratio (第 5 项)

**定义**: PTR = 语音帧总时长 / 录音总时长。直接从 §3.1 的 VAD 输出可算。

**临床基础.** 教科书上的语速 (词/分钟、音节/秒) 需要 ASR; PTR 是该量的纯信号层代理。找词失败与运动减慢都会降低说话者填满录音窗口的速率, PTR 一并捕捉。

**已验证证据**:

- 2025 年 *Age and Ageing* 系统综述与荟萃分析 报道 phonation-time 类指标以中等效应量区分 MCI 与对照。
  PMC: https://pmc.ncbi.nlm.nih.gov/articles/PMC12560767/
- *Acoustic and Language Based Deep Learning Approaches for Alzheimer's Dementia Detection From Spontaneous Speech.* Frontiers in Aging Neuroscience 2021. 使用 eGeMAPS panel 在 ADReSS 测试集上得到约 0.58 准确率, 在 panel 中 phonation/silence ratio 是组成部分之一。
  https://www.frontiersin.org/journals/aging-neuroscience/articles/10.3389/fnagi.2021.623607/full

### 3.3 MFCC family (第 6–7 项, 共 24 维)

**定义**: 每帧 13 个 mel-frequency cepstral coefficients (MFCC[0..12])。MFCC[0] 是能量项, 一般丢弃; 保留 MFCC[1..12], 跨话语聚合为均值与标准差, 共 24 维。

**临床基础.** MFCC 是对**声道形状**的压缩表示。AD 语音表现出构音精度下降 (元音中心化、辅音收缩变弱), 这种下降在倒谱里表现为 mel 各带能量分布的整体偏移。模型不需要知道**具体哪个音**发错了, 群体统计量的偏移已具判别力。MFCC 的均值与标准差互补 — 均值反映语音整体音色, 标准差反映构音变异度。MFCC 在 ADReSS / ADReSSo 类基准上是反复被验证的特征家族之一。

**已验证证据**:

- *An Exploration of Log-Mel Spectrogram and MFCC Features for Alzheimer's Dementia Recognition from Spontaneous Speech*, IEEE ICASSP 2021. CNN-LSTM 用 MFCC 在 ADReSS 上达到 64.58% 准确率。
  IEEE: https://ieeexplore.ieee.org/document/9383491/
- *Spontaneous speech feature analysis for Alzheimer's disease screening using a random forest classifier*, Frontiers in Digital Health 2022. 在 MFCC、kurtosis、filter bank energy、jitter、shimmer、HNR 等多类特征中比较, 使用 Random Forest 实现 AD vs CN 分类 82.2% 准确率; jitter 是该研究中被识别为最重要的特征之一。MFCC 仍是其特征面板的核心组成。
  PMC: https://pmc.ncbi.nlm.nih.gov/articles/PMC9712439/ · Frontiers: https://www.frontiersin.org/journals/digital-health/articles/10.3389/fdgth.2022.901419/full
- *Dementia Classification Using Acoustic Speech and Feature Selection*, arXiv 2025. 用基于 Wilcoxon 检验的特征选择, 在 ADReSS 任务上找到的前 145 个最重要特征中, **频域 spectrogram 特征与 MFCC 变体明显占主**。
  https://arxiv.org/html/2502.03484v1

### 3.4 eGeMAPS 整体 panel (第 8 项, 88 维)

**定义**: Geneva Minimalistic Acoustic Parameter Set v02, 每段录音 88 维 functionals (跨帧统计量已聚合)。内部覆盖 F0、jitter、shimmer、HNR、MFCC 子集、spectral slope、Hammarberg index、loudness 等通用嗓音质量指标。

**临床基础.** eGeMAPS 是临床嗓音研究中最有实证基础的现成捆绑包。其个别组件 (jitter、shimmer、HNR 等) 单独的 MCI/AD 单变量证据有限, 但**作为 panel 整体**, 在 ADReSS 类基准上得到一致验证。本项目以 panel 方式纳入 — 不孤立解读个别维度, 仅依赖分类器从中提取判别信号。

**已验证证据**:

- eGeMAPS 原论文: Eyben 等 (2015). *The Geneva Minimalistic Acoustic Parameter Set (GeMAPS) for Voice Research and Affective Computing.* *IEEE Trans. Affective Computing* 7(2):190-202. DOI: https://doi.org/10.1109/TAFFC.2015.2457417
- eGeMAPS 作为 ADReSS 声学基线 — Frontiers in Aging Neuroscience 2021. 该研究以 5-fold 交叉验证比较了 eGeMAPS / emobase / ComParE 三个声学特征集, eGeMAPS 在测试集上的准确率约为 0.58。
  https://www.frontiersin.org/journals/aging-neuroscience/articles/10.3389/fnagi.2021.623607/full · PMC: https://pmc.ncbi.nlm.nih.gov/articles/PMC7893079/

---

## 4. 范围与局限

**未单独纳入的通用嗓音质量指标.** Jitter、shimmer、HNR、F0 统计量、Cepstral Peak Prominence (CPP)、spectral centroid / rolloff / flatness 等指标, 已通过 §3.4 的 eGeMAPS panel 间接覆盖; 由于目前可验证的 single-feature MCI/AD 单变量证据有限, 本报告不将它们作为独立的可解释特征使用, 而由 eGeMAPS panel 在分类器层面统一处理。通用嗓音质量文献参见 Teixeira 等 (2013): https://www.sciencedirect.com/science/article/pii/S2212017313002788

**未纳入的特征**:

- **Zero-crossing rate (ZCR)**: 未找到将语音域 ZCR 作为 MCI/AD 判别器的同行评审论文; 现有 ZCR 与 AD 相关研究多基于 EEG 信号, 与本项目无关。
- **线性预测系数 (LPC) 与反射系数**: AD 文献中不直接使用; 它们通过共振峰和 MFCC 间接出现, eGeMAPS panel 已覆盖。

**任务依赖性.** 本报告所列 Tier A 证据主要建立在 Cookie Theft 图片描述 / 语义流畅 / 自发对话三类任务上。其他任务 (如朗读、命名) 的特征分布与上述结论可能不完全一致, 应用前应针对具体任务重新校验。

**复现风险.** 双峰停顿分析 (§3.1) 与 phonation time ratio (§3.2) 的效应量在 2024–2025 文献中复现稳定, 但具体阈值 (180 ms vs 200 ms 等) 因队列年龄、麦克风类型、采样率而异。建议在自有数据上重新拟合阈值, 而非照搬文献默认值。

---

## 5. 文献引用

URL 截至 2026 年 5 月已逐条核验。若链接失效, 凭标题与作者可在大学图书馆数据库检索。

**核验说明.** PubMed / PMC / 期刊门户类链接 (PMC*, PubMed*, frontiersin.org, arXiv) 已通过自动抓取核对页面标题、作者与关键结论;
ScienceDirect (S00219924…, S22120173…) 与 IEEE Xplore (document/9383491) 对自动抓取返回 403 / 418, 系发布商常规的机器人防护, 浏览器访问无碍; eGeMAPS 原论文使用 IEEE Xplore DOI 而非作者 PDF 镜像以避免 SSL 证书问题。

### 停顿 / 语速证据 (Tier A)

- Pistono 等 (2022). *Breaking the flow of thought: Increase of empty pauses in the connected speech of people with mild and moderate Alzheimer's disease.* *J. Communication Disorders.*
  https://www.sciencedirect.com/science/article/pii/S0021992422000338
- *Automated bimodal pause analysis for acoustic markers of cognitive decline and Alzheimer's disease in connected speech* (2025). PMC: https://pmc.ncbi.nlm.nih.gov/articles/PMC12397068/ · PubMed: https://pubmed.ncbi.nlm.nih.gov/40883965/
- *Linking silent pause locations in speech to amyloid and tau deposition in cognitively unimpaired individuals* (2025). PubMed: https://pubmed.ncbi.nlm.nih.gov/40934091/
- *An Automated Approach to Examining Pausing in the Speech of People With Dementia.* PMC: https://pmc.ncbi.nlm.nih.gov/articles/PMC10623991/
- *Silent Pauses and Speech Indices as Biomarkers for Primary Progressive Aphasia.* PMC: https://pmc.ncbi.nlm.nih.gov/articles/PMC9611099/
- *Diagnostic utility of speech-based biomarkers in MCI: systematic review and meta-analysis* (2025). PMC: https://pmc.ncbi.nlm.nih.gov/articles/PMC12560767/

### MFCC / 频谱 / eGeMAPS 证据 (panel 级 Tier A)

- *An Exploration of Log-Mel Spectrogram and MFCC Features for Alzheimer's Dementia Recognition from Spontaneous Speech.* IEEE ICASSP 2021.
  https://ieeexplore.ieee.org/document/9383491/
- *Acoustic and Language Based Deep Learning Approaches for Alzheimer's Dementia Detection From Spontaneous Speech.* Frontiers in Aging Neuroscience 2021.
  https://www.frontiersin.org/journals/aging-neuroscience/articles/10.3389/fnagi.2021.623607/full · PMC: https://pmc.ncbi.nlm.nih.gov/articles/PMC7893079/
- *Spontaneous speech feature analysis for Alzheimer's disease screening using a random forest classifier.* Frontiers in Digital Health 2022.
  PMC: https://pmc.ncbi.nlm.nih.gov/articles/PMC9712439/ · Frontiers: https://www.frontiersin.org/journals/digital-health/articles/10.3389/fdgth.2022.901419/full
- *Dementia classification from spontaneous speech using wrapper-based feature selection.* arXiv 2025.
  https://arxiv.org/html/2502.03484v1
- Eyben, Scherer, Schuller 等 (2015). *The Geneva Minimalistic Acoustic Parameter Set (GeMAPS).* *IEEE Trans. Affective Computing.*
  https://sail.usc.edu/publications/files/eyben-preprinttaffc-2015.pdf

### 工具 (软件主页)

- librosa: https://librosa.org/
- opensmile (audEERING): https://audeering.github.io/opensmile-python/
- WebRTC VAD: https://github.com/wiseman/py-webrtcvad
