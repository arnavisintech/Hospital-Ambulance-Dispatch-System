import { useState } from 'react';
import { LocateFixed, MapPin, Search } from 'lucide-react';
import { Input, Modal, Spinner } from '../../../components/ui';
import { usePlaceSearch } from '../../../hooks/usePlaceSearch';
import { ApiError } from '../../../lib/api';
import type { PlaceResult } from '../../../lib/types';

/** Debounced place search (GET /geo/search). Degrades to a hint when the endpoint is missing (404). */
export function PlaceSearch({ open, onClose, onPick, onUseGps }: {
  open: boolean; onClose: () => void; onPick: (p: PlaceResult) => void; onUseGps: () => void;
}) {
  const [q, setQ] = useState('');
  const { results, loading: busy, error } = usePlaceSearch(q, 350);
  const msg = !error ? null : error instanceof ApiError && error.status === 404
    ? 'Search isn’t available right now — close this and move the map to your location.'
    : 'Couldn’t search — check your connection, or move the map to your location.';

  return (
    <Modal open={open} onClose={onClose} title="Set pickup location" size="md">
      <div className="space-y-3 pb-2">
        <Input
          label="Search area, street or landmark"
          hideLabel
          icon={Search}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search area, street or landmark"
          data-autofocus
          autoComplete="off"
          trailing={busy ? <Spinner size={18} className="mr-2 text-ink-400" /> : undefined}
        />
        <button
          type="button"
          onClick={() => { onUseGps(); onClose(); }}
          className="flex min-h-[48px] w-full items-center gap-3 rounded-md px-2 text-left font-semibold text-brand-600 hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <LocateFixed size={20} aria-hidden /> Use my current location
        </button>
        <div aria-live="polite">
          {msg && <p className="rounded-md bg-warning-bg px-3 py-2 text-sm text-warning-fg">{msg}</p>}
          {results && results.length === 0 && !msg && !busy && <p className="px-2 py-3 text-sm text-ink-500">No places found for “{q.trim()}”.</p>}
          {results && results.length > 0 && (
            <ul className="divide-y divide-line">
              {results.map((p, i) => (
                <li key={`${p.lat},${p.lng},${i}`}>
                  <button
                    type="button"
                    onClick={() => { onPick(p); onClose(); }}
                    className="flex min-h-[52px] w-full items-center gap-3 px-2 py-2 text-left hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-canvas text-ink-500" aria-hidden><MapPin size={18} /></span>
                    <span className="min-w-0 text-sm font-medium text-ink-900">{p.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
