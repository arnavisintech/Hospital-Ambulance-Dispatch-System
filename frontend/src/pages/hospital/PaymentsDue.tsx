import { useState } from 'react';
import { HandCoins, Receipt } from 'lucide-react';
import { Button, Card, CardHeader, EmptyState, ErrorState, Input, Modal, SegmentedControl, Skeleton, useToast } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { get, post } from '../../lib/api';
import { fmtMoney, fmtRelative } from '../../lib/format';
import type { Bill } from '../admin/shared/types';
import { PAY_METHODS } from '../requester/trip';

/** Bills for trips handed over here that are still unpaid. Staff record what the billing desk collected. */
export function PaymentsDue() {
  const { success, error } = useToast();
  const bills = useAsync(() => get<Bill[]>('/billing', { payment_status: 'pending', limit: 50 }), [], 60000);
  const [open, setOpen] = useState<Bill | null>(null);
  const [method, setMethod] = useState<string>('upi');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const due = (bills.data ?? []).filter((b) => b.payment_status === 'pending' && !b.insurance_claim_status);

  const record = async () => {
    if (!open) return;
    setBusy(true);
    try {
      await post(`/billing/${open.id}/pay`, { method, reference: reference.trim() || undefined });
      success(`Payment for bill #${open.id} recorded`);
      setOpen(null);
      setReference('');
      void bills.reload();
    } catch (e) { error(e, { title: "Couldn't record payment" }); } finally { setBusy(false); }
  };

  return (
    <Card as="section" aria-labelledby="pay-h">
      <CardHeader as="h2" title={<span id="pay-h">Payments due</span>} subtitle="Record payments collected at your billing desk" icon={HandCoins} />
      {bills.loading && !bills.data ? (
        <div className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : bills.error && !bills.data ? (
        <ErrorState compact message={bills.error} onRetry={() => void bills.reload()} />
      ) : !due.length ? (
        <EmptyState compact icon={Receipt} title="No payments due" />
      ) : (
        <ul className="divide-y divide-line/70">
          {due.map((b) => (
            <li key={b.id} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink-900">Bill #{b.id}{b.request_id ? ` · request #${b.request_id}` : ''}</p>
                <p className="text-xs text-ink-500">{b.created_at ? fmtRelative(b.created_at, Date.now()) : '—'}</p>
              </div>
              <span className="text-sm font-bold tabular-nums text-ink-900">{fmtMoney(b.amount)}</span>
              <Button size="sm" variant="secondary" onClick={() => setOpen(b)} aria-label={`Mark bill ${b.id} received`}>Received</Button>
            </li>
          ))}
        </ul>
      )}

      <Modal open={!!open} onClose={() => setOpen(null)} size="sm" title={open ? `Bill #${open.id} · ${fmtMoney(open.amount)}` : ''}
        description="Confirm only after the money is in hand. This is recorded in the audit log."
        footer={<><Button variant="secondary" onClick={() => setOpen(null)}>Cancel</Button><Button onClick={() => void record()} loading={busy}>Confirm payment</Button></>}>
        <div className="space-y-4">
          <SegmentedControl ariaLabel="Payment method" fullWidth items={PAY_METHODS.map((m) => ({ value: m.value, label: m.label }))} value={method} onChange={setMethod} />
          <Input label="Receipt or UTR number" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} helper="Optional" />
        </div>
      </Modal>
    </Card>
  );
}
