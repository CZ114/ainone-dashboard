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
  const [loading, setLoading] = useState(false);

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
      setLoading(true);
      try {
        await serialApi.disconnect();
        setSerialConnected(false);
      } catch (e) {
        console.error('Failed to disconnect:', e);
      }
      setLoading(false);
    } else {
      setLoading(true);
      try {
        await serialApi.connect(selectedPort, baudRate);
        setSerialConnected(true, selectedPort);
      } catch (e) {
        console.error('Failed to connect:', e);
      }
      setLoading(false);
    }
  };

  const handleBleConnect = async () => {
    if (ble.connected) {
      setLoading(true);
      try {
        await bleApi.disconnect();
        setBleConnected(false);
      } catch (e) {
        console.error('Failed to disconnect BLE:', e);
      }
      setLoading(false);
    } else {
      setLoading(true);
      try {
        await bleApi.scan();
        // Give it a moment then check status
        setTimeout(async () => {
          try {
            const status = await bleApi.getStatus();
            setBleConnected(status.connected);
          } catch (e) {
            console.error('Failed to get BLE status:', e);
          }
        }, 2000);
      } catch (e) {
        console.error('Failed to scan BLE:', e);
      }
      setLoading(false);
    }
  };

  const handleAudioConnect = async () => {
    if (audio.connected) {
      setLoading(true);
      try {
        await audioApi.stop();
        setAudioConnected(false);
      } catch (e) {
        console.error('Failed to stop audio:', e);
      }
      setLoading(false);
    } else {
      setLoading(true);
      try {
        await audioApi.start(8888);
        setAudioConnected(true);
      } catch (e) {
        console.error('Failed to start audio:', e);
      }
      setLoading(false);
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
            disabled={serial.connected || loading}
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
            disabled={serial.connected || loading}
            className="w-24 shrink-0 bg-window-bg border border-card-border rounded px-3 py-1.5 text-text-primary text-sm"
          >
            <option value={9600}>9600</option>
            <option value={115200}>115200</option>
            <option value={460800}>460800</option>
            <option value={921600}>921600</option>
          </select>

          <button
            onClick={handleSerialConnect}
            disabled={loading || !selectedPort}
            className={`px-4 py-1.5 rounded font-medium text-sm transition-colors ${
              serial.connected
                ? 'bg-status-disconnected hover:bg-red-600 text-white'
                : 'bg-status-connected hover:bg-green-600 text-white'
            } disabled:opacity-50`}
          >
            {loading ? '...' : serial.connected ? 'Disconnect' : 'Connect'}
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
            disabled={loading}
            className={`px-4 py-1.5 rounded font-medium text-sm transition-colors ${
              ble.connected
                ? 'bg-status-disconnected hover:bg-red-600 text-white'
                : 'bg-ch-ble hover:opacity-80 text-white'
            } disabled:opacity-50`}
          >
            {loading ? '...' : ble.connected ? 'Disconnect' : 'Scan'}
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
            disabled={loading}
            className={`px-4 py-1.5 rounded font-medium text-sm transition-colors ${
              audio.connected
                ? 'bg-status-disconnected hover:bg-red-600 text-white'
                : 'bg-ch-audio hover:opacity-80 text-white'
            } disabled:opacity-50`}
          >
            {loading ? '...' : audio.connected ? 'Stop' : 'Start'}
          </button>
        </div>
      </div>
    </div>
  );
}