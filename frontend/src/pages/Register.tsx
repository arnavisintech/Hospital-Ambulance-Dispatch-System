import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Lock, Mail, Phone, User } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { errMsg } from '../lib/api';
import { AuthShell } from '../components/layout/AuthShell';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Field';

export default function Register() {
  const { register } = useAuth();
  const nav = useNavigate();
  const [f, setF] = useState({ name: '', phone: '', email: '', password: '' });
  const [err, setErr] = useState<string | null>(null);
  const [contactErr, setContactErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!f.email && !f.phone) { setContactErr('Add a phone number or an email so we can reach you'); return; }
    setContactErr(null);
    setBusy(true);
    setErr(null);
    try {
      await register({ name: f.name.trim(), phone: f.phone || undefined, email: f.email || undefined, password: f.password });
      nav('/sos', { replace: true });
    } catch (e2) {
      setErr(errMsg(e2));
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="Create your account"
      subtitle="Save your details once — when you need help, it's two taps."
      footer={<p className="text-center text-sm text-ink-500">Already registered? <Link to="/login" className="font-bold text-brand-600 hover:underline">Sign in</Link></p>}
    >
      <form onSubmit={submit} className="space-y-4">
        <Input label="Full name" icon={User} required value={f.name} onChange={set('name')} autoComplete="name" placeholder="Priya Raman" />
        <Input label="Phone" icon={Phone} type="tel" inputMode="tel" value={f.phone} onChange={set('phone')} autoComplete="tel"
          placeholder="98400 12345" helper="The crew calls this number if they can't find you." error={contactErr} />
        <Input label="Email" icon={Mail} type="email" value={f.email} onChange={set('email')} autoComplete="email" placeholder="you@example.com" />
        <Input label="Password" icon={Lock} type="password" required minLength={8} value={f.password} onChange={set('password')}
          autoComplete="new-password" helper="At least 8 characters." />
        {err && <p role="alert" className="rounded-md bg-danger-bg px-3 py-2.5 text-sm font-medium text-danger-fg">{err}</p>}
        <Button type="submit" size="lg" fullWidth loading={busy}>Create account</Button>
        <p className="text-center text-xs text-ink-500">
          In an emergency you don't need an account — use <Link to="/" className="font-semibold text-brand-600 hover:underline">Quick SOS</Link> or call 108.
        </p>
      </form>
    </AuthShell>
  );
}
