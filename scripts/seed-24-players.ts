/**
 * Inserts 24 org player profiles (role=player) if their usernames don’t exist yet.
 *
 * Usage: npx tsx scripts/seed-24-players.ts
 *    or: npm run seed:players24
 *
 * Env: DATABASE_URL (required)
 *      SEED_BULK_PLAYERS_PASSWORD — password for all 24 accounts (required)
 *      Optionally reuse SEED_PLAYER_PASSWORD if SEED_BULK_PLAYERS_PASSWORD is unset.
 */

import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

import { and, eq } from "drizzle-orm";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { hash } from "bcryptjs";

import * as schema from "../src/db/schema";
import { DEFAULT_ORG_SLUG } from "../src/lib/club/constants";

const DATABASE_URL_ENV = process.env.DATABASE_URL;
if (!DATABASE_URL_ENV) {
  console.error("Missing DATABASE_URL");
  process.exit(1);
}
const DATABASE_URL = DATABASE_URL_ENV;

const bulkPass =
  process.env.SEED_BULK_PLAYERS_PASSWORD?.trim() ||
  process.env.SEED_PLAYER_PASSWORD?.trim() ||
  "";
if (!bulkPass) {
  console.error("Set SEED_BULK_PLAYERS_PASSWORD (or SEED_PLAYER_PASSWORD) in .env.local — shared login password for all new players.");
  process.exit(1);
}

/** `first` = given name, `last` = surname → shows as “Emma Chen” in the app. */
const PLAYERS: readonly { u: string; first: string; last: string; mmr: number }[] = [
  { u: "p01", first: "Emma", last: "Chen", mmr: 488 },
  { u: "p02", first: "Jake", last: "Kim", mmr: 512 },
  { u: "p03", first: "Kate", last: "Patel", mmr: 465 },
  { u: "p04", first: "Ryan", last: "Nguyen", mmr: 548 },
  { u: "p05", first: "Alex", last: "Park", mmr: 502 },
  { u: "p06", first: "Sam", last: "Singh", mmr: 476 },
  { u: "p07", first: "Chris", last: "Wang", mmr: 591 },
  { u: "p08", first: "Jordan", last: "Tan", mmr: 529 },
  { u: "p09", first: "Taylor", last: "Li", mmr: 441 },
  { u: "p10", first: "Morgan", last: "Wu", mmr: 556 },
  { u: "p11", first: "Jamie", last: "Zhang", mmr: 518 },
  { u: "p12", first: "Casey", last: "Kumar", mmr: 493 },
  { u: "p13", first: "Drew", last: "Lee", mmr: 462 },
  { u: "p14", first: "Blake", last: "Yamamoto", mmr: 573 },
  { u: "p15", first: "Riley", last: "Gupta", mmr: 508 },
  { u: "p16", first: "Quinn", last: "Huynh", mmr: 535 },
  { u: "p17", first: "Logan", last: "Zhou", mmr: 428 },
  { u: "p18", first: "Noah", last: "Choi", mmr: 598 },
  { u: "p19", first: "Lily", last: "Bose", mmr: 505 },
  { u: "p20", first: "Dylan", last: "Okada", mmr: 547 },
  { u: "p21", first: "Sophia", last: "Rao", mmr: 482 },
  { u: "p22", first: "Matt", last: "Lin", mmr: 521 },
  { u: "p23", first: "Anna", last: "Das", mmr: 456 },
  { u: "p24", first: "Ben", last: "Shah", mmr: 563 },
];

async function main() {
  const sql = neon(DATABASE_URL);
  const db = drizzle(sql, { schema });

  const orgRow = await db
    .select()
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, DEFAULT_ORG_SLUG))
    .limit(1)
    .then((r) => r[0]);

  if (!orgRow) {
    console.error(`No organization with slug "${DEFAULT_ORG_SLUG}". Run scripts/seed.ts first.`);
    process.exit(1);
  }

  const orgId = orgRow.id;
  const passHash = await hash(bulkPass, 10);

  let inserted = 0;
  let skipped = 0;

  for (const row of PLAYERS) {
    const [hit] = await db
      .select()
      .from(schema.profiles)
      .where(and(eq(schema.profiles.organizationId, orgId), eq(schema.profiles.username, row.u)))
      .limit(1);

    if (hit) {
      skipped += 1;
      continue;
    }

    await db.insert(schema.profiles).values({
      organizationId: orgId,
      role: "player",
      username: row.u,
      passwordHash: passHash,
      firstName: row.first,
      lastName: row.last,
      mmr: row.mmr,
    });
    inserted += 1;
  }

  console.log(
    `Seed 24 players complete. Inserted: ${inserted}, skipped (already exist): ${skipped}. Usernames: ${PLAYERS[0]?.u} … ${PLAYERS[23]?.u}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
