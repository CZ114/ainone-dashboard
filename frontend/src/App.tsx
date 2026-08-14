// Main App component with React Router

import { BrowserRouter, HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import Dashboard from './components/Dashboard';
import ChatPage from './components/chat/ChatPage';
import SettingsPage from './components/settings/SettingsPage';
import DiaryPage from './components/diary/DiaryPage';
import CallPage from './components/call/CallPage';
import PatientsPage from './components/patients/PatientsPage';
import TodayPage from './components/patient/TodayPage';
import DoctorEvaluationPage from './features/doctor-evaluation/DoctorEvaluationPage';
import { ThemeProvider } from './contexts/ThemeContext';
import { LanguageProvider } from './contexts/LanguageContext';
import { RoleProvider, useAuth, useCan } from './contexts/RoleContext';
import { homeOf } from './lib/rolePolicy';
import type { FeatureKey } from './lib/rolePolicy';
import { AppBridge } from './components/AppBridge';
import { BackendGate } from './components/BackendGate';

/** 路由守卫: 角色无权访问 → 送回自己的落地页 (而不是 404, 减少患者困惑)。
    守卫住 route 层意味着深链/横向跳转也被拦, 不只是导航栏不渲染。 */
function RoleRoute({ feature, children }: { feature: FeatureKey; children: ReactNode }) {
  const can = useCan();
  const { auth } = useAuth();
  if (!can(feature)) return <Navigate to={homeOf(auth.role)} replace />;
  return <>{children}</>;
}

/** `/` 按角色分流 (homeOf): 患者 → /today, 医生 → /patients (先看病人列表),
    开发者 → /dashboard (设备调试)。 */
function HomeRedirect() {
  const { auth } = useAuth();
  return <Navigate to={homeOf(auth.role)} replace />;
}

function App() {
  // The installed platform keeps clean BrowserRouter URLs. The single-file
  // showcase runs from file://, where HashRouter is required so navigation
  // stays inside the generated HTML instead of opening file:///patients.
  const RuntimeRouter = window.location.protocol === 'file:' ? HashRouter : BrowserRouter;

  return (
    <LanguageProvider>
    <ThemeProvider>
      {/* BackendGate covers everything until /api/health (Python) and
          /api/projects (Hono) both respond. Without it, Vite is up
          before Python or Hono have finished installing/booting and
          the user lands on a dashboard that just throws ECONNREFUSED
          for every WS / REST call. */}
      <BackendGate>
        {/* RoleProvider sits inside BackendGate (login POST needs the
            backend up) and outside BrowserRouter: until login succeeds
            it renders the LoginGate INSTEAD of the app tree, so no
            route/WS/polling ever mounts for an unauthenticated user. */}
        <RoleProvider>
          <RuntimeRouter>
            {/* AppBridge owns the global WS subscription and recording
                timer. It must sit outside <Routes> so navigating between
                /dashboard and /chat doesn't tear the WS down (which used
                to cost ~3 s of disconnect+reconnect on each route change
                and made first-recording state behave inconsistently). */}
            <AppBridge />
            <Routes>
              <Route path="/" element={<HomeRedirect />} />
              <Route path="/today" element={
                <RoleRoute feature="route.today"><TodayPage /></RoleRoute>
              } />
              <Route path="/dashboard" element={
                <RoleRoute feature="route.dashboard"><Dashboard /></RoleRoute>
              } />
              <Route path="/patients" element={
                <RoleRoute feature="route.patients"><PatientsPage /></RoleRoute>
              } />
              <Route path="/doctor-evaluation" element={
                <RoleRoute feature="route.patients"><DoctorEvaluationPage /></RoleRoute>
              } />
              <Route path="/doctor-evaluation-demo" element={
                <Navigate to="/doctor-evaluation" replace />
              } />
              <Route path="/chat" element={<ChatPage />} />
              <Route path="/diary" element={<DiaryPage />} />
              <Route path="/call" element={<CallPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              {/* 兜底: 未知路径回落地页 */}
              <Route path="*" element={<HomeRedirect />} />
            </Routes>
          </RuntimeRouter>
        </RoleProvider>
      </BackendGate>
    </ThemeProvider>
    </LanguageProvider>
  );
}

export default App;
