-- 迁移是否都已应用 —— 精简版，专为快速粘贴
-- 完整核对（含策略、触发器、授权明细）见 verify_summary.sql
select * from (
  select 1 as 项, '6 张表已建且启用 RLS' as 检查,
         case when (select count(*) from pg_class c
                    join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relkind = 'r'
                      and c.relrowsecurity) = 6
              then 'PASS' else 'FAIL' end as 结果
  union all select 2, '迁移2: RLS 策略 20 条',
         case when (select count(*) from pg_policies
                    where schemaname = 'public') = 20
              then 'PASS' else 'FAIL' end
  union all select 3, '迁移4: rehab_sessions.rms_mv numeric(6,4)',
         case when exists (select 1 from information_schema.columns
                           where table_schema = 'public' and table_name = 'rehab_sessions'
                             and column_name = 'rms_mv' and data_type = 'numeric'
                             and numeric_precision = 6 and numeric_scale = 4)
              then 'PASS' else 'FAIL' end
  union all select 4, '迁移5: claim_device 函数存在',
         case when exists (select 1 from pg_proc p
                           join pg_namespace n on n.oid = p.pronamespace
                           where n.nspname = 'public' and p.proname = 'claim_device')
              then 'PASS' else 'FAIL' end
  union all select 5, '迁移5: claim_device 已授权给 authenticated',
         case when (select count(*) from information_schema.routine_privileges
                    where routine_schema = 'public' and routine_name = 'claim_device'
                      and grantee = 'authenticated' and privilege_type = 'EXECUTE') = 1
              then 'PASS' else 'FAIL' end
  union all select 6, '迁移5: claim_device 未授权给 anon',
         case when (select count(*) from information_schema.routine_privileges
                    where routine_schema = 'public' and routine_name = 'claim_device'
                      and grantee = 'anon' and privilege_type = 'EXECUTE') = 0
              then 'PASS' else 'FAIL' end
  union all select 7, '迁移6: care_links 仅 status 列可更新',
         case when (select string_agg(column_name, ',' order by column_name)
                    from information_schema.column_privileges
                    where table_schema = 'public' and grantee = 'authenticated'
                      and privilege_type = 'UPDATE' and table_name = 'care_links') = 'status'
              then 'PASS' else 'FAIL' end
  union all select 8, '迁移7: profiles.invite_code 存在且有唯一约束',
         case when exists (select 1 from information_schema.columns
                           where table_schema = 'public' and table_name = 'profiles'
                             and column_name = 'invite_code')
               and exists (select 1 from pg_constraint
                           where conname = 'profiles_invite_code_key'
                             and conrelid = 'public.profiles'::regclass)
              then 'PASS' else 'FAIL' end
  union all select 9, '迁移7: 所有用户都有邀请码',
         case when (select count(*) from public.profiles where invite_code is null) = 0
              then 'PASS' else 'FAIL' end
  union all select 10, '迁移7: request_care_link 已授权给 authenticated',
         case when (select count(*) from information_schema.routine_privileges
                    where routine_schema = 'public' and routine_name = 'request_care_link'
                      and grantee = 'authenticated' and privilege_type = 'EXECUTE') = 1
              then 'PASS' else 'FAIL' end
  union all select 11, '迁移8: get_care_counterparts 已授权给 authenticated',
         case when (select count(*) from information_schema.routine_privileges
                    where routine_schema = 'public' and routine_name = 'get_care_counterparts'
                      and grantee = 'authenticated' and privilege_type = 'EXECUTE') = 1
              then 'PASS' else 'FAIL' end
  union all select 12, '迁移9: rehab_sessions.hold_deg numeric(5,2) 且可空',
         case when exists (select 1 from information_schema.columns
                           where table_schema = 'public' and table_name = 'rehab_sessions'
                             and column_name = 'hold_deg' and data_type = 'numeric'
                             and numeric_precision = 5 and numeric_scale = 2
                             and is_nullable = 'YES')
              then 'PASS' else 'FAIL' end
  union all select 13, '迁移9: hold_deg 部分索引已建',
         case when exists (select 1 from pg_indexes
                           where schemaname = 'public'
                             and indexname = 'rehab_sessions_hold_idx')
              then 'PASS' else 'FAIL' end
) t order by 项;
