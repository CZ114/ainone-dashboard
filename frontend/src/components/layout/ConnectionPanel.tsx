// ConnectionPanel - serial and BLE connection controls

import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { serialApi, bleApi, audioApi } from '../../api/client';

export function ConnectionPanel() {
  const serial = useStore((state) => state.serial);
  const ble = useStore((state) => state.ble);
  const audio = useStore((state) => state.audio);
  const setSerialConnected = useStore((state) => state.setSerialConnected);
  const setAvailablePorts = useStore((state) => state.setAvailablePorts);
  const setBleConnected = useStore((state) => state.setBleConnected);
  const setAudioConnected = useStore((state) => state.setAudioConnected);

  const [selectedPort, setSelectedPort] = useState('');
  const [baudRate, setBaudRate] = useState(115200);
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

  // Fetch available ports on mount
  useEffect(() => {
    const fetchPorts = async () => {
      try {
        const result = await serialApi.listPorts();
        setAvailablePorts(result.ports || []);
        if (result.ports?.length > 0) {
          setSelectedPort(result.ports[0].port);
        }
      } catch (e) {
        console.error('Failed to list ports:', e);
      }
    };

    fetchPorts();
  }, [setAvailablePorts]);

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
        await bleApi.scan();
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
        await audioApi.start(8888);
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
          <span className="text-sm font-semibold text-text-primary">Serial Port</span>
          <span
            className={`text-xs ${serial.connected ? 'text-status-connected' : 'text-text-muted'}`}
          >
            {serial.connected ? '● Connected' : '○ Disconnected'}
          </span>
        </div>

        <div className="flex gap-2 min-w-0">
          {/* min-w-0 + truncate on the select itself keeps a very long
              port description from blowing out the flex row. `<option>`
              text can't be CSS-truncated across browsers, so we also
              clip the label string and surface the full value via
              title + the currently-selected port shown below. */}
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
                ? 'bg-status-disconnected hover:bg-red-600 text-white'
                : 'bg-status-connected hover:bg-green-600 text-white'
            } disabled:opacity-50`}
          >
            {labelFor(
              serialAction,
              serial.connected,
              'Connect',
              'Disconnect',
              'Connecting…',
              'Disconnecting…',
            )}
          </button>
        </div>
      </div>

      {/* BLE Connection */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-semibold text-text-primary">BLE</span>
          <span
            className={`text-xs ${ble.connected ? 'text-status-connected' : 'text-text-muted'}`}
          >
            {ble.connected ? '● Connected' : '○ Disconnected'}
          </span>
        </div>

        <div className="flex gap-2">
          <span className="flex-1 bg-window-bg border border-card-border rounded px-3 py-1.5 text-text-secondary text-sm">
            {ble.deviceName || 'ESP32-S3-MultiSensor'}
          </span>

          <button
            onClick={handleBleConnect}
            disabled={bleAction !== null}
            className={`px-4 py-1.5 rounded font-medium text-sm transition-colors ${
              ble.connected
                ? 'bg-status-disconnected hover:bg-red-600 text-white'
                : 'bg-ch-ble hover:opacity-80 text-white'
            } disabled:opacity-50`}
          >
            {labelFor(
              bleAction,
              ble.connected,
              'Scan',
              'Disconnect',
              'Connecting…',
              'Disconnecting…',
            )}
          </button>
        </div>
      </div>

      {/* Audio Connection */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-semibold text-text-primary">Audio (UDP)</span>
          <span
            className={`text-xs ${audio.connected ? 'text-status-connected' : 'text-text-muted'}`}
          >
            {audio.connected ? '● Connected' : '○ Disconnected'}
          </span>
        </div>

        <div className="flex gap-2">
          <span className="flex-1 bg-window-bg border border-card-border rounded px-3 py-1.5 text-text-secondary text-sm">
            Port: 8888
          </span>

          <button
            onClick={handleAudioConnect}
            disabled={audioAction !== null}
            className={`px-4 py-1.5 rounded font-medium text-sm transition-colors ${
              audio.connected
                ? 'bg-status-disconnected hover:bg-red-600 text-white'
                : 'bg-ch-audio hover:opacity-80 text-white'
            } disabled:opacity-50`}
          >
            {labelFor(
              audioAction,
              audio.connected,
              'Start',
              'Stop',
              'Starting…',
              'Stopping…',
            )}
          </button>
        </div>
      </div>
    </div>
  );
}