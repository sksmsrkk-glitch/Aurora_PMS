/** Behavioral checks for the release/runtime schema contract. */
import test from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import {
  PmsSchemaNotReadyError,
  REQUIRED_SCHEMA_VERSION,
  verifyPmsSchemaContract,
} from "../db/schema-contract.ts";

function contractDatabase(row) {
  return {
    prepare() {
      return {
        bind() { return this; },
        first: async () => row,
      };
    },
  };
}

test("runtime contract version matches the latest migration", async () => {
  const migrations = (await readdir(new URL("../supabase/migrations", import.meta.url)))
    .filter((name) => /^\d+_.+\.sql$/u.test(name))
    .sort();
  assert.equal(REQUIRED_SCHEMA_VERSION, migrations.at(-1).replace(/\.sql$/u, ""));
});

test("runtime contract accepts the hardened migration and tenant role", async () => {
  await assert.doesNotReject(
    verifyPmsSchemaContract(contractDatabase({
      migration_ready: true,
      role_ready: true,
      role_member: true,
      policy_count: 49,
    })),
  );
});

test("runtime contract fails closed before tenant queries", async () => {
  await assert.rejects(
    verifyPmsSchemaContract(contractDatabase({
      migration_ready: false,
      role_ready: true,
      role_member: false,
      policy_count: 0,
    })),
    (error) => error instanceof PmsSchemaNotReadyError && error.code === "SCHEMA_NOT_READY",
  );
});
