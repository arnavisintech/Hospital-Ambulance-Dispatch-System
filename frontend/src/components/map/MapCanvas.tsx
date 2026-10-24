import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { MapContainer, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import { LocateFixed, Minus, Plus } from 'lucide-react';
import { cn } from '../../lib/cn';
import { CITY_CENTER } from '../../lib/geo';
import type { LatLng } from '../../lib/types';
import { useIsDesktop } from '../../hooks/useMediaQuery';
import { OSM_FALLBACK, primaryTiles, type TileProvider } from '../../lib/mapTiles';

const PRIMARY = primaryTiles();
/** Active tile URL / attribution (see lib/mapTiles.ts for provider selection). */
export const TILE_URL = PRIMARY.url;
export const TILE_ATTRIBUTION = PRIMARY.attribution;

export interface MapInsets { top?: number; right?: number; bottom?: number; left?: number }
/**
 * Pixels of the map covered by app chrome (bottom sheet peek, floating bars). Provided automatically by
 * MobileAppLayout; read by MapCanvas controls and FitBounds so content is never hidden under overlays.
 */
export const MapInsetsContext = createContext<MapInsets>({});
export const useMapInsets = () => useContext(MapInsetsContext);

export interface MapCanvasProps {
  center?: LatLng;
  zoom?: number;
  minZoom?: number;
  maxZoom?: number;
  /** Size the map with classes (default 'h-full w-full'). The parent must give it height. */
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  /** Custom round zoom buttons: 'auto' = desktop only (phones pinch), true, false. Default 'auto'. */
  zoomControls?: 'auto' | boolean;
  /** Show a recenter button that flies here (e.g. user's location / ambulance). */
  recenterTo?: LatLng | null;
  /** Or handle recenter yourself (e.g. re-fit bounds). Shows the button when set. */
  onRecenter?: () => void;
  recenterLabel?: string;
  /** Pixels to keep controls clear of overlays (e.g. a bottom sheet's peek height). */
  controlsInset?: { top?: number; bottom?: number; right?: number };
  /** Swiggy-style location picking: the map moves under a fixed centre pin; `onChange` fires on moveend. */
  centerPin?: { onChange: (center: LatLng) => void; label?: ReactNode };
  scrollWheelZoom?: boolean;
  /** false = static preview (no drag/zoom/keyboard). */
  interactive?: boolean;
  onMapReady?: (map: L.Map) => void;
  /** Accessible label for the map region. */
  ariaLabel?: string;
}

/**
 * Light CARTO Voyager base map with HADS controls. All map primitives (markers, RouteLine, FitBounds…)
 * go inside as children.
 */
export function MapCanvas({
  center = CITY_CENTER, zoom = 13, minZoom = 10, maxZoom = 18, className, style, children, zoomControls = 'auto',
  recenterTo, onRecenter, recenterLabel = 'Recenter map', controlsInset, centerPin, scrollWheelZoom = true,
  interactive = true, onMapReady, ariaLabel = 'Map',
}: MapCanvasProps) {
  const isDesktop = useIsDesktop();
  const ctxInsets = useMapInsets();
  const inset = controlsInset ?? ctxInsets;
  const showZoom = interactive && (zoomControls === 'auto' ? isDesktop : zoomControls);
  const showRecenter = interactive && (!!recenterTo || !!onRecenter);
  return (
    <div className={cn('relative isolate h-full w-full overflow-hidden', className)} style={style} role="region" aria-label={ariaLabel}>
      <MapContainer
        center={center}
        zoom={zoom}
        minZoom={minZoom}
        maxZoom={maxZoom}
        zoomControl={false}
        attributionControl
        scrollWheelZoom={interactive && scrollWheelZoom}
        dragging={interactive}
        touchZoom={interactive}
        doubleClickZoom={interactive}
        keyboard={interactive}
        boxZoom={false}
        className="h-full w-full"
        zoomSnap={0.25}
        wheelPxPerZoomLevel={90}
      >
        <BaseTiles />
        <MapSetup onReady={onMapReady} />
        {children}
        {(showZoom || showRecenter) && (
          <MapControls showZoom={!!showZoom} recenterTo={recenterTo} onRecenter={onRecenter} recenterLabel={recenterLabel} inset={inset} />
        )}
        {centerPin && <CenterPin onChange={centerPin.onChange} label={centerPin.label} />}
      </MapContainer>
    </div>
  );
}

// Once the primary provider has proven unreliable, every map in this session uses the fallback.
let primaryFailed = false;

/** Primary provider with automatic fallback to OSM when tile errors dominate (e.g. blank tiles at street zoom). */
function BaseTiles() {
  const [provider, setProvider] = useState<TileProvider>(primaryFailed ? OSM_FALLBACK : PRIMARY);
  const stats = useRef({ ok: 0, err: 0 });
  return (
    <TileLayer
      key={provider.url}
      url={provider.url}
      attribution={provider.attribution}
      subdomains={provider.subdomains ?? 'abc'}
      maxZoom={20}
      maxNativeZoom={provider.maxNativeZoom}
      eventHandlers={{
        tileload: () => { stats.current.ok++; },
        tileerror: () => {
          stats.current.err++;
          const { ok, err } = stats.current;
          if (provider !== OSM_FALLBACK && err >= 4 && err > ok) {
            primaryFailed = true;
            setProvider(OSM_FALLBACK);
          }
        },
      }}
    />
  );
}

function MapSetup({ onReady }: { onReady?: (m: L.Map) => void }) {
  const map = useMap();
  useEffect(() => {
    map.attributionControl?.setPrefix('<a href="https://leafletjs.com" title="Leaflet">Leaflet</a>');
    onReady?.(map);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);
  return null;
}

/** Stops clicks / wheel on an overlay from reaching the map. */
function useMapOverlay<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!ref.current) return;
    L.DomEvent.disableClickPropagation(ref.current);
    L.DomEvent.disableScrollPropagation(ref.current);
  }, []);
  return ref;
}

const ctrlBtn = 'press flex h-11 w-11 items-center justify-center bg-surface text-ink-900 transition-colors hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500';

function MapControls({ showZoom, recenterTo, onRecenter, recenterLabel, inset }: {
  showZoom: boolean; recenterTo?: LatLng | null; onRecenter?: () => void; recenterLabel: string; inset?: MapCanvasProps['controlsInset'];
}) {
  const map = useMap();
  const ref = useMapOverlay<HTMLDivElement>();
  return (
    <div
      ref={ref}
      className="absolute z-[1000] flex flex-col items-end gap-3"
      style={{ right: (inset?.right ?? 0) + 12, bottom: (inset?.bottom ?? 0) + 24 }}
    >
      {(recenterTo || onRecenter) && (
        <RecenterButton label={recenterLabel} onClick={() => (onRecenter ? onRecenter() : recenterTo && map.flyTo(recenterTo, Math.max(map.getZoom(), 15), { duration: 0.6 }))} />
      )}
      {showZoom && (
        <div className="flex flex-col overflow-hidden rounded-full border border-line/70 shadow-raised">
          <button type="button" className={ctrlBtn} aria-label="Zoom in" title="Zoom in" onClick={() => map.zoomIn()}><Plus size={20} aria-hidden /></button>
          <span className="h-px bg-line" aria-hidden />
          <button type="button" className={ctrlBtn} aria-label="Zoom out" title="Zoom out" onClick={() => map.zoomOut()}><Minus size={20} aria-hidden /></button>
        </div>
      )}
    </div>
  );
}

/** Round floating "recenter" button (also usable standalone over a map). */
export function RecenterButton({ onClick, label = 'Recenter map', className }: { onClick: () => void; label?: string; className?: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label}
      className={cn(ctrlBtn, 'rounded-full border border-line/70 shadow-raised', className)}>
      <LocateFixed size={20} aria-hidden />
    </button>
  );
}

/** Fixed centre pin; lifts while the map moves and reports the centre on moveend. */
function CenterPin({ onChange, label }: { onChange: (c: LatLng) => void; label?: ReactNode }) {
  const [moving, setMoving] = useState(false);
  const cb = useRef(onChange);
  useEffect(() => { cb.current = onChange; });
  const map = useMapEvents({
    movestart: () => setMoving(true),
    moveend: () => {
      setMoving(false);
      const c = map.getCenter();
      cb.current([c.lat, c.lng]);
    },
  });
  useEffect(() => {
    const c = map.getCenter();
    cb.current([c.lat, c.lng]);
  }, [map]);
  return (
    <div className="pointer-events-none absolute left-1/2 top-1/2 z-[1000]" style={{ transform: 'translate(-50%, -100%)' }} aria-hidden>
      <div className="relative flex flex-col items-center">
        {label && !moving && (
          <div className="mb-2 max-w-[220px] animate-fade-in rounded-md bg-ink-900 px-3 py-2 text-center text-xs font-semibold leading-snug text-white shadow-raised">
            {label}
          </div>
        )}
        <div className={cn('transition-transform duration-standard ease-out', moving ? '-translate-y-3' : 'translate-y-0')}>
          <PinSvg />
        </div>
        {/* ground shadow */}
        <span
          className={cn('absolute -bottom-1 h-1.5 rounded-full bg-ink-900/25 blur-[1px] transition-all duration-standard', moving ? 'w-3 opacity-60' : 'w-5 opacity-100')}
        />
      </div>
    </div>
  );
}

export function PinSvg({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size * 1.25} viewBox="0 0 32 40" style={{ filter: 'drop-shadow(0 6px 8px rgba(16,24,40,.25))' }}>
      <path d="M16 0C7.2 0 0 7 0 15.7 0 27.4 16 40 16 40s16-12.6 16-24.3C32 7 24.8 0 16 0Z" fill="rgb(var(--brand-500))" />
      <circle cx="16" cy="15.5" r="6" fill="rgb(var(--surface))" />
    </svg>
  );
}
