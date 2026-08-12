// Dashboard component - main sensor monitoring view.
//
// Pure UI shell. The data plane (WebSocket subscription, recording
// timer) lives in <AppBridge/> at the App root so that navigating
// to /chat doesn't tear it down.

import { useNavigate } from 'react-router-dom';
import { wsClient } from '../api/websocket';
import { Header } from './layout/Header';
import { ConnectionPanel } from './layout/ConnectionPanel';
import { ChannelGrid } from './channels/ChannelGrid';
import { AudioLevelMeter } from './audio/AudioLevelMeter';
import { RecordingControls } from './recording/RecordingControls';
import { DisplaySettings } from './settings/DisplaySettings';
import { ReplayPanel } from './replay/ReplayPanel';
import { useT, useLang } from '../contexts/LanguageContext';
import { useCan } from '../contexts/RoleContext';
import { useActivePatient } from '../lib/activePatient';
import { useLiveOwner } from '../hooks/useLiveOwner';

const BANNER = {
  zh: {
    back: '← 患者列表',
    viewing: '正在查看',
    none: '未选择患者 — 从患者列表进入可将录制归属到该患者',
    blocked: (name: string) =>
      `🔒 当前直播来自另一位患者（${name}）的设备。这位患者的手套未连接，因此不显示实时数据，也不能录制——避免把别人的数据记到这位名下。`,
  },
  en: {
    back: '← Patients',
    viewing: 'Viewing',
    none: 'No patient selected — enter from the patient list to attribute recordings',
    blocked: (name: string) =>
      `🔒 The live stream is another patient's device (${name}). This patient's glove isn't connected, so no live data is shown and recording is disabled — so nobody else's data is filed under this patient.`,
  },
};

function Dashboard() {
  const t = useT();
  const can = useCan();
  const { lang } = useLang();
  const navigate = useNavigate();
  const activePatient = useActivePatient();
  const liveOwner = useLiveOwner();
  const bn = BANNER[lang];
  // The single device streams for one patient (its claimer). If we're viewing a
  // DIFFERENT patient, that stream isn't theirs — don't render it under their
  // name, and don't let it be recorded against them.
  const blocked = !!(liveOwner && activePatient && liveOwner.patient_id !== activePatient.id);
  return (
    <div className="min-h-screen bg-window-bg flex flex-col">
      <Header />

      {/* Patient context — this dashboard is entered per-patient from the list.
          The banner names whose data is on screen and offers the way back. */}
      <div className="bg-card-bg border-b border-card-border px-6 py-2 flex items-center gap-3 text-sm">
        {can('route.patients') && (
          <button
            type="button"
            onClick={() => navigate('/patients')}
            className="shrink-0 text-accent hover:underline"
          >
            {bn.back}
          </button>
        )}
        {activePatient ? (
          <span className="truncate text-text-secondary">
            🧑 {bn.viewing} <b className="text-text-primary">{activePatient.name}</b>{' '}
            <span className="font-mono text-text-muted">{activePatient.id}</span>
          </span>
        ) : (
          <span className="truncate text-text-muted">{bn.none}</span>
        )}
      </div>

      <div className="flex-1 flex">
        <aside className="w-80 border-r border-card-border p-4 space-y-4 overflow-y-auto">
          {/* Connect = high-privilege hardware action, patient-owned. Doctor is
              excluded by device.connect, so the panel simply doesn't render for
              them — they observe (ChannelGrid) + record only. */}
          {can('device.connect') && <ConnectionPanel />}
          {/* Recording hidden while the live stream belongs to another patient —
              recording here would file their data under this patient. */}
          {can('device.record') && !blocked && <RecordingControls />}
          <ReplayPanel />
          <AudioLevelMeter />
          <DisplaySettings />
        </aside>

        <main className="flex-1 overflow-y-auto">
          {blocked ? (
            <div className="flex h-full items-center justify-center p-8">
              <div className="max-w-md rounded-xl border border-status-danger/40 bg-status-danger/10 p-6 text-center text-sm text-status-danger">
                {bn.blocked(liveOwner!.patient_name || liveOwner!.patient_id)}
              </div>
            </div>
          ) : (
            <ChannelGrid />
          )}
        </main>
      </div>

      <footer className="bg-card-bg border-t border-card-border px-6 py-2">
        <div className="flex items-center justify-between text-xs text-text-muted">
          <span>{t.dashboard.footer.version}</span>
          <span>
            {wsClient.isConnected()
              ? t.dashboard.footer.wsConnected
              : t.dashboard.footer.wsDisconnected}
          </span>
        </div>
      </footer>
    </div>
  );
}

export default Dashboard;
