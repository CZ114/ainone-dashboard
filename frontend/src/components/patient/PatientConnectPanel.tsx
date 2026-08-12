// PatientConnectPanel — patient-facing one-tap hardware connect (glove + mic).
//
// Connecting hardware is a high-privilege physical action, so it lives on the
// patient side (rolePolicy `device.connect`), not the doctor's. No serial /
// baud / UDP jargon: the glove is a BLE device ("ESP32-S3-MultiSensor"); the
// mic is the audio stream on the backend's default UDP port. Tapping a button
// again disconnects. The developer keeps the full ConnectionPanel for serial +
// custom ports. Glove connect = scan then poll until attached (10 s budget);
// mic connect = start/stop the audio listener.

import { useState } from 'react';
import { useStore } from '../../store';
import { serialApi, bleApi, audioApi, liveApi } from '../../api/client';
import { useAuth } from '../../contexts/RoleContext';
import { useLang } from '../../contexts/LanguageContext';

// A plugged-in glove shows up as a USB-serial port; match the usual ESP32 /
// USB-UART bridge chips so we can prefer the wired link over BLE.
const WIRED_HINT = /esp32|cp210|ch340|ch910|wch|silicon\s*labs|usb.?serial|uart/i;

// Matches DEFAULT_BLE_NAME in ConnectionPanel / the firmware's advertised name.
const GLOVE_BLE_NAME = 'ESP32-S3-MultiSensor';
const CONNECT_BUDGET_MS = 10_000;

const TEXT = {
  zh: {
    gloveConnect: '连接手套',
    gloveConnecting: '正在连接手套…',
    gloveDisconnect: '断开手套',
    gloveHint: '戴上手套、确认已开机，然后点这里连接',
    gloveFailed: '没找到手套。确认手套已开机、就在附近，再试一次。',
    micConnect: '连接麦克风',
    micConnecting: '正在开启麦克风…',
    micDisconnect: '关闭麦克风',
    micHint: '语音陪伴或带声音的记录需要麦克风',
    micFailed: '麦克风开启失败，请重试。',
  },
  en: {
    gloveConnect: 'Connect glove',
    gloveConnecting: 'Connecting…',
    gloveDisconnect: 'Disconnect glove',
    gloveHint: 'Put the glove on, make sure it is powered, then tap to connect',
    gloveFailed: 'Glove not found. Make sure it is powered and nearby, then try again.',
    micConnect: 'Connect microphone',
    micConnecting: 'Starting mic…',
    micDisconnect: 'Turn off microphone',
    micHint: 'Voice companion & recordings with sound need the microphone',
    micFailed: 'Could not start the microphone. Try again.',
  },
};

export function PatientConnectPanel() {
  const { lang } = useLang();
  const t = TEXT[lang];
  const { auth } = useAuth();
  const serial = useStore((s) => s.serial);
  const ble = useStore((s) => s.ble);
  const audio = useStore((s) => s.audio);
  const setSerialConnected = useStore((s) => s.setSerialConnected);
  const setBleConnected = useStore((s) => s.setBleConnected);
  const setAudioConnected = useStore((s) => s.setAudioConnected);

  const [gloveBusy, setGloveBusy] = useState(false);
  const [gloveFailed, setGloveFailed] = useState(false);
  const [micBusy, setMicBusy] = useState(false);
  const [micFailed, setMicFailed] = useState(false);

  // Claim / release the shared live stream so a dashboard viewing a DIFFERENT
  // patient won't render this device's data under the wrong name. Fire-and-forget.
  const claimLive = () => void liveApi.setOwner(auth.id, auth.name).catch(() => {});
  const releaseLive = () => void liveApi.clearOwner().catch(() => {});

  async function toggleGlove() {
    if (gloveBusy) return;
    setGloveFailed(false);

    // Disconnect whichever transport is currently up (wired and/or wireless).
    if (serial.connected || ble.connected) {
      setGloveBusy(true);
      try {
        if (serial.connected) {
          await serialApi.disconnect();
          setSerialConnected(false);
        }
        if (ble.connected) {
          await bleApi.disconnect();
          setBleConnected(false);
        }
      } catch (e) {
        console.error('[Glove] disconnect failed:', e);
      } finally {
        releaseLive();
        setGloveBusy(false);
      }
      return;
    }

    setGloveBusy(true);
    try {
      // Wired first: if the glove is plugged in (a USB-serial port is present),
      // use the cable; only fall back to BLE when there's no wired option.
      let wiredPort: string | null = null;
      try {
        const res = await serialApi.listPorts();
        const ports: Array<{ port: string; desc?: string }> = res.ports || [];
        if (ports.length > 0) {
          const match = ports.find((p) => WIRED_HINT.test(`${p.port} ${p.desc ?? ''}`));
          wiredPort = (match ?? ports[0]).port;
        }
      } catch (e) {
        console.error('[Glove] listing serial ports failed:', e);
      }

      if (wiredPort) {
        try {
          await serialApi.connect(wiredPort, 115200);
          setSerialConnected(true, wiredPort);
          claimLive();
          return;
        } catch (e) {
          console.error('[Glove] wired connect failed, falling back to BLE:', e);
          // fall through to the wireless path
        }
      }

      // Wireless: scan for the glove, then poll until the backend reports it up.
      await bleApi.scan(GLOVE_BLE_NAME);
      const deadline = Date.now() + CONNECT_BUDGET_MS;
      let ok = false;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const status = await bleApi.getStatus();
          if (status.connected) {
            setBleConnected(true);
            claimLive();
            ok = true;
            break;
          }
        } catch {
          /* backend momentarily busy — keep polling */
        }
      }
      if (!ok) setGloveFailed(true);
    } catch (e) {
      console.error('[Glove] connect failed:', e);
      setGloveFailed(true);
    } finally {
      setGloveBusy(false);
    }
  }

  async function toggleMic() {
    if (micBusy) return;
    setMicFailed(false);

    if (audio.connected) {
      setMicBusy(true);
      try {
        await audioApi.stop();
        setAudioConnected(false);
      } catch (e) {
        console.error('[Mic] stop failed:', e);
      } finally {
        setMicBusy(false);
      }
      return;
    }

    setMicBusy(true);
    try {
      await audioApi.start(); // default UDP port on the backend
      setAudioConnected(true);
    } catch (e) {
      console.error('[Mic] start failed:', e);
      setMicFailed(true);
    } finally {
      setMicBusy(false);
    }
  }

  const gloveOn = serial.connected || ble.connected;
  const micOn = audio.connected;

  return (
    <div className="pt-2.5 mt-0.5 border-t border-card-border space-y-2.5">
      {/* Glove — primary, filled */}
      <div>
        <button
          onClick={toggleGlove}
          disabled={gloveBusy}
          className={`w-full py-2.5 px-4 rounded-lg font-semibold text-sm text-white transition-colors disabled:opacity-60 ${
            gloveOn ? 'bg-status-danger hover:opacity-90' : 'bg-accent hover:opacity-90'
          }`}
        >
          {gloveBusy
            ? gloveOn ? '…' : t.gloveConnecting
            : gloveOn ? t.gloveDisconnect : `🧤 ${t.gloveConnect}`}
        </button>
        {!gloveOn && !gloveBusy && <p className="text-[11px] text-text-muted mt-1.5">{t.gloveHint}</p>}
        {gloveFailed && <p className="text-[11px] text-status-danger mt-1.5">{t.gloveFailed}</p>}
      </div>

      {/* Mic — secondary, outlined */}
      <div>
        <button
          onClick={toggleMic}
          disabled={micBusy}
          className={`w-full py-2 px-4 rounded-lg font-medium text-sm border transition-colors disabled:opacity-60 ${
            micOn
              ? 'border-status-danger/60 text-status-danger hover:bg-status-danger/10'
              : 'border-card-border text-text-secondary hover:text-text-primary hover:bg-card-border/40'
          }`}
        >
          {micBusy
            ? t.micConnecting
            : micOn ? t.micDisconnect : `🎤 ${t.micConnect}`}
        </button>
        {!micOn && !micBusy && <p className="text-[11px] text-text-muted mt-1.5">{t.micHint}</p>}
        {micFailed && <p className="text-[11px] text-status-danger mt-1.5">{t.micFailed}</p>}
      </div>
    </div>
  );
}
