# Doctor evaluation frontend contract

This feature integrates the doctor_three_condition_demo study into the existing
React/Vite clinician platform. It is now provider-neutral: the doctor workspace
renders one shared output contract and does not call the current Claude or
single-Agent implementations.

## Three method contract

The research arms remain blinded as condition A, B and C. Their implementation
identities are stored separately:

- plain_model: 普通模型
- standard_agent: 普通 Agent
- improved_agent: 改良 Agent

Every runner must eventually return the same MethodOutput shape: schemaVersion,
runId, caseId, conditionId, methodKind, status, score, classification, optional
report/evidence, provenance, warnings and optional error/extensions. The current
fixture adapter produces this shape from the frozen seven-case dataset.

The bundle contract is version 1.1.0. The standalone method-output schema is in
schema/doctor-evaluation-method-output.schema.json and references the canonical
definition in schema/doctor-evaluation-study.schema.json.

## Platform surfaces reused

- components/diary/EntryCard.tsx renders each selected output as an embedded
  Diary card.
- components/chat/MessageMarkdown.tsx renders the compact report-question UI.
- lib/activePatient.ts remains the patient-context source for the real route.
- Existing layout, theme tokens, response export and comparative metrics are
  retained.

The doctor-evaluation feature does not import api/claudeApi.ts. Its compact
question panel uses api/doctorChatApi.ts and the provider-neutral report-chat
contract from doctor_three_condition_demo. Configure
VITE_DOCTOR_CHAT_API_BASE (see frontend/.env.example) to connect the separate
report-chat service. Until that service is running, the UI explicitly reports
offline mode and falls back to deterministic answers grounded only in the
current condition-C MethodOutput.

## Current clinician workflow

1. Select one of the seven frozen study cases.
2. Switch between A, B and C in the animated card deck.
3. Inspect run status, risk value, report and any available evidence.
4. Use the compact report-question UI to validate the planned interaction.
5. Start case rating and complete the existing A/B/C comparison metrics.

A missing score is unavailable rather than zero. Failed and partial outputs are
renderable and visible; the frontend never invents missing report or evidence
content.

## Routes

- /doctor-evaluation is the protected platform route. It always renders inside
  the existing logged-in application shell, including Header navigation,
  language/theme controls, Settings access and the active doctor identity.
- /doctor-evaluation-demo is retained only as a legacy link and redirects to
  /doctor-evaluation after the normal login gate; it is not a standalone page.

The route currently uses the hardcoded DoctorEvaluationStudyBundle. When the
three execution methods are ready, normalize their responses to MethodOutput and
replace the fixture provider; no card, Diary, evidence or rating component needs
a provider-specific branch.

## Canonical rating export

The platform export contract is
schema/doctor-evaluation-response.schema.json, version 1.1.0. It replaces the
legacy standalone template's evaluation-export shape; the platform does not
emit two competing JSON formats.

Timing fields are persisted interaction events:

- session.startedAt: session creation.
- caseResponses[].openedAt: first presentation of the case.
- caseResponses[].phases[].openedAt: first presentation of the condition
  summary. In the fused card deck, all three summaries appear together.
- caseResponses[].submittedAt and phase submittedAt: the real click on
  "提交本病例评分". The unified matrix submits all three conditions together.
- overall.openedAt: first interaction with the overall evaluation.
- overall.submittedAt and session.completedAt: final submission.
- session.exportedAt: the individual download event; re-exporting changes this
  value but does not rewrite earlier submission timestamps.

Browser drafts use advoice.doctor-evaluation.fused.v3. The previous v2 key is
left untouched rather than inventing event timestamps for old drafts.
