import { useEffect, type ReactNode } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { MapContainer, Marker, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import { CHENNAI } from '../lib/geo';
import { TILE_ATTRIBUTION, TILE_URL } from './map/MapCanvas';
import type { LatLng } from '../lib/types';

export function pinIcon(color: string, glyph = '', opts: { pulse?: boolean; size?: number } = {}): L.DivIcon {
  const size = opts.size ?? 26;
  return L.divIcon({
    className: 'hads-marker',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    html: `<div style="position:relative;width:${size}px;height:${size}px;color:${color}" class="${opts.pulse ? 'pulse' : ''}">
      <div style="width:100%;height:100%;border-radius:9999px;background:${color};border:2px solid rgb(var(--surface));display:flex;align-items:center;justify-content:center;font:700 ${Math.round(size * 0.46)}px/1 system-ui;color:rgb(var(--surface));box-shadow:0 2px 6px rgba(16,24,40,.3)">${glyph}</div></div>`,
  });
}

function Fit({ points, enabled }: { points: LatLng[]; enabled: boolean }) {
  const map = useMap();
  const key = points.map((p) => p.join(',')).join('|');
  useEffect(() => {
    if (!enabled || points.length === 0) return;
    if (points.length === 1) map.setView(points[0], Math.max(map.getZoom(), 14));
    else map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 16 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, map]);
  return null;
}

function Clicker({ onPick }: { onPick: (p: LatLng) => void }) {
  useMapEvents({ click: (e) => onPick([e.latlng.lat, e.latlng.lng]) });
  return null;
}

function Recenter({ center }: { center: LatLng }) {
  const map = useMap();
  useEffect(() => { map.setView(center, Math.max(map.getZoom(), 15)); }, [center[0], center[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

export interface MapViewProps {
  className?: string;
  center?: LatLng;
  zoom?: number;
  fitPoints?: LatLng[];
  onPick?: (p: LatLng) => void;
  recenterOn?: LatLng | null;
  children?: ReactNode;
}

export function MapView({ className = 'h-72 w-full', center = CHENNAI, zoom = 12, fitPoints = [], onPick, recenterOn, children }: MapViewProps) {
  return (
    <MapContainer center={center} zoom={zoom} className={`${className} rounded-lg`} scrollWheelZoom aria-label="Map">
      <TileLayer attribution={TILE_ATTRIBUTION} url={TILE_URL} subdomains="abcd" maxZoom={20} />
      <Fit points={fitPoints} enabled={fitPoints.length > 0} />
      {onPick && <Clicker onPick={onPick} />}
      {recenterOn && <Recenter center={recenterOn} />}
      {children}
    </MapContainer>
  );
}

export { Marker };
