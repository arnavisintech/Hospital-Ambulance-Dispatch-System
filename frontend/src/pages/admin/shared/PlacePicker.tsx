import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type L from 'leaflet';
import { Loader2, MapPin, Search } from 'lucide-react';
import { MapCanvas } from '../../../components/map';
import { get } from '../../../lib/api';
import { cn } from '../../../lib/cn';
import { CHENNAI } from '../../../lib/geo';
import type { LatLng, PlaceResult, ReversePlace } from '../../../lib/types';

/**
 * Swiggy-style location picking for onboarding: geo search (GET /geo/search) + map that moves under a fixed
 * centre pin; reverse-geocodes the pin (GET /geo/reverse) and reports a suggested address.
 */
export function PlacePicker({ value, onChange, onAddress, label = 'Location', pinLabel = 'Move the map to place the pin' }: {
  value: LatLng | null;
  onChange: (p: LatLng) => void;
  /** Suggested address for the pin (caller decides whether to use it). */
  onAddress?: (address: string) => void;
  label?: string;
  pinLabel?: string;
}) {
  const id = useId();
  const map = useRef<L.Map | null>(null);
  const [q, setQ] = useState('');
  const [found, setResults] = useState<PlaceResult[]>([]);
  const results = q.trim().length < 2 ? [] : found;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [searching, setSearching] = useState(false);
  const [place, setPlace] = useState<string | null>(null);
  const addrCb = useRef(onAddress);
  useEffect(() => { addrCb.current = onAddress; });
  const [start] = useState<LatLng>(() => value ?? CHENNAI);

  // Debounced search.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return;
    let alive = true;
    const t = setTimeout(() => {
      setSearching(true);
      get<PlaceResult[]>('/geo/search', { q: term })
        .then((r) => { if (alive) { setResults(Array.isArray(r) ? r.slice(0, 6) : []); setOpen(true); setActive(-1); } })
        .catch(() => { if (alive) setResults([]); })
        .finally(() => { if (alive) setSearching(false); });
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [q]);

  // Debounced reverse geocode of the pin.
  const key = value ? `${value[0].toFixed(5)},${value[1].toFixed(5)}` : '';
  useEffect(() => {
    if (!value) return;
    let alive = true;
    const t = setTimeout(() => {
      get<ReversePlace>('/geo/reverse', { lat: value[0], lng: value[1] })
        .then((r) => { if (alive && r?.label) { setPlace(r.label); addrCb.current?.(r.address || r.label); } })
        .catch(() => { if (alive) setPlace(null); });
    }, 450);
    return () => { alive = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const pick = (r: PlaceResult) => {
    setOpen(false);
    setQ(r.label);
    map.current?.flyTo([r.lat, r.lng], 16, { duration: 0.6 });
  };
  const onKey = (e: KeyboardEvent) => {
    if (!open || !results.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % results.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + results.length) % results.length); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(results[active]); }
    else if (e.key === 'Escape') setOpen(false);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-semibold text-ink-700" id={`${id}-l`}>{label}</span>
          <div className="relative">
            <Search size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" aria-hidden />
            <input
              type="search" role="combobox" aria-expanded={open && results.length > 0} aria-controls={`${id}-list`}
              aria-activedescendant={active >= 0 ? `${id}-o${active}` : undefined} aria-autocomplete="list"
              aria-label={`Search for ${label.toLowerCase()}`}
              value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} onFocus={() => results.length && setOpen(true)}
              onBlur={() => setTimeout(() => setOpen(false), 150)}
              placeholder="Search area, street or landmark"
              className="h-11 w-full rounded-md border border-line-strong bg-surface pl-10 pr-10 text-base placeholder:text-ink-400 focus:border-brand-500 focus:shadow-focus focus:outline-none"
            />
            {searching && <Loader2 size={18} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-ink-400" aria-hidden />}
            {open && results.length > 0 && (
              <ul id={`${id}-list`} role="listbox" className="absolute inset-x-0 top-full z-[1100] mt-1 max-h-60 overflow-auto rounded-md border border-line bg-surface py-1 shadow-raised">
                {results.map((r, i) => (
                  <li key={`${r.label}-${i}`} id={`${id}-o${i}`} role="option" aria-selected={i === active}
                    onMouseDown={(e) => { e.preventDefault(); pick(r); }}
                    className={cn('flex cursor-pointer items-start gap-2 px-3 py-2 text-sm text-ink-900', i === active ? 'bg-canvas' : 'hover:bg-canvas')}>
                    <MapPin size={16} className="mt-0.5 shrink-0 text-ink-500" aria-hidden />{r.label}
                  </li>
                ))}
              </ul>
            )}
          </div>
      <div className="relative overflow-hidden rounded-md border border-line-strong">
        <div className="h-64 sm:h-72">
          <MapCanvas center={start} zoom={value ? 15 : 12} centerPin={{ onChange, label: pinLabel }} onMapReady={(m) => { map.current = m; }}
            ariaLabel={`${label} map — move the map to position the pin`} zoomControls />
        </div>
      </div>
      <p className="flex items-start gap-1.5 text-xs text-ink-500" aria-live="polite">
        <MapPin size={14} className="mt-px shrink-0" aria-hidden />
        <span>{place ?? 'Locating…'}{value && <span className="tabular-nums"> · {value[0].toFixed(5)}, {value[1].toFixed(5)}</span>}</span>
      </p>
    </div>
  );
}
