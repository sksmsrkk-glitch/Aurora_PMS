import { readFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

function parseEnv(contents) {
  const values={};
  for(const line of contents.split(/\r?\n/u)){
    const trimmed=line.trim();if(!trimmed||trimmed.startsWith("#"))continue;
    const separator=trimmed.indexOf("=");if(separator<1)continue;
    let value=trimmed.slice(separator+1).trim();
    if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);
    values[trimmed.slice(0,separator).trim()]=value;
  }
  return values;
}

const env=parseEnv(await readFile(path.join(process.cwd(),".env.local"),"utf8"));
for(const key of ["DIRECT_URL","SUPABASE_URL","SUPABASE_SECRET_KEY"])if(!env[key])throw new Error(`${key} is required`);

const sql=postgres(env.DIRECT_URL,{max:1,prepare:false,ssl:"require",connect_timeout:15,idle_timeout:5});
try{
  const [catalog]=await sql`
    SELECT
      (SELECT COUNT(*)::int FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE') tables,
      (SELECT COUNT(*)::int FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND relrowsecurity) rls_tables,
      (SELECT COUNT(*)::int FROM pg_trigger WHERE NOT tgisinternal) triggers,
      (SELECT COUNT(*)::int FROM pms_schema_migrations) migrations
  `;
  if(catalog.tables<39||catalog.rls_tables<39||catalog.triggers<25||catalog.migrations<3)throw new Error("Supabase catalog verification failed");

  let capacityGuard=false;
  try{
    await sql.begin(async transaction=>{
      await transaction`INSERT INTO reservation_type_nights(property_id,reservation_id,room_type_id,stay_date) VALUES ('prop-seoul','smoke-capacity-1','rt-dlx','2026-07-16')`;
      await transaction`INSERT INTO reservation_type_nights(property_id,reservation_id,room_type_id,stay_date) VALUES ('prop-seoul','smoke-capacity-2','rt-dlx','2026-07-16')`;
    });
  }catch(error){capacityGuard=error instanceof Error&&error.message.includes("room type sold out");}
  if(!capacityGuard)throw new Error("Inventory capacity trigger verification failed");

  let immutableGuard=false;
  try{await sql`UPDATE folio_entries SET description='smoke' WHERE id='fe1'`;}catch(error){immutableGuard=error instanceof Error&&error.message.includes("immutable");}
  if(!immutableGuard)throw new Error("Immutable folio trigger verification failed");

  const started=Date.now();
  const response=await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/pms_execute`,{
    method:"POST",
    headers:{apikey:env.SUPABASE_SECRET_KEY,"content-type":"application/json","x-client-info":"aurora-pms-smoke/1.0"},
    body:JSON.stringify({p_sql:"SELECT COUNT(*) count FROM reservations WHERE property_id=$1",p_values:["prop-seoul"]}),
  });
  if(!response.ok)throw new Error(`Supabase Data API smoke test failed (${response.status})`);
  const data=await response.json();
  if(Number(data.results?.[0]?.count)!==4)throw new Error("Supabase Data API returned unexpected data");
  console.log(`Supabase smoke passed: ${catalog.tables} tables, ${catalog.triggers} triggers, ${catalog.rls_tables} RLS tables, Data API ${Date.now()-started} ms.`);
}finally{await sql.end({timeout:5});}
