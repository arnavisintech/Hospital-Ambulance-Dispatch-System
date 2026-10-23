import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Building2, CheckCircle2, ClipboardCheck, FileClock, IndianRupee, Landmark, Receipt, ShieldAlert, XCircle,
} from 'lucide-react';
import {
  Badge, Button, Card, DataTable, Divider, Drawer, EmptyState, ErrorState, PageHeader, Select, StatCard, Tabs, Textarea,
  Timeline, useToast, type Column, type TimelineItem,
} from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { get, post } from '../../lib/api';
import { fmtDate, fmtNumber, fmtTime } from '../../lib/format';
import { humanize } from '../../lib/status';
import {
  allowedClaimTransitions, BILLING_TONE, CLAIM_ACTION_LABEL, fmtRupees, claimSteps, isClaimPending, type ClaimStatus, type CsvColumn,
} from './shared/logic';
import type { AdminHospital, Bill } from './shared/types';
import { ExportButton } from './shared/widgets';

const PAYMENT_TABS = ['all', 'pending', 'insurance_pending', 'paid', 'waived'] as const;
type PayFilter = (typeof PAYMENT_TABS)[number];
const CLAIM_FILTERS = [
  { value: 'any', label: 'Any claim status' }, { value: 'none', label: 'No claim' },
  { value: 'pending', label: 'Awaiting decision' }, { value: 'submitted', label: 'Submitted' },
  { value: 'under_review', label: 'Under review' }, { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' }, { value: 'settled', label: 'Settled' },
];

/** Payment / claim status pill (colour + dot + label). */
export function BillPill({ status, size }: { status: string; size?: 'sm' | 'md' }) {
  return <Badge dot tone={BILLING_TONE[status] ?? 'neutral'} size={size}>{humanize(status)}</Badge>;
}

const claimStatusOf = (b: Bill) => b.claim?.status ?? b.insurance_claim_status ?? null;

export function matchesClaimFilter(b: Bill, f: string): boolean {
  const s = claimStatusOf(b);
  if (f === 'any') return true;
  if (f === 'none') return !s;
  if (f === 'pending') return isClaimPending(s);
  return s === f;
}

export function billingTotals(bills: Bill[]) {
  const sum = (k: keyof Bill) => bills.reduce((s, b) => s + (Number(b[k]) || 0), 0);
  const revenue = sum('amount');
  return {
    revenue, hospital: sum('hospital_share'), platform: sum('platform_share'),
    hospitalPct: revenue ? (100 * sum('hospital_share')) / revenue : null,
    pendingClaims: bills.filter((b) => isClaimPending(claimStatusOf(b))).length,
    pendingClaimValue: bills.filter((b) => isClaimPending(claimStatusOf(b))).reduce((s, b) => s + (b.claim?.amount_claimed ?? b.amount), 0),
    unpaid: bills.filter((b) => b.payment_status === 'pending').length,
  };
}

const CSV: CsvColumn<Bill>[] = [
  { header: 'Bill', value: (b) => b.id }, { header: 'Request', value: (b) => b.request_id }, { header: 'Trip', value: (b) => b.trip_id },
  { header: 'Created', value: (b) => b.created_at }, { header: 'Amount', value: (b) => b.amount },
  { header: 'Base fare', value: (b) => b.base_fare }, { header: 'Distance charge', value: (b) => b.distance_charge },
  { header: 'Surcharge', value: (b) => b.surcharge }, { header: 'Hospital share', value: (b) => b.hospital_share },
  { header: 'Platform share', value: (b) => b.platform_share }, { header: 'Payment', value: (b) => b.payment_status },
  { header: 'Claim status', value: (b) => claimStatusOf(b) }, { header: 'Insurer', value: (b) => b.claim?.insurer },
];

const STEP_LABEL: Record<ClaimStatus, string> = {
  submitted: 'Claim submitted', under_review: 'Under review', approved: 'Approved', rejected: 'Rejected', settled: 'Settled',
};

function ClaimPanel({ bill, onUpdated }: { bill: Bill; onUpdated: (b: Bill) => void }) {
  const { success, error } = useToast();
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState<ClaimStatus | null>(null);
  const c = bill.claim;
  if (!c) {
    return (
      <EmptyState compact icon={ClipboardCheck} title="No insurance claim"
        description={bill.insurance_claim_status ? `Claim status: ${humanize(bill.insurance_claim_status)}` : 'The requester has not filed a claim for this trip.'} />
    );
  }
  const status = c.status ?? bill.insurance_claim_status ?? 'submitted';
  const next = allowedClaimTransitions(status);
  const steps = claimSteps(status);
  // The latest reached step carries the last-updated time and the admin's remarks.
  const latest = steps.reduce((acc, s, i) => (s.state !== 'upcoming' ? i : acc), 0);
  const items: TimelineItem[] = steps.map((s, i) => ({
    id: s.key,
    title: STEP_LABEL[s.key],
    state: s.state === 'rejected' ? 'done' : s.state,
    tone: s.state === 'rejected' ? 'danger' : s.state === 'current' ? 'info' : undefined,
    icon: s.state === 'rejected' ? XCircle : undefined,
    time: i === 0 && c.submitted_at ? <time dateTime={c.submitted_at}>{fmtTime(c.submitted_at)}</time>
      : i === latest && i > 0 && c.updated_at && c.updated_at !== c.submitted_at ? <time dateTime={c.updated_at}>{fmtTime(c.updated_at)}</time> : undefined,
    description: i === latest && i > 0 && c.remarks ? `“${c.remarks}”` : undefined,
  }));

  const act = async (to: ClaimStatus) => {
    setBusy(to);
    try {
      const out = await post<Bill>(`/billing/claims/${c.id}/status`, { status: to, remarks: remarks.trim() || undefined });
      onUpdated(out ?? { ...bill, insurance_claim_status: to, claim: { ...c, status: to, remarks: remarks.trim() || c.remarks } });
      setRemarks('');
      success(`Claim #${c.id} is now ${humanize(to).toLowerCase()}.`, { title: 'Claim updated' });
    } catch (e) { error(e, { title: "Couldn't update the claim" }); } finally { setBusy(null); }
  };

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div><dt className="text-ink-500">Insurer</dt><dd className="font-semibold text-ink-900">{c.insurer ?? '--'}</dd></div>
        <div><dt className="text-ink-500">Policy</dt><dd className="font-mono text-ink-900">{c.policy_number ?? '--'}</dd></div>
        <div><dt className="text-ink-500">Amount claimed</dt><dd className="font-semibold tabular-nums text-ink-900">{fmtRupees(c.amount_claimed ?? bill.amount)}</dd></div>
        <div><dt className="text-ink-500">Status</dt><dd><BillPill status={status} /></dd></div>
      </dl>
      <Timeline items={items} dense />
      {next.length > 0 ? (
        <div className="space-y-3 rounded-md border border-line bg-canvas p-3">
          <Textarea label="Remarks" helper="Optional · stored with the decision and in the audit log" rows={2} maxLength={1000}
            value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder={next.includes('rejected') ? 'e.g. Policy lapsed on 2 Oct' : 'e.g. Verified with insurer'} />
          <div className="flex flex-wrap gap-2">
            {next.map((to) => (
              <Button key={to} size="md" variant={to === 'rejected' ? 'danger' : to === 'settled' || to === 'approved' ? 'success' : 'primary'}
                icon={to === 'rejected' ? XCircle : to === 'under_review' ? FileClock : CheckCircle2}
                loading={busy === to} disabled={!!busy && busy !== to} onClick={() => void act(to)}>
                {CLAIM_ACTION_LABEL[to]}
              </Button>
            ))}
          </div>
        </div>
      ) : (
        <p className="flex items-center gap-2 rounded-md bg-canvas px-3 py-2 text-sm text-ink-500">
          <CheckCircle2 size={16} aria-hidden /> This claim is {humanize(status).toLowerCase()} — no further action needed.
        </p>
      )}
    </div>
  );
}

function BillDrawer({ bill, hospital, onClose, onUpdated }: { bill: Bill | null; hospital?: string; onClose: () => void; onUpdated: (b: Bill) => void }) {
  return (
    <Drawer open={!!bill} onClose={onClose} side="right" width="min(100vw, 480px)" title={bill ? `Bill #${bill.id}` : ''}>
      {bill && (
        <div className="space-y-5 p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm text-ink-500">Total fare</p>
              <p className="text-3xl font-extrabold text-ink-900">{fmtRupees(bill.amount)}</p>
              <p className="mt-1 text-sm text-ink-500">
                {fmtDate(bill.created_at)}{bill.request_id ? <> · <Link to={`/track/${bill.request_id}`} className="font-semibold text-info-fg hover:underline">Request #{bill.request_id}</Link></> : null}
                {hospital && <> · {hospital}</>}
              </p>
            </div>
            <BillPill status={bill.payment_status} size="md" />
          </div>
          <Card elevation="flat" padding="sm" className="bg-canvas">
            <dl className="space-y-1.5 text-sm">
              {([['Base fare', bill.base_fare], ['Distance charge', bill.distance_charge], ['ALS surcharge', bill.surcharge]] as const).map(([k, v]) => (
                <div key={k} className="flex justify-between"><dt className="text-ink-500">{k}</dt><dd className="tabular-nums text-ink-900">{fmtRupees(v)}</dd></div>
              ))}
              <Divider className="my-2" />
              <div className="flex justify-between font-semibold"><dt>Total</dt><dd className="tabular-nums">{fmtRupees(bill.amount)}</dd></div>
              <div className="flex justify-between"><dt className="text-ink-500">Hospital share</dt><dd className="tabular-nums text-ink-900">{fmtRupees(bill.hospital_share)}</dd></div>
              <div className="flex justify-between"><dt className="text-ink-500">Platform share</dt><dd className="tabular-nums text-ink-900">{fmtRupees(bill.platform_share)}</dd></div>
            </dl>
          </Card>
          <section aria-labelledby="claim-h">
            <h3 id="claim-h" className="mb-3 text-sm font-bold uppercase tracking-wide text-ink-500">Insurance claim</h3>
            <ClaimPanel bill={bill} onUpdated={onUpdated} />
          </section>
        </div>
      )}
    </Drawer>
  );
}

export default function BillingPage() {
  const bills = useAsync(async () => {
    const x = await get<Bill[] | { items: Bill[] }>('/billing', { limit: 500 });
    return Array.isArray(x) ? x : x.items ?? [];
  }, []);
  const hospitals = useAsync(() => get<AdminHospital[]>('/admin/hospitals'), []);
  const [pay, setPay] = useState<PayFilter>('all');
  const [claimF, setClaimF] = useState('any');
  const [openId, setOpenId] = useState<number | null>(null);
  const all = useMemo(() => bills.data ?? [], [bills.data]);
  const totals = useMemo(() => billingTotals(all), [all]);
  const hName = useMemo(() => new Map((hospitals.data ?? []).map((h) => [h.id, h.name])), [hospitals.data]);
  const rows = all.filter((b) => (pay === 'all' || b.payment_status === pay) && matchesClaimFilter(b, claimF));
  const open = all.find((b) => b.id === openId) ?? null;
  const counts = useMemo(() => Object.fromEntries(PAYMENT_TABS.map((t) => [t, t === 'all' ? all.length : all.filter((b) => b.payment_status === t).length])), [all]);
  const L = bills.loading && !bills.data;

  const columns: Column<Bill>[] = [
    { key: 'id', header: 'Bill', sortable: true, cell: (b) => <span className="font-semibold">#{b.id}</span> },
    { key: 'created_at', header: 'Date', sortable: true, hideBelow: 'md', cell: (b) => <span className="text-ink-700">{fmtDate(b.created_at)}</span> },
    { key: 'hospital', header: 'Hospital', hideBelow: 'lg', accessor: (b) => (b.hospital_id ? hName.get(b.hospital_id) ?? `#${b.hospital_id}` : ''), cell: (b) => <span className="text-ink-700">{b.hospital_id ? hName.get(b.hospital_id) ?? `#${b.hospital_id}` : '--'}</span> },
    { key: 'amount', header: 'Amount', sortable: true, align: 'right', cell: (b) => <span className="font-semibold">{fmtRupees(b.amount)}</span> },
    { key: 'hospital_share', header: 'Hospital share', sortable: true, align: 'right', hideBelow: 'md', cell: (b) => fmtRupees(b.hospital_share) },
    { key: 'payment_status', header: 'Payment', sortable: true, cell: (b) => <BillPill status={b.payment_status} /> },
    { key: 'claim', header: 'Claim', sortable: true, accessor: (b) => claimStatusOf(b) ?? '', cell: (b) => { const s = claimStatusOf(b); return s ? <BillPill status={s} /> : <span className="text-ink-400">—</span>; } },
  ];

  return (
    <div>
      <PageHeader title="Billing & claims" subtitle="Trip fares, revenue split with partner hospitals and insurance claims (FR10)"
        actions={<ExportButton rows={rows} columns={CSV} name="bills" />} />
      {bills.error && !bills.data ? (
        <Card padding="none"><ErrorState message={`${bills.error}.`} onRetry={() => void bills.reload()} /></Card>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
            <StatCard loading={L} label="Total revenue" icon={IndianRupee} tone="info" value={fmtRupees(totals.revenue, true)} hint={`${fmtNumber(all.length)} bills · ${fmtNumber(totals.unpaid)} unpaid`} />
            <StatCard loading={L} label="Hospital share" icon={Building2} tone="teal" value={fmtRupees(totals.hospital, true)}
              hint={totals.hospitalPct !== null ? `${totals.hospitalPct.toFixed(0)}% of revenue to partners` : 'Paid to partner hospitals'} />
            <StatCard loading={L} label="Platform share" icon={Landmark} tone="violet" value={fmtRupees(totals.platform, true)} hint="Retained by HADS" />
            <StatCard loading={L} label="Claims awaiting decision" icon={ShieldAlert} tone={totals.pendingClaims ? 'warning' : 'success'} value={fmtNumber(totals.pendingClaims)}
              hint={totals.pendingClaims ? `${fmtRupees(totals.pendingClaimValue, true)} claimed` : 'All claims processed'} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Tabs id="pay" variant="pill" ariaLabel="Filter by payment status" value={pay} onChange={setPay}
              items={PAYMENT_TABS.map((t) => ({ value: t, label: t === 'all' ? 'All' : humanize(t), badge: counts[t] }))} className="pb-1" />
            <Select hideLabel label="Claim status" value={claimF} onChange={(e) => setClaimF(e.target.value)} options={CLAIM_FILTERS} wrapperClassName="w-full sm:w-56" className="h-10 text-sm" />
          </div>
          <DataTable caption="Bills" data={rows} columns={columns} rowKey={(b) => b.id} loading={bills.loading} searchable
            searchPlaceholder="Search bill, hospital or status" pageSize={12} initialSort={{ key: 'id', dir: 'desc' }}
            onRowClick={(b) => setOpenId(b.id)} isRowActive={(b) => b.id === openId}
            empty={<EmptyState compact icon={Receipt} title={all.length ? 'No bills match these filters' : 'No bills yet'}
              description={all.length ? 'Try a different payment or claim filter.' : 'Bills are created automatically when a trip is handed over.'} />} />
        </div>
      )}
      <BillDrawer bill={open} hospital={open?.hospital_id ? hName.get(open.hospital_id) : undefined} onClose={() => setOpenId(null)}
        onUpdated={(b) => bills.setData((xs) => xs?.map((x) => (x.id === b.id ? { ...x, ...b } : x)) ?? xs)} />
    </div>
  );
}
