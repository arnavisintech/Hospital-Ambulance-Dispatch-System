import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { Check, Clock, MapPin, Route, X } from 'lucide-react';
import { Button, CountdownRing, Modal, SeverityBadge, SlideButton, useToast } from '../../components/ui';
import { useFocusTrap, useLockBodyScroll } from '../../hooks/useFocusTrap';
import { post } from '../../lib/api';
import { cn } from '../../lib/cn';
import { fmtDistance, fmtEta } from '../../lib/format';
import { incidentMeta, severityMeta, toneClasses } from '../../lib/status';
import type { RequestOut } from '../../lib/types';
import { offerWindowS } from './nav';

const REASONS = ['Vehicle issue', 'Crew not ready', 'Too far away', 'Already handling a case', 'Other'];

/**
 * Full-screen incoming offer (driver-partner style): countdown ring, incident + severity, distance/ETA,
 * slide to accept, reject with reason. Rendered as an alertdialog with focus trapped inside.
 */
export function OfferModal({ offer, firstSeen, onDone }: { offer: RequestOut; firstSeen: number; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const { success, error, info } = useToast();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState(REASONS[0]);
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(false);
  useFocusTrap(ref, !rejecting);
  useLockBodyScroll(true);

  const total = offerWindowS(offer.offered_at, offer.offer_expires_at);
  const endsAt = offer.offer_expires_at ?? firstSeen + total * 1000;
  const inc = incidentMeta(offer.incident_type);
  const sev = severityMeta(offer.severity);

  const accept = async () => {
    try {
      await post(`/crew/offers/${offer.id}/accept`);
      success('Trip accepted — navigate to the patient');
      onDone();
    } catch (e) {
      error(e);
      onDone();
      throw e;
    }
  };
  const reject = async () => {
    setBusy(true);
    try {
      await post(`/crew/offers/${offer.id}/reject`, { reason });
      info('Offer declined — it goes to the next ambulance');
      setRejecting(false);
      onDone();
    } catch (e) { error(e); onDone(); } finally { setBusy(false); }
  };

  return createPortal(
    <div className="fixed inset-0 z-modal flex items-stretch justify-center bg-ink-900/60 sm:items-center sm:p-6">
      <motion.div
        ref={ref}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="offer-title"
        aria-describedby="offer-desc"
        tabIndex={-1}
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 60 }}
        animate={{ opacity: 1, y: 0, transition: { type: 'spring', stiffness: 420, damping: 36 } }}
        className="flex w-full flex-col bg-surface sm:max-w-md sm:rounded-2xl sm:shadow-raised"
      >
        <div className="relative overflow-hidden bg-brand-500 px-5 pb-6 pt-[calc(var(--safe-top)+20px)] text-white sm:rounded-t-2xl sm:pt-5">
          <span className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-white/10" aria-hidden />
          <p className="text-sm font-semibold uppercase tracking-wider text-white/85">New emergency</p>
          <div className="mt-2 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <h2 id="offer-title" className="text-2xl font-extrabold leading-tight">{inc.label}</h2>
              <p className="mt-1 text-sm text-white/90">{offer.zone_label ?? 'Nearby'}</p>
            </div>
            <div className="rounded-full bg-surface p-1.5 shadow-raised">
              <CountdownRing total={total} endsAt={endsAt} size={76} stroke={7} caption="sec" onExpire={() => setExpired(true)} />
            </div>
          </div>
        </div>

        <div id="offer-desc" className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
          <div className="flex items-center gap-3 rounded-lg border border-line/70 p-3">
            <span className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-full', toneClasses(sev.tone).soft)} aria-hidden><inc.icon size={22} /></span>
            <div className="min-w-0 flex-1">
              <SeverityBadge severity={offer.severity} size="md" showLevel />
              <p className="mt-1 text-sm text-ink-500">{sev.description}</p>
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-3">
            <div className="rounded-lg bg-canvas p-3">
              <dt className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-500"><Route size={14} aria-hidden /> Distance</dt>
              <dd className="mt-1 text-2xl font-extrabold tabular-nums text-ink-900">{fmtDistance(offer.distance_km)}</dd>
            </div>
            <div className="rounded-lg bg-canvas p-3">
              <dt className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-500"><Clock size={14} aria-hidden /> To patient</dt>
              <dd className="mt-1 text-2xl font-extrabold tabular-nums text-ink-900">{fmtEta(offer.eta_seconds)}</dd>
            </div>
          </dl>
          {offer.address && (
            <p className="flex items-start gap-2 text-sm text-ink-700"><MapPin size={16} className="mt-0.5 shrink-0 text-brand-500" aria-hidden />{offer.address}</p>
          )}
          {offer.notes && <p className="rounded-md bg-warning-bg px-3 py-2 text-sm text-warning-fg">“{offer.notes}”</p>}
          {expired && <p className="rounded-md bg-canvas px-3 py-2 text-sm font-semibold text-ink-700" role="alert">This offer timed out and is moving to the next ambulance.</p>}
        </div>

        <div className="space-y-3 border-t border-line px-5 pb-safe-3 pt-4 sm:pb-5">
          <SlideButton label="Slide to accept" tone="success" icon={Check} confirmedLabel="Accepted" onConfirm={accept} disabled={expired} />
          <Button variant="ghost" fullWidth icon={X} onClick={() => setRejecting(true)} disabled={expired}>Decline</Button>
        </div>
      </motion.div>

      <Modal open={rejecting} onClose={() => setRejecting(false)} title="Why are you declining?" size="sm"
        footer={<><Button variant="secondary" onClick={() => setRejecting(false)}>Back</Button><Button onClick={() => void reject()} loading={busy}>Decline offer</Button></>}>
        <fieldset>
          <legend className="sr-only">Reason</legend>
          <div className="space-y-2">
            {REASONS.map((r) => (
              <label key={r} className={cn('flex min-h-[48px] cursor-pointer items-center gap-3 rounded-md border px-3 focus-within:ring-2 focus-within:ring-brand-500', reason === r ? 'border-brand-500 bg-brand-50' : 'border-line')}>
                <input type="radio" name="reason" value={r} checked={reason === r} onChange={() => setReason(r)} className="h-4 w-4 accent-[rgb(var(--brand-500))]" data-autofocus={r === REASONS[0] || undefined} />
                <span className="text-sm font-medium text-ink-900">{r}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </Modal>
    </div>,
    document.body,
  );
}
