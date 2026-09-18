import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Siren } from 'lucide-react';
import { BLOOD_GROUPS, type BloodGroup, type Role } from '@sas/shared';
import { useAuth } from '../context/AuthContext';
import { errorMessage, fieldIssues } from '../lib/api';
import { ErrorNotice, Spinner } from '../components/ui';
import { homeRouteFor } from '../lib/routes';

export function Register() {
  const { signUp } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState({
    name: '',
    email: '',
    phone: '',
    password: '',
    role: 'patient' as Role,
    bloodGroup: 'UNKNOWN' as BloodGroup,
    medicalNotes: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const set = <Key extends keyof typeof form>(key: Key, value: (typeof form)[Key]): void => {
    setForm((previous) => ({ ...previous, [key]: value }));
  };

  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setIssues({});
    setBusy(true);

    try {
      const user = await signUp({
        ...form,
        medicalNotes: form.medicalNotes.trim() || undefined,
      } as Parameters<typeof signUp>[0]);
      navigate(homeRouteFor(user.role), { replace: true });
    } catch (caught) {
      setError(errorMessage(caught));
      // Field-level messages come back from the same schema the server used,
      // so they can be attached directly to the inputs.
      setIssues(
        Object.fromEntries(fieldIssues(caught).map((issue) => [issue.field, issue.message])),
      );
    } finally {
      setBusy(false);
    }
  };

  const fieldError = (field: string): string | undefined => issues[field];

  return (
    <div className="flex min-h-screen items-center justify-center px-6 py-12">
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-lg"
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
          <h1 className="text-2xl font-bold tracking-tight">Create your account</h1>
          <p className="mt-1 text-sm text-ink-400">
            Medical details are optional, but they are handed to the crew before they reach you.
          </p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4" noValidate>
            {error && <ErrorNotice message={error} />}

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="name">
                  Full name
                </label>
                <input
                  id="name"
                  className="input"
                  value={form.name}
                  onChange={(event) => set('name', event.target.value)}
                  placeholder="Asha Rao"
                  autoComplete="name"
                  required
                />
                {fieldError('name') && (
                  <p className="mt-1 text-xs text-emergency-300">{fieldError('name')}</p>
                )}
              </div>

              <div>
                <label className="label" htmlFor="phone">
                  Phone
                </label>
                <input
                  id="phone"
                  className="input"
                  value={form.phone}
                  onChange={(event) => set('phone', event.target.value)}
                  placeholder="+91 98000 00000"
                  autoComplete="tel"
                  required
                />
                {fieldError('phone') && (
                  <p className="mt-1 text-xs text-emergency-300">{fieldError('phone')}</p>
                )}
              </div>
            </div>

            <div>
              <label className="label" htmlFor="reg-email">
                Email
              </label>
              <input
                id="reg-email"
                type="email"
                className="input"
                value={form.email}
                onChange={(event) => set('email', event.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                required
              />
              {fieldError('email') && (
                <p className="mt-1 text-xs text-emergency-300">{fieldError('email')}</p>
              )}
            </div>

            <div>
              <label className="label" htmlFor="reg-password">
                Password
              </label>
              <input
                id="reg-password"
                type="password"
                className="input"
                value={form.password}
                onChange={(event) => set('password', event.target.value)}
                placeholder="At least 8 characters, with a number"
                autoComplete="new-password"
                required
              />
              {fieldError('password') && (
                <p className="mt-1 text-xs text-emergency-300">{fieldError('password')}</p>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="role">
                  I am a
                </label>
                <select
                  id="role"
                  className="input"
                  value={form.role}
                  onChange={(event) => set('role', event.target.value as Role)}
                >
                  <option value="patient">Patient / member of the public</option>
                  <option value="driver">Ambulance crew</option>
                </select>
              </div>

              <div>
                <label className="label" htmlFor="blood">
                  Blood group
                </label>
                <select
                  id="blood"
                  className="input"
                  value={form.bloodGroup}
                  onChange={(event) => set('bloodGroup', event.target.value as BloodGroup)}
                >
                  {BLOOD_GROUPS.map((group) => (
                    <option key={group} value={group}>
                      {group === 'UNKNOWN' ? 'Not known' : group}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {form.role === 'patient' && (
              <div>
                <label className="label" htmlFor="notes">
                  Medical notes <span className="normal-case text-ink-500">(optional)</span>
                </label>
                <textarea
                  id="notes"
                  className="input min-h-[80px] resize-y"
                  value={form.medicalNotes}
                  onChange={(event) => set('medicalNotes', event.target.value)}
                  placeholder="Allergies, conditions, regular medication..."
                  maxLength={1000}
                />
              </div>
            )}

            <button type="submit" className="btn-primary w-full py-3" disabled={busy}>
              {busy ? <Spinner className="h-4 w-4" /> : null}
              {busy ? 'Creating account' : 'Create account'}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-ink-400">
            Already registered?{' '}
            <Link to="/login" className="font-semibold text-emergency-400 hover:text-emergency-300">
              Sign in
            </Link>
          </p>
        </div>
      </motion.div>
    </div>
  );
}
