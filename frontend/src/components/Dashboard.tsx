// Dashboard component - main sensor monitoring view.
//
// Pure UI shell. The data plane (WebSocket subscription, recording
// timer) lives in <AppBridge/> at the App root so that navigating
// to /chat doesn't tear it down.

import { wsClient } from '../api/websocket';
import { Header } from './layout/Header';
import { ConnectionPanel } from './layout/ConnectionPanel';
import { ChannelGrid } from './channels/ChannelGrid';
import { AudioLevelMeter } from './audio/AudioLevelMeter';
import { RecordingControls } from './recording/RecordingControls';
import { DisplaySettings } from './settings/DisplaySettings';

function Dashboard() {
  return (
    <div className="min-h-screen bg-window-bg flex flex-col">
      <Header />

      <div className="flex-1 flex">
        <aside className="w-80 border-r border-card-border p-4 space-y-4 overflow-y-auto">
          <ConnectionPanel />
          <RecordingControls />
          <AudioLevelMeter />
          <DisplaySettings />
        </aside>

        <main className="flex-1 overflow-y-auto">
          <ChannelGrid />
        </main>
      </div>

      <footer className="bg-card-bg border-t border-card-border px-6 py-2">
        <div className="flex items-center justify-between text-xs text-text-muted">
          <span>AinOne Dashboard v1.0</span>
          <span>
            WebSocket: {wsClient.isConnected() ? '● Connected' : '○ Disconnected'}
          </span>
        </div>
      </footer>
    </div>
  );
}

export default Dashboard;
