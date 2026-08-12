import type { EvaluationForms, OverallEvaluationResponse } from '../types';


export type ScalarAnswer = string | number;

export interface OverallEvaluationDraft {
  answers: Record<string, ScalarAnswer>;
  susAnswers: Record<string, number>;
  clinicalAnswers: Record<string, number>;
  clinicalComment: string;
  submitted: boolean;
}


export const emptyOverallDraft = (): OverallEvaluationDraft => ({
  answers: {},
  susAnswers: {},
  clinicalAnswers: {},
  clinicalComment: '',
  submitted: false,
});

export function calculateSusScore(answers: number[]): number | null {
  if (answers.length !== 10 || answers.some((value) => value < 1 || value > 5)) {
    return null;
  }
  const contribution = answers.reduce(
    (total, value, index) => total + (index % 2 === 0 ? value - 1 : 5 - value),
    0,
  );
  return contribution * 2.5;
}

export function orderedQuestionnaireAnswers(
  answerMap: Record<string, number>,
  itemIds: string[],
): number[] {
  return itemIds.flatMap((id) => {
    const value = answerMap[id];
    return Number.isInteger(value) && value >= 1 && value <= 5 ? [value] : [];
  });
}

export function overallResponseFromDraft(
  draft: OverallEvaluationDraft,
  forms: EvaluationForms,
): OverallEvaluationResponse {
  const sus = forms.questionnaires.find((item) => item.id === 'sus');
  const clinical = forms.questionnaires.find((item) => item.id === 'clinical_evidence_safety');
  const susAnswers = orderedQuestionnaireAnswers(
    draft.susAnswers,
    sus?.items.map((item) => item.id) ?? [],
  );
  const clinicalAnswers = orderedQuestionnaireAnswers(
    draft.clinicalAnswers,
    clinical?.items.map((item) => item.id) ?? [],
  );

  return {
    ...draft.answers,
    susAnswers,
    clinicalEvidenceSafetyAnswers: clinicalAnswers,
    clinicalComment: draft.clinicalComment || undefined,
    susScore: calculateSusScore(susAnswers),
  } as OverallEvaluationResponse;
}
