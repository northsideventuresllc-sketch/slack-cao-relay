-- 0003_cao_agent_names.sql
-- CTO -> CAO agent-name rewrites (JB approved 2026-11-25). NOT APPLIED by the build run.
--
-- APPLY ONLY AT CUTOVER (docs/CAO-CUTOVER.md step 4): after 0002 is applied, AFTER the old
-- relay on the VM and the Mac mini is stopped, AFTER "CTO Monitor" is stopped, and right
-- before the new relay starts. Apply through the gated saved-key route (Agent OS Rules 20.11);
-- the council gate must score the exact SQL 95 or higher.
--
-- Why it is separate from 0002: the old relay (and anything else still writing the old names)
-- breaks the moment these names change, because public.fn_comms_canonical_agent() accepts only
-- names found in public.nvg_routine_state.
--
-- What it does, in one transaction (all or nothing):
--   0. Guard: aborts if any agent_comms row naming an old agent (or from "CTO Monitor") was
--      created in the last 10 minutes, i.e. something is still writing the old names.
--   1. Backs up every row it will touch into locked tables public._bak_0003_* (RLS on, no
--      grants). The backup is what the rollback restores from.
--   2. nvg_routine_state: Claude CTO / Gemini CTO / AXON-Hermes CTO renamed to the CAO names;
--      owner_agent likewise (MUSE CTO -> MUSE). The leftover "MUSE CTO" routine row (kind cto,
--      a duplicate of the live MUSE row) is RETIRED, not deleted: active = false plus a
--      health_note; it stays so history and the rollback keep it. After this no agent_comms row
--      names it.
--   3. nvg_agent_presence: "Claude CTO" row renamed to "Claude CAO". The trigger
--      fn_agent_presence_stamps_routine_last_fired() upserts nvg_routine_state from
--      presence.agent_name; it is replaced here so a session that still reports as
--      "Claude CTO" is stamped onto "Claude CAO" instead of re-creating an orphan routine row.
--   4. agent_comms from_agent / to_agent: Claude CTO -> Claude CAO, Gemini CTO -> Gemini CAO,
--      AXON-Hermes CTO -> AXON-Hermes CAO, MUSE CTO -> MUSE. The guard triggers allow it
--      (they check only status / fired_at / completed_at; the wake trigger is AFTER INSERT).
--      "CTO Monitor" stays as a SENDER name; it is a separate agent, see below.
--   5. Defensive: aos.fire_keys.agent_name (0 rows hold old names at the time of writing).
--   6. public.fn_autofire_agent() looks up the secret AGENT_FIRE_<UPPER_SNAKE(agent)>. The
--      stored key AGENT_FIRE_CLAUDE_CTO is renamed to AGENT_FIRE_CLAUDE_CAO (the NAME of the
--      ni_platform_secrets row only; no value is read, copied or printed) so Claude CAO still
--      wakes. Skipped if the new name already exists or the old one is absent.
--   7. Post-checks: raises (rolling everything back) if an old name is still found in
--      agent_comms, nvg_routine_state (other than the retired MUSE CTO row) or nvg_agent_presence.
--
-- Checked read-only on 2026-11-25: no pg_cron job and no function body contains an old agent
-- name (jobs 64-88 are site pings; only fn_autofire_agent builds a name-derived key, covered
-- by step 6). Left alone on purpose: public.agent_comms_wake_log.to_agent (an append-only log
-- of past wakes, 317 rows with old names) and nvg_routine_state.kind = 'cto' (a category
-- value, not an agent name). aos.other_runs, nvg_council_decisions, agent_bus, usage_reports_*
-- and secrets_audit_log hold no old names.
--
-- "CTO Monitor" (270 rows sent, last 2026-11-18) addresses "Claude CTO", "AXON-Hermes CTO" and
-- "Gemini CTO". After this migration those names are unknown to comms_send, so its sends would
-- fail. This migration does NOT repoint it (it is not a database object). The runbook stops it
-- first and repoints it to the CAO names before it is restarted.
--
-- Idempotent: a second run finds nothing to rewrite and the backups already exist (they are
-- created only if missing, so they always hold the PRE-0003 rows).

begin;

-- 0. Guard: refuse to run while the old names are still being written.
do $$
begin
  if exists (select 1 from public.agent_comms
              where created_at > now() - interval '10 minutes'
                and (to_agent   in ('Claude CTO','Gemini CTO','AXON-Hermes CTO','MUSE CTO')
                  or from_agent in ('Claude CTO','Gemini CTO','AXON-Hermes CTO','MUSE CTO','CTO Monitor'))) then
    raise exception '0003 aborted: agent_comms rows with old agent names were written in the last 10 minutes. Stop the old relay and CTO Monitor first.';
  end if;
end
$$;

-- 1. Backups (created once; locked down).
create table if not exists public._bak_0003_meta (
  applied_at timestamptz not null default now(),
  note       text
);
insert into public._bak_0003_meta (note)
  select '0003 applied' where not exists (select 1 from public._bak_0003_meta);

create table if not exists public._bak_0003_agent_comms as
  select id, from_agent, to_agent, created_at
    from public.agent_comms
   where from_agent in ('Claude CTO','Gemini CTO','AXON-Hermes CTO','MUSE CTO')
      or to_agent   in ('Claude CTO','Gemini CTO','AXON-Hermes CTO','MUSE CTO');

create table if not exists public._bak_0003_routine_state as
  select * from public.nvg_routine_state
   where agent_name in ('Claude CTO','Gemini CTO','AXON-Hermes CTO','MUSE CTO')
      or owner_agent in ('Claude CTO','Gemini CTO','AXON-Hermes CTO','MUSE CTO');

create table if not exists public._bak_0003_presence as
  select * from public.nvg_agent_presence
   where agent_name in ('Claude CTO','Gemini CTO','AXON-Hermes CTO','MUSE CTO');

create table if not exists public._bak_0003_fire_keys as
  select * from aos.fire_keys
   where agent_name in ('Claude CTO','Gemini CTO','AXON-Hermes CTO','MUSE CTO');

create table if not exists public._bak_0003_routine_fn as
  select pg_get_functiondef('public.fn_agent_presence_stamps_routine_last_fired()'::regprocedure) as functiondef;

create table if not exists public._bak_0003_secret_rename (old_key text, new_key text, renamed boolean);

do $$
declare t text;
begin
  foreach t in array array['_bak_0003_meta','_bak_0003_agent_comms','_bak_0003_routine_state','_bak_0003_presence','_bak_0003_fire_keys','_bak_0003_routine_fn','_bak_0003_secret_rename'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select on table public.%I to service_role', t);
  end loop;
end
$$;

-- 2. nvg_routine_state: names the comms functions validate against.
update public.nvg_routine_state s
   set agent_name = m.new_name, updated_at = now()
  from (values ('Claude CTO','Claude CAO'), ('Gemini CTO','Gemini CAO'), ('AXON-Hermes CTO','AXON-Hermes CAO')) as m(old_name, new_name)
 where s.agent_name = m.old_name
   and not exists (select 1 from public.nvg_routine_state x where x.agent_name = m.new_name);

update public.nvg_routine_state
   set owner_agent = case owner_agent
                       when 'Claude CTO'      then 'Claude CAO'
                       when 'Gemini CTO'      then 'Gemini CAO'
                       when 'AXON-Hermes CTO' then 'AXON-Hermes CAO'
                       when 'MUSE CTO'        then 'MUSE'
                     end,
       updated_at = now()
 where owner_agent in ('Claude CTO','Gemini CTO','AXON-Hermes CTO','MUSE CTO');

-- Retire the duplicate "MUSE CTO" routine row (keep it; do not delete).
update public.nvg_routine_state
   set active = false,
       health_note = 'Retired by 0003 (CTO to CAO cutover): merged into MUSE. Backup in _bak_0003_routine_state.',
       updated_at = now()
 where agent_name = 'MUSE CTO' and active;

-- 3. Presence row + the trigger function that mirrors it into nvg_routine_state.
update public.nvg_agent_presence p
   set agent_name = m.new_name
  from (values ('Claude CTO','Claude CAO'), ('Gemini CTO','Gemini CAO'), ('AXON-Hermes CTO','AXON-Hermes CAO'), ('MUSE CTO','MUSE')) as m(old_name, new_name)
 where p.agent_name = m.old_name
   and not exists (select 1 from public.nvg_agent_presence x where x.agent_name = m.new_name);

create or replace function public.fn_agent_presence_stamps_routine_last_fired()
 returns trigger
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_name text := case new.agent_name          -- 0003: old CTO names stamp the CAO routine row, never an orphan
                   when 'Claude CTO'      then 'Claude CAO'
                   when 'Gemini CTO'      then 'Gemini CAO'
                   when 'AXON-Hermes CTO' then 'AXON-Hermes CAO'
                   when 'MUSE CTO'        then 'MUSE'
                   else new.agent_name
                 end;
begin
  insert into nvg_routine_state(agent_name, last_seen_at, last_fired_at, updated_at)
  values (v_name, new.last_seen_at, new.last_seen_at, now())
  on conflict (agent_name) do update
     set last_seen_at = greatest(coalesce(nvg_routine_state.last_seen_at,'epoch'::timestamptz), excluded.last_seen_at),
         last_fired_at = greatest(coalesce(nvg_routine_state.last_fired_at,'epoch'::timestamptz), excluded.last_fired_at),
         updated_at = now();
  return new;
end;
$function$;

-- 4. agent_comms.
update public.agent_comms
   set to_agent = case to_agent
                    when 'Claude CTO'      then 'Claude CAO'
                    when 'Gemini CTO'      then 'Gemini CAO'
                    when 'AXON-Hermes CTO' then 'AXON-Hermes CAO'
                    when 'MUSE CTO'        then 'MUSE'
                  end
 where to_agent in ('Claude CTO','Gemini CTO','AXON-Hermes CTO','MUSE CTO');

update public.agent_comms
   set from_agent = case from_agent
                      when 'Claude CTO'      then 'Claude CAO'
                      when 'Gemini CTO'      then 'Gemini CAO'
                      when 'AXON-Hermes CTO' then 'AXON-Hermes CAO'
                      when 'MUSE CTO'        then 'MUSE'
                    end
 where from_agent in ('Claude CTO','Gemini CTO','AXON-Hermes CTO','MUSE CTO');

-- 5. Defensive: aos.fire_keys (names and state only; no rows expected).
update aos.fire_keys
   set agent_name = case agent_name
                      when 'Claude CTO'      then 'Claude CAO'
                      when 'Gemini CTO'      then 'Gemini CAO'
                      when 'AXON-Hermes CTO' then 'AXON-Hermes CAO'
                      when 'MUSE CTO'        then 'MUSE'
                    end
 where agent_name in ('Claude CTO','Gemini CTO','AXON-Hermes CTO','MUSE CTO');

-- 6. fn_autofire_agent secret NAME (value never touched).
do $$
begin
  if to_regclass('public.ni_platform_secrets') is not null
     and exists (select 1 from public.ni_platform_secrets where key = 'AGENT_FIRE_CLAUDE_CTO')
     and not exists (select 1 from public.ni_platform_secrets where key = 'AGENT_FIRE_CLAUDE_CAO') then
    update public.ni_platform_secrets set key = 'AGENT_FIRE_CLAUDE_CAO' where key = 'AGENT_FIRE_CLAUDE_CTO';
    insert into public._bak_0003_secret_rename values ('AGENT_FIRE_CLAUDE_CTO', 'AGENT_FIRE_CLAUDE_CAO', true);
  end if;
end
$$;

-- 7. Post-checks: abort the whole transaction if an old name survived.
do $$
begin
  if exists (select 1 from public.agent_comms
              where to_agent   in ('Claude CTO','Gemini CTO','AXON-Hermes CTO','MUSE CTO')
                 or from_agent in ('Claude CTO','Gemini CTO','AXON-Hermes CTO','MUSE CTO')) then
    raise exception '0003: old agent names remain in agent_comms';
  end if;
  if exists (select 1 from public.nvg_routine_state
              where agent_name in ('Claude CTO','Gemini CTO','AXON-Hermes CTO')
                 or (agent_name = 'MUSE CTO' and active)
                 or owner_agent in ('Claude CTO','Gemini CTO','AXON-Hermes CTO','MUSE CTO')) then
    raise exception '0003: old agent names remain in nvg_routine_state (a CAO row may already exist)';
  end if;
  if exists (select 1 from public.nvg_agent_presence where agent_name in ('Claude CTO','Gemini CTO','AXON-Hermes CTO','MUSE CTO')) then
    raise exception '0003: old agent names remain in nvg_agent_presence';
  end if;
end
$$;

commit;

-- ---------------------------------------------------------------------------
-- Verify (read-only, after applying):
--   select count(*) from public.agent_comms where to_agent ~ 'CTO' and to_agent <> 'CTO Monitor';   -- expect 0
--   select agent_name, active, kind from public.nvg_routine_state where agent_name ~ '(CTO|CAO|^MUSE$)';
--       -- expect Claude CAO, Gemini CAO, AXON-Hermes CAO, MUSE active; "MUSE CTO" active = false
--   select agent_name from public.nvg_agent_presence where agent_name ~ '(CTO|CAO)';               -- expect Claude CAO
--   select key from public.ni_platform_secrets where key ~ 'AGENT_FIRE_CLAUDE';                    -- names only; expect _CAO
--   select count(*) from public._bak_0003_agent_comms;                                             -- rows backed up
--   After the new sessions run: select agent_name from public.nvg_routine_state where agent_name ~ 'CTO'
--       -- must show only the retired "MUSE CTO"; any other row is an orphan from a session still using the old name.
--
-- Rollback (restores from the backups; run the whole block in one transaction). Order matters.
-- It touches only rows listed in the backups, so the pre-existing "Claude CAO" agent_comms row
-- is not rewritten, and MUSE CTO -> MUSE is undone exactly (the backup holds each row's original
-- from_agent and to_agent). Stop the new relay first.
--   begin;
--   -- agent_comms: put back the two original columns of every backed-up row.
--   update public.agent_comms a set from_agent = b.from_agent, to_agent = b.to_agent
--     from public._bak_0003_agent_comms b where a.id = b.id;
--   -- Rows the new relay wrote after 0003 with CAO names (created after applied_at) go back to CTO names:
--   update public.agent_comms a set to_agent = case a.to_agent when 'Claude CAO' then 'Claude CTO'
--       when 'Gemini CAO' then 'Gemini CTO' when 'AXON-Hermes CAO' then 'AXON-Hermes CTO' end
--     where a.to_agent in ('Claude CAO','Gemini CAO','AXON-Hermes CAO')
--       and a.created_at > (select applied_at from public._bak_0003_meta limit 1)
--       and a.id not in (select id from public._bak_0003_agent_comms);
--   update public.agent_comms a set from_agent = case a.from_agent when 'Claude CAO' then 'Claude CTO'
--       when 'Gemini CAO' then 'Gemini CTO' when 'AXON-Hermes CAO' then 'AXON-Hermes CTO' end
--     where a.from_agent in ('Claude CAO','Gemini CAO','AXON-Hermes CAO')
--       and a.created_at > (select applied_at from public._bak_0003_meta limit 1)
--       and a.id not in (select id from public._bak_0003_agent_comms);
--   -- nvg_routine_state: names back; MUSE CTO row un-retired and owners restored from the backup.
--   update public.nvg_routine_state set agent_name = 'Claude CTO'      where agent_name = 'Claude CAO'      and exists (select 1 from public._bak_0003_routine_state b where b.agent_name = 'Claude CTO');
--   update public.nvg_routine_state set agent_name = 'Gemini CTO'      where agent_name = 'Gemini CAO'      and exists (select 1 from public._bak_0003_routine_state b where b.agent_name = 'Gemini CTO');
--   update public.nvg_routine_state set agent_name = 'AXON-Hermes CTO' where agent_name = 'AXON-Hermes CAO' and exists (select 1 from public._bak_0003_routine_state b where b.agent_name = 'AXON-Hermes CTO');
--   update public.nvg_routine_state s set active = b.active, health_note = b.health_note
--     from public._bak_0003_routine_state b where s.agent_name = 'MUSE CTO' and b.agent_name = 'MUSE CTO';
--   update public.nvg_routine_state s set owner_agent = b.owner_agent
--     from public._bak_0003_routine_state b where s.agent_name = b.agent_name;
--   -- presence rows back (a row stamped onto a CAO name is left as is):
--   update public.nvg_agent_presence set agent_name = 'Claude CTO' where agent_name = 'Claude CAO'
--     and exists (select 1 from public._bak_0003_presence b where b.agent_name = 'Claude CTO');
--   -- aos.fire_keys back (only if rows were backed up):
--   update aos.fire_keys f set agent_name = b.agent_name from public._bak_0003_fire_keys b where f.row_id = b.row_id;
--   -- secret name back (name only):
--   update public.ni_platform_secrets set key = 'AGENT_FIRE_CLAUDE_CTO' where key = 'AGENT_FIRE_CLAUDE_CAO'
--     and exists (select 1 from public._bak_0003_secret_rename where renamed);
--   -- trigger function back to its original body (stored in the backup table):
--   --   select functiondef from public._bak_0003_routine_fn;   -- run the text it returns
--   commit;
--   Then run 0002's rollback if the tables must go back too. Drop the _bak_0003_* tables only after
--   the cutover is verified (a later migration).
-- ---------------------------------------------------------------------------
