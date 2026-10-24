import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  AlertTriangle, Ambulance, BedDouble, Building2, Check, CheckCheck, ClipboardList, Flag, HeartPulse, History, MapPin,
  Phone, RotateCcw, Save, Stethoscope, Users, Volume2, VolumeX,
} from 'lucide-react';
import { useConsolePage } from '../../components/layout';
import {
  Avatar, Badge, Button, Card, CardHeader, EmptyState, ErrorState, IconButton, IncidentBadge, SeverityBadge, Skeleton,
  SkeletonCard, SlideButton, StatusPill, Stepper, useToast,
} from '../../components/ui';
import { useAuth } from '../../context/AuthContext';
import { useReportConnection } from '../../context/ConnectionContext';
import { useAsync, type AsyncState } from '../../hooks/useAsync';
import { useSocket } from '../../hooks/useSocket';
import { ApiError, get, post, put } from '../../lib/api';
import { cn } from '../../lib/cn';
import { ageMin, fmtAge, fmtClock, fmtClockTimer, fmtDuration, fmtPhone, fmtRelative } from '../../lib/format';
import { humanize, incidentMeta, toneClasses, type Tone } from '../../lib/status';
import type { HospitalBrief, RequestOut, WsMessage } from '../../lib/types';
import { playChime, useNow, useSoundPref } from '../controller/live';
import { FleetPanel } from './FleetPanel';
import { PaymentsDue } from './PaymentsDue';
import {
  capacityDiff, etaRemaining, normalizeIncomingList, occupancy, occupancyTone, sortIncoming, specialistsMap,
  type CapacityDraft, type Incoming,
} from './capacity';

interface HandoverRow {
  request: RequestOut; trip_id?: number; handover_time?: string | null; handover_duration_s?: number | null;
  handover_confirmed_by?: { id: number; name: string } | null; closed_manually?: boolean;
  ambulance?: { registration_number: string } | null; crew?: { name: string } | null; response_time_seconds?: number | null;
}

const STALE_MIN = 30;

export default function Hospital() {
  const { user } = useAuth();
  const hid = user?.hospital_id ?? null;
  useConsolePage({ title: 'Hospital desk' });
  if (!hid) {
    return <EmptyState icon={Building2} title="Your account isn't linked to a hospital" description="Ask an administrator to assign you to your hospital, then sign in again." />;
  }
  return <HospitalDesk hid={hid} />;
}

interface EtaSnap { eta: number | null; at: number }

function HospitalDesk({ hid }: { hid: number }) {
  const { success, error, info } = useToast();
  const now = useNow(1000);
  const [soundOn, toggleSound] = useSoundPref('hads.hospital.sound');

  /* ------------------------------------------------------------------ data */
  const hosp = useAsync(() => get<HospitalBrief>(`/hospitals/${hid}`), [hid], 60000);
  // ETA snapshots: eta + time received, so the countdown ticks locally between updates. Stamped here and in the
  // live handler (never during render); an unchanged ETA keeps its original stamp so the countdown continues.
  const [snaps, setSnaps] = useState<Map<number, EtaSnap>>(() => new Map());
  const incoming = useAsync(async () => {
    const list = normalizeIncomingList(await get<unknown>(`/hospitals/${hid}/incoming`));
    const t = Date.now();
    setSnaps((prev) => {
      const next = new Map(prev);
      list.forEach((i) => {
        const s = next.get(i.request.id);
        if (!s || s.eta !== i.eta_seconds) next.set(i.request.id, { eta: i.eta_seconds, at: t });
      });
      return next;
    });
    return list;
  }, [hid], 10000);
  const handovers = useAsync(async () => {
    try { return await get<HandoverRow[]>(`/hospitals/${hid}/handovers`, { limit: 10 }); }
    catch (e) { if (e instanceof ApiError && (e.status === 404 || e.status === 405)) return null; throw e; } // v1: not available
  }, [hid], 60000);

  const known = useRef<Set<number> | null>(null);
  const [fresh, setFresh] = useState<Set<number>>(new Set());

  useEffect(() => {
    const list = incoming.data;
    if (!list) return;
    const ids = new Set(list.map((i) => i.request.id));
    if (known.current) {
      const added = list.filter((i) => !known.current!.has(i.request.id));
      if (added.length) {
        added.forEach((i) => info(`${incidentMeta(i.request.incident_type).label}${i.ambulance ? ` · ${i.ambulance.registration_number}` : ''}`, { title: `Incoming patient #${i.request.id}` }));
        if (soundOn) playChime();
        setFresh((f) => new Set([...f, ...added.map((i) => i.request.id)]));
        setTimeout(() => setFresh((f) => { const n = new Set(f); added.forEach((i) => n.delete(i.request.id)); return n; }), 12000);
      }
    }
    known.current = ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming.data]);

  /* ------------------------------------------------------------------ live */
  const reloadIncoming = incoming.reload, reloadHandovers = handovers.reload;
  const onMsg = useCallback((m: WsMessage) => {
    const d = (m.data ?? {}) as Record<string, unknown>;
    if (m.type === 'ambulance.location' && typeof d.request_id === 'number' && typeof d.eta_seconds === 'number') {
      const snap = { eta: d.eta_seconds, at: Date.now() };
      setSnaps((prev) => new Map(prev).set(d.request_id as number, snap));
      return;
    }
    if (m.type === 'trip.closed') { void reloadIncoming(); void reloadHandovers(); return; }
    if (m.type === 'hospital.incoming' || m.type === 'request.status' || m.type === 'destination.confirmed') void reloadIncoming();
  }, [reloadIncoming, reloadHandovers]);
  const { connected } = useSocket([`hospital:${hid}`], onMsg);
  useReportConnection(connected);

  const list = useMemo(() => sortIncoming(incoming.data ?? []), [incoming.data]);
  const h = hosp.data;
  const updatedMin = h ? ageMin(h.capacity_updated_at, now) : null;
  const stale = !!h && (h.stale || (updatedMin !== null && updatedMin > STALE_MIN));
  const specs = h ? specialistsMap(h.specialists) : {};
  const specTotal = Object.values(specs).reduce((s, v) => s + v, 0);

  /* ------------------------------------------------------------------ actions */
  const acknowledge = async (i: Incoming) => {
    incoming.setData((l) => l?.map((x) => x.request.id === i.request.id ? { ...x, acknowledged: true } : x) ?? l);
    try {
      await post(`/hospitals/${hid}/incoming/${i.request.id}/acknowledge`);
      success(`Crew of ${i.ambulance?.registration_number ?? `#${i.request.id}`} notified`, { title: 'Arrival acknowledged' });
    } catch (e) {
      incoming.setData((l) => l?.map((x) => x.request.id === i.request.id ? { ...x, acknowledged: false } : x) ?? l);
      error(e, { title: "Couldn't acknowledge" });
    }
  };
  const handover = async (i: Incoming) => {
    try {
      await post(`/hospitals/${hid}/handover/${i.request.id}`);
      success(`Patient #${i.request.id} received — ambulance released`, { title: 'Handover confirmed' });
      incoming.setData((l) => l?.filter((x) => x.request.id !== i.request.id) ?? l);
      void handovers.reload(); void hosp.reload();
    } catch (e) { error(e, { title: "Couldn't confirm handover" }); throw e; }
  };

  if (hosp.loading && !h) {
    return <div className="space-y-4"><Skeleton className="h-28 w-full" /><div className="grid gap-4 lg:grid-cols-[1fr_380px]"><SkeletonCard /><SkeletonCard /></div></div>;
  }
  if (!h) return <ErrorState title="Couldn't load your hospital" message={hosp.error ?? undefined} onRetry={() => void hosp.reload()} />;

  return (
    <div className="space-y-5">
      {/* Overview header */}
      <Card padding="none" className="overflow-hidden">
        <div className="flex flex-wrap items-start gap-4 p-4 sm:p-5">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-teal-bg text-xl font-extrabold text-teal-fg" aria-hidden>H</span>
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-bold text-ink-900 sm:text-2xl">{h.name}</h2>
            {h.address && <p className="mt-0.5 flex items-center gap-1 text-sm text-ink-500"><MapPin size={14} aria-hidden />{h.address}</p>}
          </div>
          <div className="order-last flex w-full items-center gap-2 sm:order-none sm:w-auto">
            {stale ? (
              <Badge tone="warning" size="md" icon={AlertTriangle} title="Dispatch deprioritises hospitals with outdated capacity">
                Updated {fmtAge(updatedMin)} — please confirm
              </Badge>
            ) : (
              <Badge tone="success" size="md" dot>Updated {fmtAge(updatedMin)}</Badge>
            )}
            <span className="flex-1 sm:hidden" />
            <IconButton label={soundOn ? 'Mute new-patient sound' : 'Unmute new-patient sound'} icon={soundOn ? Volume2 : VolumeX} variant="secondary" size="sm" onClick={toggleSound} aria-pressed={soundOn} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-px border-t border-line/70 bg-line/70 lg:grid-cols-4">
          <Gauge label="General beds" icon={BedDouble} available={h.available_beds} total={h.total_beds} />
          <Gauge label="ICU beds" icon={HeartPulse} available={h.available_icu} total={h.total_icu} />
          <Metric label="Incoming now" icon={Ambulance} value={list.length} sub={list.filter((i) => i.request.status === 'arrived').length ? `${list.filter((i) => i.request.status === 'arrived').length} at the door` : 'on the way'} tone={list.length ? 'info' : 'neutral'} />
          <Metric label="Specialists on duty" icon={Stethoscope} value={specTotal} sub={`${Object.keys(specs).length} specialt${Object.keys(specs).length === 1 ? 'y' : 'ies'}`} tone="violet" />
        </div>
      </Card>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        {/* Incoming */}
        <section aria-labelledby="inc-h" className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 id="inc-h" className="flex items-center gap-2 text-lg font-bold text-ink-900">
              Incoming patients
              {list.length > 0 && <span className="rounded-full bg-ink-900 px-2 text-sm leading-6 text-white tabular-nums">{list.length}</span>}
            </h2>
            <span className="text-xs text-ink-500">Sorted by arrival</span>
          </div>
          {incoming.loading && !incoming.data ? (
            <div className="space-y-3"><SkeletonCard /><SkeletonCard /></div>
          ) : incoming.error && !incoming.data ? (
            <Card><ErrorState compact message={incoming.error} onRetry={() => void incoming.reload()} /></Card>
          ) : list.length === 0 ? (
            <Card><EmptyState icon={ClipboardList} title="No patients on the way" description="New arrivals routed to your hospital will appear here with a live ETA and a chime." /></Card>
          ) : (
            <ul className="space-y-3" aria-live="polite">
              <AnimatePresence initial={false}>
                {list.map((i) => {
                  const s = snaps.get(i.request.id);
                  const remaining = s ? etaRemaining(s.eta, s.at, now) : i.eta_seconds;
                  return (
                    <IncomingCard key={i.request.id} item={i} remaining={remaining} now={now} fresh={fresh.has(i.request.id)}
                      onAck={() => void acknowledge(i)} onHandover={() => handover(i)} />
                  );
                })}
              </AnimatePresence>
            </ul>
          )}
        </section>

        <div className="space-y-5">
          <CapacityEditor
            h={h} specs={specs} stale={stale}
            onSaved={(next) => hosp.setData(next)}
            onRevert={(prev) => hosp.setData(prev)}
          />
          <FleetPanel hid={hid} />
          <HandoverList state={handovers} now={now} />
          <PaymentsDue />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ overview */

function Gauge({ label, icon: Icon, available, total }: { label: string; icon: typeof BedDouble; available?: number; total?: number }) {
  const occ = occupancy(available, total);
  const tone = occupancyTone(available, total);
  const color = toneClasses(tone).css;
  const r = 26, c = 2 * Math.PI * r;
  return (
    <div className="flex flex-col items-start gap-3 bg-surface p-3 sm:flex-row sm:items-center sm:gap-4 sm:p-5">
      <svg width="68" height="68" viewBox="0 0 68 68" className="shrink-0 -rotate-90" role="img" aria-label={`${label}: ${available ?? 'unknown'} of ${total ?? 'unknown'} free`}>
        <circle cx="34" cy="34" r={r} fill="none" stroke="rgb(var(--line-soft))" strokeWidth="8" />
        <motion.circle
          cx="34" cy="34" r={r} fill="none" stroke={color} strokeWidth="8" strokeLinecap="round"
          strokeDasharray={c} initial={false} animate={{ strokeDashoffset: c * (1 - (occ ?? 0)) }} transition={{ duration: 0.5, ease: 'easeOut' }}
        />
      </svg>
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-sm font-medium text-ink-500"><Icon size={14} aria-hidden />{label}</p>
        <p className="mt-0.5 text-3xl font-extrabold leading-none tracking-tight text-ink-900 tabular-nums">
          {available ?? '--'}<span className="text-base font-semibold text-ink-500"> / {total ?? '--'}</span>
        </p>
        <p className={cn('mt-1 text-xs font-semibold', toneClasses(tone).text)}>
          {occ === null ? 'Total unknown' : `${Math.round(occ * 100)}% occupied`}
        </p>
      </div>
    </div>
  );
}

function Metric({ label, icon: Icon, value, sub, tone }: { label: string; icon: typeof BedDouble; value: ReactNode; sub: string; tone: Tone }) {
  return (
    <div className="flex flex-col items-start gap-3 bg-surface p-3 sm:flex-row sm:items-center sm:gap-4 sm:p-5">
      <span className={cn('flex h-[68px] w-[68px] shrink-0 items-center justify-center rounded-full', tone === 'neutral' ? 'bg-canvas text-ink-500' : toneClasses(tone).soft)} aria-hidden>
        <Icon size={26} />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink-500">{label}</p>
        <p className="mt-0.5 text-3xl font-extrabold leading-none tracking-tight text-ink-900 tabular-nums">{value}</p>
        <p className="mt-1 truncate text-xs font-medium text-ink-500">{sub}</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ incoming */

function IncomingCard({ item, remaining, now, fresh, onAck, onHandover }: {
  item: Incoming; remaining: number | null; now: number; fresh: boolean; onAck: () => void; onHandover: () => Promise<unknown>;
}) {
  const reduce = useReducedMotion();
  const r = item.request;
  const arrived = r.status === 'arrived';
  const soon = !arrived && remaining !== null && remaining < 180;
  return (
    <motion.li
      layout={!reduce}
      initial={{ opacity: 0, y: reduce ? 0 : 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: reduce ? 1 : 0.98, transition: { duration: 0.15 } }}
      className={cn('overflow-hidden rounded-lg border bg-surface shadow-card transition-shadow',
        arrived ? 'border-teal/40' : fresh ? 'border-info/40 ring-4 ring-info/10' : 'border-line/70')}
    >
      <div className="flex flex-col sm:flex-row">
        {/* ETA block */}
        <div className={cn('flex shrink-0 items-center gap-3 px-4 py-3 sm:w-40 sm:flex-col sm:items-start sm:justify-center sm:gap-0 sm:py-4',
          arrived ? 'bg-teal-bg' : soon ? 'bg-orange-bg' : 'bg-canvas')}>
          {arrived ? (
            <>
              <Flag size={22} className="text-teal-fg sm:mb-1" aria-hidden />
              <p className="text-2xl font-extrabold text-teal-fg">At the door</p>
            </>
          ) : (
            <>
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">ETA</p>
              <p className={cn('text-4xl font-extrabold leading-tight tracking-tight tabular-nums', soon ? 'text-orange-fg' : 'text-ink-900')} aria-label={`Arriving in ${Math.ceil((remaining ?? 0) / 60)} minutes`}>
                {remaining === null ? '--:--' : fmtClockTimer(remaining)}
              </p>
              <p className="text-xs font-medium text-ink-500">{remaining === null ? 'Calculating' : `≈ ${fmtClock(now + remaining * 1000)}`}</p>
            </>
          )}
        </div>

        <div className="min-w-0 flex-1 p-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <IncidentBadge type={r.incident_type} size="md" />
            <SeverityBadge severity={r.severity} size="md" showLevel />
            {item.reserved && <Badge tone="teal" size="md" icon={item.reserved === 'icu' ? HeartPulse : BedDouble}>{item.reserved === 'icu' ? 'ICU reserved' : 'Bed reserved'}</Badge>}
            <StatusPill status={r.status} size="md" className="ml-auto" />
          </div>
          <p className="mt-2 text-sm text-ink-500">
            Patient <span className="font-semibold text-ink-900 tabular-nums">#{r.id}</span>
            {r.zone_label ? <> · from {r.zone_label}</> : null}
          </p>
          {r.notes && <p className="mt-1 rounded-md bg-canvas px-2.5 py-1.5 text-sm text-ink-700">{r.notes}</p>}

          <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-line/70 pt-3">
            <span className="flex items-center gap-2 text-sm font-semibold text-ink-900">
              <span className="flex h-8 w-8 items-center justify-center rounded-md bg-canvas text-ink-700" aria-hidden><Ambulance size={16} /></span>
              {item.ambulance?.registration_number ?? 'Unit pending'}
              {item.ambulance?.kind && <span className="rounded-sm bg-canvas px-1 text-[11px] font-semibold text-ink-700">{item.ambulance.kind}</span>}
            </span>
            {item.crew && (
              <span className="flex min-w-0 items-center gap-2 text-sm text-ink-700">
                <Avatar name={item.crew.name} initials={item.crew.initials} size="xs" />
                <span className="truncate">{item.crew.name}</span>
              </span>
            )}
            {item.crew?.phone && (
              <a href={`tel:${item.crew.phone}`} aria-label={`Call crew ${item.crew.name} on ${fmtPhone(item.crew.phone)}`}
                className="press ml-auto inline-flex h-9 items-center gap-1.5 rounded-full bg-success-bg px-3 text-sm font-semibold text-success-fg hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
                <Phone size={14} aria-hidden />Call crew
              </a>
            )}
          </div>

          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <Button
              variant={item.acknowledged ? 'ghost' : 'secondary'} size="md" icon={item.acknowledged ? Check : CheckCheck}
              disabled={item.acknowledged} onClick={onAck} className={cn(item.acknowledged && 'text-success-fg disabled:opacity-100')}
            >
              {item.acknowledged ? 'Acknowledged' : 'Acknowledge'}
            </Button>
            {arrived && (
              <SlideButton className="flex-1" label="Slide to confirm handover" confirmedLabel="Handover confirmed" tone="teal" onConfirm={onHandover} />
            )}
          </div>
        </div>
      </div>
    </motion.li>
  );
}

/* ------------------------------------------------------------------ capacity editor */

function CapacityEditor({ h, specs, stale, onSaved, onRevert }: {
  h: HospitalBrief; specs: Record<string, number>; stale: boolean; onSaved: (h: HospitalBrief) => void; onRevert: (h: HospitalBrief) => void;
}) {
  const { success, error } = useToast();
  const base: CapacityDraft = useMemo(() => ({ beds: h.available_beds ?? 0, icu: h.available_icu ?? 0, specialists: specs }), [h.available_beds, h.available_icu, specs]);
  const [draft, setDraft] = useState<CapacityDraft>(base);
  const [busy, setBusy] = useState(false);
  const changes = capacityDiff(base, draft, humanize);
  const dirty = changes.length > 0;
  const baseKey = JSON.stringify(base);
  // Server values changed (another staff member, poll) while not saving → follow them (adjusted during render).
  const [lastBase, setLastBase] = useState(baseKey);
  if (lastBase !== baseKey) {
    setLastBase(baseKey);
    if (!busy) setDraft(base);
  }

  const save = async () => {
    const prev = h;
    const optimistic: HospitalBrief = { ...h, available_beds: draft.beds, available_icu: draft.icu, specialists: draft.specialists as unknown as HospitalBrief['specialists'], capacity_updated_at: new Date().toISOString(), stale: false };
    setBusy(true);
    setLastBase(JSON.stringify({ beds: draft.beds, icu: draft.icu, specialists: draft.specialists }));
    onSaved(optimistic);
    try {
      const out = await put<HospitalBrief>(`/hospitals/${h.id}/capacity`, { available_beds: draft.beds, available_icu: draft.icu, specialists: draft.specialists });
      if (out && typeof out === 'object' && 'id' in out) onSaved(out);
      success(changes.join(' · '), { title: 'Capacity updated' });
    } catch (e) {
      onRevert(prev);
      error(e, { title: "Couldn't save capacity — previous values restored" });
    } finally { setBusy(false); }
  };
  // "Still accurate" confirmation re-saves the same values to refresh the timestamp.
  const confirmCurrent = async () => {
    setBusy(true);
    try {
      const out = await put<HospitalBrief>(`/hospitals/${h.id}/capacity`, { available_beds: base.beds, available_icu: base.icu, specialists: base.specialists });
      if (out && typeof out === 'object' && 'id' in out) onSaved(out);
      success('Capacity confirmed as current');
    } catch (e) { error(e); } finally { setBusy(false); }
  };

  const specKeys = Object.keys(draft.specialists);
  return (
    <Card as="section" aria-labelledby="cap-h">
      <CardHeader as="h2" title={<span id="cap-h">Update capacity</span>} subtitle="Dispatch uses these numbers to route patients." icon={BedDouble} />
      {stale && (
        <div className="mb-3 flex gap-2 rounded-md bg-warning-bg px-3 py-2 text-sm text-warning-fg" role="status">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
          <p>These numbers look outdated, so dispatch treats your capacity as unknown. Update them or confirm they're still accurate.</p>
        </div>
      )}
      <div className="grid grid-cols-1 gap-2">
        <StepTile><Stepper label="Free general beds" helper={`of ${h.total_beds ?? '?'} total`} value={draft.beds} max={h.total_beds ?? 9999} onChange={(v) => setDraft({ ...draft, beds: v })} disabled={busy} /></StepTile>
        <StepTile><Stepper label="Free ICU beds" helper={`of ${h.total_icu ?? '?'} total`} value={draft.icu} max={h.total_icu ?? 9999} onChange={(v) => setDraft({ ...draft, icu: v })} disabled={busy} /></StepTile>
      </div>
      {specKeys.length > 0 && (
        <>
          <p className="mb-2 mt-4 flex items-center gap-1.5 text-sm font-semibold text-ink-700"><Users size={14} aria-hidden />Specialists on duty</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-1">
            {specKeys.map((k) => (
              <StepTile key={k}>
                <Stepper label={humanize(k)} value={draft.specialists[k]} max={99} onChange={(v) => setDraft({ ...draft, specialists: { ...draft.specialists, [k]: v } })} disabled={busy} />
              </StepTile>
            ))}
          </div>
        </>
      )}
      <AnimatePresence initial={false}>
        {dirty && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="mt-4 rounded-md bg-info-bg px-3 py-2 text-sm text-info-fg" aria-live="polite">
              <p className="font-semibold">Unsaved changes</p>
              <p className="tabular-nums">{changes.join(' · ')}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="mt-4 flex gap-2">
        {dirty ? (
          <>
            <Button variant="secondary" icon={RotateCcw} onClick={() => setDraft(base)} disabled={busy}>Reset</Button>
            <Button icon={Save} fullWidth onClick={() => void save()} loading={busy}>Save changes</Button>
          </>
        ) : (
          <Button variant="secondary" icon={Check} fullWidth onClick={() => void confirmCurrent()} loading={busy}>Numbers are still accurate</Button>
        )}
      </div>
      <p className="mt-2 text-center text-xs text-ink-500">Every update is recorded in the audit log with your name.</p>
    </Card>
  );
}

function StepTile({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-line/80 bg-canvas/60 px-3 py-2">{children}</div>;
}

/* ------------------------------------------------------------------ handovers */

function HandoverList({ state, now }: { state: AsyncState<HandoverRow[] | null>; now: number }) {
  if (state.data === null && !state.loading && !state.error) return null; // endpoint not available (v1 backend)
  return (
    <Card as="section" aria-labelledby="ho-h">
      <CardHeader as="h2" title={<span id="ho-h">Recent handovers</span>} icon={History} />
      {state.loading && !state.data ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : state.error && !state.data ? (
        <ErrorState compact message={state.error} onRetry={() => void state.reload()} />
      ) : !state.data?.length ? (
        <EmptyState compact icon={History} title="No handovers yet today" />
      ) : (
        <ul className="divide-y divide-line/70">
          {state.data.map((x) => {
            const Icon = incidentMeta(x.request.incident_type).icon;
            return (
              <li key={x.trip_id ?? x.request.id} className="flex items-center gap-3 py-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-success-bg text-success-fg" aria-hidden><Icon size={16} /></span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-ink-900">
                    #{x.request.id} · {incidentMeta(x.request.incident_type).short}
                    {x.closed_manually && <span className="ml-1.5 text-xs font-medium text-warning-fg">closed manually</span>}
                  </p>
                  <p className="truncate text-xs text-ink-500">
                    {[x.ambulance?.registration_number, x.handover_confirmed_by?.name ? `by ${x.handover_confirmed_by.name}` : null].filter(Boolean).join(' · ') || '—'}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-xs font-semibold text-ink-700">{fmtRelative(x.handover_time, now)}</p>
                  {x.handover_duration_s != null && <p className="text-xs text-ink-500 tabular-nums">{fmtDuration(x.handover_duration_s)} at door</p>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
