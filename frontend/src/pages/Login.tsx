import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Ambulance, BarChart3, Building2, Eye, EyeOff, Lock, MonitorDot, Settings, Siren, User, type LucideIcon,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { errMsg, get } from '../lib/api';
import { ROLE_HOME } from '../lib/guard';
import { cn } from '../lib/cn';
import type { ClientConfig, Role } from '../lib/types';
import { AuthShell } from '../components/layout/AuthShell';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Field';
import { Spinner } from '../components/ui/Spinner';

/** Look of each role's demo card; which accounts exist (and their password) comes from the server, demo mode only. */
const ROLE_LOOK: Record<Role, { icon: LucideIcon; tone: string }> = {
  requester: { icon: Siren, tone: 'bg-brand-50 text-brand-500' },
  crew: { icon: Ambulance, tone: 'bg-info-bg text-info' },
  controller: { icon: MonitorDot, tone: 'bg-violet-bg text-violet' },
  hospital_staff: { icon: Building2, tone: 'bg-teal-bg text-teal' },
  admin: { icon: Settings, tone: 'bg-orange-bg text-orange' },
  authority: { icon: BarChart3, tone: 'bg-success-bg text-success' },
};

const FALLBACK_LOOK = { icon: User, tone: 'bg-canvas text-ink-500' };

export default function Login() {
  const { login, guest } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [cfg, setCfg] = useState<ClientConfig | null>(null);

  useEffect(() => {
    let live = true;
    get<ClientConfig>('/public/config').then((c) => { if (live) setCfg(c); }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  const demos = cfg?.demo_mode && cfg.demo_password ? cfg.demo_accounts : [];

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

      {demos.length > 0 && (
        <>
          <div className="my-7 flex items-center gap-3 text-xs font-semibold uppercase tracking-wide text-ink-500">
            <span className="h-px flex-1 bg-line" />or try a demo account<span className="h-px flex-1 bg-line" />
          </div>

          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3" aria-label="Demo accounts">
            {demos.map((d) => {
              const look = ROLE_LOOK[d.role] ?? FALLBACK_LOOK;   // a role added server-side must not break sign-in
              return (
                <li key={d.email}>
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() => void doLogin(d.email, cfg!.demo_password!, d.email)}
                    aria-label={`Sign in as demo ${d.label} (${d.email})`}
                    className={cn(
                      'press flex h-full w-full flex-col items-start gap-2 rounded-lg border border-line bg-surface p-3 text-left shadow-card transition',
                      'hover:border-ink-400 hover:shadow-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-60',
                    )}
                  >
                    <span className={cn('flex h-9 w-9 items-center justify-center rounded-md', look.tone)} aria-hidden>
                      {busy === d.email ? <Spinner size={18} className="text-current" /> : <look.icon size={18} />}
                    </span>
                    <span>
                      <span className="block text-sm font-bold text-ink-900">{d.label}</span>
                      <span className="block text-xs text-ink-500">{d.hint}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-center text-xs text-ink-500">Demo password for all accounts: <code className="font-semibold text-ink-700">{cfg!.demo_password}</code></p>
        </>
      )}
    </AuthShell>
  );
}
