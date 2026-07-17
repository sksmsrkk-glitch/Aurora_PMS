/** Prevent PostgreSQL boolean columns from regressing to legacy SQLite `= 1/0` comparisons. */
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const booleanColumns = [
  "active", "close_to_arrival", "close_to_departure", "closed",
  "deduct_inventory", "published", "website_closed",
];

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const target = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.(?:ts|tsx|js|mjs)$/u.test(entry.name) ? [target] : [];
  }));
  return nested.flat();
}

test("runtime queries never compare native booleans with integer literals", async () => {
  const files = (await Promise.all([
    sourceFiles(new URL("app/", root)),
    sourceFiles(new URL("db/", root)),
    sourceFiles(new URL("lib/", root)),
  ])).flat();
  const violations = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const column of booleanColumns) {
      const patterns = [
        new RegExp(`(?:\\b[A-Za-z_][A-Za-z0-9_]*\\.)?["']?${column}["']?\\s*(?:=|!=|<>)\\s*[01]\\b`, "gu"),
        new RegExp(`\\b[01]\\s*(?:=|!=|<>)\\s*(?:[A-Za-z_][A-Za-z0-9_]*\\.)?["']?${column}["']?\\b`, "gu"),
      ];
      for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) {
          const line = source.slice(0, match.index).split("\n").length;
          violations.push(`${file.pathname}:${line}: ${match[0]}`);
        }
      }
    }
  }
  assert.deepEqual(violations, [], `legacy boolean comparisons:\n${violations.join("\n")}`);
});
