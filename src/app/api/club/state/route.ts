import { and, desc, eq, inArray, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import {
  clubSessions,
  profiles,
  sessionPlacements,
  sessionRoster,
  sessionSnapshots,
  snapshotPlayerStats,
} from "@/db/schema";
import { getSessionFromCookies } from "@/lib/auth/get-session";
import { liveBoardFromPlacements } from "@/lib/club/board-map";
import type { RosterRow } from "@/lib/club/board-map";
import type { PlacementRow } from "@/lib/club/board-map";
import { profileRowToUser } from "@/lib/club/profile-map";
import type { ActiveCourt, GhostCourt, SessionMember, SessionSnapshot, User } from "@/lib/types";
import { emptyActiveCourts, emptyGhostCourts } from "@/lib/club/queue-promotion";

export async function GET() {
  const session = await getSessionFromCookies();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "database_not_configured" }, { status: 503 });
  }

  const profileRows = await db
    .select()
    .from(profiles)
    .where(eq(profiles.organizationId, session.oid));

  const users: User[] = profileRows.map(profileRowToUser);
  const usersById = new Map(users.map((u) => [u.id, u]));

  const me = usersById.get(session.sub);
  if (!me) {
    return NextResponse.json({ error: "profile_missing" }, { status: 403 });
  }

  const [clubRow] = await db
    .select()
    .from(clubSessions)
    .where(
      and(
        eq(clubSessions.organizationId, session.oid),
        or(eq(clubSessions.status, "draft"), eq(clubSessions.status, "active")),
      ),
    )
    .orderBy(desc(clubSessions.startedAt))
    .limit(1);

  let activeCourts: ActiveCourt[] = emptyActiveCourts();
  let ghostCourts: GhostCourt[] = emptyGhostCourts();
  let sessionMembers: SessionMember[] = [];
  let clubSession: {
    id: string;
    status: string;
    rosterProfileIds: string[];
  } | null = null;

  if (clubRow) {
    const rosterDb = await db
      .select()
      .from(sessionRoster)
      .where(eq(sessionRoster.sessionId, clubRow.id));

    const rosterProfileIds = rosterDb.map((r) => r.profileId);
    clubSession = { id: clubRow.id, status: clubRow.status, rosterProfileIds };

    const roster: RosterRow[] = rosterDb.map((r) => ({
      profileId: r.profileId,
      joinedAt: r.joinedAt ?? new Date(),
      gamesPlayed: r.gamesPlayed,
      wins: r.wins,
      losses: r.losses,
      benchEnteredAt: r.benchEnteredAt,
      lastGameFinishedAt: r.lastGameFinishedAt,
    }));

    const placeRows = await db
      .select()
      .from(sessionPlacements)
      .where(eq(sessionPlacements.sessionId, clubRow.id));

    const placements: PlacementRow[] = placeRows.map((p) => ({
      profileId: p.profileId,
      kind: p.kind as PlacementRow["kind"],
      courtIndex: p.courtIndex,
      slotNumber: p.slotNumber,
    }));

    const mapped = liveBoardFromPlacements(placements, roster, usersById);
    activeCourts = mapped.activeCourts;
    ghostCourts = mapped.ghostCourts;
    sessionMembers = mapped.sessionMembers;
  }

  const snaps = await db
    .select()
    .from(sessionSnapshots)
    .where(eq(sessionSnapshots.organizationId, session.oid))
    .orderBy(desc(sessionSnapshots.createdAt));

  const snapshotIds = snaps.map((s) => s.id);
  let statsBySnap = new Map<string, { userId: string; matchesPlayed: number; wins: number; losses: number }[]>();
  if (snapshotIds.length > 0) {
    const statsRows = await db
      .select()
      .from(snapshotPlayerStats)
      .where(inArray(snapshotPlayerStats.snapshotId, snapshotIds));
    for (const st of statsRows) {
      const list = statsBySnap.get(st.snapshotId) ?? [];
      list.push({
        userId: st.profileId,
        matchesPlayed: st.matchesPlayed,
        wins: st.wins,
        losses: st.losses,
      });
      statsBySnap.set(st.snapshotId, list);
    }
  }

  const snapshots: SessionSnapshot[] = snaps.map((s) => ({
    id: s.id,
    snapshotName: s.snapshotName,
    snapshotDate: typeof s.snapshotDate === "string" ? s.snapshotDate : String(s.snapshotDate).slice(0, 10),
    createdAt: s.createdAt?.getTime() ?? Date.now(),
    stats: statsBySnap.get(s.id) ?? [],
  }));

  return NextResponse.json({
    me,
    username: profileRows.find((p) => p.id === session.sub)?.username ?? "",
    role: session.role,
    users,
    clubSession,
    activeCourts,
    ghostCourts,
    sessionMembers,
    snapshots,
  });
}
