import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

/** Next uses `.env.local`; Drizzle CLI does not load it unless we do this. */
config({ path: ".env.local" });
config({ path: ".env" });

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
