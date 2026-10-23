// Legacy wrappers (pre-v2 pages). New code: use <StatusPill> / <SeverityBadge> from components/ui.
import { SeverityBadge, StatusPill } from './ui/Badge';
import { AMBULANCE_STATUS, REQUEST_STATUS, toneClasses, type Tone } from '../lib/status';

export function StatusChip({ status }: { status: string }) {
  if (status in REQUEST_STATUS) return <StatusPill status={status} />;
  if (status in AMBULANCE_STATUS || status === 'busy') return <StatusPill status={status} kind="ambulance" />;
  return <StatusPill status={status} kind="generic" />;
}

export function SeverityChip({ severity }: { severity: number }) {
  return <SeverityBadge severity={severity} />;
}

const MAP_TONE: Record<string, Tone> = {
  available: 'success', offered: 'warning', assigned: 'warning', accepted: 'info', en_route: 'info', on_scene: 'violet',
  transporting: 'orange', arrived: 'teal', busy: 'orange', offline: 'muted', maintenance: 'muted',
};

/** CSS colours built on CSS variables — valid in inline styles / divIcon HTML only (not SVG attributes). */
export const MAP_STATUS_HEX: Record<string, string> = Object.fromEntries(
  Object.entries(MAP_TONE).map(([k, t]) => [k, toneClasses(t).css]),
);
