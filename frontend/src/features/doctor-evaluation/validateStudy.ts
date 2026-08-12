import { METHOD_KIND_BY_CONDITION } from './domain/methodOutput';
import type {
  ConditionId,
  DoctorEvaluationStudyBundle,
  ReferenceDistribution,
} from './types';

const EXPECTED_CONDITIONS = new Set<ConditionId>(['b1', 'b2', 'ours']);

function validateReference(
  path: string,
  reference: ReferenceDistribution,
  issues: string[],
): void {
  if (!(reference.q1 <= reference.median && reference.median <= reference.q3)) {
    issues.push(path + ': expected q1 <= median <= q3');
  }
}

export function validateDoctorEvaluationStudy(
  bundle: DoctorEvaluationStudyBundle,
): string[] {
  const issues: string[] = [];
  const conditionById = new Map(
    bundle.conditions.map((condition) => [condition.id, condition]),
  );
  const definedConditions = new Set(conditionById.keys());

  if (bundle.schemaVersion !== '1.1.0') {
    issues.push('schemaVersion: expected 1.1.0');
  }
  if (definedConditions.size !== bundle.conditions.length) {
    issues.push('conditions: duplicate condition id');
  }
  for (const expected of EXPECTED_CONDITIONS) {
    if (!definedConditions.has(expected)) issues.push('conditions: missing ' + expected);
  }
  for (const condition of bundle.conditions) {
    if (condition.methodKind !== METHOD_KIND_BY_CONDITION[condition.id]) {
      issues.push(
        'conditions.' +
          condition.id +
          '.methodKind: expected ' +
          METHOD_KIND_BY_CONDITION[condition.id],
      );
    }
  }

  const caseIds = new Set<string>();
  const runIds = new Set<string>();

  for (const studyCase of bundle.cases) {
    const casePath = 'cases.' + studyCase.caseId;
    if (caseIds.has(studyCase.caseId)) issues.push(casePath + ': duplicate case id');
    caseIds.add(studyCase.caseId);

    const outputIds = studyCase.methodOutputs.map((output) => output.conditionId);
    const outputSet = new Set(outputIds);
    if (outputSet.size !== outputIds.length) {
      issues.push(casePath + '.methodOutputs: duplicate condition output');
    }
    for (const expected of EXPECTED_CONDITIONS) {
      if (!outputSet.has(expected)) {
        issues.push(casePath + '.methodOutputs: missing ' + expected);
      }
    }

    if (
      studyCase.conditionOrder.length !== outputSet.size ||
      studyCase.conditionOrder.some((conditionId) => !outputSet.has(conditionId))
    ) {
      issues.push(casePath + '.conditionOrder: must match methodOutputs');
    }

    for (const output of studyCase.methodOutputs) {
      const outputPath = casePath + '.methodOutputs.' + output.conditionId;
      const definition = conditionById.get(output.conditionId);

      if (output.schemaVersion !== '1.0.0') {
        issues.push(outputPath + '.schemaVersion: expected 1.0.0');
      }
      if (runIds.has(output.runId)) {
        issues.push(outputPath + '.runId: duplicate ' + output.runId);
      }
      runIds.add(output.runId);
      if (output.caseId !== studyCase.caseId) {
        issues.push(outputPath + '.caseId: must match parent case');
      }
      if (output.methodKind !== METHOD_KIND_BY_CONDITION[output.conditionId]) {
        issues.push(
          outputPath +
            '.methodKind: expected ' +
            METHOD_KIND_BY_CONDITION[output.conditionId],
        );
      }
      if (output.status === 'failed' && !output.error) {
        issues.push(outputPath + '.error: required when status is failed');
      }
      if (output.score.value === null && output.score.kind !== 'unavailable') {
        issues.push(outputPath + '.score: null must be unavailable');
      }
      if (output.score.value !== null && output.score.kind !== 'screening_score') {
        issues.push(outputPath + '.score: number must be screening_score');
      }

      if (output.status === 'completed' && definition) {
        if (definition.capabilities.riskScore && output.score.value === null) {
          issues.push(outputPath + '.score: completed output requires a risk value');
        }
        if (definition.capabilities.narrativeReport && !output.report) {
          issues.push(outputPath + '.report: completed output requires a report');
        }
        if (
          definition.capabilities.structuredReport &&
          output.report?.kind !== 'structured'
        ) {
          issues.push(outputPath + '.report.kind: completed output must be structured');
        }
        if (definition.capabilities.evidenceTrace && !output.evidence) {
          issues.push(outputPath + '.evidence: completed output requires evidence');
        }
      }

      const evidence = output.evidence;
      if (!evidence) continue;
      for (const state of evidence.states) {
        if (state.reference) {
          validateReference(
            outputPath + '.states.' + state.id + '.reference',
            state.reference,
            issues,
          );
        }
      }
      for (const dimension of evidence.dimensions) {
        validateReference(
          outputPath + '.dimensions.' + dimension.id + '.reference',
          dimension.reference,
          issues,
        );
        for (const segment of evidence.segments) {
          if (!(dimension.metricKey in segment.metrics)) {
            issues.push(
              outputPath +
                '.' +
                segment.segmentId +
                ': missing metric ' +
                dimension.metricKey,
            );
          }
        }
      }
    }
  }

  return issues;
}

export function assertDoctorEvaluationStudy(bundle: DoctorEvaluationStudyBundle): void {
  const issues = validateDoctorEvaluationStudy(bundle);
  if (issues.length > 0) {
    throw new Error('Invalid doctor evaluation study:\n' + issues.join('\n'));
  }
}