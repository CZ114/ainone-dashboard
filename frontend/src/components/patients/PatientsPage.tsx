// /patients page — doctor workbench for patient profiles (M1).
//
// Left column lists patient cards; right column shows the selected
// profile as an editable form (PATCH), plus pairing-code reset and a
// placeholder for M3 ownership stats. Creating a patient (or resetting
// a code) surfaces the plaintext pairing code exactly once — the
// backend only stores a hash, so the modal is the single hand-off
// moment from doctor to patient.
//
// Visibility: route gating lives in App.tsx (route.patients); all
// mutating affordances here are additionally wrapped in
// can('patients.manage') per rolePolicy.

import { useCallback, useEffect, useState } from 'react';
import { Header } from '../layout/Header';
import { Toast, type ToastMessage } from '../Toast';
import { useAuth, useCan } from '../../contexts/RoleContext';
import { useLang } from '../../contexts/LanguageContext';
import { agentAdminApi, type WorkflowEvent } from '../../api/agentAdminApi';

// ---------- Wire types (agent_service /api/agent/patients) ------------------

interface Patient {
  id: string;          // P-xxx
  name: string;
  age: number | null;
  complaint: string;
  device: string;
  created_by: string;
  created_at: number;  // epoch seconds
}

/** POST/reset-code response — pair_code plaintext appears ONLY here. */
interface PairCodeResult {
  ok: boolean;
  id: string;
  name?: string;
  pair_code: string;
}

// ---------- HTTP helpers (mirrors agentAdminApi.asJson conventions) ---------

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body?.detail === 'string') detail = body.detail;
      else if (body?.detail != null) detail = JSON.stringify(body.detail);
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

const patientsApi = {
  async list(): Promise<{ patients: Patient[] }> {
    return asJson(await fetch('/api/agent/patients'));
  },
  async create(body: {
    name: string;
    age?: number;
    complaint: string;
    device: string;
    createdBy: string;
  }): Promise<PairCodeResult> {
    return asJson(
      await fetch('/api/agent/patients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  },
  async update(
    pid: string,
    patch: Partial<Pick<Patient, 'name' | 'complaint' | 'device'>> & { age?: number },
  ): Promise<{ ok: boolean }> {
    return asJson(
      await fetch(`/api/agent/patients/${encodeURIComponent(pid)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }),
    );
  },
  async resetCode(pid: string): Promise<PairCodeResult> {
    return asJson(
      await fetch(`/api/agent/patients/${encodeURIComponent(pid)}/reset-code`, {
        method: 'POST',
      }),
    );
  },
};

// ---------- Local i18n table -------------------------------------------------
// Deliberately NOT in i18n/strings.ts — that file is being edited by the
// Header work in parallel; a local table avoids the merge conflict.

interface PatientsText {
  heading: string;
  tagline: string;
  newPatient: string;
  loading: string;
  listEmpty: string;
  selectHint: string;
  profileTitle: string;
  fieldName: string;
  fieldId: string;
  fieldAge: string;
  fieldComplaint: string;
  fieldDevice: string;
  fieldCreatedBy: string;
  fieldCreatedAt: string;
  save: string;
  saved: string;
  noChanges: string;
  nameRequired: string;
  resetCode: string;
  confirmReset: (name: string) => string;
  codeTitle: string;
  codeWarning: string;
  copy: string;
  copied: string;
  close: string;
  createTitle: string;
  create: string;
  cancel: string;
  working: string;
  statsTitle: string;
  statsPlaceholder: string;
  dismiss: string;
  initiateAnalysis: string;
  analysisRunning: string;
  analysisStarted: string;
  analysisDone: string;
  analysisFailed: string;
}

const TEXT: Record<'zh' | 'en', PatientsText> = {
  zh: {
    heading: '病人档案',
    tagline: '医生工作台 — 档案、配对码与归属统计',
    newPatient: '+ 新建病人',
    loading: '加载中…',
    listEmpty: '暂无病人档案',
    selectHint: '从左侧选择一位病人查看档案',
    profileTitle: '档案',
    fieldName: '姓名',
    fieldId: '编号',
    fieldAge: '年龄',
    fieldComplaint: '主诉',
    fieldDevice: '设备',
    fieldCreatedBy: '建档人',
    fieldCreatedAt: '建档时间',
    save: '保存',
    saved: '已保存',
    noChanges: '没有需要保存的修改',
    nameRequired: '姓名不能为空',
    resetCode: '重置配对码',
    confirmReset: (name) => `确定为「${name}」重置配对码？旧码将立即失效。`,
    codeTitle: '一次性配对码',
    codeWarning: '此码只显示这一次 — 请立即抄送给病人。关闭后无法再次查看，只能重置。',
    copy: '复制',
    copied: '已复制',
    close: '关闭',
    createTitle: '新建病人',
    create: '建档',
    cancel: '取消',
    working: '处理中…',
    statsTitle: '归属统计',
    statsPlaceholder:
      '该病人的日记/录音/会话/运行归属统计将在 M3 (owner 过滤) 落地后显示。',
    dismiss: '关闭',
    initiateAnalysis: '▶ 为此患者发起分析',
    analysisRunning: '分析中…',
    analysisStarted: '已为该患者发起随访分析',
    analysisDone: '随访分析完成',
    analysisFailed: '分析出错',
  },
  en: {
    heading: 'Patients',
    tagline: 'Doctor workbench — profiles, pairing codes and ownership stats',
    newPatient: '+ New patient',
    loading: 'Loading…',
    listEmpty: 'No patient profiles yet',
    selectHint: 'Select a patient on the left to view the profile',
    profileTitle: 'Profile',
    fieldName: 'Name',
    fieldId: 'ID',
    fieldAge: 'Age',
    fieldComplaint: 'Chief complaint',
    fieldDevice: 'Device',
    fieldCreatedBy: 'Created by',
    fieldCreatedAt: 'Created at',
    save: 'Save',
    saved: 'Saved',
    noChanges: 'Nothing to save',
    nameRequired: 'Name is required',
    resetCode: 'Reset pairing code',
    confirmReset: (name) =>
      `Reset the pairing code for "${name}"? The old code stops working immediately.`,
    codeTitle: 'One-time pairing code',
    codeWarning:
      'This code is shown only once — hand it to the patient now. It cannot be viewed again, only reset.',
    copy: 'Copy',
    copied: 'Copied',
    close: 'Close',
    createTitle: 'New patient',
    create: 'Create',
    cancel: 'Cancel',
    working: 'Working…',
    statsTitle: 'Ownership stats',
    statsPlaceholder:
      "This patient's diary/recording/session/run ownership stats will appear once M3 (owner filtering) lands.",
    dismiss: 'Dismiss',
    initiateAnalysis: '▶ Initiate analysis',
    analysisRunning: 'Analysing…',
    analysisStarted: 'Follow-up analysis started for this patient',
    analysisDone: 'Follow-up analysis done',
    analysisFailed: 'Analysis failed',
  },
};

// ---------- Small helpers ----------------------------------------------------

function formatDate(epochSeconds: number): string {
  if (!epochSeconds) return '—';
  return new Date(epochSeconds * 1000).toLocaleDateString();
}

/** Empty string ⇄ number bridge for the age <input>. */
function parseAge(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

interface FormDraft {
  name: string;
  age: string;       // keep as string; parse on submit
  complaint: string;
  device: string;
}

const EMPTY_DRAFT: FormDraft = { name: '', age: '', complaint: '', device: '' };

let toastSeq = 0;

// ---------- Page -------------------------------------------------------------

export default function PatientsPage() {
  const { auth } = useAuth();
  const can = useCan();
  const { lang } = useLang();
  const T = TEXT[lang];
  const canManage = can('patients.manage');

  const [patients, setPatients] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<FormDraft>(EMPTY_DRAFT);

  // Create form is mutually exclusive with the profile panel.
  const [creating, setCreating] = useState(false);
  const [createDraft, setCreateDraft] = useState<FormDraft>(EMPTY_DRAFT);

  const [busy, setBusy] = useState(false);
  const [workflowRunning, setWorkflowRunning] = useState(false);
  // One-time pairing code modal — the ONLY place plaintext appears.
  const [pairCode, setPairCode] = useState<{ id: string; name: string; code: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const showToast = useCallback((text: string, kind?: ToastMessage['kind']) => {
    setToast({ id: ++toastSeq, text, kind });
  }, []);

  const loadPatients = useCallback(async () => {
    try {
      const res = await patientsApi.list();
      setPatients(res.patients);
      setError(null);
      return res.patients;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPatients();
  }, [loadPatients]);

  // Auto-select the first patient once the list arrives.
  useEffect(() => {
    if (selectedId === null && patients.length > 0) {
      setSelectedId(patients[0].id);
    }
  }, [patients, selectedId]);

  const selected = patients.find((p) => p.id === selectedId) ?? null;

  // Re-seed the edit draft whenever the selection (or its data) changes.
  useEffect(() => {
    if (!selected) {
      setDraft(EMPTY_DRAFT);
      return;
    }
    setDraft({
      name: selected.name,
      age: selected.age === null ? '' : String(selected.age),
      complaint: selected.complaint,
      device: selected.device,
    });
    // Depend on the row's fields, not the object identity, so a list
    // refresh after PATCH doesn't clobber in-progress edits needlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.name, selected?.age, selected?.complaint, selected?.device]);

  // Reset "copied" feedback whenever a new code modal opens.
  useEffect(() => {
    setCopied(false);
  }, [pairCode]);

  // ---- profile save (PATCH: only changed fields) ----
  const dirty =
    selected !== null &&
    (draft.name.trim() !== selected.name ||
      (parseAge(draft.age) ?? null) !== selected.age ||
      draft.complaint !== selected.complaint ||
      draft.device !== selected.device);

  const handleSave = async () => {
    if (!selected) return;
    if (!draft.name.trim()) {
      showToast(T.nameRequired, 'error');
      return;
    }
    const patch: { name?: string; age?: number; complaint?: string; device?: string } = {};
    if (draft.name.trim() !== selected.name) patch.name = draft.name.trim();
    const age = parseAge(draft.age);
    if (age !== undefined && age !== selected.age) patch.age = age;
    if (draft.complaint !== selected.complaint) patch.complaint = draft.complaint;
    if (draft.device !== selected.device) patch.device = draft.device;
    if (Object.keys(patch).length === 0) {
      // Backend 404s on an empty patch — guard here instead.
      showToast(T.noChanges, 'info');
      return;
    }
    setBusy(true);
    try {
      await patientsApi.update(selected.id, patch);
      await loadPatients();
      showToast(T.saved, 'success');
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  // ---- pairing code reset ----
  const handleResetCode = async () => {
    if (!selected) return;
    if (!window.confirm(T.confirmReset(selected.name))) return;
    setBusy(true);
    try {
      const res = await patientsApi.resetCode(selected.id);
      setPairCode({ id: res.id, name: selected.name, code: res.pair_code });
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  // ---- initiate a follow-up analysis workflow FOR this patient ----
  // 无 human 的 followup_review, 带 patientId → run 归属服务对象患者,
  // 患者今天页照护丝带据此显示真实进度。医生停在页面直到 Toast 反馈。
  const handleInitiateAnalysis = async () => {
    if (!selected) return;
    setWorkflowRunning(true);
    showToast(T.analysisStarted, 'info');
    try {
      await agentAdminApi.streamWorkflow(
        'followup_review',
        { complaint: selected.complaint || selected.name },
        (e: WorkflowEvent) => {
          if (e.type === 'workflow_end') showToast(T.analysisDone, 'success');
          else if (e.type === 'error') showToast(T.analysisFailed, 'error');
        },
        undefined,
        selected.id,
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setWorkflowRunning(false);
    }
  };

  // ---- create patient ----
  const handleCreate = async () => {
    const name = createDraft.name.trim();
    if (!name) {
      showToast(T.nameRequired, 'error');
      return;
    }
    setBusy(true);
    try {
      const res = await patientsApi.create({
        name,
        age: parseAge(createDraft.age),
        complaint: createDraft.complaint,
        device: createDraft.device,
        createdBy: auth.id,
      });
      setPairCode({ id: res.id, name: res.name ?? name, code: res.pair_code });
      setCreating(false);
      setCreateDraft(EMPTY_DRAFT);
      await loadPatients();
      setSelectedId(res.id);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async () => {
    if (!pairCode) return;
    try {
      await navigator.clipboard.writeText(pairCode.code);
      setCopied(true);
    } catch {
      /* clipboard unavailable (http / permissions) — code stays selectable */
    }
  };

  // Shared input styling — semantic tokens only.
  const inputCls =
    'w-full rounded-lg border border-card-border bg-window-bg px-3 py-2 text-sm text-text-primary ' +
    'placeholder:text-text-muted focus:border-accent focus:outline-none disabled:opacity-60';
  const labelCls = 'text-xs text-text-muted';

  const renderFields = (
    value: FormDraft,
    onChange: (next: FormDraft) => void,
    disabled: boolean,
  ) => (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className={labelCls}>{T.fieldName} *</span>
        <input
          type="text"
          value={value.name}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
          disabled={disabled}
          className={inputCls}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelCls}>{T.fieldAge}</span>
        <input
          type="number"
          min={0}
          value={value.age}
          onChange={(e) => onChange({ ...value, age: e.target.value })}
          disabled={disabled}
          className={inputCls}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelCls}>{T.fieldComplaint}</span>
        <textarea
          rows={2}
          value={value.complaint}
          onChange={(e) => onChange({ ...value, complaint: e.target.value })}
          disabled={disabled}
          className={`${inputCls} resize-y`}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelCls}>{T.fieldDevice}</span>
        <input
          type="text"
          value={value.device}
          onChange={(e) => onChange({ ...value, device: e.target.value })}
          disabled={disabled}
          className={inputCls}
        />
      </label>
    </div>
  );

  return (
    <div className="flex min-h-screen flex-col bg-window-bg text-text-primary">
      <Header />
      <Toast message={toast} onDismiss={() => setToast(null)} />

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 overflow-y-auto px-6 py-6">
        <div>
          <h1 className="text-xl font-bold">{T.heading}</h1>
          <p className="text-xs text-text-muted">{T.tagline}</p>
        </div>

        {error && (
          <div
            role="alert"
            className="flex items-start justify-between gap-3 rounded-lg border border-status-danger/40 bg-status-danger/10 p-3 text-sm text-status-danger"
          >
            <span className="whitespace-pre-wrap">{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              className="rounded border border-status-danger/40 px-2 text-xs"
            >
              {T.dismiss}
            </button>
          </div>
        )}

        <div className="flex flex-1 flex-col gap-4 md:flex-row">
          {/* ---- Left: patient list ---- */}
          <aside className="flex w-full shrink-0 flex-col gap-3 md:w-64">
            {canManage && (
              <button
                type="button"
                onClick={() => setCreating(true)}
                disabled={busy}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-60"
              >
                {T.newPatient}
              </button>
            )}

            {loading ? (
              <div className="rounded-lg border border-dashed border-card-border p-6 text-center text-sm text-text-muted">
                {T.loading}
              </div>
            ) : patients.length === 0 ? (
              <div className="rounded-lg border border-dashed border-card-border p-6 text-center text-sm text-text-muted">
                {T.listEmpty}
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {patients.map((p) => {
                  const active = p.id === selectedId && !creating;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        setSelectedId(p.id);
                        setCreating(false);
                      }}
                      className={`rounded-lg border bg-card-bg p-3 text-left transition-colors ${
                        active
                          ? 'border-accent'
                          : 'border-card-border hover:border-accent/40'
                      }`}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-sm font-medium">{p.name}</span>
                        <span className="font-mono text-xs text-text-muted">{p.id}</span>
                      </div>
                      <div className="mt-1 truncate text-xs text-text-secondary">
                        {p.age !== null && <span>{p.age} · </span>}
                        {p.complaint || '—'}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </aside>

          {/* ---- Right: create form / profile + stats ---- */}
          <section className="flex min-w-0 flex-1 flex-col gap-4">
            {creating && canManage ? (
              <div className="rounded-lg border border-card-border bg-card-bg p-4">
                <h2 className="mb-3 text-sm font-semibold">{T.createTitle}</h2>
                {renderFields(createDraft, setCreateDraft, busy)}
                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    onClick={() => void handleCreate()}
                    disabled={busy || !createDraft.name.trim()}
                    className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-60"
                  >
                    {busy ? T.working : T.create}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCreating(false);
                      setCreateDraft(EMPTY_DRAFT);
                    }}
                    disabled={busy}
                    className="rounded-lg border border-card-border px-4 py-2 text-sm text-text-secondary hover:bg-card-border/40"
                  >
                    {T.cancel}
                  </button>
                </div>
              </div>
            ) : selected ? (
              <>
                <div className="rounded-lg border border-card-border bg-card-bg p-4">
                  <div className="mb-3 flex items-baseline justify-between gap-2">
                    <h2 className="text-sm font-semibold">{T.profileTitle}</h2>
                    <span className="font-mono text-xs text-text-muted">
                      {T.fieldId}: {selected.id}
                    </span>
                  </div>

                  {renderFields(draft, setDraft, busy || !canManage)}

                  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
                    <span>
                      {T.fieldCreatedBy}: {selected.created_by || '—'}
                    </span>
                    <span>
                      {T.fieldCreatedAt}: {formatDate(selected.created_at)}
                    </span>
                  </div>

                  {canManage && (
                    <div className="mt-4 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void handleSave()}
                        disabled={busy || !dirty}
                        className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-60"
                      >
                        {busy ? T.working : T.save}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleResetCode()}
                        disabled={busy}
                        className="rounded-lg border border-status-danger/40 px-4 py-2 text-sm text-status-danger transition-colors hover:bg-status-danger/10 disabled:opacity-60"
                      >
                        {T.resetCode}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleInitiateAnalysis()}
                        disabled={busy || workflowRunning}
                        className="rounded-lg border border-accent px-4 py-2 text-sm text-accent transition-colors hover:bg-accent/10 disabled:opacity-60"
                      >
                        {workflowRunning ? T.analysisRunning : T.initiateAnalysis}
                      </button>
                    </div>
                  )}
                </div>

                {/* Ownership stats — honest placeholder until M3 lands. */}
                <div className="rounded-lg border border-dashed border-card-border bg-card-bg p-4">
                  <h2 className="mb-2 text-sm font-semibold text-text-secondary">
                    {T.statsTitle}
                  </h2>
                  <p className="text-xs text-text-muted">{T.statsPlaceholder}</p>
                </div>
              </>
            ) : (
              !loading && (
                <div className="rounded-lg border border-dashed border-card-border p-8 text-center text-sm text-text-muted">
                  {T.selectHint}
                </div>
              )
            )}
          </section>
        </div>
      </main>

      {/* ---- One-time pairing code modal ---- */}
      {pairCode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-lg border border-card-border bg-card-bg p-6 shadow-lg">
            <h2 className="text-sm font-semibold">{T.codeTitle}</h2>
            <p className="mt-1 text-xs text-text-secondary">
              <span className="font-mono">{pairCode.id}</span> · {pairCode.name}
            </p>

            <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-accent/40 bg-accent/5 px-4 py-3">
              <span className="select-all font-mono text-3xl font-bold tracking-widest">
                {pairCode.code}
              </span>
              <button
                type="button"
                onClick={() => void handleCopy()}
                className="rounded-lg border border-card-border px-3 py-2 text-xs text-text-secondary hover:bg-card-border/40"
              >
                {copied ? T.copied : T.copy}
              </button>
            </div>

            <p className="mt-3 text-xs text-status-danger">{T.codeWarning}</p>

            <button
              type="button"
              onClick={() => setPairCode(null)}
              className="mt-4 w-full rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
            >
              {T.close}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
