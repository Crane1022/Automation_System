import { BookOpen, CalendarClock, ListTodo, Network, ShieldCheck, Sparkles, TrendingUp } from '@lucide/vue';
import type { Component } from 'vue';

/** AI Team pages that are planned but not open yet. Shown in the "Under construction" pop-up. */
export const aiTeamUpcoming: { title: string; text: string; icon: Component }[] = [
  { title: 'AI Staff', text: 'AI employees for each department that you can chat with and give work to.', icon: Sparkles },
  { title: 'AI Tasks', text: 'Hand jobs to your AI staff and follow their progress.', icon: ListTodo },
  { title: 'AI Schedules', text: 'Let AI staff run routine jobs on a timetable.', icon: CalendarClock },
  { title: 'Approvals', text: 'Check and approve what the AI wants to do before it happens.', icon: ShieldCheck },
  { title: 'Collaboration', text: 'See how AI staff pass work to each other.', icon: Network },
  { title: 'Company Knowledge', text: 'Documents and house rules the AI staff learn from.', icon: BookOpen },
  { title: 'AI Performance', text: 'How well each AI employee is doing over time.', icon: TrendingUp },
];
