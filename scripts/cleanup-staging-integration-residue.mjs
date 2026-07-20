/** One-time/repeatable cleanup for namespaced fixtures left by older integration tests. */
import postgres from "postgres";
import { assertStagingDatabaseTarget } from "./staging-db-target.mjs";

const { databaseUrl, projectRef } = assertStagingDatabaseTarget();
const host = new URL(databaseUrl).hostname;
const sql = postgres(databaseUrl, {
  max: 1,
  prepare: false,
  ssl: /^(?:localhost|127\.0\.0\.1)$/u.test(host) ? false : "require",
  connect_timeout: 15,
  idle_timeout: 5,
});
try {
  const removed = await sql.begin(async (transaction) => {
    const fixtureProperties = await transaction`
      SELECT id FROM properties
       WHERE id LIKE 'prop-saas-%' OR id LIKE 'prop-gate-%' OR id LIKE 'prop-scope-%'
       FOR UPDATE`;
    const propertyIds = fixtureProperties.map((row) => row.id);
    if (propertyIds.length) {
      // These are the only child rows created by the named integration suites.
      // Explicit deletion respects the production RESTRICT foreign keys.
      await transaction`DELETE FROM rooms WHERE property_id=ANY(${propertyIds})`;
      await transaction`DELETE FROM room_type_website WHERE property_id=ANY(${propertyIds})`;
      await transaction`DELETE FROM rate_plan_calendar WHERE property_id=ANY(${propertyIds})`;
      await transaction`DELETE FROM rate_plan_room_types WHERE property_id=ANY(${propertyIds})`;
      await transaction`DELETE FROM room_types WHERE property_id=ANY(${propertyIds})`;
      await transaction`DELETE FROM rate_plans WHERE property_id=ANY(${propertyIds})`;
      await transaction`DELETE FROM transaction_codes WHERE property_id=ANY(${propertyIds})`;
      await transaction`DELETE FROM accounting_accounts WHERE property_id=ANY(${propertyIds})`;
      await transaction`DELETE FROM audit_logs WHERE property_id=ANY(${propertyIds})`;
      await transaction`DELETE FROM role_assignments WHERE property_id=ANY(${propertyIds})`;
      await transaction`DELETE FROM property_domains WHERE property_id=ANY(${propertyIds})`;
      await transaction`DELETE FROM property_entitlements WHERE property_id=ANY(${propertyIds})`;
      await transaction`DELETE FROM property_subscriptions WHERE property_id=ANY(${propertyIds})`;
      await transaction`DELETE FROM website_settings WHERE property_id=ANY(${propertyIds})`;
    }
    const properties = await transaction`
      DELETE FROM properties
       WHERE id LIKE 'prop-saas-%' OR id LIKE 'prop-gate-%' OR id LIKE 'prop-scope-%'
       RETURNING id`;
    const organizations = await transaction`
      DELETE FROM organizations
       WHERE (id LIKE 'org-saas-%' OR id LIKE 'org-gate-%' OR id LIKE 'org-scope-%')
         AND NOT EXISTS(SELECT 1 FROM properties p WHERE p.organization_id=organizations.id)
       RETURNING id`;
    await transaction`DELETE FROM worker_attempts WHERE job_id='job-concurrency-saas' OR job_id LIKE 'job-reaper-%'`;
    const jobs = await transaction`DELETE FROM worker_jobs WHERE id='job-concurrency-saas' OR id LIKE 'job-reaper-%' RETURNING id`;
    await transaction`DELETE FROM backup_runs WHERE id='backup-scope-a'`;
    const supportOperatorId = "22222222-2222-4222-8222-222222222222";
    await transaction`DELETE FROM audit_logs WHERE entity_type='support_session' AND entity_id IN (SELECT id FROM support_sessions WHERE operator_user_id=${supportOperatorId}::uuid)`;
    await transaction`DELETE FROM support_sessions WHERE operator_user_id=${supportOperatorId}::uuid`;
    await transaction`DELETE FROM support_access_grants WHERE operator_user_id=${supportOperatorId}::uuid`;
    await transaction`DELETE FROM platform_operators WHERE auth_user_id=${supportOperatorId}::uuid AND email='support@example.com'`;
    return {
      properties: properties.length,
      organizations: organizations.length,
      jobs: jobs.length,
    };
  });
  console.log(
    `Cleaned isolated integration residue from ${projectRef}: ${JSON.stringify(removed)}`,
  );
} finally {
  await sql.end({ timeout: 5 });
}
