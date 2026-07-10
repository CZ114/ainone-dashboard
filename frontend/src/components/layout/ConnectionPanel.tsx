// ConnectionPanel - serial and BLE connection controls

import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../store';
import { serialApi, bleApi, audioApi } from '../../api/client';
import { useT } from '../../contexts/LanguageContext';

export function ConnectionPanel() {
  const t = useT();
  const serial = useStore((state) => state.serial);
  const ble = useStore((state) => state.ble);
  const audio = useStore((state) => state.audio);
  const setSerialConnected = useStore((state) => state.setSerialConnected);
  const setAvailablePorts = useStore((state) => state.setAvailablePorts);
  const setBleConnected = useStore((state) => state.setBleConnected);
  const setAudioConnected = useStore((state) => state.setAudioConnected);

  const [selectedPort, setSelectedPort] = useState('');
  const [baudRate, setBaudRate] = useState(115200);

  // BLE device name + UDP audio port — user-editable, persisted to
  // localStorage so each user keeps their own preferred values across
  // page reloads. Defaults match config.py constants on the backend.
  const BLE_NAME_KEY = 'connection-ble-device-name';
  const AUDIO_PORT_KEY = 'connection-audio-port';
  const DEFAULT_BLE_NAME = 'ESP32-S3-MultiSensor';
  const DEFAULT_AUDIO_PORT = 8888;
  const [bleDeviceName, setBleDeviceName] = useState<string>(() => {
    try {
      return localStorage.getItem(BLE_NAME_KEY) ?? DEFAULT_BLE_NAME;
    } catch {
      return DEFAULT_BLE_NAME;
    }
  });
  const [audioPort, setAudioPort] = useState<string>(() => {
    try {
      return localStorage.getItem(AUDIO_PORT_KEY) ?? String(DEFAULT_AUDIO_PORT);
    } catch {
      return String(DEFAULT_AUDIO_PORT);
    }
  });
  // Persist whenever the user commits an edit. Wrapped in try/catch
  // because Safari private mode + storage quotas can throw.
  useEffect(() => {
    try { localStorage.setItem(BLE_NAME_KEY, bleDeviceName); } catch { /* ignore */ }
  }, [bleDeviceName]);
  useEffect(() => {
    try { localStorage.setItem(AUDIO_PORT_KEY, audioPort); } catch { /* ignore */ }
  }, [audioPort]);
  // Per-tier ACTION INTENT, not "loading flag".
  //
  // The label needs to follow what the USER is doing — not what the
  // current ble.connected boolean says. Otherwise: clicking Scan flips
  // ble.connected=true mid-scan (the backend's WS sends connection_status
  // as soon as it actually attaches), and the button suddenly reads
  // "Disconnecting…" while we're still finishing the connect flow.
  //
  // 'connecting' = user-initiated connect / scan in progress
  // 'disconnecting' = user-initiated disconnect / stop in progress
  // null = idle, follow ble.connected for the label
  type Action = null | 'connecting' | 'disconnecting';
  const [serialAction, setSerialAction] = useState<Action>(null);
  const [bleAction, setBleAction] = useState<Action>(null);
  const [audioAction, setAudioAction] = useState<Action>(null);

  // Fetch available serial ports — once on mount, plus on demand via
  // the ↻ button next to the dropdown. We don't poll; plugging in a
  // USB-serial device after page load is rare enough that a manual
  // refresh is cleaner than a 2-second background fetch loop.
  // Selecting the first port only auto-fires when nothing is selected
  // yet, so a refresh that returns the same set won't move the user's
  // selection out from under them.
  const [portsRefreshing, setPortsRefreshing] = useState(false);
  const fetchPorts = useCallback(async () => {
    setPortsRefreshing(true);
    try {
      const result = await serialApi.listPorts();
      const ports: Array<{ port: string; desc?: string }> = result.ports || [];
      setAvailablePorts(ports);
      setSelectedPort((prev) => {
        if (prev && ports.some((p) => p.port === prev)) return prev;
        return ports[0]?.port ?? '';
      });
    } catch (e) {
      console.error('Failed to list ports:', e);
    } finally {
      setPortsRefreshing(false);
    }
  }, [setAvailablePorts]);
  useEffect(() => {
    void fetchPorts();
  }, [fetchPorts]);

  const handleSerialConnect = async () => {
    if (serial.connected) {
      setSerialAction('disconnecting');
      try {
        await serialApi.disconnect();
        setSerialConnected(false);
      } catch (e) {
        console.error('Failed to disconnect:', e);
      } finally {
        setSerialAction(null);
      }
    } else {
      setSerialAction('connecting');
      try {
        await serialApi.connect(selectedPort, baudRate);
        setSerialConnected(true, selectedPort);
      } catch (e) {
        console.error('Failed to connect:', e);
      } finally {
        setSerialAction(null);
      }
    }
  };

  const handleBleConnect = async () => {
    if (ble.connected) {
      setBleAction('disconnecting');
      try {
        await bleApi.disconnect();
        setBleConnected(false);
      } catch (e) {
        console.error('Failed to disconnect BLE:', e);
      } finally {
        setBleAction(null);
      }
    } else {
      // Action stays 'connecting' across the entire scan + poll cycle.
      // Even when the backend WS pushes ble.connected=true mid-scan,
      // the button keeps reading "Connecting…" until we end the action,
      // because the label is driven by `bleAction` not by ble.connected.
      setBleAction('connecting');
      try {
        // Pass the user's typed device name so the backend re-targets
        // the bridge before scanning. Empty / blank falls back to the
        // last-set value on the server.
        await bleApi.scan(bleDeviceName);
        const deadline = Date.now() + 10_000; // 10 s budget
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 500));
          try {
            const status = await bleApi.getStatus();
            if (status.connected) {
              setBleConnected(true);
              break;
            }
          } catch {
            // keep polling — backend may be momentarily busy
          }
        }
      } catch (e) {
        console.error('Failed to scan BLE:', e);
      } finally {
        setBleAction(null);
      }
    }
  };

  const handleAudioConnect = async () => {
    if (audio.connected) {
      setAudioAction('disconnecting');
      try {
        await audioApi.stop();
        setAudioConnected(false);
      } catch (e) {
        console.error('Failed to stop audio:', e);
      } finally {
        setAudioAction(null);
      }
    } else {
      setAudioAction('connecting');
      try {
        const portNum = parseInt(audioPort, 10);
        if (!Number.isFinite(portNum) || portNum < 1 || portNum > 65535) {
          throw new Error(`Invalid UDP port: ${audioPort}`);
        }
        await audioApi.start(portNum);
        setAudioConnected(true);
      } catch (e) {
        console.error('Failed to start audio:', e);
      } finally {
        setAudioAction(null);
      }
    }
  };

  // Helper: pick the right button label given the current action and
  // connection state. Verbs are passed in fully (no string concat) so
  // we don't end up with malformed gerunds like "Scaning…".
  const labelFor = (
    action: Action,
    connected: boolean,
    idleConnect: string, // e.g. "Connect" / "Scan" / "Start"
    idleDisconnect: string, // e.g. "Disconnect" / "Stop"
    busyConnecting: string, // e.g. "Connecting…" / "Scanning…" / "Starting…"
    busyDisconnecting: string, // e.g. "Disconnecting…" / "Stopping…"
  ): string => {
    if (action === 'connecting') return busyConnecting;
    if (action === 'disconnecting') return busyDisconnecting;
    return connected ? idleDisconnect : idleConnect;
  };

  return (
    <div className="bg-card-bg rounded-xl p-4 border border-card-border space-y-4">
      {/* Serial Connection */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-semibold text-text-primary">{t.dashboard.connectionPanel.serialTitle}</span>
          <span
            className={`text-xs ${serial.connected ? 'text-status-connected' : 'text-text-muted'}`}
          >
            {serial.connected
              ? t.dashboard.connectionPanel.connectedDot
              : t.dashboard.connectionPanel.disconnectedDot}
          </span>
        </div>

        <div className="flex gap-2 min-w-0">
          {/* min-w-0 + truncate on the select itself keeps a very long
              port description from blowing out the flex row. `<option>`
              text can't be CSS-truncated across browsers, so we also
              clip the label string and surface the full value via
              title + the currently-selected port shown below. */}
          <button
            type="button"
            onClick={() => void fetchPorts()}
            disabled={serial.connected || serialAction !== null || portsRefreshing}
            title="Refresh port list"
            className="shrink-0 px-2 py-1.5 rounded border border-card-border text-text-muted hover:text-text-primary hover:bg-card-border/40 disabled:opacity-50"
          >
            {portsRefreshing ? '⏳' : '↻'}
          </button>
          <select
            value={selectedPort}
            onChange={(e) => setSelectedPort(e.target.value)}
            disabled={serial.connected || serialAction !== null}
            title={
              serial.availablePorts.find((p) => p.port === selectedPort)?.desc
                ? `${selectedPort} — ${serial.availablePorts.find((p) => p.port === selectedPort)?.desc}`
                : selectedPort
            }
            className="flex-1 min-w-0 bg-window-bg border border-card-border rounded px-3 py-1.5 text-text-primary text-sm truncate"
          >
            {serial.availablePorts.map((p) => {
              const fullLabel = p.desc ? `${p.port} (${p.desc})` : p.port;
              // Clip long descriptions so the collapsed <select> view
              // doesn't push the row wider than its container.
              const display =
                fullLabel.length > 38 ? fullLabel.slice(0, 35) + '…' : fullLabel;
              return (
                <option key={p.port} value={p.port} title={fullLabel}>
                  {display}
                </option>
              );
            })}
          </select>

          <select
            value={baudRate}
            onChange={(e) => setBaudRate(Number(e.target.value))}
            disabled={serial.connected || serialAction !== null}
            className="w-24 shrink-0 bg-window-bg border border-card-border rounded px-3 py-1.5 text-text-primary text-sm"
          >
            <option value={9600}>9600</option>
            <option value={115200}>115200</option>
            <option value={460800}>460800</option>
            <option value={921600}>921600</option>
          </select>

          <button
            onClick={handleSerialConnect}
            disabled={serialAction !== null || !selectedPort}
            className={`px-4 py-1.5 rounded font-medium text-sm transition-colors ${
              serial.connected
                ? 'bg-status-danger hover:opacity-90 text-white'
                : 'bg-accent hover:opacity-90 text-white'
            } disabled:opacity-50`}
          >
            {labelFor(
              serialAction,
              serial.connected,
              t.dashboard.connectionPanel.btn.connect,
              t.dashboard.connectionPanel.btn.disconnect,
              t.dashboard.connectionPanel.btn.connecting,
              t.dashboard.connectionPanel.btn.disconnecting,
            )}
          </button>
        </div>
      </div>

      {/* BLE Connection */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-semibold text-text-primary">{t.dashboard.connectionPanel.bleTitle}</span>
          <span
            className={`text-xs ${ble.connected ? 'text-status-connected' : 'text-text-muted'}`}
          >
            {ble.connected
              ? t.dashboard.connectionPanel.connectedDot
              : t.dashboard.connectionPanel.disconnectedDot}
          </span>
        </div>

        <div className="flex gap-2">
          <input
            type="text"
            value={ble.connected && ble.deviceName ? ble.deviceName : bleDeviceName}
            onChange={(e) => setBleDeviceName(e.target.value)}
            disabled={ble.connected || bleAction !== null}
            placeholder={t.dashboard.connectionPanel.bleNamePlaceholder}
            spellCheck={false}
            title={t.dashboard.connectionPanel.bleNameTitle}
            className="flex-1 min-w-0 bg-window-bg border border-card-border rounded px-3 py-1.5 text-text-primary text-sm font-mono disabled:opacity-50"
          />

          <button
            onClick={handleBleConnect}
            disabled={bleAction !== null || !bleDeviceName.trim()}
            className={`px-4 py-1.5 rounded font-medium text-sm transition-colors ${
              ble.connected
                ? 'bg-status-danger hover:opacity-90 text-white'
                : 'bg-accent hover:opacity-90 text-white'
            } disabled:opacity-50`}
          >
            {labelFor(
              bleAction,
              ble.connected,
              t.dashboard.connectionPanel.btn.scan,
              t.dashboard.connectionPanel.btn.disconnect,
              t.dashboard.connectionPanel.btn.connecting,
              t.dashboard.connectionPanel.btn.disconnecting,
            )}
          </button>
        </div>
      </div>

      {/* Audio Connection */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-semibold text-text-primary">{t.dashboard.connectionPanel.audioTitle}</span>
          <span
            className={`text-xs ${audio.connected ? 'text-status-connected' : 'text-text-muted'}`}
          >
            {audio.connected
              ? t.dashboard.connectionPanel.connectedDot
              : t.dashboard.connectionPanel.disconnectedDot}
          </span>
        </div>

        <div className="flex gap-2">
          <div className="flex-1 flex items-center gap-2 bg-window-bg border border-card-border rounded px-3 py-1.5">
            <span className="text-xs text-text-muted shrink-0">{t.dashboard.connectionPanel.portLabel}</span>
            <input
              type="number"
              min={1}
              max={65535}
              step={1}
              value={audioPort}
              onChange={(e) => setAudioPort(e.target.value)}
              disabled={audio.connected || audioAction !== null}
              placeholder={t.dashboard.connectionPanel.audioPortPlaceholder}
              title={t.dashboard.connectionPanel.audioPortTitle}
              className="w-full bg-transparent text-text-primary text-sm font-mono outline-none disabled:opacity-50"
            />
          </div>

          <button
            onClick={handleAudioConnect}
            disabled={audioAction !== null || !audioPort.trim()}
            className={`px-4 py-1.5 rounded font-medium text-sm transition-colors ${
              audio.connected
                ? 'bg-status-danger hover:opacity-90 text-white'
                : 'bg-accent hover:opacity-90 text-white'
            } disabled:opacity-50`}
          >
            {labelFor(
              audioAction,
              audio.connected,
              t.dashboard.connectionPanel.btn.start,
              t.dashboard.connectionPanel.btn.stop,
              t.dashboard.connectionPanel.btn.starting,
              t.dashboard.connectionPanel.btn.stopping,
            )}
          </button>
        </div>
      </div>
    </div>
  );
}