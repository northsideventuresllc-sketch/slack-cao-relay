-- 0004_relay_to_aos.sql: a copy of nv-vault 'Infrastructure Code/database/NI Brain/012_relay_to_aos.sql'.
-- The canonical copy is the nv-vault file; this one is the same text so there is one source. Applies after 0003_cao_agent_names.sql, in the cutover window only.

-- 012_relay_to_aos.sql (apply name: aos_012_relay_to_aos)
-- S4 Comms and Relay, v4.0 finish, item 46 (Fable decision B).
-- Relay data: the lease and heartbeat tables stay in NI Brain but move into the aos schema; message text
-- stays in Slack; the brain keeps only a pointer row (Slack link, fire id, state) in a new pointer-only table.
-- After the relay repo is repointed (branch aos/v4-relay-cutover) and live, agent_comms is dropped
-- (wave 3; SQL: Logs/Agent OS Build/Parked SQL/s4-drop-agent-comms-wave3.sql).
-- Idempotent: every step checks first. Moving a table keeps its rows, columns and indexes.
-- Not applied by hand: applies only after the council gate scores 95+ on this exact file (Rules 6, 13.7).

do $$
begin
  -- the 0002 compatibility views keep the old cto_* names alive in public; they go first
  drop view if exists public.cto_relay_lease;
  drop view if exists public.cto_heartbeat;
  if to_regclass('public.cao_relay_lease') is not null and to_regclass('aos.cao_relay_lease') is null then
    alter table public.cao_relay_lease set schema aos;
  end if;
  if to_regclass('public.cao_heartbeat') is not null and to_regclass('aos.cao_heartbeat') is null then
    alter table public.cao_heartbeat set schema aos;
  end if;
  if to_regclass('aos.cao_relay_lease') is null or to_regclass('aos.cao_heartbeat') is null then
    raise exception 'relay tables not found in public or aos; stop and report';
  end if;
end $$;

-- The relay program for AXON CAO is now named 'axon' (it was 'axon-hermes'). The lease row name and its check follow.
-- BEFORE applying, run this read-only and keep the answer (the live constraint text must match what is replaced here):
--   select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid = 'aos.cao_relay_lease'::regclass;
-- Idempotent: the constraint comes off, the row is renamed (only if no 'axon' row exists yet), the constraint goes back on with the new name list.
do $$
begin
  alter table aos.cao_relay_lease drop constraint if exists cao_relay_lease_name_known;
  update aos.cao_relay_lease set name = 'axon'
   where name = 'axon-hermes' and not exists (select 1 from aos.cao_relay_lease where name = 'axon');
  alter table aos.cao_relay_lease add constraint cao_relay_lease_name_known check (name in ('muse', 'claude', 'gemini', 'axon'));
end $$;

-- Pointer-only: where a relayed message lives in Slack and what state it is in. No message text column.
create table if not exists aos.relay_pointers (
  row_id text primary key,                       -- made by the writer: relay-<yyyymmddhhmmss>-<rand>
  from_cao text not null check (from_cao in ('muse', 'claude', 'gemini', 'axon')),
  to_cao text not null check (to_cao in ('muse', 'claude', 'gemini', 'axon')),
  slack_channel text not null check (slack_channel in ('cao-bots', 'cao-muse', 'cao-claude', 'cao-gemini', 'cao-axon')),
  slack_link text not null check (slack_link ~ '^https://[a-z0-9-]+\.slack\.com/archives/'),
  fire_id text,                                   -- the wake or fire this message started, if any
  state text not null check (state in ('posted', 'delivered', 'answered', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (from_cao <> to_cao));
create index if not exists relay_pointers_to_state_idx on aos.relay_pointers (to_cao, state);
-- updated_at is kept by the database, not trusted from the caller.
create or replace function aos._relay_pointers_touch() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists relay_pointers_touch on aos.relay_pointers;
create trigger relay_pointers_touch before update on aos.relay_pointers
  for each row execute function aos._relay_pointers_touch();
select aos._lock('aos.relay_pointers');
select aos._lock('aos.cao_relay_lease');
select aos._lock('aos.cao_heartbeat');

-- ---------------------------------------------------------------------------------------------
-- Public wrappers: the relay reaches aos over REST only through these (aos stays off the API,
-- same pattern as 005 and 011). service_role only. Allow-listed to the three relay tables.
-- Column-agnostic on purpose: columns are checked against the real table at call time and every
-- value is cast to the column's own type, so the wrappers fit the tables whatever their columns are.
-- A filter is a json object: {"col": value} means equals; {"col": {"lt": v}} also takes eq, ne, lte, gt, gte. A null value is allowed only with eq or ne.
-- ---------------------------------------------------------------------------------------------
create or replace function aos._relay_check(p_table text, p_cols text[])
returns void language plpgsql set search_path = '' as $$
declare c text;
begin
  if p_table not in ('cao_relay_lease', 'cao_heartbeat', 'relay_pointers') then raise exception 'not a relay table'; end if;
  foreach c in array coalesce(p_cols, '{}') loop
    if not exists (select 1 from pg_attribute a where a.attrelid = ('aos.' || p_table)::regclass and a.attname = c
                   and a.attnum > 0 and not a.attisdropped) then
      raise exception 'no such column: %', c;
    end if;
  end loop;
end $$;

create or replace function aos._relay_where(p_table text, p_filter jsonb)
returns text language plpgsql set search_path = '' as $$
declare k text; v jsonb; op text; val jsonb; typ text; parts text[] := '{}'; sym text;
begin
  if p_filter is null or jsonb_typeof(p_filter) <> 'object' then raise exception 'filter must be an object'; end if;
  perform aos._relay_check(p_table, array(select jsonb_object_keys(p_filter)));
  for k, v in select * from jsonb_each(p_filter) loop
    select format_type(a.atttypid, a.atttypmod) into typ from pg_attribute a where a.attrelid = ('aos.' || p_table)::regclass and a.attname = k;
    if jsonb_typeof(v) = 'object' then
      if (select count(*) from jsonb_object_keys(v)) <> 1 then raise exception 'one operator per column'; end if;
      select key, value into op, val from jsonb_each(v);
      sym := case op when 'eq' then '=' when 'ne' then '<>' when 'lt' then '<' when 'lte' then '<=' when 'gt' then '>' when 'gte' then '>=' end;
      if sym is null then raise exception 'unknown operator'; end if;
    else sym := '='; val := v; end if;
    if jsonb_typeof(val) = 'null' then
      if sym not in ('=', '<>') then raise exception 'null is allowed only with eq or ne'; end if;
      parts := parts || format('%I %s null', k, case sym when '=' then 'is' else 'is not' end);
    else
      parts := parts || format('%I %s %L::%s', k, sym, val #>> '{}', typ);
    end if;
  end loop;
  return coalesce(nullif(array_to_string(parts, ' and '), ''), 'true');
end $$;

create or replace function public.aos_relay_select(p_table text, p_filter jsonb default '{}'::jsonb, p_limit int default 100)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare out jsonb;
begin
  execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from (select * from aos.%I where %s limit %s) t',
    p_table, aos._relay_where(p_table, p_filter), least(greatest(coalesce(p_limit, 100), 1), 1000)) into out;
  return out;
end $$;

-- p_on_conflict: 'update' (default) merges the row into the existing one; 'nothing' leaves an existing row alone and
-- returns no row (the relay's insertLease: null means another relay took the row first).
drop function if exists public.aos_relay_upsert(text, jsonb, text);
create or replace function public.aos_relay_upsert(p_table text, p_row jsonb, p_conflict text, p_on_conflict text default 'update')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare cols text[]; collist text; setlist text; action text; out jsonb;
begin
  if p_row is null or jsonb_typeof(p_row) <> 'object' then raise exception 'row must be an object'; end if;
  if coalesce(p_on_conflict, 'update') not in ('update', 'nothing') then raise exception 'p_on_conflict must be update or nothing'; end if;
  cols := array(select jsonb_object_keys(p_row));
  perform aos._relay_check(p_table, cols || p_conflict);
  collist := (select string_agg(format('%I', c), ', ') from unnest(cols) c);
  setlist := (select string_agg(format('%I = excluded.%I', c, c), ', ') from unnest(cols) c where c <> p_conflict);
  action := case when coalesce(p_on_conflict, 'update') = 'nothing' or setlist is null then 'nothing' else 'update set ' || setlist end;
  execute format('with ins as (insert into aos.%1$I (%2$s) select %2$s from jsonb_populate_record(null::aos.%1$I, $1) on conflict (%3$I) do %4$s returning *) select coalesce(jsonb_agg(to_jsonb(ins)), ''[]''::jsonb) from ins',
    p_table, collist, p_conflict, action) into out using p_row;
  return out;
end $$;

-- Compare-and-swap: updates only rows matching the filter, returns how many changed (the lease uses this).
create or replace function public.aos_relay_update(p_table text, p_filter jsonb, p_patch jsonb)
returns int language plpgsql security definer set search_path = '' as $$
declare cols text[]; setlist text; n int;
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'patch must be an object'; end if;
  if p_filter is null or p_filter = '{}'::jsonb then raise exception 'update needs a filter'; end if;
  cols := array(select jsonb_object_keys(p_patch));
  perform aos._relay_check(p_table, cols);
  setlist := (select string_agg(format('%I = (jsonb_populate_record(null::aos.%I, $1)).%I', c, p_table, c), ', ') from unnest(cols) c);
  execute format('with u as (update aos.%I set %s where %s returning 1) select count(*) from u', p_table, setlist, aos._relay_where(p_table, p_filter)) into n using p_patch;
  return n;
end $$;

create or replace function public.aos_relay_delete(p_table text, p_filter jsonb)
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if p_filter is null or p_filter = '{}'::jsonb then raise exception 'delete needs a filter'; end if;
  execute format('with d as (delete from aos.%I where %s returning 1) select count(*) from d', p_table, aos._relay_where(p_table, p_filter)) into n;
  return n;
end $$;

revoke all on function aos._relay_check(text, text[]), aos._relay_where(text, jsonb) from public, anon, authenticated;
revoke all on function public.aos_relay_select(text, jsonb, int), public.aos_relay_upsert(text, jsonb, text, text),
  public.aos_relay_update(text, jsonb, jsonb), public.aos_relay_delete(text, jsonb) from public, anon, authenticated;
grant execute on function public.aos_relay_select(text, jsonb, int), public.aos_relay_upsert(text, jsonb, text, text),
  public.aos_relay_update(text, jsonb, jsonb), public.aos_relay_delete(text, jsonb) to service_role;
