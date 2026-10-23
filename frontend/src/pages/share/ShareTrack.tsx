import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Ambulance, CheckCheck, Hospital, Link2Off, MapPin } from 'lucide-react';
import { MobileAppLayout } from '../../components/layout/MobileAppLayout';
import { ButtonLink, Card, EmptyState, LoadingBlock, ProgressSteps } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { api } from '../../lib/api';
import { backoffMs } from '../../lib/queue';
import type { LatLng, PublicTracking, WsMessage } from '../../lib/types';
import { Call108Pill, TimelineToggle, TripHeadline } from '../requester/components/TripCards';
import { TripMap } from '../requester/components/TripMap';
import { pickEta, tripHeadline, tripStage } from '../requester/trip';
import { useLiveOverlay } from '../requester/useLiveTrip';

/** Anonymous WS subscription `?share=<token>` (v2 §4). Reconnects with backoff; stops on 4404 (expired link). */
function useShareSocket(token: string | undefined, onMessage: (m: WsMessage) => void): boolean {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onMessage);
  useEffect(() => { handler.current = onMessage; });
  useEffect(() => {
    if (!token) return;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let closed = false;
    const connect = () => {
      if (closed) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      try {
        ws = new WebSocket(`${proto}//${window.location.host}/api/ws?${new URLSearchParams({ share: token })}`);
      } catch { schedule(); return; }
      ws.onopen = () => { attempt = 0; setConnected(true); };
      ws.onmessage = (ev) => { try { handler.current(JSON.parse(ev.data as string) as WsMessage); } catch { /* ignore */ } };
      ws.onclose = (ev) => { setConnected(false); if (!closed && ev.code !== 4404) schedule(); };
      ws.onerror = () => ws?.close();
    };
    const schedule = () => { timer = setTimeout(connect, backoffMs(attempt++, 1000, 15000)); };
    connect();
    return () => { closed = true; if (timer) clearTimeout(timer); if (ws) { ws.onclose = null; ws.close(); } };
  }, [token]);
  return connected;
}

/** /t/:token — read-only family tracking. No login, no PII (backend sends no names/phones, coarse patient area). */
export default function ShareTrack() {
  const { token } = useParams();
  const handler = useRef<(m: WsMessage) => void>(() => {});
  const connected = useShareSocket(token, (m) => handler.current(m));
  const state = useAsync(
    () => api<PublicTracking>(`/public/track/${encodeURIComponent(token ?? '')}`, { auth: false }),
    [token, connected], connected ? 20000 : 6000,
  );
  const { data, error, reload } = state;
  const { overlay, onMessage } = useLiveOverlay(data, () => void reload());
  handler.current = onMessage;

  if (!data) {
    if (error) {
      const gone = /not found|expired|404/i.test(error);
      return (
        <MobileAppLayout title="Live trip" showUserMenu={false}>
          <EmptyState
            icon={Link2Off}
            title={gone ? 'This link has expired' : "Couldn't load this trip"}
            description={gone ? 'Trip links stop working a couple of hours after the trip ends. Ask the person who shared it for an update.' : `${error}. We'll keep trying.`}
            action={<ButtonLink to="/" variant="secondary">Go to HADS</ButtonLink>}
          />
        </MobileAppLayout>
      );
    }
    return <LoadingBlock full label="Loading live trip" />;
  }

  const status = overlay.status ?? data.status;
  const stage = tripStage(status);
  const route = overlay.route ?? data.route ?? null;
  const eta = pickEta(overlay.eta, route?.eta_seconds, data.eta_seconds);
  const headline = tripHeadline(status, eta, data.hospital?.name);
  // Family copy: "Reached you" reads oddly to a relative — say "Reached the patient".
  if (status === 'on_scene') headline.title = 'Reached the patient';
  if (status === 'en_route' || status === 'accepted') headline.subtitle = 'Ambulance is on the way to the patient';
  const area = data.patient_area;
  const patient: LatLng | null = area && typeof area === 'object' ? [area.lat, area.lng] : null;
  const areaLabel = area && typeof area === 'object' ? area.label : typeof area === 'string' ? area : null;
  const onBoard = status === 'transporting' || status === 'arrived';
  const ambPos: LatLng | null = overlay.ambulance ? [overlay.ambulance.lat, overlay.ambulance.lng]
    : data.ambulance ? [data.ambulance.lat, data.ambulance.lng] : null;
  const done = stage === 'completed' || stage === 'cancelled';

  const map = (
    <TripMap
      patient={patient}
      patientLabel="Patient"
      showPatient={!onBoard && !done}
      ambulance={ambPos && !done ? { position: ambPos, heading: overlay.ambulance?.heading ?? data.ambulance?.heading_deg, status: onBoard ? 'transporting' : 'en_route', title: data.ambulance?.registration_number } : null}
      route={!done ? route : null}
      hospital={data.hospital ? { name: data.hospital.name, position: [data.hospital.lat, data.hospital.lng] } : null}
      eta={!done && !['on_scene', 'arrived'].includes(status) ? eta : null}
      ariaLabel="Live ambulance map"
    />
  );

  return (
    <MobileAppLayout
      title="Live trip"
      showUserMenu={false}
      actions={<Call108Pill />}
      map={map}
      sheet={{
        snapPoints: [0.42, 0.88],
        ariaLabel: 'Trip status',
        header: (
          <div className="space-y-4">
            <TripHeadline headline={headline} aside={stage === 'completed' ? <CheckCheck className="text-success" size={28} aria-hidden /> : undefined} />
            {stage !== 'cancelled' && <ProgressSteps status={status} />}
          </div>
        ),
      }}
    >
      <div className="space-y-3 pb-2">
        {data.ambulance && (
          <Card padding="md" className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-500" aria-hidden><Ambulance size={20} /></span>
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Ambulance</p>
              <p className="font-mono text-base font-bold tracking-wide text-ink-900">{data.ambulance.registration_number}</p>
            </div>
          </Card>
        )}
        <Card padding="md" className="space-y-3">
          {areaLabel && (
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-canvas text-ink-700" aria-hidden><MapPin size={18} /></span>
              <div><p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Pickup area</p><p className="font-semibold text-ink-900">{areaLabel}</p></div>
            </div>
          )}
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-teal-bg text-teal-fg" aria-hidden><Hospital size={18} /></span>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Hospital</p>
              <p className="font-semibold text-ink-900">{data.hospital?.name ?? 'Being confirmed'}</p>
            </div>
          </div>
        </Card>
        <TimelineToggle timeline={data.timeline} status={status} defaultOpen={done} />
        <p className="px-1 pt-1 text-center text-xs text-ink-500">
          Shared with you from HADS. Location updates live{connected ? '' : ' (reconnecting…)'}. In an emergency call 108.
        </p>
      </div>
    </MobileAppLayout>
  );
}

