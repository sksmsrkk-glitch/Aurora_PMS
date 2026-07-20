/** Product-brand contract: user-facing Talos identity without retained BI/CI assets. */
import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const footer = await readFile(new URL("../app/company-footer.tsx", import.meta.url), "utf8");
const footerCss = await readFile(new URL("../app/company-footer.css", import.meta.url), "utf8");
const shell = await readFile(new URL("../app/(pms)/_components/pms-shell.tsx", import.meta.url), "utf8");
const login = await readFile(new URL("../app/(pms)/login/page.tsx", import.meta.url), "utf8");

test("Talos wordmarks use the shared black text-only contract", () => {
  assert.match(footerCss, /\.talos-wordmark\s*\{[^}]*color:\s*#191f28\s*!important/isu);
  assert.match(shell, /className="talos-wordmark">TALOS PMS</u);
  assert.match(login, /className="talos-wordmark">TALOS PMS</u);
  assert.doesNotMatch(`${shell}\n${login}`, /aurora-mark|<Image/iu);
});

test("the shared footer contains the complete Allmytour legal identity", () => {
  for (const value of [
    "주식회사 올마이투어",
    "대표이사 석영규 · 정현일",
    "서울특별시 종로구 창경궁로 112-7 1101",
    "1688-8376",
    "talos@allmytour.com",
  ]) assert.match(footer, new RegExp(value, "u"));
});

test("legacy Aurora image BI/CI files are absent", async () => {
  for (const relativePath of [
    "../public/brand/aurora-mark-64.png",
    "../public/brand/aurora-mark-192.png",
    "../public/brand/aurora-mark-512.png",
    "../public/og.png",
    "../public/favicon.svg",
  ]) await assert.rejects(access(new URL(relativePath, import.meta.url)));
});
