export type Role = "admin" | "player";

export type BoardState = "bench" | "ghost" | "active" | "break";

export interface User {
  id: string;
  organizationId: string;
  role: Role;
  /** Convenience label (e.g. court chips): full display name from profile rows. */
  name: string;
  firstName: string;
  lastName: string;
  username: string;
  mmr: number;
}

export interface SessionMember {
  userId: string;
  gamesPlayed: number;
  wins: number;
  losses: number;
  boardState: BoardState;
  lastGameFinishedAt: number | null;
  joinedAt: number;
  /** Epoch ms when player last entered the bench (drives “off court” timer on bench). */
  benchEnteredAt: number | null;
}

export interface CourtSlot {
  slot: 1 | 2 | 3 | 4;
  userId: string | null;
}

export interface ActiveCourt {
  index: number;
  slots: CourtSlot[];
}

export interface GhostCourt {
  id: string;
  sortOrder: number;
  slots: CourtSlot[];
}

export interface MatchResultPayload {
  winners: [string, string];
  losers: [string, string];
  winnerScore: number;
  loserScore: number;
}

/** Admin records which side won; winners/losers are derived from court slots (top = slots 1–2, bottom = slots 3–4). */
export interface CourtResultDraft {
  winnerSide: "top" | "bottom";
  winnerScore: number;
  loserScore: number;
}

export interface MatchLedgerEntry {
  id: string;
  createdAt: number;
  winners: [string, string];
  losers: [string, string];
  winnerScore: number;
  loserScore: number;
}

export interface SnapshotPlayerStat {
  userId: string;
  matchesPlayed: number;
  wins: number;
  losses: number;
}

export interface SessionSnapshot {
  id: string;
  snapshotName: string;
  snapshotDate: string;
  createdAt: number;
  stats: SnapshotPlayerStat[];
}

export interface RecommendResult {
  playerIds: [string, string, string, string];
  warning: string | null;
}
