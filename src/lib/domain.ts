import { RecommendResult, SessionMember, User } from "@/lib/types";

export const MMR_MIN = 0;
export const MMR_MAX = 1000;
export const DEFAULT_MMR = 500;
export const ELO_K = 24;
export const RECOMMEND_MMR_TOLERANCE = 300;

export function clampMmr(value: number): number {
  return Math.max(MMR_MIN, Math.min(MMR_MAX, Math.round(value)));
}

export function validateScore(winnerScore: number, loserScore: number): string | null {
  if (winnerScore < 0 || loserScore < 0) {
    return "Scores cannot be negative.";
  }
  if (winnerScore < loserScore) {
    return "Winner score must be greater than loser score.";
  }
  if (winnerScore > 30 || loserScore > 29) {
    return "Badminton cap is 30 points for winner and 29 for loser.";
  }
  if (winnerScore < 21) {
    return "Winner must score at least 21.";
  }
  const diff = winnerScore - loserScore;
  if (winnerScore < 30 && diff < 2) {
    return "Winner must lead by 2 unless the score reaches 30.";
  }
  if (winnerScore === 30 && loserScore > 29) {
    return "At 30 cap, loser can be at most 29.";
  }
  return null;
}

function expectedScore(teamAAvg: number, teamBAvg: number): number {
  return 1 / (1 + 10 ** ((teamBAvg - teamAAvg) / 400));
}

export function getMmrDeltas(
  winners: User[],
  losers: User[],
): { winnerDelta: number; loserDelta: number } {
  const winnerAvg = average(winners.map((w) => w.mmr));
  const loserAvg = average(losers.map((l) => l.mmr));
  const expectedWinner = expectedScore(winnerAvg, loserAvg);
  const rawDelta = ELO_K * (1 - expectedWinner);
  const winnerDelta = Math.max(1, Math.round(rawDelta));
  return {
    winnerDelta,
    loserDelta: -winnerDelta,
  };
}

export function minutesSince(timestamp: number | null, now: number): number | null {
  if (timestamp === null) return null;
  const diff = Math.max(0, now - timestamp);
  return Math.floor(diff / 60000);
}

/** Minutes waiting on bench (off active/queue). Prefers bench entry time when provided. */
export function minutesWaitingOffCourt(member: SessionMember, now: number): number {
  let anchor = member.lastGameFinishedAt ?? member.joinedAt;
  if (member.boardState === "bench" && member.benchEnteredAt != null) {
    anchor = member.benchEnteredAt;
  }
  return Math.floor(Math.max(0, now - anchor) / 60000);
}

export function formatOffCourtWait(member: SessionMember, now: number): string {
  const m = minutesWaitingOffCourt(member, now);
  if (m < 1) return "Less than 1 min";
  if (m === 1) return "1 min";
  return `${m} min`;
}

/** Compact label for small UI (e.g. bench chip). */
export function formatOffCourtWaitShort(member: SessionMember, now: number): string {
  const m = minutesWaitingOffCourt(member, now);
  if (m < 1) return "<1m";
  return `${m}m`;
}

export function getRecommendation(params: {
  benchMembers: SessionMember[];
  usersById: Map<string, User>;
  now: number;
}): RecommendResult | null {
  const { benchMembers, usersById, now } = params;
  if (benchMembers.length < 4) return null;

  let best: { ids: [string, string, string, string]; score: number; maxGap: number } | null = null;
  for (let i = 0; i < benchMembers.length; i += 1) {
    for (let j = i + 1; j < benchMembers.length; j += 1) {
      for (let k = j + 1; k < benchMembers.length; k += 1) {
        for (let m = k + 1; m < benchMembers.length; m += 1) {
          const ids: [string, string, string, string] = [
            benchMembers[i].userId,
            benchMembers[j].userId,
            benchMembers[k].userId,
            benchMembers[m].userId,
          ];
          const users = ids.map((id) => usersById.get(id)).filter((u): u is User => Boolean(u));
          if (users.length !== 4) continue;
          const mmrs = users.map((u) => u.mmr);
          const maxGap = Math.max(...mmrs) - Math.min(...mmrs);
          const mmrPenalty = maxGap;
          const waitBoost = ids
            .map((id) => {
              const member = benchMembers.find((b) => b.userId === id);
              return minutesSince(member?.lastGameFinishedAt ?? null, now) ?? 120;
            })
            .reduce((a, b) => a + b, 0);
          const score = mmrPenalty - waitBoost;
          if (!best || score < best.score) {
            best = { ids, score, maxGap };
          }
        }
      }
    }
  }
  if (!best) return null;
  return {
    playerIds: best.ids,
    warning:
      best.maxGap > RECOMMEND_MMR_TOLERANCE
        ? `Suggested players exceed preferred MMR tolerance (${best.maxGap} > ${RECOMMEND_MMR_TOLERANCE}).`
        : null,
  };
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}
