/**
 * The Copilot chat panel (left column). Bring-your-own Anthropic key (stored
 * in the browser), a model picker, and a transcript that shows the model's
 * replies interleaved with the tool actions it took on your document. Sending
 * a message runs the agent loop (ai/agent.ts) which builds real geometry.
 */

import { useEffect, useRef, useState } from "react";
import { runAgent } from "../ai/agent";
import { executeTool } from "../ai/execute";
import { AI_MODELS, useAiStore, type AiModel } from "../stores/aiStore";
import { useGeometryStore } from "../stores/geometryStore";
import { newId } from "@craftbit/core";

export function AiPanel() {
  const { apiKey, model, entries, running } = useAiStore();
  const { setApiKey, setModel, addEntry, appendText, clear, setRunning } = useAiStore.getState();
  const [draft, setDraft] = useState("");
  const [showSettings, setShowSettings] = useState(!apiKey);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [entries, running]);

  // Dev/E2E hook: lets tests drive the same tools the model uses, so the tool
  // pipeline can be verified building real geometry without a live API key.
  // `bodies()` reads current body volumes so tests can assert cut/join results
  // (which modify an existing body in place, so the tool text omits a volume).
  useEffect(() => {
    (window as unknown as { __craftbitAI?: unknown }).__craftbitAI = {
      executeTool,
      bodies: () =>
        (useGeometryStore.getState().result?.bodies ?? []).map((b) => ({
          id: b.id,
          volume: b.volume,
        })),
    };
  }, []);

  const send = async () => {
    const text = draft.trim();
    if (!text || running) return;
    if (!apiKey) {
      setShowSettings(true);
      return;
    }
    setDraft("");
    addEntry({ id: newId(), role: "user", kind: "text", text });
    setRunning(true);
    await runAgent(text, {
      apiKey,
      model,
      onBlockStart: (kind) => {
        const id = newId();
        if (kind === "thinking") addEntry({ id, kind: "thinking", text: "" });
        else addEntry({ id, role: "assistant", kind: "text", text: "" });
        return id;
      },
      onBlockDelta: (id, delta) => appendText(id, delta),
      onTool: (tool, summary, ok) => addEntry({ id: newId(), kind: "tool", tool, summary, ok }),
      onError: (m) => addEntry({ id: newId(), kind: "error", text: m }),
    });
    setRunning(false);
  };

  return (
    <div className="ai-panel" data-testid="ai-panel">
      <div className="ai-head">
        <span className="ai-title">✦ Copilot</span>
        <span className="spacer" style={{ flex: 1 }} />
        <button
          className="btn ai-icon"
          title="Settings"
          data-testid="ai-settings-toggle"
          onClick={() => setShowSettings((s) => !s)}
        >
          ⚙
        </button>
        <button
          className="btn ai-icon"
          title="Clear conversation"
          onClick={clear}
          disabled={running}
        >
          🗑
        </button>
      </div>

      {showSettings && (
        <div className="ai-settings" data-testid="ai-settings">
          <label>Anthropic API key</label>
          <input
            type="password"
            data-testid="ai-key-input"
            placeholder="sk-ant-…"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
          />
          <label>Model</label>
          <select value={model} onChange={(e) => setModel(e.target.value as AiModel)}>
            {AI_MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <p className="ai-note">
            Your key is stored only in this browser and used to call Anthropic directly. It never
            leaves your machine except to api.anthropic.com.
          </p>
        </div>
      )}

      <div className="ai-messages" ref={listRef}>
        {entries.length === 0 && (
          <div className="ai-empty">
            Ask me to model something — e.g. “make a 120×80×40&nbsp;mm finger-joint box with
            5&nbsp;mm plywood”. I build it step by step on the timeline.
          </div>
        )}
        {entries.map((e) =>
          e.kind === "text" ? (
            <div key={e.id} className={`ai-msg ${e.role}`}>
              {e.text}
            </div>
          ) : e.kind === "thinking" ? (
            <div key={e.id} className="ai-thinking-block" data-testid="ai-thinking">
              {e.text}
            </div>
          ) : e.kind === "tool" ? (
            <div key={e.id} className={`ai-tool ${e.ok ? "" : "bad"}`} title={e.summary}>
              <span className="ai-tool-name">{e.tool}</span> {e.summary}
            </div>
          ) : (
            <div key={e.id} className="ai-msg error">
              {e.text}
            </div>
          ),
        )}
        {running && <div className="ai-thinking">Working…</div>}
      </div>

      <div className="ai-input">
        <textarea
          data-testid="ai-input"
          value={draft}
          rows={2}
          placeholder={apiKey ? "Describe what to model…" : "Add your API key (⚙) to start"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button
          className="btn primary"
          data-testid="ai-send"
          onClick={() => void send()}
          disabled={running || !draft.trim()}
        >
          {running ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}
