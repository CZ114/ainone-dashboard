import type { ConditionDefinition, MethodOutput } from '../types';
import { formatRiskScore, methodOutputStatusLabel } from './methodOutput';

export function methodOutputReportMarkdown(
  condition: ConditionDefinition,
  output: MethodOutput,
): string {
  const report = output.report;
  const parts = [
    '### 筛查结果 Screening result',
    '- **运行状态 Status：** ' + methodOutputStatusLabel(output.status),
    '- **风险值 Risk score：** ' + formatRiskScore(output.score.value),
    '- **分类 Classification：** ' + (output.classification || '未提供 Not provided'),
  ];

  if (output.error) {
    parts.push('', '> 输出错误 Output error [' + output.error.code + ']：' + output.error.message);
  }
  if (output.warnings.length > 0) {
    parts.push('', '### 输出警告 Output warnings', ...output.warnings.map((warning) => '- ' + warning));
  }
  if (!report) {
    parts.push('', '> 当前输出没有病例级文字报告；前端不会根据风险值自行补造临床依据。（This output has no case-level narrative report; the frontend does not fabricate clinical rationale from the risk score.）');
    return parts.join('\n');
  }

  parts.push('', '### 临床印象 Clinical impression', report.impression, '', '### 报告摘要 Report summary', report.summary);
  if (report.counterEvidence || report.limitations) {
    parts.push('', '### 反向证据与限制 Counter-evidence & limitations', report.counterEvidence || report.limitations || '未提供 Not provided');
  }
  parts.push('', '### 建议下一步 Recommended next steps', report.recommendation);
  if (condition.id === 'ours') {
    parts.push('', '> 条件 C 的结论可继续追溯到临床状态、量化指标和语音片段。（Condition C conclusions remain traceable to clinical states, quantitative metrics, and speech segments.）');
  }
  return parts.join('\n');
}