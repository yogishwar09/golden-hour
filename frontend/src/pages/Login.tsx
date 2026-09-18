import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Siren } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { errorMessage } from '../lib/api';
import { ErrorNotice, Spinner } from '../components/ui';
import { homeRouteFor } from '../lib/routes';

/** Pre-fillable demo identities, so the system can be tried without signing up. */
const DEMO_ACCOUNTS = [
  { label: 'Patient', email: 'patient@demo.test' },
  { label: 'Driver', email: 'driver@demo.test' },
  { label: 'Hospital', email: 'hospital@demo.test' },
  { label: 'Control room', email: 'admin@demo.test' },
];

export function Login() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const user = await signIn({ email, password });
      // Return the user to wherever they were headed before being asked to
      // sign in, falling back to the home screen for their role.
      const intended = (location.state as { from?: string } | null)?.from;
      navigate(intended ?? homeRouteFor(user.role), { replace: true });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const useDemo = (demoEmail: string): void => {
    setEmail(demoEmail);
    setPassword('Password123');
    setError(null);
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-6 py-12">
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md"
      >
        <Link to="/" className="mb-8 flex items-center justify-center gap-2.5">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-emergency-600 shadow-lg shadow-emergency-900/50">
            <Siren className="h-6 w-6 text-white" aria-hidden />
          </span>
          <span className="text-xl font-extrabold tracking-tight">
            Smart<span className="text-emergency-400">Ambulance</span>
          </span>
        </Link>

        <div className="card p-7">
          <h1 className="text-2xl font-bold tracking-tight">Sign in</h1>
          <p className="mt-1 text-sm text-ink-400">Access your emergency dashboard.</p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4" noValidate>
            {error && <ErrorNotice message={error} />}

            <div>
              <label className="label" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                type="email"
                className="input"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                required
              />
            </div>

            <div>
              <label className="label" htmlFor="password">
                Password
              </label>
              <input
                id="password"
                type="password"
                className="input"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Your password"
                autoComplete="current-password"
                required
              />
            </div>

            <button type="submit" className="btn-primary w-full py-3" disabled={busy}>
              {busy ? <Spinner className="h-4 w-4" /> : null}
              {busy ? 'Signing in' : 'Sign in'}
            </button>
          </form>

          <div className="mt-6 border-t border-ink-700 pt-5">
            <p className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-ink-400">
              Try a demo account
            </p>
            <div className="grid grid-cols-2 gap-2">
              {DEMO_ACCOUNTS.map((account) => (
                <button
                  key={account.email}
                  type="button"
                  onClick={() => useDemo(account.email)}
                  className="btn-secondary justify-start py-2 text-xs"
                >
                  {account.label}
                </button>
              ))}
            </div>
          </div>

          <p className="mt-6 text-center text-sm text-ink-400">
            No account?{' '}
            <Link
              to="/register"
              className="font-semibold text-emergency-400 hover:text-emergency-300"
            >
              Create one
            </Link>
          </p>
        </div>
      </motion.div>
    </div>
  );
}
