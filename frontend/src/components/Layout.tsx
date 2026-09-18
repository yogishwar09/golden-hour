/**
 * The application shell: brand, primary navigation, live notifications and the
 * account menu. Rendered once around every signed-in screen.
 */

import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Activity,
  Ambulance,
  Bell,
  Building2,
  ChevronDown,
  LayoutDashboard,
  LogOut,
  Siren,
  User as UserIcon,
} from 'lucide-react';
import type { NotificationEvent, Role } from '@sas/shared';
import { useAuth } from '../context/AuthContext';
import { useSocketEvent } from '../hooks/useSocketEvent';
import { ConnectionDot } from './ui';
import { formatRelative } from '../lib/format';

interface NavItem {
  to: string;
  label: string;
  icon: typeof Siren;
  roles: Role[];
}

const NAV: NavItem[] = [
  { to: '/sos', label: 'Emergency', icon: Siren, roles: ['patient'] },
  { to: '/history', label: 'My requests', icon: Activity, roles: ['patient'] },
  { to: '/drive', label: 'My shift', icon: Ambulance, roles: ['driver'] },
  { to: '/hospital', label: 'Incoming', icon: Building2, roles: ['hospital'] },
  { to: '/control', label: 'Control room', icon: LayoutDashboard, roles: ['admin'] },
  { to: '/control/fleet', label: 'Fleet', icon: Ambulance, roles: ['admin'] },
];

export function Layout() {
  const { user, socket, signOut } = useAuth();
  const navigate = useNavigate();
  const [connected, setConnected] = useState(socket?.connected ?? false);
  const [notifications, setNotifications] = useState<NotificationEvent[]>([]);
  const [showBell, setShowBell] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const bellRef = useRef<HTMLDivElement>(null);
  const accountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!socket) return;
    const online = (): void => setConnected(true);
    const offline = (): void => setConnected(false);

    setConnected(socket.connected);
    socket.on('connect', online);
    socket.on('disconnect', offline);
    return () => {
      socket.off('connect', online);
      socket.off('disconnect', offline);
    };
  }, [socket]);

  useSocketEvent('notification', (payload) => {
    // Newest first, and capped: this is a glanceable feed, not an inbox.
    setNotifications((previous) => [payload, ...previous].slice(0, 12));
  });

  // Close either dropdown on an outside click.
  useEffect(() => {
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (bellRef.current && !bellRef.current.contains(target)) setShowBell(false);
      if (accountRef.current && !accountRef.current.contains(target)) setShowAccount(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, []);

  if (!user) return null;

  const items = NAV.filter((item) => item.roles.includes(user.role));
  const unread = notifications.length;

  const handleSignOut = (): void => {
    signOut();
    navigate('/login', { replace: true });
  };

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-[1100] border-b border-ink-800 bg-ink-950/85 backdrop-blur-lg">
        <div className="mx-auto flex h-16 w-full max-w-[1600px] items-center gap-3 px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-emergency-600 shadow-lg shadow-emergency-900/50">
              <Siren className="h-5 w-5 text-white" aria-hidden />
            </span>
            <span className="hidden text-base font-extrabold tracking-tight text-ink-100 sm:block">
              Smart<span className="text-emergency-400">Ambulance</span>
            </span>
          </Link>

          <nav className="ml-2 flex flex-1 items-center gap-1 overflow-x-auto">
            {items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/control'}
                className={({ isActive }) =>
                  `flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                    isActive
                      ? 'bg-ink-800 text-ink-100'
                      : 'text-ink-400 hover:bg-ink-800/60 hover:text-ink-200'
                  }`
                }
              >
                <item.icon className="h-4 w-4" aria-hidden />
                <span className="hidden md:inline">{item.label}</span>
              </NavLink>
            ))}
          </nav>

          <ConnectionDot connected={connected} />

          <div className="relative" ref={bellRef}>
            <button
              type="button"
              onClick={() => setShowBell((open) => !open)}
              className="relative rounded-lg p-2 text-ink-300 transition-colors hover:bg-ink-800 hover:text-ink-100"
              aria-label={`Notifications${unread ? ` (${unread} new)` : ''}`}
            >
              <Bell className="h-5 w-5" aria-hidden />
              {unread > 0 && (
                <span className="absolute right-1 top-1 flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emergency-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emergency-500" />
                </span>
              )}
            </button>

            <AnimatePresence>
              {showBell && (
                <motion.div
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  className="card absolute right-0 mt-2 w-80 overflow-hidden p-0 shadow-2xl"
                >
                  <p className="border-b border-ink-700 px-4 py-3 text-xs font-bold uppercase tracking-wider text-ink-300">
                    Notifications
                  </p>
                  <div className="max-h-80 overflow-y-auto">
                    {notifications.length === 0 ? (
                      <p className="px-4 py-6 text-center text-sm text-ink-400">
                        Nothing yet. Updates appear here in real time.
                      </p>
                    ) : (
                      notifications.map((item) => (
                        <div
                          key={item.id}
                          className="border-b border-ink-800 px-4 py-3 last:border-0"
                        >
                          <div className="flex items-start gap-2">
                            <span
                              className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                                item.level === 'critical'
                                  ? 'bg-emergency-400'
                                  : item.level === 'warning'
                                    ? 'bg-amber-400'
                                    : item.level === 'success'
                                      ? 'bg-emerald-400'
                                      : 'bg-sky-400'
                              }`}
                            />
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-semibold text-ink-100">{item.title}</p>
                              {item.body && <p className="text-xs text-ink-400">{item.body}</p>}
                              <p className="mt-1 text-[11px] text-ink-500">
                                {formatRelative(item.at)}
                              </p>
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div className="relative" ref={accountRef}>
            <button
              type="button"
              onClick={() => setShowAccount((open) => !open)}
              className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-ink-800"
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-ink-700 text-xs font-bold text-ink-100">
                {user.name.charAt(0).toUpperCase()}
              </span>
              <span className="hidden text-sm font-semibold text-ink-200 lg:block">
                {user.name.split(' ')[0]}
              </span>
              <ChevronDown className="h-3.5 w-3.5 text-ink-400" aria-hidden />
            </button>

            <AnimatePresence>
              {showAccount && (
                <motion.div
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  className="card absolute right-0 mt-2 w-60 overflow-hidden p-0 shadow-2xl"
                >
                  <div className="border-b border-ink-700 px-4 py-3">
                    <p className="truncate text-sm font-semibold text-ink-100">{user.name}</p>
                    <p className="truncate text-xs text-ink-400">{user.email}</p>
                    <p className="mt-1.5 inline-block rounded-full bg-ink-700 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-ink-200">
                      {user.role}
                    </p>
                  </div>
                  <Link
                    to="/profile"
                    onClick={() => setShowAccount(false)}
                    className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-ink-200 transition-colors hover:bg-ink-800"
                  >
                    <UserIcon className="h-4 w-4" aria-hidden /> Profile
                  </Link>
                  <button
                    type="button"
                    onClick={handleSignOut}
                    className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-emergency-300 transition-colors hover:bg-ink-800"
                  >
                    <LogOut className="h-4 w-4" aria-hidden /> Sign out
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </header>

      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}
