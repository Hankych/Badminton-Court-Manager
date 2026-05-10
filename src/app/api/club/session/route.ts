import { and, desc, eq, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { clubSessions } from "@/db/schema";
import { getSessionFromCookies } from "@/lib/auth/get-session";

export async function POST() {
  const auth = await getSessionFromCookies();
  if (!auth || auth.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "database_not_configured" }, { status: 503 });
  }

  const [existing] = await db
    .select()
    .from(clubSessions)
    .where(
      and(
        eq(clubSessions.organizationId, auth.oid),
        or(eq(clubSessions.status, "draft"), eq(clubSessions.status, "active")),
      ),
    )
    .orderBy(desc(clubSessions.startedAt))
    .limit(1);

  if (existing) {
    return NextResponse.json({ error: "session_already_open", clubSessionId: existing.id }, { status: 409 });
  }

  const [row] = await db
    .insert(clubSessions)
    .values({
      organizationId: auth.oid,
      startedByAdminId: auth.sub,
      status: "draft",
    })
    .returning();

  return NextResponse.json({ clubSessionId: row.id });
}
