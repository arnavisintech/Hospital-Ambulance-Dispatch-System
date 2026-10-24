/**
 * Registers the service worker (public/sw.js) that keeps the app shell, and so the SOS screen, loadable offline.
 * Production builds only: in development it would cache Vite's modules and hide code changes.
 */
export async function registerServiceWorker(
  nav: Pick<Navigator, 'serviceWorker'> = navigator,
  env: { PROD: boolean } = import.meta.env,
): Promise<boolean> {
  if (!env.PROD || !nav || !('serviceWorker' in nav) || !nav.serviceWorker) return false;
  try {
    await nav.serviceWorker.register('/sw.js');
    return true;
  } catch {
    return false; // offline support is an enhancement; never break the app over it
  }
}
