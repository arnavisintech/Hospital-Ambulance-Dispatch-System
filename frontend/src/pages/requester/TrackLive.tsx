import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Clock, XCircle } from 'lucide-react';
import { MobileAppLayout } from '../../components/layout/MobileAppLayout';
import {
  Button, Call108Button, Card, ConfirmDialog, IncidentBadge, ProgressSteps, PulseRadar, SeverityBadge, useToast,
} from '../../components/ui';
import { post } from '../../lib/api';
import { fmtClockTimer } from '../../lib/format';
import type { LatLng, ShareLink, Tracking } from '../../lib/types';
import { Call108Pill, CrewCard, HospitalCard, PickupCard, ShareTripCard, TimelineToggle, TripHeadline } from './components/TripCards';
import { TripMap } from './components/TripMap';
import { isCancellable, pickEta, tripHeadline, tripStage, type LiveOverlay } from './trip';

const SLOW_SEARCH_S = 120;

function useElapsed(sinceIso: string): number {
  const since = new Date(sinceIso).getTime();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return Number.isFinite(since) ? Math.max(0, (now - since) / 1000) : 0;
}

export function TrackLive({ data, overlay, status, onChanged }: { data: Tracking; overlay: LiveOverlay; status: string; onChanged: () => void }) {
  const r = data.request;
  const stage = tripStage(status);
  const reduce = useReducedMotion();
  const { success, error } = useToast();
  const [confirmCancel, setConfirmCancel] = useState(false);

  const route = overlay.route ?? data.route ?? null;
  const eta = pickEta(overlay.eta, route?.eta_seconds, data.eta_seconds, r.eta_seconds);
  const hospitalName = data.hospital?.name ?? r.destination_hospital?.name ?? null;
  const headline = tripHeadline(status, eta, hospitalName);
  const onBoard = status === 'transporting' || status === 'arrived';
  const ambPos: LatLng | null = overlay.ambulance
    ? [overlay.ambulance.lat, overlay.ambulance.lng]
    : data.ambulance ? [data.ambulance.lat, data.ambulance.lng] : null;
  const hosp = data.hospital ?? r.destination_hospital ?? null;

  const cancel = async () => {
    try {
      await post(`/requests/${r.id}/cancel`, { reason: 'Cancelled by requester' });
      success('Request cancelled');
      onChanged();
    } catch (e) {
      error(e);
      throw e;
    }
  };
  const getShare = () => (data.share ? Promise.resolve(data.share) : post<ShareLink>(`/requests/${r.id}/share`));

  const map = (
    <TripMap
      patient={[r.lat, r.lng]}
      patientLabel={stage === 'searching' ? 'You' : 'Pickup'}
      showPatient={!onBoard}
      ambulance={stage === 'live' && ambPos ? {
        position: ambPos,
        heading: overlay.ambulance?.heading ?? data.ambulance?.heading_deg,
        status: data.ambulance?.status ?? 'en_route',
        title: data.ambulance?.registration_number ?? r.ambulance?.registration_number,
      } : null}
      route={stage === 'live' ? route : null}
      hospital={hosp && stage === 'live' ? { name: hosp.name, position: [hosp.lat, hosp.lng] } : null}
      eta={stage === 'live' && !['on_scene', 'arrived'].includes(status) ? eta : null}
    />
  );

  const fade = {
    initial: reduce ? { opacity: 0 } : { opacity: 0, y: 12 },
    animate: { opacity: 1, y: 0, transition: { duration: 0.22, ease: [0.16, 1, 0.3, 1] as const } },
    exit: { opacity: 0, transition: { duration: 0.14 } },
  };

  const header = stage === 'live' ? (
    <div className="space-y-4">
      <TripHeadline headline={headline} />
      <ProgressSteps status={status} />
    </div>
  ) : undefined;

  return (
    <MobileAppLayout
      title={stage === 'searching' ? 'Requesting ambulance' : 'Your ambulance'}
      back="/history"
      actions={<Call108Pill />}
      map={map}
      sheet={{ snapPoints: stage === 'searching' ? [0.56, 0.9] : [0.44, 0.9], header, ariaLabel: 'Trip details' }}
    >
      <AnimatePresence mode="wait" initial={false}>
        {stage === 'searching' ? (
          <motion.div key="searching" {...fade}>
            <Searching data={data} status={status} headline={headline} onCancel={() => setConfirmCancel(true)} />
          </motion.div>
        ) : (
          <motion.div key="live" {...fade} className="space-y-3 pb-2">
            <CrewCard crew={data.crew} registration={data.ambulance?.registration_number ?? r.ambulance?.registration_number} kind={data.ambulance?.kind ?? r.ambulance?.kind} />
            <HospitalCard hospital={data.hospital} fallbackName={r.destination_hospital?.name} />
            <ShareTripCard getLink={getShare} />
            <Card padding="md" className="space-y-3">
              <div className="flex flex-wrap gap-1.5">
                <IncidentBadge type={r.incident_type} size="md" />
                <SeverityBadge severity={r.severity} size="md" />
              </div>
              <PickupCard address={r.address} zone={r.zone_label} />
            </Card>
            <TimelineToggle timeline={data.timeline ?? r.timeline} status={status} />
            {isCancellable(status) && (
              <Button variant="ghost" fullWidth icon={XCircle} onClick={() => setConfirmCancel(true)} className="text-ink-500">
                Cancel request
              </Button>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        onConfirm={cancel}
        tone="danger"
        title="Cancel this request?"
        description={stage === 'live' ? 'The ambulance on its way to you will be stopped and sent to other patients.' : "We'll stop looking for an ambulance."}
        confirmLabel="Yes, cancel"
        cancelLabel="Keep request"
      />
    </MobileAppLayout>
  );
}

function Searching({ data, status, headline, onCancel }: { data: Tracking; status: string; headline: { title: string; subtitle: string }; onCancel: () => void }) {
  const r = data.request;
  const elapsed = useElapsed(r.created_at);
  const offeredTo = status === 'offered' ? r.attempts?.filter((a) => a.status === 'offered').slice(-1)[0] : undefined;
  const slow = elapsed > SLOW_SEARCH_S;
  return (
    <div className="flex flex-col items-center gap-5 pb-2 pt-2">
      <PulseRadar size={148} label={headline.title} sublabel={offeredTo ? `${offeredTo.registration_number} is confirming` : headline.subtitle} />
      <p className="flex items-center gap-1.5 text-sm font-medium text-ink-500">
        <Clock size={16} aria-hidden />
        <span>Requested <span className="tabular-nums">{fmtClockTimer(elapsed)}</span> ago</span>
      </p>
      {slow && (
        <div className="w-full rounded-lg border border-warning/30 bg-warning-bg p-4 text-warning-fg" role="alert">
          <p className="font-semibold">Taking longer than usual</p>
          <p className="mt-0.5 text-sm">Our control room has been alerted. If it's urgent, call 108 now.</p>
          <Call108Button size="md" variant="dark" className="mt-3 w-full" />
        </div>
      )}
      <Card padding="md" className="w-full space-y-3">
        <div className="flex flex-wrap gap-1.5">
          <IncidentBadge type={r.incident_type} size="md" />
          <SeverityBadge severity={r.severity} size="md" />
        </div>
        <PickupCard address={r.address} zone={r.zone_label} />
      </Card>
      <Button variant="danger" fullWidth size="lg" icon={XCircle} onClick={onCancel}>Cancel request</Button>
    </div>
  );
}
