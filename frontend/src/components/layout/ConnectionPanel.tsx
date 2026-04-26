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
  // Per-tier loading flags. A single shared `loading` used to disable
  // all three buttons whenever any one was busy, which made Serial /
  // BLE / Audio feel coupled even though they're independent.
  const [serialLoading, setSerialLoading] = useState(false);
  const [bleLoading, setBleLoading] = useState(false);
  const [audioLoading, setAudioLoading] = useState(false);

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
      setSerialLoading(true);
      try {
        await serialApi.disconnect();
        setSerialConnected(false);
      } catch (e) {
        console.error('Failed to disconnect:', e);
      }
      setSerialLoading(false);
    } else {
      setSerialLoading(true);
      try {
        await serialApi.connect(selectedPort, baudRate);
        setSerialConnected(true, selectedPort);
      } catch (e) {
        console.error('Failed to connect:', e);
      }
      setSerialLoading(false);
    }
  };

  const handleBleConnect = async () => {
    if (ble.connected) {
      setBleLoading(true);
      try {
        await bleApi.disconnect();
        setBleConnected(false);
      } catch (e) {
        console.error('Failed to disconnect BLE:', e);
      }
      setBleLoading(false);
    } else {
      // Hold the loading state across the entire scan + poll cycle so
      // the user sees "Connecting…" the whole time. The previous code
      // released loading the instant scan() returned and only polled
      // once via setTimeout, leaving the button visually idle while
      // BLE was still negotiating.
      setBleLoading(true);
      try {
        await bleApi.scan();
        const deadline = Date.now() + 10_000; // 10 s budget
        let connected = false;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 500));
          try {
            const status = await bleApi.getStatus();
            if (status.connected) {
              connected = true;
              break;
            }
          } catch {
            // keep polling — backend may be momentarily busy
          }
        }
        setBleConnected(connected);
      } catch (e) {
        console.error('Failed to scan BLE:', e);
      } finally {
        setBleLoading(false);
      }
    }
  };

  const handleAudioConnect = async () => {
    if (audio.connected) {
      setAudioLoading(true);
      try {
        await audioApi.stop();
        setAudioConnected(false);
      } catch (e) {
        console.error('Failed to stop audio:', e);
      }
      setAudioLoading(false);
    } else {
      setAudioLoading(true);
      try {
        await audioApi.start(8888);
        setAudioConnected(true);
      } catch (e) {
        console.error('Failed to start audio:', e);
      }
      setAudioLoading(false);
    }
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
            disabled={serial.connected || serialLoading}
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
            disabled={serial.connected || serialLoading}
            className="w-24 shrink-0 bg-window-bg border border-card-border rounded px-3 py-1.5 text-text-primary text-sm"
          >
            <option value={9600}>9600</option>
            <option value={115200}>115200</option>
            <option value={460800}>460800</option>
            <option value={921600}>921600</option>
          </select>

          <button
            onClick={handleSerialConnect}
            disabled={serialLoading || !selectedPort}
            className={`px-4 py-1.5 rounded font-medium text-sm transition-colors ${
              serial.connected
                ? 'bg-status-disconnected hover:bg-red-600 text-white'
                : 'bg-status-connected hover:bg-green-600 text-white'
            } disabled:opacity-50`}
          >
            {serialLoading
              ? serial.connected
                ? 'Disconnecting…'
                : 'Connecting…'
              : serial.connected
              ? 'Disconnect'
              : 'Connect'}
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
            disabled={bleLoading}
            className={`px-4 py-1.5 rounded font-medium text-sm transition-colors ${
              ble.connected
                ? 'bg-status-disconnected hover:bg-red-600 text-white'
                : 'bg-ch-ble hover:opacity-80 text-white'
            } disabled:opacity-50`}
          >
            {bleLoading
              ? ble.connected
                ? 'Disconnecting…'
                : 'Connecting…'
              : ble.connected
              ? 'Disconnect'
              : 'Scan'}
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
            disabled={audioLoading}
            className={`px-4 py-1.5 rounded font-medium text-sm transition-colors ${
              audio.connected
                ? 'bg-status-disconnected hover:bg-red-600 text-white'
                : 'bg-ch-audio hover:opacity-80 text-white'
            } disabled:opacity-50`}
          >
            {audioLoading
              ? audio.connected
                ? 'Stopping…'
                : 'Starting…'
              : audio.connected
              ? 'Stop'
              : 'Start'}
          </button>
        </div>
      </div>
    </div>
  );
}