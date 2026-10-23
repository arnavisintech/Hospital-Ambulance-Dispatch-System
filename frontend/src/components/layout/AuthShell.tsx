import type { ReactNode } from 'react';
import { BedDouble, MapPin, ShieldCheck } from 'lucide-react';
import { BrandMark } from './Chrome';
import { Call108Button } from '../ui/EmptyState';

/** Two-column auth frame: brand panel (desktop) + form column. */
export function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-dvh bg-canvas">
      <aside className="relative hidden w-[44%] max-w-[620px] flex-col justify-between overflow-hidden bg-brand-50 p-10 lg:flex">
        <BrandMark />
        <div className="relative z-[1] max-w-md">
          <h2 className="text-4xl font-extrabold leading-tight tracking-tight text-ink-900">
            Help is closer than you think.
          </h2>
          <p className="mt-3 text-lg text-ink-700">
            One platform for patients, crews, control rooms and hospitals — so the nearest ambulance reaches you fast and a bed is ready on arrival.
          </p>
          <ul className="mt-8 space-y-4">
            {[
              { icon: MapPin, t: 'Live tracking from dispatch to handover' },
              { icon: ShieldCheck, t: 'Nearest ambulance by real road ETA' },
              { icon: BedDouble, t: 'Hospital bed confirmed before you arrive' },
            ].map(({ icon: Icon, t }) => (
              <li key={t} className="flex items-center gap-3 text-base font-semibold text-ink-900">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-surface text-brand-500 shadow-card" aria-hidden><Icon size={20} /></span>
                {t}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative z-[1] text-sm text-ink-500">In a life-threatening emergency you can always dial 108.</p>
        {/* decorative rings */}
        <svg className="pointer-events-none absolute -bottom-40 -right-40 h-[520px] w-[520px] text-brand-200" viewBox="0 0 520 520" aria-hidden>
          {[80, 140, 200, 260].map((r) => <circle key={r} cx="260" cy="260" r={r} fill="none" stroke="currentColor" strokeWidth="1.5" opacity={1 - r / 320} />)}
        </svg>
      </aside>
      <main id="main" className="flex flex-1 flex-col">
        <div className="flex items-center justify-between px-5 pt-safe" style={{ paddingTop: 'calc(var(--safe-top) + 16px)' }}>
          <BrandMark className="lg:invisible" />
          <Call108Button size="sm" variant="ghost" />
        </div>
        <div className="flex flex-1 items-start justify-center px-5 py-8 sm:items-center">
          <div className="w-full max-w-[420px]">
            <h1 className="text-3xl font-extrabold tracking-tight text-ink-900">{title}</h1>
            {subtitle && <p className="mt-1.5 text-base text-ink-500">{subtitle}</p>}
            <div className="mt-7">{children}</div>
            {footer && <div className="mt-8">{footer}</div>}
          </div>
        </div>
      </main>
    </div>
  );
}
