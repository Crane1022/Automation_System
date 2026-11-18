/**
 * AI Staff — custom AI employees built on the Widebed Assistant engine.
 *
 * Firestore (server only):
 *   aiAgents/{agentId}          the profile below
 *   assistantChats/{id}         chats; `agentId` says which AI employee (missing = the Widebed Assistant)
 *   assistantMemories/{id}      memory; `agentId` as above
 */

export const DEFAULT_AGENT_ID = 'widebed-assistant';

export type AgentVisibility = 'private' | 'department' | 'company';
export type AgentStatus = 'active' | 'disabled' | 'archived';

/** The tool groups an AI employee may be given. */
export interface AgentTools {
  /** Remember / forget facts (its own memory). */
  memory: boolean;
  /** List and run published workflows the person may run. */
  workflows: boolean;
  /** Read PMS data through the read-only connection (AI Settings). */
  pms: boolean;
  /** Web browser with saved website logins. */
  browser: boolean;
  /** Which saved websites: credential ids, or 'all' it may see. */
  websites: string[] | 'all';
  /** Look things up in Company Knowledge (missing = on). */
  knowledge?: boolean;
}

export interface AiAgent {
  agentId: string;
  name: string;
  /** One emoji shown in the avatar circle. */
  avatar: string;
  /** Avatar colour key (see AGENT_COLORS). */
  color: string;
  title: string;
  department: string | null;
  description: string;
  personality: string;
  communicationStyle: string;
  responsibilities: string[];
  expertise: string[];
  /** Extra instructions written by the admin. Only admins can read them. */
  instructions: string;
  /** AI service connection (Credentials → AI). null = the one in AI Settings. */
  aiCredentialId: string | null;
  /** Model name; null = the connection's own model. */
  model: string | null;
  /** 0–1; null = the service default (some newer models refuse other values). */
  temperature: number | null;
  maxOutputTokens: number;
  tools: AgentTools;
  memoryEnabled: boolean;
  /**
   * A manager: may hand parts of a request to other AI staff (Main Manager).
   * Its helpers then only get tools the manager itself has.
   */
  canDelegate: boolean;
  /** Most tool steps per message before it stops and asks. */
  maxSteps: number;
  visibility: AgentVisibility;
  /** Extra people who may use it (any visibility). */
  allowedUserIds: string[];
  /**
   * People an Admin trusted to look after this AI employee (e.g. the Finance manager):
   * they may change its profile, job and instructions — not its AI, tools or who may use it.
   */
  managerIds: string[];
  /** People an Admin allowed to approve this AI employee's actions (any level, incl. critical). */
  approverIds: string[];
  /** If not empty, only these roles may use it (admins always can). */
  allowedRoles: string[];
  status: AgentStatus;
  /** The original Widebed Assistant: can't be deleted. */
  builtIn: boolean;
  /** Template it was made from, if any. */
  templateId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string | null;
}

/** What people who may only chat get to see (no instructions or access lists). */
export type AgentSummary = Pick<
  AiAgent,
  'agentId' | 'name' | 'avatar' | 'color' | 'title' | 'department' | 'description' | 'responsibilities' | 'expertise' | 'visibility' | 'status' | 'builtIn' | 'lastActiveAt' | 'model' | 'canDelegate'
> & {
  /** Plain words, e.g. "Gemini · gemini-2.5-flash". */
  aiName: string | null;
  tools: AgentTools;
  /** Full control (Admins). */
  canManage: boolean;
  /** May edit its profile, job and instructions (Admins and its delegated managers). */
  canEdit: boolean;
  /** Why it can't answer right now (no AI connection…), or null. */
  problem: string | null;
  chats: number;
  /** A chat of this person with this agent is working right now. */
  working: boolean;
};

export type AgentInput = Omit<AiAgent, 'agentId' | 'builtIn' | 'createdBy' | 'createdAt' | 'updatedAt' | 'lastActiveAt'>;

export const AGENT_COLORS: Record<string, { label: string }> = {
  brand: { label: 'Green' },
  blue: { label: 'Blue' },
  amber: { label: 'Amber' },
  rose: { label: 'Rose' },
  violet: { label: 'Violet' },
  slate: { label: 'Slate' },
};

export const DEFAULT_AGENT_TOOLS: AgentTools = { memory: true, workflows: false, pms: false, browser: false, websites: 'all' };

export function blankAgent(): AgentInput {
  return {
    name: '',
    avatar: '🤖',
    color: 'brand',
    title: '',
    department: null,
    description: '',
    personality: 'Friendly, careful and practical.',
    communicationStyle: 'Short, clear answers in simple English with bullet points. Exact numbers and dates.',
    responsibilities: [],
    expertise: [],
    instructions: '',
    aiCredentialId: null,
    model: null,
    temperature: null,
    maxOutputTokens: 8000,
    tools: { ...DEFAULT_AGENT_TOOLS },
    memoryEnabled: true,
    canDelegate: false,
    maxSteps: 10,
    visibility: 'company',
    allowedUserIds: [],
    managerIds: [],
    approverIds: [],
    allowedRoles: [],
    status: 'active',
    templateId: null,
  };
}

/** What a delegated manager (not an Admin) may change on an AI employee. */
export const DELEGATED_AGENT_FIELDS = ['avatar', 'color', 'title', 'description', 'personality', 'communicationStyle', 'responsibilities', 'expertise', 'instructions'] as const;

/** Lasting memory never keeps secrets. Returns why the text is refused, or null. */
export function memorySecretProblem(text: string): string | null {
  if (/\b(password|passwd|passcode|pwd|kata\s*laluan)\b\s*(is|=|:|-)?\s*\S{4,}/i.test(text) || /\b(pin|otp|pass)\b\s*(is|=|:)\s*\S{3,}/i.test(text)) return 'It looks like a password or code. Passwords are never kept in memory — save website logins on the Credentials page instead.';
  if (/\b\d{6}-\d{2}-\d{4}\b/.test(text) || /\b(ic|nric|mykad|i\/c)\b[^\d]{0,12}\d{12}\b/i.test(text)) return 'It looks like an IC number. IC numbers are never kept in memory.';
  for (const m of text.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return 'It looks like a card number. Card numbers are never kept in memory.';
  }
  return null;
}
function luhn(d: string) {
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

export interface AgentTemplate {
  templateId: string;
  /** Short line for the template picker. */
  pitch: string;
  agent: Partial<AgentInput> & Pick<AgentInput, 'name' | 'avatar' | 'title'>;
}

/** Optional starting points. Every field can be changed after creating. */
export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    templateId: 'main-manager',
    pitch: 'Coordinates the other AI staff and writes management reports.',
    agent: {
      name: 'Main Manager',
      avatar: '🧭',
      color: 'slate',
      title: 'AI Workforce Manager',
      description: 'Understands your request, gathers what is needed and gives you one clear summary.',
      responsibilities: ['Understand requests from management', 'Coordinate the other AI staff', 'Review finished work', 'Write management reports'],
      expertise: ['Planning', 'Summaries', 'Prioritising'],
      personality: 'Calm, organised and to the point, like a reliable operations manager.',
      communicationStyle: 'Start with a 2–3 line summary, then details under short headings. End with recommended next steps.',
      instructions: 'For anything that needs more than one area (bookings + issues, finance + operations…), hand the parts to the right colleagues with the delegate tool, run independent parts at the same time, check their results against each other, then write one combined report.',
      tools: { memory: true, workflows: true, pms: true, browser: false, websites: 'all' },
      canDelegate: true,
    },
  },
  {
    templateId: 'pms-assistant',
    pitch: 'Arrivals, departures, reservations and booking problems.',
    agent: {
      name: 'PMS Assistant',
      avatar: '🏨',
      color: 'brand',
      title: 'Reservations & Front Desk',
      department: 'Operations',
      description: 'Checks guest arrivals and departures, searches reservations and spots booking problems.',
      responsibilities: ['Check today’s and tomorrow’s arrivals', 'Check departures', 'Search reservations', 'Flag booking problems (double bookings, missing details)', 'Prepare PMS reports'],
      expertise: ['Bookings', 'Guests', 'Occupancy'],
      instructions: 'Always look bookings up in the PMS before answering. Show guest name, unit, check-in and check-out dates. Flag anything unusual.',
      tools: { memory: true, workflows: false, pms: true, browser: false, websites: 'all' },
    },
  },
  {
    templateId: 'finance-assistant',
    pitch: 'Utility bills, expenses and financial summaries.',
    agent: {
      name: 'Finance Assistant',
      avatar: '💰',
      color: 'amber',
      title: 'Finance & Utilities',
      department: 'Finance',
      description: 'Checks outstanding utility bills, organises expenses and prepares financial summaries.',
      responsibilities: ['Check outstanding utility bills', 'Organise expense information', 'Prepare financial summaries and reports'],
      expertise: ['Utility bills', 'Expenses', 'Reports'],
      instructions: 'Use exact amounts with RM and dates. Never pay, transfer or change anything on a website. Say clearly when data is missing.',
      tools: { memory: true, workflows: true, pms: true, browser: true, websites: 'all' },
    },
  },
  {
    templateId: 'hr-assistant',
    pitch: 'Attendance, missing clock-ins and HR summaries.',
    agent: {
      name: 'HR Assistant',
      avatar: '🧑‍💼',
      color: 'violet',
      title: 'People & Attendance',
      department: 'HR',
      description: 'Checks attendance records, finds missing clock-ins and prepares HR summaries.',
      responsibilities: ['Check attendance records', 'Find missing clock-ins', 'Summarise attendance', 'Prepare HR reports'],
      expertise: ['Attendance', 'Staff schedules'],
      instructions: 'Treat staff information as confidential: only share it with the person asking. Never guess attendance — check the records.',
      tools: { memory: true, workflows: false, pms: true, browser: false, websites: 'all' },
    },
  },
  {
    templateId: 'operations-assistant',
    pitch: 'Open issues, overdue maintenance and daily operations.',
    agent: {
      name: 'Operations Assistant',
      avatar: '🛠️',
      color: 'blue',
      title: 'Operations & Maintenance',
      department: 'Operations',
      description: 'Watches operational issues and maintenance, finds overdue work and writes the daily operations summary.',
      responsibilities: ['Check unresolved issues', 'Find overdue maintenance', 'Track outstanding work', 'Write the daily operations summary'],
      expertise: ['Issues', 'Maintenance', 'Housekeeping'],
      instructions: 'Sort problems by urgency and age. For each issue show unit, what is wrong, how long it has been open and who has it.',
      tools: { memory: true, workflows: true, pms: true, browser: false, websites: 'all' },
    },
  },
  {
    templateId: 'marketing-assistant',
    pitch: 'Social media posts, campaign ideas and marketing research.',
    agent: {
      name: 'Marketing Assistant',
      avatar: '📣',
      color: 'rose',
      title: 'Marketing & Content',
      department: 'Marketing',
      description: 'Writes social media posts, suggests campaign ideas and looks at marketing results.',
      responsibilities: ['Prepare social media content', 'Suggest campaign ideas', 'Look at marketing performance'],
      expertise: ['Social media', 'Copywriting', 'Campaigns'],
      personality: 'Creative, upbeat and on-brand.',
      communicationStyle: 'Give 2–3 options when writing content. Mark which one you recommend and why.',
      tools: { memory: true, workflows: false, pms: false, browser: false, websites: 'all' },
    },
  },
  {
    templateId: 'automation-assistant',
    pitch: 'Runs workflows and investigates failed automations.',
    agent: {
      name: 'Automation Assistant',
      avatar: '⚙️',
      color: 'slate',
      title: 'Automation & Integrations',
      department: 'IT',
      description: 'Runs published workflows, checks how they went and helps find out why an automation failed.',
      responsibilities: ['Run published workflows when asked', 'Check workflow results', 'Investigate failed automations'],
      expertise: ['Workflows', 'Webhooks', 'Integrations'],
      tools: { memory: true, workflows: true, pms: false, browser: false, websites: 'all' },
    },
  },
];

/** The original assistant as an AI employee (created automatically). */
export function builtInAssistant(): AgentInput {
  return {
    ...blankAgent(),
    name: 'Widebed Assistant',
    avatar: '✨',
    color: 'brand',
    title: 'General assistant',
    description: 'Your all-round helper: PMS data, workflows, saved websites and anything else.',
    responsibilities: ['Answer questions from staff', 'Look things up in PMS', 'Run workflows when asked', 'Get bills and documents from saved websites'],
    expertise: ['Everything Widebed'],
    tools: { memory: true, workflows: true, pms: true, browser: true, websites: 'all' },
  };
}
