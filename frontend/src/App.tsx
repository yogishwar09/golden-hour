/**
 * Routing and access control.
 *
 * Route guards here are a usability measure, not a security boundary: they stop
 * a crew landing on a control-room screen they cannot use. The API enforces the
 * real authorisation on every request regardless of what the client renders.
 */

import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { Role } from '@sas/shared';
import { useAuth } from './context/AuthContext';
import { Layout } from './components/Layout';
import { FullPageLoader } from './components/ui';
import { homeRouteFor } from './lib/routes';
import { Landing } from './pages/Landing';
import { Login } from './pages/Login';
import { Register } from './pages/Register';
import { PatientSOS } from './pages/PatientSOS';
import { DriverShift } from './pages/DriverShift';
import { ControlRoom, FleetRoster } from './pages/ControlRoom';
import { HospitalBoard } from './pages/HospitalBoard';
import { History } from './pages/History';
import { Profile } from './pages/Profile';
import { NotFound } from './pages/NotFound';

function RequireAuth({ children, roles }: { children: ReactNode; roles?: Role[] }) {
  const { user, initialising } = useAuth();
  const location = useLocation();

  // Wait for the stored session to be checked, or every reload would bounce a
  // signed-in user to the login screen for a frame.
  if (initialising) return <FullPageLoader label="Restoring your session" />;

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (roles && !roles.includes(user.role)) {
    return <Navigate to={homeRouteFor(user.role)} replace />;
  }
  return <>{children}</>;
}

/** Sends an already-signed-in visitor to their own home screen. */
function RedirectIfSignedIn({ children }: { children: ReactNode }) {
  const { user, initialising } = useAuth();
  if (initialising) return <FullPageLoader />;
  if (user) return <Navigate to={homeRouteFor(user.role)} replace />;
  return <>{children}</>;
}

function HomeRedirect() {
  const { user, initialising } = useAuth();
  if (initialising) return <FullPageLoader />;
  return user ? <Navigate to={homeRouteFor(user.role)} replace /> : <Landing />;
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<HomeRedirect />} />
      <Route
        path="/login"
        element={
          <RedirectIfSignedIn>
            <Login />
          </RedirectIfSignedIn>
        }
      />
      <Route
        path="/register"
        element={
          <RedirectIfSignedIn>
            <Register />
          </RedirectIfSignedIn>
        }
      />

      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route
          path="/sos"
          element={
            <RequireAuth roles={['patient', 'admin']}>
              <PatientSOS />
            </RequireAuth>
          }
        />
        <Route
          path="/history"
          element={
            <RequireAuth roles={['patient', 'admin']}>
              <History />
            </RequireAuth>
          }
        />
        <Route
          path="/drive"
          element={
            <RequireAuth roles={['driver']}>
              <DriverShift />
            </RequireAuth>
          }
        />
        <Route
          path="/hospital"
          element={
            <RequireAuth roles={['hospital', 'admin']}>
              <HospitalBoard />
            </RequireAuth>
          }
        />
        <Route
          path="/control"
          element={
            <RequireAuth roles={['admin']}>
              <ControlRoom />
            </RequireAuth>
          }
        />
        <Route
          path="/control/fleet"
          element={
            <RequireAuth roles={['admin']}>
              <FleetRoster />
            </RequireAuth>
          }
        />
        <Route path="/profile" element={<Profile />} />
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
