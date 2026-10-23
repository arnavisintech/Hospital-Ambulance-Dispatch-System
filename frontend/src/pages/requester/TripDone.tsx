import { useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { CheckCheck, FileCheck2, Receipt, Siren, Star, XCircle } from 'lucide-react';
import { MobileAppLayout } from '../../components/layout/MobileAppLayout';
import { HospitalMarker, MapCanvas, PatientPin, FitBounds } from '../../components/map';
import {
  Button, ButtonLink, Card, CardHeader, Input, Modal, SkeletonText, StatusPill, Textarea, useToast,
} from '../../components/ui';
import { post } from '../../lib/api';
import { cn } from '../../lib/cn';
import { fmtClock, fmtDate, fmtDuration, fmtMoney } from '../../lib/format';
import type { BillSummary, Feedback, Tracking } from '../../lib/types';
import { CrewCard, TimelineToggle } from './components/TripCards';
import { tripHeadline, tripTimes } from './trip';

/** Completed (summary, bill, rating) or cancelled/failed request. */
export function TripDone({ data, onChanged }: { data: Tracking; onChanged: () => void }) {
  const r = data.request;
  const reduce = useReducedMotion();
  const completed = r.status === 'completed';
  const hosp = data.hospital ?? r.destination_hospital ?? null;
  const headline = tripHeadline(r.status, null, hosp?.name);
  const times = tripTimes(r, data.timeline ?? r.timeline);

  return (
    <MobileAppLayout title={completed ? 'Trip summary' : 'Request'} subtitle={fmtDate(r.created_at)} back="/history" width="md">
      <motion.div
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.22 } }}
        className="space-y-4"
      >
        {/* hero */}
        <section className="flex flex-col items-center gap-3 pt-2 text-center" role="status">
          <motion.span
            initial={reduce ? false : { scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1, transition: { type: 'spring', stiffness: 420, damping: 22 } }}
            className={cn('flex h-16 w-16 items-center justify-center rounded-full', completed ? 'bg-success text-white shadow-[0_10px_24px_-8px_rgb(var(--success)/.7)]' : 'bg-canvas text-ink-500')}
            aria-hidden
          >
            {completed ? <CheckCheck size={30} strokeWidth={2.5} /> : <XCircle size={30} />}
          </motion.span>
          <div>
            <h2 className="text-2xl font-extrabold tracking-tight text-ink-900">{headline.title}</h2>
            <p className="mt-1 text-sm text-ink-500">{headline.subtitle}</p>
          </div>
        </section>

        {completed ? (
          <>
            {hosp && (
              <div className="h-40 overflow-hidden rounded-lg border border-line/70 shadow-card">
                <MapCanvas interactive={false} center={[hosp.lat, hosp.lng]} zoom={13} ariaLabel="Trip map">
                  <PatientPin position={[r.lat, r.lng]} pulse={false} />
                  <HospitalMarker position={[hosp.lat, hosp.lng]} name={hosp.name} selected />
                  <FitBounds points={[[r.lat, r.lng], [hosp.lat, hosp.lng]]} padding={36} insets={{}} animate={false} />
                </MapCanvas>
              </div>
            )}
            <Card padding="md">
              <CardHeader title="Trip summary" as="h3" />
              <dl className="grid grid-cols-2 gap-3">
                <Stat label="Response time" value={fmtDuration(times.responseS)} hint="Request to ambulance at you" />
                <Stat label="Total time" value={fmtDuration(times.totalS)} hint="Request to handover" />
              </dl>
              <ul className="mt-4 space-y-2 text-sm">
                <TimeRow label="Requested" at={times.requestedAt} />
                <TimeRow label="Ambulance assigned" at={times.assignedAt} />
                <TimeRow label="Reached you" at={times.reachedPatientAt} />
                <TimeRow label="Picked up" at={times.pickedUpAt} />
                <TimeRow label={hosp ? `At ${hosp.name}` : 'At hospital'} at={times.atHospitalAt} />
                <TimeRow label="Handover complete" at={times.completedAt} />
              </ul>
            </Card>
            <CrewCard crew={data.crew ? { ...data.crew, phone: null } : null} registration={data.ambulance?.registration_number ?? r.ambulance?.registration_number} kind={data.ambulance?.kind ?? r.ambulance?.kind} />
            <BillCard bill={data.bill ?? null} onChanged={onChanged} />
            <RatingCard requestId={r.id} existing={data.feedback ?? null} onChanged={onChanged} />
          </>
        ) : (
          <ButtonLink to="/sos" size="xl" fullWidth icon={Siren}>Request an ambulance</ButtonLink>
        )}
        <TimelineToggle timeline={data.timeline ?? r.timeline} status={r.status} />
      </motion.div>
    </MobileAppLayout>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-md bg-canvas p-3">
      <dt className="text-xs font-semibold uppercase tracking-wide text-ink-500">{label}</dt>
      <dd className="mt-1 text-xl font-extrabold tabular-nums text-ink-900">{value}</dd>
      <dd className="text-xs text-ink-500">{hint}</dd>
    </div>
  );
}

function TimeRow({ label, at }: { label: string; at: string | null }) {
  if (!at) return null;
  return (
    <li className="flex items-baseline justify-between gap-3">
      <span className="text-ink-700">{label}</span>
      <time dateTime={at} className="shrink-0 tabular-nums text-ink-500">{fmtClock(at)}</time>
    </li>
  );
}

/* ------------------------------------------------------------------ bill */

function BillCard({ bill, onChanged }: { bill: BillSummary | null; onChanged: () => void }) {
  const { success, error } = useToast();
  const [claimOpen, setClaimOpen] = useState(false);
  const [insurer, setInsurer] = useState('');
  const [policy, setPolicy] = useState('');
  const [busy, setBusy] = useState(false);
  const [claimErr, setClaimErr] = useState<{ insurer?: string; policy?: string }>({});

  if (!bill) {
    return (
      <Card padding="md">
        <CardHeader title="Bill" icon={Receipt} subtitle="Your bill is being prepared" />
        <SkeletonText lines={2} />
      </Card>
    );
  }
  const paid = bill.payment_status === 'paid';
  const claimStatus = bill.insurance_claim_status && bill.insurance_claim_status !== 'none' ? bill.insurance_claim_status : null;

  const claim = async () => {
    const errs = { insurer: insurer.trim().length < 2 ? 'Enter your insurer' : undefined, policy: policy.trim().length < 3 ? 'Enter your policy number' : undefined };
    setClaimErr(errs);
    if (errs.insurer || errs.policy) return;
    setBusy(true);
    try {
      await post(`/billing/${bill.id}/claim`, { insurer: insurer.trim(), policy_number: policy.trim() });
      success('Claim submitted — we will update you here');
      setClaimOpen(false);
      onChanged();
    } catch (e) { error(e); } finally { setBusy(false); }
  };

  return (
    <Card padding="md">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Trip fare</p>
          <p className="mt-0.5 text-3xl font-extrabold tabular-nums text-ink-900">{fmtMoney(bill.amount)}</p>
        </div>
        <StatusPill status={bill.payment_status} kind="generic" size="md" />
      </div>
      {claimStatus && (
        <p className="mt-3 flex items-center gap-2 text-sm text-ink-700">
          <FileCheck2 size={16} className="text-ink-500" aria-hidden /> Insurance claim <StatusPill status={claimStatus} kind="generic" />
        </p>
      )}
      {!paid && !claimStatus && (
        <p className="mt-3 text-sm text-ink-500">Pay at the hospital's billing desk (cash, card or UPI). This updates once they confirm the payment.</p>
      )}
      {!claimStatus && !paid && (
        <div className="mt-4">
          <Button variant="secondary" icon={FileCheck2} onClick={() => setClaimOpen(true)} fullWidth>Claim insurance instead</Button>
        </div>
      )}

      <Modal open={claimOpen} onClose={() => setClaimOpen(false)} title="Claim insurance" description="We'll send the bill to your insurer for this trip." size="sm"
        footer={<><Button variant="secondary" onClick={() => setClaimOpen(false)}>Cancel</Button><Button onClick={() => void claim()} loading={busy}>Submit claim</Button></>}>
        <div className="space-y-3">
          <Input label="Insurer" value={insurer} onChange={(e) => setInsurer(e.target.value)} error={claimErr.insurer} placeholder="e.g. Star Health" data-autofocus autoComplete="organization" />
          <Input label="Policy number" value={policy} onChange={(e) => setPolicy(e.target.value)} error={claimErr.policy} placeholder="As printed on your card" />
        </div>
      </Modal>
    </Card>
  );
}

/* ------------------------------------------------------------------ rating */

const RATING_WORDS = ['', 'Poor', 'Could be better', 'Okay', 'Good', 'Excellent'];

function RatingCard({ requestId, existing, onChanged }: { requestId: number; existing: Feedback | null; onChanged: () => void }) {
  const { success, error } = useToast();
  const [rating, setRating] = useState(existing?.rating ?? 0);
  const [comment, setComment] = useState(existing?.comment ?? '');
  const [editing, setEditing] = useState(!existing);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!rating) return;
    setBusy(true);
    try {
      await post(`/requests/${requestId}/feedback`, { rating, comment: comment.trim() || undefined });
      success('Thanks for your feedback');
      setEditing(false);
      onChanged();
    } catch (e) { error(e); } finally { setBusy(false); }
  };

  return (
    <Card padding="md">
      <CardHeader title={editing ? 'How was your experience?' : 'Your rating'} subtitle={editing ? 'Your feedback helps crews and hospitals improve' : undefined} as="h3"
        action={!editing ? <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>Edit</Button> : undefined} />
      <fieldset disabled={!editing}>
        <legend className="sr-only">Rating out of 5</legend>
        <div className="flex items-center gap-1">
          {[1, 2, 3, 4, 5].map((n) => (
            <label key={n} className={cn('press flex h-11 w-11 cursor-pointer items-center justify-center rounded-full focus-within:ring-2 focus-within:ring-brand-500', !editing && 'cursor-default')}>
              <input type="radio" name="rating" value={n} checked={rating === n} onChange={() => setRating(n)} className="sr-only" aria-label={`${n} star${n > 1 ? 's' : ''} — ${RATING_WORDS[n]}`} />
              <Star size={30} aria-hidden className={cn('transition-colors duration-micro', n <= rating ? 'fill-warning text-warning' : 'text-line-strong')} />
            </label>
          ))}
          {rating > 0 && <span className="ml-2 text-sm font-semibold text-ink-700" aria-live="polite">{RATING_WORDS[rating]}</span>}
        </div>
      </fieldset>
      {editing ? (
        <div className="mt-3 space-y-3">
          <Textarea label="Comments (optional)" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500} showCount rows={2} placeholder="Anything we should know?" />
          <Button fullWidth onClick={() => void submit()} loading={busy} disabled={!rating}>Submit feedback</Button>
        </div>
      ) : existing?.comment ? (
        <p className="mt-2 text-sm text-ink-700">“{existing.comment}”</p>
      ) : null}
    </Card>
  );
}
