/** Verifies source-level schema version synchronization without contacting DB. */
import { readdir } from "node:fs/promises";
import { REQUIRED_SCHEMA_VERSION } from "../db/schema-contract.ts";

const migrations = (await readdir(new URL("../supabase/migrations/", import.meta.url)))
  .filter((name) => /^\d+_.+\.sql$/u.test(name))
  .sort();
const latest = migrations.at(-1)?.replace(/\.sql$/u, "");
if (!latest || latest !== REQUIRED_SCHEMA_VERSION) {
  throw new Error(
    `Static schema contract mismatch: runtime=${REQUIRED_SCHEMA_VERSION}, latest=${latest || "missing"}`,
  );
}
console.log(`Static schema contract passed: ${REQUIRED_SCHEMA_VERSION}`);
