import { createClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import type { Database } from "@/types/database";

/**
 * Single shared Supabase browser client. Uses the publishable key only.
 * Auth tokens are managed by the Supabase client itself - do not persist or
 * print them manually.
 */
export const supabase = createClient<Database>(
  // Local access: same-origin proxy that holds the admin token server-side.
  env.VITE_LOCAL_ACCESS
    ? `${window.location.origin}/sb`
    : env.VITE_SUPABASE_URL,
  env.VITE_SUPABASE_PUBLISHABLE_KEY,
  {
    auth: {
      persistSession: !env.VITE_LOCAL_ACCESS,
      autoRefreshToken: !env.VITE_LOCAL_ACCESS,
      detectSessionInUrl: !env.VITE_LOCAL_ACCESS,
    },
    global: env.VITE_LOCAL_ACCESS
      ? { headers: { "x-ninja-local": "1" } }
      : undefined,
  },
);
