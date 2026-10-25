/**
 * Base-map tile provider selection.
 *
 * DESIGN_SYSTEM.md specifies CARTO Voyager, but CARTO basemaps now return an "API KEY REQUIRED" watermark tile
 * without a key. Resolution order:
 *   1. VITE_MAP_TILE_URL (+ VITE_MAP_TILE_ATTRIBUTION)        — any custom XYZ provider
 *   2. VITE_CARTO_API_KEY                                      — CARTO Voyager (the spec'd look)
 *   3. default: Stadia "Alidade Smooth" (light, premium look; keyless on localhost, deployed domains must be
 *      registered free at stadiamaps.com or set VITE_STADIA_API_KEY)
 * MapCanvas additionally falls back to OSM_FALLBACK if the chosen provider keeps failing.
 */
export interface TileProvider { url: string; attribution: string; subdomains?: string; maxNativeZoom?: number }

const env = import.meta.env as Record<string, string | undefined>;
const OSM = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

export const CARTO_VOYAGER: TileProvider = {
  url: `https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png${env.VITE_CARTO_API_KEY ? `?api_key=${env.VITE_CARTO_API_KEY}` : ''}`,
  attribution: `${OSM} &copy; <a href="https://carto.com/attributions">CARTO</a>`,
  subdomains: 'abcd',
};

export const STADIA_SMOOTH: TileProvider = {
  url: `https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png${env.VITE_STADIA_API_KEY ? `?api_key=${env.VITE_STADIA_API_KEY}` : ''}`,
  attribution: `&copy; <a href="https://stadiamaps.com/">Stadia Maps</a> &copy; <a href="https://openmaptiles.org/">OpenMapTiles</a> ${OSM}`,
  maxNativeZoom: 20,
};

export const OSM_FALLBACK: TileProvider = {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: OSM,
  maxNativeZoom: 19,
};

export function primaryTiles(): TileProvider {
  if (env.VITE_MAP_TILE_URL) return { url: env.VITE_MAP_TILE_URL, attribution: env.VITE_MAP_TILE_ATTRIBUTION ?? OSM };
  if (env.VITE_CARTO_API_KEY) return CARTO_VOYAGER;
  return STADIA_SMOOTH;
}

/** No tile within this window (and no error either) means the provider is hanging, e.g. blocked on this network. */
export const TILE_STALL_MS = 6000;

/** Switch to OSM_FALLBACK when errors dominate, or when nothing has loaded or failed within the stall window. */
export function shouldFallBack(stats: { ok: number; err: number }, elapsedMs: number): boolean {
  if (stats.err >= 4 && stats.err > stats.ok) return true;
  return stats.ok === 0 && elapsedMs >= TILE_STALL_MS;
}
