import { eq, and } from "drizzle-orm";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/db";
import { organizations, profiles } from "@/db/schema";
import { verifyPassword } from "@/lib/auth/password";
import { SESSION_COOKIE_NAME, signSessionToken } from "@/lib/auth/session-token";
import { DEFAULT_ORG_SLUG } from "@/lib/club/constants";
import { profileRowToUser } from "@/lib/club/profile-map";

export async function POST(request: Request) {
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "database_not_configured" }, { status: 503 });
  }

  let body: { username?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const username = body.username?.trim();
  const password = body.password;
  if (!username || !password) {
    return NextResponse.json({ error: "missing_credentials" }, { status: 400 });
  }

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.slug, DEFAULT_ORG_SLUG))
    .limit(1);

  if (!org) {
    return NextResponse.json({ error: "org_not_seeded" }, { status: 500 });
  }

  const [prof] = await db
    .select()
    .from(profiles)
    .where(and(eq(profiles.organizationId, org.id), eq(profiles.username, username)))
    .limit(1);

  if (!prof) {
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  const ok = await verifyPassword(password, prof.passwordHash);
  if (!ok) {
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  const token = await signSessionToken({
    sub: prof.id,
    oid: org.id,
    role: prof.role === "admin" ? "admin" : "player",
  });

  const jar = await cookies();
  jar.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });

  return NextResponse.json({
    user: profileRowToUser(prof),
    username: prof.username,
    role: prof.role,
  });
}
