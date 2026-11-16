-- Rollback for 0029. Removes the MCP reader policies, grants and role.
do $$
declare
  r record;
begin
  for r in
    select schemaname, tablename, policyname from pg_policies
    where policyname like '% mcp reader select'
  loop
    execute format('drop policy if exists %I on %I.%I',
      r.policyname, r.schemaname, r.tablename);
  end loop;
end;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'ninja_mcp_reader') then
    revoke all on all tables in schema public from ninja_mcp_reader;
    revoke usage on schema public from ninja_mcp_reader;
    drop role ninja_mcp_reader;
  end if;
end;
$$;
