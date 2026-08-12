import { EntryCard } from '../../../components/diary/EntryCard';
import type { DiaryEntry } from '../../../api/diaryApi';
import type { ConditionDefinition, MethodOutput, StudyMode } from '../types';
import {
  formatMethodOutputValue,
  methodOutputStatusLabel,
} from '../domain/methodOutput';
import { methodOutputReportMarkdown } from '../domain/diaryReports';

interface ConditionDiaryCardProps {
  condition: ConditionDefinition;
  output: MethodOutput;
  mode: StudyMode;
  evidenceOpen: boolean;
  onToggleEvidence: () => void;
  evidenceActionLabel?: string;
}

const conditionTone = {
  b1: 'border-slate-400/30 bg-slate-400/10 text-slate-300',
  b2: 'border-blue-400/30 bg-blue-400/10 text-blue-300',
  ours: 'border-accent/35 bg-accent/15 text-accent',
} as const;

export function ConditionDiaryCard({
  condition,
  output,
  mode,
  evidenceOpen,
  onToggleEvidence,
  evidenceActionLabel,
}: ConditionDiaryCardProps) {
  const title = mode === 'blinded' ? condition.blindLabel : condition.name;
  const entry: DiaryEntry = {
    id: `doctor-eval-${output.runId}`,
    type: 'observation',
    title: `${title} · 病例观察`,
    body: methodOutputReportMarkdown(condition, output),
    created_at: output.provenance.generatedAt || new Date(0).toISOString(),
    trigger: 'manual',
    agent_id: title,
    model: mode === 'blinded' ? 'frozen-study-output' : output.provenance.modelId || output.methodKind,
    context_refs: { recordings: [] },
    read: true,
  };

  return (
    <section className="flex min-h-[430px] flex-col overflow-hidden rounded-xl border border-card-border bg-card-bg shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-card-border px-4 py-3">
        <div className="flex items-center gap-2">
          <span className={`rounded-full border px-2.5 py-1 text-xs font-bold ${conditionTone[condition.id]}`}>
            {condition.blindLabel}
          </span>
          <span className="text-xs text-text-muted">{condition.shortDescription}</span>
        </div>
        <span className="flex items-center gap-2 text-xs">
          <span data-method-status={output.status} className="text-text-muted">
            {methodOutputStatusLabel(output.status)}
          </span>
          <span className="font-mono text-text-secondary">{formatMethodOutputValue(output)}</span>
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <EntryCard entry={entry} display="embedded" embeddedLabel={title} />
      </div>

      <footer className="border-t border-card-border px-4 py-3">
        {condition.id === 'ours' && output.evidence ? (
          <button
            type="button"
            onClick={onToggleEvidence}
            className="w-full rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-xs font-semibold text-accent transition hover:bg-accent/15"
          >
            {evidenceActionLabel ?? (evidenceOpen ? '收起临床状态与证据轨迹' : '展开临床状态与证据轨迹')}
          </button>
        ) : condition.id === 'b2' ? (
          <div className="text-center text-[11px] leading-5 text-text-muted">
            该文字由直接 Agent 根据可用音频/转录生成，结论与具体片段之间没有结构化链接。
          </div>
        ) : (
          <div className="text-center text-[11px] leading-5 text-text-muted">
            {output.score.value == null
              ? '该普通话病例只展示分类和可核查证据，不显示未经校准的概率。'
              : '概率表示模型筛查输出，不是确诊概率。'}
          </div>
        )}
      </footer>
    </section>
  );
}
