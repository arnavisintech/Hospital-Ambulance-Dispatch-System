import { useMemo, useState, type FormEvent } from 'react';
import { Eye, EyeOff, Mail, Phone, Power, ShieldCheck, User as UserIcon, UserPlus, Users as UsersIcon, Wand2 } from 'lucide-react';
import {
  Avatar, Badge, Button, ConfirmDialog, DataTable, EmptyState, ErrorState, IconButton, Input, Modal, PageHeader, Select, StatusPill,
  Tabs, useToast, type Column,
} from '../../components/ui';
import { ROLE_LABEL } from '../../components/layout';
import { useAuth } from '../../context/AuthContext';
import { useAsync } from '../../hooks/useAsync';
import { get, patch, post } from '../../lib/api';
import { fmtDate, fmtPhone } from '../../lib/format';
import type { Tone } from '../../lib/status';
import type { AmbulanceBrief, Role } from '../../lib/types';
import type { AdminHospital, AdminUser } from './shared/types';

const ROLES: Role[] = ['requester', 'crew', 'hospital_staff', 'controller', 'admin', 'authority'];
export const ROLE_TONE: Record<Role, Tone> = {
  admin: 'brand', controller: 'info', authority: 'violet', hospital_staff: 'teal', crew: 'orange', requester: 'neutral',
};

/* ------------------------------------------------------------------ validation (mirrors backend UserIn) */

export interface UserDraft {
  name: string; email: string; phone: string; password: string; role: Role;
  hospital_id: string; ambulance_id: string; license_number: string;
}
const EMPTY: UserDraft = { name: '', email: '', phone: '', password: '', role: 'controller', hospital_id: '', ambulance_id: '', license_number: '' };

export function validateUser(f: UserDraft): Partial<Record<keyof UserDraft, string>> {
  const e: Partial<Record<keyof UserDraft, string>> = {};
  if (f.name.trim().length < 2) e.name = 'Enter the full name (at least 2 characters)';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) e.email = 'Enter a valid email address';
  if (f.phone.trim() && !/^\+?[0-9]{7,15}$/.test(f.phone.replace(/[\s-]/g, ''))) e.phone = 'Use 7–15 digits, optionally starting with +';
  if (f.password.length < 8 || f.password.length > 72) e.password = 'Use 8–72 characters';
  if (f.role === 'hospital_staff' && !f.hospital_id) e.hospital_id = 'Choose the hospital this person works at';
  if (f.role === 'crew' && !f.license_number.trim()) e.license_number = 'Driving / paramedic licence is required for crew';
  return e;
}

function genPassword(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const a = new Uint32Array(12);
  crypto.getRandomValues(a);
  return `${Array.from(a, (n) => chars[n % chars.length]).join('')}#7`;
}

function CreateUserModal({ open, onClose, onCreated, hospitals, ambulances, takenAmbulances }: {
  open: boolean; onClose: () => void; onCreated: (u: AdminUser) => void;
  hospitals: AdminHospital[]; ambulances: AmbulanceBrief[]; takenAmbulances: Set<number>;
}) {
  const { success, error } = useToast();
  const [f, setF] = useState<UserDraft>(EMPTY);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  const errs = validateUser(f);
  const err = (k: keyof UserDraft) => (touched ? errs[k] : undefined);
  const set = (k: keyof UserDraft) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const close = () => { if (!busy) { setF(EMPTY); setTouched(false); onClose(); } };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const u = await post<AdminUser>('/admin/users', {
        name: f.name.trim(), email: f.email.trim(), phone: f.phone.replace(/[\s-]/g, '') || undefined, password: f.password, role: f.role,
        hospital_id: f.role === 'hospital_staff' ? Number(f.hospital_id) : undefined,
        ambulance_id: f.role === 'crew' && f.ambulance_id ? Number(f.ambulance_id) : undefined,
        license_number: f.role === 'crew' ? f.license_number.trim() : undefined,
      });
      success(`${u.name} can now sign in as ${ROLE_LABEL[u.role] ?? u.role}.`, { title: 'User created' });
      onCreated(u);
      setF(EMPTY); setTouched(false); onClose();
    } catch (e2) { error(e2, { title: "Couldn't create user" }); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={close} size="lg" title="Add a user" description="Staff accounts are created by admins. Share the temporary password securely."
      footer={<>
        <Button variant="secondary" onClick={close} disabled={busy}>Cancel</Button>
        <Button type="submit" form="create-user" icon={UserPlus} loading={busy}>Create user</Button>
      </>}>
      <form id="create-user" onSubmit={(e) => void submit(e)} noValidate className="grid gap-4 sm:grid-cols-2">
        <Select label="Role" value={f.role} onChange={set('role')} wrapperClassName="sm:col-span-2"
          options={ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
          helper={f.role === 'crew' ? 'Crew sign in on the duty app and receive dispatch offers.' : f.role === 'hospital_staff' ? 'Staff manage beds and confirm handovers for one hospital.' : f.role === 'authority' ? 'Read-only access to city-wide dashboards and the audit log.' : undefined} />
        <Input label="Full name" required icon={UserIcon} value={f.name} onChange={set('name')} error={err('name')} autoComplete="off" data-autofocus />
        <Input label="Email" required type="email" icon={Mail} value={f.email} onChange={set('email')} error={err('email')} autoComplete="off" />
        <Input label="Phone" type="tel" icon={Phone} value={f.phone} onChange={set('phone')} error={err('phone')} helper="Optional · e.g. +919840012345" />
        <Input label="Temporary password" required type={show ? 'text' : 'password'} value={f.password} onChange={set('password')} error={err('password')}
          autoComplete="new-password" className="font-mono"
          trailing={<span className="flex">
            <IconButton size="sm" label={show ? 'Hide password' : 'Show password'} icon={show ? EyeOff : Eye} onClick={() => setShow((s) => !s)} />
            <IconButton size="sm" label="Generate a strong password" icon={Wand2} onClick={() => { setF((x) => ({ ...x, password: genPassword() })); setShow(true); }} />
          </span>}
          wrapperClassName="[&_input]:pr-24" />
        {f.role === 'hospital_staff' && (
          <Select label="Hospital" required value={f.hospital_id} onChange={set('hospital_id')} error={err('hospital_id')} wrapperClassName="sm:col-span-2"
            placeholder={hospitals.length ? 'Choose a hospital' : 'No hospitals onboarded yet'}
            options={hospitals.map((h) => ({ value: h.id, label: h.name }))} />
        )}
        {f.role === 'crew' && (
          <>
            <Input label="Licence number" required value={f.license_number} onChange={set('license_number')} error={err('license_number')} maxLength={40} />
            <Select label="Ambulance" value={f.ambulance_id} onChange={set('ambulance_id')} helper="Optional · one crew account per ambulance"
              options={[{ value: '', label: 'Assign later' }, ...ambulances.map((a) => ({
                value: a.id, label: `${a.registration_number}${a.station_name ? ` · ${a.station_name}` : ''}${takenAmbulances.has(a.id) ? ' (has crew)' : ''}`,
                disabled: takenAmbulances.has(a.id),
              }))]} />
          </>
        )}
      </form>
    </Modal>
  );
}

type RoleFilter = Role | 'all';

export default function Users() {
  const { user: me } = useAuth();
  const { success, error } = useToast();
  const users = useAsync(async () => {
    const x = await get<AdminUser[] | { items: AdminUser[] }>('/admin/users', { limit: 500 });
    return Array.isArray(x) ? x : x.items ?? [];
  }, []);
  const hospitals = useAsync(() => get<AdminHospital[]>('/admin/hospitals'), []);
  const fleet = useAsync(async () => (await get<{ ambulances: AmbulanceBrief[] }>('/controller/board')).ambulances ?? [], []);
  const [role, setRole] = useState<RoleFilter>('all');
  const [creating, setCreating] = useState(false);
  const [confirm, setConfirm] = useState<AdminUser | null>(null);

  const all = useMemo(() => users.data ?? [], [users.data]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: all.length };
    for (const u of all) c[u.role] = (c[u.role] ?? 0) + 1;
    return c;
  }, [all]);
  const rows = role === 'all' ? all : all.filter((u) => u.role === role);
  const hospitalName = useMemo(() => new Map((hospitals.data ?? []).map((h) => [h.id, h.name])), [hospitals.data]);
  const ambReg = useMemo(() => new Map((fleet.data ?? []).map((a) => [a.id, a.registration_number])), [fleet.data]);
  const taken = useMemo(() => new Set(all.filter((u) => u.role === 'crew' && u.ambulance_id).map((u) => u.ambulance_id!)), [all]);

  const toggle = async (u: AdminUser) => {
    const next = !(u.is_active ?? true);
    try {
      const out = await patch<AdminUser>(`/admin/users/${u.id}`, { is_active: next });
      users.setData((xs) => xs?.map((x) => (x.id === u.id ? { ...x, ...out, is_active: out?.is_active ?? next } : x)) ?? xs);
      success(`${u.name} ${next ? 'can sign in again' : 'can no longer sign in'}.`, { title: next ? 'Account activated' : 'Account deactivated' });
    } catch (e) { error(e, { title: "Couldn't update account" }); throw e; }
  };

  const linked = (u: AdminUser) => {
    if (u.role === 'hospital_staff') return u.hospital_id ? hospitalName.get(u.hospital_id) ?? `Hospital #${u.hospital_id}` : '--';
    if (u.role === 'crew') {
      const amb = u.ambulance_id ? ambReg.get(u.ambulance_id) ?? `Ambulance #${u.ambulance_id}` : 'No ambulance';
      return u.license_number ? `${amb} · ${u.license_number}` : amb;
    }
    return '';
  };

  const columns: Column<AdminUser>[] = [
    {
      key: 'name', header: 'User', sortable: true, accessor: (u) => `${u.name} ${u.email ?? ''}`,
      cell: (u) => (
        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={u.name} size="sm" />
          <div className="min-w-0">
            <p className="truncate font-semibold text-ink-900">{u.name}{u.id === me?.id && <span className="ml-1.5 text-xs font-medium text-ink-500">(you)</span>}</p>
            <p className="truncate text-sm text-ink-500">{u.email ?? '--'}</p>
          </div>
        </div>
      ),
    },
    { key: 'role', header: 'Role', sortable: true, accessor: (u) => ROLE_LABEL[u.role] ?? u.role, cell: (u) => <Badge tone={ROLE_TONE[u.role] ?? 'neutral'}>{ROLE_LABEL[u.role] ?? u.role}</Badge> },
    { key: 'phone', header: 'Phone', hideBelow: 'lg', cell: (u) => <span className="tabular-nums text-ink-700">{u.phone ? fmtPhone(u.phone) : '--'}</span> },
    { key: 'linked', header: 'Assignment', hideBelow: 'md', accessor: linked, cell: (u) => <span className="text-sm text-ink-700">{linked(u) || <span className="text-ink-400">—</span>}</span> },
    { key: 'created_at', header: 'Added', sortable: true, hideBelow: 'lg', cell: (u) => <span className="text-sm text-ink-700">{fmtDate(u.created_at)}</span> },
    { key: 'is_active', header: 'Status', sortable: true, accessor: (u) => (u.is_active === false ? 'inactive' : 'active'), cell: (u) => <StatusPill kind="generic" status={u.is_active === false ? 'inactive' : 'active'} /> },
    {
      key: 'actions', header: <span className="sr-only">Actions</span>, align: 'right',
      cell: (u) => (
        <Button size="sm" variant={u.is_active === false ? 'secondary' : 'ghost'} icon={Power} disabled={u.id === me?.id}
          title={u.id === me?.id ? "You can't deactivate your own account" : undefined}
          onClick={(e) => { e.stopPropagation(); setConfirm(u); }}>
          {u.is_active === false ? 'Activate' : 'Deactivate'}
        </Button>
      ),
    },
  ];

  const tabs = [{ value: 'all' as RoleFilter, label: 'All', badge: counts.all ?? 0 }, ...ROLES.map((r) => ({ value: r as RoleFilter, label: ROLE_LABEL[r], badge: counts[r] ?? 0 }))];

  return (
    <div>
      <PageHeader title="Users & roles" subtitle="Staff accounts, role assignments and access"
        actions={<Button icon={UserPlus} onClick={() => setCreating(true)}>Add user</Button>} />
      <Tabs id="roles" variant="pill" ariaLabel="Filter by role" items={tabs} value={role} onChange={setRole} className="mb-4 pb-1" />
      {users.error && !users.data ? (
        <div className="rounded-lg border border-line/70 bg-surface shadow-card"><ErrorState message={`${users.error}.`} onRetry={() => void users.reload()} /></div>
      ) : (
        <DataTable caption={`Users${role !== 'all' ? ` — ${ROLE_LABEL[role]}` : ''}`} data={rows} columns={columns} rowKey={(u) => u.id}
          loading={users.loading} searchable searchPlaceholder="Search name, email or role" pageSize={12} initialSort={{ key: 'created_at', dir: 'desc' }}
          toolbar={<span className="hidden items-center gap-1.5 text-sm text-ink-500 sm:inline-flex"><ShieldCheck size={16} aria-hidden /> Changes are audited</span>}
          empty={<EmptyState compact icon={UsersIcon} title={role === 'all' ? 'No users yet' : `No ${ROLE_LABEL[role].toLowerCase()} accounts`}
            action={<Button size="sm" variant="secondary" icon={UserPlus} onClick={() => setCreating(true)}>Add user</Button>} />} />
      )}

      <CreateUserModal open={creating} onClose={() => setCreating(false)} hospitals={hospitals.data ?? []} ambulances={fleet.data ?? []} takenAmbulances={taken}
        onCreated={(u) => users.setData((xs) => [...(xs ?? []), u])} />
      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        tone={confirm?.is_active === false ? 'primary' : 'danger'}
        icon={Power}
        title={confirm?.is_active === false ? `Activate ${confirm?.name}?` : `Deactivate ${confirm?.name}?`}
        description={confirm?.is_active === false
          ? 'They will be able to sign in again with their existing password.'
          : 'They will be signed out of new sessions and can no longer sign in. Their history and audit trail are kept.'}
        confirmLabel={confirm?.is_active === false ? 'Activate' : 'Deactivate'}
        onConfirm={() => (confirm ? toggle(confirm) : undefined)}
      />
    </div>
  );
}
