import type { DoctorEvaluationCase, DoctorEvaluationStudyBundle } from './types';

/** A frozen study case rendered through the platform's patient workbench. */
export interface ResearchPatient {
  id: string;
  name: string;
  age: null;
  complaint: string;
  device: string;
  created_by: 'frozen-study';
  created_at: number;
  studyCaseId: string;
  kind: 'research';
}

export function researchPatientId(caseId: string): string {
  return `study:${caseId}`;
}

export function researchPatientForCase(studyCase: DoctorEvaluationCase): ResearchPatient {
  return {
    id: researchPatientId(studyCase.caseId),
    name: `研究受试者 ${studyCase.caseId}`,
    age: null,
    complaint: studyCase.task,
    device: `冻结评测数据 · ${studyCase.source.dataset}`,
    created_by: 'frozen-study',
    // Fixed fixture timestamp: this is display metadata, not a fabricated
    // clinical event time.
    created_at: Math.floor(Date.UTC(2026, 7, 3, 0, 0, studyCase.displayOrder) / 1000),
    studyCaseId: studyCase.caseId,
    kind: 'research',
  };
}

export function researchPatientsFromStudy(
  bundle: DoctorEvaluationStudyBundle,
): ResearchPatient[] {
  return bundle.cases.map(researchPatientForCase);
}

export function isResearchPatient(patient: unknown): patient is ResearchPatient {
  return (
    typeof patient === 'object' &&
    patient !== null &&
    'kind' in patient &&
    (patient as { kind?: unknown }).kind === 'research'
  );
}