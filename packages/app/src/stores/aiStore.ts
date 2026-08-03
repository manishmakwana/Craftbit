/**
 * State for the AI Copilot (§ AI integration): the chat transcript, the
 * bring-your-own Anthropic API key (persisted to localStorage — this is a
 * client-side, no-backend app, so the key lives in the browser), the chosen
 * model, and whether a request is in flight. The agent loop (ai/agent.ts)
 * reads the key/model from here and appends transcript entries as it runs.
 */

import { create } from "zustand";

export type ChatRole = "user" | "assistant";

/** One rendered line in the transcript. Tool activity is folded in as its
 * own entry type so the panel can show what the model did to the model. */
export type ChatEntry =
  | { id: string; role: ChatRole; kind: "text"; text: string }
  | { id: string; kind: "thinking"; text: string }
  | { id: string; kind: "tool"; tool: string; summary: string; ok: boolean }
  | { id: string; kind: "error"; text: string };

const KEY_STORAGE = "craftbit.anthropicApiKey";
const MODEL_STORAGE = "craftbit.aiModel";
export const AI_MODELS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"] as const;
export type AiModel = (typeof AI_MODELS)[number];

const readStored = (k: string): string => {
  try {
    return localStorage.getItem(k) ?? "";
  } catch {
    return "";
  }
};

interface AiState {
  apiKey: string;
  model: AiModel;
  entries: ChatEntry[];
  running: boolean;
  /** Panel open/closed (persisted only in-session). */
  open: boolean;

  setApiKey(key: string): void;
  setModel(model: AiModel): void;
  toggleOpen(): void;
  setRunning(running: boolean): void;
  addEntry(entry: ChatEntry): void;
  /** Appends streamed text to a text/thinking entry (by id) in place. */
  appendText(id: string, delta: string): void;
  clear(): void;
}

export const useAiStore = create<AiState>((set) => ({
  apiKey: readStored(KEY_STORAGE),
  model: (readStored(MODEL_STORAGE) || "claude-opus-5") as AiModel,
  entries: [],
  running: false,
  open: true,

  setApiKey(key) {
    try {
      if (key) localStorage.setItem(KEY_STORAGE, key);
      else localStorage.removeItem(KEY_STORAGE);
    } catch {
      // storage may be unavailable (private mode); key stays in memory only
    }
    set({ apiKey: key });
  },

  setModel(model) {
    try {
      localStorage.setItem(MODEL_STORAGE, model);
    } catch {
      // ignore
    }
    set({ model });
  },

  toggleOpen() {
    set((s) => ({ open: !s.open }));
  },

  setRunning(running) {
    set({ running });
  },

  addEntry(entry) {
    set((s) => ({ entries: [...s.entries, entry] }));
  },

  appendText(id, delta) {
    set((s) => ({
      entries: s.entries.map((e) =>
        e.id === id && (e.kind === "text" || e.kind === "thinking")
          ? { ...e, text: e.text + delta }
          : e,
      ),
    }));
  },

  clear() {
    set({ entries: [] });
  },
}));
