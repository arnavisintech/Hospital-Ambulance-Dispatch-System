import { useEffect, useRef, type ReactNode } from 'react';
import L from 'leaflet';
import { CircleMarker, Tooltip, useMap } from 'react-leaflet';
import { tokenRgbTuple, type TokenName } from '../../lib/tokens';

export interface HeatPoint {
  lat: number;
  lng: number;
  /** Intensity (any scale — normalised by `max` or the data max). */
  value: number;
}

export interface RiskHeatLayerProps<Z extends { lat: number; lng: number }> {
  zones: Z[];
  /** Value accessor. Default: `zone.risk`. */
  getValue?: (z: Z) => number;
  /** Influence radius in metres (scales with zoom). Default 900. */
  radiusM?: number;
  /** Value treated as 100% (default: max of data). */
  max?: number;
  /** Overall layer opacity 0..1. Default 0.7. */
  opacity?: number;
  /** Optional hover tooltip per zone (renders invisible hit targets). */
  renderTooltip?: (z: Z) => ReactNode;
}

/** Colour ramp (low → high risk) from design tokens. */
const RAMP: [number, TokenName][] = [[0.0, 'success'], [0.35, 'success'], [0.55, 'warning'], [0.75, 'orange'], [1.0, 'brand-600']];

function buildPalette(): Uint8ClampedArray {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 1;
  const ctx = c.getContext('2d');
  if (!ctx) return new Uint8ClampedArray(1024);
  const g = ctx.createLinearGradient(0, 0, 256, 0);
  RAMP.forEach(([stop, name]) => { const [r, gg, b] = tokenRgbTuple(name); g.addColorStop(stop, `rgb(${r},${gg},${b})`); });
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 1);
  return ctx.getImageData(0, 0, 256, 1).data;
}

/** Canvas heat layer (simpleheat technique): alpha-accumulated radial blobs, colourised through a palette. */
class HeatCanvas extends L.Layer {
  private canvas?: HTMLCanvasElement;
  private points: HeatPoint[] = [];
  private palette?: Uint8ClampedArray;
  constructor(private opts: { radiusM: number; max?: number; opacity: number }) { super(); }

  setData(points: HeatPoint[], opts: { radiusM: number; max?: number; opacity: number }) {
    this.points = points;
    this.opts = opts;
    this.redraw();
  }

  onAdd(map: L.Map) {
    this.canvas = L.DomUtil.create('canvas', 'hads-heat') as HTMLCanvasElement;
    Object.assign(this.canvas.style, { position: 'absolute', pointerEvents: 'none', transition: 'opacity 150ms ease' });
    map.getPanes().overlayPane.appendChild(this.canvas);
    map.on('moveend resize zoomend viewreset', this.redraw, this);
    map.on('zoomstart', this.hide, this);
    this.redraw();
    return this;
  }

  onRemove(map: L.Map) {
    map.off('moveend resize zoomend viewreset', this.redraw, this);
    map.off('zoomstart', this.hide, this);
    this.canvas?.remove();
    this.canvas = undefined;
    return this;
  }

  private hide() { if (this.canvas) this.canvas.style.opacity = '0'; }

  redraw() {
    const map = this._map as L.Map | undefined;
    const canvas = this.canvas;
    if (!map || !canvas) return;
    const size = map.getSize();
    L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));
    canvas.width = size.x;
    canvas.height = size.y;
    canvas.style.width = `${size.x}px`;
    canvas.style.height = `${size.y}px`;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx || size.x === 0 || size.y === 0) return;
    ctx.clearRect(0, 0, size.x, size.y);
    if (this.points.length === 0) return;

    const lat = map.getCenter().lat;
    const mPerPx = (40075016.686 * Math.cos((lat * Math.PI) / 180)) / 2 ** (map.getZoom() + 8);
    const r = Math.max(14, Math.min(260, this.opts.radiusM / mPerPx));
    const max = this.opts.max ?? Math.max(...this.points.map((p) => p.value), 1e-9);

    for (const p of this.points) {
      const pt = map.latLngToContainerPoint([p.lat, p.lng]);
      if (pt.x < -r || pt.y < -r || pt.x > size.x + r || pt.y > size.y + r) continue;
      const a = Math.max(0.03, Math.min(1, p.value / max));
      const g = ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, r);
      g.addColorStop(0, `rgba(0,0,0,${a})`);
      g.addColorStop(0.45, `rgba(0,0,0,${a * 0.6})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    this.palette ??= buildPalette();
    const img = ctx.getImageData(0, 0, size.x, size.y);
    const d = img.data, pal = this.palette;
    for (let i = 3; i < d.length; i += 4) {
      const alpha = d[i];
      if (!alpha) continue;
      const k = Math.min(255, alpha) * 4;
      d[i - 3] = pal[k]; d[i - 2] = pal[k + 1]; d[i - 1] = pal[k + 2];
      // Low intensity fades out so calm areas keep the base map clean; hotspots stay vivid.
      const k01 = alpha / 255;
      d[i] = Math.min(255, 255 * this.opts.opacity * Math.pow(k01, 0.9) * (0.25 + 0.75 * k01) * 1.6);
    }
    ctx.putImageData(img, 0, 0);
    canvas.style.opacity = '1';
  }
}

/** Smooth risk heat map (FR3 risk zones / coverage gaps). */
export function RiskHeatLayer<Z extends { lat: number; lng: number }>({
  zones, getValue, radiusM = 900, max, opacity = 0.7, renderTooltip,
}: RiskHeatLayerProps<Z>) {
  const map = useMap();
  const layer = useRef<HeatCanvas | null>(null);
  const valueOf = getValue ?? ((z: Z) => Number((z as unknown as { risk?: number }).risk ?? 0));

  useEffect(() => {
    const l = new HeatCanvas({ radiusM, max, opacity });
    layer.current = l;
    l.addTo(map);
    return () => { l.remove(); layer.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);

  useEffect(() => {
    layer.current?.setData(zones.map((z) => ({ lat: z.lat, lng: z.lng, value: valueOf(z) })), { radiusM, max, opacity });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zones, radiusM, max, opacity]);

  if (!renderTooltip) return null;
  return (
    <>
      {zones.map((z, i) => (
        <CircleMarker key={i} center={[z.lat, z.lng]} radius={16} pathOptions={{ opacity: 0, fillOpacity: 0 }}>
          <Tooltip direction="top">{renderTooltip(z)}</Tooltip>
        </CircleMarker>
      ))}
    </>
  );
}
