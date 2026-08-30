import type {
  ConditionId,
  MethodKind,
  MethodOutput,
  MethodRunStatus,
} from '../types';

export const METHOD_KIND_BY_CONDITION: Record<ConditionId, MethodKind> = {
  b1: 'plain_model',
  b2: 'standard_agent',
  ours: 'improved_agent',
};

export const METHOD_MARKER_BY_CONDITION: Record<ConditionId, string> = {
  b1: 'A',
  b2: 'B',
  ours: 'C',
};

export const METHOD_NAME_BY_KIND: Record<MethodKind, string> = {
  plain_model: '普通模型 Plain model',
  standard_agent: '普通 Agent Standard agent',
  improved_agent: '改良 Agent Improved agent',
};

export function formatRiskScore(value: number | null): string {
  if (value === null) return '未输出 No output';
  const percentage = value <= 1 ? value * 100 : value;
  return Math.round(percentage) + '%';
}

export function methodOutputStatusLabel(status: MethodRunStatus): string {
  const labels: Record<MethodRunStatus, string> = {
    completed: '已完成 Completed',
    partial: '部分输出 Partial output',
    failed: '运行失败 Run failed',
    unavailable: '未运行 Not run',
  };
  return labels[status];
}

export function formatMethodOutputValue(output: MethodOutput): string {
  if (output.score.value !== null) return formatRiskScore(output.score.value);
  if (output.status === 'failed') return '运行失败 Run failed';
  if (output.status === 'unavailable') return '未运行 Not run';
  if (output.status === 'partial') return '部分输出 Partial output';
  return '未输出 No output';
}