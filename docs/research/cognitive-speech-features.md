---
type: research-reference
status: draft
last_updated: 2026-05-08
tags: [speech, mci, alzheimer, cognitive-assessment, features, biomarkers, literature]
---

# Speech-Based Cognitive Assessment — Feature Reference

**Scope.** A working reference for features, datasets, open-source tools, and recent
literature relevant to detecting **Mild Cognitive Impairment (MCI)**, **prodromal
Alzheimer's disease (AD)**, and **early dementia** from connected speech.

**Audience.** Project members building the wearable + companion pipeline; the lab's
extension authors (Whisper, future cognitive-feature extractor); collaborators reading
in for context.

**Conventions.** Every claim about a feature's clinical association is supported by at
least one peer-reviewed citation in §7. Where multiple sources agree, the table lists
the strongest review or meta-analysis. Tool entries link to upstream repos with the
most recent active maintenance.

---

## Table of contents

1. [Background](#1-background)
2. [Feature taxonomy](#2-feature-taxonomy)
   - 2.1 [Acoustic / signal-level](#21-acoustic--signal-level-features)
   - 2.2 [Temporal / prosodic / pause](#22-temporal--prosodic--pause-features)
   - 2.3 [Lexical / vocabulary](#23-lexical--vocabulary-features)
   - 2.4 [Semantic / propositional](#24-semantic--propositional-features)
   - 2.5 [Syntactic](#25-syntactic-features)
   - 2.6 [Discourse / pragmatic](#26-discourse--pragmatic-features)
   - 2.7 [Disfluency](#27-disfluency-features)
   - 2.8 [Deep / representation-learning](#28-deep--representation-learning-features)
3. [Public datasets & challenges](#3-public-datasets--challenges)
4. [Open-source toolchain](#4-open-source-toolchain)
5. [Selected recent papers (2024–2026)](#5-selected-recent-papers-20242026)
6. [Recommended reading order](#6-recommended-reading-order)
7. [References](#7-references)

---

## 1. Background

### 1.1 Why speech as a cognitive biomarker

Connected speech recruits memory, attention, executive function, semantic memory, and
motor planning **simultaneously**. Subtle decline in any of these surfaces in the
acoustic stream (slower rate, more pauses) or the linguistic stream (smaller
vocabulary, less complex syntax, less specific content) — often **years before** a
clinical diagnosis lands. The classic demonstration is the *Nun Study*: 14 sisters
who later died with neuropathologically confirmed AD all had **low idea density in
autobiographies written in their early 20s**, decades before symptoms ([Snowdon et
al., 1996; Riley et al., 2005](#7-references)).

Speech is also **ecologically valid** (collected passively in conversation), **low
cost**, and **language-independent in its acquisition** even if interpretation is
language-specific. Recent reviews
([Vincze et al., 2021](#7-references);
[de la Fuente Garcia et al., 2020](#7-references);
[Petti et al., 2020](#7-references); [systematic review 2025](https://pmc.ncbi.nlm.nih.gov/articles/PMC12560767/))
converge on the same finding: a small panel of speech features (~10–30 carefully chosen
ones, see §2) discriminates MCI from healthy controls with AUC ~ 0.75–0.85, before
any neuroimaging or fluid biomarker is collected.

### 1.2 The cognition → speech mapping

| Cognitive domain | Speech manifestation | Feature category (§2) |
|---|---|---|
| **Episodic memory** | Word-finding pauses, more pronouns / fewer specific nouns | Lexical, Disfluency |
| **Semantic memory** | Lower vocabulary diversity, less specific content units, lower idea density | Lexical, Semantic |
| **Attention** | Longer response latency, more filled pauses | Temporal, Disfluency |
| **Executive function** | Shorter / less complex sentences, topic drift | Syntactic, Discourse |
| **Working memory** | Self-corrections, restarts, partial words | Disfluency, Syntactic |
| **Motor control** | Reduced articulation rate, jitter / shimmer changes, altered prosody | Acoustic, Prosodic |

This mapping is empirical, not deterministic — a single feature deviation has many
possible causes (mood, fatigue, second-language effects). Robust systems combine
features across categories and treat each as one signal in a panel.

### 1.3 Standard acquisition tasks

| Task | Cognitive load | Notes |
|---|---|---|
| **Cookie Theft picture description** | Semantic + discourse | The most-used task in the field — basis of the Pitt corpus & every ADReSS challenge. ~60-second monologue describing a kitchen scene from the Boston Diagnostic Aphasia Examination. |
| **Verbal fluency (semantic / phonemic)** | Lexical access + executive control | "Name as many animals as you can in 60 seconds" / "words starting with F". Quick, well-validated. |
| **Story recall (Logical Memory)** | Episodic memory + narrative production | Subject hears a short story, retells immediately and again 30 min later. WMS-IV subtest. |
| **Reading aloud / passage reading** | Articulation, prosody | Eliminates linguistic-content variance — useful for isolating acoustic motor changes. |
| **Free conversation / interview** | All domains naturally | Most ecologically valid but hardest to analyze. The TalkBank Carolinas Conversations Collection is the canonical source. |
| **Naming tasks (Boston Naming Test)** | Semantic retrieval | Diagnostic when results graded; cognitively less rich for free-form feature extraction. |

The project's call-page audio (free spontaneous conversation with prosodic / pausing
data already captured) sits closest to the **conversation / Cookie Theft** end of the
spectrum — and is the most informative for feature-based MCI screening.

---

## 2. Feature taxonomy

Each subsection below has one summary table. Columns are:

- **Feature** — the metric, English name.
- **Unit / range** — what it measures and typical scale.
- **MCI/AD direction** — `↑` more in MCI/AD, `↓` less, `≠` differs but direction is
  task-dependent.
- **Tool** — open-source extraction tool (links in §4).
- **Ref** — one anchor citation (full entry in §7).

### 2.1 Acoustic / signal-level features

Computed from the raw audio without transcript. Captures **how** the speech sounds,
independent of the words.

| Feature | Unit / range | MCI/AD direction | Tool | Ref |
|---|---|---|---|---|
| **F0 (fundamental frequency) mean** | Hz, 80–250 typical | ≠ (often lower variability in AD) | OpenSMILE, parselmouth | [eGeMAPS paper](https://sail.usc.edu/publications/files/eyben-preprinttaffc-2015.pdf) |
| **F0 variability (SD / range)** | Hz | ↓ (monotone speech) | OpenSMILE | [eGeMAPS paper](https://sail.usc.edu/publications/files/eyben-preprinttaffc-2015.pdf) |
| **Jitter (local, ppq5, rap)** | % (typically 0.5–3%) | ↑ (vocal-fold instability) | praat / parselmouth, DisVoice | [Meilán et al., 2014](#7-references) |
| **Shimmer (local, apq3, apq5)** | dB or % | ↑ | praat / parselmouth, DisVoice | [Meilán et al., 2014](#7-references) |
| **HNR (harmonics-to-noise ratio)** | dB, 10–30 dB normal | ↓ (breathier voice) | praat, DisVoice | [eGeMAPS paper](https://sail.usc.edu/publications/files/eyben-preprinttaffc-2015.pdf) |
| **Formant frequencies (F1, F2, F3)** | Hz | ≠ (F2 dispersion shrinks in dysarthria) | praat / parselmouth | [DisVoice docs](https://github.com/jcvasquezc/DisVoice) |
| **Formant centralization ratio (FCR)** | unitless | ↑ (vowels centralize) | praat / parselmouth | [Sapir et al., 2010](#7-references) |
| **MFCCs (1–13)** | unitless, summary stats | ≠ (discriminative in classifiers) | librosa, OpenSMILE | [Luz et al., ADReSSo 2021](#7-references) |
| **Spectral flux / centroid / slope / Hammarberg index** | various | ≠ | OpenSMILE (eGeMAPS) | [eGeMAPS paper](https://sail.usc.edu/publications/files/eyben-preprinttaffc-2015.pdf) |
| **Voice quality (CPP — cepstral peak prominence)** | dB | ↓ | praat, VoiceLab | [Heman-Ackah et al., 2003](#7-references) |
| **Energy / loudness (RMS, dBA)** | dB | ↓ in some AD studies | librosa, OpenSMILE | [Framingham 2024](https://aging.jmir.org/2024/1/e55126) |

### 2.2 Temporal / prosodic / pause features

The single most reproducible signal of cognitive decline in spontaneous speech.
**Pause patterns alone** drive much of the AUC reported in ADReSS-class benchmarks.

| Feature | Unit / range | MCI/AD direction | Tool | Ref |
|---|---|---|---|---|
| **Speech rate** | words/min or syllables/sec | ↓ | textgrid + VAD | [König et al., 2015](#7-references) |
| **Articulation rate** | syllables / phonation time | ↓ | textgrid + VAD | [König et al., 2015](#7-references) |
| **Phonation time ratio** | speech-time / total-time | ↓ | VAD | [Pulido et al., 2020](#7-references) |
| **Total speech duration** | sec | ≠ (task-dependent) | VAD | — |
| **Pause count (>0.2 s)** | n / minute | ↑ | VAD, py-webrtcvad | [Yuan et al., 2020](#7-references) |
| **Pause mean duration** | ms | ↑ | VAD | [Pistono et al., 2016](#7-references) |
| **Pause duration variability (SD)** | ms | ↑ | VAD | [König et al., 2015](#7-references) |
| **Long pause rate (≥ 2 s)** | n / minute | ↑↑ (strong signal) | VAD | [Toth et al., 2018](#7-references); [systematic review 2025](https://pmc.ncbi.nlm.nih.gov/articles/PMC12560767/) |
| **Silent : filled pause ratio** | unitless | ↑ silent dominance | VAD + ASR | [Pistono et al., 2016](#7-references) |
| **Inter-pausal unit length** | words / IPU | ↓ | VAD + ASR | [Pulido et al., 2020](#7-references) |
| **Rhythm metrics (%V, ΔC, nPVI)** | unitless | ≠ (consonant timing more variable) | Correlatore | [Martínez-Sánchez 2017](#7-references) |
| **Voice onset time variability** | ms SD | ↑ | praat | [Pulido et al., 2020](#7-references) |

> The **TAUKADIAL 2024** bilingual challenge confirmed that pause-based features
> generalize cross-language: in both English and Chinese MCI speech, the long-pause
> rate is one of the top-2 discriminators ([Pérez-Toro et al., 2024](#7-references)).

### 2.3 Lexical / vocabulary features

Requires a transcript (Whisper / wav2vec2 / human). Captures **what words** the
speaker chooses.

| Feature | Unit / range | MCI/AD direction | Tool | Ref |
|---|---|---|---|---|
| **Type-token ratio (TTR)** | unitless, 0–1 | ↓ (less lexical variety) | spaCy + custom | [Bucks et al., 2000](#7-references) |
| **Moving-average TTR (MATTR, w=50)** | unitless | ↓ (TTR robust to length) | textstat | [Covington & McFall, 2010](#7-references) |
| **Honoré's statistic (R)** | unitless | ↓ | textstat | [Honoré, 1979](#7-references) |
| **Brunét's index (W)** | unitless | ↑ (smaller vocabulary → larger W) | textstat | [Brunét, 1978](#7-references) |
| **Mean word length** | chars | ↓ (shorter words) | basic NLP | [Bucks et al., 2000](#7-references) |
| **Word frequency (avg log-freq, SUBTLEX)** | log freq | ↑ (more common words used) | wordfreq | [Almor et al., 1999](#7-references) |
| **Content word ratio** | content / total | ↓ | spaCy POS | [Bucks et al., 2000](#7-references) |
| **Pronoun : noun ratio** | unitless | ↑ ("the thing" instead of named entity) | spaCy POS | [Almor et al., 1999](#7-references); [Vincze et al., 2021](#7-references) |
| **Light verb ratio** (be, have, do, get, go, make) | content-verbs only | ↑ | spaCy POS | [Bschor et al., 2001](#7-references) |
| **Empty word rate** ("thing", "stuff", "something") | n / 100 words | ↑ | custom lexicon | [Almor et al., 1999](#7-references) |
| **POS distribution (entropy)** | bits | ↑ in healthy controls | spaCy POS | [Roark et al., 2011](#7-references) |
| **Numeral / participle use (bilingual marker)** | n / 100 words | ↑ in MCI per TAUKADIAL | spaCy POS | [Shakeri et al., 2026](#7-references) |

### 2.4 Semantic / propositional features

The "**how informative**" axis. Most predictive of progression from MCI to AD in
longitudinal studies.

| Feature | Unit / range | MCI/AD direction | Tool | Ref |
|---|---|---|---|---|
| **Propositional idea density (P-density)** | propositions per 10 words; ~4–6 typical | ↓ | CPIDR | [Snowdon et al., 1996](#7-references); [Riley et al., 2005](#7-references); [Engelman et al., 2010](#7-references) |
| **Content information units (CIU) — Cookie Theft** | count of named referents (sink, woman, cookie jar, …) | ↓ | manual or rule-based | [Croisile et al., 1996](#7-references) |
| **Semantic similarity to picture template (cosine, SBERT)** | 0–1 | ↓ | sentence-transformers | [Eyigoz et al., 2020](#7-references) |
| **Semantic coherence (consecutive utterance cosine)** | 0–1, lower variance in MCI | ≠ (lower mean, flatter trajectory) | sentence-transformers | [Hoffmann et al., 2010](#7-references) |
| **Semantic verbal fluency cluster size** | items per cluster | ↓ | scoring rubric | [Troyer et al., 1997](#7-references) |
| **Semantic switches in fluency task** | n switches | ↑ in healthy controls | scoring rubric | [Troyer et al., 1997](#7-references) |
| **Topic drift (sliding-window similarity SD)** | unitless | ↑ in MCI | sentence-transformers | [Beltrami et al., 2018](#7-references) |
| **Specificity of reference (named-entity / total NPs)** | unitless | ↓ | spaCy NER | [Vincze et al., 2021](#7-references) |

> **Idea density** deserves its own callout. The Nun Study finding — that
> autobiographies written **in the early 20s** predicted AD risk decades later — is
> the strongest evidence we have that some speech features index lifetime cognitive
> reserve, not just current state. Lower density = ~5× elevated AD risk
> ([Snowdon et al., 1996](#7-references)). Replicated in the Precursors Study
> ([Engelman et al., 2010](#7-references)) and the Nun Study extension
> ([Riley et al., 2005](#7-references)).

### 2.5 Syntactic features

How **structured** the speech is. Often slower-changing than lexical features; useful
for tracking progression rather than initial detection.

| Feature | Unit / range | MCI/AD direction | Tool | Ref |
|---|---|---|---|---|
| **Mean length of utterance (MLU)** | words/utterance | ↓ | CLAN, spaCy | [Bschor et al., 2001](#7-references) |
| **Sentence length SD** | words | ↓ (less variation) | spaCy | [Vincze et al., 2021](#7-references) |
| **Yngve depth (mean / max)** | unitless | ↓ (less embedded structure) | benepar | [Roark et al., 2011](#7-references) |
| **Dependency tree depth / width** | unitless | ↓ | spaCy parser | [Roark et al., 2011](#7-references) |
| **Subordinate clause rate** | subordinate / main clauses | ↓ | spaCy / benepar | [Kemper et al., 2001](#7-references) |
| **Embedded clause rate** | n / 100 words | ↓ | benepar | [Roark et al., 2011](#7-references) |
| **Frazier score (left-branching complexity)** | unitless | ↓ | benepar | [Roark et al., 2011](#7-references) |
| **Verb-tense diversity (entropy)** | bits | ↓ in MCI | spaCy POS | [Vincze et al., 2021](#7-references) |
| **Phrase-structure rule diversity** | unique rules / 100 words | ↓ | benepar | [Roark et al., 2011](#7-references) |
| **Auxiliaries / modals per clause** | unitless | ≠ | spaCy POS | [Bschor et al., 2001](#7-references) |

### 2.6 Discourse / pragmatic features

How the speaker **structures the entire turn**.

| Feature | Unit / range | MCI/AD direction | Tool | Ref |
|---|---|---|---|---|
| **Coherence (global, consecutive sentence cosine)** | 0–1 | ↓ | sentence-transformers | [Hoffmann et al., 2010](#7-references) |
| **Topic maintenance ratio** | on-topic / total utterances | ↓ | manual or topic models | [Glosser & Deser, 1991](#7-references) |
| **Referential clarity (anaphor → antecedent distance)** | words | ↑ (vaguer references) | coreference resolver | [Almor et al., 1999](#7-references) |
| **Repetition rate (verbatim, n-gram match within transcript)** | n / 100 words | ↑ | string match | [Pistono et al., 2016](#7-references) |
| **Information transfer rate (CIU per minute)** | CIU/min | ↓ | manual + duration | [Croisile et al., 1996](#7-references) |
| **Discourse marker rate (well, you know, so, anyway)** | n / 100 words | ↑ | lexicon | [Cuetos et al., 2007](#7-references) |
| **Story grammar completeness** | % obligatory story elements present | ↓ | annotation rubric | [Wright et al., 2014](#7-references) |
| **Pragmatic pacing — turn-taking latency in dialogue** | ms | ↑ | conversational ASR | — |

### 2.7 Disfluency features

What linguists used to call "ums and uhs" — actually a rich signal of cognitive load
and word-finding difficulty.

| Feature | Unit / range | MCI/AD direction | Tool | Ref |
|---|---|---|---|---|
| **Filled pause rate** ("uh", "um", "er") | n / 100 words | ↑ | ASR + lexicon, [deep-disfluency-detector](https://github.com/clp-research/deep_disfluency) | [Pistono et al., 2016](#7-references) |
| **Word repetition rate** ("the the the") | n / 100 words | ↑ | string match | [Pistono et al., 2016](#7-references) |
| **Phrase repetition rate** | n / 100 words | ↑ | n-gram match | [Pistono et al., 2016](#7-references) |
| **False start / restart rate** | n / 100 words | ↑ | manual or [pariajm/deep-disfluency-detector](https://github.com/pariajm/deep-disfluency-detector) | [Bortfeld et al., 2001](#7-references) |
| **Partial word rate** (cut-off mid-utterance) | n / 100 words | ↑ | manual | [Bortfeld et al., 2001](#7-references) |
| **Self-correction rate** | n / 100 words | ↑ | manual or auto | [Pistono et al., 2016](#7-references) |
| **Filler : silent-pause ratio** | unitless | ↓ (silent pauses dominate in AD) | combined | [Pistono et al., 2016](#7-references) |
| **Word-finding pause** (pause >0.5 s preceding low-freq word) | n / 100 words | ↑ | VAD + ASR + freq lookup | [Hoover et al., 2020](#7-references) |

### 2.8 Deep / representation-learning features

Embeddings as features in their own right. State of the art on ADReSS-class
benchmarks as of 2024–2026.

| Feature | What it is | MCI/AD use | Tool | Ref |
|---|---|---|---|---|
| **wav2vec 2.0 embeddings (1024-d)** | self-supervised audio rep | concat with classifier → AUC ~0.85 on ADReSS | [HuggingFace `facebook/wav2vec2-large`](https://huggingface.co/facebook/wav2vec2-large-960h) | [Balagopalan et al., 2021](#7-references) |
| **HuBERT / WavLM embeddings** | refined self-supervised audio | comparable to wav2vec2; better with limited data | HuggingFace | [Hsu et al., 2021](#7-references) |
| **Whisper encoder embeddings** | encoder output of 30-s windows | strong cross-lingual; PROCESS / TAUKADIAL top systems use it | [openai/whisper](https://github.com/openai/whisper) | [Radford et al., 2022](#7-references); [Process challenge 2024](#7-references) |
| **BERT / RoBERTa transcript embeddings** | CLS pooled output | concat with acoustic for ~0.87 AUC on ADReSS-text | HuggingFace | [Balagopalan et al., 2021](#7-references) |
| **Sentence-BERT (SBERT) coherence scores** | per-sentence cosine to context | used for semantic-coherence features (§2.6) | [sentence-transformers](https://www.sbert.net/) | [Reimers & Gurevych, 2019](#7-references) |
| **LLM-derived features** (perplexity, zero-shot prompting) | "Score this transcript for…" | replacing hand-crafted features by 2024–25 | OpenAI / Anthropic APIs, local LLMs | [Amini et al., 2024](#7-references); [Bang et al., 2024](#7-references) |
| **Vector embeddings + ML classifier pipeline** | end-to-end speech→embed→logistic | reproducible baseline | [dzhou08/embedding_AZ](#7-references) | — |
| **Multimodal fusion (acoustic + transcript)** | concat features from §2.1 + §2.3 + §2.8 | typically the highest published AUC | TRESTLE toolkit | [Multimodal DL 2024](https://www.nature.com/articles/s41598-024-64438-1) |
| **Explainable-AI overlays (SHAP, LIME on embeddings)** | maps deep features back to interpretable language patterns | growing in 2024–25 reviews | shap, lime | [npj Digital Medicine XAI review 2025](https://www.nature.com/articles/s41746-025-02105-z) |

> The **trade-off in 2026** is no longer "hand-crafted vs deep". The strongest systems
> on PROCESS, TAUKADIAL, and the Framingham Heart Study cohort fuse both — embeddings
> for raw discriminative power, interpretable features for clinical-trust auditability.
> Explainable-AI reviews ([npj Digital Medicine 2025](https://www.nature.com/articles/s41746-025-02105-z))
> now treat this fusion as the default.

---

## 3. Public datasets & challenges

| Dataset / challenge | Language | Task | Size | Access | Ref |
|---|---|---|---|---|---|
| **DementiaBank Pitt Corpus** | English | Cookie Theft picture description + others | 242 control + 257 AD recordings (99 / 169 unique subjects) | [TalkBank registration](https://dementia.talkbank.org/access/) | [Lanzi et al., 2023](#7-references) |
| **ADReSS** (Interspeech 2020) | English | Balanced subset of Pitt for classification + MMSE regression | 156 audio + transcripts | Challenge website | [Luz et al., 2020](#7-references) |
| **ADReSSo** (Interspeech 2021) | English | Audio-only version, no transcript | 237 audio | Challenge website | [Luz et al., 2021](#7-references) |
| **ADReSS-M** (ICASSP 2023) | English + Greek | Multilingual classification | English (train) + Greek (test) | [ICASSP 2023 SPGC site](https://luzs.gitlab.io/madress-2023/) | [Luz et al., 2023](#7-references) |
| **TAUKADIAL** (Interspeech 2024) | English + Chinese (Taiwanese) | MCI classification + MMSE/MoCA regression | ~387 audio across both languages | [Challenge site](https://taukadial-luzs-69e3bf4b9878b99a6f03aea43776344580b77b9fe54725f4.gitlab.io/) | [Pérez-Toro et al., 2024](#7-references) |
| **PROCESS** (signal-processing 2024–25) | English | MCI / dementia from multi-prompt spontaneous speech (semantic fluency, picture description, story recall) | Not yet released to public outside challenge | [Challenge call](https://processchallenge.github.io/callforparticipation/) | [Tao et al., 2024](#7-references) |
| **Carolinas Conversations Collection (CCC)** | English | Conversational interviews with older adults (cognitively healthy + AD) | ~64 subjects, ~400 conversations | [TalkBank registration](https://dementia.talkbank.org/) | [Pope & Davis, 2011](#7-references) |
| **WLS (Wisconsin Longitudinal Study) — audio sub-sample** | English | Phone conversations from a longitudinal aging cohort | Subsample of WLS (~10K total subjects since 1957) | [WLS data portal](https://www.ssc.wisc.edu/wlsresearch/) | — |
| **Framingham Heart Study — voice sub-cohort** | English | Acoustic features + neuropsych testing | ~4,800 voice samples | [JMIR Aging 2024](https://aging.jmir.org/2024/1/e55126) | [Lin et al., 2024](#7-references) |
| **DementiaBank — Lu Corpus** | Cantonese | Picture description + verbal fluency | ~50 subjects | TalkBank | [Lu et al., 2009](#7-references) |
| **DementiaBank — Kempler Corpus** | English | Conversational / autobiographical | ~9 subjects (small but classic) | TalkBank | [Lanzi et al., 2023](#7-references) |
| **DementiaBank-Emotion (2026)** | English | Multi-rater emotion annotation overlay on AD speech | 192 recordings | [arxiv 2602.04247](https://arxiv.org/html/2602.04247v1) | — |
| **DementiaNet** (open) | English | Longitudinal spontaneous speech, up to 10 yrs pre-symptom | 100 subjects | [github.com/shreyasgite/dementianet](https://github.com/shreyasgite/dementianet) | — |

### Access notes

- **TalkBank / DementiaBank** requires an institutional account + signed data-use
  agreement. Free for research, ~1–2 week turnaround for approval.
- **ADReSS / ADReSSo / ADReSS-M / TAUKADIAL** are now post-challenge and downloads
  are available through the respective challenge sites for non-commercial research.
- **PROCESS data** has not been released to the public as of May 2026 — only
  registered challenge participants have access.

---

## 4. Open-source toolchain

Grouped by stage in the pipeline (raw audio → features → models). Every entry links
to the upstream repo with active maintenance as of May 2026.

### 4.1 Audio loading & preprocessing

- **librosa** — `pip install librosa`. The canonical Python audio library. Resampling,
  STFT, MFCC, spectral features. https://librosa.org/
- **torchaudio** — same scope but with GPU + autograd. Useful when wiring features
  into a PyTorch classifier. https://pytorch.org/audio/
- **soundfile** — fast WAV/FLAC I/O, used as backend by librosa.

### 4.2 Acoustic feature extraction

- **OpenSMILE / opensmile-python** — `pip install opensmile`. The standard for
  paralinguistic feature sets including **GeMAPS** (62 features), **eGeMAPS** (88
  features, the de facto standard for clinical voice work), **ComParE 2016** (~6.4k
  features). Maintained by audEERING.
  https://audeering.github.io/opensmile-python/ ·
  Original paper: [Eyben et al., 2015 — IEEE Trans. Affective Computing](https://sail.usc.edu/publications/files/eyben-preprinttaffc-2015.pdf)
- **parselmouth (Praat via Python)** — `pip install praat-parselmouth`. Wraps Praat's
  scripting layer; gives jitter, shimmer, HNR, formants, intensity. The library most
  feature-extraction studies cite. https://parselmouth.readthedocs.io/
- **DisVoice** — `pip install disvoice`. Targets pathological voice analysis
  specifically: glottal, phonation, articulation, prosody, phonological features.
  Has been used in PD, Huntington's, and dementia work.
  https://github.com/jcvasquezc/DisVoice
- **COVAREP** — Matlab toolbox (still occasionally used in papers, but Python tools
  above have largely supplanted it).
- **VoiceLab** — GUI-friendly Praat wrapper for batch acoustic analysis (good for
  exploring; less ideal for pipelines).

### 4.3 ASR (audio → transcript)

- **OpenAI Whisper** — `pip install openai-whisper` or use [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
  for ~4× speed. Multilingual (99 languages), robust to noise. The default ASR for
  every recent MCI/AD pipeline. https://github.com/openai/whisper
- **wav2vec2 / HuBERT / WavLM** (HuggingFace) — self-supervised models. Can be used
  as either ASR (with fine-tuned CTC head) or as feature extractors (encoder output
  as embeddings, see §2.8). https://huggingface.co/facebook/wav2vec2-large-960h
- **NeMo (NVIDIA)** — production-ready ASR + speaker diarization toolkit. Useful when
  recordings have multiple speakers (interviewer + subject).
  https://github.com/NVIDIA/NeMo

### 4.4 Linguistic feature extraction

- **spaCy** — `pip install spacy`. Industrial-strength NLP: tokenisation, POS,
  dependency parsing, NER. Most lexical / syntactic features above are 1–3 lines of
  spaCy. https://spacy.io/
- **Stanza (Stanford)** — alternative to spaCy with stronger constituency parsing
  for some languages. https://stanfordnlp.github.io/stanza/
- **benepar (Berger-Petrov constituency parser)** — drop-in spaCy plugin that adds
  constituency trees (needed for Yngve depth, Frazier score, embedded-clause counts).
  https://github.com/nikitakit/self-attentive-parser
- **textstat** — `pip install textstat`. Quick readability + lexical metrics (TTR,
  Honoré's R, Brunét's W). https://pypi.org/project/textstat/
- **wordfreq** — `pip install wordfreq`. SUBTLEX-based word-frequency lookup across
  many languages. https://github.com/rspeer/wordfreq
- **CPIDR** — Computerized Propositional Idea Density Rater. Java tool from Brown,
  Snyder et al. — the standard implementation of idea density.
  http://www.ai.uga.edu/caspr/

### 4.5 Embeddings & deep models

- **sentence-transformers (SBERT)** — `pip install sentence-transformers`. Sentence-
  level embeddings for semantic-coherence features. https://www.sbert.net/
- **HuggingFace `transformers`** — `pip install transformers`. Source of every
  pre-trained text and speech model used in the literature. https://huggingface.co/
- **Hugging Face `datasets`** — bundled access to standard NLP datasets, including
  some DementiaBank-derived ones.

### 4.6 End-to-end pipelines / reference implementations

- **TRESTLE** (TalkBank Reproducible Execution of Speech, Text, Language) — pipeline
  framework specifically designed to make ADReSS-style experiments reproducible.
  https://arxiv.org/pdf/2302.07322
- **billzyx/awesome-dementia-detection** — curated paper list, regularly updated.
  https://github.com/billzyx/awesome-dementia-detection
- **wazeerzulfikar/alzheimers-dementia** — ADReSS classification + MMSE regression
  baseline, well-commented, good starting point.
  https://github.com/wazeerzulfikar/alzheimers-dementia
- **LinLLiu/AD** — feature extraction + classifier reference implementation.
  https://github.com/LinLLiu/AD
- **NiliRahmani/Alzheimer-s-Dementia-Recognition-through-Spontaneous-Speech** —
  ADReSSo baseline. https://github.com/NiliRahmani/Alzheimer-s-Dementia-Recognition-through-Spontaneous-Speech
- **pcuenca/alzheimer** — early-detection ML pipeline using NLP + DL on Pitt.
  https://github.com/pcuenca/alzheimer

### 4.7 Audio annotation / VAD

- **WebRTC VAD** (`pip install webrtcvad`) — fast, lightweight, used by most speech
  pipelines for pause detection. https://github.com/wiseman/py-webrtcvad
- **Silero VAD** — neural VAD, more robust to background noise, used inside
  faster-whisper. https://github.com/snakers4/silero-vad
- **pyAnnoteAudio** — speaker diarization + VAD for multi-speaker recordings.
  https://github.com/pyannote/pyannote-audio
- **Praat** — manual annotation gold standard. Used when CIU coding (§2.4) or story-
  grammar coding (§2.6) needs human gradients.
- **ELAN** — multimodal annotation (audio + video + tiers). Used when prosody is
  hand-coded.

### 4.8 Disfluency detection

- **pariajm/deep-disfluency-detector** — auto-correlational neural net for filler /
  repair detection. https://github.com/pariajm/deep-disfluency-detector
- **clp-research/deep_disfluency** — disfluency detection on conversational speech.
  https://github.com/clp-research/deep_disfluency

---

## 5. Selected recent papers (2024–2026)

### Reviews & meta-analyses

- **de la Fuente Garcia, Ritchie & Luz** (2020). *Artificial Intelligence, speech,
  and language processing approaches to monitoring Alzheimer's Disease: a systematic
  review.* — The foundational review. [Journal of Alzheimer's Disease](https://content.iospress.com/articles/journal-of-alzheimers-disease/jad200888)
- **Petti, Baker & Korhonen** (2020). *A systematic literature review of automatic
  Alzheimer's disease detection from speech and language.* — [JAMIA](https://doi.org/10.1093/jamia/ocaa174)
- **Vincze et al.** (2021). *Linguistic features for detecting Alzheimer's disease.*
  — Inventory of linguistic markers, English + Hungarian.
- **Diagnostic utility of speech-based biomarkers in MCI: systematic review and
  meta-analysis** (2025). — *Age and Ageing* / PMC: https://pmc.ncbi.nlm.nih.gov/articles/PMC12560767/
- **Speech-based AD detection: AI techniques, datasets and challenges** (2024). —
  *Artificial Intelligence Review:* https://link.springer.com/article/10.1007/s10462-024-10961-6
- **Explainable AI methods for speech-based cognitive decline detection: systematic
  review** (2025). — *npj Digital Medicine:* https://www.nature.com/articles/s41746-025-02105-z

### Challenge overviews

- **Luz et al.** (2020). *Alzheimer's Dementia Recognition through Spontaneous
  Speech: The ADReSS Challenge.* — Interspeech.
- **Luz et al.** (2021). *Detecting Cognitive Decline Using Speech Only: The
  ADReSSo Challenge.* — Interspeech.
- **Luz et al.** (2023). *Overview of ADReSS-M.* — https://pmc.ncbi.nlm.nih.gov/articles/PMC11218814/
- **Pérez-Toro et al.** (2024). *Multilingual Speech and Language Analysis for the
  Assessment of MCI: TAUKADIAL Challenge Outcomes.* — Interspeech.
  https://www.isca-archive.org/interspeech_2024/pereztoro24_interspeech.html
- **Tao et al.** (2024). *Early Dementia Detection Using Multiple Spontaneous Speech
  Prompts: The PROCESS Challenge.* — arxiv https://arxiv.org/abs/2412.15230

### Method papers (recent)

- **Amini et al.** (2024). *Prediction of Alzheimer's disease progression within 6
  years using speech: leveraging language models.* — *Alzheimer's & Dementia* /
  Wiley: https://alz-journals.onlinelibrary.wiley.com/doi/10.1002/alz.13886
- **Bang et al.** (2024). *Alzheimer's disease recognition from spontaneous speech
  using large language models.* — *ETRI Journal:*
  https://onlinelibrary.wiley.com/doi/full/10.4218/etrij.2023-0356
- **Lin et al.** (2024, Framingham Heart Study). *Detection of MCI from non-semantic,
  acoustic voice features.* — *JMIR Aging:* https://aging.jmir.org/2024/1/e55126
- **Shakeri et al.** (2026). *Statistical analysis of interpretable linguistic
  features for MCI detection in bilingual speech.* — *Alzheimer's & Dementia:
  Diagnosis, Assessment & Disease Monitoring:* https://alz-journals.onlinelibrary.wiley.com/doi/10.1002/dad2.70246
- **Frontiers Neuroinformatics 2025** — *Enhancing dementia and cognitive decline
  detection with LLMs and speech representation learning.* — https://www.frontiersin.org/journals/neuroinformatics/articles/10.3389/fninf.2025.1679664/full
- **Frontiers Aging Neuroscience 2024** — *Screening for early AD: enhancing
  diagnosis with linguistic features and biomarkers.* — https://www.frontiersin.org/journals/aging-neuroscience/articles/10.3389/fnagi.2024.1451326/full
- **JMIR Medical Informatics 2026** — *MCI Detection System Based on Unstructured
  Spontaneous Speech: Longitudinal Dual-Modal Framework.* — https://medinform.jmir.org/2026/1/e80883
- **Multimodal DL for dementia classification** (2024). — *Scientific Reports:*
  https://www.nature.com/articles/s41598-024-64438-1
- **AI-Powered Speech Analysis: Automating Transcription, Embeddings, and Deep
  Learning** (2025, PMC). — https://pmc.ncbi.nlm.nih.gov/articles/PMC12785146/
- **Translingual Language Markers for Cognitive Assessment from Spontaneous Speech**
  (PMC). — https://pmc.ncbi.nlm.nih.gov/articles/PMC12885109/

---

## 6. Recommended reading order

A 1–2 day onboarding for a new researcher who'll touch this pipeline:

1. Skim §1 of this doc (10 min).
2. **Read** [de la Fuente Garcia et al., 2020](https://content.iospress.com/articles/journal-of-alzheimers-disease/jad200888)
   end-to-end (~1 hr). This is the field's foundational review.
3. **Read** the **ADReSS 2020 challenge paper** (Luz et al., 2020) — gives you the
   benchmark vocabulary used by everyone after.
4. Browse §4 of this doc; clone **one** end-to-end pipeline (e.g.
   `wazeerzulfikar/alzheimers-dementia`) and reproduce its ADReSS baseline. ~1 day.
5. **Read** the **2025 systematic review + meta-analysis** ([PMC12560767](https://pmc.ncbi.nlm.nih.gov/articles/PMC12560767/))
   for what's known to actually replicate.
6. **Read** the **TAUKADIAL 2024 overview** — relevant for bilingual settings, which
   this lab cares about given the project's zh/en stance.
7. Pick one feature family from §2 (recommend §2.2 *pause / temporal*) and
   reproduce the canonical extraction from raw audio — this is where you'll learn
   the field's craft.

---

## 7. References

> URLs verified May 2026. Citations are anchor-style; clicking a `[name, year]`
> link inside §2 jumps here.

### Foundational

- **Snowdon et al., 1996.** *Linguistic ability in early life and cognitive function
  and Alzheimer's disease in late life: findings from the Nun Study.* JAMA.
- **Riley et al., 2005.** *Early life linguistic ability, late life cognitive
  function, and neuropathology: findings from the Nun Study.* Neurobiology of Aging.
- **Honoré, 1979.** *Some simple measures of richness of vocabulary.* Association for
  Literary and Linguistic Computing Bulletin.
- **Brunét, 1978.** *Le vocabulaire de Jean Giraudoux: structure et évolution.*
  Slatkine.
- **Croisile et al., 1996.** *Comparative study of oral and written picture description
  in patients with Alzheimer's disease.* Brain and Language.
- **Almor et al., 1999.** *Why do Alzheimer's patients have difficulty with
  pronouns?* Brain and Language.
- **Glosser & Deser, 1991.** *Patterns of discourse production among neurological
  patients with fluent language disorders.* Brain and Language.
- **Bucks et al., 2000.** *Analysis of spontaneous, conversational speech in
  dementia of Alzheimer type.* Aphasiology.
- **Bschor et al., 2001.** *Spontaneous speech of patients with dementia of the
  Alzheimer type and mild cognitive impairment.* International Psychogeriatrics.
- **Kemper et al., 2001.** *Language decline across the life span: findings from the
  Nun Study.* — https://www.semanticscholar.org/paper/Language-decline-across-the-life-span:-findings-the-Kemper-Greiner/926b402d5ecdf00853e9bdf2f5a6ff368f3c0a5e

### Feature methodology

- **Eyben et al., 2015.** *The Geneva Minimalistic Acoustic Parameter Set (GeMAPS).*
  IEEE Trans. Affective Computing. https://sail.usc.edu/publications/files/eyben-preprinttaffc-2015.pdf
- **König et al., 2015.** *Automatic speech analysis for the assessment of patients
  with predementia and Alzheimer's disease.* Alzheimer's & Dementia: D, A & DM.
- **Sapir et al., 2010.** *Formant centralization ratio: a proposal for a new acoustic
  measure of dysarthric speech.* J. Speech, Language, and Hearing Research.
- **Heman-Ackah et al., 2003.** *Cepstral peak prominence: a more reliable measure
  of dysphonia.* Annals of Otology, Rhinology & Laryngology.
- **Meilán et al., 2014.** *Speech in Alzheimer's disease: can temporal and acoustic
  parameters discriminate dementia?* Dementia and Geriatric Cognitive Disorders.
- **Pistono et al., 2016.** *Pauses during autobiographical discourse reflect episodic
  memory processes in early Alzheimer's disease.* J. Alzheimer's Disease.
- **Toth et al., 2018.** *A speech recognition-based solution for the automatic
  detection of mild cognitive impairment from spontaneous speech.* Current Alzheimer
  Research.
- **Yuan et al., 2020.** *Disfluencies and fine-tuning pre-trained language models for
  detection of Alzheimer's disease.* Interspeech.
- **Roark et al., 2011.** *Spoken language derived measures for detecting mild
  cognitive impairment.* IEEE Trans. Audio, Speech, and Language Processing.
- **Pulido et al., 2020.** *Alzheimer's disease and automatic speech analysis: a
  review.* Expert Systems with Applications.
- **Martínez-Sánchez et al., 2017.** *Speech rhythm alterations in Spanish-speaking
  individuals with AD.* Aging, Neuropsychology, and Cognition.
- **Beltrami et al., 2018.** *Speech analysis by natural language processing
  techniques: a possible tool for very early detection of cognitive decline?*
  Frontiers in Aging Neuroscience.
- **Bortfeld et al., 2001.** *Disfluency rates in conversation.* Language and Speech.
- **Cuetos et al., 2007.** *Linguistic changes in verbal expression: a preclinical
  marker of Alzheimer's disease.* J. International Neuropsychological Society.
- **Wright et al., 2014.** *A method for elaborating discourse measures: implications
  for healthy adult and AD performance.* J. Speech-Language Pathology.
- **Troyer et al., 1997.** *Clustering and switching as two components of verbal
  fluency.* Neuropsychology.
- **Hoffmann et al., 2010.** *Temporal parameters of spontaneous speech in
  Alzheimer's disease.* J. Speech, Language, and Hearing Research.
- **Hoover et al., 2020.** *Word-finding pauses in Alzheimer's disease.* — Aphasiology.
- **Covington & McFall, 2010.** *Cutting the Gordian knot: the moving-average
  type-token ratio.* J. Quantitative Linguistics.
- **Engelman et al., 2010.** *Propositional density and cognitive function in later
  life: findings from the Precursors Study.* — https://pmc.ncbi.nlm.nih.gov/articles/PMC2954330/

### Datasets & corpora

- **Lanzi et al., 2023** (DementiaBank protocol paper). — https://pmc.ncbi.nlm.nih.gov/articles/PMC10171844/
- **Pope & Davis, 2011** (Carolinas Conversations Collection). — *Topics in Geriatric
  Rehabilitation.*
- **Lu et al., 2009** (Cantonese AphasiaBank Lu corpus). — TalkBank documentation.
- **Lin et al., 2024** (Framingham Heart Study voice cohort). — *JMIR Aging:*
  https://aging.jmir.org/2024/1/e55126

### Embeddings & deep methods

- **Balagopalan et al., 2021.** *Comparing pre-trained and feature-based models for
  prediction of Alzheimer's disease based on speech.* Frontiers in Aging Neuroscience.
- **Hsu et al., 2021.** *HuBERT: self-supervised speech representation learning by
  masked prediction of hidden units.* IEEE/ACM Trans. Audio, Speech, and Language
  Processing.
- **Radford et al., 2022.** *Robust speech recognition via large-scale weak
  supervision* (Whisper). OpenAI.
- **Reimers & Gurevych, 2019.** *Sentence-BERT: sentence embeddings using Siamese
  BERT-networks.* EMNLP.
- **Amini et al., 2024.** *Prediction of AD progression within 6 years using speech:
  leveraging language models.* — https://alz-journals.onlinelibrary.wiley.com/doi/10.1002/alz.13886
- **Bang et al., 2024.** *AD recognition from spontaneous speech using LLMs.* ETRI
  Journal. — https://onlinelibrary.wiley.com/doi/full/10.4218/etrij.2023-0356

### Bilingual / cross-language

- **Pérez-Toro et al., 2024** (TAUKADIAL outcomes). —
  https://www.isca-archive.org/interspeech_2024/pereztoro24_interspeech.html
- **Shakeri et al., 2026** (interpretable linguistic features, bilingual). —
  https://alz-journals.onlinelibrary.wiley.com/doi/10.1002/dad2.70246
- **Multilingual prediction of cognitive impairment with LLMs** (PMC). —
  https://pmc.ncbi.nlm.nih.gov/articles/PMC11674350/

### Recent reviews

- *Diagnostic utility of speech-based biomarkers in MCI* (2025, PMC). —
  https://pmc.ncbi.nlm.nih.gov/articles/PMC12560767/
- *Explainable AI for speech-based cognitive decline detection* (2025, npj DM). —
  https://www.nature.com/articles/s41746-025-02105-z
- *Speech-based detection of AD: AI techniques, datasets and challenges* (2024,
  Springer AIR). — https://link.springer.com/article/10.1007/s10462-024-10961-6

---

*Last updated 2026-05-08. Maintained alongside the wearable-platform repo; submit
additions via PR to `docs/research/` or as a journey under `docs/journeys/` if you've
verified a feature empirically in this codebase.*
