import { useMemo, type ReactNode } from 'react';
import L from 'leaflet';
import { Marker, Tooltip } from 'react-leaflet';
import type { LatLng } from '../../lib/types';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const SHADOW = 'filter:drop-shadow(0 4px 6px rgba(16,24,40,.25))';

/* ------------------------------------------------------------------ PatientPin */

export interface PatientPinProps {
  position: LatLng;
  /** Small dark label above the pin, e.g. "Pickup" / "You". */
  label?: string;
  /** Pulse ring (default true). */
  pulse?: boolean;
  draggable?: boolean;
  onDragEnd?: (p: LatLng) => void;
  children?: ReactNode;
}

/** Patient / pickup location: brand teardrop with pulse ring. Anchored at the tip. */
export function PatientPin({ position, label, pulse = true, draggable, onDragEnd, children }: PatientPinProps) {
  const icon = useMemo(() => L.divIcon({
    className: 'hads-marker',
    iconSize: [36, 46],
    iconAnchor: [18, 44],
    html: `
<div style="position:relative;width:36px;height:46px">
  ${pulse ? `<span style="position:absolute;left:9px;bottom:-7px;width:18px;height:18px;color:rgb(var(--brand-500))"><span class="hads-pulse"></span><span class="hads-pulse hads-pulse--delay"></span></span>` : ''}
  <span style="position:absolute;left:14px;bottom:-2px;width:8px;height:4px;border-radius:50%;background:rgb(var(--ink-900) / .25)"></span>
  <svg width="36" height="44" viewBox="0 0 32 40" style="position:absolute;top:0;left:0;${SHADOW}">
    <path d="M16 0C7.2 0 0 7 0 15.7 0 27.4 16 40 16 40s16-12.6 16-24.3C32 7 24.8 0 16 0Z" fill="rgb(var(--brand-500))"/>
    <circle cx="16" cy="15.5" r="6" fill="rgb(var(--surface))"/>
  </svg>
  ${label ? `<span class="hads-chip" style="bottom:calc(100% + 4px)">${esc(label)}</span>` : ''}
</div>`,
  }), [label, pulse]);
  return (
    <Marker
      position={position}
      icon={icon}
      draggable={draggable}
      zIndexOffset={400}
      alt={label ?? 'Patient location'}
      keyboard={!!draggable}
      eventHandlers={onDragEnd ? { dragend: (e) => { const ll = (e.target as L.Marker).getLatLng(); onDragEnd([ll.lat, ll.lng]); } } : undefined}
    >
      {children}
    </Marker>
  );
}

/* ------------------------------------------------------------------ HospitalMarker */

export interface HospitalMarkerProps {
  position: LatLng;
  name?: string;
  /** Available beds → badge (green > 5, amber 1-5, red 0). Omit to hide the badge. */
  beds?: number | null;
  icu?: number | null;
  /** Capacity data is stale → grey "?" badge. */
  stale?: boolean;
  /** Highlight as the destination. */
  selected?: boolean;
  onClick?: () => void;
  /** Custom <Tooltip>/<Popup>; default tooltip = name + beds. */
  children?: ReactNode;
}

/** Hospital: white circle with teal "H" and a beds badge. */
export function HospitalMarker({ position, name, beds, icu, stale, selected, onClick, children }: HospitalMarkerProps) {
  const s = selected ? 40 : 32;
  const icon = useMemo(() => {
    const hasBeds = beds !== undefined && beds !== null;
    const badgeBg = stale ? 'rgb(var(--ink-400))' : !hasBeds ? '' : beds! <= 0 ? 'rgb(var(--brand-500))' : beds! <= 5 ? 'rgb(var(--warning))' : 'rgb(var(--success))';
    const badge = stale ? '?' : hasBeds ? String(beds) : '';
    return L.divIcon({
      className: 'hads-marker',
      iconSize: [s, s],
      iconAnchor: [s / 2, s / 2],
      html: `
<div style="position:relative;width:${s}px;height:${s}px;${SHADOW}">
  <div style="width:100%;height:100%;border-radius:9999px;background:rgb(var(--surface));border:${selected ? 3 : 2}px solid rgb(var(--teal));display:flex;align-items:center;justify-content:center;font:800 ${selected ? 18 : 15}px/1 'Plus Jakarta Sans',system-ui,sans-serif;color:rgb(var(--teal))">H</div>
  ${badge ? `<span style="position:absolute;top:-6px;right:-10px;min-width:20px;height:18px;padding:0 5px;border-radius:9999px;background:${badgeBg};color:rgb(var(--surface));font:700 11px/18px 'Plus Jakarta Sans',system-ui,sans-serif;text-align:center;font-variant-numeric:tabular-nums;border:2px solid rgb(var(--surface));box-sizing:content-box">${badge}</span>` : ''}
</div>`,
    });
  }, [beds, stale, selected, s]);
  const label = name ? `${name}${beds !== undefined && beds !== null ? ` · ${beds} beds` : ''}${icu !== undefined && icu !== null ? ` · ${icu} ICU` : ''}${stale ? ' · capacity unknown' : ''}` : undefined;
  return (
    <Marker
      position={position}
      icon={icon}
      alt={label ?? 'Hospital'}
      zIndexOffset={selected ? 300 : 100}
      keyboard={!!onClick}
      eventHandlers={onClick ? { click: onClick } : undefined}
    >
      {children ?? (label && <Tooltip direction="top" offset={[0, -s / 2 - 4]}>{label}</Tooltip>)}
    </Marker>
  );
}

/* ------------------------------------------------------------------ StationMarker */

export interface StationMarkerProps {
  position: LatLng;
  name?: string;
  /** Available / total ambulances shown in the tooltip. */
  available?: number;
  total?: number;
  onClick?: () => void;
  children?: ReactNode;
}

/** Ambulance station: small ink square. */
export function StationMarker({ position, name, available, total, onClick, children }: StationMarkerProps) {
  const icon = useMemo(() => L.divIcon({
    className: 'hads-marker',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
    html: `<div style="width:16px;height:16px;border-radius:4px;background:rgb(var(--ink-900));border:2px solid rgb(var(--surface));box-shadow:0 1px 3px rgba(16,24,40,.35);display:flex;align-items:center;justify-content:center"><span style="width:4px;height:4px;border-radius:1px;background:rgb(var(--surface))"></span></div>`,
  }), []);
  const label = name ? `${name}${available !== undefined ? ` · ${available}${total !== undefined ? `/${total}` : ''} available` : ''}` : undefined;
  return (
    <Marker position={position} icon={icon} alt={label ?? 'Station'} zIndexOffset={0} keyboard={!!onClick} eventHandlers={onClick ? { click: onClick } : undefined}>
      {children ?? (label && <Tooltip direction="top" offset={[0, -10]}>{label}</Tooltip>)}
    </Marker>
  );
}
