/** Behavioral checks for the release/runtime schema contract. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import {
  PmsSchemaNotReadyError,
  REQUIRED_SCHEMA_VERSION,
  REQUIRED_TENANT_POLICY_COUNT,
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

test("authenticated search QA follows the shared runtime schema contract", async () => {
  const qaSource = await readFile(
    new URL("../scripts/qa-search-ui.mjs", import.meta.url),
    "utf8",
  );
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.match(
    qaSource,
    /import\s*\{\s*REQUIRED_SCHEMA_VERSION\s*\}\s*from\s*["']\.\.\/db\/schema-contract\.ts["']/u,
  );
  assert.match(
    qaSource,
    /body\.schemaVersion\s*===\s*REQUIRED_SCHEMA_VERSION/u,
  );
  assert.doesNotMatch(
    qaSource,
    /body\.schemaVersion\s*===\s*["']\d{12,}_[^"']+["']/u,
  );
  assert.equal(
    packageJson.scripts["qa:search-ui"],
    "node --import tsx scripts/qa-search-ui.mjs",
  );
});

test("runtime contract accepts the hardened migration and tenant role", async () => {
  await assert.doesNotReject(
    verifyPmsSchemaContract(contractDatabase({
      migration_ready: true,
      role_ready: true,
      role_member: true,
      policy_count: REQUIRED_TENANT_POLICY_COUNT,
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
