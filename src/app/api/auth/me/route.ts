import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { profiles } from "@/db/schema";
import { getSessionFromCookies } from "@/lib/auth/get-session";
import { profileRowToUser } from "@/lib/club/profile-map";

export async function GET() {
  const session = await getSessionFromCookies();
  if (!session) {
    return NextResponse.json(null, { status: 401 });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "database_not_configured" }, { status: 503 });
  }
  const [prof] = await db.select().from(profiles).where(eq(profiles.id, session.sub)).limit(1);
  if (!prof) {
    return NextResponse.json(null, { status: 401 });
  }

  return NextResponse.json({
    user: profileRowToUser(prof),
    username: prof.username,
    role: prof.role,
  });
}
