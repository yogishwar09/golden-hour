/**
 * Small presentational primitives shared across the screens.
 *
 * These exist so that a status chip, an empty state or a loading skeleton looks
 * the same in the patient app and the control room. Anything with real
 * behaviour lives in its own file.
 */

import type { ReactNode } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';

export function Card({
  children,
  className = '',
  ...rest
}: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`card ${className}`} {...rest}>
      {children}
    </div>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-sm font-bold uppercase tracking-wider text-ink-300">{children}</h2>
      {action}
    </div>
  );
}

export function Chip({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`chip ${className}`}>{children}</span>;
}

export function Spinner({ className = 'h-5 w-5' }: { className?: string }) {
  return <Loader2 className={`animate-spin ${className}`} aria-hidden />;
}

export function FullPageLoader({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-ink-300">
      <Spinner className="h-8 w-8 text-emergency-400" />
      <p className="text-sm">{label}...</p>
    </div>
  );
}

/** A content-shaped placeholder, so panels do not collapse while loading. */
export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div className={`relative overflow-hidden rounded-lg bg-ink-800 ${className}`}>
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-ink-700/60 to-transparent" />
    </div>
  );
}

export function EmptyState({
  title,
  description,
  icon,
  action,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {icon && <div className="mb-1 text-ink-500">{icon}</div>}
      <p className="text-sm font-semibold text-ink-200">{title}</p>
      {description && <p className="max-w-sm text-sm text-ink-400">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function ErrorNotice({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-xl border border-emergency-700/50 bg-emergency-950/40 px-3.5 py-3 text-sm text-emergency-200"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{message}</span>
    </div>
  );
}

/** A headline figure for the control room. */
export function StatTile({
  label,
  value,
  hint,
  accent = 'text-ink-100',
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  accent?: string;
  icon?: ReactNode;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-ink-400">{label}</p>
        {icon && <span className="text-ink-500">{icon}</span>}
      </div>
      <p className={`numeric mt-2 text-3xl font-bold leading-none ${accent}`}>{value}</p>
      {hint && <p className="mt-1.5 text-xs text-ink-400">{hint}</p>}
    </Card>
  );
}

/** A live/offline dot, used wherever the socket's health matters. */
export function ConnectionDot({ connected }: { connected: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-300">
      <span className="relative flex h-2 w-2">
        {connected && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
        )}
        <span
          className={`relative inline-flex h-2 w-2 rounded-full ${
            connected ? 'bg-emerald-400' : 'bg-ink-500'
          }`}
        />
      </span>
      {connected ? 'Live' : 'Offline'}
    </span>
  );
}
