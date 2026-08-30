import { useEffect, useMemo, useState } from 'react';
import type { ConditionDefinition, ConditionId, FormFieldDefinition, StudyMode } from '../types';
export type EvaluationAnswers = Record<string, string | number>;

interface ComparativeMetricsFormProps {
  caseId: string;
  conditions: ConditionDefinition[];
  conditionOrder: ConditionId[];
  mode: StudyMode;
  fields: FormFieldDefinition[];
  answersByCondition: Record<ConditionId, EvaluationAnswers>;
  submitted: boolean;
  onAnswer: (conditionId: ConditionId, fieldId: string, value: string | number) => void;
  onSubmit: () => void;
}

export function ComparativeMetricsForm({
  caseId,
  conditions,
  conditionOrder,
  mode,
  fields,
  answersByCondition,
  submitted,
  onAnswer,
  onSubmit,
}: ComparativeMetricsFormProps) {
  const hasDraft = conditionOrder.some((conditionId) => Object.keys(answersByCondition[conditionId] ?? {}).length > 0);
  const [started, setStarted] = useState(submitted || hasDraft);
  const judgment = fields.find((field) => field.id === 'judgment');
  const likertFields = fields.filter((field) => field.kind === 'likert_5');
  const comment = fields.find((field) => field.id === 'comment');
  const requiredFields = fields.filter((field) => field.required);

  useEffect(() => {
    setStarted(submitted || conditionOrder.some((conditionId) => Object.keys(answersByCondition[conditionId] ?? {}).length > 0));
  }, [caseId]);

  const completion = useMemo(
    () =>
      Object.fromEntries(
        conditionOrder.map((conditionId) => {
          const answers = answersByCondition[conditionId] ?? {};
          const completed = requiredFields.filter((field) => answers[field.id] !== undefined && answers[field.id] !== '').length;
          return [conditionId, { completed, total: requiredFields.length }];
        }),
      ) as Record<ConditionId, { completed: number; total: number }>,
    [answersByCondition, conditionOrder, requiredFields],
  );
  const complete = conditionOrder.every(
    (conditionId) => completion[conditionId].completed === completion[conditionId].total,
  );

  const titleFor = (conditionId: ConditionId) => {
    const condition = conditions.find((item) => item.id === conditionId)!;
    return mode === 'blinded' ? condition.blindLabel : condition.name;
  };

  if (!started) {
    return (
      <section className="rounded-xl border border-card-border bg-card-bg p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-accent">Doctor metrics</p>
            <h2 className="mt-1 text-lg font-semibold text-text-primary">结果与 Agent 交互完成后，开始统一评分（After reviewing the results and agent chat, start the unified rating）</h2>
            <p className="mt-1 text-sm text-text-muted">不再在每个结果下面重复打分；A、B、C 使用同一张比较矩阵。（No repeated per-result scoring; A, B, C share one comparison matrix.）</p>
          </div>
          <button
            type="button"
            onClick={() => setStarted(true)}
            className="rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-accent-hover"
          >
            开始本病例评分 / Start rating this case
          </button>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {['分类判断 Classification', '判断信心 Confidence', '筛查帮助 Screening help', '信息清晰度 Clarity', '依据可核查性 Traceability', '安全说明 Safety notes', '阅读负担 Reading burden'].map((label) => (
            <span key={label} className="rounded-full border border-card-border bg-card-hover px-2.5 py-1 text-xs text-text-secondary">{label}</span>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="overflow-hidden rounded-xl border border-card-border bg-card-bg shadow-sm">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-card-border px-5 py-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-accent">Doctor metrics</p>
          <h2 className="mt-1 text-lg font-semibold text-text-primary">A / B / C 统一评分矩阵 / Unified rating matrix</h2>
          <p className="mt-1 text-xs text-text-muted">沿用旧研究的全部病例级 metrics；三个条件在同一视图完成。（Keeps all case-level metrics from the earlier study; all three conditions rated in one view.）</p>
        </div>
        <div className="flex gap-2">
          {conditionOrder.map((conditionId) => (
            <span key={conditionId} className="rounded-full bg-card-hover px-2.5 py-1 text-[11px] text-text-secondary">
              {titleFor(conditionId)} {completion[conditionId].completed}/{completion[conditionId].total}
            </span>
          ))}
        </div>
      </header>

      <div className="overflow-x-auto">
        <div className="min-w-[980px] p-5">
          <div className="grid grid-cols-[210px_repeat(3,minmax(0,1fr))] border-b border-card-border pb-3">
            <div className="text-xs font-semibold text-text-muted">评价指标 Metric</div>
            {conditionOrder.map((conditionId) => (
              <div key={conditionId} className="px-3 text-center">
                <p className="text-sm font-semibold text-text-primary">{titleFor(conditionId)}</p>
                <p className="mt-0.5 text-[10px] text-text-muted">冻结结果 · 独立记录 Frozen output · rated independently</p>
              </div>
            ))}
          </div>

          {judgment && (
            <div className="grid grid-cols-[210px_repeat(3,minmax(0,1fr))] items-center border-b border-card-border py-4">
              <div className="pr-4 text-sm font-medium text-text-primary">{judgment.label}</div>
              {conditionOrder.map((conditionId) => (
                <div key={conditionId} className="px-3">
                  <select
                    value={String(answersByCondition[conditionId]?.[judgment.id] ?? '')}
                    onChange={(event) => onAnswer(conditionId, judgment.id, event.target.value)}
                    className="w-full rounded-lg border border-card-border bg-window-bg px-3 py-2 text-xs text-text-primary outline-none focus:border-accent"
                  >
                    <option value="">请选择 Select…</option>
                    {judgment.options?.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          )}

          {likertFields.map((field) => (
            <div key={field.id} className="grid grid-cols-[210px_repeat(3,minmax(0,1fr))] items-center border-b border-card-border py-4 last:border-b-0">
              <div className="pr-4">
                <p className="text-sm font-medium text-text-primary">{field.label}</p>
                <div className="mt-1 flex justify-between text-[10px] text-text-muted">
                  <span>{field.leftAnchor || '低 Low'}</span><span>{field.rightAnchor || '高 High'}</span>
                </div>
              </div>
              {conditionOrder.map((conditionId) => (
                <div key={conditionId} className="flex gap-1 px-3">
                  {[1, 2, 3, 4, 5].map((value) => {
                    const active = Number(answersByCondition[conditionId]?.[field.id]) === value;
                    return (
                      <button
                        key={value}
                        type="button"
                        onClick={() => onAnswer(conditionId, field.id, value)}
                        className={`h-9 flex-1 rounded-md border text-xs font-semibold transition ${
                          active
                            ? 'border-accent bg-accent text-white'
                            : 'border-card-border bg-card-hover text-text-secondary hover:border-accent/50'
                        }`}
                        aria-pressed={active}
                      >
                        {value}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          ))}

          {comment && (
            <div className="grid grid-cols-[210px_repeat(3,minmax(0,1fr))] items-start pt-4">
              <div className="pr-4 text-sm font-medium text-text-primary">{comment.label}</div>
              {conditionOrder.map((conditionId) => (
                <div key={conditionId} className="px-3">
                  <textarea
                    value={String(answersByCondition[conditionId]?.[comment.id] ?? '')}
                    onChange={(event) => onAnswer(conditionId, comment.id, event.target.value)}
                    rows={3}
                    placeholder={`${titleFor(conditionId)} 的补充意见（Additional comments）`}
                    className="w-full resize-y rounded-lg border border-card-border bg-window-bg px-3 py-2 text-xs text-text-primary outline-none focus:border-accent"
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-card-border px-5 py-4">
        <div>
          <p className={`text-xs ${complete ? 'text-status-success' : 'text-text-muted'}`}>
            {complete ? '✓ 三个条件的必填 metrics 已完成（Required metrics complete for all three conditions）' : '评分会自动保存；完成三个条件的必填项后可提交。（Ratings save automatically; submit once all required items are complete for the three conditions.）'}
          </p>
          {submitted && <p className="mt-1 text-xs text-status-success">本病例比较评分已提交，可继续修改并更新。（Comparison ratings submitted for this case; you can still revise and update.）</p>}
        </div>
        <button
          type="button"
          disabled={!complete}
          onClick={onSubmit}
          className="rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitted ? '更新本病例评分 / Update case ratings' : '提交本病例评分 / Submit case ratings'}
        </button>
      </footer>
    </section>
  );
}
