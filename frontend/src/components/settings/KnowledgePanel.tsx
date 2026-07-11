// 设置页「知识库」tab — agent_service 的 RAG 管理：
// 集合 CRUD、文档入库（粘贴文本 / 上传文件）、检索预览。
// 首次 ingest 会在服务端加载嵌入模型（可达 1–2 分钟），api client
// 已放宽超时，这里在 pending 期间常驻提示。

import { useCallback, useEffect, useState } from 'react';
import {
  agentAdminApi,
  type IngestDocument,
  type RagCollection,
  type RagHit,
} from '../../api/agentAdminApi';
import { useT } from '../../contexts/LanguageContext';

export function KnowledgePanel() {
  const t = useT();
  const [collections, setCollections] = useState<RagCollection[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // create
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // ingest
  const [ingestCollection, setIngestCollection] = useState('');
  const [mode, setMode] = useState<'text' | 'file'>('text');
  const [sourceName, setSourceName] = useState('');
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [fileInputKey, setFileInputKey] = useState(0); // 成功后重挂载以清空
  const [ingesting, setIngesting] = useState(false);
  const [ingestMsg, setIngestMsg] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  // search
  const [searchCollection, setSearchCollection] = useState('');
  const [query, setQuery] = useState('');
  const [topK, setTopK] = useState('5');
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<RagHit[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const r = await agentAdminApi.listCollections();
      setCollections(r.collections);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setCreateError(null);
    try {
      await agentAdminApi.createCollection(name);
      setNewName('');
      await refresh();
    } catch (err) {
      setCreateError(
        t.settings.knowledge.collections.createFailed(
          err instanceof Error ? err.message : String(err),
        ),
      );
    }
    setCreating(false);
  };

  const handleDeleteCollection = async (name: string) => {
    if (!window.confirm(t.settings.knowledge.collections.confirmDelete(name))) return;
    try {
      await agentAdminApi.deleteCollection(name);
      if (ingestCollection === name) setIngestCollection('');
      if (searchCollection === name) {
        setSearchCollection('');
        setHits(null);
      }
      await refresh();
    } catch (err) {
      window.alert(
        t.settings.knowledge.collections.deleteFailed(
          err instanceof Error ? err.message : String(err),
        ),
      );
    }
  };

  const canIngest =
    !!ingestCollection &&
    !ingesting &&
    (mode === 'text' ? !!sourceName.trim() && !!text.trim() : files.length > 0);

  const handleIngest = async () => {
    if (!canIngest) return;
    setIngesting(true);
    setIngestMsg(null);
    try {
      let documents: IngestDocument[];
      if (mode === 'text') {
        documents = [{ source: sourceName.trim(), text }];
      } else {
        documents = await Promise.all(
          files.map(async (f) => {
            try {
              return { source: f.name, text: await f.text() };
            } catch {
              throw new Error(t.settings.knowledge.ingest.fileReadFailed(f.name));
            }
          }),
        );
      }
      const r = await agentAdminApi.ingest(ingestCollection, documents);
      setIngestMsg({
        ok: true,
        text: t.settings.knowledge.ingest.ok(r.added_chunks, r.total_count),
      });
      setText('');
      setFiles([]);
      setFileInputKey((k) => k + 1);
      await refresh();
    } catch (err) {
      setIngestMsg({
        ok: false,
        text: t.settings.knowledge.ingest.failed(
          err instanceof Error ? err.message : String(err),
        ),
      });
    }
    setIngesting(false);
  };

  const handleSearch = async () => {
    if (!searchCollection || !query.trim() || searching) return;
    setSearching(true);
    setSearchError(null);
    try {
      const k = Math.floor(Number(topK));
      const r = await agentAdminApi.search(
        searchCollection,
        query.trim(),
        Number.isFinite(k) && k >= 1 ? k : 5,
      );
      setHits(r.hits);
      setExpanded(new Set());
    } catch (err) {
      setHits(null);
      setSearchError(
        t.settings.knowledge.search.failed(
          err instanceof Error ? err.message : String(err),
        ),
      );
    }
    setSearching(false);
  };

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const collectionSelect = (
    value: string,
    onChange: (v: string) => void,
    placeholder: string,
  ) => (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={inputClass}
    >
      <option value="">{placeholder}</option>
      {collections.map((c) => (
        <option key={c.name} value={c.name}>
          {c.name}
        </option>
      ))}
    </select>
  );

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-base font-semibold text-text-primary">
          {t.settings.knowledge.heading}
        </h2>
        <p className="mt-0.5 text-xs text-text-muted">
          {t.settings.knowledge.tagline}
        </p>
      </header>

      {/* ① Collections */}
      <section className="rounded-lg border border-card-border bg-card-bg/40 p-4">
        <h3 className="mb-3 text-sm font-semibold text-text-primary">
          {t.settings.knowledge.collections.heading}
        </h3>

        {loadError && (
          <div className="mb-3 p-3 text-xs bg-status-danger/10 border border-status-danger/30 rounded text-status-danger">
            <div className="font-semibold mb-1">
              {t.settings.knowledge.collections.loadFailed}
            </div>
            <div className="break-all">{loadError}</div>
          </div>
        )}
        {!loaded && !loadError && (
          <div className="text-xs text-text-muted">{t.common.loading}</div>
        )}
        {loaded && !loadError && collections.length === 0 && (
          <div className="text-xs text-text-muted">
            {t.settings.knowledge.collections.empty}
          </div>
        )}

        <div className="space-y-1">
          {collections.map((c) => (
            <div
              key={c.name}
              className="flex items-center justify-between rounded border border-card-border p-2 text-sm"
            >
              <div className="min-w-0">
                <span className="font-mono text-xs text-text-primary">{c.name}</span>
                <span className="ml-2 text-[11px] text-text-muted">
                  {t.settings.knowledge.collections.chunkCount(c.count)} ·{' '}
                  <span className="font-mono">{c.embedder}</span>
                </span>
              </div>
              <button
                type="button"
                onClick={() => void handleDeleteCollection(c.name)}
                className="shrink-0 rounded border border-card-border px-2 py-1 text-xs text-text-muted hover:text-status-danger"
              >
                {t.settings.knowledge.collections.delete}
              </button>
            </div>
          ))}
        </div>

        {/* create row */}
        <div className="mt-3 flex items-center gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t.settings.knowledge.collections.namePlaceholder}
            className={inputClass + ' max-w-xs font-mono text-xs'}
          />
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={creating || !newName.trim()}
            className="shrink-0 rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {creating
              ? t.settings.knowledge.collections.creating
              : t.settings.knowledge.collections.create}
          </button>
        </div>
        <p className="mt-1 text-[11px] text-text-muted">
          {t.settings.knowledge.collections.nameHint}
        </p>
        {createError && (
          <p className="mt-1 text-xs text-status-danger break-all">{createError}</p>
        )}
      </section>

      {/* ② Ingest */}
      <section className="rounded-lg border border-card-border bg-card-bg/40 p-4">
        <h3 className="mb-3 text-sm font-semibold text-text-primary">
          {t.settings.knowledge.ingest.heading}
        </h3>

        <div className="flex flex-wrap items-end gap-3">
          <Field
            label={t.settings.knowledge.ingest.fieldCollection}
            className="w-56"
          >
            {collectionSelect(
              ingestCollection,
              setIngestCollection,
              t.settings.knowledge.ingest.selectCollection,
            )}
          </Field>
          {/* mode toggle */}
          <div className="flex rounded border border-card-border overflow-hidden text-xs">
            {(['text', 'file'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setMode(m);
                  setIngestMsg(null);
                }}
                className={`px-3 py-1.5 transition-colors ${
                  mode === m
                    ? 'bg-accent/20 text-text-primary'
                    : 'text-text-muted hover:text-text-primary'
                }`}
              >
                {m === 'text'
                  ? t.settings.knowledge.ingest.modeText
                  : t.settings.knowledge.ingest.modeFile}
              </button>
            ))}
          </div>
        </div>

        {mode === 'text' ? (
          <div className="mt-3 space-y-3">
            <Field label={t.settings.knowledge.ingest.fieldSource} className="max-w-xs">
              <input
                value={sourceName}
                onChange={(e) => setSourceName(e.target.value)}
                placeholder={t.settings.knowledge.ingest.sourcePlaceholder}
                className={inputClass + ' font-mono text-xs'}
              />
              <span className="text-[11px] text-text-muted">
                {t.settings.knowledge.ingest.sourceHint}
              </span>
            </Field>
            <textarea
              rows={8}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t.settings.knowledge.ingest.textPlaceholder}
              className={inputClass + ' resize-y font-mono text-xs leading-relaxed'}
            />
          </div>
        ) : (
          <div className="mt-3">
            <Field label={t.settings.knowledge.ingest.filesLabel}>
              <input
                key={fileInputKey}
                type="file"
                multiple
                accept=".txt,.md,.csv,.json"
                onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
                className="text-xs text-text-secondary file:mr-3 file:rounded file:border file:border-card-border file:bg-card-bg file:px-3 file:py-1.5 file:text-xs file:text-text-secondary file:cursor-pointer hover:file:bg-card-border/40"
              />
            </Field>
            <p className="mt-1 text-[11px] text-text-muted">
              {files.length > 0 &&
                t.settings.knowledge.ingest.filesSelected(files.length) + ' · '}
              {t.settings.knowledge.ingest.sourceHint}
            </p>
          </div>
        )}

        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void handleIngest()}
            disabled={!canIngest}
            className="rounded bg-accent px-4 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {ingesting
              ? t.settings.knowledge.ingest.submitting
              : t.settings.knowledge.ingest.submit}
          </button>
          {ingesting && (
            <span className="text-xs text-text-muted animate-pulse">
              {t.settings.knowledge.ingest.firstCallHint}
            </span>
          )}
          {ingestMsg && !ingesting && (
            <span
              className={`text-xs break-all ${
                ingestMsg.ok ? 'text-status-success' : 'text-status-danger'
              }`}
            >
              {ingestMsg.text}
            </span>
          )}
        </div>
      </section>

      {/* ③ Search preview */}
      <section className="rounded-lg border border-card-border bg-card-bg/40 p-4">
        <h3 className="mb-3 text-sm font-semibold text-text-primary">
          {t.settings.knowledge.search.heading}
        </h3>

        <div className="flex flex-wrap items-end gap-2">
          <Field
            label={t.settings.knowledge.search.fieldCollection}
            className="w-56"
          >
            {collectionSelect(
              searchCollection,
              setSearchCollection,
              t.settings.knowledge.search.selectCollection,
            )}
          </Field>
          <Field label="" className="flex-1 min-w-[200px]">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSearch();
              }}
              placeholder={t.settings.knowledge.search.queryPlaceholder}
              className={inputClass}
            />
          </Field>
          <Field label={t.settings.knowledge.search.fieldTopK} className="w-20">
            <input
              type="number"
              min={1}
              max={50}
              value={topK}
              onChange={(e) => setTopK(e.target.value)}
              className={inputClass}
            />
          </Field>
          <button
            type="button"
            onClick={() => void handleSearch()}
            disabled={searching || !searchCollection || !query.trim()}
            className="rounded bg-accent px-4 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {searching
              ? t.settings.knowledge.search.searching
              : t.settings.knowledge.search.submit}
          </button>
        </div>

        {searchError && (
          <p className="mt-3 text-xs text-status-danger break-all">{searchError}</p>
        )}
        {hits && hits.length === 0 && (
          <p className="mt-3 text-xs text-text-muted">
            {t.settings.knowledge.search.noHits}
          </p>
        )}
        {hits && hits.length > 0 && (
          <div className="mt-3 space-y-2">
            {hits.map((h) => {
              const isOpen = expanded.has(h.id);
              return (
                <div
                  key={h.id}
                  className="rounded border border-card-border p-2 text-sm"
                >
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="px-1.5 py-0.5 rounded bg-accent/20 text-accent-soft font-mono">
                      {h.score.toFixed(2)}
                    </span>
                    <span className="font-mono text-text-muted">
                      {h.meta.source} #{h.meta.chunk}
                    </span>
                    <button
                      type="button"
                      onClick={() => toggleExpanded(h.id)}
                      className="ml-auto text-text-muted hover:text-text-primary"
                    >
                      {isOpen
                        ? t.settings.knowledge.search.collapse
                        : t.settings.knowledge.search.expand}
                    </button>
                  </div>
                  <p
                    className={`mt-1 text-xs text-text-secondary whitespace-pre-wrap break-all ${
                      isOpen ? '' : 'line-clamp-3'
                    }`}
                  >
                    {h.text}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`flex flex-col gap-1 ${className ?? ''}`}>
      {label !== '' && (
        <span className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
          {label}
        </span>
      )}
      {children}
    </label>
  );
}

const inputClass =
  'w-full rounded border border-card-border bg-window-bg px-2 py-1 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none disabled:opacity-50';
