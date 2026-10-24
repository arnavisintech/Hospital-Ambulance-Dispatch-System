import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type L from 'leaflet';
import { ChevronRight, LocateFixed, MapPin, PencilLine, Phone, Search, Siren, WifiOff } from 'lucide-react';
import { MobileAppLayout } from '../../components/layout/MobileAppLayout';
import { MapCanvas } from '../../components/map';
import { Button, SegmentedControl, Textarea, useToast } from '../../components/ui';
import { AGE_OPTIONS, buildSosBody, receiptMessage, type AgeGroup } from './trip';
import { notifyQueueChanged } from '../../components/QueueBanner';
import { useAsync } from '../../hooks/useAsync';
import { useIsDesktop } from '../../hooks/useMediaQuery';
import { ApiError, get, post } from '../../lib/api';
import { cn } from '../../lib/cn';
import { CITY_CENTER } from '../../lib/geo';
import { enqueue, isRetryable, newUuid } from '../../lib/queue';
import { INCIDENT, INCIDENT_KEYS, SEVERITY, isLiveTrip, requestStatusMeta, severityMeta, toneClasses } from '../../lib/status';
import type { CreateRequestBody, LatLng, PlaceResult, RequestOut, ReversePlace } from '../../lib/types';
import { PlaceSearch } from './components/PlaceSearch';

/** How the pickup point was set. 'none' = map default, not yet confirmed. */
type LocSource = 'none' | 'gps' | 'pin' | 'search';

const DEFAULT_SEVERITY = 3; // "Serious": err on the side of urgency when the caller doesn't choose
const PEEK = 0.5;
const HAS_GPS = typeof navigator !== 'undefined' && 'geolocation' in navigator;

/**
 * Home / SOS (UC-1). NFR5: open → (GPS fix + defaults) → tap "Request ambulance" = submitted.
 * Swiggy-style pickup: the map moves under a fixed centre pin; address via /geo/reverse.
 */
export default function Sos() {
  const nav = useNavigate();
  const isDesktop = useIsDesktop();
  const { toast, error } = useToast();
  const uuid = useRef(newUuid());
  const map = useRef<L.Map | null>(null);
  const programmatic = useRef(false);
  const firstMove = useRef(true);

  const [center, setCenter] = useState<LatLng>(CITY_CENTER);
  const [source, setSource] = useState<LocSource>('none');
  const [locating, setLocating] = useState(HAS_GPS);   // a GPS fix is requested as soon as the screen opens
  const [gpsError, setGpsError] = useState<string | null>(HAS_GPS ? null : 'Location isn’t available on this device');
  const [place, setPlace] = useState<ReversePlace | null>(null);
  const [placeLoading, setPlaceLoading] = useState(false);
  const geoMissing = useRef(false);
  const [searchOpen, setSearchOpen] = useState(false);

  const [type, setType] = useState<string>('other');
  const [severity, setSeverity] = useState(DEFAULT_SEVERITY);
  const [notes, setNotes] = useState('');
  const [age, setAge] = useState<AgeGroup>('unknown');
  const [showNote, setShowNote] = useState(false);
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(false);

  // An already-active request: offer a shortcut instead of a duplicate SOS.
  const mine = useAsync(() => get<RequestOut[]>('/requests/mine').catch(() => [] as RequestOut[]), []);
  const active = mine.data?.find((r) => isLiveTrip(r.status) || requestStatusMeta(r.status).searching);

  const flyTo = useCallback((p: LatLng, zoom = 16) => {
    programmatic.current = true;
    if (map.current) map.current.setView(p, zoom, { animate: true });
    else setCenter(p);
  }, []);

  // Ask the device for a fix; results arrive in callbacks (no state is set synchronously here).
  const requestFix = useCallback(() => {
    if (!HAS_GPS) return;
    navigator.geolocation.getCurrentPosition(
      (g) => {
        setLocating(false);
        setGpsError(null);
        setSource('gps');
        flyTo([g.coords.latitude, g.coords.longitude]);
      },
      (e) => {
        setLocating(false);
        setGpsError(e.code === e.PERMISSION_DENIED ? 'Location permission is off' : 'Couldn’t get your GPS location');
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 },
    );
  }, [flyTo]);
  useEffect(() => { requestFix(); }, [requestFix]);
  const locate = useCallback(() => {   // "use my location" button
    if (!HAS_GPS) return;
    setLocating(true);
    requestFix();
  }, [requestFix]);

  const onCenter = useCallback((c: LatLng) => {
    setCenter(c);
    if (firstMove.current) { firstMove.current = false; return; } // initial report of the default centre
    if (programmatic.current) { programmatic.current = false; return; }
    setSource('pin');
  }, []);

  // Reverse geocode the pin (debounced). Falls back silently when /geo/reverse is absent.
  useEffect(() => {
    if (source === 'none' || geoMissing.current) return;
    let alive = true;
    setPlaceLoading(true);
    const t = setTimeout(async () => {
      try {
        const p = await get<ReversePlace>('/geo/reverse', { lat: center[0].toFixed(6), lng: center[1].toFixed(6) });
        if (alive) setPlace(p);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) geoMissing.current = true;
        if (alive) setPlace(null);
      } finally {
        if (alive) setPlaceLoading(false);
      }
    }, 450);
    return () => { alive = false; clearTimeout(t); };
  }, [center, source]);

  const ready = source !== 'none';
  const addressText = place?.address || place?.label || undefined;

  const submit = async () => {
    if (!ready) { setSource('pin'); return; } // first tap confirms the pin when GPS is unavailable
    const body: CreateRequestBody = buildSosBody({
      uuid: uuid.current, center: [center[0], center[1]], address: addressText, type, severity, notes, age,
    });
    setBusy(true);
    try {
      const r = await post<RequestOut>('/requests', body);
      toast(receiptMessage(r.id, r.estimated_wait_seconds), 'success');
      nav(`/track/${r.id}`);
    } catch (err) {
      if (isRetryable(err)) {
        enqueue(body);
        notifyQueueChanged();
        setQueued(true);
        toast('No connection — your SOS is saved and will send automatically', 'info');
      } else {
        error(err);
      }
      setBusy(false);
    }
  };

  const sevMeta = severityMeta(severity);

  const header = (
    <AddressCard
      ready={ready}
      locating={locating && !ready}
      loading={placeLoading}
      place={place}
      center={center}
      gpsError={!ready ? gpsError : null}
      onSearch={() => setSearchOpen(true)}
    />
  );

  const mapEl = (
    <div className={cn('relative w-full', isDesktop ? 'h-full' : '')} style={isDesktop ? undefined : { height: `calc(${(1 - PEEK) * 100}dvh + 28px)` }}>
      <MapCanvas
        center={center}
        zoom={15}
        onMapReady={(m) => { map.current = m; }}
        centerPin={{ onChange: onCenter, label: ready ? 'Ambulance will come here' : 'Move the map to your location' }}
        onRecenter={locate}
        recenterLabel="Use my current location"
        controlsInset={isDesktop ? undefined : { bottom: 36 }}
        ariaLabel="Pickup location map. Move the map to place the pin."
      />
    </div>
  );

  const bottomBar = (
    <div className="flex items-center gap-3">
      <a href="tel:108" aria-label="Call 108 emergency helpline"
        className="press flex h-14 w-16 shrink-0 flex-col items-center justify-center rounded-lg border border-line-strong bg-surface text-ink-900 hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
        <Phone size={18} className="text-brand-500" aria-hidden />
        <span className="text-xs font-bold leading-tight">108</span>
      </a>
      <Button
        size="xl"
        fullWidth
        icon={ready ? Siren : MapPin}
        loading={busy}
        disabled={!ready && locating}
        onClick={() => void submit()}
        className="text-lg font-extrabold"
      >
        {ready ? 'Request ambulance' : locating ? 'Finding you…' : 'Confirm pickup here'}
      </Button>
    </div>
  );

  return (
    <MobileAppLayout
      title={isDesktop ? 'Request an ambulance' : undefined}
      map={mapEl}
      sheet={{ snapPoints: [PEEK, 0.92], header, ariaLabel: 'Emergency details' }}
      bottomBar={bottomBar}
    >
      <div className="space-y-6 pb-4">
        {active && (
          <Link to={`/track/${active.id}`} className="press flex items-center gap-3 rounded-lg border border-info/30 bg-info-bg p-3 text-info-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
            <Siren size={20} aria-hidden />
            <span className="min-w-0 flex-1 text-sm font-semibold">You have an active request — {requestStatusMeta(active.status).headline.toLowerCase()}</span>
            <ChevronRight size={18} aria-hidden />
          </Link>
        )}
        {queued && (
          <div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning-bg p-3 text-warning-fg" role="status">
            <WifiOff size={20} className="mt-0.5 shrink-0" aria-hidden />
            <p className="text-sm"><span className="font-semibold">Your SOS is saved.</span> We’ll send it the moment you’re back online. If it’s urgent, call 108.</p>
          </div>
        )}

        <fieldset>
          <legend className="mb-3 flex w-full items-baseline justify-between gap-2 text-base font-bold text-ink-900">
            What’s the emergency?
            <span className="text-sm font-semibold text-brand-600" aria-hidden>{INCIDENT[type as keyof typeof INCIDENT]?.short}</span>
          </legend>
          <div className="grid grid-cols-3 gap-2">
            {INCIDENT_KEYS.map((k) => {
              const m = INCIDENT[k];
              const on = type === k;
              return (
                <label key={k} title={m.hint}
                  className={cn(
                    'press flex min-h-[84px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border px-1.5 py-2.5 text-center transition-colors duration-micro',
                    'focus-within:ring-2 focus-within:ring-brand-500 focus-within:ring-offset-1',
                    on ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-line bg-surface text-ink-700 hover:border-line-strong',
                  )}>
                  <input type="radio" name="incident" value={k} className="sr-only" checked={on} onChange={() => setType(k)} />
                  <span className={cn('flex h-9 w-9 items-center justify-center rounded-full', on ? 'bg-brand-500 text-white' : 'bg-canvas text-ink-700')} aria-hidden>
                    <m.icon size={20} />
                  </span>
                  <span className="text-xs font-semibold leading-tight">{m.short}</span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-3 text-base font-bold text-ink-900">How serious is it?</legend>
          <div className="grid grid-cols-5 gap-1.5" role="presentation">
            {([1, 2, 3, 4, 5] as const).map((n) => {
              const m = SEVERITY[n];
              const on = severity === n;
              const t = toneClasses(m.tone);
              return (
                <label key={n}
                  className={cn(
                    'press flex min-h-[52px] cursor-pointer items-center justify-center rounded-md border px-1 text-center text-xs font-bold leading-tight transition-colors duration-micro',
                    'focus-within:ring-2 focus-within:ring-brand-500 focus-within:ring-offset-1',
                    on ? cn(t.solid, 'border-transparent') : 'border-line bg-surface text-ink-700 hover:border-line-strong',
                  )}>
                  <input type="radio" name="severity" value={n} className="sr-only" checked={on} onChange={() => setSeverity(n)} aria-describedby="sev-desc" />
                  {m.label}
                </label>
              );
            })}
          </div>
          <p id="sev-desc" className="mt-2 text-sm text-ink-500" aria-live="polite">
            <span className={cn('font-semibold', toneClasses(sevMeta.tone).text)}>{sevMeta.label}:</span> {sevMeta.description}
          </p>
        </fieldset>

        <fieldset>
          <legend className="mb-3 text-base font-bold text-ink-900">Patient age <span className="font-medium text-ink-500">(optional)</span></legend>
          <SegmentedControl ariaLabel="Patient age" fullWidth items={AGE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            value={age} onChange={(v) => setAge(v as AgeGroup)} />
        </fieldset>

        {showNote ? (
          <Textarea label="Note for the crew (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} showCount rows={2}
            placeholder="Patient condition, landmark, gate or floor…" autoFocus />
        ) : (
          <button type="button" onClick={() => setShowNote(true)}
            className="flex min-h-[48px] w-full items-center gap-2 rounded-md border border-dashed border-line-strong px-3 text-sm font-semibold text-ink-700 hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
            <PencilLine size={18} aria-hidden /> Add a note for the crew <span className="font-normal text-ink-500">(optional)</span>
          </button>
        )}
      </div>

      <PlaceSearch
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onUseGps={locate}
        onPick={(p: PlaceResult) => { setSource('search'); flyTo([p.lat, p.lng]); setPlace({ label: p.label }); }}
      />
    </MobileAppLayout>
  );
}

function AddressCard({ ready, locating, loading, place, center, gpsError, onSearch }: {
  ready: boolean; locating: boolean; loading: boolean; place: ReversePlace | null; center: LatLng; gpsError: string | null; onSearch: () => void;
}) {
  const title = locating ? 'Finding your location…'
    : !ready ? (gpsError ?? 'Set your pickup location')
    : place?.locality || place?.label || (loading ? 'Finding address…' : 'Pinned location');
  const sub = locating ? 'Using GPS for the fastest pickup'
    : !ready ? 'Move the map under the pin, or search'
    : place?.address || (place?.label && place.label !== title ? place.label : `${center[0].toFixed(5)}, ${center[1].toFixed(5)}`);
  return (
    <div className="flex items-center gap-3" aria-live="polite">
      <span className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-full', ready ? 'bg-brand-50 text-brand-500' : 'bg-warning-bg text-warning-fg')} aria-hidden>
        {locating ? <LocateFixed size={20} className="animate-pulse" /> : <MapPin size={20} />}
      </span>
      <div className={cn('min-w-0 flex-1', loading && 'opacity-60 transition-opacity')}>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Pickup</p>
        <p className="truncate text-base font-bold text-ink-900">{title}</p>
        <p className="truncate text-sm text-ink-500">{sub}</p>
      </div>
      <Button variant="secondary" size="md" icon={Search} onClick={onSearch} aria-label="Search for a location">Change</Button>
    </div>
  );
}
