import publicCasesJson from './mock/publicCases.json';
import { adaptLegacyCases, type LegacyDoctorCase } from './legacyAdapter';
import { CONDITIONS, EVALUATION_FORMS, STUDY_MANIFEST } from './studyManifest';
import type { DoctorEvaluationStudyBundle } from './types';
import { assertDoctorEvaluationStudy } from './validateStudy';

const publicCases = publicCasesJson as unknown as LegacyDoctorCase[];

/**
 * Public frontend fixture used until the report/case APIs are wired.
 *
 * It preserves the frozen result, report, metric and evidence fields but omits
 * research-only truth and source-group labels before data reaches a doctor
 * browser. The canonical research fixture remains in doctor_three_condition_demo.
 */
const study: DoctorEvaluationStudyBundle = {
  schemaVersion: '1.1.0',
  dataMode: 'hardcoded',
  study: STUDY_MANIFEST,
  conditions: CONDITIONS,
  cases: adaptLegacyCases(publicCases),
  forms: EVALUATION_FORMS,
};

assertDoctorEvaluationStudy(study);

export const doctorEvaluationMockStudy = study;