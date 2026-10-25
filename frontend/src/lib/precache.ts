/**
 * Build step for the service worker (public/sw.js): writes the list of hashed build assets into it, so a new release
 * changes sw.js byte-for-byte (browsers then install the new worker), every route chunk is cached up front (the SOS
 * screen opens offline even if it was never visited), and the worker can prune assets left over from older builds.
 */
import type { Plugin } from 'vite';

export const PRECACHE_MARKER = '[] /*__HADS_ASSETS__*/';

export function injectPrecache(sw: string, files: string[]): string {
  const assets = files.filter((f) => f.startsWith('assets/')).sort().map((f) => `/${f}`);
  return sw.replace(PRECACHE_MARKER, JSON.stringify(assets));
}

export function precachePlugin(): Plugin {
  let files: string[] = [];
  return {
    name: 'hads-precache',
    apply: 'build',
    generateBundle(_opts, bundle) { files = Object.keys(bundle); },
    async writeBundle(opts) {
      const { readFile, writeFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const path = join(opts.dir ?? 'dist', 'sw.js');
      const src = await readFile(path, 'utf8');
      if (!src.includes(PRECACHE_MARKER)) throw new Error('sw.js is missing the precache marker');
      await writeFile(path, injectPrecache(src, files));
    },
  };
}
