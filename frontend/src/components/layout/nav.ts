import {
  Ambulance, BarChart3, Building2, ClipboardList, History, LayoutDashboard, MonitorDot, Receipt, ScrollText, Settings,
  Siren, Users, type LucideIcon,
} from 'lucide-react';
import type { Role } from '../../lib/types';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Match only the exact path (default true). */
  end?: boolean;
}

/** Console sidebar / drawer navigation per role. Screen agents: add entries here when adding console pages. */
export const CONSOLE_NAV: Partial<Record<Role, NavItem[]>> = {
  controller: [
    { to: '/controller', label: 'Live board', icon: MonitorDot },
  ],
  admin: [
    { to: '/admin', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/controller', label: 'Live board', icon: MonitorDot },
    { to: '/admin/onboarding', label: 'Onboarding', icon: Building2 },
    { to: '/admin/users', label: 'Users', icon: Users },
    { to: '/admin/billing', label: 'Billing', icon: Receipt },
    { to: '/admin/audit', label: 'Audit log', icon: ScrollText },
    { to: '/admin/settings', label: 'Settings', icon: Settings },
  ],
  authority: [
    { to: '/authority', label: 'Overview', icon: BarChart3 },
    { to: '/authority/audit', label: 'Audit log', icon: ScrollText },
  ],
  hospital_staff: [
    { to: '/hospital', label: 'Incoming', icon: ClipboardList },
  ],
};

/** Avatar-menu links for mobile-app roles. */
export const APP_MENU: Partial<Record<Role, NavItem[]>> = {
  requester: [
    { to: '/sos', label: 'Request ambulance', icon: Siren },
    { to: '/history', label: 'My trips', icon: History },
  ],
  crew: [{ to: '/crew', label: 'Duty', icon: Ambulance }],
};

export const ROLE_LABEL: Record<Role, string> = {
  requester: 'Requester',
  crew: 'Ambulance crew',
  hospital_staff: 'Hospital staff',
  controller: 'Controller',
  admin: 'Admin',
  authority: 'Health authority',
};
