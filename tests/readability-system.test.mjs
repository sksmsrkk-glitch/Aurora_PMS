/** Source-contract guard for the final, highest-priority PMS readability layer. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const globals = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const css = await readFile(new URL("../app/styles/readability-system.css", import.meta.url), "utf8");

test("the readability contract is the final PMS stylesheet", () => {
  const imports = [...globals.matchAll(/@import\s+"([^"]+)"/gu)].map((match) => match[1]);
  assert.equal(imports.at(-1), "./styles/readability-system.css");
});

test("operational type and pointer tokens keep their documented minimums", () => {
  assert.match(css, /--aurora-type-caption:\s*0\.75rem/u);
  assert.match(css, /--aurora-type-body:\s*0\.875rem/u);
  assert.match(css, /--aurora-target:\s*2\.75rem/u);
  assert.match(css, /--aurora-readable-measure:\s*66ch/u);

  // Numeric declarations in this authoritative layer may never reintroduce
  // the 5–11px text that made legacy operational data unreadable.
  const sizes = [...css.matchAll(/font-size:\s*([0-9.]+)(px|rem)/gu)].map((match) =>
    match[2] === "rem" ? Number(match[1]) * 16 : Number(match[1]),
  );
  assert.ok(sizes.length > 10);
  assert.ok(sizes.every((size) => size >= 12), `sub-12px declaration: ${Math.min(...sizes)}px`);
});

test("mobile queues expose hidden reservation columns as labelled cards", () => {
  assert.match(css, /@media \(max-width: 760px\)/u);
  assert.match(css, /\.reservation-table \.table-row/u);
  assert.match(css, /content:\s*"투숙 일정"/u);
  assert.match(css, /content:\s*"예약 경로"/u);
  assert.match(css, /env\(safe-area-inset-bottom\)/u);
  assert.match(css, /prefers-reduced-motion:\s*reduce/u);
});
