import { neonConfig, Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";
import * as schema from "./schema";

/**
 * Neon's Pool uses WebSockets; required in Node (Next API routes default to Node.js).
 * `neon-http` has no `.transaction()` — Pool + neon-serverless does.
 */
neonConfig.webSocketConstructor = ws;

const globalForDb = globalThis as unknown as { neonPool?: Pool };

function getPool(): Pool | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (!globalForDb.neonPool) {
    globalForDb.neonPool = new Pool({ connectionString: url });
  }
  return globalForDb.neonPool;
}

/** Drizzle DB with transaction support (`db.transaction(...)`) via Neon Pool. */
export function getDb() {
  const pool = getPool();
  if (!pool) return null;
  return drizzle(pool, { schema });
}
