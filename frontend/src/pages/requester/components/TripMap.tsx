import { useState } from 'react';
import { AmbulanceMarker, FitBounds, HospitalMarker, MapCanvas, PatientPin, RouteLine } from '../../../components/map';
import type { LatLng, RoutePhase } from '../../../lib/types';

export interface TripMapProps {
  patient: LatLng | null;
  patientLabel?: string;
  /** Hide the patient pin once they are on board. */
  showPatient?: boolean;
  ambulance?: { position: LatLng; heading?: number | null; status?: string; title?: string } | null;
  route?: { phase: RoutePhase | null; polyline: LatLng[] } | null;
  hospital?: { name: string; position: LatLng; beds?: number | null } | null;
  /** ETA chip on the ambulance (seconds). */
  eta?: number | null;
  ariaLabel?: string;
}

/**
 * Live trip map shared by the requester tracker and the family share page: road route (travelled part greyed),
 * gliding ambulance with heading + ETA chip, patient pin, destination hospital. Fits the relevant leg on load and
 * whenever the leg changes; the recenter button re-fits without fighting the user's panning in between.
 */
export function TripMap({ patient, patientLabel = 'Pickup', showPatient = true, ambulance, route, hospital, eta, ariaLabel = 'Live trip map' }: TripMapProps) {
  const [recenterN, setRecenterN] = useState(0);
  const phase: RoutePhase = route?.phase ?? (showPatient ? 'to_patient' : 'to_hospital');
  const hasAmb = !!ambulance;

  // Fit points change only on leg change / recenter (not on every GPS ping) — "adjust state on key change".
  const computeFit = (): LatLng[] => {
    const pts: (LatLng | null | undefined)[] = [ambulance?.position];
    pts.push(phase === 'to_hospital' ? hospital?.position : patient);
    if (!ambulance) pts.push(hospital?.position);
    const valid = pts.filter((p): p is LatLng => !!p);
    // FitBounds uses setView (ignoring sheet insets) for one point; a degenerate 2-point bounds keeps the
    // point centred in the visible area above the bottom sheet.
    return valid.length === 1 ? [valid[0], valid[0]] : valid;
  };
  const fitKey = `${phase}|${hasAmb}|${!!hospital}|${!!patient}|${recenterN}`;
  const [fit, setFit] = useState(() => ({ key: fitKey, points: computeFit() }));
  if (fit.key !== fitKey) setFit({ key: fitKey, points: computeFit() });
  const fitPoints = fit.points;

  const center = ambulance?.position ?? patient ?? undefined;
  return (
    <MapCanvas center={center} zoom={14} onRecenter={() => setRecenterN((n) => n + 1)} recenterLabel="Show the whole trip" ariaLabel={ariaLabel}>
      {route && route.polyline.length > 1 && (
        <RouteLine positions={route.polyline} phase={route.phase ?? phase} progressAt={ambulance?.position} />
      )}
      {hospital && <HospitalMarker position={hospital.position} name={hospital.name} beds={hospital.beds} selected />}
      {patient && showPatient && <PatientPin position={patient} label={patientLabel} />}
      {ambulance && (
        <AmbulanceMarker
          position={ambulance.position}
          heading={ambulance.heading}
          status={ambulance.status ?? 'en_route'}
          eta={eta ?? null}
          route={route?.polyline}
          title={ambulance.title}
        />
      )}
      <FitBounds points={fitPoints} refitKey={recenterN} maxZoom={16} />
    </MapCanvas>
  );
}
