import { useState, type FormEvent } from 'react';
import { Copy, KeyRound, Plug, RotateCw, ShieldOff } from 'lucide-react';
import { Badge, Button, Card, CardHeader, ConfirmDialog, EmptyState, ErrorState, Input, Modal, Skeleton, useToast } from '../../../components/ui';
import { useAsync } from '../../../hooks/useAsync';
import { get, post } from '../../../lib/api';
import { fmtRelative } from '../../../lib/format';

interface ApiClient { id: number; name: string; is_active: boolean; created_at: string | null; last_used_at: string | null }
interface IssuedKey { name: string; api_key: string }

/** NFR8: API keys for external dispatch centres (108/102) calling the interop API (docs/INTEROP.md). */
export function ApiClientsCard() {
  const { success, error } = useToast();
  const list = useAsync(() => get<ApiClient[]>('/admin/api-clients'), []);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<IssuedKey | null>(null);
  const [confirm, setConfirm] = useState<{ client: ApiClient; action: 'rotate' | 'deactivate' } | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (name.trim().length < 2) return;
    setBusy(true);
    try {
      const out = await post<ApiClient & { api_key: string }>('/admin/api-clients', { name: name.trim() });
      setIssued({ name: out.name, api_key: out.api_key });
      setName('');
      void list.reload();
    } catch (err) { error(err, { title: "Couldn't create the key" }); } finally { setBusy(false); }
  };

  const act = async () => {
    if (!confirm) return;
    const { client, action } = confirm;
    try {
      const out = await post<ApiClient & { api_key?: string }>(`/admin/api-clients/${client.id}/${action}`, {});
      if (action === 'rotate' && out.api_key) setIssued({ name: client.name, api_key: out.api_key });
      else success(`${client.name} deactivated`);
      void list.reload();
    } catch (err) {
      error(err, { title: action === 'rotate' ? "Couldn't rotate the key" : "Couldn't deactivate" });
      throw err;
    }
  };

  const copy = async (key: string) => {
    try { await navigator.clipboard.writeText(key); success('Key copied'); } catch { /* clipboard blocked: the key stays visible */ }
  };

  const clients = list.data ?? [];
  return (
    <Card as="section" aria-labelledby="api-h">
      <CardHeader as="h2" title={<span id="api-h">API clients</span>}
        subtitle="Keys for external dispatch centres (108/102) using the interop API" icon={Plug} />
      <form onSubmit={create} className="mb-4 flex flex-wrap items-end gap-3">
        <Input label="Centre name" placeholder="e.g. TN 108 CAD" value={name} onChange={(e) => setName(e.target.value)}
          wrapperClassName="min-w-[14rem] flex-1" maxLength={120} />
        <Button type="submit" icon={KeyRound} loading={busy} disabled={name.trim().length < 2}>Create key</Button>
      </form>
      {list.loading && !list.data ? (
        <div className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : list.error && !list.data ? (
        <ErrorState compact message={list.error} onRetry={() => void list.reload()} />
      ) : !clients.length ? (
        <EmptyState compact icon={Plug} title="No external centres yet" description="Create a key for each centre that will send incidents." />
      ) : (
        <ul className="divide-y divide-line/70">
          {clients.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink-900">{c.name}</p>
                <p className="text-xs text-ink-500">{c.last_used_at ? `Last used ${fmtRelative(c.last_used_at)}` : 'Never used'}</p>
              </div>
              <Badge tone={c.is_active ? 'success' : 'muted'}>{c.is_active ? 'Active' : 'Deactivated'}</Badge>
              <Button size="sm" variant="secondary" icon={RotateCw} onClick={() => setConfirm({ client: c, action: 'rotate' })}
                aria-label={`Rotate key for ${c.name}`}>Rotate</Button>
              {c.is_active && (
                <Button size="sm" variant="ghost" icon={ShieldOff} onClick={() => setConfirm({ client: c, action: 'deactivate' })}
                  aria-label={`Deactivate ${c.name}`}>Deactivate</Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)} onConfirm={act}
        tone={confirm?.action === 'deactivate' ? 'danger' : 'primary'}
        title={confirm ? (confirm.action === 'rotate' ? `Rotate the key for ${confirm.client.name}?` : `Deactivate ${confirm.client.name}?`) : ''}
        description={confirm?.action === 'rotate'
          ? 'The current key stops working immediately. Give the new key to the centre right away.'
          : 'The centre can no longer send or read incidents. Its history is kept; rotating the key re-activates it.'}
        confirmLabel={confirm?.action === 'rotate' ? 'Rotate key' : 'Deactivate centre'} />

      <Modal open={!!issued} onClose={() => setIssued(null)} size="md" title={issued ? `Key for ${issued.name}` : ''}
        description="Copy it now and give it to the centre over a secure channel. It will not be shown again."
        footer={<Button onClick={() => setIssued(null)}>Done</Button>}>
        {issued && (
          <div className="flex items-center gap-2 rounded-md border border-line bg-canvas p-3">
            <code className="min-w-0 flex-1 break-all font-mono text-sm text-ink-900">{issued.api_key}</code>
            <Button size="sm" variant="secondary" icon={Copy} onClick={() => void copy(issued.api_key)} aria-label="Copy key">Copy</Button>
          </div>
        )}
      </Modal>
    </Card>
  );
}
