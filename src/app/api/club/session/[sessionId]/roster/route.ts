import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { clubSessions, profiles, sessionRoster } from "@/db/schema";
import { getSessionFromCookies } from "@/lib/auth/get-session";

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
  if (!cs || cs.status !== "draft") {
    return NextResponse.json({ error: "invalid_session" }, { status: 400 });
  }

  let body: { profileIds?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const ids = body.profileIds ?? [];
  const unique = [...new Set(ids)];

  const orgPlayers = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(and(eq(profiles.organizationId, auth.oid), eq(profiles.role, "player")));
  const allowed = new Set(orgPlayers.map((p) => p.id));
  for (const id of unique) {
    if (!allowed.has(id)) {
      return NextResponse.json({ error: "invalid_roster_id", id }, { status: 400 });
    }
  }

  await db.delete(sessionRoster).where(eq(sessionRoster.sessionId, sessionId));

  if (unique.length) {
    await db.insert(sessionRoster).values(
      unique.map((profileId) => ({
        sessionId,
        profileId,
      })),
    );
  }

  return NextResponse.json({ ok: true, count: unique.length });
}
