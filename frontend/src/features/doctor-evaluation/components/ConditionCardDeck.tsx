import { useRef, useState, type KeyboardEvent } from 'react';
import type {
  ConditionDefinition,
  ConditionId,
  MethodOutput,
  StudyMode,
} from '../types';
import {
  formatMethodOutputValue,
  METHOD_MARKER_BY_CONDITION,
  methodOutputStatusLabel,
} from '../domain/methodOutput';
import { ConditionDiaryCard } from './ConditionDiaryCard';

interface ConditionCardDeckItem {
  definition: ConditionDefinition;
  output: MethodOutput;
}

interface ConditionCardDeckProps {
  items: ConditionCardDeckItem[];
  mode: StudyMode;
  evidenceOpen: boolean;
  onToggleEvidence: () => void;
  evidenceActionLabel?: string;
  onActiveConditionChange?: (conditionId: ConditionId) => void;
}

const selectorTone = {
  b1: {
    active: 'border-slate-300/60 bg-slate-400/15 shadow-slate-950/20',
    marker: 'bg-slate-300',
    label: 'text-slate-200',
  },
  b2: {
    active: 'border-blue-300/60 bg-blue-400/15 shadow-blue-950/20',
    marker: 'bg-blue-300',
    label: 'text-blue-200',
  },
  ours: {
    active: 'border-accent/60 bg-accent/15 shadow-accent/10',
    marker: 'bg-accent',
    label: 'text-accent',
  },
} as const;

export function ConditionCardDeck({
  items,
  mode,
  evidenceOpen,
  onToggleEvidence,
  evidenceActionLabel,
  onActiveConditionChange,
}: ConditionCardDeckProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const selectorRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeItem = items[activeIndex];

  if (!activeItem) return null;

  const selectIndex = (nextIndex: number, moveFocus = false) => {
    const normalizedIndex = (nextIndex + items.length) % items.length;
    setActiveIndex(normalizedIndex);
    onActiveConditionChange?.(items[normalizedIndex].definition.id);
    if (moveFocus) {
      window.requestAnimationFrame(() => selectorRefs.current[normalizedIndex]?.focus());
    }
  };

  const handleSelectorKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      selectIndex(activeIndex - 1, true);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      selectIndex(activeIndex + 1, true);
    } else if (event.key === 'Home') {
      event.preventDefault();
      selectIndex(0, true);
    } else if (event.key === 'End') {
      event.preventDefault();
      selectIndex(items.length - 1, true);
    }
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-card-border bg-window-bg/40 p-3 shadow-sm sm:p-4">
      <div
        role="tablist"
        aria-label="A、B、C 筛查结果"
        onKeyDown={handleSelectorKeyDown}
        className="grid gap-2 sm:grid-cols-3"
      >
        {items.map(({ definition, output }, index) => {
          const active = index === activeIndex;
          const tone = selectorTone[definition.id];
          const title = mode === 'blinded' ? definition.blindLabel : definition.name;

          return (
            <button
              key={definition.id}
              ref={(node) => {
                selectorRefs.current[index] = node;
              }}
              id={`condition-selector-${definition.id}`}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`condition-result-${definition.id}`}
              tabIndex={active ? 0 : -1}
              onClick={() => selectIndex(index)}
              className={`group relative overflow-hidden rounded-xl border px-3 py-3 text-left shadow-sm transition-[transform,box-shadow,border-color,background-color] duration-300 ease-out motion-reduce:transition-none ${
                active
                  ? `-translate-y-0.5 shadow-lg ${tone.active}`
                  : 'border-card-border bg-card-bg hover:-translate-y-0.5 hover:border-text-muted/40 hover:bg-card-hover'
              }`}
            >
              <span
                aria-hidden="true"
                className={`absolute inset-x-0 bottom-0 h-0.5 origin-left transition-transform duration-500 ease-out motion-reduce:transition-none ${tone.marker} ${
                  active ? 'scale-x-100' : 'scale-x-0'
                }`}
              />
              <span className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-bold transition-transform duration-300 motion-reduce:transition-none ${
                      active
                        ? `${tone.active} ${tone.label} scale-105`
                        : 'border-card-border bg-card-hover text-text-secondary'
                    }`}
                  >
                    {METHOD_MARKER_BY_CONDITION[definition.id]}
                  </span>
                  <span className={`truncate text-sm font-semibold ${active ? 'text-text-primary' : 'text-text-secondary'}`}>
                    {title}
                  </span>
                </span>
                <span className={`font-mono text-sm font-bold ${active ? tone.label : 'text-text-muted'}`}>
                  {formatMethodOutputValue(output)}
                </span>
              </span>
              <span className="mt-2 flex items-center justify-between gap-2 text-[11px]">
                <span className="truncate text-text-muted">{definition.shortDescription}</span>
                <span
                  data-method-status={output.status}
                  className="shrink-0 font-medium text-text-secondary"
                >
                  {methodOutputStatusLabel(output.status)}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[11px] text-text-muted">
          <span className="font-mono text-text-secondary">
            {String(activeIndex + 1).padStart(2, '0')} / {String(items.length).padStart(2, '0')}
          </span>
          <span className="hidden sm:inline">点击卡片或使用 ← → 切换</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => selectIndex(activeIndex - 1)}
            aria-label="查看上一个条件"
            className="flex h-8 w-8 items-center justify-center rounded-full border border-card-border bg-card-bg text-sm text-text-secondary transition hover:border-accent/40 hover:bg-accent/10 hover:text-accent"
          >
            ←
          </button>
          <button
            type="button"
            onClick={() => selectIndex(activeIndex + 1)}
            aria-label="查看下一个条件"
            className="flex h-8 w-8 items-center justify-center rounded-full border border-card-border bg-card-bg text-sm text-text-secondary transition hover:border-accent/40 hover:bg-accent/10 hover:text-accent"
          >
            →
          </button>
        </div>
      </div>

      <div className="mt-3 h-1 overflow-hidden rounded-full bg-card-hover" aria-hidden="true">
        <div
          className="h-full origin-left rounded-full bg-accent transition-transform duration-500 ease-out motion-reduce:transition-none"
          style={{
            width: `${100 / items.length}%`,
            transform: `translateX(${activeIndex * 100}%)`,
          }}
        />
      </div>

      <div className="mt-3 grid overflow-hidden rounded-xl">
        {items.map(({ definition, output }, index) => {
          const active = index === activeIndex;
          const isPrevious = index < activeIndex;

          return (
            <div
              key={definition.id}
              id={`condition-result-${definition.id}`}
              role="tabpanel"
              aria-labelledby={`condition-selector-${definition.id}`}
              aria-hidden={!active}
              className={`col-start-1 row-start-1 transition-[transform,opacity] duration-500 ease-out motion-reduce:transition-none ${
                active
                  ? 'visible relative z-10 translate-x-0 scale-100 opacity-100'
                  : `invisible relative z-0 scale-[0.985] opacity-0 ${isPrevious ? '-translate-x-10' : 'translate-x-10'}`
              }`}
            >
              <ConditionDiaryCard
                condition={definition}
                output={output}
                mode={mode}
                evidenceOpen={evidenceOpen}
                onToggleEvidence={onToggleEvidence}
                evidenceActionLabel={evidenceActionLabel}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
