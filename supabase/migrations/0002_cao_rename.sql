-- 0002_cao_rename.sql
-- CTO -> CAO rename for the Slack relay (JB approved 2026-11-25).
-- NOT APPLIED by the build run. Apply through the gated saved-key route
-- (Agent OS Rules 20.11) AFTER docs/CAO-CUTOVER.md step 2 and BEFORE the new relay code starts.
--
-- What it does (NI Brain, project uaztknnipdxxptrmlxlb, public schema):
--   1. cto_relay_lease -> cao_relay_lease, cto_heartbeat -> cao_heartbeat (tables renamed in
--      place: rows, RLS, grants and constraints move with them; constraint names renamed too).
--   2. Compatibility views cto_relay_lease and cto_heartbeat over the new tables, so the
--      OLD relay build (which still reads /cto_relay_lease and /cto_heartbeat) keeps working
--      until it is stopped. The views are simple, so PostgREST can INSERT/UPDATE through them.
--      security_invoker = true: the view runs with the caller's rights, so the tables' RLS
--      applies; anon/authenticated get no grant. Drop the views after the cutover is verified.
--
-- SAFE TO APPLY NOW: nothing here changes agent names. The agent-name rewrites
-- (agent_comms, nvg_routine_state, nvg_agent_presence, ...) live in 0003_cao_agent_names.sql,
-- which is applied ONLY at cutover, after the old relay (VM + Mac mini) is stopped.
--
-- Idempotent: safe to run twice. One transaction: all or nothing.

begin;

-- 1. Rename the tables (only while the old name is still a real table).
do $$
begin
  if to_regclass('public.cao_relay_lease') is null
     and exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relname = 'cto_relay_lease' and c.relkind = 'r') then
    alter table public.cto_relay_lease rename to cao_relay_lease;
    alter table public.cao_relay_lease rename constraint cto_relay_lease_pkey to cao_relay_lease_pkey;
    alter table public.cao_relay_lease rename constraint cto_relay_lease_name_known to cao_relay_lease_name_known;
    alter table public.cao_relay_lease rename constraint cto_relay_lease_epoch_positive to cao_relay_lease_epoch_positive;
    alter table public.cao_relay_lease rename constraint cto_relay_lease_holder_not_blank to cao_relay_lease_holder_not_blank;
    alter table public.cao_relay_lease rename constraint cto_relay_lease_expiry_after_heartbeat to cao_relay_lease_expiry_after_heartbeat;
  end if;
  if to_regclass('public.cao_heartbeat') is null
     and exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relname = 'cto_heartbeat' and c.relkind = 'r') then
    alter table public.cto_heartbeat rename to cao_heartbeat;
    alter table public.cao_heartbeat rename constraint cto_heartbeat_pkey to cao_heartbeat_pkey;
    alter table public.cao_heartbeat rename constraint cto_heartbeat_agent_not_blank to cao_heartbeat_agent_not_blank;
  end if;
end
$$;

comment on table public.cao_heartbeat is
  'Slack CAO Loop: one liveness row per agent. Written by the cao-heartbeat cron every 15 min. Offline = older than 30 min. (Renamed from cto_heartbeat by 0002.)';
comment on table public.cao_relay_lease is
  'Slack CAO Loop: one lease per relay program. 90 s lease, 30 s heartbeat. epoch is the fencing token, +1 on every acquisition. (Renamed from cto_relay_lease by 0002.)';

-- Same access as the renamed tables: RLS on, no policies, service_role only.
alter table public.cao_heartbeat   enable row level security;
alter table public.cao_relay_lease enable row level security;
revoke all on table public.cao_heartbeat   from anon, authenticated;
revoke all on table public.cao_relay_lease from anon, authenticated;
grant select, insert, update on table public.cao_heartbeat   to service_role;
grant select, insert, update on table public.cao_relay_lease to service_role;

-- 2. Compatibility views under the old names (drop after cutover).
create or replace view public.cto_relay_lease with (security_invoker = true) as
  select name, epoch, holder, acquired_at, heartbeat_at, expires_at from public.cao_relay_lease;
create or replace view public.cto_heartbeat with (security_invoker = true) as
  select agent, heartbeat_at from public.cao_heartbeat;
comment on view public.cto_relay_lease is 'DEPRECATED compatibility view over cao_relay_lease (0002). Drop after the CAO cutover is verified.';
comment on view public.cto_heartbeat   is 'DEPRECATED compatibility view over cao_heartbeat (0002). Drop after the CAO cutover is verified.';
revoke all on table public.cto_relay_lease from anon, authenticated;
revoke all on table public.cto_heartbeat   from anon, authenticated;
grant select, insert, update on table public.cto_relay_lease to service_role;
grant select, insert, update on table public.cto_heartbeat   to service_role;

commit;

-- ---------------------------------------------------------------------------
-- Verify (read-only, run after applying):
--   select relname, relkind, relrowsecurity from pg_class
--    where relnamespace = 'public'::regnamespace
--      and relname in ('cao_relay_lease','cao_heartbeat','cto_relay_lease','cto_heartbeat');
--      -- expect cao_* = r with RLS true; cto_* = v
--
-- Rollback (agent names are untouched by this file, so this is the whole rollback):
--   begin;
--   drop view if exists public.cto_relay_lease; drop view if exists public.cto_heartbeat;
--   alter table public.cao_relay_lease rename to cto_relay_lease;
--   alter table public.cao_heartbeat   rename to cto_heartbeat;
--   -- constraint names may stay cao_*; harmless.
--   commit;
--
-- Cleanup after a verified cutover (a later migration, not part of this one):
--   drop view public.cto_relay_lease; drop view public.cto_heartbeat;
-- ---------------------------------------------------------------------------
