import type { EvaluationForms } from '../types';
import type { OverallEvaluationDraft, ScalarAnswer } from '../domain/evaluationExport';
import { calculateSusScore, orderedQuestionnaireAnswers } from '../domain/evaluationExport';

interface OverallEvaluationFormProps {
  forms: EvaluationForms;
  draft: OverallEvaluationDraft;
  casesComplete: boolean;
  onAnswer: (fieldId: string, value: ScalarAnswer) => void;
  onQuestionnaireAnswer: (questionnaireId: 'sus' | 'clinical_evidence_safety', itemId: string, value: number) => void;
  onClinicalComment: (value: string) => void;
  onSubmit: () => void;
}

function LikertButtons({ value, onChange, disabled }: { value?: number; onChange: (value: number) => void; disabled: boolean }) {
  return (
    <div className="flex gap-1.5" role="group" aria-label="1 到 5 分（1 to 5）">
      {[1, 2, 3, 4, 5].map((item) => (
        <button
          key={item}
          type="button"
          disabled={disabled}
          aria-pressed={value === item}
          onClick={() => onChange(item)}
          className={`h-9 min-w-9 flex-1 rounded-md border text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-45 ${
            value === item
              ? 'border-accent bg-accent text-white'
              : 'border-card-border bg-card-hover text-text-secondary hover:border-accent/50'
          }`}
        >
          {item}
        </button>
      ))}
    </div>
  );
}

export function OverallEvaluationForm({
  forms,
  draft,
  casesComplete,
  onAnswer,
  onQuestionnaireAnswer,
  onClinicalComment,
  onSubmit,
}: OverallEvaluationFormProps) {
  const sus = forms.questionnaires.find((item) => item.id === 'sus')!;
  const clinical = forms.questionnaires.find((item) => item.id === 'clinical_evidence_safety')!;
  const requiredOverall = forms.overallFields.filter((field) => field.required);
  const requiredComplete = requiredOverall.every((field) => draft.answers[field.id] !== undefined && draft.answers[field.id] !== '');
  const susValues = orderedQuestionnaireAnswers(draft.susAnswers, sus.items.map((item) => item.id));
  const clinicalValues = orderedQuestionnaireAnswers(draft.clinicalAnswers, clinical.items.map((item) => item.id));
  const complete = casesComplete && requiredComplete && susValues.length === 10 && clinicalValues.length === 6;
  const susScore = calculateSusScore(susValues);

  return (
    <section id="overall-evaluation" className="scroll-mt-6 overflow-hidden rounded-xl border border-card-border bg-card-bg shadow-sm">
      <header className="border-b border-card-border px-5 py-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-accent">Overall evaluation</p>
        <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-text-primary">总体比较、SUS 与临床安全量表 / Overall comparison, SUS & clinical safety scale</h2>
            <p className="mt-1 text-xs text-text-muted">完成全部病例后提交；回答自动保存在当前浏览器。（Submit after finishing all cases; answers auto-save in this browser.）</p>
          </div>
          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${casesComplete ? 'bg-status-success/15 text-status-success' : 'bg-card-hover text-text-muted'}`}>
            病例 Cases {casesComplete ? '已全部完成 All complete' : '尚未全部完成 Incomplete'}
          </span>
        </div>
      </header>

      <fieldset disabled={!casesComplete} className="space-y-6 p-5 disabled:opacity-60">
        <div className="grid gap-4 md:grid-cols-2">
          {forms.overallFields.map((field) => (
            <label key={field.id} className={field.kind === 'textarea' ? 'md:col-span-2' : ''}>
              <span className="mb-1.5 block text-sm font-medium text-text-primary">
                {field.label}{field.required && <span className="ml-1 text-status-danger">*</span>}
              </span>
              {field.kind === 'single_select' ? (
                <select
                  value={String(draft.answers[field.id] ?? '')}
                  onChange={(event) => onAnswer(field.id, event.target.value)}
                  className="w-full rounded-lg border border-card-border bg-window-bg px-3 py-2.5 text-sm text-text-primary outline-none focus:border-accent"
                >
                  <option value="">请选择 Select…</option>
                  {field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              ) : field.kind === 'likert_5' ? (
                <div>
                  <LikertButtons value={Number(draft.answers[field.id]) || undefined} onChange={(value) => onAnswer(field.id, value)} disabled={!casesComplete} />
                  <div className="mt-1 flex justify-between text-[10px] text-text-muted"><span>{field.leftAnchor}</span><span>{field.rightAnchor}</span></div>
                </div>
              ) : (
                <textarea
                  rows={3}
                  value={String(draft.answers[field.id] ?? '')}
                  onChange={(event) => onAnswer(field.id, event.target.value)}
                  className="w-full resize-y rounded-lg border border-card-border bg-window-bg px-3 py-2.5 text-sm text-text-primary outline-none focus:border-accent"
                />
              )}
            </label>
          ))}
        </div>

        {[sus, clinical].map((questionnaire) => {
          const answerMap = questionnaire.id === 'sus' ? draft.susAnswers : draft.clinicalAnswers;
          return (
            <section key={questionnaire.id} className="rounded-xl border border-card-border bg-window-bg/40 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div><h3 className="font-semibold text-text-primary">{questionnaire.title}</h3><p className="mt-1 text-xs text-text-muted">{questionnaire.description}</p></div>
                {questionnaire.id === 'sus' && <span className="text-xs font-semibold text-accent">SUS：{susScore ?? '待完成 Pending'}</span>}
              </div>
              <div className="mt-4 space-y-4">
                {questionnaire.items.map((item, index) => (
                  <div key={item.id} className="grid gap-2 border-b border-card-border pb-4 last:border-0 last:pb-0 md:grid-cols-[minmax(0,1fr)_330px] md:items-center">
                    <p className="text-sm leading-6 text-text-secondary">{index + 1}. {item.text}</p>
                    <div><LikertButtons value={answerMap[item.id]} onChange={(value) => onQuestionnaireAnswer(questionnaire.id, item.id, value)} disabled={!casesComplete} /><div className="mt-1 flex justify-between text-[10px] text-text-muted"><span>{questionnaire.scale.leftAnchor}</span><span>{questionnaire.scale.rightAnchor}</span></div></div>
                  </div>
                ))}
              </div>
            </section>
          );
        })}

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-text-primary">临床安全补充意见 / Additional clinical-safety comments</span>
          <textarea rows={3} value={draft.clinicalComment} onChange={(event) => onClinicalComment(event.target.value)} className="w-full resize-y rounded-lg border border-card-border bg-window-bg px-3 py-2.5 text-sm text-text-primary outline-none focus:border-accent" />
        </label>
      </fieldset>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-card-border px-5 py-4">
        <p className={`text-xs ${complete ? 'text-status-success' : 'text-text-muted'}`}>
          {draft.submitted ? '✓ 总体评价已提交并导出；继续修改后可重新导出。（Overall evaluation submitted and exported; re-export after further edits.）' : complete ? '全部必填项已完成，可以提交并导出平台评价。（All required items complete; ready to submit and export.）' : '需完成 7 个病例、总体必填项、10 道 SUS 和 6 道临床安全题。（Requires 7 cases, the required overall items, 10 SUS items, and 6 clinical-safety items.）'}
        </p>
        <button type="button" disabled={!complete} onClick={onSubmit} className="rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40">
          {draft.submitted ? '更新并重新导出平台 JSON / Update & re-export JSON' : '提交并导出平台 JSON / Submit & export JSON'}
        </button>
      </footer>
    </section>
  );
}
