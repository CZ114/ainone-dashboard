// Main App component with React Router

import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Dashboard from './components/Dashboard';
import ChatPage from './components/chat/ChatPage';
import SettingsPage from './components/settings/SettingsPage';
import DiaryPage from './components/diary/DiaryPage';
import { ThemeProvider } from './contexts/ThemeContext';
import { AppBridge } from './components/AppBridge';
import { BackendGate } from './components/BackendGate';

function App() {
  return (
    <ThemeProvider>
      {/* BackendGate covers everything until /api/health (Python) and
          /api/projects (Hono) both respond. Without it, Vite is up
          before Python or Hono have finished installing/booting and
          the user lands on a dashboard that just throws ECONNREFUSED
          for every WS / REST call. */}
      <BackendGate>
        <BrowserRouter>
          {/* AppBridge owns the global WS subscription and recording
              timer. It must sit outside <Routes> so navigating between
              /dashboard and /chat doesn't tear the WS down (which used
              to cost ~3 s of disconnect+reconnect on each route change
              and made first-recording state behave inconsistently). */}
          <AppBridge />
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/diary" element={<DiaryPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </BrowserRouter>
      </BackendGate>
    </ThemeProvider>
  );
}

export default App;
