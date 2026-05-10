import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { clubSessions, sessionPlacements, sessionRoster } from "@/db/schema";
import { getSessionFromCookies } from "@/lib/auth/get-session";

type Ctx = { params: Promise<{ sessionId: string }> };

/** End active session immediately without a snapshot (no history row). Profiles are unchanged. */
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
  if (!cs || cs.status !== "active") {
    return NextResponse.json({ error: "invalid_session" }, { status: 400 });
  }

  await db.transaction(async (tx) => {
    await tx
      .update(clubSessions)
      .set({ status: "ended", endedAt: new Date() })
      .where(eq(clubSessions.id, sessionId));

    await tx.delete(sessionPlacements).where(eq(sessionPlacements.sessionId, sessionId));
    await tx.delete(sessionRoster).where(eq(sessionRoster.sessionId, sessionId));
  });

  return NextResponse.json({ ok: true });
}
