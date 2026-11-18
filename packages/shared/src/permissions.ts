/**
 * Role-based access control. This file is shared so the UI can hide
 * buttons, but the backend is the only place where these checks are
 * enforced. Never trust a role sent by the browser.
 */

export const ROLES = ['super_admin', 'admin', 'it_admin', 'department_manager', 'employee'] as const;
export type Role = (typeof ROLES)[number];

export type UserStatus = 'active' | 'pending' | 'disabled';

export interface AppUser {
  uid: string;
  name: string;
  email: string;
  role: Role;
  department: string | null;
  status: UserStatus;
  createdAt: string;
  lastLoginAt: string | null;
}

export type Permission =
  | 'workflow.create'
  | 'workflow.viewAll'
  | 'workflow.manageAll'
  | 'workflow.manageDepartment'
  | 'workflow.publish'
  | 'execution.viewAll'
  | 'execution.viewDepartment'
  | 'execution.debug'
  | 'credential.manage'
  | 'integration.manage'
  | 'node.createCustom'
  | 'user.manage'
  | 'settings.manage'
  | 'audit.view'
  /** Create and change AI employees (AI Staff). */
  | 'agent.manage'
  /** Add, change and remove Company Knowledge documents. */
  | 'knowledge.manage';

const MATRIX: Record<Role, Permission[]> = {
  super_admin: [
    'workflow.create', 'workflow.viewAll', 'workflow.manageAll', 'workflow.manageDepartment', 'workflow.publish',
    'execution.viewAll', 'execution.viewDepartment', 'execution.debug',
    'credential.manage', 'integration.manage', 'node.createCustom',
    'user.manage', 'settings.manage', 'audit.view', 'agent.manage', 'knowledge.manage',
  ],
  admin: [
    'workflow.create', 'workflow.viewAll', 'workflow.manageAll', 'workflow.manageDepartment', 'workflow.publish',
    'execution.viewAll', 'execution.viewDepartment', 'integration.manage', 'audit.view', 'agent.manage', 'knowledge.manage',
  ],
  it_admin: [
    'workflow.create', 'workflow.viewAll', 'workflow.manageAll', 'workflow.publish',
    'execution.viewAll', 'execution.viewDepartment', 'execution.debug',
    'credential.manage', 'integration.manage', 'node.createCustom',
  ],
  department_manager: ['workflow.create', 'workflow.manageDepartment', 'workflow.publish', 'execution.viewDepartment'],
  employee: [],
};

export function hasPermission(user: Pick<AppUser, 'role'>, permission: Permission): boolean {
  return MATRIX[user.role]?.includes(permission) ?? false;
}

/** Minimal shape needed to decide access to a workflow. */
export interface WorkflowAccessTarget {
  ownerId: string;
  department: string | null;
  sharedWith: string[];
}

export function canViewWorkflow(user: AppUser, wf: WorkflowAccessTarget): boolean {
  if (hasPermission(user, 'workflow.viewAll')) return true;
  if (wf.ownerId === user.uid) return true;
  if (wf.sharedWith.includes(user.uid)) return true;
  if (hasPermission(user, 'workflow.manageDepartment') && user.department && wf.department === user.department) return true;
  return false;
}

export function canEditWorkflow(user: AppUser, wf: WorkflowAccessTarget): boolean {
  if (hasPermission(user, 'workflow.manageAll')) return true;
  if (hasPermission(user, 'workflow.manageDepartment') && user.department && wf.department === user.department) return true;
  // Owners who are allowed to create workflows can keep editing their own.
  if (wf.ownerId === user.uid && hasPermission(user, 'workflow.create')) return true;
  return false;
}

/** Running is allowed for editors and for users the workflow is shared with. */
export function canRunWorkflow(user: AppUser, wf: WorkflowAccessTarget): boolean {
  return canEditWorkflow(user, wf) || wf.sharedWith.includes(user.uid) || wf.ownerId === user.uid;
}

export function canPublishWorkflow(user: AppUser, wf: WorkflowAccessTarget): boolean {
  return hasPermission(user, 'workflow.publish') && canEditWorkflow(user, wf);
}
