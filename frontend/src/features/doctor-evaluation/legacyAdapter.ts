import type {
  ClinicalReport,
  ConditionId,
  DoctorEvaluationCase,
  MethodOutput,
  ReferenceDistribution,
  ReferenceKind,
  SeverityCode,
  TraceableEvidence,
} from './types';
import { METHOD_KIND_BY_CONDITION } from './domain/methodOutput';

interface LegacyReference {
  q1: number;
  median: number;
  q3: number;
  n?: number;
}

interface LegacyMetricDetail {
  label: string;
  value: number | string | null;
  reference?: string;
  interpretation?: string;
}

interface LegacyState {
  key: string;
  label: string;
  description: string;
  value: number | null;
  value_label?: string;
  severity: string;
  reference?: LegacyReference;
  reference_label?: string;
  expand_metrics?: boolean;
  metric_details?: LegacyMetricDetail[];
}

interface LegacySegment {
  idx: number;
  start: number;
  end: number;
  text: string;
  words?: number;
  core_units?: string[];
  disfluency_100w?: number;
  gap_before?: number;
  scores: Record<string, number | null>;
}

interface LegacyAgentReport {
  impression: string;
  body: string;
  recommendation: string;
}

interface LegacyStructuredReport {
  impression: string;
  summary: string;
  counter?: string;
  limitations?: string;
  recommendation: string;
}

export interface LegacyDoctorCase {
  id: string;
  task: string;
  task_description: string;
  audio: string;
  duration: number;
  role_counts?: Record<string, number | string>;
  role_note: string;
  truth?: string;
  source_group?: string;
  scores: Record<ConditionId, number | null>;
  diagnoses: Record<ConditionId, string>;
  states?: LegacyState[];
  segments?: LegacySegment[];
  trace_options?: Array<[string, string]>;
  trajectory_reference?: Record<string, LegacyReference>;
  agent_report?: LegacyAgentReport;
  ours_report?: LegacyStructuredReport;
}

const CONDITION_ORDERS: ConditionId[][] = [
  ['b1', 'b2', 'ours'],
  ['b2', 'ours', 'b1'],
  ['ours', 'b1', 'b2'],
];

const DEFAULT_TRACE_OPTIONS: Array<[string, string]> = [
  ['lexical', '词汇提取'],
  ['information', '信息密度'],
  ['pause', '停顿/连续性'],
  ['output', '输出效率'],
];

function severityCode(label: string): SeverityCode {
  const map: Record<string, SeverityCode> = {
    参考范围内: 'reference_range',
    边界偏高: 'borderline_high',
    明显异常: 'abnormal',
    同队列偏低: 'cohort_low',
    同队列中位范围: 'cohort_mid',
    同队列偏高: 'cohort_high',
  };
  return map[label] ?? 'ungraded';
}

function datasetFor(caseId: string): string {
  if (caseId.startsWith('S')) return 'ADReSS 2020';
  if (caseId.startsWith('iaeav-')) return 'IAEAV';
  return 'PREPARE';
}

function languageFor(caseId: string): string {
  if (caseId.startsWith('S')) return 'en';
  if (caseId.startsWith('iaeav-')) return 'es';
  return 'zh-CN';
}

function protocolFor(caseId: string, task: string): string {
  if (caseId.startsWith('S')) return 'cookie_theft_picture_description';
  if (caseId.startsWith('iaeav-')) return 'structured_clinical_interview';
  if (task.includes('普通话')) return 'mandarin_cognitive_speech';
  return 'other';
}

function publicTaskDescription(source: LegacyDoctorCase): string {
  if (datasetFor(source.id) !== 'PREPARE') return source.task_description;
  return '普通话认知评估语音；当前材料包含真实音频，暂无时间对齐转录或说话人角色标注。';
}

function referenceKindFor(source: LegacyDoctorCase): ReferenceKind {
  if (datasetFor(source.id) === 'PREPARE') return 'same_cohort_iqr';
  if (datasetFor(source.id) === 'ADReSS 2020') return 'healthy_control_iqr';
  return 'comparison_cohort_iqr';
}

function populationLabelFor(source: LegacyDoctorCase): string {
  if (datasetFor(source.id) === 'PREPARE') return '34 例同源普通话 MCI 音频';
  if (datasetFor(source.id) === 'ADReSS 2020') return 'ADReSS 2020 训练集健康对照';
  return '当前刺激材料内置比较队列';
}

function referenceFor(
  source: LegacyDoctorCase,
  legacy: LegacyReference,
): ReferenceDistribution {
  return {
    kind: referenceKindFor(source),
    q1: legacy.q1,
    median: legacy.median,
    q3: legacy.q3,
    n: legacy.n ?? null,
    populationLabel: populationLabelFor(source),
  };
}

function reportFor(source: LegacyDoctorCase, conditionId: ConditionId): ClinicalReport | undefined {
  if (conditionId === 'b1') return undefined;
  if (conditionId === 'b2' && source.agent_report) {
    return {
      kind: 'narrative',
      impression: source.agent_report.impression,
      summary: source.agent_report.body,
      recommendation: source.agent_report.recommendation,
    };
  }
  if (conditionId === 'ours' && source.ours_report) {
    return {
      kind: 'structured',
      impression: source.ours_report.impression,
      summary: source.ours_report.summary,
      counterEvidence: source.ours_report.counter,
      limitations: source.ours_report.limitations,
      recommendation: source.ours_report.recommendation,
    };
  }
  return undefined;
}

function evidenceFor(source: LegacyDoctorCase): TraceableEvidence | undefined {
  const legacyReferences = source.trajectory_reference ?? {};
  const traceOptions = source.trace_options ?? DEFAULT_TRACE_OPTIONS;
  const dimensions = traceOptions.flatMap(([id, label]) => {
    const legacyReference = legacyReferences[id];
    if (!legacyReference) return [];
    return [
      {
        id,
        label,
        metricKey: id,
        reference: referenceFor(source, legacyReference),
      },
    ];
  });

  return {
    states: (source.states ?? []).map((state) => ({
      id: state.key,
      label: state.label,
      description: state.description,
      normalizedValue: state.value,
      valueLabel: state.value_label,
      referenceLabel: state.reference_label,
      expandMetrics: state.expand_metrics,
      severity: severityCode(state.severity),
      severityLabel: state.severity,
      reference: state.reference ? referenceFor(source, state.reference) : undefined,
      supportingMetrics: (state.metric_details ?? []).map((metric, index) => ({
        id: `${state.key}_metric_${index + 1}`,
        label: metric.label,
        value: metric.value,
        interpretation: metric.interpretation,
        referenceText: metric.reference,
      })),
    })),
    dimensions,
    segments: (source.segments ?? []).map((segment) => ({
      segmentId: `${source.id}-segment-${segment.idx}`,
      index: segment.idx,
      startSeconds: segment.start,
      endSeconds: segment.end,
      speakerRole: datasetFor(source.id) === 'PREPARE' ? 'unknown' : 'patient',
      transcript: segment.text,
      wordCount: segment.words,
      coreUnits: segment.core_units ?? [],
      gapBeforeSeconds: segment.gap_before,
      disfluencyPer100Words: segment.disfluency_100w,
      metrics: segment.scores,
    })),
  };
}

function provenanceFor(conditionId: ConditionId): MethodOutput['provenance'] {
  if (conditionId === 'b2') {
    return {
      mode: 'frozen_stimulus',
      generatedAt: '2026-08-03',
      pipelineVersion: '7.30',
      note: '直接智能体文字报告为固定实验刺激；风险值沿用 B2_direct_agent_proxy。',
    };
  }
  return {
    mode: 'frozen_stimulus',
    pipelineVersion: '7.30',
    note: conditionId === 'ours' ? '可追溯报告与片段轨迹为当前硬编码实验刺激。' : '传统模型风险值为当前硬编码实验刺激。',
  };
}

function methodOutputFor(
  source: LegacyDoctorCase,
  conditionId: ConditionId,
): MethodOutput {
  const score = source.scores[conditionId];
  const report = reportFor(source, conditionId);
  const evidence = conditionId === 'ours' ? evidenceFor(source) : undefined;
  const isComplete =
    score !== null &&
    (conditionId === 'b1' || Boolean(report)) &&
    (conditionId !== 'ours' || Boolean(evidence));

  return {
    schemaVersion: '1.0.0',
    runId: 'fixture:' + source.id + ':' + METHOD_KIND_BY_CONDITION[conditionId] + ':v1',
    caseId: source.id,
    conditionId,
    methodKind: METHOD_KIND_BY_CONDITION[conditionId],
    status: isComplete ? 'completed' : 'partial',
    score: {
      value: score,
      kind: score === null ? 'unavailable' : 'screening_score',
      displayLabel: score === null ? '未输出' : undefined,
    },
    classification: source.diagnoses[conditionId] || null,
    report,
    evidence,
    provenance: provenanceFor(conditionId),
    warnings: score === null ? ['当前冻结刺激未提供可校准风险值。'] : [],
  };
}

export function adaptLegacyCases(cases: LegacyDoctorCase[]): DoctorEvaluationCase[] {
  return cases.map((source, index) => ({
    caseId: source.id,
    displayOrder: index + 1,
    task: source.task,
    taskDescription: publicTaskDescription(source),
    source: {
      dataset: datasetFor(source.id),
      language: languageFor(source.id),
      protocol: protocolFor(source.id, source.task),
    },
    audio: {
      src: source.audio.startsWith('/') ? source.audio : `/${source.audio}`,
      mimeType: 'audio/wav',
      durationSeconds: source.duration,
    },
    roleHandling: {
      description: source.role_note,
      counts: source.role_counts ?? {},
    },
    conditionOrder: CONDITION_ORDERS[index % CONDITION_ORDERS.length],
    methodOutputs: (['b1', 'b2', 'ours'] as ConditionId[]).map((conditionId) =>
      methodOutputFor(source, conditionId),
    ),
  }));
}
