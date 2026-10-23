import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Ambulance, BarChart3, Building2, Eye, EyeOff, Lock, MonitorDot, Settings, Siren, User, type LucideIcon,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { errMsg } from '../lib/api';
import { ROLE_HOME } from '../lib/guard';
import { cn } from '../lib/cn';
import { AuthShell } from '../components/layout/AuthShell';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Field';
import { Spinner } from '../components/ui/Spinner';

export const DEMO_PASSWORD = 'Hads@1234';

interface Demo { email: string; label: string; hint: string; icon: LucideIcon; tone: string }
export const DEMO_USERS: Demo[] = [
  { email: 'user@hads.in', label: 'Requester', hint: 'Request & track', icon: Siren, tone: 'bg-brand-50 text-brand-500' },
  { email: 'crew1@hads.in', label: 'Crew', hint: 'Accept trips', icon: Ambulance, tone: 'bg-info-bg text-info' },
  { email: 'controller@hads.in', label: 'Controller', hint: 'Live dispatch board', icon: MonitorDot, tone: 'bg-violet-bg text-violet' },
  { email: 'staff1@hads.in', label: 'Hospital', hint: 'Incoming patients', icon: Building2, tone: 'bg-teal-bg text-teal' },
  { email: 'admin@hads.in', label: 'Admin', hint: 'Platform setup', icon: Settings, tone: 'bg-orange-bg text-orange' },
  { email: 'authority@hads.in', label: 'Authority', hint: 'Oversight & KPIs', icon: BarChart3, tone: 'bg-success-bg text-success' },
];

export default function Login() {
  const { login, guest } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const doLogin = async (id: string, pw: string, key: string) => {
    setBusy(key);
    setErr(null);
    try {
      const u = await login(id, pw);
      const from = (loc.state as { from?: string } | null)?.from;
      nav(from && from !== '/login' ? from : ROLE_HOME[u.role], { replace: true });
    } catch (e) {
      setErr(errMsg(e));
      setBusy(null);
    }
  };
  const submit = (e: FormEvent) => { e.preventDefault(); void doLogin(identifier.trim(), password, 'form'); };
  const quickSos = async () => {
    setBusy('sos');
    try { await guest(); nav('/sos'); } catch (e) { setErr(`${errMsg(e)} — you can also call 108.`); setBusy(null); }
  };

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to continue to HADS."
      footer={
        <div className="flex flex-col items-center gap-3 text-sm text-ink-500">
          <p>New here? <Link to="/register" className="font-bold text-brand-600 hover:underline">Create an account</Link></p>
          <button type="button" onClick={() => void quickSos()} disabled={!!busy}
            className="inline-flex items-center gap-1.5 font-semibold text-ink-700 hover:text-brand-600 disabled:opacity-50">
            <Siren size={16} className="text-brand-500" aria-hidden /> Emergency? Quick SOS without signing in
          </button>
        </div>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Input label="Email or phone" icon={User} autoComplete="username" required value={identifier}
          onChange={(e) => setIdentifier(e.target.value)} placeholder="you@example.com" />
        <Input
          label="Password" icon={Lock} type={show ? 'text' : 'password'} autoComplete="current-password" required
          value={password} onChange={(e) => setPassword(e.target.value)}
          trailing={
            <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'}
              className="flex h-10 w-10 items-center justify-center rounded-full text-ink-500 hover:bg-canvas">
              {show ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
            </button>
          }
        />
        {err && <p role="alert" className="rounded-md bg-danger-bg px-3 py-2.5 text-sm font-medium text-danger-fg">{err}</p>}
        <Button type="submit" size="lg" fullWidth loading={busy === 'form'} disabled={!!busy && busy !== 'form'}>Sign in</Button>
      </form>

      <div className="my-7 flex items-center gap-3 text-xs font-semibold uppercase tracking-wide text-ink-500">
        <span className="h-px flex-1 bg-line" />or try a demo account<span className="h-px flex-1 bg-line" />
      </div>

      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3" aria-label="Demo accounts">
        {DEMO_USERS.map((d) => (
          <li key={d.email}>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => void doLogin(d.email, DEMO_PASSWORD, d.email)}
              aria-label={`Sign in as demo ${d.label} (${d.email})`}
              className={cn(
                'press flex h-full w-full flex-col items-start gap-2 rounded-lg border border-line bg-surface p-3 text-left shadow-card transition',
                'hover:border-ink-400 hover:shadow-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-60',
              )}
            >
              <span className={cn('flex h-9 w-9 items-center justify-center rounded-md', d.tone)} aria-hidden>
                {busy === d.email ? <Spinner size={18} className="text-current" /> : <d.icon size={18} />}
              </span>
              <span>
                <span className="block text-sm font-bold text-ink-900">{d.label}</span>
                <span className="block text-xs text-ink-500">{d.hint}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-center text-xs text-ink-500">Demo password for all accounts: <code className="font-semibold text-ink-700">{DEMO_PASSWORD}</code></p>
    </AuthShell>
  );
}
