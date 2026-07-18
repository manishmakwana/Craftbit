import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { useDocumentStore } from "./stores/documentStore";
import { useGeometryStore } from "./stores/geometryStore";
import "./styles.css";

// Dev-only debug handle for E2E scripts and console poking; stripped from
// production by the DEV guard.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__craftbitDebug = {
    doc: () => useDocumentStore.getState().doc,
    result: () => useGeometryStore.getState().result,
  };
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("Missing #root element");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
