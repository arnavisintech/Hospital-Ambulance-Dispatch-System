import { useId, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Ambulance, BedDouble, ChevronDown, Copy, Hospital, MapPin, Phone, Share2 } from 'lucide-react';
import { Avatar, Badge, Button, Card, Timeline, requestTimelineItems, useToast } from '../../../components/ui';
import { cn } from '../../../lib/cn';
import { fmtPhone } from '../../../lib/format';
import { toneClasses } from '../../../lib/status';
import type { CrewContact, TimelineEvent, TrackingHospital } from '../../../lib/types';
import type { Headline } from '../trip';

/* ------------------------------------------------------------------ Call 108 pill (app bar) */

/** Compact always-visible "108" call link for the (floating) app bar. */
export function Call108Pill({ className }: { className?: string }) {
  return (
    <a
      href="tel:108"
      aria-label="Call 108 emergency helpline"
      className={cn(
        'press inline-flex h-11 items-center gap-1.5 rounded-full border border-line/70 bg-surface px-3.5 text-sm font-bold text-ink-900 shadow-raised',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
        className,
      )}
    >
      <Phone size={16} className="text-brand-500" aria-hidden />
      108
    </a>
  );
}

/* ------------------------------------------------------------------ headline */

/** Big status headline that cross-fades when it changes. Announced politely to screen readers. */
export function TripHeadline({ headline, aside }: { headline: Headline; aside?: ReactNode }) {
  const reduce = useReducedMotion();
  const t = toneClasses(headline.tone);
  return (
    <div className="flex items-start gap-3" role="status" aria-live="polite" aria-atomic="true">
      <div className="min-w-0 flex-1">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={headline.title}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.22, ease: [0.16, 1, 0.3, 1] } }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6, transition: { duration: 0.14 } }}
          >
            <h2 className="text-2xl font-extrabold leading-tight tracking-tight text-ink-900 tabular-nums">{headline.title}</h2>
            {headline.subtitle && (
              <p className="mt-1 flex items-center gap-1.5 text-sm font-medium text-ink-500">
                <span className={cn('h-2 w-2 shrink-0 rounded-full', t.dot)} aria-hidden />
                {headline.subtitle}
              </p>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
      {aside}
    </div>
  );
}

/* ------------------------------------------------------------------ crew */

export function CrewCard({ crew, registration, kind }: { crew?: CrewContact | null; registration?: string | null; kind?: string | null }) {
  if (!crew && !registration) return null;
  return (
    <Card padding="md" className="flex items-center gap-3">
      {crew ? (
        <Avatar name={crew.name} initials={crew.initials} size="lg" />
      ) : (
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-500" aria-hidden><Ambulance size={22} /></span>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-base font-bold text-ink-900">{crew?.name ?? 'Your ambulance'}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm text-ink-500">
          {registration && <span className="rounded-sm border border-line-strong bg-canvas px-1.5 py-0.5 font-mono text-xs font-bold tracking-wide text-ink-900">{registration}</span>}
          {kind && <Badge tone="info">{kind.toUpperCase()}</Badge>}
        </p>
      </div>
      {crew?.phone && (
        <a
          href={`tel:${crew.phone}`}
          aria-label={`Call ${crew.name} on ${fmtPhone(crew.phone)}`}
          className="press flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-success text-white shadow-[0_6px_16px_-6px_rgb(var(--success)/.6)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success focus-visible:ring-offset-2"
        >
          <Phone size={20} aria-hidden />
        </a>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ hospital */

export function HospitalCard({ hospital, fallbackName }: { hospital?: Pick<TrackingHospital, 'name'> & Partial<TrackingHospital> | null; fallbackName?: string | null }) {
  const name = hospital?.name ?? fallbackName;
  if (!name) {
    return (
      <Card padding="md" className="flex items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-canvas text-ink-500" aria-hidden><Hospital size={20} /></span>
        <div>
          <p className="font-semibold text-ink-900">Choosing the right hospital</p>
          <p className="text-sm text-ink-500">We check live bed availability before you arrive</p>
        </div>
      </Card>
    );
  }
  const reserved = hospital?.reserved;
  const title = reserved === 'icu' ? 'ICU bed confirmed' : reserved === 'bed' ? 'Bed confirmed' : 'Destination hospital';
  return (
    <Card padding="md" className="flex items-start gap-3">
      <span className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-full', reserved ? 'bg-teal-bg text-teal-fg' : 'bg-canvas text-ink-700')} aria-hidden>
        {reserved ? <BedDouble size={20} /> : <Hospital size={20} />}
      </span>
      <div className="min-w-0 flex-1">
        <p className={cn('text-xs font-bold uppercase tracking-wide', reserved ? 'text-teal-fg' : 'text-ink-500')}>{title}</p>
        <p className="mt-0.5 text-base font-bold leading-snug text-ink-900">{name}</p>
        {hospital?.address && <p className="mt-0.5 text-sm text-ink-500">{hospital.address}</p>}
      </div>
      {hospital?.phone && (
        <a href={`tel:${hospital.phone}`} aria-label={`Call ${name}`} className="press flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line-strong text-ink-900 hover:bg-canvas">
          <Phone size={18} aria-hidden />
        </a>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ pickup */

export function PickupCard({ address, zone }: { address?: string | null; zone?: string | null }) {
  if (!address && !zone) return null;
  return (
    <div className="flex items-start gap-3 px-1">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-500" aria-hidden><MapPin size={16} /></span>
      <div className="min-w-0">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Pickup</p>
        <p className="text-sm font-medium text-ink-900">{address || zone}</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ share */

/** Share the live trip with family: navigator.share when available, else copy the link. */
export function ShareTripCard({ getLink }: { getLink: () => Promise<{ url: string }> }) {
  const { success, error } = useToast();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    try {
      const { url } = await getLink();
      const abs = new URL(url, window.location.origin).toString();
      const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
      if (nav.share) {
        try {
          await nav.share({ title: 'Live ambulance trip', text: 'Follow the ambulance live on HADS', url: abs });
          return;
        } catch (e) {
          if ((e as Error).name === 'AbortError') return; // user closed the share sheet
        }
      }
      try {
        await navigator.clipboard.writeText(abs);
        success('Link copied — send it to family');
      } catch {
        /* clipboard blocked: show the link so it can be copied manually */
      }
      setCopied(abs);
    } catch (e) {
      error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card padding="md">
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-info-bg text-info-fg" aria-hidden><Share2 size={20} /></span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-ink-900">Share live trip</p>
          <p className="text-sm text-ink-500">Family can follow along — no login needed</p>
        </div>
        <Button variant="secondary" size="md" onClick={() => void run()} loading={busy} icon={Share2}>Share</Button>
      </div>
      {copied && (
        <label className="mt-3 flex items-center gap-2 rounded-md bg-canvas px-3 py-2">
          <Copy size={16} className="shrink-0 text-ink-500" aria-hidden />
          <span className="sr-only">Share link</span>
          <input readOnly value={copied} onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 bg-transparent text-sm text-ink-700 focus:outline-none" />
        </label>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ timeline (expandable) */

export function TimelineToggle({ timeline, status, defaultOpen = false }: { timeline?: TimelineEvent[]; status: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const reduce = useReducedMotion();
  return (
    <div className="rounded-lg border border-line/70 bg-surface">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-[52px] w-full items-center justify-between gap-3 rounded-lg px-4 text-left font-semibold text-ink-900 hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        Trip timeline
        <ChevronDown size={20} className={cn('text-ink-500 transition-transform duration-standard', open && 'rotate-180')} aria-hidden />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={id}
            initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={reduce ? { opacity: 1 } : { height: 'auto', opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0, transition: { duration: 0.15 } }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 pt-1">
              <Timeline items={requestTimelineItems(timeline, status, { consumer: true })} dense />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
