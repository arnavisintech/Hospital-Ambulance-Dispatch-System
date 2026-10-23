import { useCallback, useEffect, useRef, useState } from 'react';
import type { WsMessage } from '../../lib/types';
import { applyLiveEvent, type LiveOverlay } from './trip';

/**
 * Holds the WebSocket "live overlay" (ambulance position, ETA, route) on top of the last REST payload.
 * The overlay is cleared whenever a fresh payload arrives (`base` identity changes). Events that need a full
 * reload call `refetch` (debounced so a burst of events costs one request).
 */
export function useLiveOverlay(base: unknown, refetch: () => void) {
  const [overlay, setOverlay] = useState<LiveOverlay>({});
  const refetchRef = useRef(refetch);
  useEffect(() => { refetchRef.current = refetch; });
  const timer = useRef<ReturnType<typeof setTimeout>>();

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setOverlay({}); }, [base]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const onMessage = useCallback((m: WsMessage) => {
    setOverlay((prev) => applyLiveEvent(prev, m).overlay);
    // Whether a reload is needed depends only on the message, not on the previous overlay.
    if (applyLiveEvent({}, m).refetch) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => refetchRef.current(), 250);
    }
  }, []);

  return { overlay, onMessage };
}
