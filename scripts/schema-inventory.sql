-- Paste the whole SELECT into the Supabase SQL Editor.
-- It reads Postgres catalogs only. The output contains names, types, keys
-- and grants. It never reads table contents or function/view bodies.
with schemas as (
  select n.oid, n.nspname as schema_name
  from pg_catalog.pg_namespace n
  where n.nspname <> 'information_schema' and n.nspname !~ '^pg_'
),
relations as (
  select s.schema_name, c.oid, c.relname, c.relkind, c.relrowsecurity
  from schemas s
  join pg_catalog.pg_class c on c.relnamespace = s.oid
  where c.relkind in ('r', 'p', 'f', 'v', 'm')
),
app_relations as (
  select * from relations
  where schema_name = 'public' or schema_name ~ '^workspace(_|$)'
),
inventory as (
  -- Include managed schemas in the overview so their tables are recognizable.
  select 1 as section, s.schema_name, 'schema' as kind, s.schema_name as object_name,
    jsonb_build_object(
      'tables_and_views', coalesce(jsonb_agg(r.relname order by r.relname)
        filter (where r.oid is not null), '[]'::jsonb)
    ) as details
  from schemas s left join relations r using (schema_name)
  group by s.schema_name
  union all
  select 2, r.schema_name,
    case r.relkind when 'r' then 'table' when 'p' then 'partitioned table'
      when 'v' then 'view' when 'm' then 'materialized view' else 'foreign table' end,
    r.relname, jsonb_build_object(
      'columns', array(
        select a.attname || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod)
          || case when a.attnotnull then ' NOT NULL' else '' end
        from pg_catalog.pg_attribute a
        where a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
        order by a.attnum
      ),
      'keys', array(
        select pg_catalog.pg_get_constraintdef(k.oid)
        from pg_catalog.pg_constraint k
        where k.conrelid = r.oid and k.contype in ('p', 'u', 'f')
        order by k.contype, k.conname
      ),
      'indexes', array(
        select i.indexrelid::regclass::text from pg_catalog.pg_index i
        where i.indrelid = r.oid order by 1
      ),
      'row_level_security', case when r.relkind in ('r', 'p') then r.relrowsecurity end,
      'policy_names', array(
        select p.polname from pg_catalog.pg_policy p
        where p.polrelid = r.oid order by p.polname
      ),
      'table_grants', array(
        select role_name || ' ' || privilege_name
        from unnest(array['anon','authenticated','service_role']) as roles(role_name)
        cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) as grants(privilege_name)
        where has_table_privilege(role_name, r.oid, privilege_name)
        order by role_name, privilege_name
      )
    )
  from app_relations r
  union all
  select 3, s.schema_name, 'routine', p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')',
    jsonb_build_object(
      'security_definer', p.prosecdef,
      'executable_by', array(
        select role_name from unnest(array['anon','authenticated','service_role']) as roles(role_name)
        where has_function_privilege(role_name, p.oid, 'EXECUTE') order by role_name
      )
    )
  from schemas s join pg_catalog.pg_proc p on p.pronamespace = s.oid
  where (s.schema_name = 'public' or s.schema_name ~ '^workspace(_|$)')
    and not exists (
      select 1 from pg_catalog.pg_depend d
      where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
    )
)
select schema_name, kind, object_name, details
from inventory
order by section, schema_name, object_name;
