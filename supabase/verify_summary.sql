-- ============================================================================
-- 一屏核对：所有关键检查项合并成单条 SELECT
-- ============================================================================
-- 为什么要有这个文件：Supabase SQL Editor 只渲染**最后一条语句**的结果，
-- 逐段版的 verify_rls.sql 贴进去只能看到第 7 段。这里把所有检查合并成
-- 一条查询，一次 Run 就能看全。
--
-- 想看明细（策略清单、函数清单等）再用 verify_rls.sql 逐段选中执行。
--
-- 期望输出：18 行。序号 1-14 与 16-18 的结果列应全部 PASS；
-- 第 15 行是 INFO，只列出 public 下所有 security definer 函数供辨认，不参与判断。
-- ============================================================================

with
-- 表与 RLS 开关
tbl as (
  select count(*)                                  as total,
         count(*) filter (where c.relrowsecurity)  as rls_on
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
),
-- 策略
pol as (
  select count(*)                                        as total,
         count(*) filter (where tablename = 'keepalive') as ka_count
  from pg_policies
  where schemaname = 'public'
),
-- 匿名角色在业务表上的权限（应为 0）
anon_on_biz as (
  select count(*) as n
  from information_schema.table_privileges
  where table_schema = 'public'
    and grantee = 'anon'
    and table_name <> 'keepalive'
),
-- profiles 可被 authenticated 更新的列
prof_cols as (
  select coalesce(string_agg(column_name, ',' order by column_name), '(无)') as cols
  from information_schema.column_privileges
  where table_schema = 'public' and grantee = 'authenticated'
    and privilege_type = 'UPDATE' and table_name = 'profiles'
),
-- alerts 可被 authenticated 更新的列
alert_cols as (
  select coalesce(string_agg(column_name, ',' order by column_name), '(无)') as cols
  from information_schema.column_privileges
  where table_schema = 'public' and grantee = 'authenticated'
    and privilege_type = 'UPDATE' and table_name = 'alerts'
),
-- 本项目自己建的 8 个 security definer 函数是否齐全。
-- 刻意不数"总数"——Supabase 自己也会在 public 下装辅助函数
-- （比如启用自动 RLS 时的 rls_auto_enable），数总数会误报。
sd_mine as (
  select count(*) as n
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef
    and p.proname in (
      'my_role', 'is_caregiver_of', 'is_patient_of', 'can_access_patient',
      'enforce_care_link_transition', 'handle_new_user', 'ping_keepalive',
      'claim_device')
),
-- 信息行：public 下所有 security definer 函数，用于辨认多出来的那些
sd_all as (
  select count(*) as n,
         coalesce(string_agg(p.proname, ', ' order by p.proname), '(无)') as names
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef
),
-- 关键触发器（用 pg_trigger 而非 information_schema.triggers，
-- 后者看不见非本人拥有的 auth.users 上的触发器）
trgs as (
  select count(distinct t.tgname) as n
  from pg_trigger t
  join pg_class c     on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where not t.tgisinternal
    and (
      (n.nspname = 'public' and t.tgname in (
        'profiles_touch_updated_at',
        'care_links_touch_updated_at',
        'devices_touch_updated_at',
        'care_links_enforce_transition'))
      or (n.nspname = 'auth' and t.tgname = 'on_auth_user_created')
    )
),
-- keepalive 种子行
ka as (
  select count(*) as n from public.keepalive where id = 1
),
-- ping_keepalive 是否对匿名可执行
ka_exec as (
  select count(*) as n
  from information_schema.routine_privileges
  where routine_schema = 'public'
    and routine_name = 'ping_keepalive'
    and grantee = 'anon'
    and privilege_type = 'EXECUTE'
),
-- 迁移 4 新增的肌电 RMS 列
rms_col as (
  select coalesce(
    (select data_type || '(' || numeric_precision || ',' || numeric_scale || ')'
     from information_schema.columns
     where table_schema = 'public' and table_name = 'rehab_sessions'
       and column_name = 'rms_mv'),
    '(缺失)'
  ) as spec
)

select 1 as 序号, 'public 下恰好 6 张表' as 检查项,
       case when tbl.total = 6 then 'PASS' else 'FAIL' end as 结果,
       tbl.total || ' 张' as 实际
from tbl
union all
select 2, '6 张表全部启用 RLS',
       case when tbl.rls_on = 6 then 'PASS' else 'FAIL' end,
       tbl.rls_on || ' 张已启用'
from tbl
union all
select 3, 'RLS 策略总数 = 20',
       case when pol.total = 20 then 'PASS' else 'FAIL' end,
       pol.total || ' 条'
from pol
union all
select 4, 'keepalive 只有 1 条策略（刻意不建写策略）',
       case when pol.ka_count = 1 then 'PASS' else 'FAIL' end,
       pol.ka_count || ' 条'
from pol
union all
select 5, 'anon 在业务表上无任何权限',
       case when anon_on_biz.n = 0 then 'PASS' else 'FAIL' end,
       anon_on_biz.n || ' 项授权'
from anon_on_biz
union all
select 6, 'anon 在 keepalive 上有 SELECT',
       case when exists (
              select 1 from information_schema.table_privileges
              where table_schema = 'public' and grantee = 'anon'
                and table_name = 'keepalive' and privilege_type = 'SELECT')
            then 'PASS' else 'FAIL' end,
       '—'
union all
select 7, 'profiles 列级 UPDATE 仅 3 列',
       case when prof_cols.cols = 'birth_date,display_name,phone'
            then 'PASS' else 'FAIL' end,
       prof_cols.cols
from prof_cols
union all
select 8, 'profiles 的 role 列不可更新（防提权）',
       case when prof_cols.cols not like '%role%' then 'PASS' else 'FAIL' end,
       case when prof_cols.cols like '%role%' then '❌ role 可被改！' else '已排除' end
from prof_cols
union all
select 9, 'alerts 列级 UPDATE 仅 2 列',
       case when alert_cols.cols = 'acknowledged_at,acknowledged_by'
            then 'PASS' else 'FAIL' end,
       alert_cols.cols
from alert_cols
union all
select 10, 'alerts 的 severity 列不可更新',
       case when alert_cols.cols not like '%severity%' then 'PASS' else 'FAIL' end,
       case when alert_cols.cols like '%severity%' then '❌ severity 可被改！' else '已排除' end
from alert_cols
union all
select 11, '本项目 8 个 security definer 函数齐全',
       case when sd_mine.n = 8 then 'PASS' else 'FAIL' end,
       sd_mine.n || '/8 个'
from sd_mine
union all
select 12, '关键触发器 = 5 个',
       case when trgs.n = 5 then 'PASS' else 'FAIL' end,
       trgs.n || ' 个'
from trgs
union all
select 13, 'keepalive 种子行存在',
       case when ka.n = 1 then 'PASS' else 'FAIL' end,
       ka.n || ' 行'
from ka
union all
select 14, 'ping_keepalive 对 anon 可执行',
       case when ka_exec.n = 1 then 'PASS' else 'FAIL' end,
       ka_exec.n || ' 项授权'
from ka_exec
union all
-- 信息行，不参与判断：列出 public 下全部 security definer 函数，
-- 便于辨认哪些是 Supabase 自己装的、哪些是本项目建的
select 15, '【信息】public 下全部 security definer 函数',
       'INFO',
       sd_all.n || ' 个：' || sd_all.names
from sd_all
union all
-- 迁移 4：肌电 RMS 列。缺了它数据分析页的肌力对比拿不到数据
select 16, 'rehab_sessions.rms_mv 存在且为 numeric(6,4)',
       case when rms_col.spec = 'numeric(6,4)' then 'PASS' else 'FAIL' end,
       rms_col.spec
from rms_col
union all
-- 迁移 5：设备认领 RPC。缺了它设备解绑后就再也绑不回来
select 17, 'claim_device 可被 authenticated 调用',
       case when (select count(*) from information_schema.routine_privileges
                  where routine_schema = 'public' and routine_name = 'claim_device'
                    and grantee = 'authenticated' and privilege_type = 'EXECUTE') = 1
            then 'PASS' else 'FAIL' end,
       '—'
union all
-- 反向断言：匿名不该能探测设备序列号
select 18, 'claim_device 对 anon 不可调用（防序列号探测）',
       case when (select count(*) from information_schema.routine_privileges
                  where routine_schema = 'public' and routine_name = 'claim_device'
                    and grantee = 'anon' and privilege_type = 'EXECUTE') = 0
            then 'PASS' else 'FAIL' end,
       '—';

-- ============================================================================
-- 第 7 段那个心跳写入这里没重复做，避免每次核对都把 ping_count 加一。
-- 想验证的话单独跑：  select public.ping_keepalive();
-- ============================================================================
