import { useMemo, useState, type FormEvent } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  Ambulance, ArrowLeft, ArrowRight, BadgeCheck, Check, CheckCircle2, ClipboardPaste, Hospital, Plus, Power,
  Stethoscope, Trash2, Warehouse, XCircle,
} from 'lucide-react';
import {
  Badge, Button, Card, ConfirmDialog, DataTable, EmptyState, ErrorState, IconButton, Input, PageHeader, SegmentedControl, Select,
  StatusPill, Tabs, Textarea, tabPanelProps, useToast, type Column,
} from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { get, patch, post } from '../../lib/api';
import { cn } from '../../lib/cn';
import { fmtNumber } from '../../lib/format';
import { humanize } from '../../lib/status';
import type { AmbulanceBrief, LatLng } from '../../lib/types';
import { MAX_BULK, parseFleetText, type CsvColumn } from './shared/logic';
import { PlacePicker } from './shared/PlacePicker';
import type { AdminHospital, AdminStation } from './shared/types';
import { ExportButton } from './shared/widgets';

/* ------------------------------------------------------------------ helpers */

export const SPECIALTIES = ['cardiology', 'neurology', 'trauma', 'obstetrics', 'burns', 'pulmonology', 'toxicology'];

/** Normalise the backend's specialists (dict name→count; older: list / comma string) to entries. */
export function specialistEntries(s: AdminHospital['specialists']): [string, number][] {
  if (!s) return [];
  if (typeof s === 'string') return s.split(',').map((x) => x.trim()).filter(Boolean).map((x) => [x, 1]);
  if (Array.isArray(s)) return s.map((x) => [String(x), 1]);
  return Object.entries(s).map(([k, v]) => [k, Number(v) || 0]);
}

type Step = 0 | 1 | 2 | 3;
const STEPS = [
  { label: 'Hospital', icon: Hospital },
  { label: 'Station', icon: Warehouse },
  { label: 'Fleet', icon: Ambulance },
];

function WizardSteps({ step }: { step: Step }) {
  return (
    <ol className="flex items-center gap-2 sm:gap-3" aria-label="Onboarding progress">
      {STEPS.map((s, i) => {
        const done = step > i;
        const cur = step === i;
        const Icon = s.icon;
        return (
          <li key={s.label} className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3" aria-current={cur ? 'step' : undefined}>
            <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold transition-colors',
              done ? 'bg-success text-white' : cur ? 'bg-brand-500 text-white shadow-[0_0_0_4px_rgb(var(--brand-500)/.15)]' : 'border-2 border-line-strong bg-surface text-ink-500')}>
              {done ? <Check size={18} strokeWidth={3} aria-hidden /> : <Icon size={18} aria-hidden />}
            </span>
            <span className="min-w-0">
              <span className="block text-xs font-medium text-ink-500">Step {i + 1}</span>
              <span className={cn('block truncate text-sm font-semibold', cur || done ? 'text-ink-900' : 'text-ink-500')}>
                {s.label}<span className="sr-only">{done ? ' (done)' : cur ? ' (current)' : ''}</span>
              </span>
            </span>
            {i < STEPS.length - 1 && <span className={cn('mx-1 hidden h-0.5 flex-1 rounded-full sm:block', done ? 'bg-success/50' : 'bg-line')} aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ specialists editor */

function SpecialistsEditor({ value, onChange }: { value: [string, number][]; onChange: (v: [string, number][]) => void }) {
  const [custom, setCustom] = useState('');
  const has = new Set(value.map(([k]) => k));
  const add = (k: string) => { const n = k.trim().toLowerCase(); if (n && !has.has(n)) onChange([...value, [n, 1]]); };
  return (
    <fieldset className="space-y-3">
      <legend className="mb-1 flex items-center gap-2 text-sm font-semibold text-ink-700"><Stethoscope size={16} aria-hidden /> Specialists on duty</legend>
      <p className="text-xs text-ink-500">Dispatch requires cardiology for cardiac, neurology for stroke, trauma for injuries/burns and obstetrics for maternity.</p>
      <div className="flex flex-wrap gap-2">
        {SPECIALTIES.filter((s) => !has.has(s)).map((s) => (
          <button key={s} type="button" onClick={() => add(s)}
            className="press inline-flex h-8 items-center gap-1 rounded-full border border-dashed border-line-strong px-3 text-sm font-medium text-ink-700 hover:border-ink-400 hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
            <Plus size={14} aria-hidden /> {humanize(s)}
          </button>
        ))}
      </div>
      {value.length > 0 && (
        <ul className="divide-y divide-line rounded-md border border-line">
          {value.map(([k, n], i) => (
            <li key={k} className="flex items-center gap-3 px-3 py-2">
              <span className="flex-1 text-sm font-semibold text-ink-900">{humanize(k)}</span>
              <label className="flex items-center gap-2 text-sm text-ink-500">
                <span>On duty</span>
                <input type="number" min={0} max={99} value={n} inputMode="numeric"
                  onChange={(e) => onChange(value.map((x, j) => (j === i ? [k, Math.max(0, Math.min(99, Number(e.target.value) || 0))] : x)))}
                  className="h-9 w-16 rounded-sm border border-line-strong px-2 text-right tabular-nums text-ink-900 focus:border-brand-500 focus:shadow-focus focus:outline-none"
                  aria-label={`${humanize(k)} specialists on duty`} />
              </label>
              <IconButton size="sm" label={`Remove ${humanize(k)}`} icon={Trash2} onClick={() => onChange(value.filter((_, j) => j !== i))} />
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Input hideLabel label="Other specialty" placeholder="Other specialty" value={custom} onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(custom); setCustom(''); } }} wrapperClassName="flex-1" className="h-10" />
        <Button variant="secondary" size="sm" icon={Plus} className="h-10" disabled={!custom.trim()} onClick={() => { add(custom); setCustom(''); }}>Add</Button>
      </div>
    </fieldset>
  );
}

/* ------------------------------------------------------------------ wizard */

interface PickedHospital { id: number; name: string; isNew: boolean; pos?: LatLng }
interface Created { hospital?: PickedHospital; station?: { id: number; name: string; isNew: boolean }; ambulances: number }

const intIn = (s: string, min: number, max: number) => /^\d+$/.test(s.trim()) && Number(s) >= min && Number(s) <= max;

function HospitalStep({ hospitals, onDone }: { hospitals: AdminHospital[]; onDone: (h: PickedHospital) => void }) {
  const { success, error } = useToast();
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [existing, setExisting] = useState('');
  const [f, setF] = useState({ name: '', address: '', beds: '', icu: '', share: '' });
  const [addrTouched, setAddrTouched] = useState(false);
  const [pos, setPos] = useState<LatLng | null>(null);
  const [spec, setSpec] = useState<[string, number][]>([]);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const errs: Record<string, string | undefined> = {
    name: f.name.trim().length < 2 ? 'Enter the hospital name' : hospitals.some((h) => h.name.toLowerCase() === f.name.trim().toLowerCase()) ? 'A hospital with this name already exists' : undefined,
    beds: !intIn(f.beds, 0, 100000) ? 'Enter total beds (whole number)' : undefined,
    icu: !intIn(f.icu, 0, 100000) ? 'Enter total ICU beds (whole number)' : intIn(f.beds, 0, 100000) && Number(f.icu) > Number(f.beds) ? 'ICU beds cannot exceed total beds' : undefined,
    share: f.share.trim() && !(Number(f.share) >= 0 && Number(f.share) <= 100) ? 'Between 0 and 100' : undefined,
  };
  const e = (k: string) => (touched ? errs[k] : undefined);
  const set = (k: keyof typeof f) => (ev: { target: { value: string } }) => setF((x) => ({ ...x, [k]: ev.target.value }));

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (mode === 'existing') {
      const h = hospitals.find((x) => String(x.id) === existing);
      if (h) onDone({ id: h.id, name: h.name, isNew: false, pos: [h.lat, h.lng] });
      return;
    }
    setTouched(true);
    if (Object.values(errs).some(Boolean) || !pos) return;
    setBusy(true);
    try {
      const h = await post<AdminHospital>('/admin/hospitals', {
        name: f.name.trim(), address: f.address.trim(), lat: pos[0], lng: pos[1], total_beds: Number(f.beds), total_icu: Number(f.icu),
        specialists: spec.length ? Object.fromEntries(spec) : undefined,
        revenue_share_pct: f.share.trim() ? Number(f.share) : undefined,
      });
      const name = h?.name ?? f.name.trim();
      success(`${name} is now a partner hospital.`, { title: 'Hospital created' });
      onDone({ id: h.id, name, isNew: true, pos });
    } catch (e2) { error(e2, { title: "Couldn't create hospital" }); } finally { setBusy(false); }
  };

  return (
    <form onSubmit={(ev) => void submit(ev)} noValidate className="space-y-6">
      <SegmentedControl ariaLabel="Hospital source" value={mode} onChange={setMode}
        items={[{ value: 'new', label: 'New hospital' }, { value: 'existing', label: 'Existing hospital', disabled: !hospitals.length }]} />
      {mode === 'existing' ? (
        <Select label="Partner hospital" required value={existing} onChange={(ev) => setExisting(ev.target.value)} placeholder="Choose a hospital"
          options={hospitals.map((h) => ({ value: h.id, label: h.name }))} helper="Add a new station or fleet to a hospital that is already onboarded." wrapperClassName="max-w-lg" />
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-4">
            <Input label="Hospital name" required value={f.name} onChange={set('name')} error={e('name')} placeholder="e.g. Apollo Hospitals, Greams Road" data-autofocus />
            <Textarea label="Address" rows={2} value={f.address} onChange={(ev) => { setAddrTouched(true); set('address')(ev); }} helper="Filled from the map pin — edit if needed" maxLength={255} />
            <div className="grid grid-cols-2 gap-4">
              <Input label="Total beds" required inputMode="numeric" value={f.beds} onChange={set('beds')} error={e('beds')} className="tabular-nums" />
              <Input label="ICU beds" required inputMode="numeric" value={f.icu} onChange={set('icu')} error={e('icu')} className="tabular-nums" />
            </div>
            <Input label="Revenue share" inputMode="decimal" value={f.share} onChange={set('share')} error={e('share')} placeholder="Platform default"
              trailing={<span className="pr-2 text-sm text-ink-500">%</span>} helper="Optional · hospital's share of each fare; leave blank for the platform default" />
          </div>
          <div className="space-y-6">
            <PlacePicker label="Hospital location" value={pos} onChange={setPos} pinLabel="Hospital entrance"
              onAddress={(a) => { if (!addrTouched) setF((x) => ({ ...x, address: a })); }} />
            <SpecialistsEditor value={spec} onChange={setSpec} />
          </div>
        </div>
      )}
      <div className="flex justify-end border-t border-line pt-4">
        <Button type="submit" iconRight={ArrowRight} loading={busy} disabled={mode === 'existing' && !existing}>
          {mode === 'new' ? 'Create hospital & continue' : 'Continue'}
        </Button>
      </div>
    </form>
  );
}

function StationStep({ hospital, stations, onBack, onDone }: {
  hospital: PickedHospital; stations: AdminStation[];
  onBack: () => void; onDone: (s: { id: number; name: string; isNew: boolean }) => void;
}) {
  const { success, error } = useToast();
  const mine = stations.filter((s) => s.hospital_id === hospital.id);
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [existing, setExisting] = useState('');
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [addrTouched, setAddrTouched] = useState(false);
  const [pos, setPos] = useState<LatLng | null>(hospital.pos ?? null);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const nameErr = touched && name.trim().length < 2 ? 'Enter a station name, e.g. “Adyar dark station”' : undefined;

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (mode === 'existing') {
      const s = mine.find((x) => String(x.id) === existing);
      if (s) onDone({ id: s.id, name: s.name, isNew: false });
      return;
    }
    setTouched(true);
    if (name.trim().length < 2 || !pos) return;
    setBusy(true);
    try {
      const s = await post<AdminStation>(`/admin/hospitals/${hospital.id}/stations`, { name: name.trim(), address: address.trim(), lat: pos[0], lng: pos[1] });
      const sname = s?.name ?? name.trim();
      success(`${sname} is ready for ambulances.`, { title: 'Station created' });
      onDone({ id: s.id, name: sname, isNew: true });
    } catch (e2) { error(e2, { title: "Couldn't create station" }); } finally { setBusy(false); }
  };

  return (
    <form onSubmit={(ev) => void submit(ev)} noValidate className="space-y-6">
      <p className="text-sm text-ink-500">Dark stations are where <b className="font-semibold text-ink-900">{hospital.name}</b>'s ambulances wait between trips.</p>
      <SegmentedControl ariaLabel="Station source" value={mode} onChange={setMode}
        items={[{ value: 'new', label: 'New station' }, { value: 'existing', label: `Existing (${mine.length})`, disabled: !mine.length }]} />
      {mode === 'existing' ? (
        <Select label="Station" required value={existing} onChange={(ev) => setExisting(ev.target.value)} placeholder="Choose a station"
          options={mine.map((s) => ({ value: s.id, label: `${s.name}${s.is_active === false ? ' (inactive)' : ''}` }))} wrapperClassName="max-w-lg" />
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-4">
            <Input label="Station name" required value={name} onChange={(ev) => setName(ev.target.value)} error={nameErr} placeholder="e.g. Adyar dark station" />
            <Textarea label="Address" rows={2} value={address} onChange={(ev) => { setAddrTouched(true); setAddress(ev.target.value); }} helper="Filled from the map pin — edit if needed" maxLength={255} />
          </div>
          <PlacePicker label="Station location" value={pos} onChange={setPos} pinLabel="Ambulances park here"
            onAddress={(a) => { if (!addrTouched) setAddress(a); }} />
        </div>
      )}
      <div className="flex justify-between gap-3 border-t border-line pt-4">
        <Button variant="ghost" icon={ArrowLeft} onClick={onBack}>Back</Button>
        <Button type="submit" iconRight={ArrowRight} loading={busy} disabled={mode === 'existing' && !existing}>
          {mode === 'new' ? 'Create station & continue' : 'Continue'}
        </Button>
      </div>
    </form>
  );
}

const EXAMPLE = 'TN 01 AB 1234, ALS, yes\nTN 01 AB 1235, BLS, yes\nTN 09 CD 4321, BLS, no';

function FleetStep({ station, existingRegs, onBack, onDone }: {
  station: { id: number; name: string }; existingRegs: string[]; onBack: () => void; onDone: (n: number) => void;
}) {
  const { success, error } = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => parseFleetText(text, existingRegs), [text, existingRegs]);
  const canSubmit = parsed.valid.length > 0 && parsed.invalidCount === 0 && parsed.errors.length === 0;

  const submit = async () => {
    setBusy(true);
    try {
      const out = await post<{ created: number }>(`/admin/stations/${station.id}/ambulances/bulk`, {
        ambulances: parsed.valid.map((r) => ({ registration_number: r.registration_number, kind: r.kind, staffed: r.staffed })),
      });
      const n = out?.created ?? parsed.valid.length;
      success(`${n} ambulance${n > 1 ? 's' : ''} added to ${station.name}.`, { title: 'Fleet registered' });
      onDone(n);
    } catch (e) { error(e, { title: "Couldn't register the fleet — nothing was saved" }); } finally { setBusy(false); }
  };

  const cols: Column<(typeof parsed.rows)[number]>[] = [
    { key: 'line', header: 'Line', align: 'right', width: 'w-14', cell: (r) => <span className="text-ink-500">{r.line}</span> },
    { key: 'registration_number', header: 'Registration', cell: (r) => <span className="whitespace-nowrap font-mono font-semibold">{r.registration_number || '—'}</span> },
    { key: 'kind', header: 'Type', cell: (r) => <Badge tone={r.kind === 'ALS' ? 'violet' : 'neutral'}>{r.kind}</Badge> },
    { key: 'staffed', header: 'Crew', hideBelow: 'sm', cell: (r) => <span className="text-ink-700">{r.staffed ? 'Staffed' : 'Unstaffed (offline)'}</span> },
    {
      key: 'errors', header: 'Check', cell: (r) => r.errors.length
        ? <span className="flex items-start gap-1.5 text-sm font-medium text-danger-fg"><XCircle size={16} className="mt-0.5 shrink-0" aria-hidden />{r.errors.join(' · ')}</span>
        : <span className="flex items-center gap-1.5 text-sm font-medium text-success-fg"><CheckCircle2 size={16} aria-hidden />Ready</span>,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="space-y-3">
          <Textarea label={`Ambulances for ${station.name}`} rows={9} value={text} onChange={(e) => setText(e.target.value)}
            className="font-mono text-sm" placeholder={EXAMPLE} spellCheck={false}
            helper={`One per line: registration, type, staffed. Type BLS or ALS (default BLS); staffed yes or no (default yes). Pasting from a spreadsheet works too. Up to ${MAX_BULK}.`} />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" icon={ClipboardPaste} onClick={() => setText((t) => (t.trim() ? `${t.trim()}\n${EXAMPLE}` : EXAMPLE))}>Insert example</Button>
            {text && <Button size="sm" variant="ghost" onClick={() => setText('')}>Clear</Button>}
          </div>
        </div>
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-sm" aria-live="polite">
            <span className="font-semibold text-ink-900">Preview</span>
            {parsed.rows.length > 0 && <>
              <Badge tone="success" icon={CheckCircle2}>{parsed.valid.length} ready</Badge>
              {parsed.invalidCount > 0 && <Badge tone="danger" icon={XCircle}>{parsed.invalidCount} to fix</Badge>}
            </>}
          </div>
          {parsed.errors.map((er) => <p key={er} role="alert" className="mb-2 text-sm font-medium text-danger-fg">{er}</p>)}
          <DataTable caption="Fleet rows to register" data={parsed.rows} columns={cols} rowKey={(r) => r.line} pageSize={0} maxHeight="20rem" className="shadow-none"
            empty={<EmptyState compact icon={Ambulance} title="Nothing to register yet" description="Paste or type registrations on the left." />} />
        </div>
      </div>
      <div className="flex flex-wrap justify-between gap-3 border-t border-line pt-4">
        <Button variant="ghost" icon={ArrowLeft} onClick={onBack}>Back</Button>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => onDone(0)}>Skip for now</Button>
          <Button icon={Ambulance} loading={busy} disabled={!canSubmit} onClick={() => void submit()}>
            {parsed.valid.length ? `Register ${parsed.valid.length} ambulance${parsed.valid.length > 1 ? 's' : ''}` : 'Register ambulances'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function SuccessScreen({ created, onAgain, onView }: { created: Created; onAgain: () => void; onView: () => void }) {
  const reduce = useReducedMotion();
  return (
    <div className="flex flex-col items-center px-4 py-8 text-center">
      <motion.span initial={reduce ? { opacity: 0 } : { scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 420, damping: 22 }}
        className="flex h-20 w-20 items-center justify-center rounded-full bg-success-bg text-success" aria-hidden>
        <BadgeCheck size={40} />
      </motion.span>
      <h2 className="mt-5 text-2xl font-extrabold text-ink-900">Partner onboarded</h2>
      <p className="mt-1 max-w-md text-ink-500">Dispatch can use the new capacity immediately. Every step was written to the audit log.</p>
      <dl className="mt-6 grid w-full max-w-2xl gap-3 text-left sm:grid-cols-3">
        {[
          { icon: Hospital, k: 'Hospital', v: created.hospital?.name, n: created.hospital?.isNew ? 'New' : 'Existing' },
          { icon: Warehouse, k: 'Station', v: created.station?.name, n: created.station?.isNew ? 'New' : 'Existing' },
          { icon: Ambulance, k: 'Fleet', v: `${created.ambulances} ambulance${created.ambulances === 1 ? '' : 's'}`, n: created.ambulances ? 'Registered' : 'Skipped' },
        ].map(({ icon: Icon, k, v, n }) => (
          <div key={k} className="rounded-md border border-line bg-canvas p-3">
            <dt className="flex items-center gap-1.5 text-xs font-medium text-ink-500"><Icon size={14} aria-hidden /> {k} · {n}</dt>
            <dd className="mt-1 text-sm font-semibold text-ink-900">{v ?? '--'}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Button variant="secondary" icon={Plus} onClick={onAgain}>Onboard another</Button>
        <Button icon={Ambulance} onClick={onView}>View fleet</Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ registry tables */

const HOSP_CSV: CsvColumn<AdminHospital>[] = [
  { header: 'ID', value: (h) => h.id }, { header: 'Name', value: (h) => h.name }, { header: 'Address', value: (h) => h.address },
  { header: 'Total beds', value: (h) => h.total_beds }, { header: 'Total ICU', value: (h) => h.total_icu },
  { header: 'Specialists', value: (h) => specialistEntries(h.specialists).map(([k, n]) => `${k}:${n}`).join(' ') },
  { header: 'Revenue share %', value: (h) => h.revenue_share_pct }, { header: 'Stations', value: (h) => h.stations },
];

function HospitalsTable({ data, loading }: { data: AdminHospital[]; loading: boolean }) {
  const cols: Column<AdminHospital>[] = [
    { key: 'name', header: 'Hospital', sortable: true, cell: (h) => (
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 font-semibold text-ink-900">{h.name}{h.partner_verified && <BadgeCheck size={16} className="shrink-0 text-info" aria-label="Verified partner" />}</p>
        <p className="max-w-xs truncate text-sm text-ink-500">{h.address || '--'}</p>
      </div>
    ) },
    { key: 'total_beds', header: 'Beds', sortable: true, align: 'right', cell: (h) => <span className="tabular-nums">{h.available_beds ?? '--'}<span className="text-ink-500"> / {h.total_beds ?? '--'}</span></span> },
    { key: 'total_icu', header: 'ICU', sortable: true, align: 'right', hideBelow: 'sm', cell: (h) => <span className="tabular-nums">{h.available_icu ?? '--'}<span className="text-ink-500"> / {h.total_icu ?? '--'}</span></span> },
    { key: 'specialists', header: 'Specialists', hideBelow: 'md', accessor: (h) => specialistEntries(h.specialists).map(([k]) => k).join(' '), cell: (h) => {
      const sp = specialistEntries(h.specialists);
      return sp.length ? <div className="flex max-w-xs flex-wrap gap-1">{sp.slice(0, 3).map(([k, n]) => <Badge key={k}>{humanize(k)} · {n}</Badge>)}{sp.length > 3 && <Badge tone="muted">+{sp.length - 3}</Badge>}</div> : <span className="text-ink-400">—</span>;
    } },
    { key: 'revenue_share_pct', header: 'Share', sortable: true, align: 'right', hideBelow: 'lg', cell: (h) => (h.revenue_share_pct !== null && h.revenue_share_pct !== undefined ? `${h.revenue_share_pct}%` : '--') },
    { key: 'stations', header: 'Stations', sortable: true, align: 'right', hideBelow: 'lg' },
  ];
  return (
    <DataTable caption="Partner hospitals" data={data} columns={cols} rowKey={(h) => h.id} loading={loading} searchable searchPlaceholder="Search hospitals"
      initialSort={{ key: 'name', dir: 'asc' }} toolbar={<ExportButton rows={data} columns={HOSP_CSV} name="hospitals" />}
      empty={<EmptyState compact icon={Hospital} title="No partner hospitals yet" description="Use “Add partner” to onboard the first one." />} />
  );
}

function StationsTable({ data, loading, onToggled }: { data: AdminStation[]; loading: boolean; onToggled: (s: AdminStation) => void }) {
  const { success, error } = useToast();
  const [confirm, setConfirm] = useState<AdminStation | null>(null);
  const toggle = async (s: AdminStation) => {
    const next = s.is_active === false;
    try {
      const out = await patch<AdminStation>(`/admin/stations/${s.id}`, { is_active: next });
      onToggled({ ...s, ...out, is_active: out?.is_active ?? next });
      success(next ? `${s.name} is back in service.` : `${s.name} will no longer receive dispatches.`, { title: next ? 'Station activated' : 'Station deactivated' });
    } catch (e) { error(e, { title: "Couldn't update station" }); throw e; }
  };
  const cols: Column<AdminStation>[] = [
    { key: 'name', header: 'Station', sortable: true, cell: (s) => (
      <div className="min-w-0"><p className="font-semibold text-ink-900">{s.name}</p><p className="max-w-xs truncate text-sm text-ink-500">{s.address || `${s.lat.toFixed(4)}, ${s.lng.toFixed(4)}`}</p></div>
    ) },
    { key: 'hospital_name', header: 'Hospital', sortable: true, hideBelow: 'md' },
    { key: 'ambulances', header: 'Available', sortable: true, align: 'right', cell: (s) => <span className="tabular-nums">{s.available ?? '--'}<span className="text-ink-500"> / {s.ambulances ?? '--'}</span></span> },
    { key: 'is_active', header: 'Status', sortable: true, accessor: (s) => (s.is_active === false ? 'inactive' : 'active'), cell: (s) => <StatusPill kind="generic" status={s.is_active === false ? 'inactive' : 'active'} /> },
    { key: 'act', header: <span className="sr-only">Actions</span>, align: 'right', cell: (s) => (
      <Button size="sm" variant={s.is_active === false ? 'secondary' : 'ghost'} icon={Power} onClick={(e) => { e.stopPropagation(); if (s.is_active === false) void toggle(s).catch(() => {}); else setConfirm(s); }}>
        {s.is_active === false ? 'Activate' : 'Deactivate'}
      </Button>
    ) },
  ];
  return (
    <>
      <DataTable caption="Dark stations" data={data} columns={cols} rowKey={(s) => s.id} loading={loading} searchable searchPlaceholder="Search stations or hospitals"
        initialSort={{ key: 'name', dir: 'asc' }}
        toolbar={<ExportButton rows={data} name="stations" columns={[
          { header: 'ID', value: (s) => s.id }, { header: 'Name', value: (s) => s.name }, { header: 'Hospital', value: (s) => s.hospital_name },
          { header: 'Latitude', value: (s) => s.lat }, { header: 'Longitude', value: (s) => s.lng }, { header: 'Ambulances', value: (s) => s.ambulances },
          { header: 'Available', value: (s) => s.available }, { header: 'Active', value: (s) => (s.is_active === false ? 'no' : 'yes') }]} />}
        empty={<EmptyState compact icon={Warehouse} title="No stations yet" />} />
      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)} tone="danger" icon={Power}
        title={`Deactivate ${confirm?.name}?`} confirmLabel="Deactivate"
        description="Its ambulances stay registered but the station is excluded from dispatch and rebalancing until reactivated."
        onConfirm={() => (confirm ? toggle(confirm) : undefined)} />
    </>
  );
}

function FleetTable({ data, loading }: { data: AmbulanceBrief[]; loading: boolean }) {
  const cols: Column<AmbulanceBrief>[] = [
    { key: 'registration_number', header: 'Registration', sortable: true, cell: (a) => <span className="font-mono font-semibold">{a.registration_number}</span> },
    { key: 'kind', header: 'Type', sortable: true, cell: (a) => <Badge tone={a.kind?.toUpperCase() === 'ALS' ? 'violet' : 'neutral'}>{a.kind?.toUpperCase() ?? '--'}</Badge> },
    { key: 'station_name', header: 'Station', sortable: true, hideBelow: 'sm' },
    { key: 'crew_name', header: 'Crew', hideBelow: 'md', cell: (a) => <span className="text-ink-700">{a.crew_name ?? '—'}</span> },
    { key: 'status', header: 'Status', sortable: true, cell: (a) => <StatusPill kind="ambulance" status={a.status} /> },
  ];
  return (
    <DataTable caption="Fleet" data={data} columns={cols} rowKey={(a) => a.id} loading={loading} searchable searchPlaceholder="Search registration or station"
      initialSort={{ key: 'registration_number', dir: 'asc' }} pageSize={15}
      toolbar={<ExportButton rows={data} name="fleet" columns={[
        { header: 'ID', value: (a) => a.id }, { header: 'Registration', value: (a) => a.registration_number }, { header: 'Type', value: (a) => a.kind },
        { header: 'Station', value: (a) => a.station_name }, { header: 'Status', value: (a) => a.status }]} />}
      empty={<EmptyState compact icon={Ambulance} title="No ambulances registered" />} />
  );
}

/* ------------------------------------------------------------------ page */

type View = 'wizard' | 'hospitals' | 'stations' | 'fleet';

export default function Onboarding() {
  const reduce = useReducedMotion();
  const hospitals = useAsync(() => get<AdminHospital[]>('/admin/hospitals'), []);
  const stations = useAsync(() => get<AdminStation[]>('/admin/stations'), []);
  const fleet = useAsync(async () => (await get<{ ambulances: AmbulanceBrief[] }>('/controller/board')).ambulances ?? [], []);
  const [view, setView] = useState<View>('wizard');
  const [step, setStep] = useState<Step>(0);
  const [created, setCreated] = useState<Created>({ ambulances: 0 });
  const regs = useMemo(() => (fleet.data ?? []).map((a) => a.registration_number), [fleet.data]);

  const reset = () => { setCreated({ ambulances: 0 }); setStep(0); };
  const anyError = hospitals.error && stations.error && !hospitals.data && !stations.data;

  return (
    <div>
      <PageHeader title="Onboarding" subtitle="Add partner hospitals, their dark stations and fleet (FR12)" />
      <Tabs id="onb" ariaLabel="Onboarding sections" value={view} onChange={setView} className="mb-6"
        items={[
          { value: 'wizard', label: 'Add partner', icon: Plus },
          { value: 'hospitals', label: 'Hospitals', icon: Hospital, badge: hospitals.data?.length },
          { value: 'stations', label: 'Stations', icon: Warehouse, badge: stations.data?.length },
          { value: 'fleet', label: 'Fleet', icon: Ambulance, badge: fleet.data?.length },
        ]} />
      <div {...tabPanelProps('onb', view)} className="focus-visible:outline-none">
        {anyError ? (
          <Card padding="none"><ErrorState message={`${hospitals.error}.`} onRetry={() => { void hospitals.reload(); void stations.reload(); void fleet.reload(); }} /></Card>
        ) : view === 'wizard' ? (
          <Card padding="lg">
            {step < 3 && <div className="mb-8"><WizardSteps step={step} /></div>}
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={step} initial={reduce ? { opacity: 0 } : { opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, x: -12, transition: { duration: 0.12 } }} transition={{ duration: 0.2, ease: 'easeOut' }}>
                {step === 0 && <HospitalStep hospitals={hospitals.data ?? []} onDone={(h) => { setCreated((c) => ({ ...c, hospital: h })); setStep(1); if (h.isNew) void hospitals.reload(); }} />}
                {step === 1 && created.hospital && (
                  <StationStep hospital={created.hospital} stations={stations.data ?? []} onBack={() => setStep(0)}
                    onDone={(s) => { setCreated((c) => ({ ...c, station: s })); setStep(2); if (s.isNew) void stations.reload(); }} />
                )}
                {step === 2 && created.station && (
                  <FleetStep station={created.station} existingRegs={regs} onBack={() => setStep(1)}
                    onDone={(n) => { setCreated((c) => ({ ...c, ambulances: n })); setStep(3); if (n) { void fleet.reload(); void stations.reload(); void hospitals.reload(); } }} />
                )}
                {step === 3 && <SuccessScreen created={created} onAgain={reset} onView={() => { reset(); setView('fleet'); }} />}
              </motion.div>
            </AnimatePresence>
          </Card>
        ) : view === 'hospitals' ? (
          <HospitalsTable data={hospitals.data ?? []} loading={hospitals.loading} />
        ) : view === 'stations' ? (
          <StationsTable data={stations.data ?? []} loading={stations.loading}
            onToggled={(s) => stations.setData((xs) => xs?.map((x) => (x.id === s.id ? s : x)) ?? xs)} />
        ) : (
          <>
            {fleet.error && !fleet.data
              ? <Card padding="none"><ErrorState message={`${fleet.error}.`} onRetry={() => void fleet.reload()} /></Card>
              : <FleetTable data={fleet.data ?? []} loading={fleet.loading} />}
            <p className="mt-3 text-xs text-ink-500">{fmtNumber(fleet.data?.length ?? 0)} ambulances. Status is live from the dispatch board.</p>
          </>
        )}
      </div>
    </div>
  );
}
