import type { DoctorEvaluationCase, DoctorEvaluationStudyBundle } from './types';
import { researchPatientId } from './researchPatients';

/** Resolve only an explicit frozen-study patient ID to its study case. */
export function studyCaseForPatientId(
  patientId: string,
  bundle: DoctorEvaluationStudyBundle,
): DoctorEvaluationCase | null {
  return bundle.cases.find(
    (studyCase) => patientId === researchPatientId(studyCase.caseId),
  ) ?? null;
}

export function studyCaseIndexForId(
  caseId: string | null,
  bundle: DoctorEvaluationStudyBundle,
): number | null {
  if (!caseId) return null;
  const index = bundle.cases.findIndex((studyCase) => studyCase.caseId === caseId);
  return index >= 0 ? index : null;
}

export function evaluationPathForCase(caseId: string): string {
  return `/doctor-evaluation?caseId=${encodeURIComponent(caseId)}`;
}
