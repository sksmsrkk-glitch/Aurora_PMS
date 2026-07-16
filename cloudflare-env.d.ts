declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    DATABASE_URL?: string;
    SUPABASE_URL?: string;
    SUPABASE_SECRET_KEY?: string;
  }
}
