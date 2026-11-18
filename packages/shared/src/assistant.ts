/**
 * Widebed Assistant — a chat bot that remembers, uses tools (workflows, PMS data, a web browser)
 * and asks before doing anything risky. Shared by the API and the web app.
 *
 * Firestore:
 *   assistantChats/{id}                    ownerId, title, status, createdAt, updatedAt (+ server-only transcriptJson, pendingJson)
 *   assistantChats/{id}/messages/{id}      role, text, steps[], status, pending?, files[]
 *   assistantMemories/{id}                 ownerId, text, createdAt — what the assistant remembers about a person
 *   systemSettings/assistant               which AI / PMS connection it uses, browser on/off
 */

export type AssistantStepStatus = 'running' | 'done' | 'error' | 'waiting';

/** One visible step of the assistant's work, e.g. “Reading PMS: issues”. */
export interface AssistantStep {
  id: string;
  label: string;
  status: AssistantStepStatus;
  detail?: string;
  at: string;
}

export type AssistantMessageStatus = 'running' | 'done' | 'waiting_approval' | 'waiting_input' | 'error' | 'stopped';

export interface AssistantFile {
  fileId: string;
  name: string;
  size: number;
}

export interface AssistantMessage {
  messageId: string;
  chatId: string;
  role: 'user' | 'assistant';
  text: string;
  status: AssistantMessageStatus;
  steps: AssistantStep[];
  /** An action waiting for “Approve / Don’t do it”. */
  pending?: { tool: string; label: string; details: string; level?: 1 | 2 | 3 | 4; target?: string; approvalId?: string | null; expiresAt?: string | null } | null;
  files?: AssistantFile[];
  /** Files the person attached (only their text was given to the AI; the files are not kept). */
  attachments?: { name: string; kind: string; chars: number }[];
  /** Photos the person attached (kept small, inside the chat; shown with GET …/images/:imageId). */
  images?: { imageId: string; name: string; width: number; height: number }[];
  createdAt: string;
  updatedAt: string;
}

export interface AssistantChat {
  chatId: string;
  ownerId: string;
  /** Which AI employee (missing on old chats = the Widebed Assistant). */
  agentId?: string;
  title: string;
  status: 'idle' | 'running' | 'waiting';
  createdAt: string;
  updatedAt: string;
}

export interface AssistantMemory {
  memoryId: string;
  ownerId: string;
  /** Which AI employee remembers it (missing on old memories = the Widebed Assistant). */
  agentId?: string;
  text: string;
  createdAt: string;
}

export interface AssistantSettings {
  enabled: boolean;
  /** AI service connection (ai_provider) the assistant thinks with. */
  aiCredentialId: string | null;
  /** Read-only Firebase connection to Widebed PMS, or null. */
  pmsCredentialId: string | null;
  /** Lets the assistant use the web browser with saved website logins. */
  browserEnabled: boolean;
}

export const DEFAULT_ASSISTANT_SETTINGS: AssistantSettings = { enabled: false, aiCredentialId: null, pmsCredentialId: null, browserEnabled: false };

/** What a signed-in person sees about the assistant's setup. */
export interface AssistantStatus {
  enabled: boolean;
  ready: boolean;
  problem: string | null;
  aiName: string | null;
  pmsName: string | null;
  canUsePms: boolean;
  browserEnabled: boolean;
  websites: { credentialId: string; name: string }[];
  canManage: boolean;
  settings?: AssistantSettings;
}

/** A photo attached to a chat message, stored compressed inside the chat (no file storage). */
export interface ChatImage {
  imageId: string;
  chatId: string;
  /** Set when the message is sent; null = uploaded but not sent yet. */
  messageId: string | null;
  name: string;
  mime: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  /** Base64 of the image bytes. */
  data: string;
  bytes: number;
  width: number;
  height: number;
  createdAt: string;
}

export const CHAT_IMAGE_LIMITS = {
  /** Largest photo after compression in the browser. Firestore documents are max 1 MB. */
  maxBytes: 700 * 1024,
  perMessage: 3,
  perChat: 40,
  /** How many of the latest photos the AI looks at in one answer. */
  aiSees: 4,
  /** Longest side the browser shrinks photos to. */
  maxSide: 1600,
};
