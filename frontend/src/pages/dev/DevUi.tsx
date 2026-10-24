import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Activity, Ambulance, BedDouble, Bell, CheckCircle, Clock, Inbox, MapPin, Plus, Search, Settings, Siren, Trash2, Users,
} from 'lucide-react';
import {
  Avatar, Badge, Button, Card, CardHeader, ConfirmDialog, CountdownRing, DataTable, Drawer, EmptyState, ErrorState,
  IconButton, IncidentBadge, Input, Modal, PageHeader, ProgressSteps, PulseRadar, SectionTitle, SegmentedControl, Select,
  SeverityBadge, Sheet, Skeleton, SkeletonCard, SkeletonText, SlideButton, StatCard, StatusPill, Stepper, Switch, Tabs,
  Textarea, Timeline, requestTimelineItems, useToast, Call108Button, type Column,
} from '../../components/ui';
import {
  AmbulanceMarker, FitBounds, HospitalMarker, MapCanvas, PatientPin, RiskHeatLayer, RouteLine, StationMarker,
} from '../../components/map';
import { BrandMark, ConnectionIndicator } from '../../components/layout/Chrome';
import { AMBULANCE_STATUSES, INCIDENT_KEYS, REQUEST_STATUSES } from '../../lib/status';
import { fmtDistance, fmtEta, fmtMoney, fmtRelative } from '../../lib/format';
import { pointAlong } from '../../lib/geo';
import type { LatLng } from '../../lib/types';

const NOW = Date.now();
const SECTIONS = ['Tokens', 'Buttons', 'Status', 'Cards', 'Forms', 'Controls', 'Trip', 'Feedback', 'Table', 'Overlays', 'Map', 'Picker'] as const;

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 border-b border-line py-10 last:border-0">
      <h2 className="mb-5 text-xl font-extrabold">{title}</h2>
      {children}
    </section>
  );
}
const Row = ({ children, label }: { children: ReactNode; label?: string }) => (
  <div className="mb-5">
    {label && <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">{label}</p>}
    <div className="flex flex-wrap items-center gap-3">{children}</div>
  </div>
);

// Demo geometry (Chennai): station -> patient -> hospital.
const ROUTE: LatLng[] = [
  [13.0405, 80.2337], [13.0418, 80.2405], [13.0447, 80.2462], [13.0489, 80.2491], [13.0524, 80.2535], [13.0569, 80.2551],
];
const PATIENT: LatLng = ROUTE[ROUTE.length - 1];
const TO_HOSP: LatLng[] = [PATIENT, [13.0602, 80.2564], [13.0617, 80.2600], [13.0635, 80.2622]];
const HOSPITALS = [
  { id: 1, name: 'Apollo Greams Road', pos: [13.0635, 80.2622] as LatLng, beds: 24, icu: 5 },
  { id: 2, name: 'Kauvery Alwarpet', pos: [13.0338, 80.2532] as LatLng, beds: 3, icu: 0 },
  { id: 3, name: 'SIMS Vadapalani', pos: [13.0510, 80.2120] as LatLng, beds: 0, icu: 0 },
  { id: 4, name: 'Govt. General', pos: [13.0820, 80.2770] as LatLng, beds: null, icu: null, stale: true },
];
const ZONES = Array.from({ length: 36 }, (_, i) => ({
  lat: 13.0 + (i % 6) * 0.018 + ((i * 37) % 7) * 0.001,
  lng: 80.19 + Math.floor(i / 6) * 0.02 + ((i * 13) % 5) * 0.001,
  risk: Math.abs(Math.sin(i * 1.7)) * (i % 5 === 0 ? 1 : 0.55),
}));

interface Row_ { id: number; reg: string; station: string; status: string; eta: number | null; trips: number }
const TABLE: Row_[] = Array.from({ length: 23 }, (_, i) => ({
  id: i + 1,
  reg: `TN 0${(i % 9) + 1} AM ${4000 + i * 37}`,
  station: ['Adyar', 'T. Nagar', 'Anna Nagar', 'Velachery', 'Guindy'][i % 5],
  status: AMBULANCE_STATUSES[i % AMBULANCE_STATUSES.length],
  eta: i % 4 === 0 ? null : 60 + ((i * 97) % 900),
  trips: (i * 7) % 13,
}));

export default function DevUi() {
  const { toast, success, error, warning } = useToast();
  const [modal, setModal] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [sw, setSw] = useState(true);
  const [beds, setBeds] = useState(12);
  const [tab, setTab] = useState('incoming');
  const [seg, setSeg] = useState('map');
  const [progress, setProgress] = useState(1);
  const [center, setCenter] = useState<LatLng | null>(null);

  // Simulated ambulance pings every 1.5 s along the route (exercises useGlide).
  const [t, setT] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setT((v) => (v >= 1 ? 0 : Math.min(1, v + 0.08))), 1500);
    return () => clearInterval(id);
  }, []);
  const amb = useMemo(() => pointAlong(ROUTE, t).position, [t]);

  const columns: Column<Row_>[] = [
    { key: 'reg', header: 'Ambulance', sortable: true, cell: (r) => <span className="font-semibold">{r.reg}</span> },
    { key: 'station', header: 'Station', sortable: true, hideBelow: 'sm' },
    { key: 'status', header: 'Status', sortable: true, cell: (r) => <StatusPill kind="ambulance" status={r.status} /> },
    { key: 'eta', header: 'ETA', sortable: true, align: 'right', cell: (r) => fmtEta(r.eta) },
    { key: 'trips', header: 'Trips', sortable: true, align: 'right', hideBelow: 'md' },
  ];

  return (
    <div className="min-h-dvh bg-canvas">
      <header className="sticky top-0 z-sticky border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
          <BrandMark />
          <span className="rounded-full bg-canvas px-2.5 py-1 text-xs font-bold text-ink-500">/dev/ui</span>
          <nav className="ml-auto hidden gap-1 overflow-x-auto text-sm font-semibold text-ink-500 lg:flex" aria-label="Sections">
            {SECTIONS.map((s) => <a key={s} href={`#${s}`} className="rounded-md px-2 py-1 hover:bg-canvas hover:text-ink-900">{s}</a>)}
          </nav>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-6xl px-4 pb-24">
        <PageHeader className="mt-8" title="Kitchen sink" subtitle="Every HADS UI component and map primitive in its states. See frontend/COMPONENTS.md for APIs."
          actions={<><ConnectionIndicator /><Button variant="secondary" size="sm" onClick={() => toast('Hello from the kit')}>Ping toast</Button></>} />

        <Section id="Tokens" title="Tokens">
          <Row label="Brand">
            {['bg-brand-50', 'bg-brand-100', 'bg-brand-200', 'bg-brand-400', 'bg-brand-500', 'bg-brand-600', 'bg-brand-700'].map((c) => <Swatch key={c} c={c} />)}
          </Row>
          <Row label="Ink / surfaces">
            {['bg-ink-900', 'bg-ink-700', 'bg-ink-500', 'bg-ink-400', 'bg-line-strong', 'bg-line', 'bg-canvas', 'bg-surface'].map((c) => <Swatch key={c} c={c} />)}
          </Row>
          <Row label="Tones (solid / bg)">
            {[['bg-success', 'bg-success-bg'], ['bg-info', 'bg-info-bg'], ['bg-warning', 'bg-warning-bg'], ['bg-violet', 'bg-violet-bg'],
              ['bg-orange', 'bg-orange-bg'], ['bg-teal', 'bg-teal-bg']].map(([a, b]) => (
              <div key={a} className="flex gap-1"><Swatch c={a} /><Swatch c={b} /></div>
            ))}
          </Row>
          <Row label="Type scale">
            <div className="space-y-1">
              <p className="text-4xl font-extrabold">Arriving in 4 min</p>
              <p className="text-2xl font-bold">Help is on the way</p>
              <p className="text-base">Body 16 — Bed confirmed at Apollo Greams Road.</p>
              <p className="text-sm text-ink-500">Secondary 14 — Updated 2 min ago</p>
              <p className="text-xs text-ink-500">Caption 12 — © OpenStreetMap contributors</p>
            </div>
          </Row>
          <Row label="Format helpers">
            <Badge>{fmtEta(245)}</Badge><Badge>{fmtMoney(125000)}</Badge><Badge>{fmtDistance(0.85)}</Badge><Badge>{fmtDistance(4.24)}</Badge>
            <Badge>{fmtRelative(NOW - 120000, NOW)}</Badge>
          </Row>
        </Section>

        <Section id="Buttons" title="Buttons">
          <Row label="Variants">
            <Button icon={Siren}>Primary</Button><Button variant="secondary">Secondary</Button><Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button><Button variant="danger" icon={Trash2}>Danger</Button><Button variant="success" icon={CheckCircle}>Success</Button>
            <Button variant="dark">Dark</Button>
          </Row>
          <Row label="Sizes / states">
            <Button size="sm">Small</Button><Button size="md">Medium</Button><Button size="lg">Large</Button><Button size="xl" icon={Siren}>Extra large</Button>
            <Button loading>Saving</Button><Button disabled>Disabled</Button><Call108Button />
          </Row>
          <Row label="Icon buttons">
            <IconButton label="Notifications" icon={Bell} badge={3} /><IconButton label="Settings" icon={Settings} variant="secondary" />
            <IconButton label="Add" icon={Plus} variant="primary" /><IconButton label="Locate" icon={MapPin} variant="floating" />
            <IconButton label="Delete" icon={Trash2} variant="danger" /><IconButton label="Loading" icon={Search} loading variant="secondary" />
          </Row>
        </Section>

        <Section id="Status" title="Status, severity, incidents">
          <Row label="Request status">{REQUEST_STATUSES.map((s) => <StatusPill key={s} status={s} />)}</Row>
          <Row label="Request status — consumer headline">{['matching', 'en_route', 'on_scene', 'transporting'].map((s) => <StatusPill key={s} status={s} headline size="md" />)}</Row>
          <Row label="Ambulance status">{AMBULANCE_STATUSES.map((s) => <StatusPill key={s} kind="ambulance" status={s} />)}</Row>
          <Row label="Generic">{['pending', 'paid', 'submitted', 'approved', 'rejected', 'stale'].map((s) => <StatusPill key={s} kind="generic" status={s} />)}</Row>
          <Row label="Severity">{[1, 2, 3, 4, 5].map((s) => <SeverityBadge key={s} severity={s} />)}<SeverityBadge severity={4} showLevel variant="solid" /></Row>
          <Row label="Incident types">{INCIDENT_KEYS.map((k) => <IncidentBadge key={k} type={k} />)}</Row>
          <Row label="Badges">
            <Badge tone="brand" dot pulse>Live</Badge><Badge tone="info" variant="solid">Solid</Badge><Badge tone="teal" variant="outline">Outline</Badge>
          </Row>
          <Row label="Avatars">
            <Avatar name="Priya Raman" size="xs" /><Avatar name="Ravi Kumar" size="sm" /><Avatar name="Arjun M" size="md" status="online" />
            <Avatar name="Lakshmi" size="lg" status="busy" /><Avatar name="Dr. Meena Iyer" size="xl" />
          </Row>
        </Section>

        <Section id="Cards" title="Cards & KPIs">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Avg response" value="7m 40s" icon={Clock} tone="info" delta={{ value: -12, unit: '%', goodWhen: 'down', label: 'vs last week' }} sparkline={[9, 8.4, 8.8, 7.9, 8.1, 7.6, 7.4]} />
            <StatCard label="Active trips" value="14" icon={Ambulance} tone="brand" delta={{ value: 3, label: 'last hour' }} />
            <StatCard label="Beds free" value="186" icon={BedDouble} tone="teal" hint="8 hospitals" sparkline={[200, 190, 195, 185, 186]} />
            <StatCard label="Loading" value="" loading icon={Activity} />
          </div>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader title="Apollo Greams Road" subtitle="2.4 km · 24 beds · 5 ICU" icon={BedDouble} action={<StatusPill kind="generic" status="live" />} />
              <p className="text-sm text-ink-500">Default card with header, icon and action slot.</p>
            </Card>
            <Card elevation="raised" interactive>
              <SectionTitle action={<Button size="sm" variant="ghost">View all</Button>}>Section title</SectionTitle>
              <p className="text-sm text-ink-500">Raised + interactive (hover lift, press scale).</p>
            </Card>
          </div>
        </Section>

        <Section id="Forms" title="Forms">
          <div className="grid max-w-3xl gap-4 sm:grid-cols-2">
            <Input label="Patient name" placeholder="Priya Raman" helper="As on ID if known" />
            <Input label="Phone" icon={Users} error="Enter a 10-digit mobile number" defaultValue="98400" />
            <Select label="Incident type" placeholder="Choose…" defaultValue="" options={INCIDENT_KEYS.map((k) => ({ value: k, label: k }))} />
            <Input label="Search" icon={Search} placeholder="Search hospitals" size="lg" />
            <Textarea label="Notes for the crew" placeholder="Gate 2, third floor" maxLength={200} showCount wrapperClassName="sm:col-span-2" />
            <Input label="Disabled" disabled defaultValue="Read only" />
          </div>
        </Section>

        <Section id="Controls" title="Controls">
          <div className="grid max-w-3xl gap-6">
            <Card><Switch checked={sw} onChange={setSw} label="On duty" description="You'll receive trip offers nearby" size="lg" /></Card>
            <Card><Stepper label="Available beds" helper="General ward" value={beds} onChange={setBeds} max={60} size="lg" /></Card>
            <Tabs ariaLabel="Hospital views" value={tab} onChange={setTab} items={[
              { value: 'incoming', label: 'Incoming', badge: 3 }, { value: 'capacity', label: 'Capacity' }, { value: 'history', label: 'History' },
            ]} />
            <Tabs variant="pill" ariaLabel="Filters" value={tab} onChange={setTab} items={[
              { value: 'incoming', label: 'All', badge: 12 }, { value: 'capacity', label: 'Critical', badge: 2 }, { value: 'history', label: 'Completed' },
            ]} />
            <div className="flex flex-wrap gap-3">
              <SegmentedControl ariaLabel="View" value={seg} onChange={setSeg} items={[{ value: 'map', label: 'Map', icon: MapPin }, { value: 'list', label: 'List', icon: Inbox }]} />
              <SegmentedControl ariaLabel="Range" size="sm" value={seg} onChange={setSeg} items={[{ value: 'map', label: 'Today' }, { value: 'list', label: '7 days' }]} />
            </div>
            <div className="max-w-md space-y-3">
              <SlideButton label="Slide to start trip" tone="info" onConfirm={() => new Promise((r) => setTimeout(r, 900))} confirmedLabel="Trip started" />
              <SlideButton label="Slide to confirm SOS" tone="brand" icon={Siren} onConfirm={() => { success('SOS confirmed'); }} />
              <SlideButton label="Slide to mark arrived" tone="teal" disabled onConfirm={() => {}} />
            </div>
          </div>
        </Section>

        <Section id="Trip" title="Trip progress">
          <Card className="max-w-xl">
            <ProgressSteps current={progress} />
            <div className="mt-4 flex gap-2">
              {[-1, 0, 1, 2, 3, 4].map((i) => <Button key={i} size="sm" variant={progress === i ? 'dark' : 'secondary'} onClick={() => setProgress(i)}>{i}</Button>)}
            </div>
          </Card>
          <div className="mt-6 grid gap-6 md:grid-cols-2">
            <Card>
              <CardHeader title="Timeline (from v2 events)" />
              <Timeline items={requestTimelineItems([
                { status: 'received', at: new Date(NOW - 600000).toISOString() },
                { status: 'accepted', at: new Date(NOW - 540000).toISOString() },
                { status: 'en_route', at: new Date(NOW - 500000).toISOString() },
              ], 'en_route', { consumer: true })} />
            </Card>
            <Card className="flex flex-col items-center justify-center gap-6">
              <PulseRadar label="Finding the nearest ambulance…" sublabel="Usually under 30 seconds" />
              <div className="flex items-center gap-6">
                <CountdownRing total={30} remaining={22} caption="sec" />
                <CountdownRing total={30} remaining={8} size={80} />
                <CountdownRing total={30} remaining={3} size={56} />
              </div>
            </Card>
          </div>
        </Section>

        <Section id="Feedback" title="Loading, empty, error, toasts">
          <div className="grid gap-4 md:grid-cols-3">
            <Card><SkeletonCard /><div className="mt-4"><SkeletonText lines={3} /></div><Skeleton className="mt-4 h-24 w-full" rounded="lg" /></Card>
            <Card padding="none"><EmptyState compact icon={Inbox} title="No incoming patients" description="New arrivals appear here instantly." action={<Button size="sm" variant="secondary">Refresh</Button>} /></Card>
            <Card padding="none"><ErrorState compact message="Couldn't send — we'll retry automatically." onRetry={() => {}} showCall108 /></Card>
          </div>
          <Row label="Toasts">
            <Button variant="secondary" onClick={() => success('Bed confirmed at Apollo Greams Road')}>Success</Button>
            <Button variant="secondary" onClick={() => toast('Ambulance is 2 min away', 'info')}>Info</Button>
            <Button variant="secondary" onClick={() => warning('Capacity data is 40 min old', { title: 'Stale data' })}>Warning</Button>
            <Button variant="secondary" onClick={() => error(new Error("Couldn't reach the server"), { action: { label: 'Retry', onClick: () => {} } })}>Error + action</Button>
          </Row>
        </Section>

        <Section id="Table" title="DataTable">
          <DataTable caption="Fleet" data={TABLE} columns={columns} rowKey={(r) => r.id} searchable searchPlaceholder="Search fleet" pageSize={8}
            initialSort={{ key: 'eta', dir: 'asc' }} toolbar={<Button size="sm" variant="secondary">Export</Button>} />
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <DataTable caption="Loading" data={[]} columns={columns.slice(0, 3)} rowKey={(r) => r.id} loading />
            <DataTable caption="Empty" data={[]} columns={columns.slice(0, 3)} rowKey={(r) => r.id} />
          </div>
        </Section>

        <Section id="Overlays" title="Overlays">
          <Row>
            <Button variant="secondary" onClick={() => setModal(true)}>Modal</Button>
            <Button variant="secondary" onClick={() => setConfirm(true)}>Confirm (danger)</Button>
            <Button variant="secondary" onClick={() => setDrawer(true)}>Drawer</Button>
            <Button variant="secondary" onClick={() => setSheet(true)}>Bottom sheet (modal)</Button>
          </Row>
          <Modal open={modal} onClose={() => setModal(false)} title="Change destination" description="Pick a hospital with capacity."
            footer={<><Button variant="secondary" onClick={() => setModal(false)}>Cancel</Button><Button onClick={() => setModal(false)}>Save</Button></>}>
            <Select label="Hospital" options={HOSPITALS.map((h) => ({ value: h.id, label: h.name }))} />
          </Modal>
          <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} tone="danger" title="Cancel this request?"
            description="The ambulance will be released. If you still need help, call 108." confirmLabel="Cancel request" cancelLabel="Keep request"
            onConfirm={() => new Promise((r) => setTimeout(r, 700))} />
          <Drawer open={drawer} onClose={() => setDrawer(false)} title="Request #1042">
            <div className="space-y-3 p-4"><StatusPill status="en_route" /><SkeletonText lines={4} /></div>
          </Drawer>
          <Sheet open={sheet} onClose={() => setSheet(false)} modal title="What happened?" subtitle="Helps us send the right ambulance" snapPoints={[0.55, 0.9]}
            footer={<Button fullWidth size="lg" onClick={() => setSheet(false)}>Continue</Button>}>
            <div className="grid grid-cols-2 gap-3">
              {INCIDENT_KEYS.map((k) => <Card key={k} padding="sm" interactive><IncidentBadge type={k} /></Card>)}
            </div>
          </Sheet>
        </Section>

        <Section id="Map" title="Map primitives">
          <div className="h-[460px] overflow-hidden rounded-xl border border-line shadow-card">
            <MapCanvas center={[13.05, 80.245]} zoom={13} zoomControls recenterTo={PATIENT}>
              <RiskHeatLayer zones={ZONES} radiusM={1100} />
              <RouteLine positions={ROUTE} phase="to_patient" progressAt={amb} />
              <RouteLine positions={TO_HOSP} phase="to_hospital" dashed />
              <StationMarker position={[13.0405, 80.2337]} name="Kodambakkam station" available={3} total={5} />
              {HOSPITALS.map((h) => <HospitalMarker key={h.id} position={h.pos} name={h.name} beds={h.beds} icu={h.icu} stale={h.stale} selected={h.id === 1} />)}
              <PatientPin position={PATIENT} label="Pickup" />
              <AmbulanceMarker position={amb} route={ROUTE} status="en_route" eta={Math.round((1 - t) * 420)} title="TN 09 AM 4521" selected />
              <AmbulanceMarker position={[13.03, 80.22]} heading={45} status="available" title="TN 07 AM 1203" />
              <AmbulanceMarker position={[13.075, 80.24]} heading={200} status="transporting" title="TN 05 AM 9921" />
              <AmbulanceMarker position={[13.068, 80.21]} status="offline" title="TN 01 AM 0001" />
              <FitBounds points={[...ROUTE, ...TO_HOSP]} once />
            </MapCanvas>
          </div>
        </Section>

        <Section id="Picker" title="Centre-pin location picker">
          <div className="grid gap-4 md:grid-cols-[1fr_280px]">
            <div className="h-[360px] overflow-hidden rounded-xl border border-line shadow-card">
              <MapCanvas center={[13.0418, 80.2341]} zoom={15} centerPin={{ onChange: setCenter, label: 'Ambulance will come here' }} />
            </div>
            <Card>
              <CardHeader title="Pickup location" icon={MapPin} />
              <p className="text-sm tabular-nums text-ink-700">{center ? `${center[0].toFixed(5)}, ${center[1].toFixed(5)}` : '--'}</p>
              <p className="mt-1 text-xs text-ink-500">Drag the map — emits on moveend.</p>
            </Card>
          </div>
        </Section>
      </main>
    </div>
  );
}

function Swatch({ c }: { c: string }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span className={`h-12 w-12 rounded-md border border-line ${c}`} />
      <span className="text-3xs text-ink-500">{c.replace('bg-', '')}</span>
    </div>
  );
}
