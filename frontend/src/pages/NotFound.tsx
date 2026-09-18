import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';

export function NotFound() {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <Compass className="h-10 w-10 text-ink-500" aria-hidden />
      <div>
        <p className="numeric text-4xl font-extrabold text-ink-200">404</p>
        <p className="mt-1 text-ink-400">That page does not exist.</p>
      </div>
      <Link to="/" className="btn-primary">
        Back to safety
      </Link>
    </div>
  );
}
