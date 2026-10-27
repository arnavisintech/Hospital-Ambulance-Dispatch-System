# HADS v2 UI foundation — component guide

Design tokens: `src/index.css` and `tailwind.config.js`. Live review page: **`/dev/ui`** (no login needed; every component and
map primitive in all states). Everything is light-only, typed, and keyboard/screen-reader accessible.

```ts
import { Button, Card, StatusPill, Sheet, useToast /* … */ } from '../components/ui';
import { MapCanvas, AmbulanceMarker, RouteLine /* … */ } from '../components/map';
import { MobileAppLayout, ConsoleLayout, useConsolePage } from '../components/layout';
```

## Rules for screen agents

- **No hex in components.** Use Tailwind tokens (`brand-500`, `ink-700`, `line`, `canvas`, `surface`, `success|info|warning|violet|orange|teal` with `-bg` (tint) and `-fg` (AA text) variants, `danger` = brand). Raw SVG/divIcon HTML: `rgb(var(--brand-500))`. SVG attributes, canvas, Recharts: `token('brand-500')` / `chartPalette()` from `lib/tokens.ts`.
- **Status is colour + icon + label**, always from `lib/status.ts` (`requestStatusMeta`, `ambulanceStatusMeta`, `severityMeta`, `incidentMeta`, `progressIndex`). Severity is shown as words, never bare numbers to the public.
- **Formatting** from `lib/format.ts`: `fmtEta(240) → "4 min"`, `fmtArrival(240) → "Arriving in 4 min"`, `fmtRelative`, `fmtClock`, `fmtDuration`, `fmtClockTimer`, `fmtMoney → "₹1,25,000"`, `fmtDistance(km)`, `fmtMeters`, `fmtPhone`, `initials`. Put `tabular-nums` on changing numbers.
- Icons: `lucide-react` only, sizes 16/20/24. No emoji. Combine classes with `cn()` from `lib/cn.ts` (clsx + tailwind-merge).
- Motion: framer-motion; springs via `SPRING` (stiffness 420, damping 36). Respect `useReducedMotion()`.
- Requester emergency screens must show a "Call 108" fallback: `<Call108Button />`.
- z-index tokens: `z-sticky` 30 · `z-sheet` 40 · `z-modal` 50 · `z-toast` 60. Maps isolate their own stacking (Leaflet 400–1000 stays inside).
- Utilities: `min-h-dvh`, `h-dvh`, `pt-safe`/`pb-safe`/`pb-safe-3`, `tabular-nums`, `press` (active scale .98), `scrollbar-thin`.

## Routing & layouts (`src/App.tsx`)

| Roles | Layout | How |
|---|---|---|
| requester, crew (`/sos`, `/track/:id`, `/history`, `/crew`) | `MobileAppLayout` | **Each page renders its own** `<MobileAppLayout>`. Legacy pages are wrapped by `MobileRoute legacyTitle="…"` in App.tsx — when you rebuild a page, render `<MobileAppLayout>` inside it and **remove `legacyTitle`** from its route. |
| controller, admin, authority, hospital_staff | `ConsoleLayout` (route element, `<Outlet/>`) | Pages render content only. Add nav entries in `components/layout/nav.ts` (`CONSOLE_NAV`). |
| public | none | `/`, `/login`, `/register`, `/dev/ui`, `*` |

Not yet routed (v2): `/t/:token` public family-share page — add it as a public route.

### MobileAppLayout
```tsx
<MobileAppLayout title="Live tracking" back /* true | '/path' | fn */ actions={<IconButton …/>}
  map={<MapCanvas>…</MapCanvas>}                       // map-first screen (optional)
  sheet={{ snapPoints: [0.38, 0.88], initialSnap: 0, header: <EtaHero/> }}
  bottomBar={<SlideButton label="Slide to confirm" onConfirm={…}/>}
  width="md" /* md | lg | 2xl for non-map screens */>
  {panelContent}
</MobileAppLayout>
```
Phones with `map`: full-screen map, floating back/title/avatar, children in a draggable bottom Sheet, `bottomBar` pinned (safe-area). ≥1024px: app bar + map left / 420px panel right. Without `map`: sticky app bar, centred content, sticky CTA bar. It provides `MapInsetsContext` so `MapCanvas` controls and `FitBounds` automatically avoid the sheet. Requesters automatically get the offline-SOS `QueueBanner`. Avatar menu (`UserMenu`) has role links + sign out.

### ConsoleLayout
Collapsible sidebar (rail state persisted), top bar with page title + `ConnectionIndicator` + `UserMenu`; phones get a top bar + slide-over `Drawer`. Content is `max-w-7xl` padded; for full-bleed maps call
`useConsolePage({ title: 'Live board', fullBleed: true })` (title otherwise comes from the nav label). Report socket state with `useReportConnection(connected)` (ConnectionContext) so the indicator is live.

## UI kit (`src/components/ui`)

| Component | Key props | Snippet |
|---|---|---|
| **Button** | `variant` primary·secondary·outline·ghost·danger·success·dark, `size` sm(36)·md(44)·lg·xl, `icon`, `iconRight`, `loading`, `fullWidth` | `<Button icon={Siren} size="xl" loading={busy}>Send SOS</Button>` |
| **ButtonLink** / `buttonClasses()` | Button styling for router links / anything | `<ButtonLink to="/login" variant="secondary">Sign in</ButtonLink>` |
| **IconButton** | `label` (required aria-label), `icon`, `variant` ghost·secondary·primary·floating·danger·dark, `size`, `badge` | `<IconButton label="Back" icon={ArrowLeft} />` |
| **Card**, CardHeader, Divider | `padding` none·sm·md·lg, `elevation` flat·card·raised, `interactive`, `as`; header: `title subtitle icon action` | `<Card><CardHeader title="Apollo" icon={BedDouble} action={…}/>…</Card>` |
| **StatusPill** | `status`, `kind` request·ambulance·generic, `headline` (consumer copy), `size`, `variant` | `<StatusPill status={r.status} headline />` |
| **SeverityBadge**, IncidentBadge, Badge | severity number → word; `type` → label+icon; generic `tone dot pulse icon` | `<SeverityBadge severity={4} showLevel />` |
| **Avatar** | `name` or `initials`, `size` xs–xl, `status` | `<Avatar name={crew.name} initials={crew.initials} />` |
| **Sheet** | `open`(default true) `onClose` `title subtitle header footer` `snapPoints`[fractions] `initialSnap`/`snap`+`onSnapChange` `modal` `desktop` panel·dialog | `<Sheet modal onClose={close} title="What happened?" footer={<Button fullWidth>Continue</Button>}>…</Sheet>` |
| **Modal** | `open onClose title description footer size dismissible hideClose`; focus trap, Esc, scrim, restore focus; `data-autofocus` on initial field | `<Modal open={o} onClose={…} title="Change destination" footer={…}>…</Modal>` |
| **ConfirmDialog** | `onConfirm` (may return promise → spinner, stays open on throw), `tone` danger·primary, `confirmLabel cancelLabel` | `<ConfirmDialog tone="danger" title="Cancel request?" onConfirm={cancel} …/>` |
| **Drawer** | `open onClose title side` left·right `width hideHeader ariaLabel footer` | `<Drawer open side="right" title="Request #12">…</Drawer>` |
| **Tabs** / `tabPanelProps(id, v)` | `items[{value,label,icon,badge}] value onChange id variant` underline·pill | `<Tabs id="h" items={…} value={t} onChange={setT}/><div {...tabPanelProps('h', t)}>…</div>` |
| **SegmentedControl** | same items, `ariaLabel` required, `size`, `fullWidth` | `<SegmentedControl ariaLabel="View" items={…} value={v} onChange={setV}/>` |
| **Switch** | `checked onChange label description size tone` | `<Switch checked={onDuty} onChange={setDuty} label="On duty" size="lg" />` |
| **Stepper** | `value onChange min max step label helper size` (spinbutton keys) | `<Stepper label="Available beds" value={b} onChange={setB} max={200} />` |
| **SlideButton** | `label onConfirm`(promise ok) `tone icon confirmedLabel disabled threshold`; tap does nothing, slide or Enter/Space confirms | `<SlideButton label="Slide to start trip" tone="info" onConfirm={start} />` |
| **Input / Select / Textarea / Field** | `label helper error hideLabel labelAside`; Input `icon trailing size`; Select `options placeholder`; Textarea `showCount` | `<Input label="Phone" icon={Phone} error={err} />` |
| **Skeleton**, SkeletonText, SkeletonCard | sizes via className | `<SkeletonCard />` |
| **EmptyState**, **ErrorState**, Call108Button | `icon title description action compact`; error: `message onRetry retrying showCall108` | `<ErrorState message="Couldn't send — we'll retry." onRetry={reload} showCall108 />` |
| **Toast** (`useToast`) | `toast(text, kind \| opts)`, `success/info/warning/error(e, {title, action, duration})`; polite live region, 4 s (errors 6 s) | `const { success, error } = useToast(); success('Bed confirmed');` |
| **StatCard**, Sparkline | `label value icon tone delta{value,unit,goodWhen,label} sparkline[] hint loading` | `<StatCard label="Avg response" value="7m 40s" delta={{value:-12,unit:'%',goodWhen:'down'}} />` |
| **DataTable** | `data columns[{key header accessor cell sortable align hideBelow}] rowKey caption searchable pageSize initialSort loading empty onRowClick isRowActive toolbar maxHeight`; pure `sortRows`/`filterRows` exported | `<DataTable caption="Users" data={u} columns={cols} rowKey={(r)=>r.id} searchable />` |
| **Timeline** / `requestTimelineItems(events, status, {consumer})` | items `{title description time(iso) icon tone state done·current·upcoming}` | `<Timeline items={requestTimelineItems(t.timeline, r.status, { consumer: true })} />` |
| **ProgressSteps** | `status` or `current` (-1..4), `labels` | `<ProgressSteps status={r.status} />` |
| **CountdownRing** | `total` + `remaining` or `endsAt`, `onExpire size stroke tone caption` (auto amber/red) | `<CountdownRing total={30} endsAt={offer.offer_expires_at} onExpire={…} />` |
| **PulseRadar** | `size icon label sublabel` | `<PulseRadar label="Finding the nearest ambulance…" />` |
| **Menu** | `trigger(props)` render-prop, `items[{label icon onSelect danger}]`, `header`, `align` | see `UserMenu` |
| **PageHeader**, SectionTitle | `title subtitle actions` | `<PageHeader title="Users" actions={<Button>Add</Button>} />` |
| Spinner, LoadingBlock | inline / centred loading | `<LoadingBlock label="Loading board" />` |

Legacy helpers (`components/States`, `Chips`, `StatusTimeline`, `MapView`, `LocationPicker`, `RiskLayer`) still work and are re-skinned; prefer the kit for new code. `context/ToastContext` re-exports the new toast.

## Map (`src/components/map`)

```tsx
<MapCanvas center={CHENNAI} zoom={13} recenterTo={patient} /* or onRecenter */ zoomControls="auto">
  <RiskHeatLayer zones={risk.zones} radiusM={900} renderTooltip={(z) => z.zone_label} />
  <RouteLine positions={t.route.polyline} phase={t.route.phase} progressAt={ambPos} />
  <HospitalMarker position={[h.lat, h.lng]} name={h.name} beds={h.available_beds} stale={h.stale} selected />
  <StationMarker position={…} name="Adyar" available={2} total={4} />
  <PatientPin position={[r.lat, r.lng]} label="Pickup" />
  <AmbulanceMarker position={[a.lat, a.lng]} heading={a.heading_deg} status={a.status}
    eta={t.eta_seconds} route={t.route?.polyline} title={a.registration_number} />
  <FitBounds points={[ambPos, patient, hospital]} once />
</MapCanvas>
```

- **MapCanvas**: `center zoom min/maxZoom className zoomControls`('auto' = desktop only; phones pinch) `recenterTo`/`onRecenter` `controlsInset` `centerPin={{ onChange, label }}` `interactive scrollWheelZoom onMapReady ariaLabel`. The parent must give it a height.
- **Tiles**: DESIGN_SYSTEM specifies CARTO Voyager, but CARTO now serves an "API KEY REQUIRED" tile without a key. `lib/mapTiles.ts` picks `VITE_MAP_TILE_URL` → CARTO Voyager if `VITE_CARTO_API_KEY` is set → otherwise **Stadia Alidade Smooth** (same light look; keyless on localhost, production domains need free registration or `VITE_STADIA_API_KEY`), with automatic fallback to OSM tiles if tiles keep failing.
- **Centre-pin picking** (Swiggy-style address selection): `centerPin={{ onChange: setLatLng, label: 'Ambulance will come here' }}` — the map moves under a fixed pin; `onChange` fires on mount and every moveend. Pair with `GET /geo/reverse`.
- **AmbulanceMarker** glides between pings (along `route` when the pings lie on it), shows a heading nose, status dot (ambulance status) and an ETA chip (`eta` seconds or string). `glide={false}` for static lists; `onClick`, `selected`, Tooltip/Popup children.
- **useGlide(target, { route, durationMs, maxJumpM, enabled })** → `{ position, heading }`: rAF interpolation over the measured ping interval; jumps on reduced motion or > 3 km jumps. Pure math in `lib/geo.ts` (`planGlide`, `pointAlong`, `projectOnPolyline`, `splitRoute`, `bearingDeg`).
- **RouteLine**: 6px white casing + 4px line; brand red `to_patient`, info blue `to_hospital`; part before `progressAt` greyed; `dashed` for previews.
- **FitBounds**: `points insets padding maxZoom once refitKey` (insets default to the layout's sheet/app-bar insets).
- Passthroughs: `Tooltip`, `Popup`, `useMap`, `useMapEvents`.

## Types (`src/lib/types.ts`)

v2 contract types added: `Tracking` (+ `route`, `crew`, `timeline`, `share`, `bill`, `feedback`, `ambulance.heading_deg/kind`, `hospital.reserved/address/beds`), `TrackingRoute`, `TimelineEvent`, `PublicTracking`, `FeedbackBody`, `RouteStep.maneuver/name/duration_s`, `RouteOut.bearing_deg`, `CrewMe.stats_today/crew`, offer fields on `RequestOut` (`offered_at`, `offer_expires_at`, `distance_km`, `zone_label`, `timeline`), `IncomingItem`, board ambulance `heading_deg/crew_name/request_id`, `ReversePlace`, `PlaceResult`, `Dashboard.kpis.avg_rating`. All v2 fields are optional so the app works against v1 and v2 backends.

## Tests

`npm test` covers `status.ts`, `format.ts`, glide math (`useGlide`/`lib/geo`), SlideButton keyboard path and DataTable sorting/search/pagination (`src/test/*`).
