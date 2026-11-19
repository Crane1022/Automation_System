import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import type { Permission } from '@widebed/shared';

declare module 'vue-router' {
  interface RouteMeta {
    public?: boolean;
    permission?: Permission;
    title?: string;
    /** Page is shown in the menu but blocked with an "Under construction" screen. */
    underConstruction?: boolean;
  }
}

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: () => import('@/views/LoginView.vue'), meta: { public: true, title: 'Sign in' } },
    { path: '/reset-password', component: () => import('@/views/ResetPasswordView.vue'), meta: { public: true, title: 'Reset password' } },
    // Full-screen editor (own layout)
    { path: '/workflows/:id/edit', component: () => import('@/views/WorkflowEditorView.vue'), meta: { title: 'Editor' } },
    {
      path: '/',
      component: () => import('@/layouts/AppLayout.vue'),
      children: [
        { path: '', component: () => import('@/views/OverviewView.vue'), meta: { title: 'Dashboard' } },
        { path: 'workflows', component: () => import('@/views/WorkflowsView.vue'), meta: { title: 'Workflows' } },
        { path: 'executions', component: () => import('@/views/ExecutionsView.vue'), meta: { title: 'Executions' } },
        { path: 'executions/:id', component: () => import('@/views/ExecutionDetailView.vue'), meta: { title: 'Execution' } },
        { path: 'users', component: () => import('@/views/UsersView.vue'), meta: { title: 'Users & Permissions', permission: 'user.manage' } },
        { path: 'integrations', component: () => import('@/views/IntegrationsView.vue'), meta: { title: 'Integrations' } },
        { path: 'ai-agents', component: () => import('@/views/AiView.vue'), meta: { title: 'AI Settings' } },
        // AI Staff (the Widebed Assistant is one of them; old /assistant links still work)
        { path: 'ai-staff', component: () => import('@/views/AiStaffView.vue'), meta: { underConstruction: true, title: 'AI Staff' } },
        { path: 'ai-staff/new', component: () => import('@/views/AgentEditView.vue'), meta: { underConstruction: true, title: 'New AI employee', permission: 'agent.manage' } },
        { path: 'ai-staff/:id/edit', component: () => import('@/views/AgentEditView.vue'), meta: { underConstruction: true, title: 'Edit AI employee' } },
        { path: 'ai-tasks', component: () => import('@/views/AiTasksView.vue'), meta: { underConstruction: true, title: 'AI Tasks' } },
        { path: 'ai-collaboration', component: () => import('@/views/AiCollaborationView.vue'), meta: { underConstruction: true, title: 'Collaboration' } },
        { path: 'ai-performance', component: () => import('@/views/AiPerformanceView.vue'), meta: { underConstruction: true, title: 'AI Performance' } },
        { path: 'knowledge', component: () => import('@/views/KnowledgeView.vue'), meta: { underConstruction: true, title: 'Company Knowledge' } },
        { path: 'ai-approvals', component: () => import('@/views/AiApprovalsView.vue'), meta: { underConstruction: true, title: 'Approvals' } },
        { path: 'ai-schedules', component: () => import('@/views/AiSchedulesView.vue'), meta: { underConstruction: true, title: 'AI Schedules' } },
        { path: 'ai-staff/:agentId/chat/:chatId?', component: () => import('@/views/AgentChatView.vue'), meta: { underConstruction: true, title: 'AI Staff' } },
        { path: 'assistant/:id?', redirect: (to) => `/ai-staff/widebed-assistant/chat${typeof to.params.id === 'string' && to.params.id ? `/${to.params.id}` : ''}` },
        { path: 'credentials', component: () => import('@/views/CredentialsView.vue'), meta: { title: 'Credentials' } },
        { path: 'schedules', component: () => import('@/views/SchedulesView.vue'), meta: { title: 'Schedules' } },
        { path: 'templates', component: () => import('@/views/TemplatesView.vue'), meta: { title: 'Templates' } },
        { path: 'activity', component: () => import('@/views/ActivityView.vue'), meta: { title: 'Activity log', permission: 'audit.view' } },
        { path: 'settings', component: () => import('@/views/SettingsView.vue'), meta: { title: 'Settings' } },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  await auth.readyPromise;
  if (to.meta.public) return auth.profile ? '/' : true;
  if (!auth.isSignedIn || !auth.profile) return { path: '/login', query: to.fullPath !== '/' ? { next: to.fullPath } : {} };
  if (to.meta.permission && !auth.can(to.meta.permission)) return '/';
  return true;
});

router.afterEach((to) => {
  document.title = to.meta.title ? `${to.meta.title} · Widebed Automation` : 'Widebed Automation';
});
