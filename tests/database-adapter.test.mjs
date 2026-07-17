/** Behavioral tests for PostgreSQL parameter compilation at the DB boundary. */
import test from "node:test";
import assert from "node:assert/strict";
import { compilePostgresParameters } from "../db/postgres-parameters.mjs";
import { assertSystemOnlyRootQuery } from "../db/pms-database.ts";

test("positional parameters ignore SQL literals, identifiers, and comments",()=>{
  const input=`SELECT '?', "?", ? AS value -- ?\n/* ? */ WHERE note=$tag$?$tag$ AND id=?`;
  assert.equal(
    compilePostgresParameters(input,2),
    `SELECT '?', "?", $1 AS value -- ?\n/* ? */ WHERE note=$tag$?$tag$ AND id=$2`,
  );
});

test("parameter compiler rejects bind count mismatches and unterminated SQL",()=>{
  assert.throws(()=>compilePostgresParameters("SELECT ?",0),/parameter mismatch/u);
  assert.throws(()=>compilePostgresParameters("SELECT 'unterminated",0),/unterminated/iu);
});

test("root query boundary rejects every tenant table including role assignments",()=>{
  assert.throws(
    ()=>assertSystemOnlyRootQuery("SELECT property_id,role FROM role_assignments WHERE email=? AND active OR true"),
    /dedicated root capability/iu,
  );
  assert.throws(
    ()=>assertSystemOnlyRootQuery("WITH exposed AS (SELECT * FROM reservations) SELECT * FROM exposed"),
    /scopePmsDatabase/iu,
  );
  assert.doesNotThrow(
    ()=>assertSystemOnlyRootQuery("SELECT rolname FROM pg_roles WHERE rolname=?"),
  );
});
