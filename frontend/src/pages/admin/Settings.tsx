import { useMemo, useState, type FormEvent } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { BrainCircuit, Calculator, IndianRupee, RotateCcw, Save, Timer } from 'lucide-react';
import { Button, Card, ErrorState, Input, PageHeader, Skeleton, useToast } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { get, put } from '../../lib/api';
import { cn } from '../../lib/cn';
import { fmtMoney } from '../../lib/format';
import { changedSettings, settingDef, SETTING_DEFS, SETTING_GROUPS, validateSetting, type SettingGroup } from './shared/logic';
import { DemographicsCard } from './shared/DemographicsCard';
import { useUnsavedGuard } from './shared/useUnsavedGuard';

type SettingsMap = Record<string, unknown>;
const GROUP_ICON = { fares: IndianRupee, dispatch: Timer, model: BrainCircuit } as const;

function toDraft(s: SettingsMap): Record<string, string> {
  return Object.fromEntries(Object.entries(s).filter(([, v]) => typeof v === 'number').map(([k, v]) => [k, String(v)]));
}

function FarePreview({ draft }: { draft: Record<string, string> }) {
  const n = (k: string) => Number(draft[k]) || 0;
  const km = 8;
  const bls = n('base_fare') + n('per_km_rate') * km;
  const als = bls + n('als_surcharge');
  const share = Math.min(100, Math.max(0, n('revenue_share_pct')));
  return (
    <div className="rounded-md border border-line bg-canvas p-4 text-sm" aria-live="polite">
      <p className="mb-2 flex items-center gap-2 font-semibold text-ink-900"><Calculator size={16} aria-hidden /> Example: {km} km trip</p>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5">
        <dt className="text-ink-500">Basic (BLS)</dt><dd className="text-right font-semibold tabular-nums text-ink-900">{fmtMoney(bls)}</dd>
        <dt className="text-ink-500">Advanced (ALS)</dt><dd className="text-right font-semibold tabular-nums text-ink-900">{fmtMoney(als)}</dd>
        <dt className="text-ink-500">Hospital receives</dt><dd className="text-right tabular-nums text-ink-900">{fmtMoney((bls * share) / 100)} <span className="text-ink-500">({share}%)</span></dd>
        <dt className="text-ink-500">Platform keeps</dt><dd className="text-right tabular-nums text-ink-900">{fmtMoney((bls * (100 - share)) / 100)}</dd>
      </dl>
    </div>
  );
}

export default function Settings() {
  const { success, error } = useToast();
  const reduce = useReducedMotion();
  const state = useAsync(async () => {
    const x = await get<SettingsMap | { key: string; value: unknown }[]>('/admin/settings');
    return Array.isArray(x) ? Object.fromEntries(x.map((r) => [r.key, r.value])) : x;
  }, []);
  const [saved, setSaved] = useState<SettingsMap | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);

  // Adopt server values when they first arrive (or after a reload) — but never clobber edits in progress.
  const [adopted, setAdopted] = useState<SettingsMap | null>(null);
  if (state.data && state.data !== adopted) {
    setAdopted(state.data);
    if (!saved || changedSettings(saved, draft).length === 0) { setSaved(state.data); setDraft(toDraft(state.data)); }
  }

  const changed = useMemo(() => (saved ? changedSettings(saved, draft) : []), [saved, draft]);
  const errors = useMemo(() => Object.fromEntries(Object.keys(draft).map((k) => [k, validateSetting(settingDef(k), draft[k])]).filter(([, e]) => e)), [draft]) as Record<string, string>;
  const dirty = changed.length > 0;
  const guard = useUnsavedGuard(dirty, 'You have unsaved platform settings. Leave without saving?');


  const known = new Set(SETTING_DEFS.map((d) => d.key));
  const extra = Object.keys(draft).filter((k) => !known.has(k));
  const groups = SETTING_GROUPS.map((g) => ({
    ...g, keys: [...SETTING_DEFS.filter((d) => d.group === g.key && d.key in draft).map((d) => d.key), ...(g.key === 'model' ? extra : [])],
  })).filter((g) => g.keys.length);

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    setShowErrors(true);
    if (!dirty) return;
    if (changed.some((k) => errors[k])) {
      document.getElementById(`set-${changed.find((k) => errors[k])}`)?.focus();
      return;
    }
    setBusy(true);
    try {
      const body = Object.fromEntries(changed.map((k) => [k, settingDef(k).integer ? Math.round(Number(draft[k])) : Number(draft[k])]));
      const out = await put<SettingsMap>('/admin/settings', body);
      const next = out && typeof out === 'object' && !Array.isArray(out) ? out : { ...saved, ...body };
      setSaved(next); setDraft(toDraft(next)); setShowErrors(false);
      success(`${changed.length} setting${changed.length > 1 ? 's' : ''} updated. New trips use them immediately.`, { title: 'Settings saved' });
    } catch (e2) { error(e2, { title: "Couldn't save settings" }); } finally { setBusy(false); }
  };
  const discard = () => { if (saved) { setDraft(toDraft(saved)); setShowErrors(false); } };

  return (
    <div className="mx-auto max-w-4xl pb-24">
      <PageHeader title="Platform settings" subtitle="Fares, revenue share, dispatch timing and model refresh. Every change is audited." />
      {state.error && !state.data ? (
        <Card padding="none"><ErrorState message={`${state.error}.`} onRetry={() => void state.reload()} /></Card>
      ) : !saved ? (
        <div className="space-y-6" role="status" aria-label="Loading settings">
          {[0, 1, 2].map((i) => <Card key={i} padding="lg"><Skeleton className="mb-4 h-5 w-48" /><div className="grid gap-4 sm:grid-cols-2"><Skeleton className="h-12" /><Skeleton className="h-12" /></div></Card>)}
        </div>
      ) : (
        <form onSubmit={(e) => void save(e)} noValidate className="space-y-6">
          {groups.map((g) => {
            const Icon = GROUP_ICON[g.key as SettingGroup];
            return (
              <Card as="section" padding="lg" key={g.key} aria-labelledby={`grp-${g.key}`}>
                <div className="mb-5 flex items-start gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-canvas text-ink-700" aria-hidden><Icon size={20} /></span>
                  <div>
                    <h2 id={`grp-${g.key}`} className="text-lg font-bold text-ink-900">{g.title}</h2>
                    <p className="text-sm text-ink-500">{g.description}</p>
                  </div>
                </div>
                <div className="grid gap-5 sm:grid-cols-2">
                  {g.keys.map((k) => {
                    const d = settingDef(k);
                    const isChanged = changed.includes(k);
                    const range = Number.isFinite(d.min) ? `${d.min}–${d.max}${d.unit ? ` ${d.unit.replace('/', 'per ')}` : ''}` : '';
                    return (
                      <Input key={k} id={`set-${k}`} label={<>{d.label}{isChanged && <span className="ml-2 rounded-full bg-info-bg px-1.5 py-0.5 text-xs font-semibold text-info-fg">Edited</span>}</>}
                        inputMode={d.integer ? 'numeric' : 'decimal'} value={draft[k] ?? ''}
                        onChange={(e) => setDraft((x) => ({ ...x, [k]: e.target.value }))}
                        icon={d.prefix === '₹' ? IndianRupee : undefined}
                        trailing={d.unit ? <span className="pr-2 text-sm font-medium text-ink-500">{d.unit}</span> : undefined}
                        error={((showErrors && dirty) || isChanged) ? errors[k] : undefined}
                        helper={`${d.help}${range ? ` Allowed ${range}.` : ''}${isChanged ? ` Was ${String(saved[k])}.` : ''}`}
                        className="tabular-nums" />
                    );
                  })}
                </div>
                {g.key === 'fares' && <div className="mt-5"><FarePreview draft={draft} /></div>}
              </Card>
            );
          })}
          <AnimatePresence>
            {dirty && (
              <motion.div
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} exit={reduce ? { opacity: 0 } : { opacity: 0, y: 16 }}
                transition={{ type: 'spring', stiffness: 420, damping: 36 }}
                className="sticky bottom-4 z-sticky mx-auto flex max-w-2xl flex-wrap items-center gap-3 rounded-lg border border-line bg-surface p-3 pl-4 shadow-raised"
                role="region" aria-label="Unsaved changes">
                <p className={cn('min-w-0 flex-1 text-sm font-semibold', Object.keys(errors).some((k) => changed.includes(k)) ? 'text-danger-fg' : 'text-ink-900')}>
                  {changed.length} unsaved change{changed.length > 1 ? 's' : ''}
                  {changed.some((k) => errors[k]) && <span className="font-medium"> · fix highlighted fields</span>}
                </p>
                <Button variant="ghost" icon={RotateCcw} onClick={discard} disabled={busy}>Discard</Button>
                <Button type="submit" icon={Save} loading={busy}>Save changes</Button>
              </motion.div>
            )}
          </AnimatePresence>
        </form>
      )}
      <div className="mt-6"><DemographicsCard /></div>
      {guard}
    </div>
  );
}
