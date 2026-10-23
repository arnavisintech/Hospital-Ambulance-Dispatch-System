import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Ambulance, CheckCircle2, List, Map as MapIcon, PhoneCall, Shuffle, Siren, Volume2, VolumeX } from 'lucide-react';
import { useConsolePage } from '../../components/layout';
import {
  Button, Drawer, EmptyState, ErrorState, IconButton, LoadingBlock, SPRING, SegmentedControl, Tabs, tabPanelProps, useToast,
} from '../../components/ui';
import { useReportConnection } from '../../context/ConnectionContext';
import { useAsync } from '../../hooks/useAsync';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useSocket } from '../../hooks/useSocket';
import { get } from '../../lib/api';
import { cn } from '../../lib/cn';
import { CHENNAI } from '../../lib/geo';
import { incidentMeta, severityMeta } from '../../lib/status';
import type { AmbulanceBrief, Board, LatLng, RiskMap, Tracking, WsMessage } from '../../lib/types';
import {
  ROUTED, boardKpis, escalatedRequests, reduceBoard, sortActive, type BoardStation, type LiveBoard,
} from './board';
import { ConsoleMap, DEFAULT_LAYERS, type Layers, type MoveLine } from './ConsoleMap';
import { FleetPanel } from './FleetPanel';
import { IvrModal } from './IvrModal';
import { KpiStrip } from './KpiStrip';
import { isTypingTarget, modalOpen, playChime, useNow, useSoundPref } from './live';
import { LayerToggles, MapLegend } from './MapOverlays';
import { RebalancePanel, type Rec } from './RebalancePanel';
import { RequestCard } from './RequestCard';
import { RequestDetail } from './RequestDetail';

type PanelTab = 'active' | 'escalations' | 'fleet' | 'rebalance';
const TOPICS = ['controller'];
const DETAIL_W = 404;

export default function Controller() {
  useConsolePage({ title: 'Live dispatch', fullBleed: true });
  const split = useMediaQuery('(min-width: 768px)', true);
  const reduce = useReducedMotion();
  const { warning, info } = useToast();
  const now = useNow(1000);

  /* ------------------------------------------------------------------ board state */
  const [live, setLive] = useState<LiveBoard | null>(null);
  const liveRef = useRef<LiveBoard | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const alerted = useRef<Set<number> | null>(null);
  const [soundOn, toggleSound] = useSoundPref('hads.controller.sound');
  const soundRef = useRef(soundOn);
  soundRef.current = soundOn;

  const [tab, setTab] = useState<PanelTab>('active');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [focus, setFocus] = useState<{ at: LatLng; key: string; zoom?: number; exact?: boolean } | null>(null);
  const [layers, setLayers] = useState<Layers>(DEFAULT_LAYERS);
  const [ivrOpen, setIvrOpen] = useState(false);
  const [phoneView, setPhoneView] = useState<'list' | 'map'>('list');
  const [hoverRec, setHoverRec] = useState<number | null>(null);

  const select = useCallback((id: number | null) => {
    setSelectedId(id);
    const r = id !== null ? liveRef.current?.board.requests.find((x) => x.id === id) : null;
    if (r) setFocus({ at: [r.lat, r.lng], key: `r${r.id}-${Date.now()}`, zoom: 14 });
  }, []);

  const alertEscalation = useCallback((id: number) => {
    if (!alerted.current || alerted.current.has(id)) return;
    alerted.current.add(id);
    const r = liveRef.current?.board.requests.find((x) => x.id === id);
    const what = r ? `${incidentMeta(r.incident_type).short}, ${severityMeta(r.severity).label}${r.zone_label ? ` · ${r.zone_label}` : ''}` : 'No unit accepted';
    warning(what, {
      title: `Request #${id} needs manual dispatch`, duration: 8000,
      action: { label: 'Review', onClick: () => { setTab('escalations'); select(id); } },
    });
    if (soundRef.current) playChime(true);
  }, [warning, select]);

  const commit = useCallback((s: LiveBoard) => { liveRef.current = s; setLive(s); }, []);

  const load = useCallback(async () => {
    try {
      const b = await get<Board>('/controller/board');
      const prevRoutes = liveRef.current?.routes ?? {};
      const ids = new Set(b.requests.map((r) => r.id));
      const routes = Object.fromEntries(Object.entries(prevRoutes).filter(([k]) => ids.has(Number(k))));
      commit({ board: b, routes });
      setLoadError(null);
      // Escalations seen by polling (socket down) also alert; the first load only seeds the set.
      const esc = escalatedRequests(b).map((r) => r.id);
      if (alerted.current === null) alerted.current = new Set(esc);
      else esc.forEach(alertEscalation);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load the board');
    }
  }, [commit, alertEscalation]);

  const pending = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastLoad = useRef(0);
  const throttledLoad = useCallback(() => {
    if (pending.current) return;
    const wait = Math.max(0, 1200 - (Date.now() - lastLoad.current));
    pending.current = setTimeout(() => { pending.current = undefined; lastLoad.current = Date.now(); void load(); }, wait);
  }, [load]);
  useEffect(() => () => { if (pending.current) clearTimeout(pending.current); }, []);

  /* ------------------------------------------------------------------ rebalance */
  const recs = useAsync<Rec[]>(async () => {
    const x = await get<Rec[] | { items: Rec[] }>('/rebalance/recommendations', { status: 'pending' });
    return Array.isArray(x) ? x : x.items ?? [];
  }, [], 30000);
  const reloadRecs = recs.reload;

  /* ------------------------------------------------------------------ live socket */
  const onMsg = useCallback((m: WsMessage) => {
    if (m.type === 'rebalance.new') {
      void reloadRecs();
      const n = (m.data as { count?: number } | null)?.count;
      info(`${n ?? 'New'} repositioning suggestion${n === 1 ? '' : 's'} ready`, { title: 'Rebalance', action: { label: 'View', onClick: () => setTab('rebalance') } });
      return;
    }
    const cur = liveRef.current;
    if (!cur) return;
    const res = reduceBoard(cur, m);
    if (res.state !== cur) commit(res.state);
    if (res.reload) throttledLoad();
    if (res.escalated !== undefined) {
      if (res.reload) setTimeout(() => alertEscalation(res.escalated!), 1500); // let the row arrive first
      else alertEscalation(res.escalated);
    }
  }, [commit, throttledLoad, alertEscalation, reloadRecs, info]);
  const { connected } = useSocket(TOPICS, onMsg);
  useReportConnection(connected);

  // Initial load + polling fallback: every 10 s while the socket is down, 30 s while live (age/ETA refresh).
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), connected ? 30000 : 10000);
    return () => clearInterval(t);
  }, [load, connected]);

  /* ------------------------------------------------------------------ routes for units on a leg */
  const routeTried = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!live) return;
    const need = live.board.requests.filter((r) => ROUTED.has(r.status) && r.ambulance && !live.routes[r.id] && !routeTried.current.has(`${r.id}:${r.status}`));
    need.slice(0, 12).forEach((r) => {
      routeTried.current.add(`${r.id}:${r.status}`);
      get<Tracking>(`/requests/${r.id}/tracking`).then((t) => {
        const cur = liveRef.current;
        if (!t.route || !cur || t.route.polyline.length < 2) return;
        commit({ ...cur, routes: { ...cur.routes, [r.id]: t.route } });
      }).catch(() => { /* v1 backend: no routes, markers still glide */ });
    });
  }, [live, commit]);

  /* ------------------------------------------------------------------ risk layer */
  const risk = useAsync<RiskMap | null>(async () => (layers.risk ? get<RiskMap>('/analytics/risk-map') : null), [layers.risk]);

  /* ------------------------------------------------------------------ derived */
  const board = live?.board ?? null;
  const kpis = useMemo(() => (board ? boardKpis(board) : null), [board]);
  const escalated = useMemo(() => (board ? escalatedRequests(board) : []), [board]);
  const escIds = useMemo(() => new Set(escalated.map((r) => r.id)), [escalated]);
  const active = useMemo(() => (board ? sortActive(board.requests, board.escalations) : []), [board]);
  const matching = useMemo(() => active.filter((r) => ['received', 'matching', 'offered'].includes(r.status)).length, [active]);
  const selected = board?.requests.find((r) => r.id === selectedId) ?? null;
  const list = tab === 'escalations' ? escalated : active;

  // Selected request finished → close the panel gracefully.
  useEffect(() => {
    if (selectedId !== null && board && !board.requests.some((r) => r.id === selectedId)) setSelectedId(null);
  }, [board, selectedId]);

  const moves = useMemo<MoveLine[]>(() => {
    if (tab !== 'rebalance' || !board || !recs.data) return [];
    const st = new Map((board.stations as BoardStation[]).map((s) => [s.id, s]));
    return recs.data
      .filter((r) => hoverRec === null || r.id === hoverRec)
      .map((r) => {
        const a = st.get(r.from_station_id ?? -1), b = st.get(r.to_station_id ?? -1);
        return a && b ? { id: r.id, from: [a.lat, a.lng] as LatLng, to: [b.lat, b.lng] as LatLng } : null;
      })
      .filter((m): m is MoveLine => !!m);
  }, [tab, board, recs.data, hoverRec]);


  const locate = useCallback((a: AmbulanceBrief) => {
    if (a.lat == null || a.lng == null) return;
    if (!split) setPhoneView('map');
    setFocus({ at: [a.lat, a.lng], key: `a${a.id}-${Date.now()}`, zoom: 15 });
  }, [split]);

  /* ------------------------------------------------------------------ keyboard: Esc, J/K, N */
  const listRef = useRef(list);
  listRef.current = list;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || modalOpen() || isTypingTarget(e.target)) return;
      const k = e.key.toLowerCase();
      if (e.key === 'Escape' && selectedId !== null) { e.preventDefault(); setSelectedId(null); return; }
      if (k === 'j' || k === 'k') {
        const l = listRef.current;
        if (!l.length) return;
        e.preventDefault();
        const i = l.findIndex((r) => r.id === selectedId);
        const next = i < 0 ? 0 : (i + (k === 'j' ? 1 : -1) + l.length) % l.length;
        select(l[next].id);
        document.getElementById(`req-card-${l[next].id}`)?.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
      } else if (k === 'n') { e.preventDefault(); setIvrOpen(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, select, reduce]);

  /* ------------------------------------------------------------------ render */
  if (!live && loadError) {
    return <div className="flex h-full items-center justify-center p-6"><ErrorState title="Couldn't load the live board" message={`${loadError}. We'll keep retrying every 10 seconds.`} onRetry={() => void load()} /></div>;
  }
  if (!live || !board) return <LoadingBlock full label="Loading live board" />;

  const actions = (
    <>
      <IconButton label={soundOn ? 'Mute escalation alerts' : 'Unmute escalation alerts'} icon={soundOn ? Volume2 : VolumeX} variant="secondary" size={split ? 'md' : 'sm'} onClick={toggleSound} aria-pressed={soundOn} />
      <Button icon={PhoneCall} size={split ? 'md' : 'sm'} onClick={() => setIvrOpen(true)} title="New phone request (N)">{split ? 'New IVR call' : 'IVR'}</Button>
    </>
  );

  const tabs = [
    { value: 'active' as const, label: 'Active', badge: board.requests.length },
    {
      value: 'escalations' as const,
      label: (
        <span className="inline-flex items-center gap-2">
          Escalations
          {escalated.length > 0 && <span className="min-w-[20px] animate-fade-in rounded-full bg-brand-500 px-1.5 text-xs leading-5 text-white tabular-nums">{escalated.length}</span>}
        </span>
      ),
    },
    { value: 'fleet' as const, label: <span className="inline-flex items-center gap-1.5"><Ambulance size={16} aria-hidden className="xl:hidden" /><span className="sr-only xl:not-sr-only">Fleet</span></span> },
    { value: 'rebalance' as const, label: <span className="inline-flex items-center gap-1.5"><Shuffle size={16} aria-hidden className="xl:hidden" /><span className="sr-only xl:not-sr-only">Rebalance</span></span> },
  ];

  const requestList = (items: typeof list, empty: ReactNode) => (
    items.length === 0 ? empty : (
      <ul className="space-y-2" aria-live="polite">
        <AnimatePresence initial={false}>
          {items.map((r) => (
            <motion.li
              key={r.id} id={`req-card-${r.id}`} layout={!reduce ? 'position' : false}
              initial={{ opacity: 0, y: reduce ? 0 : 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.12 } }}
              transition={{ duration: 0.2 }}
            >
              <RequestCard r={r} now={now} selected={r.id === selectedId} escalated={escIds.has(r.id)} onSelect={select} />
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    )
  );

  const panelBody = (
    <>
      {tab === 'active' && (
        <div className="min-h-0 flex-1 overflow-y-auto p-3 scrollbar-thin">
          {requestList(active, <EmptyState compact icon={Siren} title="No active requests" description="New SOS and IVR requests appear here instantly." action={<Button size="sm" variant="secondary" icon={PhoneCall} onClick={() => setIvrOpen(true)}>Log a phone call</Button>} />)}
        </div>
      )}
      {tab === 'escalations' && (
        <div className="min-h-0 flex-1 overflow-y-auto p-3 scrollbar-thin">
          {requestList(escalated, <EmptyState compact icon={CheckCircle2} title="All clear" description="No request is waiting for manual dispatch." />)}
        </div>
      )}
      {tab === 'fleet' && <div className="min-h-0 flex-1"><FleetPanel board={board} onLocate={locate} /></div>}
      {tab === 'rebalance' && <div className="min-h-0 flex-1"><RebalancePanel recs={recs} onHover={setHoverRec} onChanged={() => void load()} /></div>}
    </>
  );

  const detail = selected && (
    <RequestDetail
      key={selected.id} req={selected} board={board} escalated={escIds.has(selected.id)} now={now}
      onClose={() => setSelectedId(null)} onChanged={() => void load()} hideClose={!split}
    />
  );

  const map = (
    <div className="relative h-full w-full">
      <ConsoleMap
        live={live} selectedId={selectedId} onSelect={(id) => { select(id); if (tab === 'fleet' || tab === 'rebalance') setTab('active'); }}
        layers={layers} riskZones={risk.data?.zones} moves={moves} focus={focus}
        controlsInset={{ right: split && selected ? DETAIL_W + 12 : 0, bottom: 0 }}
        onRecenter={() => setFocus({ at: CHENNAI, key: `home-${Date.now()}`, zoom: 12, exact: true })}
      />
      <div className="pointer-events-none absolute right-3 top-3 z-[1000] flex flex-col items-end gap-2" style={{ right: split && selected ? DETAIL_W + 24 : 12 }}>
        <LayerToggles compact={!split || !!selected} layers={layers} onChange={setLayers} riskLoading={risk.loading && layers.risk} riskError={risk.error} />
      </div>
      {split && (
        <div className="pointer-events-none absolute bottom-6 left-3 z-[1000]">
          <MapLegend showRisk={layers.risk} />
        </div>
      )}
      {split && (
        <AnimatePresence>
          {selected && (
            <motion.aside
              key="detail"
              aria-label={`Request ${selected.id} details`}
              className="absolute bottom-3 right-3 top-3 z-[1001] overflow-hidden rounded-xl border border-line/70 bg-surface shadow-raised"
              style={{ width: `min(${DETAIL_W}px, calc(100% - 24px))` }}
              initial={reduce ? { opacity: 0 } : { opacity: 0, x: 32 }}
              animate={reduce ? { opacity: 1 } : { opacity: 1, x: 0, transition: SPRING }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, x: 32, transition: { duration: 0.14 } }}
            >
              {detail}
            </motion.aside>
          )}
        </AnimatePresence>
      )}
    </div>
  );

  const ivr = (
    <IvrModal
      open={ivrOpen} onClose={() => setIvrOpen(false)} center={selected ? [selected.lat, selected.lng] : undefined}
      onCreated={(r) => { void load().then(() => { setTab('active'); select(r.id); }); }}
    />
  );

  /* ---------------- phones: simplified list + map toggle ---------------- */
  if (!split) {
    return (
      <div className="flex h-full flex-col">
        <KpiStrip compact kpis={kpis} matching={matching} onEscalations={() => { setTab('escalations'); setPhoneView('list'); }} />
        <div className="flex items-center gap-2 border-b border-line bg-surface px-3 py-2">
          <SegmentedControl ariaLabel="View" size="sm" value={phoneView} onChange={setPhoneView} items={[{ value: 'list', label: 'List', icon: List }, { value: 'map', label: 'Map', icon: MapIcon }]} />
          <div className="ml-auto flex items-center gap-1.5">{actions}</div>
        </div>
        <div className="relative flex min-h-0 flex-1 flex-col bg-canvas">
          {phoneView === 'map' ? map : (
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <SegmentedControl
                ariaLabel="Requests" size="sm" fullWidth className="mb-3" value={tab === 'escalations' ? 'escalations' : 'active'}
                onChange={(v) => setTab(v)}
                items={[{ value: 'active', label: 'Active', badge: board.requests.length }, { value: 'escalations', label: 'Urgent', badge: escalated.length }]}
              />
              {tab === 'escalations'
                ? requestList(escalated, <EmptyState compact icon={CheckCircle2} title="All clear" description="No request is waiting for manual dispatch." />)
                : requestList(active, <EmptyState compact icon={Siren} title="No active requests" description="New SOS and IVR requests appear here instantly." />)}
            </div>
          )}
        </div>
        <Drawer open={!!selected} onClose={() => setSelectedId(null)} side="right" width="100vw" title={selected ? `Request #${selected.id}` : ''}>
          {detail}
        </Drawer>
        {ivr}
      </div>
    );
  }

  /* ---------------- tablet / desktop ---------------- */
  return (
    <div className="flex h-full flex-col">
      <KpiStrip kpis={kpis} matching={matching} onEscalations={() => setTab('escalations')} actions={actions} />
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[340px] shrink-0 flex-col border-r border-line bg-surface lg:w-[360px] xl:w-[400px]" aria-label="Dispatch queue">
          <div className="px-2">
            <Tabs id="console" items={tabs} value={tab} onChange={setTab} fullWidth ariaLabel="Dispatch panel" />
          </div>
          <div {...tabPanelProps('console', tab)} tabIndex={-1} className={cn('flex min-h-0 flex-1 flex-col bg-canvas/60 focus-visible:outline-none')}>
            {panelBody}
          </div>
          <p className="hidden border-t border-line px-3 py-2 text-xs text-ink-500 lg:block">
            <Kbd>J</Kbd> <Kbd>K</Kbd> move · <Kbd>Esc</Kbd> close · <Kbd>N</Kbd> new IVR call
          </p>
        </aside>
        <div className="relative min-w-0 flex-1">{map}</div>
      </div>
      {ivr}
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-[20px] items-center justify-center rounded border border-line-strong bg-surface px-1 font-sans text-[11px] font-semibold text-ink-700">{children}</kbd>;
}
