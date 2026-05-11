import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { clubSessions, profiles, sessionPlacements, sessionRoster } from "@/db/schema";
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

/** Add or remove rostered players while the session is live (bench placement for new joins). */
export async function PATCH(request: Request, ctx: Ctx) {
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

  let body: { add?: string[]; remove?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const addIds = [...new Set(body.add ?? [])];
  const removeIds = [...new Set(body.remove ?? [])];
  if (addIds.length === 0 && removeIds.length === 0) {
    return NextResponse.json({ ok: true, added: 0, removed: 0 });
  }

  const orgPlayers = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(and(eq(profiles.organizationId, auth.oid), eq(profiles.role, "player")));
  const allowed = new Set(orgPlayers.map((p) => p.id));
  for (const id of [...addIds, ...removeIds]) {
    if (!allowed.has(id)) {
      return NextResponse.json({ error: "invalid_roster_id", id }, { status: 400 });
    }
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    for (const profileId of removeIds) {
      await tx
        .delete(sessionPlacements)
        .where(and(eq(sessionPlacements.sessionId, sessionId), eq(sessionPlacements.profileId, profileId)));
      await tx
        .delete(sessionRoster)
        .where(and(eq(sessionRoster.sessionId, sessionId), eq(sessionRoster.profileId, profileId)));
    }
    for (const profileId of addIds) {
      const [existing] = await tx
        .select({ profileId: sessionRoster.profileId })
        .from(sessionRoster)
        .where(and(eq(sessionRoster.sessionId, sessionId), eq(sessionRoster.profileId, profileId)))
        .limit(1);
      if (existing) continue;
      await tx.insert(sessionRoster).values({
        sessionId,
        profileId,
        benchEnteredAt: now,
      });
      await tx.insert(sessionPlacements).values({
        sessionId,
        profileId,
        kind: "bench",
        courtIndex: null,
        slotNumber: null,
      });
    }
  });

  return NextResponse.json({ ok: true });
}
