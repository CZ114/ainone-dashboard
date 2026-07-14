// DeviceStatusCard — "smart glove connection status" translated out of
// engineering terms. No BLE / Serial / COM / port jargon; the patient
// sees "glove connected", "mic ready", "reading N sensors".
//
// The device is a smart glove (finger PPG, hand IMU, palm GSR, etc.).
// Fields are all real store values (ble/serial/audio.connected,
// channelCount, recording); the pipeline has no signal-quality or
// battery field, so we don't invent one.

import { useLang } from '../../contexts/LanguageContext';
import type { DeviceStatus } from '../../hooks/usePatientInsights';

const TEXT = {
  zh: {
    title: '手套连接状态',
    glove: '智能手套', gloveOn: '已连接', gloveOff: '未连接',
    hub: '数据同步', hubOn: '已连接', hubOff: '未连接',
    mic: '麦克风', micOn: '活跃', micOff: '待机',
    sensors: (n: number) => `正在采集 ${n} 路传感器数据`,
    recording: '记录中',
    allGood: '手套一切正常',
    hint: '请戴上手套并确认它已开机',
  },
  en: {
    title: 'Glove status',
    glove: 'Smart glove', gloveOn: 'connected', gloveOff: 'not connected',
    hub: 'Data sync', hubOn: 'connected', hubOff: 'not connected',
    mic: 'Microphone', micOn: 'ready', micOff: 'standby',
    sensors: (n: number) => `Reading ${n} sensor streams`,
    recording: 'Recording',
    allGood: 'Your glove is all set',
    hint: 'Please put the glove on and make sure it is powered',
  },
};

function Dot({ on }: { on: boolean }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${
        on ? 'bg-status-connected' : 'bg-status-disconnected'
      }`}
    />
  );
}

function Row({ on, label, state }: { on: boolean; label: string; state: string }) {
  return (
    <div className="flex items-center gap-2 text-[13px]">
      <Dot on={on} />
      <span className="text-text-secondary">{label}</span>
      <span className={`ml-auto font-medium ${on ? 'text-text-primary' : 'text-text-muted'}`}>
        {state}
      </span>
    </div>
  );
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function DeviceStatusCard({ device }: { device: DeviceStatus }) {
  const { lang } = useLang();
  const t = TEXT[lang];

  return (
    <div className="bg-card-bg border border-card-border rounded-xl p-4">
      <h3 className="text-sm font-semibold text-text-primary mb-3">🧤 {t.title}</h3>

      <div className="flex flex-col gap-2.5">
        <Row on={device.glove.connected} label={t.glove} state={device.glove.connected ? t.gloveOn : t.gloveOff} />
        <Row on={device.hub.connected} label={t.hub} state={device.hub.connected ? t.hubOn : t.hubOff} />
        <Row on={device.mic.connected} label={t.mic} state={device.mic.connected ? t.micOn : t.micOff} />

        {device.channelCount > 0 && (
          <div className="flex items-center gap-2 text-[12.5px] text-text-muted pt-0.5">
            <span className="inline-block w-2 h-2 rounded-full bg-accent shrink-0" />
            {t.sensors(device.channelCount)}
          </div>
        )}

        {device.recording.active && (
          <div className="flex items-center gap-2 text-[13px] text-status-disconnected font-medium">
            <span className="relative flex items-center justify-center w-2 h-2">
              <span className="w-2 h-2 rounded-full bg-status-disconnected" />
              <span className="absolute w-2 h-2 rounded-full bg-status-disconnected animate-ping opacity-75" />
            </span>
            {t.recording} {fmt(device.recording.elapsedSec)}
          </div>
        )}
      </div>

      <div className="mt-3 pt-3 border-t border-card-border text-[11.5px] text-text-muted">
        {device.anyConnected ? `✓ ${t.allGood}` : t.hint}
      </div>
    </div>
  );
}
