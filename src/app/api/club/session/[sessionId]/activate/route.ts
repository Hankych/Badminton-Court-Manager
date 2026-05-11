import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { clubSessions, sessionPlacements, sessionRoster } from "@/db/schema";
import { getSessionFromCookies } from "@/lib/auth/get-session";

type Ctx = { params: Promise<{ sessionId: string }> };

export async function POST(_request: Request, ctx: Ctx) {
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
  if (!cs || cs.status !== "draft") {
    return NextResponse.json({ error: "invalid_session" }, { status: 400 });
  }

  const rosterRows = await db.select().from(sessionRoster).where(eq(sessionRoster.sessionId, sessionId));

  await db.delete(sessionPlacements).where(eq(sessionPlacements.sessionId, sessionId));

  if (rosterRows.length > 0) {
    const now = new Date();
    await db
      .update(sessionRoster)
      .set({ benchEnteredAt: now })
      .where(eq(sessionRoster.sessionId, sessionId));

    await db.insert(sessionPlacements).values(
      rosterRows.map((r) => ({
        sessionId,
        profileId: r.profileId,
        kind: "bench" as const,
        courtIndex: null,
        slotNumber: null,
      })),
    );
  }

  await db
    .update(clubSessions)
    .set({ status: "active" })
    .where(eq(clubSessions.id, sessionId));

  return NextResponse.json({ ok: true });
}
