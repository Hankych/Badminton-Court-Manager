import { and, eq, ne } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { matchResults, profiles } from "@/db/schema";
import { getSessionFromCookies } from "@/lib/auth/get-session";
import { hashPassword } from "@/lib/auth/password";

function splitDisplayName(name: string): { firstName: string; lastName: string } {
  const trimmed = name.trim();
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "Player", lastName: "Player" };
  if (parts.length === 1) return { firstName: parts[0]!, lastName: parts[0]! };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(" ") };
}

type Ctx = { params: Promise<{ profileId: string }> };

export async function PATCH(request: Request, ctx: Ctx) {
  const auth = await getSessionFromCookies();
  if (!auth || auth.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "database_not_configured" }, { status: 503 });
  }
  const { profileId } = await ctx.params;

  const [existing] = await db
    .select()
    .from(profiles)
    .where(and(eq(profiles.id, profileId), eq(profiles.organizationId, auth.oid)))
    .limit(1);
  if (!existing) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let body: { name?: string; mmr?: number; username?: string; password?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const patch: {
    firstName?: string;
    lastName?: string;
    mmr?: number;
    username?: string;
    passwordHash?: string;
    updatedAt: Date;
  } = { updatedAt: new Date() };
  if (body.name !== undefined) {
    const { firstName, lastName } = splitDisplayName(String(body.name));
    patch.firstName = firstName;
    patch.lastName = lastName;
  }
  if (typeof body.mmr === "number" && Number.isFinite(body.mmr)) {
    patch.mmr = body.mmr;
  }
  if (typeof body.username === "string" && body.username.trim()) {
    patch.username = body.username.trim();
  }
  if (body.password !== undefined && body.password !== null && body.password !== "") {
    patch.passwordHash = await hashPassword(body.password);
  }

  const hasChange =
    patch.firstName !== undefined ||
    patch.mmr !== undefined ||
    patch.username !== undefined ||
    patch.passwordHash !== undefined;
  if (!hasChange) {
    return NextResponse.json({ error: "nothing_to_update" }, { status: 400 });
  }

  try {
    if (patch.username) {
      const [collision] = await db
        .select({ id: profiles.id })
        .from(profiles)
        .where(
          and(
            eq(profiles.organizationId, auth.oid),
            eq(profiles.username, patch.username),
            ne(profiles.id, profileId),
          ),
        )
        .limit(1);
      if (collision) {
        return NextResponse.json({ error: "username_taken" }, { status: 409 });
      }
    }

    await db
      .update(profiles)
      .set(patch)
      .where(eq(profiles.id, profileId));
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "update_failed" }, { status: 409 });
  }
}

export async function DELETE(_request: Request, ctx: Ctx) {
  const auth = await getSessionFromCookies();
  if (!auth || auth.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "database_not_configured" }, { status: 503 });
  }
  const { profileId } = await ctx.params;

  if (profileId === auth.sub) {
    return NextResponse.json({ error: "cannot_delete_self" }, { status: 400 });
  }

  const [existing] = await db
    .select()
    .from(profiles)
    .where(and(eq(profiles.id, profileId), eq(profiles.organizationId, auth.oid)))
    .limit(1);
  if (!existing) {
    return NextResponse.json({ ok: true });
  }
  if (existing.role === "admin") {
    return NextResponse.json({ error: "cannot_delete_admin" }, { status: 400 });
  }

  try {
    await db.transaction(async (tx) => {
      await tx
        .update(matchResults)
        .set({ slot1ProfileId: null })
        .where(eq(matchResults.slot1ProfileId, profileId));
      await tx
        .update(matchResults)
        .set({ slot2ProfileId: null })
        .where(eq(matchResults.slot2ProfileId, profileId));
      await tx
        .update(matchResults)
        .set({ slot3ProfileId: null })
        .where(eq(matchResults.slot3ProfileId, profileId));
      await tx
        .update(matchResults)
        .set({ slot4ProfileId: null })
        .where(eq(matchResults.slot4ProfileId, profileId));
      await tx.delete(profiles).where(eq(profiles.id, profileId));
    });
  } catch (e) {
    console.error("DELETE profile", profileId, e);
    return NextResponse.json({ error: "delete_failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
