import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { clubSessions, matchResults, profiles, sessionPlacements, sessionRoster } from "@/db/schema";
import { getSessionFromCookies } from "@/lib/auth/get-session";
import { liveBoardFromPlacements, placementsFromLiveBoard } from "@/lib/club/board-map";
import type { PlacementRow, RosterRow } from "@/lib/club/board-map";
import { promoteQueueAfterFinish } from "@/lib/club/queue-promotion";
import { profileRowToUser } from "@/lib/club/profile-map";
import { clampMmr, getMmrDeltas, validateScore } from "@/lib/domain";
import type { User } from "@/lib/types";

type Ctx = { params: Promise<{ sessionId: string }> };

export async function POST(request: Request, ctx: Ctx) {
  const auth = await getSessionFromCookies();
  if (!auth || auth.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "database_not_configured" }, { status: 503 });
  }
  const { sessionId } = await ctx.params;

  const [cs] = await db
    .select()
    .from(clubSessions)
    .where(and(eq(clubSessions.id, sessionId), eq(clubSessions.organizationId, auth.oid)))
    .limit(1);
  if (!cs || cs.status !== "active") {
    return NextResponse.json({ error: "invalid_session" }, { status: 400 });
  }

  let body: { courtIndex?: number; winnerSide?: "top" | "bottom"; winnerScore?: number; loserScore?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const courtIndex = body.courtIndex;
  const winnerSide = body.winnerSide;
  const winnerScore = body.winnerScore ?? 21;
  const loserScore = body.loserScore ?? 18;
  if (typeof courtIndex !== "number" || (winnerSide !== "top" && winnerSide !== "bottom")) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const scoreError = validateScore(winnerScore, loserScore);
  if (scoreError) {
    return NextResponse.json({ error: scoreError }, { status: 400 });
  }

  const rosterDb = await db.select().from(sessionRoster).where(eq(sessionRoster.sessionId, sessionId));
  const rosterIds = rosterDb.map((r) => r.profileId);
  const placeRows = await db.select().from(sessionPlacements).where(eq(sessionPlacements.sessionId, sessionId));
  const placements: PlacementRow[] = placeRows.map((p) => ({
    profileId: p.profileId,
    kind: p.kind as PlacementRow["kind"],
    courtIndex: p.courtIndex,
    slotNumber: p.slotNumber,
  }));
  const roster: RosterRow[] = rosterDb.map((r) => ({
    profileId: r.profileId,
    joinedAt: r.joinedAt ?? new Date(),
    gamesPlayed: r.gamesPlayed,
    wins: r.wins,
    losses: r.losses,
    benchEnteredAt: r.benchEnteredAt,
    lastGameFinishedAt: r.lastGameFinishedAt,
  }));

  const profileRows = await db.select().from(profiles).where(eq(profiles.organizationId, auth.oid));
  const usersById = new Map(profileRows.map((p) => [p.id, profileRowToUser(p)]));

  const { activeCourts, ghostCourts } = liveBoardFromPlacements(placements, roster, usersById);
  const court = activeCourts.find((c) => c.index === courtIndex);
  if (!court) {
    return NextResponse.json({ error: "court_not_found" }, { status: 400 });
  }

  const uid = (slot: 1 | 2 | 3 | 4) => court.slots.find((s) => s.slot === slot)?.userId ?? null;
  const topLeft = uid(1);
  const topRight = uid(2);
  const botLeft = uid(3);
  const botRight = uid(4);
  if (!topLeft || !topRight || !botLeft || !botRight) {
    return NextResponse.json({ error: "need_four_players" }, { status: 400 });
  }

  const winners: [string, string] =
    winnerSide === "top" ? [topLeft, topRight] : [botLeft, botRight];
  const losers: [string, string] =
    winnerSide === "top" ? [botLeft, botRight] : [topLeft, topRight];

  const winnersUsers = winners.map((id) => usersById.get(id)).filter((u): u is User => Boolean(u));
  const losersUsers = losers.map((id) => usersById.get(id)).filter((u): u is User => Boolean(u));
  if (winnersUsers.length !== 2 || losersUsers.length !== 2) {
    return NextResponse.json({ error: "team_resolve" }, { status: 400 });
  }

  const { winnerDelta, loserDelta } = getMmrDeltas(winnersUsers, losersUsers);
  const now = new Date();

  const { fillSlots, newGhost } = promoteQueueAfterFinish(ghostCourts);
  const fillUserIds = fillSlots.map((s) => s.userId).filter((id): id is string => Boolean(id));

  const newActiveCourts = activeCourts.map((c) =>
    c.index === courtIndex ? { ...c, slots: fillSlots.map((s) => ({ ...s })) } : c,
  );

  const newPlacements = placementsFromLiveBoard(rosterIds, newActiveCourts, newGhost);

  const oldPlacements = await db.select().from(sessionPlacements).where(eq(sessionPlacements.sessionId, sessionId));
  const oldBench = new Set(oldPlacements.filter((p) => p.kind === "bench").map((p) => p.profileId));
  const newBench = new Set(newPlacements.filter((p) => p.kind === "bench").map((p) => p.profileId));

  await db.transaction(async (tx) => {
    for (const id of winners) {
      const row = rosterDb.find((r) => r.profileId === id);
      if (!row) continue;
      await tx
        .update(sessionRoster)
        .set({
          gamesPlayed: row.gamesPlayed + 1,
          wins: row.wins + 1,
          lastGameFinishedAt: now,
          benchEnteredAt: now,
        })
        .where(and(eq(sessionRoster.sessionId, sessionId), eq(sessionRoster.profileId, id)));
    }
    for (const id of losers) {
      const row = rosterDb.find((r) => r.profileId === id);
      if (!row) continue;
      await tx
        .update(sessionRoster)
        .set({
          gamesPlayed: row.gamesPlayed + 1,
          losses: row.losses + 1,
          lastGameFinishedAt: now,
          benchEnteredAt: now,
        })
        .where(and(eq(sessionRoster.sessionId, sessionId), eq(sessionRoster.profileId, id)));
    }

    for (const pid of fillUserIds) {
      await tx
        .update(sessionRoster)
        .set({ benchEnteredAt: null })
        .where(and(eq(sessionRoster.sessionId, sessionId), eq(sessionRoster.profileId, pid)));
    }

    for (const pid of rosterIds) {
      if (newBench.has(pid) && !oldBench.has(pid) && !fillUserIds.includes(pid)) {
        await tx
          .update(sessionRoster)
          .set({ benchEnteredAt: now })
          .where(and(eq(sessionRoster.sessionId, sessionId), eq(sessionRoster.profileId, pid)));
      }
    }

    for (const id of winners) {
      const u = usersById.get(id);
      if (!u) continue;
      await tx
        .update(profiles)
        .set({ mmr: clampMmr(u.mmr + winnerDelta), updatedAt: now })
        .where(eq(profiles.id, id));
    }
    for (const id of losers) {
      const u = usersById.get(id);
      if (!u) continue;
      await tx
        .update(profiles)
        .set({ mmr: clampMmr(u.mmr + loserDelta), updatedAt: now })
        .where(eq(profiles.id, id));
    }

    await tx.insert(matchResults).values({
      sessionId,
      activeCourtIndex: courtIndex,
      winnerSide,
      winnerScore,
      loserScore,
      slot1ProfileId: topLeft,
      slot2ProfileId: topRight,
      slot3ProfileId: botLeft,
      slot4ProfileId: botRight,
    });

    await tx.delete(sessionPlacements).where(eq(sessionPlacements.sessionId, sessionId));
    await tx.insert(sessionPlacements).values(
      newPlacements.map((r) => ({
        sessionId,
        profileId: r.profileId,
        kind: r.kind,
        courtIndex: r.courtIndex,
        slotNumber: r.slotNumber,
      })),
    );
  });

  return NextResponse.json({ ok: true });
}
