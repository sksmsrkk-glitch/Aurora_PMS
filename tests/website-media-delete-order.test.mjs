/** Verifies the CMS delete saga around an unreliable external object store. */
import test from "node:test";
import assert from "node:assert/strict";
import { handleExtendedAction } from "../app/api/pms/extended.ts";

function fakeDatabase() {
  const batches = [];
  return {
    batches,
    prepare(query) {
      return {
        query,
        values: [],
        bind(...values) { this.values = values; return this; },
        async first() {
          if (query.startsWith("SELECT * FROM website_media")) return { id:"media-1", object_path:"prop-seoul/test.webp", public_url:"https://cdn.test/test.webp", active:true };
          return null;
        },
      };
    },
    async batch(statements) { batches.push(statements); return statements.map(()=>({results:[],success:true})); },
  };
}

test("website media is hidden in DB before Storage deletion and hard-delete", async () => {
  const originalFetch=globalThis.fetch,originalUrl=process.env.SUPABASE_URL,originalKey=process.env.SUPABASE_SECRET_KEY;
  process.env.SUPABASE_URL="https://storage.test";
  process.env.SUPABASE_SECRET_KEY="test-secret";
  try {
    const failing=fakeDatabase();
    globalThis.fetch=async()=>new Response("provider unavailable",{status:503});
    await assert.rejects(()=>handleExtendedAction(failing,{action:"delete_website_media",mediaId:"media-1"},{email:"qa@aurora.test",capabilities:["ADMIN"],propertyId:"prop-seoul"},"2026-07-17","2026-07-17T00:00:00.000Z","delete-failure"));
    assert.equal(failing.batches.length,1,"Storage failure must stop before hard-delete");
    assert.match(failing.batches[0][0].query,/UPDATE website_media SET active=false/u);
    assert.equal(failing.batches[0].some(statement=>/^DELETE FROM website_media/u.test(statement.query)),false);

    const successful=fakeDatabase();
    globalThis.fetch=async()=>new Response(null,{status:200});
    await handleExtendedAction(successful,{action:"delete_website_media",mediaId:"media-1"},{email:"qa@aurora.test",capabilities:["ADMIN"],propertyId:"prop-seoul"},"2026-07-17","2026-07-17T00:00:00.000Z","delete-success");
    assert.equal(successful.batches.length,2);
    assert.match(successful.batches[1][0].query,/DELETE FROM website_media.+NOT active/u);
  } finally {
    globalThis.fetch=originalFetch;
    if(originalUrl===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=originalUrl;
    if(originalKey===undefined)delete process.env.SUPABASE_SECRET_KEY;else process.env.SUPABASE_SECRET_KEY=originalKey;
  }
});
