// Main App component with React Router

import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Dashboard from './components/Dashboard';
import ChatPage from './components/chat/ChatPage';
import SettingsPage from './components/settings/SettingsPage';
import { ThemeProvider } from './contexts/ThemeContext';
import { AppBridge } from './components/AppBridge';

function App() {
  return (
    <ThemeProvider>
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
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  );
}

export default App;
