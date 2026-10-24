import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { ForcedPasswordChange } from './components/ChangePasswordModal';
import { RequireRole } from './components/RequireRole';
import { ConsoleLayout } from './components/layout/ConsoleLayout';
import { MobileAppLayout } from './components/layout/MobileAppLayout';
import { LoadingBlock } from './components/ui/Spinner';
import { useAuth } from './context/AuthContext';
import { ROLE_HOME } from './lib/guard';
import type { Role } from './lib/types';
import Landing from './pages/Landing';
import Login from './pages/Login';
import NotFound from './pages/NotFound';
import Register from './pages/Register';

const Sos = lazy(() => import('./pages/requester/Sos'));
const Track = lazy(() => import('./pages/requester/Track'));
const History = lazy(() => import('./pages/requester/History'));
const Account = lazy(() => import('./pages/requester/Account'));
const Crew = lazy(() => import('./pages/crew/Crew'));
const Controller = lazy(() => import('./pages/controller/Controller'));
const Hospital = lazy(() => import('./pages/hospital/Hospital'));
const AdminDashboard = lazy(() => import('./pages/admin/AdminDashboard'));
const Onboarding = lazy(() => import('./pages/admin/Onboarding'));
const Users = lazy(() => import('./pages/admin/Users'));
const Settings = lazy(() => import('./pages/admin/Settings'));
const BillingPage = lazy(() => import('./pages/admin/BillingPage'));
const AuditPage = lazy(() => import('./pages/admin/AuditPage'));
const Authority = lazy(() => import('./pages/authority/Authority'));
const DevUi = lazy(() => import('./pages/dev/DevUi'));
const ShareTrack = lazy(() => import('./pages/share/ShareTrack'));

const Loading = () => <LoadingBlock full label="Loading screen" />;

function Home() {
  const { user, loading } = useAuth();
  if (loading) return <LoadingBlock full label="Checking session" />;
  return user ? <Navigate to={ROLE_HOME[user.role]} replace /> : <Landing />;
}

/**
 * Mobile-app roles (requester, crew). Each screen owns its <MobileAppLayout> (title, back, map, sheet, CTA).
 * LEGACY pages that don't render one yet are wrapped here via `legacyTitle`; when a screen agent rebuilds a page
 * with its own <MobileAppLayout>, drop `legacyTitle` for that route.
 */
function MobileRoute({ roles, legacyTitle, back, children }: { roles: Role[]; legacyTitle?: string; back?: string | boolean; children: ReactNode }) {
  return (
    <RequireRole roles={roles}>
      <Suspense fallback={<Loading />}>
        {legacyTitle ? <MobileAppLayout title={legacyTitle} back={back} width="2xl">{children}</MobileAppLayout> : children}
      </Suspense>
    </RequireRole>
  );
}

const CONSOLE_ROLES: Role[] = ['controller', 'admin', 'authority', 'hospital_staff'];

export default function App() {
  return (
    <Suspense fallback={<Loading />}>
      <ForcedPasswordChange />
      <Routes>
        {/* Public */}
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        {import.meta.env.DEV && <Route path="/dev/ui" element={<DevUi />} />}{/* component gallery: dev server only */}
        <Route path="/t/:token" element={<ShareTrack />} />

        {/* Mobile app: requester & crew */}
        <Route path="/sos" element={<MobileRoute roles={['requester']}><Sos /></MobileRoute>} />
        <Route path="/track/:id" element={<MobileRoute roles={['requester', 'controller', 'admin']}><Track /></MobileRoute>} />
        <Route path="/history" element={<MobileRoute roles={['requester']}><History /></MobileRoute>} />
        <Route path="/account" element={<MobileRoute roles={['requester']}><Account /></MobileRoute>} />
        <Route path="/crew" element={<MobileRoute roles={['crew']}><Crew /></MobileRoute>} />

        {/* Console: controller, admin, authority, hospital staff */}
        <Route element={<RequireRole roles={CONSOLE_ROLES}><ConsoleLayout /></RequireRole>}>
          <Route path="/controller" element={<RequireRole roles={['controller', 'admin']}><Controller /></RequireRole>} />
          <Route path="/hospital" element={<RequireRole roles={['hospital_staff']}><Hospital /></RequireRole>} />
          <Route path="/admin" element={<RequireRole roles={['admin']}><AdminDashboard /></RequireRole>} />
          <Route path="/admin/onboarding" element={<RequireRole roles={['admin']}><Onboarding /></RequireRole>} />
          <Route path="/admin/users" element={<RequireRole roles={['admin']}><Users /></RequireRole>} />
          <Route path="/admin/settings" element={<RequireRole roles={['admin']}><Settings /></RequireRole>} />
          <Route path="/admin/billing" element={<RequireRole roles={['admin']}><BillingPage /></RequireRole>} />
          <Route path="/admin/audit" element={<RequireRole roles={['admin']}><AuditPage /></RequireRole>} />
          <Route path="/authority" element={<RequireRole roles={['authority']}><Authority /></RequireRole>} />
          <Route path="/authority/audit" element={<RequireRole roles={['authority']}><AuditPage /></RequireRole>} />
        </Route>

        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
}
