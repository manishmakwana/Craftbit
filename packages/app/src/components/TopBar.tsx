import { useDocumentStore } from "../stores/documentStore";
import { useUiStore } from "../stores/uiStore";
import { useAiStore } from "../stores/aiStore";
import { downloadDocument, openDocumentFile } from "../stores/persistence";

export function TopBar() {
  const doc = useDocumentStore((s) => s.doc);
  const saved = useDocumentStore((s) => s.saved);
  const canUndo = useDocumentStore((s) => s.history.undoStack.length > 0);
  const canRedo = useDocumentStore((s) => s.history.redoStack.length > 0);
  const { dispatch, undo, redo, replaceDocument, newDocument } = useDocumentStore.getState();
  const openDialog = useUiStore((s) => s.openDialog);
  const aiOpen = useAiStore((s) => s.open);
  const toggleAi = useAiStore((s) => s.toggleOpen);

  return (
    <div className="top-bar">
      <span className="brand">Craftbit</span>
      <input
        className="doc-name-input"
        value={doc.name}
        aria-label="Project name"
        onChange={(e) => dispatch({ kind: "renameDocument", name: e.target.value })}
      />
      <span className="save-dot" title={saved ? "Autosaved" : "Saving…"} data-saved={saved} />
      <button className="btn" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)">
        ↩ Undo
      </button>
      <button className="btn" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Y)">
        ↪ Redo
      </button>
      <button
        className={`btn${aiOpen ? " primary" : ""}`}
        onClick={toggleAi}
        title={aiOpen ? "Hide Copilot" : "Show Copilot"}
        data-testid="ai-toggle"
        aria-pressed={aiOpen}
      >
        ✦ Copilot
      </button>
      <span className="spacer" />
      <button
        className="btn"
        onClick={() => {
          if (
            confirm(
              "Start a new project? The current one stays in this browser's autosave until replaced.",
            )
          ) {
            newDocument();
          }
        }}
      >
        New
      </button>
      <button
        className="btn"
        onClick={async () => {
          const opened = await openDocumentFile();
          if (opened) replaceDocument(opened);
        }}
      >
        Open…
      </button>
      <button className="btn" onClick={() => downloadDocument(doc)}>
        Save .craftbit
      </button>
      <button className="btn primary" onClick={() => openDialog({ kind: "export" })}>
        Export ▾
      </button>
    </div>
  );
}
