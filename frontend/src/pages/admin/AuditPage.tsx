import { useState, type FormEvent } from 'react';
import { ChevronLeft, ChevronRight, Filter, Link2, ScrollText, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import {
  Badge, Button, Card, DataTable, Drawer, EmptyState, ErrorState, IconButton, Input, PageHeader, Tabs, useToast, type Column,
} from '../../components/ui';
import { DownloadButton } from '../../components/DownloadButton';
import { useAuth } from '../../context/AuthContext';
import { useAsync } from '../../hooks/useAsync';
import { get } from '../../lib/api';
import { cn } from '../../lib/cn';
import { fmtNumber, fmtRelative, fmtTime } from '../../lib/format';
import type { AuditItem, AuditPage as AuditPageT, AuditVerify } from './shared/types';

const PAGE = 50;
/** Quick filters: backend treats a trailing '.' as a prefix match. */
const PRESETS = [
  { value: '', label: 'All' }, { value: 'request.', label: 'Requests' }, { value: 'dispatch.', label: 'Dispatch' },
  { value: 'capacity.', label: 'Capacity' }, { value: 'billing.', label: 'Billing' }, { value: 'admin.', label: 'Admin' },
  { value: 'analytics.', label: 'Model' },
];

function VerifyBanner({ v, onClose }: { v: AuditVerify; onClose: () => void }) {
  return (
    <div role="status" className={cn('mb-6 flex items-start gap-3 rounded-lg border p-4',
      v.ok ? 'border-success/30 bg-success-bg' : 'border-brand-200 bg-brand-50')}>
      {v.ok ? <ShieldCheck size={24} className="shrink-0 text-success" aria-hidden /> : <ShieldAlert size={24} className="shrink-0 text-brand-500" aria-hidden />}
      <div className="min-w-0 flex-1">
        <p className={cn('font-bold', v.ok ? 'text-success-fg' : 'text-danger-fg')}>
          {v.ok ? 'Audit chain intact' : `Integrity check failed at entry #${v.broken_at}`}
        </p>
        <p className="text-sm text-ink-700">
          {v.ok
            ? `All ${fmtNumber(v.checked)} entries were re-hashed and every link matches. No record has been altered or removed.`
            : `${fmtNumber(v.checked)} entries verified before the break. Entry #${v.broken_at} or its predecessor was modified, inserted or deleted — escalate to the security team.`}
        </p>
      </div>
      <IconButton size="sm" label="Dismiss result" icon={X} onClick={onClose} />
    </div>
  );
}

function DetailDrawer({ item, onClose }: { item: AuditItem | null; onClose: () => void }) {
  const json = item ? JSON.stringify(item.details ?? {}, null, 2) : '';
  return (
    <Drawer open={!!item} onClose={onClose} title={item ? `Entry #${item.id}` : ''} width="min(100vw, 520px)">
      {item && (
        <div className="space-y-5 p-5">
          <dl className="grid grid-cols-[110px_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-ink-500">Action</dt><dd className="font-mono font-semibold text-ink-900">{item.action}</dd>
            <dt className="text-ink-500">Entity</dt><dd className="text-ink-900">{item.entity ?? '--'}{item.entity_id !== null && item.entity_id !== undefined ? ` #${item.entity_id}` : ''}</dd>
            <dt className="text-ink-500">Actor</dt><dd className="text-ink-900">{item.user_id ? `User #${item.user_id}` : 'System'}</dd>
            <dt className="text-ink-500">Time</dt><dd className="text-ink-900">{item.ts ? <time dateTime={item.ts}>{fmtTime(item.ts)}</time> : '--'}</dd>
          </dl>
          <section aria-labelledby="det-h">
            <h3 id="det-h" className="mb-2 text-sm font-bold uppercase tracking-wide text-ink-500">Details</h3>
            <pre className="max-h-[50vh] overflow-auto rounded-md border border-line bg-canvas p-3 font-mono text-xs leading-relaxed text-ink-900 scrollbar-thin" tabIndex={0} aria-label="Details JSON">{json}</pre>
          </section>
          <section aria-labelledby="hash-h">
            <h3 id="hash-h" className="mb-2 flex items-center gap-1.5 text-sm font-bold uppercase tracking-wide text-ink-500"><Link2 size={14} aria-hidden /> Hash chain</h3>
            <dl className="space-y-2 text-xs">
              <div><dt className="text-ink-500">Previous hash</dt><dd className="break-all font-mono text-ink-700">{item.prev_hash || '(genesis)'}</dd></div>
              <div><dt className="text-ink-500">This entry</dt><dd className="break-all font-mono text-ink-900">{item.hash ?? '--'}</dd></div>
            </dl>
          </section>
        </div>
      )}
    </Drawer>
  );
}

export default function AuditPage() {
  const { user } = useAuth();
  const { error } = useToast();
  const [action, setAction] = useState('');
  const [entity, setEntity] = useState('');
  const [applied, setApplied] = useState({ action: '', entity: '' });
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<AuditItem | null>(null);
  const [verify, setVerify] = useState<AuditVerify | null>(null);
  const [verifying, setVerifying] = useState(false);

  const page = useAsync(async (): Promise<AuditPageT> => {
    const x = await get<AuditPageT | AuditItem[]>('/audit', { action: applied.action, entity: applied.entity, limit: PAGE, offset });
    return Array.isArray(x) ? { total: offset + x.length + (x.length === PAGE ? 1 : 0), limit: PAGE, offset, items: x } : x;
  }, [applied.action, applied.entity, offset]);
  const items = page.data?.items ?? [];
  const total = page.data?.total ?? 0;

  const apply = (a: string, e: string) => { setOffset(0); setApplied({ action: a.trim(), entity: e.trim() }); };
  const submit = (e: FormEvent) => { e.preventDefault(); apply(action, entity); };
  const doVerify = async () => {
    setVerifying(true);
    try { setVerify(await get<AuditVerify>('/audit/verify')); } catch (e) { error(e, { title: "Couldn't verify the audit chain" }); } finally { setVerifying(false); }
  };

  const columns: Column<AuditItem>[] = [
    { key: 'id', header: '#', cell: (r) => <span className="tabular-nums text-ink-500">{r.id}</span>, width: 'w-16' },
    { key: 'ts', header: 'Time', cell: (r) => r.ts ? <time dateTime={r.ts} title={fmtTime(r.ts)} className="whitespace-nowrap text-ink-700">{fmtRelative(r.ts)}</time> : '--' },
    { key: 'action', header: 'Action', cell: (r) => <span className="rounded-sm bg-canvas px-1.5 py-0.5 font-mono text-xs font-semibold text-ink-900">{r.action}</span> },
    { key: 'entity', header: 'Entity', hideBelow: 'sm', cell: (r) => <span className="text-ink-700">{r.entity ?? '--'}{r.entity_id !== null && r.entity_id !== undefined ? <span className="text-ink-500"> #{String(r.entity_id)}</span> : null}</span> },
    { key: 'user_id', header: 'Actor', hideBelow: 'md', cell: (r) => <span className="text-ink-700">{r.user_id ? `User #${r.user_id}` : <Badge tone="muted">System</Badge>}</span> },
    { key: 'hash', header: 'Hash', hideBelow: 'lg', cell: (r) => <span className="font-mono text-xs text-ink-500" title={r.hash ?? undefined}>{r.hash ? `${r.hash.slice(0, 10)}…` : '--'}</span> },
  ];

  const hasFilter = !!(applied.action || applied.entity);
  const presetValue = PRESETS.some((p) => p.value === applied.action) && !applied.entity ? applied.action : '__custom';

  return (
    <div>
      <PageHeader title="Audit log" subtitle={`Tamper-evident, hash-chained record of every sensitive action (NFR7)${user?.role === 'authority' ? ' · read-only' : ''}`}
        actions={<>
          <DownloadButton path="/audit/export.csv" query={{ action: applied.action, entity: applied.entity }} filename="hads-audit.csv">
            Export CSV
          </DownloadButton>
          <Button icon={ShieldCheck} loading={verifying} onClick={() => void doVerify()}>{verifying ? 'Verifying…' : 'Verify integrity'}</Button>
        </>} />
      {verify && <VerifyBanner v={verify} onClose={() => setVerify(null)} />}

      <Card padding="md" className="mb-4">
        <Tabs id="audit-presets" variant="pill" ariaLabel="Quick filters" value={presetValue}
          items={[...PRESETS.map((p) => ({ value: p.value, label: p.label })), ...(presetValue === '__custom' ? [{ value: '__custom', label: 'Custom' }] : [])]}
          onChange={(v) => { if (v !== '__custom') { setAction(v); setEntity(''); apply(v, ''); } }} className="mb-4 pb-1" />
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
          <Input label="Action" value={action} onChange={(e) => setAction(e.target.value)} placeholder="e.g. capacity.query or billing." helper="Exact match; end with “.” or “*” for a prefix" />
          <Input label="Entity" value={entity} onChange={(e) => setEntity(e.target.value)} placeholder="e.g. request, claim, user" helper="Exact entity type" />
          <Button type="submit" icon={Filter} variant="secondary" className="sm:mb-6">Apply</Button>
          <Button variant="ghost" disabled={!hasFilter && !action && !entity} className="sm:mb-6" onClick={() => { setAction(''); setEntity(''); apply('', ''); }}>Clear</Button>
        </form>
      </Card>

      {page.error && !page.data ? (
        <Card padding="none"><ErrorState message={`${page.error}.`} onRetry={() => void page.reload()} /></Card>
      ) : (
        <>
          <DataTable caption="Audit entries, newest first" data={items} columns={columns} rowKey={(r) => r.id} loading={page.loading} pageSize={0}
            onRowClick={setOpen} isRowActive={(r) => r.id === open?.id} maxHeight="65vh"
            empty={<EmptyState compact icon={ScrollText} title={hasFilter ? 'No entries match these filters' : 'No audit entries yet'}
              description={hasFilter ? 'Try a broader prefix such as “request.”' : undefined} />} />
          <nav className="mt-3 flex items-center justify-between gap-3 text-sm text-ink-500" aria-label="Audit pages">
            <span className="tabular-nums" aria-live="polite">
              {total ? <>{fmtNumber(offset + 1)}–{fmtNumber(offset + items.length)} of {fmtNumber(total)}</> : page.loading ? 'Loading…' : '0 entries'}
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" icon={ChevronLeft} disabled={offset === 0 || page.loading} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Newer</Button>
              <Button size="sm" variant="secondary" iconRight={ChevronRight} disabled={offset + PAGE >= total || page.loading} onClick={() => setOffset(offset + PAGE)}>Older</Button>
            </div>
          </nav>
        </>
      )}
      <DetailDrawer item={open} onClose={() => setOpen(null)} />
    </div>
  );
}
