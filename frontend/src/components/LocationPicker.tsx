import { useCallback, useEffect, useState } from 'react';
import { Marker } from 'react-leaflet';
import { CHENNAI } from '../lib/geo';
import type { LatLng } from '../lib/types';
import { MapView, pinIcon } from './MapView';

type GpsState = 'idle' | 'locating' | 'ok' | 'denied' | 'unavailable';

interface Props {
  value: LatLng | null;
  onChange: (p: LatLng) => void;
  address: string;
  onAddress: (a: string) => void;
  autoLocate?: boolean;
  mapClass?: string;
}

/** Auto GPS + click-on-map pin + manual address search (UC-1 A1). */
export function LocationPicker({ value, onChange, address, onAddress, autoLocate = true, mapClass = 'h-56 w-full' }: Props) {
  const [gps, setGps] = useState<GpsState>('idle');
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);

  const locate = useCallback(() => {
    if (!('geolocation' in navigator)) { setGps('unavailable'); return; }
    setGps('locating');
    navigator.geolocation.getCurrentPosition(
      (pos) => { onChange([pos.coords.latitude, pos.coords.longitude]); setGps('ok'); },
      (err) => setGps(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable'),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 15000 },
    );
  }, [onChange]);

  useEffect(() => { if (autoLocate && !value) locate(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const search = async () => {
    if (!address.trim()) return;
    setSearching(true);
    setSearchErr(null);
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=in&q=${encodeURIComponent(address)}`);
      const j = (await r.json()) as { lat: string; lon: string }[];
      if (!j.length) setSearchErr('Address not found - tap the map to drop a pin instead');
      else onChange([parseFloat(j[0].lat), parseFloat(j[0].lon)]);
    } catch {
      setSearchErr('Address lookup unavailable - tap the map to drop a pin');
    } finally {
      setSearching(false);
    }
  };

  const msg: Record<GpsState, string> = {
    idle: 'Location not set',
    locating: 'Finding your location...',
    ok: 'GPS location locked',
    denied: 'Location permission denied - enter an address or tap the map',
    unavailable: 'GPS unavailable - enter an address or tap the map',
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className={`text-sm ${gps === 'ok' ? 'text-success-fg' : gps === 'denied' || gps === 'unavailable' ? 'text-warning-fg' : 'text-ink-700'}`} role="status" aria-live="polite">
          {value && gps !== 'ok' ? 'Pin set on map' : msg[gps]}
        </p>
        <button type="button" className="btn-secondary btn-sm" onClick={locate}>Use my location</button>
      </div>
      <MapView
        className={mapClass}
        center={value ?? CHENNAI}
        zoom={value ? 16 : 11}
        onPick={onChange}
        recenterOn={value}
      >
        {value && <Marker position={value} icon={pinIcon('rgb(var(--brand-500))', '!', { pulse: true, size: 30 })} />}
      </MapView>
      <p className="text-xs text-ink-500">Tap the map to place or move the pin.</p>
      <div>
        <label htmlFor="addr" className="label">Address / landmark</label>
        <div className="flex gap-2">
          <input id="addr" className="input" value={address} onChange={(e) => onAddress(e.target.value)} placeholder="e.g. T Nagar bus stand" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void search(); } }} />
          <button type="button" className="btn-secondary" disabled={searching} onClick={() => void search()}>{searching ? '...' : 'Find'}</button>
        </div>
        {searchErr && <p className="mt-1 text-xs text-warning-fg" role="alert">{searchErr}</p>}
      </div>
    </div>
  );
}
