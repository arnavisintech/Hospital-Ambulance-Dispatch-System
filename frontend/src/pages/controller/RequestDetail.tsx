import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, Ambulance, BedDouble, Building2, Clock, ExternalLink, Gauge, HeartPulse, Hospital, MapPin, Phone,
  Radio, RefreshCw, Route, UserRound, X, XCircle,
} from 'lucide-react';
import {
  Avatar, Badge, Button, ButtonLink, ConfirmDialog, EmptyState, ErrorState, IconButton, Modal, SeverityBadge,
  Skeleton, StatusPill, Tabs, Textarea, Timeline, requestTimelineItems, tabPanelProps, useToast, type TimelineItem,
} from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { get, post } from '../../lib/api';
import { cn } from '../../lib/cn';
import { fmtClockTimer, fmtDistance, fmtEta, fmtPhone, fmtAge } from '../../lib/format';
import { haversineKm } from '../../lib/geo';
import { incidentMeta, requestStatusMeta, severityMeta, toneClasses } from '../../lib/status';
import type { Board, Candidate, HospitalBrief, RequestOut, Tracking } from '../../lib/types';
import { ageSeconds, isTerminal } from './board';

type DetailTab = 'dispatch' | 'hospital' | 'timeline';

const asCandidates = (x: unknown): Candidate[] => {
  if (Array.isArray(x)) return x as Candidate[];
  if (x && typeof x === 'object' && Array.isArray((x as { candidates?: unknown }).candidates)) return (x as { candidates: Candidate[] }).candidates;
  return [];
};

/** v1 backends have no `timeline`: synthesise one from the known timestamps. */
function fallbackTimeline(r: RequestOut): TimelineItem[] {
  const ev = [
    { status: 'received', at: r.created_at },
    r.dispatched_at ? { status: 'offered', at: r.dispatched_at } : null,
    r.accepted_at ? { status: 'accepted', at: r.accepted_at } : null,
  ].filter(Boolean) as { status: string; at: string }[];
  return requestTimelineItems(ev, r.status);
}

const CLOSE_REASONS = ['Patient handed over, crew offline', 'Duplicate request', 'Patient refused transport', 'Handled by another service'];

export interface RequestDetailProps {
  req: RequestOut;
  board: Board;
  escalated: boolean;
  now: number;
  onClose: () => void;
  onChanged: () => void;
  /** Hide the built-in header close button (phone drawer has its own). */
  hideClose?: boolean;
}

export function RequestDetail({ req, board, escalated, now, onClose, onChanged, hideClose }: RequestDetailProps) {
  const { success, error } = useToast();
  const live = !isTerminal(req.status);
  const canDispatch = live && !['arrived', 'transporting', 'on_scene'].includes(req.status);
  const [tab, setTab] = useState<DetailTab>(canDispatch ? 'dispatch' : 'timeline');
  const [assignTo, setAssignTo] = useState<Candidate | null>(null);
  const [destTo, setDestTo] = useState<HospitalBrief | null>(null);
  const [closing, setClosing] = useState(false);

  // Tracking gives crew contact + reserved bed; refresh on status change. Degrades silently on v1/403.
  const tracking = useAsync(() => get<Tracking>(`/requests/${req.id}/tracking`).catch(() => null), [req.id, req.status, req.ambulance?.id]);
  const cands = useAsync(async () => (canDispatch ? asCandidates(await get<unknown>(`/controller/requests/${req.id}/candidates`)) : []), [req.id, canDispatch, req.status]);

  const inc = incidentMeta(req.incident_type);
  const sev = severityMeta(req.severity);
  const IncIcon = inc.icon;
  const st = requestStatusMeta(req.status);
  const age = ageSeconds(req, now);
  const t = tracking.data;
  const crew = t?.crew ?? null;
  const amb = board.ambulances.find((a) => a.id === req.ambulance?.id);

  const hospitals = useMemo(() => board.hospitals
    .map((h) => ({ h, km: haversineKm([req.lat, req.lng], [h.lat, h.lng]) }))
    .sort((a, b) => a.km - b.km), [board.hospitals, req.lat, req.lng]);

  const timeline = req.timeline?.length || t?.timeline?.length
    ? requestTimelineItems(req.timeline?.length ? req.timeline : t?.timeline, req.status)
    : fallbackTimeline(req);

  const assign = async (c: Candidate) => {
    try {
      await post(`/controller/requests/${req.id}/assign`, { ambulance_id: c.ambulance_id });
      success(`${c.registration_number ?? `Unit ${c.ambulance_id}`} assigned to #${req.id}`, { title: 'Ambulance dispatched' });
      onChanged(); void cands.reload();
    } catch (e) { error(e, { title: "Couldn't assign" }); throw e; }
  };
  const setDestination = async (h: HospitalBrief) => {
    try {
      await post(`/controller/requests/${req.id}/destination`, { hospital_id: h.id });
      success(`Destination set to ${h.name}`, { title: 'Hospital updated' });
      onChanged(); void tracking.reload();
    } catch (e) { error(e, { title: "Couldn't change hospital" }); throw e; }
  };

  const tabs = [
    { value: 'dispatch' as const, label: 'Dispatch', icon: Ambulance, disabled: !canDispatch },
    { value: 'hospital' as const, label: 'Hospital', icon: Hospital, disabled: !live || req.status === 'arrived' },
    { value: 'timeline' as const, label: 'Timeline', icon: Clock },
  ];
  // If the status moves on (e.g. accepted -> on_scene) while on a now-disabled tab, fall back.
  const activeTab = tabs.find((x) => x.value === tab && !x.disabled) ? tab : 'timeline';

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-line px-4 pb-3 pt-4">
        <div className="flex items-start gap-3">
          <span className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-md', toneClasses(sev.tone).soft)} aria-hidden>
            <IncIcon size={22} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-bold text-ink-900">
              {inc.label} <span className="font-semibold text-ink-500 tabular-nums">#{req.id}</span>
            </h2>
            <p className="mt-0.5 flex items-center gap-1 truncate text-sm text-ink-500">
              <MapPin size={14} aria-hidden className="shrink-0" />
              <span className="truncate">{[req.zone_label, req.address].filter(Boolean).join(' · ') || `${req.lat.toFixed(4)}, ${req.lng.toFixed(4)}`}</span>
            </p>
          </div>
          {!hideClose && <IconButton label="Close details (Esc)" icon={X} size="sm" onClick={onClose} className="-mr-1 -mt-1" />}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {escalated ? <Badge tone="danger" icon={AlertTriangle}>Escalated</Badge> : <StatusPill status={req.status} />}
          <SeverityBadge severity={req.severity} showLevel />
          <Badge tone="neutral" icon={Clock}><span className="tabular-nums">{fmtClockTimer(age)}</span></Badge>
          {req.channel === 'ivr' && <Badge tone="neutral" icon={Phone}>IVR</Badge>}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {escalated && (
          <div className="mx-4 mt-4 flex gap-3 rounded-lg border border-brand-200 bg-brand-50 p-3" role="alert">
            <AlertTriangle size={20} className="mt-0.5 shrink-0 text-brand-600" aria-hidden />
            <div className="text-sm">
              <p className="font-bold text-brand-700">Needs manual dispatch</p>
              <p className="text-brand-700/90">
                Auto-dispatch couldn't secure a unit{req.attempts?.length ? ` after ${req.attempts.length} offer${req.attempts.length > 1 ? 's' : ''}` : ''}. Pick an ambulance below.
              </p>
            </div>
          </div>
        )}

        {/* Facts */}
        <dl className="grid grid-cols-2 gap-2 px-4 pt-4">
          <Fact icon={Ambulance} label="Unit">
            {req.ambulance ? <>{req.ambulance.registration_number}{req.ambulance.kind ? <span className="font-medium text-ink-500"> · {req.ambulance.kind}</span> : null}</> : <span className="text-ink-500">Not assigned</span>}
          </Fact>
          <Fact icon={Route} label={st.progress >= 2 ? 'ETA to hospital' : 'ETA to patient'}>
            <span className="tabular-nums">{req.ambulance ? fmtEta(req.eta_seconds) : '--'}</span>
            {t?.route?.distance_km != null && <span className="font-medium text-ink-500"> · {fmtDistance(t.route.distance_km)}</span>}
          </Fact>
          <Fact icon={Hospital} label="Destination">
            {req.destination_hospital ? req.destination_hospital.name : <span className="text-ink-500">Not set</span>}
            {t?.hospital?.reserved && <span className="mt-1 block"><Badge tone="teal" icon={BedDouble}>{t.hospital.reserved === 'icu' ? 'ICU reserved' : 'Bed reserved'}</Badge></span>}
          </Fact>
          <Fact icon={Gauge} label="Matched in">
            <span className="tabular-nums">{req.match_duration_ms != null ? `${req.match_duration_ms} ms` : '--'}</span>
          </Fact>
        </dl>

        {/* Contacts */}
        <div className="space-y-2 px-4 pt-3">
          <Contact
            title="Caller"
            name={req.caller_name || (req.channel === 'ivr' ? 'Phone caller' : 'App user')}
            phone={req.caller_phone}
            icon={UserRound}
          />
          {req.ambulance && (
            tracking.loading && !t ? <Skeleton className="h-14 w-full" /> : (
              <Contact title="Crew" name={crew?.name ?? amb?.crew_name ?? 'Crew'} initials={crew?.initials} phone={crew?.phone} icon={Radio} />
            )
          )}
          {req.notes && <p className="rounded-md bg-canvas px-3 py-2 text-sm text-ink-700"><span className="font-semibold">Notes: </span>{req.notes}</p>}
        </div>

        {/* Tabs */}
        <div className="sticky top-0 z-[1] mt-4 bg-surface px-2">
          <Tabs id={`req-${req.id}`} items={tabs} value={activeTab} onChange={setTab} fullWidth ariaLabel="Request actions" />
        </div>
        <div {...tabPanelProps(`req-${req.id}`, activeTab)} className="px-4 py-4 focus-visible:outline-none">
          {activeTab === 'dispatch' && (
            <section aria-label="Candidate ambulances">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold text-ink-900">Nearest units by road ETA</p>
                <IconButton label="Refresh candidates" icon={RefreshCw} size="sm" onClick={() => void cands.reload()} loading={cands.loading && !!cands.data} />
              </div>
              {cands.loading && !cands.data ? (
                <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
              ) : cands.error ? (
                <ErrorState compact message={cands.error} onRetry={() => void cands.reload()} />
              ) : !cands.data?.length ? (
                <EmptyState compact icon={Ambulance} title="No units available right now" description="Every ambulance is busy or offline. Check the Fleet tab or wait for a unit to free up." />
              ) : (
                <ol className="space-y-2">
                  {cands.data.map((c, i) => {
                    const current = req.ambulance?.id === c.ambulance_id;
                    return (
                      <li key={c.ambulance_id ?? i} className={cn('flex items-center gap-3 rounded-lg border p-3', current ? 'border-info/30 bg-info-bg' : 'border-line/80 bg-surface')}>
                        <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold tabular-nums', i === 0 ? 'bg-success text-white' : 'bg-canvas text-ink-700')}>
                          {c.rank ?? i + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-bold text-ink-900">
                            {c.registration_number ?? `Unit ${c.ambulance_id}`}
                            {c.kind && <span className="ml-1.5 rounded-sm bg-canvas px-1 py-px text-[11px] font-semibold text-ink-700">{String(c.kind)}</span>}
                          </p>
                          <p className="truncate text-xs font-medium text-ink-500">
                            {[c.station_name, c.distance_km != null ? fmtDistance(Number(c.distance_km)) : null].filter(Boolean).join(' · ') || '—'}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-sm font-extrabold tabular-nums text-ink-900">{fmtEta(c.eta_seconds)}</p>
                          {current ? <p className="text-xs font-semibold text-info-fg">Assigned</p> : (
                            <Button size="sm" variant={i === 0 ? 'primary' : 'secondary'} className="mt-1 h-8" onClick={() => setAssignTo(c)}>Assign</Button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>
          )}

          {activeTab === 'hospital' && (
            <section aria-label="Choose destination hospital">
              <p className="mb-2 text-sm font-semibold text-ink-900">Hospitals by distance from patient</p>
              <ul className="space-y-2">
                {hospitals.map(({ h, km }) => {
                  const isDest = req.destination_hospital?.id === h.id;
                  const needIcu = req.severity >= 4;
                  const full = needIcu ? (h.available_icu ?? 0) <= 0 : (h.available_beds ?? 0) <= 0;
                  return (
                    <li key={h.id} className={cn('rounded-lg border p-3', isDest ? 'border-teal/30 bg-teal-bg' : 'border-line/80 bg-surface')}>
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-bold text-ink-900">{h.name}</p>
                          <p className="text-xs font-medium text-ink-500 tabular-nums">{fmtDistance(km)} away</p>
                        </div>
                        {isDest ? <Badge tone="teal" icon={Hospital}>Destination</Badge> : (
                          <Button size="sm" variant="secondary" className="h-8" onClick={() => setDestTo(h)}>Select</Button>
                        )}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <CapChip label="Beds" n={h.available_beds} />
                        <CapChip label="ICU" n={h.available_icu} emphasise={needIcu} />
                        {h.stale && <Badge tone="warning" icon={AlertTriangle}>Updated {fmtAge(h.capacity_age_min)}</Badge>}
                        {full && !h.stale && <Badge tone="danger">{needIcu ? 'No ICU free' : 'Full'}</Badge>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {activeTab === 'timeline' && (
            <section aria-label="Status timeline">
              <Timeline items={timeline} dense />
              {!!req.attempts?.length && (
                <div className="mt-5">
                  <p className="mb-2 text-sm font-semibold text-ink-900">Dispatch attempts</p>
                  <ul className="divide-y divide-line rounded-lg border border-line/80">
                    {req.attempts.map((a, i) => (
                      <li key={i} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                        <span className="font-semibold text-ink-900">#{a.rank} {a.registration_number}</span>
                        <span className="flex items-center gap-2 text-xs text-ink-500">
                          <span className="tabular-nums">{fmtEta(a.eta_seconds)}</span>
                          <StatusPill status={a.status} kind="generic" />
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2 border-t border-line px-4 py-3">
        <ButtonLink to={`/track/${req.id}`} variant="secondary" size="sm" icon={ExternalLink} className="flex-1">Live tracking</ButtonLink>
        {live && <Button variant="danger" size="sm" icon={XCircle} className="flex-1" onClick={() => setClosing(true)}>Close trip</Button>}
      </div>

      <ConfirmDialog
        open={!!assignTo}
        onClose={() => setAssignTo(null)}
        onConfirm={() => assignTo ? assign(assignTo) : undefined}
        icon={Ambulance}
        title={`Assign ${assignTo?.registration_number ?? 'unit'}?`}
        description={
          <>
            ETA <b className="tabular-nums">{fmtEta(assignTo?.eta_seconds)}</b>{assignTo?.station_name ? ` from ${assignTo.station_name}` : ''}.
            {req.ambulance && req.ambulance.id !== assignTo?.ambulance_id ? ` This replaces ${req.ambulance.registration_number}.` : ''} The override is recorded in the audit log.
          </>
        }
        confirmLabel="Assign & dispatch"
      />
      <ConfirmDialog
        open={!!destTo}
        onClose={() => setDestTo(null)}
        onConfirm={() => destTo ? setDestination(destTo) : undefined}
        icon={Building2}
        title={`Send patient to ${destTo?.name ?? ''}?`}
        description={destTo ? <>
          {destTo.available_beds ?? '?'} beds and {destTo.available_icu ?? '?'} ICU free{destTo.stale ? ' (capacity may be outdated)' : ''}. A bed is reserved and the crew and hospital are notified.
        </> : undefined}
        confirmLabel="Set destination"
      />
      <CloseTripDialog open={closing} onClose={() => setClosing(false)} req={req} onDone={onChanged} />
    </div>
  );
}

function Fact({ icon: Icon, label, children }: { icon: typeof HeartPulse; label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md bg-canvas px-3 py-2.5">
      <dt className="flex items-center gap-1.5 text-xs font-semibold text-ink-500"><Icon size={13} aria-hidden />{label}</dt>
      <dd className="mt-0.5 text-sm font-bold text-ink-900">{children}</dd>
    </div>
  );
}

function CapChip({ label, n, emphasise }: { label: string; n?: number | null; emphasise?: boolean }) {
  const tone = n == null ? 'muted' : n <= 0 ? 'danger' : n <= 3 ? 'warning' : 'success';
  return (
    <Badge tone={tone} className={cn(emphasise && 'ring-1 ring-inset ring-current/20')}>
      <span className="tabular-nums">{n ?? '?'}</span>&nbsp;{label}
    </Badge>
  );
}

function Contact({ title, name, phone, initials, icon: Icon }: { title: string; name: string; phone?: string | null; initials?: string; icon: typeof Phone }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line/80 px-3 py-2.5">
      <Avatar name={name} initials={initials} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1 text-xs font-semibold text-ink-500"><Icon size={12} aria-hidden />{title}</p>
        <p className="truncate text-sm font-bold text-ink-900">{name}</p>
      </div>
      {phone ? (
        <a
          href={`tel:${phone}`}
          className="press inline-flex h-9 items-center gap-1.5 rounded-full bg-success-bg px-3 text-sm font-semibold text-success-fg hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          aria-label={`Call ${title.toLowerCase()} ${name} on ${fmtPhone(phone)}`}
        >
          <Phone size={14} aria-hidden /><span className="tabular-nums">{fmtPhone(phone)}</span>
        </a>
      ) : <span className="text-xs text-ink-500">No phone</span>}
    </div>
  );
}

function CloseTripDialog({ open, onClose, req, onDone }: { open: boolean; onClose: () => void; req: RequestOut; onDone: () => void }) {
  const { success, error } = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  useEffect(() => { if (open) { setReason(''); setTouched(false); } }, [open]);
  const submit = async () => {
    setTouched(true);
    if (!reason.trim()) return;
    setBusy(true);
    try {
      await post(`/controller/requests/${req.id}/close`, { reason: reason.trim() });
      success(`Request #${req.id} closed`, { title: 'Trip closed manually' });
      onClose(); onDone();
    } catch (e) { error(e, { title: "Couldn't close trip" }); } finally { setBusy(false); }
  };
  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      size="md"
      title={`Close request #${req.id} manually?`}
      description="Use this when the trip can't be finished from the crew app. The ambulance is freed and the reason is written to the audit log."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Keep open</Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy}>Close trip</Button>
        </>
      }
    >
      <div className="mb-3 flex flex-wrap gap-2">
        {CLOSE_REASONS.map((r) => (
          <button
            key={r} type="button" onClick={() => setReason(r)}
            className={cn('press h-8 rounded-full border px-3 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
              reason === r ? 'border-ink-900 bg-ink-900 text-white' : 'border-line-strong bg-surface text-ink-700 hover:border-ink-400')}
          >{r}</button>
        ))}
      </div>
      <Textarea
        label="Reason" required maxLength={255} showCount data-autofocus
        value={reason} onChange={(e) => setReason(e.target.value)}
        error={touched && !reason.trim() ? 'A reason is required for the audit trail.' : undefined}
        placeholder="What happened?"
      />
    </Modal>
  );
}
