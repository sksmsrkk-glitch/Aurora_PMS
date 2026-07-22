import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { config, proxy } from "../proxy.ts";

function request(path, host) {
  return new NextRequest(`https://platform.example${path}`, {
    headers: { host },
  });
}

test("Next 16 proxy matcher covers only public custom-domain entry paths", () => {
  assert.deepEqual(config.matcher, ["/", "/book"]);
});

test("custom domains rewrite root and booking paths to the public hotel app", () => {
  const previous = {
    platformHosts: process.env.AURORA_PLATFORM_HOSTS,
    vercel: process.env.VERCEL,
  };
  try {
    delete process.env.VERCEL;
    process.env.AURORA_PLATFORM_HOSTS = "aurora-pms-gilt.vercel.app";
    const home = proxy(request("/", "hotel.example"));
    const book = proxy(request("/book?from=2026-08-01", "hotel.example"));
    assert.equal(new URL(home.headers.get("x-middleware-rewrite")).pathname, "/hotel");
    const bookDestination = new URL(book.headers.get("x-middleware-rewrite"));
    assert.equal(bookDestination.pathname, "/hotel/book");
    assert.equal(bookDestination.searchParams.get("from"), "2026-08-01");
  } finally {
    if (previous.platformHosts === undefined) delete process.env.AURORA_PLATFORM_HOSTS;
    else process.env.AURORA_PLATFORM_HOSTS = previous.platformHosts;
    if (previous.vercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previous.vercel;
  }
});

test("platform hosts remain on the authenticated PMS root", () => {
  const previous = {
    platformHosts: process.env.AURORA_PLATFORM_HOSTS,
    vercel: process.env.VERCEL,
  };
  try {
    delete process.env.VERCEL;
    process.env.AURORA_PLATFORM_HOSTS = "aurora-pms-gilt.vercel.app";
    const response = proxy(request("/", "aurora-pms-gilt.vercel.app"));
    assert.equal(response.headers.get("x-middleware-next"), "1");
    assert.equal(response.headers.get("x-middleware-rewrite"), null);
  } finally {
    if (previous.platformHosts === undefined) delete process.env.AURORA_PLATFORM_HOSTS;
    else process.env.AURORA_PLATFORM_HOSTS = previous.platformHosts;
    if (previous.vercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previous.vercel;
  }
});
