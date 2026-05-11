import type { ActiveCourt, CourtSlot, GhostCourt } from "@/lib/types";
import { CLUB_COURT_COUNT } from "./constants";

export function makeEmptySlots(): CourtSlot[] {
  return [
    { slot: 1, userId: null },
    { slot: 2, userId: null },
    { slot: 3, userId: null },
    { slot: 4, userId: null },
  ];
}

export function emptyActiveCourts(): ActiveCourt[] {
  return Array.from({ length: CLUB_COURT_COUNT }, (_, i) => ({
    index: i + 1,
    slots: makeEmptySlots(),
  }));
}

export function emptyGhostCourts(): GhostCourt[] {
  return Array.from({ length: CLUB_COURT_COUNT }, (_, i) => ({
    id: `ghost-${i + 1}`,
    sortOrder: i + 1,
    slots: makeEmptySlots(),
  }));
}

/** Queue 1 → fills cleared active court; each queue rung shifts up; last rung empties. */
export function promoteQueueAfterFinish(ghostPrev: GhostCourt[]): { fillSlots: CourtSlot[]; newGhost: GhostCourt[] } {
  const sorted = [...ghostPrev].sort((a, b) => a.sortOrder - b.sortOrder);
  if (sorted.length === 0) {
    return { fillSlots: makeEmptySlots(), newGhost: ghostPrev };
  }
  const fillSlots: CourtSlot[] = sorted[0].slots.map((s) => ({ ...s }));
  const newGhost = ghostPrev.map((gc) => {
    const pos = sorted.findIndex((x) => x.id === gc.id);
    if (pos === -1) return gc;
    if (pos === sorted.length - 1) {
      return { ...gc, slots: makeEmptySlots() };
    }
    return {
      ...gc,
      slots: sorted[pos + 1].slots.map((s) => ({ ...s })),
    };
  });
  return { fillSlots, newGhost };
}

