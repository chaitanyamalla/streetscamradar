-- The parts of Supabase that schema.sql is written against, in miniature.
-- Only what it touches: the users table, the three roles, and auth.uid().
create extension if not exists pgcrypto;
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  -- varchar(255), NOT text, because that is what Supabase's auth.users has.
  -- The difference is not cosmetic: a plpgsql function that declares an OUT
  -- column as `text` and returns this one fails with "structure of query does
  -- not match function result type" — on the real database only. A shim that
  -- says `text` here makes every such function pass locally and fail live,
  -- which is exactly what happened to admin_members.
  email character varying(255),
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
-- Who the current request is. Supabase reads it from the JWT; here a session
-- setting stands in, which is all the schema's policies and functions use it for.
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;
grant usage on schema public to anon, authenticated, service_role;
-- What a Supabase project starts with. The REVOKE lines in schema.sql are
-- written against this, so without it every privilege assertion in the test
-- below would pass simply because nothing was ever granted.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
