import { Ambulance, type LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface PulseRadarProps {
  /** Diameter in px. Default 160. */
  size?: number;
  icon?: LucideIcon;
  /** Announced + shown under the radar. e.g. "Finding the nearest ambulance…" */
  label?: string;
  sublabel?: string;
  className?: string;
}

/** "Finding nearest ambulance" animation: brand core with expanding rings + rotating sweep. Static under reduced motion. */
export function PulseRadar({ size = 160, icon: Icon = Ambulance, label, sublabel, className }: PulseRadarProps) {
  const core = Math.round(size * 0.36);
  return (
    <div className={cn('flex flex-col items-center gap-4', className)} role="status" aria-live="polite">
      <div className="relative text-brand-500" style={{ width: size, height: size }} aria-hidden>
        <span className="absolute inset-0 rounded-full bg-brand-50" />
        <span className="absolute inset-[18%] rounded-full border border-brand-200/80" />
        <span className="absolute inset-[34%] rounded-full border border-brand-200" />
        {/* rotating sweep */}
        <span
          className="absolute inset-0 animate-[spin_2.4s_linear_infinite] rounded-full motion-reduce:hidden"
          style={{ background: 'conic-gradient(from 0deg, rgb(var(--brand-500) / .0) 0deg, rgb(var(--brand-500) / .0) 280deg, rgb(var(--brand-500) / .22) 360deg)' }}
        />
        <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ width: core, height: core }}>
          <span className="hads-pulse" />
          <span className="hads-pulse hads-pulse--delay" />
          <span className="relative flex h-full w-full items-center justify-center rounded-full bg-brand-500 text-white shadow-[0_8px_24px_-6px_rgb(var(--brand-500)/.6)]">
            <Icon size={Math.round(core * 0.5)} strokeWidth={2.2} />
          </span>
        </span>
      </div>
      {(label || sublabel) && (
        <div className="text-center">
          {label && <p className="text-lg font-bold text-ink-900">{label}</p>}
          {sublabel && <p className="mt-0.5 text-sm text-ink-500">{sublabel}</p>}
        </div>
      )}
    </div>
  );
}
