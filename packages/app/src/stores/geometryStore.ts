/**
 * Bridge to the geometry worker. Holds the latest regeneration result and
 * discards stale responses via a monotonically increasing generation number
 * (design doc D1). Regeneration requests are debounced so slider-like edits
 * don't queue up a regen per keystroke.
 */

import { create } from "zustand";
import { serializeDocument, type CraftbitDocument } from "@craftbit/core";
import {
  createGeometryWorkerClient,
  type GeometryWorkerClient,
  type RegenResult,
  type StlExportResult,
} from "@craftbit/geometry-worker";

let client: GeometryWorkerClient | null = null;
function worker(): GeometryWorkerClient {
  client ??= createGeometryWorkerClient();
  return client;
}

interface GeometryState {
  kernelReady: boolean;
  regenerating: boolean;
  result: RegenResult | null;
  lastError: string | null;
  init(): void;
  requestRegen(doc: CraftbitDocument): void;
  exportStl(doc: CraftbitDocument): Promise<StlExportResult>;
  exportStep(doc: CraftbitDocument): Promise<Uint8Array>;
}

let generation = 0;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

export const useGeometryStore = create<GeometryState>((set) => ({
  kernelReady: false,
  regenerating: false,
  result: null,
  lastError: null,

  init() {
    worker()
      .api.ready()
      .then(() => set({ kernelReady: true }))
      .catch((e: unknown) =>
        set({ lastError: `Kernel failed to load: ${e instanceof Error ? e.message : String(e)}` }),
      );
  },

  requestRegen(doc) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const myGeneration = ++generation;
      set({ regenerating: true });
      worker()
        .api.regenerate(serializeDocument(doc), myGeneration)
        .then((result) => {
          if (result.generation !== generation) return; // stale — superseded
          set({ result, regenerating: false, lastError: null });
        })
        .catch((e: unknown) => {
          if (myGeneration !== generation) return;
          set({
            regenerating: false,
            lastError: e instanceof Error ? e.message : String(e),
          });
        });
    }, 60);
  },

  exportStl(doc) {
    return worker().api.exportStl(serializeDocument(doc), []);
  },

  exportStep(doc) {
    return worker().api.exportStep(serializeDocument(doc), []);
  },
}));
