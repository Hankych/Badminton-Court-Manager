import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { profiles } from "@/db/schema";
import { getSessionFromCookies } from "@/lib/auth/get-session";
import { hashPassword } from "@/lib/auth/password";

function splitDisplayName(name: string): { firstName: string; lastName: string } {
  const trimmed = name.trim();
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "Player", lastName: "Player" };
  if (parts.length === 1) return { firstName: parts[0]!, lastName: parts[0]! };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(" ") };
}

export async function POST(request: Request) {
  const auth = await getSessionFromCookies();
  if (!auth || auth.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "database_not_configured" }, { status: 503 });
  }

  let body: { username?: string; password?: string; name?: string; mmr?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const username = body.username?.trim();
  const password = body.password;
  const displayName = body.name?.trim();
  const mmr = typeof body.mmr === "number" ? body.mmr : Number.NaN;
  if (!username || !password || !displayName || !Number.isFinite(mmr)) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const { firstName, lastName } = splitDisplayName(displayName);
  const passwordHash = await hashPassword(password);

  try {
    const [row] = await db
      .insert(profiles)
      .values({
        organizationId: auth.oid,
        role: "player",
        username,
        passwordHash,
        firstName,
        lastName,
        mmr,
      })
      .returning();

    return NextResponse.json({ ok: true, profileId: row.id });
  } catch {
    return NextResponse.json({ error: "username_taken_or_invalid" }, { status: 409 });
  }
}
