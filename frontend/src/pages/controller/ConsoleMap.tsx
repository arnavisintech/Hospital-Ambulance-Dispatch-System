import { memo, useEffect, useMemo, useRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import L from 'leaflet';
import { Marker } from 'react-leaflet';
import {
  AmbulanceMarker, FitBounds, HospitalMarker, MapCanvas, RiskHeatLayer, RouteLine, StationMarker, Tooltip, useMap,
} from '../../components/map';
import { demographicsLine, fmtAge } from '../../lib/format';
import { ambulanceStatusMeta, incidentMeta, severityMeta, toneClasses } from '../../lib/status';
import type { AmbulanceBrief, HospitalBrief, LatLng, RequestOut, RiskZone } from '../../lib/types';
import { ROUTED, type BoardStation, type LiveBoard } from './board';

export interface Layers { units: boolean; hospitals: boolean; stations: boolean; routes: boolean; risk: boolean }
export const DEFAULT_LAYERS: Layers = { units: true, hospitals: true, stations: true, routes: true, risk: false };

export interface MoveLine { id: number; from: LatLng; to: LatLng }

export interface ConsoleMapProps {
  live: LiveBoard;
  selectedId: number | null;
  onSelect: (id: number) => void;
  layers: Layers;
  riskZones?: RiskZone[] | null;
  /** Rebalance previews (dashed from → to). */
  moves?: MoveLine[];
  /** Fly here when `focus.key` changes. */
  focus?: { at: LatLng; key: string; zoom?: number; exact?: boolean } | null;
  /** Pixels covered by floating UI (keeps zoom buttons clear). */
  controlsInset?: { top?: number; bottom?: number; right?: number };
  onRecenter?: () => void;
}

/* ------------------------------------------------------------------ request pin (severity coloured) */

const iconCache = new Map<string, string>();
function incidentSvg(type: string): string {
  const hit = iconCache.get(type);
  if (hit) return hit;
  const Icon = incidentMeta(type).icon;
  const svg = renderToStaticMarkup(<Icon size={15} strokeWidth={2.4} color="currentColor" aria-hidden />);
  iconCache.set(type, svg);
  return svg;
}

function requestIcon(r: RequestOut, escalated: boolean, selected: boolean): L.DivIcon {
  const sev = severityMeta(r.severity);
  const color = toneClasses(sev.tone).css;
  const w = selected ? 40 : 32, h = Math.round(w * 1.25);
  const pulse = escalated || r.status === 'received' || r.status === 'matching';
  return L.divIcon({
    className: 'hads-marker',
    iconSize: [w, h],
    iconAnchor: [w / 2, h - 2],
    html: `
<div style="position:relative;width:${w}px;height:${h}px">
  ${pulse ? `<span style="position:absolute;left:${w / 2 - 9}px;bottom:-7px;width:18px;height:18px;color:${escalated ? 'rgb(var(--brand-500))' : color}"><span class="hads-pulse"></span><span class="hads-pulse hads-pulse--delay"></span></span>` : ''}
  <svg width="${w}" height="${h}" viewBox="0 0 32 40" style="position:absolute;inset:0;filter:drop-shadow(0 4px 6px rgba(16,24,40,.28))">
    <path d="M16 0C7.2 0 0 7 0 15.7 0 27.4 16 40 16 40s16-12.6 16-24.3C32 7 24.8 0 16 0Z" fill="${color}" stroke="rgb(var(--surface))" stroke-width="${selected ? 2.2 : 1.6}"/>
    <circle cx="16" cy="15.5" r="10" fill="rgb(var(--surface))"/>
  </svg>
  <span style="position:absolute;left:0;right:0;top:${selected ? 8 : 5}px;display:flex;justify-content:center;color:${color}">${incidentSvg(r.incident_type)}</span>
  ${escalated ? `<span style="position:absolute;top:-4px;right:-6px;width:14px;height:14px;border-radius:9999px;background:rgb(var(--brand-500));border:2px solid rgb(var(--surface));color:#fff;font:800 9px/10px 'Plus Jakarta Sans',system-ui;text-align:center">!</span>` : ''}
</div>`,
  });
}

const RequestPin = memo(function RequestPin({ r, escalated, selected, onSelect }: { r: RequestOut; escalated: boolean; selected: boolean; onSelect: (id: number) => void }) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const icon = useMemo(() => requestIcon(r, escalated, selected), [r.severity, r.incident_type, r.status, escalated, selected]);
  const inc = incidentMeta(r.incident_type), sev = severityMeta(r.severity);
  const label = `Request #${r.id}, ${inc.short}, ${sev.label}${r.zone_label ? `, ${r.zone_label}` : ''}`;
  return (
    <Marker
      position={[r.lat, r.lng]} icon={icon} alt={label} title={label} keyboard
      zIndexOffset={selected ? 1200 : escalated ? 900 : 600}
      eventHandlers={{ click: () => onSelect(r.id) }}
    >
      <Tooltip direction="top" offset={[0, -36]}>
        <span className="block font-bold">#{r.id} · {inc.short}</span>
        <span className="block font-medium text-ink-500">{sev.label}{r.zone_label ? ` · ${r.zone_label}` : ''}</span>
      </Tooltip>
    </Marker>
  );
});

/* ------------------------------------------------------------------ helpers */

function FlyTo({ focus, offsetX = 0 }: { focus: ConsoleMapProps['focus']; offsetX?: number }) {
  const map = useMap();
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (!focus || focus.key === last.current) return;
    last.current = focus.key;
    const z = focus.exact ? (focus.zoom ?? 12) : Math.max(map.getZoom(), focus.zoom ?? 14);
    // Keep the target visible beside a panel covering `offsetX` px on the right.
    const c = offsetX ? map.unproject(map.project(focus.at, z).add([offsetX / 2, 0]), z) : focus.at;
    map.flyTo(c, z, { duration: 0.7 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, map]);
  return null;
}

function HospitalTip({ h }: { h: HospitalBrief }) {
  return (
    <>
      <span className="block font-bold">{h.name}</span>
      <span className="block font-medium tabular-nums">
        {h.available_beds ?? '?'} beds · {h.available_icu ?? '?'} ICU
      </span>
      <span className={h.stale ? 'block font-semibold text-warning-fg' : 'block font-medium text-ink-500'}>
        {h.stale ? 'Capacity may be outdated · ' : 'Updated '}{fmtAge(h.capacity_age_min)}
      </span>
    </>
  );
}

function AmbTip({ a, req }: { a: AmbulanceBrief; req?: RequestOut }) {
  const m = ambulanceStatusMeta(a.status);
  return (
    <>
      <span className="block font-bold">{a.registration_number}{a.kind ? ` · ${a.kind}` : ''}</span>
      <span className="block font-medium">{m.label}{req ? ` · Request #${req.id}` : ''}</span>
      <span className="block font-medium text-ink-500">{[a.crew_name, a.station_name].filter(Boolean).join(' · ') || '—'}</span>
    </>
  );
}

/* ------------------------------------------------------------------ map */

export function ConsoleMap({ live, selectedId, onSelect, layers, riskZones, moves, focus, controlsInset, onRecenter }: ConsoleMapProps) {
  const { board, routes } = live;
  const esc = useMemo(() => new Set(board.escalations), [board.escalations]);
  const selected = board.requests.find((r) => r.id === selectedId) ?? null;
  const reqById = useMemo(() => new Map(board.requests.map((r) => [r.id, r])), [board.requests]);
  const reqByAmb = useMemo(() => {
    const m = new Map<number, RequestOut>();
    board.requests.forEach((r) => { if (r.ambulance?.id !== undefined) m.set(r.ambulance.id, r); });
    return m;
  }, [board.requests]);

  return (
    <MapCanvas zoom={12} ariaLabel="Live dispatch map" controlsInset={controlsInset} onRecenter={onRecenter} recenterLabel="Show whole city">
      {layers.risk && riskZones && riskZones.length > 0 && (
        <RiskHeatLayer
          zones={riskZones}
          radiusM={1100}
          renderTooltip={(z) => (
            <>
              <span className="block font-bold">{z.zone_label ?? `Zone ${z.zone_id}`}</span>
              <span className="block font-medium tabular-nums">Risk {(z.risk <= 1 ? z.risk * 100 : z.risk).toFixed(0)}% · ~{z.expected_demand.toFixed(1)} calls/h</span>
              {demographicsLine(z) && <span className="block tabular-nums">{demographicsLine(z)}</span>}
            </>
          )}
        />
      )}

      {layers.stations && (board.stations as BoardStation[]).map((s) => (
        <StationMarker key={`s${s.id}`} position={[s.lat, s.lng]} name={`${s.name}${s.is_active === false ? ' (inactive)' : ''}`} available={s.available} total={s.ambulances} />
      ))}

      {moves && moves.length > 0 && <FitBounds padding={64} maxZoom={14} insets={{ right: controlsInset?.right ?? 0 }} points={moves.flatMap((m) => [m.from, m.to])} />}
      {moves?.map((m) => <RouteLine key={`mv${m.id}`} positions={[m.from, m.to]} phase="to_hospital" dashed weight={3} />)}

      {layers.routes && board.requests.map((r) => {
        const route = routes[r.id];
        if (!route || !ROUTED.has(r.status) || route.polyline.length < 2) return null;
        return <RouteLine key={`rt${r.id}`} positions={route.polyline} phase={route.phase ?? (r.status === 'transporting' ? 'to_hospital' : 'to_patient')} weight={r.id === selectedId ? 5 : 4} />;
      })}

      {layers.hospitals && board.hospitals.map((h) => (
        <HospitalMarker
          key={`h${h.id}`} position={[h.lat, h.lng]} name={h.name} beds={h.available_beds} icu={h.available_icu} stale={h.stale}
          selected={selected?.destination_hospital?.id === h.id}
        >
          <Tooltip direction="top" offset={[0, -20]}><HospitalTip h={h} /></Tooltip>
        </HospitalMarker>
      ))}

      {board.requests.map((r) => (
        <RequestPin key={`r${r.id}`} r={r} escalated={esc.has(r.id) || r.status === 'awaiting_manual'} selected={r.id === selectedId} onSelect={onSelect} />
      ))}

      {layers.units && board.ambulances.map((a) => {
        if (a.lat == null || a.lng == null) return null;
        const req = reqByAmb.get(a.id) ?? (a.request_id ? reqById.get(a.request_id) : undefined);
        const isSel = !!selected && req?.id === selected.id;
        return (
          <AmbulanceMarker
            key={`a${a.id}`}
            position={[a.lat, a.lng]}
            heading={a.heading_deg}
            status={a.status}
            route={req ? routes[req.id]?.polyline : undefined}
            eta={isSel ? (selected.eta_seconds ?? null) : null}
            selected={isSel}
            size={isSel ? 38 : 30}
            title={a.registration_number}
            onClick={req ? () => onSelect(req.id) : undefined}
          >
            <Tooltip direction="top" offset={[0, -18]}><AmbTip a={a} req={req} /></Tooltip>
          </AmbulanceMarker>
        );
      })}

      <FitBounds once padding={56} maxZoom={13} points={board.requests.length ? board.requests.map((r) => [r.lat, r.lng] as LatLng) : board.hospitals.map((h) => [h.lat, h.lng] as LatLng)} />
      <FlyTo focus={focus} offsetX={controlsInset?.right ?? 0} />
    </MapCanvas>
  );
}
