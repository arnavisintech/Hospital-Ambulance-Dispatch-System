import type { ReactNode } from 'react';
import { AlertTriangle, Ambulance, Gauge, Siren, type LucideIcon } from 'lucide-react';
import { Skeleton } from '../../components/ui';
import { cn } from '../../lib/cn';
import { toneClasses, type Tone } from '../../lib/status';
import type { Kpis } from './board';

interface KpiProps { label: string; value: ReactNode; sub?: ReactNode; icon: LucideIcon; tone: Tone; emphasis?: boolean; onClick?: () => void; loading?: boolean }

function Kpi({ label, value, sub, icon: Icon, tone, emphasis, onClick, loading }: KpiProps) {
  const t = toneClasses(tone);
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      {...(onClick ? { type: 'button' as const, onClick } : {})}
      className={cn(
        'flex min-w-0 items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors',
        onClick && 'press hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
        emphasis && 'bg-brand-50 ring-1 ring-inset ring-brand-200 hover:bg-brand-100',
      )}
    >
      <span className={cn('hidden h-10 w-10 shrink-0 items-center justify-center rounded-md xl:flex', emphasis ? 'bg-brand-500 text-white' : t.soft)} aria-hidden>
        <Icon size={20} />
      </span>
      <span className="min-w-0">
        <span className={cn('block truncate text-xs font-semibold', emphasis ? 'text-brand-700' : 'text-ink-500')}>{label}</span>
        {loading ? <Skeleton className="mt-1 h-6 w-14" /> : (
          <span className="flex items-baseline gap-1.5">
            <span className={cn('text-2xl font-extrabold leading-tight tracking-tight tabular-nums', emphasis ? 'text-brand-700' : 'text-ink-900')}>{value}</span>
            {sub && <span className="hidden truncate text-xs font-medium text-ink-500 xl:inline">{sub}</span>}
          </span>
        )}
      </span>
    </Tag>
  );
}

export function KpiStrip({ kpis, matching, loading, onEscalations, actions, compact }: {
  kpis: Kpis | null; matching?: number; loading?: boolean; onEscalations?: () => void; actions?: ReactNode; compact?: boolean;
}) {
  const k = kpis;
  if (compact) {
    const tiles: { label: string; value: ReactNode; danger?: boolean; onClick?: () => void }[] = [
      { label: 'Active', value: k?.active ?? '--' },
      { label: 'Free units', value: k ? `${k.available}/${k.fleet}` : '--' },
      { label: 'Match ms', value: k?.avgMatchMs ?? '--' },
      { label: 'Escalated', value: k?.escalations ?? '--', danger: !!k?.escalations, onClick: onEscalations },
    ];
    return (
      <div className="grid shrink-0 grid-cols-4 gap-1.5 border-b border-line bg-surface px-3 py-2" role="region" aria-label="Live KPIs">
        {tiles.map((t) => {
          const Tag = t.onClick ? 'button' : 'div';
          return (
            <Tag key={t.label} {...(t.onClick ? { type: 'button' as const, onClick: t.onClick } : {})}
              className={cn('min-w-0 rounded-md px-2 py-1.5 text-left', t.danger ? 'bg-brand-500 text-white' : 'bg-canvas text-ink-900',
                t.onClick && 'press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500')}>
              {loading ? <Skeleton className="h-6 w-8" /> : <span className="block text-lg font-extrabold leading-6 tabular-nums">{t.value}</span>}
              <span className={cn('block truncate text-[11px] font-semibold', t.danger ? 'text-white/90' : 'text-ink-500')}>{t.label}</span>
            </Tag>
          );
        })}
      </div>
    );
  }
  return (
    <div className={cn('flex shrink-0 items-center gap-2 border-b border-line bg-surface', compact ? 'overflow-x-auto px-2 py-1.5 scrollbar-none' : 'px-3 py-2')} role="region" aria-label="Live KPIs">
      <div className={cn('flex min-w-0 flex-1 items-center gap-1', compact ? '' : 'xl:gap-3')}>
        <Kpi label="Active requests" icon={Siren} tone="brand" loading={loading} value={k?.active ?? '--'} sub={matching ? `${matching} matching` : undefined} />
        <Kpi label="Available units" icon={Ambulance} tone="success" loading={loading} value={k ? k.available : '--'} sub={k ? `of ${k.fleet} online` : undefined} />
        <Kpi label="Avg match time" icon={Gauge} tone="info" loading={loading} value={k?.avgMatchMs != null ? k.avgMatchMs : '--'} sub={k?.avgMatchMs != null ? 'ms' : undefined} />
        <Kpi
          label="Escalations" icon={AlertTriangle} tone={k?.escalations ? 'danger' : 'neutral'} loading={loading}
          value={k?.escalations ?? '--'} sub={k?.escalations ? 'need a unit' : 'all clear'} emphasis={!!k?.escalations} onClick={onEscalations}
        />
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
