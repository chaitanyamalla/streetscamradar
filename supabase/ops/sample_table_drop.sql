-- Removes the proof-of-access table created by sample_table.sql.
drop table if exists public.claude_access_check;
select 'DROPPED' as step,
       not exists (
         select 1 from information_schema.tables
          where table_schema = 'public' and table_name = 'claude_access_check'
       ) as confirmed_gone;
