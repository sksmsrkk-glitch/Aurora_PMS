/** Behavioral tests for PostgreSQL parameter compilation at the DB boundary. */
import test from "node:test";
import assert from "node:assert/strict";
import { compilePostgresParameters } from "../db/postgres-parameters.mjs";

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
