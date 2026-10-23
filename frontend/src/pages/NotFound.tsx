import { Home, MapPinOff } from 'lucide-react';
import { BrandMark } from '../components/layout/Chrome';
import { ButtonLink } from '../components/ui/Button';
import { Call108Button } from '../components/ui/EmptyState';

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="px-5 pt-5"><BrandMark /></header>
      <main id="main" className="flex flex-1 flex-col items-center justify-center px-6 pb-16 text-center">
        <span className="flex h-20 w-20 items-center justify-center rounded-full bg-brand-50 text-brand-500" aria-hidden>
          <MapPinOff size={36} />
        </span>
        <p className="mt-6 text-sm font-bold uppercase tracking-wider text-brand-500">Error 404</p>
        <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-ink-900">We couldn't find that page</h1>
        <p className="mt-2 max-w-sm text-ink-500">The link may be old or mistyped. Head home to request an ambulance or sign in.</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <ButtonLink to="/" icon={Home} size="lg">Go home</ButtonLink>
          <Call108Button size="lg" />
        </div>
      </main>
    </div>
  );
}
