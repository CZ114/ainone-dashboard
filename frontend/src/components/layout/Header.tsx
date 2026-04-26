// Header component with navigation

import { useStore } from '../../store';
import { Link, useLocation } from 'react-router-dom';
import { ThemeToggle } from '../ThemeToggle';

export function Header() {
  const serial = useStore((state) => state.serial);
  const ble = useStore((state) => state.ble);
  const audio = useStore((state) => state.audio);
  const channelCount = useStore((state) => state.channelCount);
  const isRecording = useStore((state) => state.isRecording);
  const location = useLocation();

  return (
    <header className="bg-card-bg border-b border-card-border px-6 py-3">
      <div className="flex items-center justify-between">
        {/* Logo and title */}
        <div className="flex items-center gap-3">
          <span className="text-2xl">📊</span>
          <div>
            <h1 className="text-lg font-bold text-text-primary">AinOne Dashboard</h1>
            <p className="text-xs text-text-muted">Real-time multi-sensor visualization</p>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex items-center gap-2">
          <Link
            to="/dashboard"
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              location.pathname === '/dashboard'
                ? 'bg-blue-600 text-white'
                : 'text-text-secondary hover:text-text-primary hover:bg-card-border/50'
            }`}
          >
            Dashboard
          </Link>
          <Link
            to="/chat"
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              location.pathname === '/chat'
                ? 'bg-blue-600 text-white'
                : 'text-text-secondary hover:text-text-primary hover:bg-card-border/50'
            }`}
          >
            Claude Chat
          </Link>
        </nav>

        {/* Status indicators */}
        <div className="flex items-center gap-6">
          {/* Connection status */}
          <div className="flex items-center gap-4 text-sm">
            <div className="flex items-center gap-1.5">
              <span
                className={`w-2 h-2 rounded-full ${
                  serial.connected ? 'bg-status-connected' : 'bg-status-disconnected'
                }`}
              />
              <span className="text-text-secondary">
                Serial {serial.connected ? serial.port : 'Disconnected'}
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              <span
                className={`w-2 h-2 rounded-full ${
                  ble.connected ? 'bg-status-connected' : 'bg-status-disconnected'
                }`}
              />
              <span className="text-text-secondary">
                BLE {ble.connected ? ble.deviceName : 'Disconnected'}
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              <span
                className={`w-2 h-2 rounded-full ${
                  audio.connected ? 'bg-status-connected' : 'bg-status-disconnected'
                }`}
              />
              <span className="text-text-secondary">
                Audio {audio.connected ? 'Active' : 'Inactive'}
              </span>
            </div>
          </div>

          {/* Recording indicator */}
          {isRecording && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-status-disconnected/20 rounded-lg">
              <span className="w-2 h-2 rounded-full bg-status-disconnected animate-pulse" />
              <span className="text-status-disconnected text-sm font-medium">Recording</span>
            </div>
          )}

          {/* Channel count */}
          <div className="text-sm text-text-secondary">
            <span className="font-mono">{channelCount}</span> channels
          </div>

          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}