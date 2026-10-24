import { useState } from 'react';
import { Ambulance as AmbulanceIcon, Wrench } from 'lucide-react';
import { Button, Card, CardHeader, EmptyState, ErrorState, Skeleton, StatusPill, Switch, useToast } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { get, patch } from '../../lib/api';
import { fmtDurShort } from '../admin/shared/logic';

interface FleetUnit {
  id: number; registration_number: string; kind: string; status: string; staffed: boolean;
  station_id: number; location_age_s: number | null;
}
interface FleetStation { id: number; name: string; is_active: boolean; ambulances: FleetUnit[] }
interface Fleet { hospital_id: number; stations: FleetStation[] }

const ON_TRIP = new Set(['assigned', 'en_route', 'on_scene', 'transporting']);

/** FR2 / STRQ5: this hospital's dark stations and ambulances; staff take units out of service and back. */
export function FleetPanel({ hid }: { hid: number }) {
  const { success, error } = useToast();
  const fleet = useAsync(() => get<Fleet>(`/hospitals/${hid}/fleet`), [hid], 30000);
  const [busy, setBusy] = useState<number | null>(null);

  const update = async (u: FleetUnit, body: { staffed?: boolean; maintenance?: boolean }, done: string) => {
    setBusy(u.id);
    try {
      const next = await patch<FleetUnit>(`/hospitals/${hid}/ambulances/${u.id}`, body);
      fleet.setData((f) => f && {
        ...f,
        stations: f.stations.map((s) => ({ ...s, ambulances: s.ambulances.map((a) => (a.id === u.id ? { ...a, ...next } : a)) })),
      });
      success(`${u.registration_number} ${done}`);
    } catch (e) {
      error(e, { title: `Couldn't update ${u.registration_number}` });
    } finally {
      setBusy(null);
    }
  };

  const stations = fleet.data?.stations ?? [];
  return (
    <Card as="section" aria-labelledby="fleet-h">
      <CardHeader as="h2" title={<span id="fleet-h">Your fleet</span>} subtitle="Units out of service are never dispatched" icon={AmbulanceIcon} />
      {fleet.loading && !fleet.data ? (
        <div className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : fleet.error && !fleet.data ? (
        <ErrorState compact message={fleet.error} onRetry={() => void fleet.reload()} />
      ) : !stations.length ? (
        <EmptyState compact icon={AmbulanceIcon} title="No stations yet" description="An administrator registers your stations and ambulances." />
      ) : (
        <div className="space-y-4">
          {stations.map((s) => (
            <div key={s.id}>
              <p className="mb-1 text-xs font-bold uppercase tracking-wider text-ink-500">{s.name}</p>
              <ul className="divide-y divide-line/70">
                {s.ambulances.map((u) => {
                  const onTrip = ON_TRIP.has(u.status);
                  const inMaintenance = u.status === 'maintenance';
                  return (
                    <li key={u.id} className="flex flex-wrap items-center gap-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-ink-900 tabular-nums">{u.registration_number}</p>
                        <p className="text-xs text-ink-500">
                          {u.kind} · {u.location_age_s == null ? 'no GPS yet' : `GPS ${fmtDurShort(u.location_age_s)} ago`}
                        </p>
                      </div>
                      <StatusPill status={u.status} kind="ambulance" />
                      <Switch size="md" checked={u.staffed} disabled={onTrip || busy === u.id}
                        ariaLabel={`${u.registration_number} staffed`}
                        onChange={(v) => void update(u, { staffed: v }, v ? 'marked staffed' : 'marked not staffed')} />
                      <Button size="sm" variant="secondary" icon={Wrench} disabled={onTrip} loading={busy === u.id}
                        aria-label={`${inMaintenance ? 'End' : 'Start'} maintenance for ${u.registration_number}`}
                        onClick={() => void update(u, { maintenance: !inMaintenance }, inMaintenance ? 'back in service' : 'in maintenance')}>
                        {inMaintenance ? 'Back in service' : 'Maintenance'}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
