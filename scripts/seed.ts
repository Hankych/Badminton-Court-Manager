/**
 * One-time / dev seed: org + admin (+ optional demo players).
 * Usage: npx tsx scripts/seed.ts
 *
 * Env: DATABASE_URL (required), SESSION_SECRET not needed for seed.
 *      SEED_ADMIN_USERNAME (default admin), SEED_ADMIN_PASSWORD (required)
 *      SEED_PLAYER_PASSWORD optional — if set, creates demo players with that password
 */

import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

import { eq } from "drizzle-orm";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { hash } from "bcryptjs";

import * as schema from "../src/db/schema";
import { DEFAULT_ORG_SLUG } from "../src/lib/club/constants";
import { DEFAULT_MMR } from "../src/lib/domain";

const DATABASE_URL_ENV = process.env.DATABASE_URL;
if (!DATABASE_URL_ENV) {
  console.error("Missing DATABASE_URL");
  process.exit(1);
}
/** Non-null after guard above. */
const DATABASE_URL = DATABASE_URL_ENV;

const adminUser = process.env.SEED_ADMIN_USERNAME ?? "admin";
const ADMIN_PASSWORD_ENV = process.env.SEED_ADMIN_PASSWORD;
if (!ADMIN_PASSWORD_ENV) {
  console.error("Set SEED_ADMIN_PASSWORD in .env.local for seed.");
  process.exit(1);
}
const adminPass = ADMIN_PASSWORD_ENV;

const playerPass = process.env.SEED_PLAYER_PASSWORD;

async function main() {
  const sql = neon(DATABASE_URL);
  const db = drizzle(sql, { schema });

  let orgRow = await db
    .select()
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, DEFAULT_ORG_SLUG))
    .limit(1)
    .then((r) => r[0]);

  if (!orgRow) {
    const [inserted] = await db
      .insert(schema.organizations)
      .values({ name: "Origin Club", slug: DEFAULT_ORG_SLUG })
      .returning();
    orgRow = inserted;
  }
  const orgId = orgRow.id;

  const passHash = await hash(adminPass, 10);
  const existingAdmin = await db
    .select()
    .from(schema.profiles)
    .where(eq(schema.profiles.organizationId, orgId))
    .then((rows) => rows.find((p) => p.username === adminUser && p.role === "admin"));

  if (existingAdmin) {
    await db
      .update(schema.profiles)
      .set({ passwordHash: passHash, updatedAt: new Date() })
      .where(eq(schema.profiles.id, existingAdmin.id));
  } else {
    await db.insert(schema.profiles).values({
      organizationId: orgId,
      role: "admin",
      username: adminUser,
      passwordHash: passHash,
      firstName: "Club",
      lastName: "Admin",
      mmr: DEFAULT_MMR,
    });
  }

  if (playerPass) {
    const ph = await hash(playerPass, 10);
    const demo = [
      ["alice", "Alice", "Player", 510],
      ["ben", "Ben", "Player", 550],
      ["chloe", "Chloe", "Player", 480],
      ["derrick", "Derrick", "Player", 620],
    ] as const;
    for (const [uname, first, last, mmr] of demo) {
      const hit = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.organizationId, orgId))
        .then((rows) => rows.find((p) => p.username === uname));
      if (!hit) {
        await db.insert(schema.profiles).values({
          organizationId: orgId,
          role: "player",
          username: uname,
          passwordHash: ph,
          firstName: first,
          lastName: last,
          mmr,
        });
      }
    }
  }

  console.log("Seed complete. Org slug:", DEFAULT_ORG_SLUG, "admin username:", adminUser);
  if (!playerPass) {
    console.log("No SEED_PLAYER_PASSWORD — add players via app (Manage players) or re-run with that env set.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
