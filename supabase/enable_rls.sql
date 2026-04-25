-- Enable Row Level Security on all public tables
-- This blocks access via Supabase PostgREST (anon/authenticated keys)
-- while allowing full access via direct PostgreSQL connections (Prisma)
-- since the postgres role bypasses RLS by default.

ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verification_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.domain_patterns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.domain_intel ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.search_log ENABLE ROW LEVEL SECURITY;

-- No policies are created intentionally.
-- The app uses Prisma with the postgres role (which bypasses RLS),
-- so no policies are needed. This effectively blocks all access
-- through Supabase's auto-generated REST API.
