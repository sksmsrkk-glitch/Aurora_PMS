/** Runs PostgreSQL integration tests only against an explicitly named staging project. */
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertStagingDatabaseTarget } from "./staging-db-target.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { databaseUrl } = assertStagingDatabaseTarget();

const testFiles = (await readdir(path.join(root, "tests")))
  .filter((name) => /^postgres-.+\.integration\.mjs$/u.test(name))
  .sort()
  .map((name) => path.join("tests", name));
if (!testFiles.length) throw new Error("No PostgreSQL integration tests found");

const child = spawn(
  process.execPath,
  ["--import", "tsx", "--test", ...testFiles],
  {
    cwd: root,
    env: { ...process.env, TEST_DATABASE_URL: databaseUrl },
    stdio: "inherit",
  },
);
child.on("error", (error) => {
  throw error;
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exitCode = code ?? 1;
});
