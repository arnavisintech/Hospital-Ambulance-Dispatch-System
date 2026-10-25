import { useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { errMsg } from '../lib/api';
import { Button } from './ui/Button';
import { Input } from './ui/Field';
import { Modal } from './ui/Modal';

/** Change own password. `forced` (temporary password after an admin reset) cannot be dismissed. */
export function ChangePasswordModal({ open, onClose, forced = false }: { open: boolean; onClose: () => void; forced?: boolean }) {
  const { changePassword, logout } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setErr(null);
    if (next.length < 8) { setErr('New password must be at least 8 characters'); return; }
    if (next !== confirm) { setErr('Passwords do not match'); return; }
    setBusy(true);
    try {
      await changePassword(current, next);
      setCurrent(''); setNext(''); setConfirm('');
      onClose();
    } catch (ex) {
      setErr(errMsg(ex));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={forced ? () => undefined : onClose}
      dismissible={!forced}
      hideClose={forced}
      title={forced ? 'Set a new password' : 'Change password'}
      description={forced ? 'You signed in with a temporary password. Choose your own to continue.' : 'Other signed-in devices will be signed out.'}
      footer={<>
        {forced
          ? <Button variant="secondary" onClick={logout}>Sign out</Button>
          : <Button variant="secondary" onClick={onClose}>Cancel</Button>}
        <Button onClick={() => void submit()} loading={busy}>Update password</Button>
      </>}
    >
      <form onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
        <Input label="Current password" icon={Lock} type="password" autoComplete="current-password" required
          value={current} onChange={(e) => setCurrent(e.target.value)} data-autofocus />
        <Input label="New password" icon={Lock} type="password" autoComplete="new-password" required
          helper="At least 8 characters" value={next} onChange={(e) => setNext(e.target.value)} />
        <Input label="Confirm new password" icon={Lock} type="password" autoComplete="new-password" required
          value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        {err && <p role="alert" className="rounded-md bg-danger-bg px-3 py-2.5 text-sm font-medium text-danger-fg">{err}</p>}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}

// Raising or tracking an SOS and running a live trip must never wait on a password form.
const EMERGENCY_PATHS = /^\/(sos|track|crew)(\/|$)/;

/** Mounted once: forces the password change after an admin reset or a bootstrap admin's first sign-in (except on the
 *  emergency screens, where it appears once the user moves on). */
export function ForcedPasswordChange() {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const open = !!user?.must_change_password && !EMERGENCY_PATHS.test(pathname);
  return <ChangePasswordModal open={open} onClose={() => undefined} forced />;
}
