export type ConditionId = 'b1' | 'b2' | 'ours';

export type MethodKind = 'plain_model' | 'standard_agent' | 'improved_agent';

export type MethodRunStatus = 'completed' | 'partial' | 'failed' | 'unavailable';

export type EvaluationPhaseId = 'audio_only' | ConditionId;

export type StudyMode = 'blinded' | 'researcher';

export type SeverityCode =
  | 'reference_range'
  | 'borderline_high'
  | 'abnormal'
  | 'cohort_low'
  | 'cohort_mid'
  | 'cohort_high'
  | 'ungraded';

export type ReferenceKind =
  | 'healthy_control_iqr'
  | 'same_cohort_iqr'
  | 'comparison_cohort_iqr'
  | 'task_specific'
  | 'none';

export interface StudyManifest {
  id: string;
  title: string;
  description: string;
  defaultLocale: string;
  supportedLocales: string[];
  disclaimer: string;
  blinding: {
    defaultMode: StudyMode;
    revealPolicy: 'researcher_only';
    truthField: 'researchOnly';
  };
  interactionPolicy: {
    reportChat: {
      enabledFor: ConditionId[];
      recordUsage: boolean;
      treatAsIndependentVariable: boolean;
    };
  };
}

export interface ConditionDefinition {
  id: ConditionId;
  methodKind: MethodKind;
  blindLabel: string;
  name: string;
  shortDescription: string;
  capabilities: {
    riskScore: boolean;
    narrativeReport: boolean;
    structuredReport: boolean;
    reportChat: boolean;
    stateCards: boolean;
    evidenceTrace: boolean;
  };
}

export interface RiskScore {
  value: number | null;
  kind: 'screening_score' | 'unavailable';
  displayLabel?: string;
}

export interface ClinicalReport {
  kind: 'narrative' | 'structured';
  impression: string;
  summary: string;
  counterEvidence?: string;
  limitations?: string;
  recommendation: string;
}

export interface ResultProvenance {
  mode: 'frozen_stimulus' | 'live' | 'demo' | 'unavailable';
  generatedAt?: string;
  modelId?: string;
  pipelineVersion?: string;
  promptVersion?: string;
  note?: string;
}

export interface ReferenceDistribution {
  kind: ReferenceKind;
  q1: number;
  median: number;
  q3: number;
  n: number | null;
  populationLabel: string;
}

export interface SupportingMetric {
  id: string;
  label: string;
  value: number | string | null;
  unit?: string;
  displayValue?: string;
  interpretation?: string;
  referenceText?: string;
}

export interface ClinicalState {
  id: string;
  label: string;
  description: string;
  normalizedValue: number | null;
  valueLabel?: string;
  /** Original frozen-fixture label for the reference comparator. */
  referenceLabel?: string;
  /** Whether the original stimulus opened its raw-metric detail by default. */
  expandMetrics?: boolean;
  severity: SeverityCode;
  severityLabel: string;
  reference?: ReferenceDistribution;
  supportingMetrics: SupportingMetric[];
}

export interface TraceDimension {
  id: string;
  label: string;
  description?: string;
  metricKey: string;
  reference: ReferenceDistribution;
}

export interface EvidenceSegment {
  segmentId: string;
  index: number;
  startSeconds: number;
  endSeconds: number;
  speakerRole: 'patient' | 'examiner' | 'unknown';
  transcript: string;
  wordCount?: number;
  coreUnits: string[];
  gapBeforeSeconds?: number;
  disfluencyPer100Words?: number;
  metrics: Record<string, number | null>;
}

export interface TraceableEvidence {
  states: ClinicalState[];
  dimensions: TraceDimension[];
  segments: EvidenceSegment[];
}

export interface MethodRunError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface MethodOutput {
  schemaVersion: '1.0.0';
  runId: string;
  caseId: string;
  conditionId: ConditionId;
  methodKind: MethodKind;
  status: MethodRunStatus;
  score: RiskScore;
  classification: string | null;
  report?: ClinicalReport;
  evidence?: TraceableEvidence;
  provenance: ResultProvenance;
  warnings: string[];
  error?: MethodRunError;
  extensions?: Record<string, unknown>;
}

export interface DoctorEvaluationCase {
  caseId: string;
  displayOrder: number;
  task: string;
  taskDescription: string;
  source: {
    dataset: string;
    language: string;
    protocol: string;
  };
  audio: {
    src: string;
    mimeType: string;
    durationSeconds: number;
  };
  roleHandling: {
    description: string;
    counts: Record<string, number | string>;
  };
  conditionOrder: ConditionId[];
  methodOutputs: MethodOutput[];
  researchOnly?: {
    truth: string;
    sourceGroup: string;
    originalTaskDescription?: string;
  };
}

export interface FormOption {
  value: string;
  label: string;
}

export interface FormFieldDefinition {
  id: string;
  label: string;
  kind: 'text' | 'number' | 'textarea' | 'single_select' | 'likert_5';
  required: boolean;
  options?: FormOption[];
  min?: number;
  max?: number;
  leftAnchor?: string;
  rightAnchor?: string;
}

export interface QuestionnaireDefinition {
  id: 'sus' | 'clinical_evidence_safety';
  title: string;
  description: string;
  scale: {
    min: 1;
    max: 5;
    leftAnchor: string;
    rightAnchor: string;
  };
  items: Array<{
    id: string;
    text: string;
    reverseScored?: boolean;
  }>;
}

export interface EvaluationForms {
  profileFields: FormFieldDefinition[];
  caseRatingFields: FormFieldDefinition[];
  overallFields: FormFieldDefinition[];
  questionnaires: QuestionnaireDefinition[];
}

export interface DoctorEvaluationStudyBundle {
  schemaVersion: '1.1.0';
  dataMode: 'hardcoded' | 'api';
  study: StudyManifest;
  conditions: ConditionDefinition[];
  cases: DoctorEvaluationCase[];
  forms: EvaluationForms;
}

export type JudgmentCode =
  | 'no_cognitive_impairment'
  | 'mci'
  | 'ad_adrd'
  | 'cognitive_impairment_untyped'
  | 'insufficient_evidence';

export interface CaseRatingAnswers {
  judgment?: JudgmentCode;
  confidence?: number;
  usefulness?: number;
  clarity?: number;
  traceability?: number;
  safety?: number;
  effort?: number;
  comment?: string;
}

export interface ReportChatUsage {
  used: boolean;
  questionCount: number;
  promptIds: string[];
  startedAt?: string;
  endedAt?: string;
}

export interface CasePhaseResponse {
  phaseId: EvaluationPhaseId;
  conditionId?: ConditionId;
  presentationOrder: number;
  status: 'draft' | 'submitted';
  openedAt?: string;
  submittedAt?: string;
  durationMs?: number;
  rating: CaseRatingAnswers;
  reportChat?: ReportChatUsage;
}

export interface CaseEvaluationResponse {
  caseId: string;
  status: 'draft' | 'submitted';
  openedAt?: string;
  submittedAt?: string;
  durationMs?: number;
  phases: CasePhaseResponse[];
}

export interface ClinicianProfile {
  participantCode: string;
  ageRange?: string;
  gender?: string;
  specialty?: string;
  trainingLevel?: string;
  yearsClinical?: number;
  cognitiveExperience?: string;
  weeklyCognitiveCases?: string;
  aiFamiliarity?: number;
  speechBiomarkerExperience?: string;
  institutionType?: string;
  languages: string[];
}

export interface OverallEvaluationResponse {
  openedAt?: string;
  submittedAt?: string;
  durationMs?: number;
  preferredConditionId?: ConditionId;
  secondConditionId?: ConditionId;
  confidence?: number;
  workflowFit?: number;
  adoption?: number;
  overrelianceConcern?: number;
  mostValuableInformation?: string;
  reason?: string;
  missingInformation?: string;
  susAnswers: number[];
  clinicalEvidenceSafetyAnswers: number[];
  clinicalComment?: string;
  susScore: number | null;
}

export interface DoctorEvaluationResponse {
  schemaVersion: '1.1.0';
  studyId: string;
  responseId: string;
  status: 'draft' | 'submitted';
  participant: ClinicianProfile;
  session: {
    locale: string;
    startedAt: string;
    completedAt?: string;
    exportedAt?: string;
    initialMode: StudyMode;
  };
  reveal: {
    methodsRevealedAt?: string;
    groundTruthRevealedAt?: string;
  };
  caseResponses: CaseEvaluationResponse[];
  overall: OverallEvaluationResponse;
}
