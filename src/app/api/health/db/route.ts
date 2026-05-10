import { neon } from "@neondatabase/serverless";
import { NextResponse } from "next/server";

/** Smoke-test Neon connectivity (requires DATABASE_URL). No auth. */
export async function GET() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    return NextResponse.json({ ok: false, db: "not_configured", hint: "Set DATABASE_URL for Neon." }, { status: 200 });
  }
  try {
    const sql = neon(url);
    await sql`SELECT 1`;
    return NextResponse.json({ ok: true, db: "neon" });
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown_error";
    return NextResponse.json({ ok: false, db: "error", message }, { status: 500 });
  }
}
