import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import {
  Activity, Ambulance, ArrowRight, BedDouble, FileCheck2, MapPin, Phone, Radar,
  ShieldCheck, Siren, Timer, WifiOff,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/ui/Toast';
import { Button, ButtonLink } from '../components/ui/Button';
import { Call108Button } from '../components/ui/EmptyState';
import { ProgressSteps } from '../components/ui/ProgressSteps';
import { Avatar } from '../components/ui/Avatar';
import { BrandMark } from '../components/layout/Chrome';
import { cn } from '../lib/cn';

/** NFR5: tap 1 = Quick SOS (guest session), tap 2 = confirm on the SOS screen. */
function useQuickSos() {
  const { guest } = useAuth();
  const nav = useNavigate();
  const { error } = useToast();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await guest();
      nav('/sos');
    } catch {
      error("Couldn't start SOS — check your connection, or call 108 right away.", { title: 'Not connected' });
      setBusy(false);
    }
  };
  return { go, busy };
}

export default function Landing() {
  const sos = useQuickSos();
  const heroCta = useRef<HTMLDivElement>(null);
  const [showSticky, setShowSticky] = useState(false);

  useEffect(() => {
    const el = heroCta.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setShowSticky(!e.isIntersecting), { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div className="min-h-dvh bg-surface">
      <TopNav />
      <main id="main">
        {/* ------------------------------------------------------------------ hero */}
        <section className="relative overflow-hidden bg-gradient-to-b from-brand-50 via-surface to-surface">
          <HeroBackdrop />
          <div className="relative mx-auto grid max-w-6xl items-center gap-10 px-5 pb-12 pt-8 sm:pt-14 lg:grid-cols-[1.1fr_1fr] lg:gap-16 lg:pb-24 lg:pt-20">
            <div>
              <span className="inline-flex items-center gap-2 rounded-full border border-brand-100 bg-surface px-3 py-1.5 text-xs font-semibold text-ink-700 shadow-card">
                <span className="relative flex h-2 w-2" aria-hidden>
                  <span className="absolute inset-0 animate-ping rounded-full bg-success opacity-60" />
                  <span className="relative h-2 w-2 rounded-full bg-success" />
                </span>
                Live across Chennai · 24×7
              </span>
              <h1 className="mt-5 text-display font-extrabold leading-[1.05] tracking-tight text-ink-900 text-balance sm:text-5xl lg:text-display-lg">
                Emergency? <span className="text-brand-500">An ambulance in minutes.</span>
              </h1>
              <p className="mt-5 max-w-xl text-lg text-ink-700">
                Two taps to share your location. We dispatch the nearest ambulance by real road time, confirm a hospital bed,
                and show it arriving live.
              </p>

              <div ref={heroCta} className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
                <SosButton onClick={() => void sos.go()} busy={sos.busy} />
                <Call108Button size="xl" className="sm:px-6" />
              </div>
              <p className="mt-3 text-sm text-ink-500">No sign-up needed. Your location is shared only with the responding crew.</p>

              <ul className="mt-8 flex flex-col gap-3 text-sm font-medium text-ink-700 sm:flex-row sm:flex-wrap sm:gap-x-6">
                {[
                  { icon: Radar, t: 'Nearest by road ETA' },
                  { icon: BedDouble, t: 'Bed confirmed en route' },
                  { icon: MapPin, t: 'Track it to your door' },
                ].map(({ icon: Icon, t }) => (
                  <li key={t} className="flex items-center gap-2 whitespace-nowrap">
                    <Icon size={18} className="text-brand-500" aria-hidden />{t}
                  </li>
                ))}
              </ul>
            </div>
            <PhoneMock />
          </div>
        </section>

        {/* ------------------------------------------------------------------ stats */}
        <StatsStrip />

        {/* ------------------------------------------------------------------ how it works */}
        <section id="how" className="mx-auto max-w-6xl scroll-mt-20 px-5 py-16 sm:py-24">
          <p className="text-sm font-bold uppercase tracking-wider text-brand-500">How it works</p>
          <h2 className="mt-2 max-w-2xl text-3xl font-extrabold tracking-tight text-ink-900 sm:text-4xl">From SOS to hospital bed, without the guesswork.</h2>
          <ol className="mt-10 grid gap-5 md:grid-cols-3">
            {[
              { icon: Siren, title: 'Tap SOS', body: 'We pick up your location automatically. Tell us what happened in one tap — or skip it, help is already on the way.' },
              { icon: Ambulance, title: 'Nearest ambulance dispatched', body: 'Matched by real road travel time, not straight-line distance. The crew accepts within seconds.' },
              { icon: BedDouble, title: 'Bed ready on arrival', body: 'We confirm a hospital with the right capacity and keep you, your family and the ER updated live.' },
            ].map((s, i) => (
              <li key={s.title} className="relative rounded-xl border border-line/80 bg-surface p-6 shadow-card">
                <div className="flex items-center justify-between">
                  <span className="flex h-12 w-12 items-center justify-center rounded-lg bg-brand-50 text-brand-500" aria-hidden><s.icon size={24} /></span>
                  <span className="text-5xl font-extrabold text-line" aria-hidden>{i + 1}</span>
                </div>
                <h3 className="mt-5 text-xl font-bold">{s.title}</h3>
                <p className="mt-2 text-ink-500">{s.body}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* ------------------------------------------------------------------ for hospitals */}
        <section id="hospitals" className="scroll-mt-20 bg-canvas">
          <div className="mx-auto grid max-w-6xl items-center gap-10 px-5 py-16 sm:py-24 lg:grid-cols-2 lg:gap-16">
            <div>
              <p className="text-sm font-bold uppercase tracking-wider text-teal-fg">For hospitals & fleets</p>
              <h2 className="mt-2 text-3xl font-extrabold tracking-tight text-ink-900 sm:text-4xl">Know who's coming before they arrive.</h2>
              <p className="mt-4 text-lg text-ink-700">
                Partner hospitals publish live bed and ICU capacity, get incoming-patient alerts with ETA and severity, and
                close trips with automatic billing and insurance claims.
              </p>
              <ul className="mt-8 space-y-4">
                {[
                  { icon: Activity, t: 'Live capacity board', d: 'Update beds and ICU in two taps; stale data is flagged automatically.' },
                  { icon: Timer, t: 'Incoming alerts with ETA', d: 'See severity, crew and arrival time — prep the bay before the doors open.' },
                  { icon: FileCheck2, t: 'Billing & claims built in', d: 'Fares, revenue share and insurance claims generated at handover.' },
                ].map(({ icon: Icon, t, d }) => (
                  <li key={t} className="flex gap-4">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-surface text-teal shadow-card" aria-hidden><Icon size={22} /></span>
                    <div>
                      <p className="font-bold text-ink-900">{t}</p>
                      <p className="text-ink-500">{d}</p>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="mt-8 flex flex-wrap gap-3">
                <ButtonLink to="/login" variant="dark" size="lg" iconRight={ArrowRight}>Partner sign in</ButtonLink>
              </div>
            </div>
            <HospitalMock />
          </div>
        </section>

        {/* ------------------------------------------------------------------ final CTA */}
        <section className="mx-auto max-w-6xl px-5 py-16 sm:py-20">
          <div className="flex flex-col items-start justify-between gap-6 rounded-2xl bg-ink-900 p-8 sm:p-10 md:flex-row md:items-center">
            <div>
              <h2 className="text-2xl font-extrabold text-white sm:text-3xl">Save HADS for the moment it matters.</h2>
              <p className="mt-2 text-ink-400">Create a free account so your name and number are ready when you need help.</p>
            </div>
            <div className="flex flex-wrap gap-3">
              <ButtonLink to="/register" size="lg">Create free account</ButtonLink>
              <ButtonLink to="/login" size="lg" variant="secondary">Sign in</ButtonLink>
            </div>
          </div>
        </section>
      </main>
      <Footer />

      {/* sticky mobile SOS bar once the hero CTA scrolls away */}
      <div
        className={cn(
          'fixed inset-x-0 bottom-0 z-sticky border-t border-line bg-surface/95 px-4 pt-3 backdrop-blur transition-transform duration-standard sm:hidden pb-safe-3',
          showSticky ? 'translate-y-0' : 'translate-y-full',
        )}
        aria-hidden={!showSticky}
      >
        <div className="flex gap-3">
          <Button size="lg" className="flex-1" icon={Siren} loading={sos.busy} onClick={() => void sos.go()} tabIndex={showSticky ? 0 : -1}>SOS — Get help now</Button>
          <a href="tel:108" tabIndex={showSticky ? 0 : -1} className="press flex h-12 w-12 items-center justify-center rounded-md border border-line-strong text-ink-900" aria-label="Call 108">
            <Phone size={20} aria-hidden />
          </a>
        </div>
      </div>
    </div>
  );
}

function TopNav() {
  return (
    <header className="sticky top-0 z-sticky border-b border-line/70 bg-surface/90 pt-safe backdrop-blur">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-toast focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:shadow-raised">Skip to content</a>
      <nav className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-5" aria-label="Main">
        <BrandMark />
        <div className="hidden items-center gap-6 text-sm font-semibold text-ink-700 md:flex">
          <a href="#how" className="hover:text-ink-900">How it works</a>
          <a href="#hospitals" className="hover:text-ink-900">For hospitals</a>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <a href="tel:108" className="hidden h-10 items-center gap-2 rounded-md px-3 text-sm font-semibold text-ink-700 hover:bg-canvas sm:inline-flex">
            <Phone size={16} aria-hidden /> 108
          </a>
          <ButtonLink to="/login" variant="ghost" size="sm" className="h-10">Sign in</ButtonLink>
          <ButtonLink to="/register" variant="secondary" size="sm" className="hidden h-10 sm:inline-flex">Create account</ButtonLink>
        </div>
      </nav>
    </header>
  );
}

function SosButton({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  const reduce = useReducedMotion();
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-busy={busy || undefined}
      aria-label="SOS — request an ambulance now as a guest"
      whileTap={reduce ? undefined : { scale: 0.97 }}
      className={cn(
        'group relative inline-flex h-16 items-center justify-center gap-3 overflow-hidden rounded-xl bg-brand-500 pl-3 pr-7 text-white',
        'shadow-[0_14px_32px_-10px_rgb(var(--brand-500)/.7)] transition-colors hover:bg-brand-600',
        'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-500/30 disabled:opacity-80',
      )}
    >
      <span className="relative flex h-11 w-11 items-center justify-center rounded-lg bg-white/15" aria-hidden>
        <span className="absolute inset-0 rounded-lg bg-white/20 motion-safe:animate-ping" style={{ animationDuration: '2s' }} />
        <Siren size={24} />
      </span>
      <span className="flex flex-col items-start leading-tight">
        <span className="text-xl font-extrabold tracking-wide">{busy ? 'Starting…' : 'SOS'}</span>
        <span className="text-sm font-semibold text-white/85">Get an ambulance now</span>
      </span>
      <ArrowRight size={22} className="ml-2 transition-transform group-hover:translate-x-0.5" aria-hidden />
    </motion.button>
  );
}

function HeroBackdrop() {
  return (
    <svg className="pointer-events-none absolute -right-48 -top-48 h-[720px] w-[720px] text-brand-100" viewBox="0 0 720 720" aria-hidden>
      {[120, 200, 280, 360].map((r) => <circle key={r} cx="360" cy="360" r={r} fill="none" stroke="currentColor" strokeWidth="1.5" />)}
    </svg>
  );
}

/* ------------------------------------------------------------------ phone mock (pure SVG/HTML, no network) */

function PhoneMock() {
  const reduce = useReducedMotion();
  return (
    <div className="relative mx-auto hidden w-full max-w-[360px] md:block" aria-hidden>
      <div className="relative overflow-hidden rounded-[44px] border-[10px] border-ink-900 bg-surface shadow-[0_40px_80px_-24px_rgba(16,24,40,.35)]">
        <div className="absolute left-1/2 top-2 z-[2] h-5 w-24 -translate-x-1/2 rounded-full bg-ink-900" />
        {/* map */}
        <div className="relative h-[330px] bg-canvas">
          <svg viewBox="0 0 340 330" className="absolute inset-0 h-full w-full">
            <rect width="340" height="330" fill="rgb(var(--canvas))" />
            <path d="M0 250 Q120 236 340 260" stroke="rgb(var(--surface))" strokeWidth="18" fill="none" />
            <path d="M60 0 L90 330" stroke="rgb(var(--surface))" strokeWidth="14" fill="none" />
            <path d="M0 110 L340 90" stroke="rgb(var(--surface))" strokeWidth="12" fill="none" />
            <path d="M230 0 L250 330" stroke="rgb(var(--surface))" strokeWidth="10" fill="none" />
            <rect x="120" y="140" width="70" height="60" rx="8" fill="rgb(var(--success) / .12)" />
            <rect x="268" y="150" width="60" height="70" rx="8" fill="rgb(var(--info) / .08)" />
            {/* route */}
            <path d="M78 300 L 74 200 L 160 196 L 240 190 L 236 104" stroke="rgb(var(--surface))" strokeWidth="9" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M78 300 L 74 200 L 160 196" stroke="rgb(var(--ink-400))" strokeWidth="5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M160 196 L 240 190 L 236 104" stroke="rgb(var(--brand-500))" strokeWidth="5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {/* patient pin */}
          <div className="absolute" style={{ left: 236 - 14, top: 104 - 36 }}>
            <span className="absolute left-[5px] top-[26px] h-[18px] w-[18px] text-brand-500"><span className="hads-pulse" /></span>
            <svg width="28" height="36" viewBox="0 0 32 40" style={{ filter: 'drop-shadow(0 4px 6px rgba(16,24,40,.25))' }}>
              <path d="M16 0C7.2 0 0 7 0 15.7 0 27.4 16 40 16 40s16-12.6 16-24.3C32 7 24.8 0 16 0Z" fill="rgb(var(--brand-500))" />
              <circle cx="16" cy="15.5" r="6" fill="rgb(var(--surface))" />
            </svg>
          </div>
          {/* ambulance */}
          <motion.div
            className="absolute"
            style={{ left: 160 - 17, top: 196 - 17 }}
            animate={reduce ? undefined : { x: [0, 30, 0], y: [0, -2, 0] }}
            transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut' }}
          >
            <span className="absolute -top-9 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-ink-900 px-2.5 py-1.5 text-xs font-bold text-white tabular-nums shadow-raised">4 min</span>
            <svg width="34" height="34" viewBox="0 0 40 40" style={{ overflow: 'visible', transform: 'rotate(90deg)', filter: 'drop-shadow(0 4px 6px rgba(16,24,40,.28))' }}>
              <path d="M20 -3 L25 4 H15 Z" fill="rgb(var(--brand-500))" />
              <rect x="5" y="5" width="30" height="30" rx="9" fill="rgb(var(--surface))" stroke="rgb(var(--line-strong))" />
              <rect x="17.5" y="11" width="5" height="18" rx="1.2" fill="rgb(var(--brand-500))" />
              <rect x="11" y="17.5" width="18" height="5" rx="1.2" fill="rgb(var(--brand-500))" />
            </svg>
          </motion.div>
          {/* hospital */}
          <div className="absolute flex h-7 w-7 items-center justify-center rounded-full border-2 border-teal bg-surface text-sm font-extrabold text-teal-fg shadow-card" style={{ left: 290, top: 40 }}>H</div>
        </div>
        {/* sheet */}
        <div className="relative -mt-6 rounded-t-2xl bg-surface px-5 pb-6 pt-3 shadow-sheet">
          <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-line-strong" />
          <p className="text-xs font-semibold uppercase tracking-wide text-info-fg">Ambulance on the way</p>
          <p className="mt-1 text-2xl font-extrabold tabular-nums text-ink-900">Arriving in 4 min</p>
          <ProgressSteps current={1} className="mt-4" />
          <div className="mt-4 flex items-center gap-3 rounded-lg bg-canvas p-3">
            <Avatar name="Ravi Kumar" size="md" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold text-ink-900">Ravi Kumar · ALS</p>
              <p className="truncate text-xs text-ink-500">TN 09 AM 4521 · Apollo Greams Rd</p>
            </div>
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-success text-white"><Phone size={18} /></span>
          </div>
        </div>
      </div>
      {/* floating bed card */}
      <motion.div
        className="absolute -left-16 top-24 flex items-center gap-3 rounded-lg border border-line/80 bg-surface p-3 pr-4 shadow-raised"
        initial={reduce ? false : { opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0, transition: { delay: 0.4, duration: 0.4 } }}
      >
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-success-bg text-success"><BedDouble size={20} /></span>
        <div>
          <p className="text-sm font-bold text-ink-900">Bed confirmed</p>
          <p className="text-xs text-ink-500">Apollo Greams Road · ICU</p>
        </div>
      </motion.div>
    </div>
  );
}

/**
 * Value props (no figures): no public endpoint exposes network stats, and invented numbers must never be
 * presented as live data.
 */
function StatsStrip() {
  const props = [
    { icon: Radar, title: 'Nearest by road', body: 'Matched on real driving time, not distance' },
    { icon: BedDouble, title: 'Bed confirmed first', body: 'Hospital capacity checked before pickup' },
    { icon: MapPin, title: 'Track it live', body: 'Share the trip with family in one tap' },
    { icon: WifiOff, title: 'Works on weak signal', body: 'Your SOS queues and retries by itself' },
  ];
  return (
    <section aria-label="Why HADS" className="border-y border-line/80 bg-surface">
      <ul className="mx-auto grid max-w-6xl grid-cols-1 gap-px bg-line/70 sm:grid-cols-2 lg:grid-cols-4">
        {props.map((s) => (
          <li key={s.title} className="flex items-start gap-3 bg-surface px-5 py-5 sm:gap-4 sm:py-7">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600" aria-hidden><s.icon size={22} /></span>
            <div className="min-w-0">
              <p className="text-base font-bold text-ink-900">{s.title}</p>
              <p className="text-sm text-ink-500">{s.body}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function HospitalMock() {
  const rows = [
    { name: 'Priya S. · Cardiac', sev: 'Critical', tone: 'bg-danger-bg text-danger-fg', eta: '3 min', bed: 'ICU' },
    { name: 'Arjun M. · Road accident', sev: 'Serious', tone: 'bg-orange-bg text-orange-fg', eta: '9 min', bed: 'Bed' },
    { name: 'Lakshmi R. · Breathing', sev: 'Moderate', tone: 'bg-warning-bg text-warning-fg', eta: '14 min', bed: 'Bed' },
  ];
  return (
    <div className="relative" aria-hidden>
      <div className="rounded-2xl border border-line/80 bg-surface p-5 shadow-raised">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Apollo Greams Road</p>
            <p className="text-lg font-bold text-ink-900">Incoming patients</p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-success-bg px-2.5 py-1 text-xs font-semibold text-success-fg">
            <span className="h-1.5 w-1.5 rounded-full bg-success" />Live
          </span>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-3">
          {[{ l: 'Beds free', v: '24' }, { l: 'ICU free', v: '5' }, { l: 'Arriving', v: '3' }].map((k) => (
            <div key={k.l} className="rounded-lg bg-canvas p-3">
              <p className="text-2xl font-extrabold tabular-nums text-ink-900">{k.v}</p>
              <p className="text-xs text-ink-500">{k.l}</p>
            </div>
          ))}
        </div>
        <ul className="mt-4 divide-y divide-line">
          {rows.map((r) => (
            <li key={r.name} className="flex items-center gap-3 py-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-info-bg text-info"><Ambulance size={18} /></span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-ink-900">{r.name}</p>
                <span className={cn('mt-0.5 inline-flex rounded-full px-2 py-0.5 text-2xs font-bold', r.tone)}>{r.sev}</span>
              </div>
              <div className="text-right">
                <p className="text-sm font-bold tabular-nums text-ink-900">{r.eta}</p>
                <p className="text-xs text-ink-500">{r.bed} reserved</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Footer() {
  return (
    <footer className="border-t border-line bg-canvas pb-24 sm:pb-0">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-5 py-10 md:flex-row md:items-start md:justify-between">
        <div className="max-w-sm">
          <BrandMark />
          <p className="mt-3 text-sm text-ink-500">Hospital Ambulance Dispatch System — connecting patients, crews, control rooms and hospitals.</p>
        </div>
        <nav aria-label="Footer" className="grid grid-cols-2 gap-x-10 gap-y-2 text-sm sm:grid-cols-3">
          <a href="#how" className="text-ink-700 hover:text-ink-900">How it works</a>
          <a href="#hospitals" className="text-ink-700 hover:text-ink-900">For hospitals</a>
          <Link to="/login" className="text-ink-700 hover:text-ink-900">Sign in</Link>
          <Link to="/register" className="text-ink-700 hover:text-ink-900">Create account</Link>
          <a href="tel:108" className="text-ink-700 hover:text-ink-900">Call 108</a>
        </nav>
      </div>
      <div className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-5 py-5 text-xs text-ink-500 sm:flex-row sm:justify-between">
          <p className="flex items-center gap-1.5"><ShieldCheck size={14} aria-hidden /> In a life-threatening emergency, always call <a href="tel:108" className="font-bold text-ink-900">108</a>.</p>
          <p>© {new Date().getFullYear()} HADS · Chennai</p>
        </div>
      </div>
    </footer>
  );
}
