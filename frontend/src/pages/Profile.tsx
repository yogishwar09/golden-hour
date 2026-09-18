import { useState, type FormEvent } from 'react';
import toast from 'react-hot-toast';
import { BLOOD_GROUPS, type BloodGroup, type UserDto } from '@sas/shared';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { Card, ErrorNotice, SectionTitle, Spinner } from '../components/ui';

export function Profile() {
  const { user, updateUser } = useAuth();

  const [form, setForm] = useState({
    name: user?.name ?? '',
    phone: user?.phone ?? '',
    bloodGroup: (user?.bloodGroup ?? 'UNKNOWN') as BloodGroup,
    medicalNotes: user?.medicalNotes ?? '',
    emergencyContactName: user?.emergencyContact?.name ?? '',
    emergencyContactPhone: user?.emergencyContact?.phone ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user) return null;

  const set = <Key extends keyof typeof form>(key: Key, value: (typeof form)[Key]): void => {
    setForm((previous) => ({ ...previous, [key]: value }));
  };

  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const hasContact =
        form.emergencyContactName.trim().length > 1 && form.emergencyContactPhone.trim().length > 6;

      const response = await api.patch<{ user: UserDto }>('/auth/me', {
        name: form.name,
        phone: form.phone,
        bloodGroup: form.bloodGroup,
        medicalNotes: form.medicalNotes.trim() || undefined,
        ...(hasContact
          ? {
              emergencyContact: {
                name: form.emergencyContactName.trim(),
                phone: form.emergencyContactPhone.trim(),
              },
            }
          : {}),
      });
      updateUser(response.data.user);
      toast.success('Profile updated');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-2xl space-y-5 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Profile</h1>
        <p className="mt-1 text-sm text-ink-400">
          These details are sent to the crew the moment you raise an emergency.
        </p>
      </div>

      <Card className="p-6">
        <form onSubmit={handleSubmit} className="space-y-5" noValidate>
          {error && <ErrorNotice message={error} />}

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="p-name">
                Full name
              </label>
              <input
                id="p-name"
                className="input"
                value={form.name}
                onChange={(event) => set('name', event.target.value)}
                required
              />
            </div>
            <div>
              <label className="label" htmlFor="p-phone">
                Phone
              </label>
              <input
                id="p-phone"
                className="input"
                value={form.phone}
                onChange={(event) => set('phone', event.target.value)}
                required
              />
            </div>
          </div>

          <div>
            <label className="label" htmlFor="p-email">
              Email
            </label>
            <input id="p-email" className="input opacity-60" value={user.email} disabled />
            <p className="mt-1 text-xs text-ink-500">
              Your email identifies the account and cannot be changed here.
            </p>
          </div>

          {user.role === 'patient' && (
            <>
              <div>
                <label className="label" htmlFor="p-blood">
                  Blood group
                </label>
                <select
                  id="p-blood"
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

              <div>
                <label className="label" htmlFor="p-notes">
                  Medical notes
                </label>
                <textarea
                  id="p-notes"
                  className="input min-h-[96px] resize-y"
                  value={form.medicalNotes}
                  onChange={(event) => set('medicalNotes', event.target.value)}
                  placeholder="Allergies, conditions, regular medication..."
                  maxLength={1000}
                />
                <p className="mt-1 text-xs text-ink-500">
                  Shown to the crew before they arrive. Keep it short and clinically relevant.
                </p>
              </div>

              <div>
                <SectionTitle>Emergency contact</SectionTitle>
                <div className="grid gap-4 sm:grid-cols-2">
                  <input
                    className="input"
                    value={form.emergencyContactName}
                    onChange={(event) => set('emergencyContactName', event.target.value)}
                    placeholder="Contact name"
                    aria-label="Emergency contact name"
                  />
                  <input
                    className="input"
                    value={form.emergencyContactPhone}
                    onChange={(event) => set('emergencyContactPhone', event.target.value)}
                    placeholder="Contact phone"
                    aria-label="Emergency contact phone"
                  />
                </div>
              </div>
            </>
          )}

          <button type="submit" className="btn-primary w-full py-3" disabled={busy}>
            {busy ? <Spinner className="h-4 w-4" /> : null}
            Save changes
          </button>
        </form>
      </Card>
    </div>
  );
}
