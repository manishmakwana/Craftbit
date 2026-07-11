/** Display-unit formatting (spec §7.3). Storage is always mm. */

import type { DisplayUnit } from "./document";

const MM_PER: Record<DisplayUnit, number> = { mm: 1, cm: 10, m: 1000, in: 25.4 };

export function mmToDisplay(mm: number, unit: DisplayUnit): number {
  return mm / MM_PER[unit];
}

export function formatLength(mm: number, unit: DisplayUnit, decimals = 2): string {
  return `${mmToDisplay(mm, unit).toFixed(decimals)} ${unit}`;
}
