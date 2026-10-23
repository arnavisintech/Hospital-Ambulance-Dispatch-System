import { useRef } from 'react';
import { useParams } from 'react-router-dom';
import { MobileAppLayout } from '../../components/layout/MobileAppLayout';
import { ErrorState, LoadingBlock } from '../../components/ui';
import { useReportConnection } from '../../context/ConnectionContext';
import { useAsync } from '../../hooks/useAsync';
import { useSocket } from '../../hooks/useSocket';
import { get } from '../../lib/api';
import type { Tracking, WsMessage } from '../../lib/types';
import { TrackLive } from './TrackLive';
import { TripDone } from './TripDone';
import { tripStage } from './trip';
import { useLiveOverlay } from './useLiveTrip';

/**
 * /track/:id — one route, three moods: searching (radar) → live tracking (map + sheet) → completed summary.
 * Live via WS `request:{id}`; REST polling as a fallback (fast while the socket is down).
 */
export default function Track() {
  const { id } = useParams();
  const handler = useRef<(m: WsMessage) => void>(() => {});
  const { connected } = useSocket([`request:${id}`], (m) => handler.current(m), !!id);
  useReportConnection(connected);

  const state = useAsync(() => get<Tracking>(`/requests/${id}/tracking`), [id, connected], connected ? 20000 : 6000);
  const { data, error, reload } = state;
  const { overlay, onMessage } = useLiveOverlay(data, () => void reload());
  handler.current = onMessage;

  if (!data) {
    if (error) {
      return (
        <MobileAppLayout title="Your trip" back="/history">
          <ErrorState title="Couldn't load your trip" message={`${error}. We'll keep trying — you can also call 108.`} onRetry={() => void reload()} showCall108 />
        </MobileAppLayout>
      );
    }
    return <LoadingBlock full label="Loading your trip" />;
  }

  // A pushed status is newer than the last REST payload (a refetch is already on its way).
  const status = overlay.status ?? data.request.status;
  const stage = tripStage(status);
  if (stage === 'completed' || stage === 'cancelled') return <TripDone data={data} onChanged={() => void reload()} />;
  return <TrackLive data={data} overlay={overlay} status={status} onChanged={() => void reload()} />;
}
