import { useState, type FormEvent } from 'react';
import { FileDown, Filter, History } from 'lucide-react';
import { DownloadButton } from '../../components/DownloadButton';
import { Badge, Button, Card, DataTable, EmptyState, ErrorState, Input, PageHeader, Select, type Column } from '../../components/ui';
import { useAuth } from '../../context/AuthContext';
import { useAsync } from '../../hooks/useAsync';
import { get } from '../../lib/api';
import { fmtDurShort } from '../admin/shared/logic';
import { fmtMoney, fmtTime } from '../../lib/format';
import { incidentMeta } from '../../lib/status';

export interface TripRecordRow {
  request_id: number; trip_id: number; created_at: string | null; completed_at: string | null; status: string;
  incident_type: string; severity: number; ambulance: string | null; station_id: number | null; station_name: string | null;
  destination_hospital: string | null; delivered_here: boolean; own_fleet: boolean; response_time_seconds: number | null;
  handover_time: string | null; distance_km: number | null; closed_manually: boolean; amount: number | null;
  payment_status: string | null; insurance_claim_status: string | null;
}
interface RecordsPage { total: number; limit: number; offset: number; items: TripRecordRow[] }
interface Filters { date_from: string; date_to: string; station_id: string; request_id: string }

const PAGE = 50;
const EMPTY: Filters = { date_from: '', date_to: '', station_id: '', request_id: '' };

/** UR2: search past trips (own fleet + patients delivered here) by date, station or request number; UR4: PDF export. */
export default function Records() {
  const { user } = useAuth();
  const hid = user?.hospital_id ?? null;
  if (!hid) return <EmptyState icon={History} title="Your account isn't linked to a hospital" description="Ask an administrator to assign you to your hospital." />;
  return <RecordsSearch hid={hid} />;
}

function RecordsSearch({ hid }: { hid: number }) {
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [offset, setOffset] = useState(0);
  const stations = useAsync(() => get<{ stations: { id: number; name: string }[] }>(`/hospitals/${hid}/fleet`), [hid]);
  const page = useAsync(
    () => get<RecordsPage>(`/hospitals/${hid}/records`, { ...applied, limit: PAGE, offset }),
    [hid, applied.date_from, applied.date_to, applied.station_id, applied.request_id, offset],
  );
  const set = (k: keyof Filters) => (v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const submit = (e: FormEvent) => { e.preventDefault(); setOffset(0); setApplied({ ...draft, request_id: draft.request_id.replace(/\D/g, '') }); };
  const stationOptions = (stations.data?.stations ?? []).map((s) => ({ value: String(s.id), label: s.name }));
  const items = page.data?.items ?? [];
  const total = page.data?.total ?? 0;

  const columns: Column<TripRecordRow>[] = [
    { key: 'request_id', header: 'Request', cell: (r) => <span className="font-semibold tabular-nums text-ink-900">#{r.request_id}</span> },
    { key: 'created_at', header: 'Date', accessor: (r) => r.created_at, cell: (r) => (r.created_at ? fmtTime(r.created_at) : '-') },
    { key: 'incident_type', header: 'Incident', cell: (r) => incidentMeta(r.incident_type).short },
    { key: 'station_name', header: 'Station', hideBelow: 'sm', cell: (r) => r.station_name ?? '-' },
    { key: 'ambulance', header: 'Ambulance', hideBelow: 'md', cell: (r) => <span className="tabular-nums">{r.ambulance ?? '-'}</span> },
    { key: 'response_time_seconds', header: 'Response', align: 'right', hideBelow: 'md', cell: (r) => fmtDurShort(r.response_time_seconds) },
    { key: 'amount', header: 'Fare', align: 'right', hideBelow: 'lg', cell: (r) => (r.amount == null ? '-' : fmtMoney(r.amount)) },
    {
      key: 'relation', header: 'Case', hideBelow: 'lg', accessor: (r) => (r.delivered_here ? 'here' : 'fleet'),
      cell: (r) => <Badge tone={r.delivered_here ? 'info' : 'muted'}>{r.delivered_here ? 'Delivered here' : 'Our fleet'}</Badge>,
    },
  ];

  return (
    <div>
      <PageHeader title="Trip records" subtitle="Your fleet's trips and patients delivered here. Caller details are never shown." />
      <Card padding="md" className="mb-4">
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_auto] lg:items-end">
          <Input type="date" label="From" value={draft.date_from} onChange={(e) => set('date_from')(e.target.value)} />
          <Input type="date" label="To" value={draft.date_to} onChange={(e) => set('date_to')(e.target.value)} />
          <Select label="Station" value={draft.station_id} onChange={(e) => set('station_id')(e.target.value)}
            options={[{ value: '', label: 'All stations' }, ...stationOptions]} />
          <Input label="Request number" inputMode="numeric" placeholder="e.g. 501" value={draft.request_id}
            onChange={(e) => set('request_id')(e.target.value)} />
          <Button type="submit" icon={Filter} variant="secondary">Search</Button>
        </form>
        {applied.station_id && (
          <div className="mt-3 flex justify-end">
            <DownloadButton icon={FileDown} path={`/hospitals/${hid}/stations/${applied.station_id}/history.pdf`}
              query={{ date_from: applied.date_from, date_to: applied.date_to }} filename="station-history.pdf">
              Station history (PDF)
            </DownloadButton>
          </div>
        )}
      </Card>

      {page.error && !page.data ? (
        <ErrorState message={page.error} onRetry={() => void page.reload()} />
      ) : (
        <>
          <DataTable data={items} columns={columns} rowKey={(r) => r.trip_id} loading={page.loading && !page.data} pageSize={0}
            caption="Trip records" empty={<EmptyState compact icon={History} title="No trips match these filters" />} />
          <div className="mt-3 flex items-center justify-between text-sm text-ink-500">
            <span>{total ? `${offset + 1}-${Math.min(offset + PAGE, total)} of ${total}` : ''}</span>
            <span className="flex gap-2">
              <Button size="sm" variant="ghost" disabled={offset === 0} onClick={() => setOffset((o) => Math.max(0, o - PAGE))}>Previous</Button>
              <Button size="sm" variant="ghost" disabled={offset + PAGE >= total} onClick={() => setOffset((o) => o + PAGE)}>Next</Button>
            </span>
          </div>
        </>
      )}
    </div>
  );
}
