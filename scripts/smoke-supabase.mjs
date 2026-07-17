/** Read-only/rollback Supabase catalog, invariant and pooled-runtime smoke checks. */
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

const env={...parseEnv(await readFile(path.join(process.cwd(),".env.local"),"utf8")),...Object.fromEntries(["DIRECT_URL","DATABASE_URL"].filter(key=>process.env[key]).map(key=>[key,process.env[key]]))};
for(const key of ["DIRECT_URL","DATABASE_URL"])if(!env[key])throw new Error(`${key} is required`);

const sql=postgres(env.DIRECT_URL,{max:1,prepare:false,ssl:"require",connect_timeout:15,idle_timeout:5});
try{
  const [catalog]=await sql`
    SELECT
      (SELECT COUNT(*)::int FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE') tables,
      (SELECT COUNT(*)::int FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND relrowsecurity) rls_tables,
      (SELECT COUNT(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname='public') triggers,
      (SELECT COUNT(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname='public' AND t.tgname IN ('reservation_type_nights_capacity','block_inventory_capacity_insert','folio_entries_no_update','ar_ledger_no_update','integration_attempts_no_update','accounting_journal_lines_no_update','accounting_journal_entries_guard_update','reservation_rate_nights_no_update','channel_settlement_contract_snapshot_insert')) required_triggers,
      (SELECT COUNT(*)::int FROM pg_constraint WHERE connamespace='public'::regnamespace AND contype='f' AND convalidated) foreign_keys,
      (SELECT COUNT(*)::int FROM pms_schema_migrations) migrations,
      (SELECT COUNT(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('pms_execute','pms_batch','pms_execute_statement','pms_render_sql')) arbitrary_sql_functions,
      (SELECT COUNT(*)::int FROM role_assignments WHERE id IN ('role-local-admin','role-local-pms-admin')) seeded_admins
  `;
  if(catalog.tables<54||catalog.rls_tables<54||catalog.triggers<29||Number(catalog.required_triggers)!==9||catalog.foreign_keys<86||catalog.migrations<16||Number(catalog.arbitrary_sql_functions)!==0||Number(catalog.seeded_admins)!==0)throw new Error("Supabase catalog verification failed");

  const [website]=await sql`
    SELECT
      (SELECT COUNT(*)::int FROM website_settings WHERE property_id='prop-seoul' AND published=1) settings,
      (SELECT COUNT(*)::int FROM room_type_website WHERE property_id='prop-seoul' AND published=1) published_rooms,
      EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='inventory_controls' AND column_name='website_closed') website_control,
      EXISTS(SELECT 1 FROM storage.buckets WHERE id='hotel-media' AND public=true) public_bucket
  `;
  if(Number(website.settings)!==1||Number(website.published_rooms)<1||!website.website_control||!website.public_bucket)throw new Error("Website CMS catalog verification failed");

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
        await transaction`INSERT INTO reservations(id,confirmation_no,property_id,guest_id,room_type_id,room_id,arrival_date,departure_date,status,adults,children,source,rate_plan,nightly_rate,eta,notes,version,created_at,updated_at) VALUES (${reservationId},${`SMOKE-CAP-${index}`},'prop-seoul',${guest.id},${target.room_type_id},NULL,${target.stay_date},${target.stay_date},'DUE_IN',1,0,'SMOKE','SMOKE',0,NULL,'',1,now(),now())`;
        await transaction`INSERT INTO reservation_type_nights(property_id,reservation_id,room_type_id,stay_date) VALUES ('prop-seoul',${reservationId},${target.room_type_id},${target.stay_date})`;
      }
    });
  }catch(error){capacityGuard=error instanceof Error&&error.message.includes("room type sold out");}
  if(!capacityGuard)throw new Error("Inventory capacity trigger verification failed");

  let immutableGuard=false;
  try{await sql`UPDATE folio_entries SET description='smoke' WHERE id='fe1'`;}catch(error){immutableGuard=error instanceof Error&&error.message.includes("immutable");}
  if(!immutableGuard)throw new Error("Immutable folio trigger verification failed");

  // A clean staging database intentionally has no operational journals. Build a
  // balanced entry inside a transaction, exercise the immutable-line trigger, and
  // confirm PostgreSQL rolled the whole smoke fixture back after the trigger abort.
  const journalId=`smoke-balanced-${crypto.randomUUID()}`;
  let accountingImmutable=false;
  try{
    await sql.begin(async transaction=>{
      const accounts=await transaction`SELECT id FROM accounting_accounts WHERE property_id='prop-seoul' AND active=1 ORDER BY code LIMIT 2`;
      if(accounts.length<2)throw new Error("starter accounting accounts are missing");
      const now=new Date().toISOString();
      await transaction`INSERT INTO accounting_journal_entries(id,property_id,entry_no,business_date,entry_type,source_type,source_id,description,vendor,status,reversal_of_id,created_at,created_by) VALUES (${journalId},'prop-seoul',${`SMOKE-BAL-${crypto.randomUUID()}`},'2099-12-30','ADJUSTMENT','SMOKE',NULL,'rollback-only balanced journal',NULL,'POSTED',NULL,${now},'smoke')`;
      await transaction`INSERT INTO accounting_journal_lines(id,property_id,journal_entry_id,account_id,debit,credit,department,channel_connection_id,reservation_id,memo,created_at) VALUES (${crypto.randomUUID()},'prop-seoul',${journalId},${accounts[0].id},100,0,'FINANCE',NULL,NULL,'rollback-only debit',${now}),(${crypto.randomUUID()},'prop-seoul',${journalId},${accounts[1].id},0,100,'FINANCE',NULL,NULL,'rollback-only credit',${now})`;
      const [totals]=await transaction`SELECT COALESCE(SUM(debit),0) debit,COALESCE(SUM(credit),0) credit FROM accounting_journal_lines WHERE journal_entry_id=${journalId}`;
      if(Math.abs(Number(totals.debit)-Number(totals.credit))>0.01)throw new Error("balanced accounting journal mismatch");
      await transaction`UPDATE accounting_journal_lines SET memo='forbidden smoke update' WHERE journal_entry_id=${journalId}`;
    });
  }catch(error){accountingImmutable=error instanceof Error&&error.message.includes("immutable");}
  const [journalRollback]=await sql`SELECT COUNT(*)::int count FROM accounting_journal_entries WHERE id=${journalId}`;
  if(!accountingImmutable||Number(journalRollback.count)!==0)throw new Error("Balanced immutable accounting journal verification failed");
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

  // Duplicate receipts must abort every statement in the financial transaction,
  // not merely ignore the second key after ledger side effects were committed.
  const receiptKey=`smoke-idempotency-${crypto.randomUUID()}`,auditId=crypto.randomUUID();
  let receiptRollback=false;
  try {
    await sql.begin(async transaction=>{
      await transaction`INSERT INTO audit_logs(id,property_id,actor,action,entity_type,entity_id,before_json,after_json,created_at) VALUES (${auditId},'prop-seoul','smoke','SMOKE_IDEMPOTENCY','smoke',${receiptKey},NULL,NULL,${new Date().toISOString()})`;
      await transaction`INSERT INTO idempotency_keys(key,property_id,action,actor,created_at) VALUES (${receiptKey},'prop-seoul','SMOKE','smoke',${new Date().toISOString()})`;
      await transaction`INSERT INTO idempotency_keys(key,property_id,action,actor,created_at) VALUES (${receiptKey},'prop-seoul','SMOKE','smoke',${new Date().toISOString()})`;
    });
  } catch(error) { receiptRollback=error instanceof Error&&error.message.includes("idempotency_keys_pkey"); }
  const [receiptState]=await sql`SELECT (SELECT COUNT(*)::int FROM idempotency_keys WHERE key=${receiptKey}) receipts,(SELECT COUNT(*)::int FROM audit_logs WHERE id=${auditId}) audits`;
  if(!receiptRollback||Number(receiptState.receipts)!==0||Number(receiptState.audits)!==0)throw new Error("Idempotency transaction rollback verification failed");

  const rateScope=`smoke-${crypto.randomUUID()}`;let rateRollback=false;
  try {
    await sql.begin(async transaction=>{
      const [first]=await transaction`INSERT INTO api_rate_limits(scope,key_hash,window_start,count,expires_at) VALUES (${rateScope},'smoke','2099-01-01T00:00:00.000Z',1,'2099-01-01T00:02:00.000Z') ON CONFLICT(scope,key_hash,window_start) DO UPDATE SET count=api_rate_limits.count+1 RETURNING count`;
      const [second]=await transaction`INSERT INTO api_rate_limits(scope,key_hash,window_start,count,expires_at) VALUES (${rateScope},'smoke','2099-01-01T00:00:00.000Z',1,'2099-01-01T00:02:00.000Z') ON CONFLICT(scope,key_hash,window_start) DO UPDATE SET count=api_rate_limits.count+1 RETURNING count`;
      if(Number(first.count)!==1||Number(second.count)!==2)throw new Error("rate limit count mismatch");
      throw new Error("rollback rate limit smoke");
    });
  } catch(error) { rateRollback=error instanceof Error&&error.message==="rollback rate limit smoke"; }
  const [rateState]=await sql`SELECT COUNT(*)::int count FROM api_rate_limits WHERE scope=${rateScope}`;
  if(!rateRollback||Number(rateState.count)!==0)throw new Error("Rate-limit atomic rollback verification failed");

  const started=Date.now(),runtimeSql=postgres(env.DATABASE_URL,{max:1,prepare:false,ssl:"require",connect_timeout:15,idle_timeout:5});
  try {
    const [runtime]=await runtimeSql`SELECT COUNT(*)::int count FROM reservations WHERE property_id='prop-seoul'`;
    if(Number(runtime?.count)<4)throw new Error("Pooled runtime connection returned fewer rows than the seed baseline");
  } finally { await runtimeSql.end({timeout:5}); }
  console.log(`Supabase smoke passed: ${catalog.tables} tables, ${catalog.triggers} triggers, ${catalog.foreign_keys} validated foreign keys, ${catalog.rls_tables} RLS tables, ${website.published_rooms} published website rooms, pooled runtime ${Date.now()-started} ms, arbitrary SQL RPCs 0.`);
}finally{await sql.end({timeout:5});}
