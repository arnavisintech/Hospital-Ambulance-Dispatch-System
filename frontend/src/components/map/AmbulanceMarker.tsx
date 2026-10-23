import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import L from 'leaflet';
import { Marker } from 'react-leaflet';
import { fmtEta } from '../../lib/format';
import { ambulanceStatusMeta, toneClasses } from '../../lib/status';
import type { LatLng } from '../../lib/types';
import { useGlide } from './useGlide';

export interface AmbulanceMarkerProps {
  position: LatLng;
  /** Server heading (deg, 0 = north). Movement bearing from gliding takes precedence while moving. */
  heading?: number | null;
  /** Ambulance status → status dot colour (lib/status). */
  status?: string;
  /** ETA chip above the marker: seconds (formatted "4 min") or a ready string. */
  eta?: number | string | null;
  /** Glide between position updates (default true). */
  glide?: boolean;
  /** Route polyline to glide along. */
  route?: LatLng[] | null;
  selected?: boolean;
  /** Tile size in px (default 36). */
  size?: number;
  /** Accessible name / native tooltip, e.g. registration number. */
  title?: string;
  onClick?: () => void;
  zIndexOffset?: number;
  /** <Tooltip>/<Popup> children. */
  children?: ReactNode;
}

function html(size: number, dotColor: string, chip: string | null, selected: boolean, heading: number) {
  const s = size;
  return `
<div class="hads-amb${selected ? ' hads-amb--selected' : ''}" style="width:${s}px;height:${s}px">
  <div class="hads-amb__rot" style="transform:rotate(${heading}deg)">
    <svg width="${s}" height="${s}" viewBox="0 0 40 40" style="overflow:visible">
      <path d="M20 -6.5 L25.5 1.5 Q20 -0.5 14.5 1.5 Z" fill="rgb(var(--ink-900))" stroke="rgb(var(--surface))" stroke-width="1.5" stroke-linejoin="round"/>
    </svg>
  </div>
  <svg width="${s}" height="${s}" viewBox="0 0 40 40" style="position:absolute;inset:0;overflow:visible;filter:drop-shadow(0 4px 6px rgba(16,24,40,.28))">
    <rect x="4" y="4" width="32" height="32" rx="10" fill="rgb(var(--surface))" stroke="rgb(var(--${selected ? 'brand-500' : 'line-strong'}))" stroke-width="${selected ? 2 : 1}"/>
    <rect x="17.5" y="11" width="5" height="18" rx="1.2" fill="rgb(var(--brand-500))"/>
    <rect x="11" y="17.5" width="18" height="5" rx="1.2" fill="rgb(var(--brand-500))"/>
  </svg>
  <span class="hads-amb__dot" style="background:${dotColor}"></span>
  ${chip ? `<span class="hads-chip">${chip}</span>` : ''}
</div>`;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Ambulance: upright white rounded tile with red cross, a dark heading nose that orbits the tile to show direction
 * (the cross itself never rotates — a 45° cross reads as an "X"), status dot, optional ETA chip.
 * Glides between pings (along `route` when given).
 */
export function AmbulanceMarker({
  position, heading, status = 'available', eta, glide = true, route, selected = false, size = 36, title, onClick, zIndexOffset = 500, children,
}: AmbulanceMarkerProps) {
  const g = useGlide(position, { route, enabled: glide });
  const rot = g.heading ?? heading ?? 0;
  const markerRef = useRef<L.Marker>(null);
  const chip = eta === undefined || eta === null || eta === '' ? null : escapeHtml(typeof eta === 'number' ? fmtEta(eta) : eta);
  const dot = toneClasses(ambulanceStatusMeta(status).tone).css;

  // Icon is rebuilt only when its look changes; rotation is patched on the DOM so it animates smoothly.
  const icon = useMemo(
    () => L.divIcon({ className: 'hads-marker', html: html(size, dot, chip, selected, 0), iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
    [size, dot, chip, selected],
  );
  useEffect(() => {
    const el = markerRef.current?.getElement()?.querySelector<HTMLElement>('.hads-amb__rot');
    if (el) el.style.transform = `rotate(${rot}deg)`;
  }, [rot, icon]);

  return (
    <Marker
      ref={markerRef}
      position={g.position ?? position}
      icon={icon}
      title={title}
      alt={title ? `Ambulance ${title}` : 'Ambulance'}
      keyboard={!!onClick}
      interactive={!!onClick || !!children}
      zIndexOffset={selected ? zIndexOffset + 200 : zIndexOffset}
      eventHandlers={onClick ? { click: onClick, keypress: (e) => { if ((e.originalEvent as KeyboardEvent).key === 'Enter') onClick(); } } : undefined}
    >
      {children}
    </Marker>
  );
}
