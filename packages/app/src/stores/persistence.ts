/**
 * Local-first persistence (spec §7.2, session subset): the working document
 * autosaves to IndexedDB on every change (debounced) and is restored on boot.
 * Explicit save/open moves `.craftbit` files (JSON) in and out.
 */

import { deserializeDocument, serializeDocument, type CraftbitDocument } from "@craftbit/core";

const DB_NAME = "craftbit";
const STORE = "projects";
const CURRENT_KEY = "current";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error as Error);
  });
}

export async function saveToAutosave(doc: CraftbitDocument): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(serializeDocument(doc), CURRENT_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error as Error);
  });
  db.close();
}

export async function loadFromAutosave(): Promise<CraftbitDocument | null> {
  const db = await openDb();
  const json = await new Promise<string | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(CURRENT_KEY);
    req.onsuccess = () => resolve(req.result as string | undefined);
    req.onerror = () => reject(req.error as Error);
  });
  db.close();
  if (!json) return null;
  try {
    return deserializeDocument(json);
  } catch (e) {
    console.error("Autosave was corrupt; starting fresh.", e);
    return null;
  }
}

export function downloadFile(name: string, data: BlobPart, mime: string): void {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadDocument(doc: CraftbitDocument): void {
  downloadFile(`${doc.name || "project"}.craftbit`, serializeDocument(doc), "application/json");
}

export function openDocumentFile(): Promise<CraftbitDocument | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".craftbit,application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      try {
        resolve(deserializeDocument(await file.text()));
      } catch (e) {
        alert(`Could not open file: ${e instanceof Error ? e.message : String(e)}`);
        resolve(null);
      }
    };
    input.click();
  });
}
