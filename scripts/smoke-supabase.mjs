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
      (SELECT COUNT(*)::int FROM pg_constraint WHERE connamespace='public'::regnamespace AND contype='f' AND convalidated) foreign_keys,
      (SELECT COUNT(*)::int FROM pms_schema_migrations) migrations
  `;
  if(catalog.tables<47||catalog.rls_tables<47||catalog.triggers<34||catalog.foreign_keys<74||catalog.migrations<8)throw new Error("Supabase catalog verification failed");

  let capacityGuard=false;
  try{
    await sql.begin(async transaction=>{
      const [target]=await transaction`
        SELECT p.business_date stay_date,rt.id room_type_id,
          COALESCE(ic.sell_limit,COUNT(rm.id) FILTER (WHERE rm.active=1 AND rm.housekeeping_status<>'OUT_OF_SERVICE'))::int capacity_limit,
          (SELECT COUNT(*)::int FROM reservation_type_nights n WHERE n.property_id=p.id AND n.room_type_id=rt.id AND n.stay_date=p.business_date) sold,
          (SELECT COALESCE(SUM(bi.current_rooms-bi.picked_up),0)::int FROM block_inventory bi JOIN business_blocks bb ON bb.id=bi.block_id WHERE bi.property_id=p.id AND bi.room_type_id=rt.id AND bi.stay_date=p.business_date AND bb.deduct_inventory=1 AND bb.status IN ('TENTATIVE','DEFINITE')) held
        FROM properties p JOIN room_types rt ON rt.property_id=p.id LEFT JOIN rooms rm ON rm.room_type_id=rt.id LEFT JOIN inventory_controls ic ON ic.property_id=p.id AND ic.room_type_id=rt.id AND ic.stay_date=p.business_date
        WHERE p.id='prop-seoul' AND rt.active=1 AND COALESCE(ic.closed,0)=0
        GROUP BY p.id,p.business_date,rt.id,ic.sell_limit ORDER BY rt.id LIMIT 1`;
      const [guest]=await transaction`SELECT id FROM guests WHERE property_id='prop-seoul' LIMIT 1`;
      const remaining=Math.max(0,Number(target.capacity_limit)-Number(target.sold)-Number(target.held));
      for(let index=0;index<=remaining;index+=1){
        const reservationId=`smoke-capacity-${index}`;
        await transaction`INSERT INTO reservations(id,confirmation_no,property_id,guest_id,room_type_id,room_id,arrival_date,departure_date,status,adults,children,source,rate_plan,nightly_rate,eta,notes,version,created_at,updated_at) VALUES (${reservationId},${`SMOKE-CAP-${index}`},'prop-seoul',${guest.id},${target.room_type_id},NULL,${target.stay_date},${target.stay_date},'DUE_IN',1,0,'SMOKE','SMOKE',0,NULL,'',1,now()::text,now()::text)`;
        await transaction`INSERT INTO reservation_type_nights(property_id,reservation_id,room_type_id,stay_date) VALUES ('prop-seoul',${reservationId},${target.room_type_id},${target.stay_date})`;
      }
    });
  }catch(error){capacityGuard=error instanceof Error&&error.message.includes("room type sold out");}
  if(!capacityGuard)throw new Error("Inventory capacity trigger verification failed");

  let immutableGuard=false;
  try{await sql`UPDATE folio_entries SET description='smoke' WHERE id='fe1'`;}catch(error){immutableGuard=error instanceof Error&&error.message.includes("immutable");}
  if(!immutableGuard)throw new Error("Immutable folio trigger verification failed");

  const [journal]=await sql`SELECT e.id,COALESCE(SUM(l.debit),0) debit,COALESCE(SUM(l.credit),0) credit FROM accounting_journal_entries e JOIN accounting_journal_lines l ON l.journal_entry_id=e.id GROUP BY e.id LIMIT 1`;
  if(!journal||Math.abs(Number(journal.debit)-Number(journal.credit))>0.01)throw new Error("Balanced accounting journal verification failed");
  let accountingImmutable=false;
  try{await sql`UPDATE accounting_journal_lines SET memo='smoke' WHERE journal_entry_id=${journal.id}`;}catch(error){accountingImmutable=error instanceof Error&&error.message.includes("immutable");}
  if(!accountingImmutable)throw new Error("Immutable accounting journal verification failed");
  let reversalRaceGuard=false;
  try{
    await sql.begin(async transaction=>{
      const suffix=crypto.randomUUID(),baseId=`smoke-journal-${suffix}`,reversalOne=`smoke-reversal-a-${suffix}`,reversalTwo=`smoke-reversal-b-${suffix}`,now=new Date().toISOString();
      await transaction`INSERT INTO accounting_journal_entries(id,property_id,entry_no,business_date,entry_type,source_type,source_id,description,vendor,status,reversal_of_id,created_at,created_by) VALUES (${baseId},'prop-seoul',${`SMOKE-BASE-${suffix}`},'2099-12-30','ADJUSTMENT','SMOKE',NULL,'rollback-only smoke journal',NULL,'POSTED',NULL,${now},'smoke')`;
      await transaction`INSERT INTO accounting_journal_entries(id,property_id,entry_no,business_date,entry_type,source_type,source_id,description,vendor,status,reversal_of_id,created_at,created_by) VALUES (${reversalOne},'prop-seoul',${`SMOKE-REV-A-${suffix}`},'2099-12-30','REVERSAL','JOURNAL_REVERSAL',${baseId},'rollback-only reversal',NULL,'POSTED',${baseId},${now},'smoke')`;
      await transaction`INSERT INTO accounting_journal_entries(id,property_id,entry_no,business_date,entry_type,source_type,source_id,description,vendor,status,reversal_of_id,created_at,created_by) VALUES (${reversalTwo},'prop-seoul',${`SMOKE-REV-B-${suffix}`},'2099-12-30','REVERSAL','JOURNAL_REVERSAL',${baseId},'duplicate rollback-only reversal',NULL,'POSTED',${baseId},${now},'smoke')`;
    });
  }catch(error){reversalRaceGuard=error instanceof Error&&(error.message.includes("accounting_journal_reversal_once_uq")||error.message.includes("accounting_journal_source_once_uq"));}
  if(!reversalRaceGuard)throw new Error("Accounting reversal concurrency guard verification failed");
  const [settlementMismatch]=await sql`SELECT COUNT(*)::int count FROM channel_settlements WHERE abs((gross_sell_amount-channel_cost_amount)-hotel_net_amount)>0.01 OR contract_type NOT IN ('COMMISSION','NET_RATE')`;
  if(Number(settlementMismatch.count)!==0)throw new Error("Channel settlement equation verification failed");

  const started=Date.now();
  const response=await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/pms_execute`,{
    method:"POST",
    headers:{apikey:env.SUPABASE_SECRET_KEY,"content-type":"application/json","x-client-info":"aurora-pms-smoke/1.0"},
    body:JSON.stringify({p_sql:"SELECT COUNT(*) count FROM reservations WHERE property_id=$1",p_values:["prop-seoul"]}),
  });
  if(!response.ok)throw new Error(`Supabase Data API smoke test failed (${response.status})`);
  const data=await response.json();
  if(Number(data.results?.[0]?.count)<4)throw new Error("Supabase Data API returned fewer rows than the seed baseline");
  console.log(`Supabase smoke passed: ${catalog.tables} tables, ${catalog.triggers} triggers, ${catalog.foreign_keys} validated foreign keys, ${catalog.rls_tables} RLS tables, Data API ${Date.now()-started} ms.`);
}finally{await sql.end({timeout:5});}
