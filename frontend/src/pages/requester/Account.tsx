import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, KeyRound, Lock, ShieldCheck, Trash2 } from 'lucide-react';
import { ChangePasswordModal } from '../../components/ChangePasswordModal';
import { MobileAppLayout } from '../../components/layout';
import { Button, Card, CardHeader, Input, Modal, useToast } from '../../components/ui';
import { useAuth } from '../../context/AuthContext';
import { api, errMsg, get, saveBlob } from '../../lib/api';

/** Account & privacy (DPDP Act): change password, download my data, delete my account. */
export default function Account() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const { success, error } = useToast();
  const [pwOpen, setPwOpen] = useState(false);
  const [delOpen, setDelOpen] = useState(false);
  const guest = !!user?.is_guest;
  const [password, setPassword] = useState('');
  const [delErr, setDelErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<'export' | 'delete' | null>(null);

  const download = async () => {
    setBusy('export');
    try {
      const data = await get<unknown>('/auth/me/export');
      saveBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
        `hads-my-data-${new Date().toISOString().slice(0, 10)}.json`);
      success('Your data was downloaded');
    } catch (e) { error(e, { title: "Couldn't export your data" }); } finally { setBusy(null); }
  };

  const erase = async () => {
    setBusy('delete');
    setDelErr(null);
    try {
      await api('/auth/me', { method: 'DELETE', body: guest ? {} : { password } });
      logout();
      nav('/', { replace: true });
    } catch (e) { setDelErr(errMsg(e)); setBusy(null); }
  };

  return (
    <MobileAppLayout title="Account & privacy" back="/sos" width="2xl">
      <div className="space-y-4 p-4">
        <Card padding="md">
          <CardHeader title={user?.name ?? 'Your account'} subtitle={user?.email ?? user?.phone ?? undefined} icon={ShieldCheck} />
          {!guest && <Button variant="secondary" icon={KeyRound} onClick={() => setPwOpen(true)} fullWidth>Change password</Button>}
        </Card>
        <Card padding="md">
          <CardHeader title="Your data" subtitle="Everything HADS holds about you: profile, requests, trips and bills." icon={Download} />
          <Button variant="secondary" icon={Download} onClick={() => void download()} loading={busy === 'export'} fullWidth>Download my data</Button>
        </Card>
        <Card padding="md">
          <CardHeader title="Delete account" icon={Trash2}
            subtitle="Removes your name, phone, email, notifications and the notes, addresses, feedback and insurance details on your requests; pickup points are blurred to about 1 km. Anonymous trip and billing records are kept as the law requires." />
          <Button variant="danger" icon={Trash2} onClick={() => setDelOpen(true)} fullWidth>Delete my account</Button>
        </Card>
      </div>

      <ChangePasswordModal open={pwOpen} onClose={() => setPwOpen(false)} />
      <Modal open={delOpen} onClose={() => setDelOpen(false)} size="sm" title="Delete your account?"
        description="This cannot be undone. You will be signed out on every device."
        footer={<><Button variant="secondary" onClick={() => setDelOpen(false)}>Cancel</Button>
          <Button variant="danger" onClick={() => void erase()} loading={busy === 'delete'} disabled={!guest && !password}>Delete permanently</Button></>}>
        {guest
          ? delErr && <p className="text-sm text-danger-fg" role="alert">{delErr}</p>
          : <Input label="Password" icon={Lock} type="password" autoComplete="current-password" value={password}
              onChange={(e) => setPassword(e.target.value)} error={delErr ?? undefined} data-autofocus />}
      </Modal>
    </MobileAppLayout>
  );
}
