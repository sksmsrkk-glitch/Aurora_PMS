/** Shared fail-closed guard for any process allowed to mutate the staging DB. */
export function assertStagingDatabaseTarget() {
  const databaseUrl = process.env.DATABASE_URL || "";
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const expectedProjectRef = process.env.PMS_QA_PROJECT_REF || "";
  const actualProjectRef = (() => {
    try {
      return new URL(supabaseUrl).hostname.split(".")[0] || "";
    } catch {
      return "";
    }
  })();
  if (
    process.env.PMS_ENVIRONMENT !== "staging" ||
    process.env.PMS_ALLOW_DESTRUCTIVE_QA !== "true" ||
    !expectedProjectRef ||
    actualProjectRef !== expectedProjectRef ||
    !/^postgres(?:ql)?:\/\//u.test(databaseUrl)
  ) {
    throw new Error(
      `Staging database target rejected ` +
        `(environment=${process.env.PMS_ENVIRONMENT || "missing"}, qaAllowed=${process.env.PMS_ALLOW_DESTRUCTIVE_QA || "missing"}, ` +
        `expectedRef=${expectedProjectRef || "missing"}, actualRef=${actualProjectRef || "missing"}, databaseConfigured=${Boolean(databaseUrl)})`,
    );
  }
  return { databaseUrl, projectRef: actualProjectRef };
}
