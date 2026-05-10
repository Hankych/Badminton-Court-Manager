import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { clubSessions, sessionPlacements, sessionRoster } from "@/db/schema";
import { getSessionFromCookies } from "@/lib/auth/get-session";
import { assertCourtShape, placementsFromLiveBoard } from "@/lib/club/board-map";
import type { ActiveCourt, GhostCourt } from "@/lib/types";

type Ctx = { params: Promise<{ sessionId: string }> };

export async function PUT(request: Request, ctx: Ctx) {
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

  let body: { activeCourts?: ActiveCourt[]; ghostCourts?: GhostCourt[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.activeCourts || !body.ghostCourts) {
    return NextResponse.json({ error: "missing_board" }, { status: 400 });
  }
  try {
    assertCourtShape(body.activeCourts, body.ghostCourts);
  } catch {
    return NextResponse.json({ error: "invalid_court_shape" }, { status: 400 });
  }

  const rosterRows = await db.select().from(sessionRoster).where(eq(sessionRoster.sessionId, sessionId));
  const rosterIds = rosterRows.map((r) => r.profileId);

  const oldPlacements = await db.select().from(sessionPlacements).where(eq(sessionPlacements.sessionId, sessionId));
  const oldBench = new Set(oldPlacements.filter((p) => p.kind === "bench").map((p) => p.profileId));

  const newRows = placementsFromLiveBoard(rosterIds, body.activeCourts, body.ghostCourts);
  const newBench = new Set(newRows.filter((p) => p.kind === "bench").map((p) => p.profileId));

  const now = new Date();

  await db.transaction(async (tx) => {
    for (const pid of rosterIds) {
      if (newBench.has(pid) && !oldBench.has(pid)) {
        await tx
          .update(sessionRoster)
          .set({ benchEnteredAt: now })
          .where(and(eq(sessionRoster.sessionId, sessionId), eq(sessionRoster.profileId, pid)));
      }
    }

    await tx.delete(sessionPlacements).where(eq(sessionPlacements.sessionId, sessionId));

    if (newRows.length) {
      await tx.insert(sessionPlacements).values(
        newRows.map((r) => ({
          sessionId,
          profileId: r.profileId,
          kind: r.kind,
          courtIndex: r.courtIndex,
          slotNumber: r.slotNumber,
        })),
      );
    }
  });

  return NextResponse.json({ ok: true });
}
