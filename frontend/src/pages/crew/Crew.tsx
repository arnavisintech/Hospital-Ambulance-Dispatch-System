import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Ambulance, BedDouble, Clock, ExternalLink, Gauge, Hospital, MapPin, Navigation, Phone, Route as RouteIcon, Satellite, Timer, Warehouse,
} from 'lucide-react';
import { MobileAppLayout } from '../../components/layout/MobileAppLayout';
import { AmbulanceMarker, FitBounds, HospitalMarker, MapCanvas, PatientPin, RouteLine, StationMarker } from '../../components/map';
import {
  Card, EmptyState, ErrorState, LoadingBlock, SeverityBadge, IncidentBadge, SlideButton, StatusPill, Switch, useToast,
} from '../../components/ui';
import { useReportConnection } from '../../context/ConnectionContext';
import { useAsync } from '../../hooks/useAsync';
import { useIsDesktop } from '../../hooks/useMediaQuery';
import { useSocket } from '../../hooks/useSocket';
import { get, post } from '../../lib/api';
import { cn } from '../../lib/cn';
import { fmtDistance, fmtEta, fmtPhone } from '../../lib/format';
import { densify } from '../../lib/geo';
import type { CrewMe, LatLng, RequestOut, RouteOut } from '../../lib/types';
import { NavBanner } from './NavBanner';
import { OfferModal } from './OfferModal';
import { crewAction, crewPhase, nextManeuver } from './nav';

const REPORT_MS = 3000;
const ROUTE_REFRESH_MS = 45000;

/* ------------------------------------------------------------------ alerts for a new offer */

function alertNewOffer(offer: RequestOut) {
  try {
    if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
      new Notification('New emergency request', { body: `Slide to accept in the HADS app · ${offer.zone_label ?? 'Nearby'}`, tag: `offer-${offer.id}` });
    }
  } catch { /* notifications unsupported */ }
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [0, 0.22].forEach((t, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = i ? 1046 : 784;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.2);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + t);
      o.stop(ctx.currentTime + t + 0.22);
    });
    setTimeout(() => void ctx.close(), 800);
  } catch { /* autoplay blocked */ }
}

/* ------------------------------------------------------------------ page */

export default function Crew() {
  const { success, error } = useToast();
  const isDesktop = useIsDesktop();
  const me = useAsync(() => get<CrewMe>('/crew/me'), [], 5000);
  const c = me.data;
  const trip = c?.active_trip ?? null;
  const offer = c?.pending_offer ?? null;
  const ambId = c?.ambulance?.id ?? null;
  const onDuty = !!c?.ambulance && !['offline', 'maintenance'].includes(c.ambulance.status);

  /* ---- live updates ---- */
  const [routeKey, setRouteKey] = useState(0);
  const topics = [ambId ? `crew:${ambId}` : '', trip ? `request:${trip.id}` : ''].filter(Boolean);
  const { connected } = useSocket(topics, (m) => {
    if (m.type === 'ambulance.location') return; // our own pings echoed back
    if (m.type === 'request.route') setRouteKey((k) => k + 1);
    void me.reload();
  }, topics.length > 0);
  useReportConnection(connected);

  /* ---- offer alert ---- */
  const seenOffer = useRef<number | null>(null);
  const [offerSeenAt, setOfferSeenAt] = useState(() => Date.now());
  useEffect(() => {
    if (offer && seenOffer.current !== offer.id) {
      seenOffer.current = offer.id;
      setOfferSeenAt(Date.now());
      alertNewOffer(offer);
    }
    if (!offer) seenOffer.current = null;
  }, [offer]);

  /* ---- route for the current leg ---- */
  const phase = trip ? crewPhase(trip.status) : null;
  const route = useAsync<RouteOut | null>(
    async () => (trip && trip.status !== 'arrived' ? get<RouteOut>(`/crew/trips/${trip.id}/route`).catch(() => null) : null),
    [trip?.id, phase, routeKey], trip ? ROUTE_REFRESH_MS : 0,
  );
  const poly = useMemo<LatLng[]>(() => route.data?.polyline ?? [], [route.data]);

  /* ---- GPS reporting (every ~3 s) or simulated drive ---- */
  const [simulate, setSimulate] = useState(false);
  const [pos, setPos] = useState<LatLng | null>(null);
  const [gpsErr, setGpsErr] = useState<string | null>(null);
  const lastSent = useRef(0);
  const sendLoc = useCallback(async (p: LatLng) => {
    try { await post('/crew/location', { lat: p[0], lng: p[1] }); } catch { /* transient; next tick retries */ }
  }, []);

  useEffect(() => {
    if (!onDuty || simulate) return;
    if (!('geolocation' in navigator)) { setGpsErr('GPS not available on this device'); return; }
    const id = navigator.geolocation.watchPosition(
      (g) => {
        setGpsErr(null);
        const p: LatLng = [g.coords.latitude, g.coords.longitude];
        setPos(p);
        const now = Date.now();
        if (now - lastSent.current >= REPORT_MS) { lastSent.current = now; void sendLoc(p); }
      },
      (e) => setGpsErr(e.code === e.PERMISSION_DENIED ? 'Location permission denied' : 'GPS signal lost'),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [onDuty, simulate, sendLoc]);

  const simPath = useMemo(() => densify(poly, 120), [poly]);
  const simIdx = useRef(0);
  const posRef = useRef(pos);
  posRef.current = pos;
  const serverPos: LatLng | null = c?.ambulance?.lat != null && c.ambulance.lng != null ? [c.ambulance.lat, c.ambulance.lng] : null;
  const serverPosRef = useRef(serverPos);
  serverPosRef.current = serverPos;
  useEffect(() => { simIdx.current = 0; }, [simPath]);
  useEffect(() => {
    if (!simulate || !onDuty) return;
    const tick = () => {
      let p: LatLng | null = posRef.current ?? serverPosRef.current;
      if (simPath.length > 0) {
        p = simPath[Math.min(simIdx.current, simPath.length - 1)];
        if (simIdx.current < simPath.length - 1) simIdx.current += 1;
      }
      if (p) { setPos(p); void sendLoc(p); }
    };
    tick();
    const t = setInterval(tick, REPORT_MS);
    return () => clearInterval(t);
  }, [simulate, onDuty, simPath, sendLoc]);

  /* ---- actions ---- */
  const [dutyBusy, setDutyBusy] = useState(false);
  const toggleDuty = async (next: boolean) => {
    setDutyBusy(true);
    try {
      await post('/crew/duty', { on_duty: next });
      if (next && 'Notification' in window && Notification.permission === 'default') void Notification.requestPermission().catch(() => undefined);
      await me.reload();
      success(next ? "You're online — requests will appear here" : "You're offline");
    } catch (e) { error(e); } finally { setDutyBusy(false); }
  };
  const advance = async (status: string) => {
    if (!trip) return;
    try {
      await post(`/crew/trips/${trip.id}/status`, { status });
      await me.reload();
    } catch (e) {
      error(e);
      await me.reload();
      throw e;
    }
  };

  /* ---- render ---- */
  if (!c) {
    if (me.error) {
      return (
        <MobileAppLayout title="Duty">
          <ErrorState title="Couldn't load your duty status" message={`${me.error}.`} onRetry={() => void me.reload()} />
        </MobileAppLayout>
      );
    }
    return <LoadingBlock full label="Loading duty status" />;
  }
  if (!c.ambulance) {
    return (
      <MobileAppLayout title="Duty">
        <EmptyState icon={Ambulance} title="No ambulance assigned" description="Ask your station admin to link your account to an ambulance." />
      </MobileAppLayout>
    );
  }

  const myPos = pos ?? serverPos;
  const reporting = onDuty && (simulate || (!!pos && !gpsErr));
  const devTools = (
    <DevTools onDuty={onDuty} simulate={simulate} setSimulate={setSimulate} gpsErr={gpsErr} reporting={reporting} hasRoute={poly.length > 1} />
  );

  const offerModal = offer && !trip && <OfferModal key={offer.id} offer={offer} firstSeen={offerSeenAt} onDone={() => void me.reload()} />;

  if (trip) {
    return (
      <>
        <Navigate trip={trip} route={route.data ?? null} myPos={myPos} isDesktop={isDesktop} onAdvance={advance} devTools={devTools} />
        {offerModal}
      </>
    );
  }

  /* ---- standby ---- */
  const station = c.station;
  const stats = c.stats_today;
  const map = (
    <MapCanvas center={myPos ?? (station ? [station.lat, station.lng] : undefined)} zoom={15} recenterTo={myPos} recenterLabel="Center on my ambulance" ariaLabel="Your position">
      {station && <StationMarker position={[station.lat, station.lng]} name={station.name} />}
      {myPos && <AmbulanceMarker position={myPos} heading={c.ambulance.heading_deg} status={c.ambulance.status} title={c.ambulance.registration_number} />}
      {myPos && <FitBounds points={[myPos, myPos]} maxZoom={15} />}
    </MapCanvas>
  );
  return (
    <>
      <MobileAppLayout
        title={isDesktop ? 'Duty' : undefined}
        map={map}
        sheet={{
          snapPoints: [0.4, 0.86],
          ariaLabel: 'Duty',
          header: (
            <div className={cn('rounded-xl p-4 transition-colors duration-standard', onDuty ? 'bg-success-bg' : 'bg-canvas')}>
              <Switch
                size="lg"
                checked={onDuty}
                disabled={dutyBusy || c.ambulance.status === 'maintenance'}
                onChange={(v) => void toggleDuty(v)}
                label={<span className="text-lg font-extrabold">{onDuty ? "You're online" : "You're offline"}</span>}
                description={onDuty ? 'Waiting for the next emergency nearby' : 'Go online to receive emergency requests'}
              />
            </div>
          ),
        }}
      >
        <div className="space-y-4 pb-2">
          <div className="flex items-center gap-3">
            {c.crew && <span className="flex h-11 w-11 items-center justify-center rounded-full bg-brand-50 text-sm font-bold text-brand-600" aria-hidden>{c.crew.initials}</span>}
            <div className="min-w-0 flex-1">
              <p className="truncate font-bold text-ink-900">{c.crew?.name ?? 'Crew'}</p>
              <p className="flex items-center gap-2 text-sm text-ink-500">
                <span className="font-mono font-semibold text-ink-700">{c.ambulance.registration_number}</span>
                {c.ambulance.kind && <span>· {c.ambulance.kind.toUpperCase()}</span>}
              </p>
            </div>
            <StatusPill status={c.ambulance.status} kind="ambulance" />
          </div>

          <section aria-labelledby="h-today">
            <h2 id="h-today" className="mb-2 text-sm font-bold uppercase tracking-wide text-ink-500">Today</h2>
            <dl className="grid grid-cols-3 gap-2">
              <Tile icon={Ambulance} label="Trips" value={stats ? String(stats.trips) : '--'} />
              <Tile icon={Gauge} label="Distance" value={stats ? fmtDistance(stats.distance_km) : '--'} />
              <Tile icon={Timer} label="Online" value={stats ? fmtOnline(stats.online_minutes) : '--'} />
            </dl>
          </section>

          {station && (
            <Card padding="md" elevation="flat" className="flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-canvas text-ink-700" aria-hidden><Warehouse size={18} /></span>
              <div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Home station</p><p className="truncate font-semibold text-ink-900">{station.name}</p></div>
            </Card>
          )}
          {devTools}
        </div>
      </MobileAppLayout>
      {offerModal}
    </>
  );
}

function fmtOnline(min: number): string {
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

function Tile({ icon: Icon, label, value }: { icon: typeof Clock; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line/70 bg-surface p-3 shadow-card">
      <dt className="flex items-center gap-1 text-xs font-semibold text-ink-500"><Icon size={14} aria-hidden />{label}</dt>
      <dd className="mt-1 text-xl font-extrabold tabular-nums text-ink-900">{value}</dd>
    </div>
  );
}

function DevTools({ onDuty, simulate, setSimulate, gpsErr, reporting, hasRoute }: {
  onDuty: boolean; simulate: boolean; setSimulate: (v: boolean) => void; gpsErr: string | null; reporting: boolean; hasRoute: boolean;
}) {
  if (!onDuty) return null;
  return (
    <Card padding="md" elevation="flat" className="space-y-3">
      <p className="flex items-center gap-2 text-sm" aria-live="polite">
        <Satellite size={16} className={reporting ? 'text-success' : 'text-warning-fg'} aria-hidden />
        <span className={reporting ? 'text-ink-700' : 'text-warning-fg'}>
          {simulate ? 'Simulated GPS · sending every 3 s'
            : reporting ? 'GPS live · sending every 3 s'
            : `${gpsErr ?? 'Waiting for GPS'} — demo autopilot may drive this ambulance until your device reports`}
        </span>
      </p>
      <Switch checked={simulate} onChange={setSimulate} label={<span className="text-sm">Simulate drive (dev)</span>}
        description={hasRoute ? 'Moves the ambulance along the route' : 'Holds position until a trip has a route'} />
    </Card>
  );
}

/* ------------------------------------------------------------------ navigation */

function Navigate({ trip, route, myPos, isDesktop, onAdvance, devTools }: {
  trip: RequestOut; route: RouteOut | null; myPos: LatLng | null; isDesktop: boolean; onAdvance: (s: string) => Promise<void>; devTools: React.ReactNode;
}) {
  const action = crewAction(trip.status);
  const toHospital = crewPhase(trip.status) === 'to_hospital';
  const hosp = trip.destination_hospital ?? null;
  const patient: LatLng = [trip.lat, trip.lng];
  const dest: LatLng | null = toHospital ? (hosp ? [hosp.lat, hosp.lng] : null) : patient;
  const poly = route?.polyline ?? [];
  const next = trip.status === 'on_scene' || trip.status === 'arrived' ? null : nextManeuver(route?.steps, poly, myPos);
  const then = next && route ? route.steps.slice(next.index + 1).length ? nextManeuver(route.steps.slice(next.index + 1), poly, [route.steps[next.index].lat, route.steps[next.index].lng]) : null : null;
  const [fitKey, setFitKey] = useState(0);
  const mapsUrl = dest ? `https://www.google.com/maps/dir/?api=1&destination=${dest[0]},${dest[1]}&travelmode=driving` : null;

  const title = trip.status === 'accepted' ? 'Start trip to patient'
    : trip.status === 'en_route' ? 'Drive to patient'
    : trip.status === 'on_scene' ? 'With patient'
    : trip.status === 'transporting' ? `Drive to ${hosp?.name ?? 'hospital'}`
    : `At ${hosp?.name ?? 'hospital'}`;

  const map = (
    <div className="relative h-full w-full">
      <MapCanvas center={myPos ?? patient} zoom={15} onRecenter={() => setFitKey((k) => k + 1)} recenterLabel="Show route" ariaLabel="Navigation map">
        {poly.length > 1 && <RouteLine positions={poly} phase={route?.phase ?? (toHospital ? 'to_hospital' : 'to_patient')} progressAt={myPos} />}
        {hosp && <HospitalMarker position={[hosp.lat, hosp.lng]} name={hosp.name} selected={toHospital} />}
        {!toHospital && <PatientPin position={patient} label="Patient" />}
        {myPos && <AmbulanceMarker position={myPos} status={trip.status === 'transporting' ? 'transporting' : 'en_route'} route={poly} title="You" zIndexOffset={800} />}
        <FitBounds points={[myPos, dest]} refitKey={`${fitKey}-${trip.status}`} once={false} maxZoom={16} />
      </MapCanvas>
      {next && (
        <NavBanner next={next} then={then} className={cn('absolute z-sticky', isDesktop ? 'left-4 right-4 top-4 max-w-md' : 'inset-x-3 top-[calc(var(--safe-top)+66px)]')} />
      )}
    </div>
  );

  const bottomBar = action ? (
    <SlideButton key={trip.status} label={action.label} tone={action.tone} confirmedLabel={action.confirmed} onConfirm={() => onAdvance(action.next)} />
  ) : (
    <div className="flex items-center gap-3 rounded-lg bg-teal-bg px-4 py-3 text-teal-fg" role="status">
      <BedDouble size={20} aria-hidden />
      <p className="text-sm font-semibold">Waiting for hospital staff to confirm handover</p>
    </div>
  );

  return (
    <MobileAppLayout
      title={isDesktop ? `Trip #${trip.id}` : undefined}
      map={map}
      bottomBar={bottomBar}
      sheet={{
        snapPoints: [0.34, 0.86],
        ariaLabel: 'Trip details',
        header: (
          <div className="flex items-end justify-between gap-3" role="status" aria-live="polite">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">{toHospital ? 'Drop-off' : 'Pickup'}</p>
              <h2 className="truncate text-xl font-extrabold text-ink-900">{title}</h2>
            </div>
            {route && trip.status !== 'on_scene' && trip.status !== 'arrived' && (
              <div className="shrink-0 text-right">
                <p className="text-2xl font-extrabold leading-none tabular-nums text-ink-900">{fmtEta(route.eta_seconds)}</p>
                <p className="mt-1 text-sm tabular-nums text-ink-500">{fmtDistance(route.distance_km)}</p>
              </div>
            )}
          </div>
        ),
      }}
    >
      <div className="space-y-3 pb-2">
        <Card padding="md" className="space-y-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <IncidentBadge type={trip.incident_type} size="md" />
            <SeverityBadge severity={trip.severity} size="md" showLevel />
          </div>
          <p className="flex items-start gap-2 text-sm text-ink-700">
            <MapPin size={16} className="mt-0.5 shrink-0 text-brand-500" aria-hidden />
            {trip.address || trip.zone_label || `${trip.lat.toFixed(5)}, ${trip.lng.toFixed(5)}`}
          </p>
          {trip.notes && <p className="rounded-md bg-warning-bg px-3 py-2 text-sm text-warning-fg">“{trip.notes}”</p>}
          {(trip.caller_name || trip.caller_phone) && (
            <div className="flex items-center gap-3 border-t border-line pt-3">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Caller</p>
                <p className="truncate font-semibold text-ink-900">{trip.caller_name ?? 'Patient contact'}</p>
                {trip.caller_phone && <p className="text-sm tabular-nums text-ink-500">{fmtPhone(trip.caller_phone)}</p>}
              </div>
              {trip.caller_phone && (
                <a href={`tel:${trip.caller_phone}`} aria-label={`Call ${trip.caller_name ?? 'caller'}`}
                  className="press flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-success text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success focus-visible:ring-offset-2">
                  <Phone size={20} aria-hidden />
                </a>
              )}
            </div>
          )}
        </Card>

        <Card padding="md" className="flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-teal-bg text-teal-fg" aria-hidden><Hospital size={20} /></span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Destination hospital</p>
            <p className="truncate font-semibold text-ink-900">{hosp?.name ?? 'Being confirmed by control'}</p>
          </div>
        </Card>

        {mapsUrl && (
          <a href={mapsUrl} target="_blank" rel="noreferrer"
            className="press flex min-h-[48px] items-center justify-center gap-2 rounded-md border border-line-strong bg-surface text-sm font-semibold text-ink-900 hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
            <Navigation size={18} aria-hidden /> Open in Google Maps <ExternalLink size={14} className="text-ink-500" aria-hidden />
          </a>
        )}
        {!route && trip.status !== 'on_scene' && trip.status !== 'arrived' && (
          <p className="flex items-center gap-2 text-sm text-ink-500"><RouteIcon size={16} aria-hidden /> Loading route…</p>
        )}
        {devTools}
      </div>
    </MobileAppLayout>
  );
}
