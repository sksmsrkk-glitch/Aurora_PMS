Never edit an existing file under `supabase/migrations/` for branding, comments, formatting, or logic; add a new forward-only migration when a database change is required.
Every new migration that repairs or backfills tenant rows must append a matching `audit_logs` record with `actor='system:migration'`; never fabricate a historical before-image when it is unavailable.
