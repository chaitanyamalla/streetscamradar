-- ---------------------------------------------------------------------------
-- A throwaway table, purely to prove the GitHub Actions -> Supabase path works
-- end to end: create, write, read back, and report.
-- Drop it afterwards with supabase/ops/sample_table_drop.sql.
-- ---------------------------------------------------------------------------
create table if not exists public.claude_access_check (
  id         bigserial primary key,
  note       text not null,
  created_at timestamptz not null default now()
);

-- Not reachable by the website: no policies, and no grants to the public roles.
alter table public.claude_access_check enable row level security;
revoke all on table public.claude_access_check from anon, authenticated;

insert into public.claude_access_check (note)
values ('written from GitHub Actions by Claude');

select 'TABLE CREATED'                    as step,
       count(*)                           as rows_now,
       max(created_at)::text              as written_at
  from public.claude_access_check;

select 'READ BACK'    as step, id, note, created_at
  from public.claude_access_check
 order by id desc limit 3;

-- And a look at the real schema, to confirm this is your actual database.
select 'YOUR SCHEMA' as step, table_name
  from information_schema.tables
 where table_schema = 'public'
 order by table_name;
