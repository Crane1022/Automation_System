import {
  Layers,
  GlobeLock,
  Sparkles,
  Bot,
  Clock,
  Code,
  Database,
  Filter,
  GitBranch,
  Globe,
  Mail,
  MailOpen,
  Merge,
  MessageSquare,
  MousePointerClick,
  Radio,
  Repeat,
  ScanText,
  Sheet,
  Split,
  SquareKanban,
  Tags,
  Timer,
  Webhook,
  Wrench,
  Box,
} from '@lucide/vue';
import type { Component } from 'vue';

/** Node icon names (from node descriptors) → Lucide components. Explicit map keeps the bundle small. */
const map: Record<string, Component> = {
  'mouse-pointer-click': MousePointerClick,
  webhook: Webhook,
  globe: Globe,
  'git-branch': GitBranch,
  clock: Clock,
  radio: Radio,
  split: Split,
  merge: Merge,
  filter: Filter,
  repeat: Repeat,
  timer: Timer,
  database: Database,
  code: Code,
  mail: Mail,
  'mail-open': MailOpen,
  sheet: Sheet,
  trello: SquareKanban,
  'message-square': MessageSquare,
  bot: Bot,
  wrench: Wrench,
  tags: Tags,
  'scan-text': ScanText,
  layers: Layers,
  'globe-lock': GlobeLock,
  sparkles: Sparkles,
};

export const iconFor = (name: string): Component => map[name] ?? Box;

/** Accent per node category, used for the icon tile. */
export const categoryStyle: Record<string, string> = {
  trigger: 'bg-ok-soft text-ok',
  logic: 'bg-warn-soft text-warn',
  data: 'bg-info-soft text-info',
  communication: 'bg-[#dff3f1] text-[#0f766e] dark:bg-[#0e2a2c] dark:text-[#5fd0c6]',
  ai: 'bg-[#efe8f5] text-[#6c4a8f] dark:bg-[#2a2233] dark:text-[#b99ad6]',
};

export const categoryLabels: Record<string, string> = {
  trigger: 'Triggers',
  logic: 'Logic',
  data: 'Data',
  communication: 'Communication',
  ai: 'AI',
};
