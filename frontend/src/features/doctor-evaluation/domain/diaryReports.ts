import type { ConditionDefinition, MethodOutput } from '../types';
import { formatRiskScore, methodOutputStatusLabel } from './methodOutput';

export function methodOutputReportMarkdown(
  condition: ConditionDefinition,
  output: MethodOutput,
): string {
  const report = output.report;
  const parts = [
    '### 筛查结果',
    '- **运行状态：** ' + methodOutputStatusLabel(output.status),
    '- **风险值：** ' + formatRiskScore(output.score.value),
    '- **分类：** ' + (output.classification || '未提供'),
  ];

  if (output.error) {
    parts.push('', '> 输出错误 [' + output.error.code + ']：' + output.error.message);
  }
  if (output.warnings.length > 0) {
    parts.push('', '### 输出警告', ...output.warnings.map((warning) => '- ' + warning));
  }
  if (!report) {
    parts.push('', '> 当前输出没有病例级文字报告；前端不会根据风险值自行补造临床依据。');
    return parts.join('\n');
  }

  parts.push('', '### 临床印象', report.impression, '', '### 报告摘要', report.summary);
  if (report.counterEvidence || report.limitations) {
    parts.push('', '### 反向证据与限制', report.counterEvidence || report.limitations || '未提供');
  }
  parts.push('', '### 建议下一步', report.recommendation);
  if (condition.id === 'ours') {
    parts.push('', '> 条件 C 的结论可继续追溯到临床状态、量化指标和语音片段。');
  }
  return parts.join('\n');
}