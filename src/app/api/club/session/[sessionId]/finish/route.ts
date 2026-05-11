import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import {
  clubSessions,
  sessionPlacements,
  sessionRoster,
  sessionSnapshots,
  snapshotPlayerStats,
} from "@/db/schema";
import { getSessionFromCookies } from "@/lib/auth/get-session";

const ORG_NAME = "Origin";

type Ctx = { params: Promise<{ sessionId: string }> };

function serverDateLabel(): string {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

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

  const roster = await db.select().from(sessionRoster).where(eq(sessionRoster.sessionId, sessionId));

  let body: { snapshotDate?: string } = {};
  try {
    body = (await request.json()) as { snapshotDate?: string };
  } catch {
    body = {};
  }
  const browserDate = typeof body.snapshotDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.snapshotDate)
    ? body.snapshotDate
    : null;
  const dateLabel = browserDate ?? serverDateLabel();
  const baseName = `${ORG_NAME}_${dateLabel}`;
  const sameDay = await db
    .select()
    .from(sessionSnapshots)
    .where(and(eq(sessionSnapshots.organizationId, auth.oid), eq(sessionSnapshots.snapshotDate, dateLabel)));
  const snapshotName = sameDay.length === 0 ? baseName : `${baseName}_${sameDay.length + 1}`;

  /** Snapshot + tear down roster/placements; session ended (nothing left “on bench”). */
  await db.transaction(async (tx) => {
    const [snap] = await tx
      .insert(sessionSnapshots)
      .values({
        clubSessionId: sessionId,
        organizationId: auth.oid,
        snapshotName,
        snapshotDate: dateLabel,
      })
      .returning();

    if (!snap) throw new Error("snapshot_insert");

    if (roster.length > 0) {
      for (const r of roster) {
        await tx.insert(snapshotPlayerStats).values({
          snapshotId: snap.id,
          profileId: r.profileId,
          matchesPlayed: r.gamesPlayed,
          wins: r.wins,
          losses: r.losses,
        });
      }
    }

    await tx
      .update(clubSessions)
      .set({ status: "ended", endedAt: new Date() })
      .where(eq(clubSessions.id, sessionId));

    await tx.delete(sessionPlacements).where(eq(sessionPlacements.sessionId, sessionId));
    await tx.delete(sessionRoster).where(eq(sessionRoster.sessionId, sessionId));
  });

  return NextResponse.json({ ok: true, snapshotName });
}
