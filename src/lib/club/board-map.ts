import type { ActiveCourt, GhostCourt, SessionMember } from "@/lib/types";
import type { BoardState } from "@/lib/types";
import { CLUB_COURT_COUNT } from "./constants";
import { emptyActiveCourts, emptyGhostCourts } from "./queue-promotion";

export type PlacementRow = {
  profileId: string;
  kind: "bench" | "active" | "queue";
  courtIndex: number | null;
  slotNumber: number | null;
};

export type RosterRow = {
  profileId: string;
  joinedAt: Date;
  gamesPlayed: number;
  wins: number;
  losses: number;
  benchEnteredAt: Date | null;
  lastGameFinishedAt: Date | null;
};

export function liveBoardFromPlacements(
  placements: PlacementRow[],
  roster: RosterRow[],
): { activeCourts: ActiveCourt[]; ghostCourts: GhostCourt[]; sessionMembers: SessionMember[] } {
  const activeCourts = emptyActiveCourts();
  const ghostCourts = emptyGhostCourts();

  const byProfile = new Map(placements.map((p) => [p.profileId, p]));

  for (const p of placements) {
    if (p.kind === "active" && p.courtIndex != null && p.slotNumber != null) {
      const court = activeCourts.find((c) => c.index === p.courtIndex);
      const slot = court?.slots.find((s) => s.slot === p.slotNumber);
      if (slot) slot.userId = p.profileId;
    }
    if (p.kind === "queue" && p.courtIndex != null && p.slotNumber != null) {
      const court = ghostCourts.find((c) => c.sortOrder === p.courtIndex);
      const slot = court?.slots.find((s) => s.slot === p.slotNumber);
      if (slot) slot.userId = p.profileId;
    }
  }

  const sessionMembers: SessionMember[] = roster.map((r) => {
    const pl = byProfile.get(r.profileId);
    let boardState: BoardState = "bench";
    if (pl?.kind === "active") boardState = "active";
    else if (pl?.kind === "queue") boardState = "ghost";

    return {
      userId: r.profileId,
      gamesPlayed: r.gamesPlayed,
      wins: r.wins,
      losses: r.losses,
      boardState,
      lastGameFinishedAt: r.lastGameFinishedAt?.getTime() ?? null,
      joinedAt: r.joinedAt.getTime(),
      benchEnteredAt: r.benchEnteredAt?.getTime() ?? null,
    };
  });

  return { activeCourts, ghostCourts, sessionMembers };
}

/** Build placement rows from current board; anyone on roster not on a slot is bench. */
export function placementsFromLiveBoard(
  rosterProfileIds: string[],
  activeCourts: ActiveCourt[],
  ghostCourts: GhostCourt[],
): PlacementRow[] {
  const onSlot = new Set<string>();
  const rows: PlacementRow[] = [];

  for (const c of activeCourts) {
    for (const s of c.slots) {
      if (s.userId) {
        onSlot.add(s.userId);
        rows.push({
          profileId: s.userId,
          kind: "active",
          courtIndex: c.index,
          slotNumber: s.slot,
        });
      }
    }
  }
  for (const c of ghostCourts) {
    for (const s of c.slots) {
      if (s.userId) {
        onSlot.add(s.userId);
        rows.push({
          profileId: s.userId,
          kind: "queue",
          courtIndex: c.sortOrder,
          slotNumber: s.slot,
        });
      }
    }
  }

  for (const id of rosterProfileIds) {
    if (!onSlot.has(id)) {
      rows.push({ profileId: id, kind: "bench", courtIndex: null, slotNumber: null });
    }
  }

  return rows;
}

export function assertCourtShape(active: ActiveCourt[], ghost: GhostCourt[]): void {
  if (active.length !== CLUB_COURT_COUNT || ghost.length !== CLUB_COURT_COUNT) {
    throw new Error("Invalid court count");
  }
}
