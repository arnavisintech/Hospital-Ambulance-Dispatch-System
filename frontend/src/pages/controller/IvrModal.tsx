import { useEffect, useRef, useState, type FormEvent } from 'react';
import type L from 'leaflet';
import { Loader2, MapPin, Phone, Search, Send, UserRound } from 'lucide-react';
import { MapCanvas } from '../../components/map';
import { Button, Input, Modal, Textarea, useToast } from '../../components/ui';
import { usePlaceSearch } from '../../hooks/usePlaceSearch';
import { get, post } from '../../lib/api';
import { cn } from '../../lib/cn';
import { CITY_CENTER } from '../../lib/geo';
import { newUuid } from '../../lib/queue';
import { INCIDENT_KEYS, incidentMeta, severityMeta, toneClasses } from '../../lib/status';
import type { LatLng, PlaceResult, RequestOut, ReversePlace } from '../../lib/types';

export interface IvrModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (r: RequestOut) => void;
  /** Initial map centre (e.g. current map view). */
  center?: LatLng;
}

const PHONE_RE = /^\+?[\d\s-]{8,16}$/;

/** Operator-entered request on behalf of a phone/IVR caller (UC-1 A2). */
export function IvrModal({ open, onClose, onCreated, center }: IvrModalProps) {
  return (
    <Modal open={open} onClose={onClose} size="xl" className="sm:max-w-5xl" title="New phone (IVR) request" description="Enter the caller's details and drop the pin on the incident location. Dispatch starts as soon as you submit.">
      {open && <IvrForm onCreated={(r) => { onCreated(r); onClose(); }} center={center} onCancel={onClose} />}
    </Modal>
  );
}

function IvrForm({ onCreated, center, onCancel }: { onCreated: (r: RequestOut) => void; center?: LatLng; onCancel: () => void }) {
  const { success, error } = useToast();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [incident, setIncident] = useState<string>('');
  const [severity, setSeverity] = useState<number>(3);
  const [notes, setNotes] = useState('');
  const [pos, setPos] = useState<LatLng | null>(null);
  const [address, setAddress] = useState('');
  const [addrEdited, setAddrEdited] = useState(false);
  // Reverse-geocoded address, keyed by the pin it describes: `resolving` is derived (current pin not answered yet).
  const [geo, setGeo] = useState<{ key: string; place: ReversePlace | null } | null>(null);
  const posKey = pos ? `${pos[0].toFixed(6)},${pos[1].toFixed(6)}` : null;
  const resolving = posKey !== null && geo?.key !== posKey;
  const place = geo?.place ?? null;
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const map = useRef<L.Map | null>(null);
  // One id per call: re-sending after a lost reply returns the same request instead of dispatching a second unit.
  const uuid = useRef(newUuid());

  // Reverse-geocode the pin (debounced). Degrades to coordinates when /geo is unavailable.
  useEffect(() => {
    if (!posKey) return;
    let alive = true;
    const [lat, lng] = posKey.split(',');
    const t = setTimeout(() => {
      get<ReversePlace>('/geo/reverse', { lat, lng })
        .then((p) => { if (!alive) return; setGeo({ key: posKey, place: p }); if (!addrEdited) setAddress(p.address || p.label || ''); })
        .catch(() => { if (alive) setGeo({ key: posKey, place: null }); });
    }, 450);
    return () => { alive = false; clearTimeout(t); };
  }, [posKey, addrEdited]);

  const phoneErr = submitted && phone && !PHONE_RE.test(phone) ? 'Enter a valid phone number' : undefined;
  const incErr = submitted && !incident ? 'Pick what happened' : undefined;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (!incident || !pos || (phone && !PHONE_RE.test(phone))) return;
    setBusy(true);
    try {
      const r = await post<RequestOut>('/requests/ivr', {
        client_uuid: uuid.current, lat: pos[0], lng: pos[1], address: address.trim() || undefined, channel: 'ivr',
        incident_type: incident, severity, notes: notes.trim() || undefined,
        caller_name: name.trim() || undefined, caller_phone: phone.trim() || undefined,
      });
      success(`Request #${r.id} created — finding the nearest ambulance`, { title: 'Dispatch started' });
      uuid.current = newUuid();
      onCreated(r);
    } catch (e2) { error(e2, { title: "Couldn't create request" }); } finally { setBusy(false); }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="grid gap-5 pb-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]" aria-label="IVR request entry" noValidate>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Input label="Caller name" icon={UserRound} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" data-autofocus />
          <Input label="Caller phone" icon={Phone} type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} error={phoneErr} autoComplete="off" />
        </div>

        <fieldset>
          <legend className="mb-1.5 text-sm font-semibold text-ink-700">What happened? <span className="text-brand-500" aria-hidden>*</span></legend>
          <div role="radiogroup" aria-label="Incident type" className="grid grid-cols-3 gap-2">
            {INCIDENT_KEYS.map((k) => {
              const m = incidentMeta(k);
              const Icon = m.icon;
              const on = incident === k;
              return (
                <button
                  key={k} type="button" role="radio" aria-checked={on} onClick={() => setIncident(k)} title={m.hint}
                  className={cn('press flex h-16 flex-col items-center justify-center gap-1 rounded-md border text-xs font-semibold transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
                    on ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-line-strong bg-surface text-ink-700 hover:border-ink-400')}
                >
                  <Icon size={20} aria-hidden />{m.short}
                </button>
              );
            })}
          </div>
          {incErr && <p className="mt-1 text-xs font-medium text-danger-fg" role="alert">{incErr}</p>}
        </fieldset>

        <fieldset>
          <legend className="mb-1.5 text-sm font-semibold text-ink-700">Severity</legend>
          <div role="radiogroup" aria-label="Severity" className="grid grid-cols-5 gap-1.5">
            {[1, 2, 3, 4, 5].map((n) => {
              const m = severityMeta(n);
              const on = severity === n;
              return (
                <button
                  key={n} type="button" role="radio" aria-checked={on} onClick={() => setSeverity(n)} title={m.description}
                  className={cn('press flex h-14 flex-col items-center justify-center rounded-md border px-1 text-center text-2xs font-semibold leading-tight transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
                    on ? cn(toneClasses(m.tone).solid, 'border-transparent') : 'border-line-strong bg-surface text-ink-700 hover:border-ink-400')}
                >
                  <span className="text-base font-extrabold tabular-nums">{n}</span>{m.label}
                </button>
              );
            })}
          </div>
          <p className="mt-1 text-xs text-ink-500">{severityMeta(severity).description}</p>
        </fieldset>

        <Textarea label="Notes for the crew" rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Landmark, floor, patient condition…" />
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <PlaceSearch onPick={(p) => { setAddrEdited(false); map.current?.flyTo([p.lat, p.lng], 16, { duration: 0.6 }); }} />
        <div className={cn('relative h-[300px] overflow-hidden rounded-lg border md:h-[340px]', submitted && !pos ? 'border-brand-500' : 'border-line')}>
          <MapCanvas
            center={center ?? CITY_CENTER} zoom={14} zoomControls ariaLabel="Incident location map — drag to place the pin"
            onMapReady={(m) => { map.current = m; }}
            centerPin={{ onChange: setPos, label: 'Ambulance will come here' }}
          />
        </div>
        <div className="flex items-start gap-2 rounded-md bg-canvas px-3 py-2 text-sm" aria-live="polite">
          <MapPin size={16} className="mt-0.5 shrink-0 text-brand-500" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold text-ink-900">
              {resolving ? 'Finding address…' : place?.label || (pos ? 'Pinned location' : 'Move the map to place the pin')}
            </p>
            {pos && <p className="text-xs text-ink-500 tabular-nums">{pos[0].toFixed(5)}, {pos[1].toFixed(5)}{place?.locality ? ` · ${place.locality}` : ''}</p>}
          </div>
          {resolving && <Loader2 size={16} className="mt-0.5 animate-spin text-ink-400" aria-hidden />}
        </div>
        <Input label="Address / landmark" value={address} onChange={(e) => { setAddress(e.target.value); setAddrEdited(true); }} placeholder="Door no., street, landmark" />
      </div>

      <div className="flex flex-col-reverse gap-2 border-t border-line pt-4 sm:flex-row sm:justify-end md:col-span-2">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" icon={Send} loading={busy}>Create & dispatch</Button>
      </div>
    </form>
  );
}

/** Debounced locality search (GET /geo/search) with a results listbox. */
function PlaceSearch({ onPick }: { onPick: (p: PlaceResult) => void }) {
  const [q, setQ] = useState('');
  const found = usePlaceSearch(q);
  const [picked, setPicked] = useState<string | null>(null);   // the list closes once a place is chosen
  const results = picked !== null && q === picked ? null : found.results;
  const loading = found.loading && q !== picked;
  const failed = !!found.error;
  const [active, setActive] = useState(0);
  const [activeFor, setActiveFor] = useState(results);
  if (activeFor !== results) { setActiveFor(results); setActive(0); }   // new results: highlight the first

  const pick = (p: PlaceResult) => { onPick(p); setQ(p.label); setPicked(p.label); };
  const open = results !== null;

  return (
    <div className="relative">
      <Input
        icon={Search} placeholder="Search area or landmark (e.g. T. Nagar)" aria-label="Search location"
        value={q} onChange={(e) => setQ(e.target.value)}
        role="combobox" aria-expanded={open} aria-controls="ivr-places" aria-autocomplete="list"
        aria-activedescendant={open && results.length ? `ivr-place-${active}` : undefined}
        onKeyDown={(e) => {
          if (!results?.length) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % results.length); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + results.length) % results.length); }
          else if (e.key === 'Enter') { e.preventDefault(); pick(results[active]); }
          else if (e.key === 'Escape') { e.stopPropagation(); setPicked(q); }   // close until the text changes
        }}
        trailing={loading ? <Loader2 size={16} className="mr-2 animate-spin text-ink-400" aria-hidden /> : undefined}
      />
      {open && (
        <ul id="ivr-places" role="listbox" className="absolute inset-x-0 top-full z-[1100] mt-1 overflow-hidden rounded-lg border border-line/80 bg-surface py-1 shadow-raised">
          {results.length === 0 ? (
            <li className="px-3 py-2 text-sm text-ink-500">{failed ? "Search is unavailable — move the map to place the pin." : 'No places found in Chennai.'}</li>
          ) : results.map((p, i) => (
            <li
              key={`${p.label}-${i}`} id={`ivr-place-${i}`} role="option" aria-selected={i === active}
              onMouseDown={(e) => { e.preventDefault(); pick(p); }} onMouseEnter={() => setActive(i)}
              className={cn('flex cursor-pointer items-center gap-2 px-3 py-2 text-sm', i === active ? 'bg-canvas text-ink-900' : 'text-ink-700')}
            >
              <MapPin size={14} className="shrink-0 text-ink-400" aria-hidden /><span className="truncate">{p.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
