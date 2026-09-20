-- ============================================================================
-- RLS 与权限核对脚本（不是迁移文件，不会被 supabase db push 执行）
-- ============================================================================
-- ⚠️ 这是**明细版**：Supabase SQL Editor 只渲染最后一条语句的结果，
--    整段贴进去你只能看到第 7 段。想做一次性核对请用 verify_summary.sql，
--    那个把关键检查合并成了单条 SELECT。
--    本文件适合**分段选中执行**，逐段看明细。
--
-- 第 7 段会真的写数据（就是心跳本身，无副作用）。
-- ============================================================================
--
-- ⚠️ 写应用代码时必须知道的一点：RLS 的拒绝方式分两种
--
--   【抛异常】INSERT 违反 WITH CHECK、以及列级授权不足
--            → 客户端收到 error，supabase-js 会走 error 分支
--   【静默过滤】SELECT 查不到别人的行 → 返回空数组，没有 error
--              UPDATE 改不到别人的行 → 影响 0 行，没有 error
--
--   后者不会报错！如果代码写成
--       await supabase.from('profiles').update({...}).eq('id', id)
--   然后假定"没报错就是改成功了"，在无权修改时会安静地什么都不做。
--   凡是 UPDATE / DELETE，都要检查 affected rows 或改用 .select() 回读确认。
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. 表是否建全、RLS 是否开启
-- ---------------------------------------------------------------------------
-- 期望：6 行，rls_on 全为 true
-- 注：这两个字段在 pg_class 上，pg_tables 视图里没有
select c.relname  as tablename,
       c.relrowsecurity      as rls_on,
       c.relforcerowsecurity as force_rls
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
order by c.relname;


-- ---------------------------------------------------------------------------
-- 2. 策略清单
-- ---------------------------------------------------------------------------
-- 期望：keepalive 只有 1 条 select 策略（刻意不建写策略）；
--       其余各表的策略数与迁移 2 中定义的一致
select tablename, policyname, cmd, roles::text as roles
from pg_policies
where schemaname = 'public'
order by tablename, cmd, policyname;


-- ---------------------------------------------------------------------------
-- 3. 表级授权
-- ---------------------------------------------------------------------------
-- 期望：anon 只在 keepalive 上有 SELECT；
--       authenticated 在 5 张业务表上有完整权限
select table_name,
       grantee,
       string_agg(privilege_type, ', ' order by privilege_type) as privs
from information_schema.table_privileges
where table_schema = 'public'
  and grantee in ('anon', 'authenticated')
group by table_name, grantee
order by table_name, grantee;


-- ---------------------------------------------------------------------------
-- 4. 列级授权 —— 防提权的关键
-- ---------------------------------------------------------------------------
-- 只看做过列级收窄的这两张表。期望 5 行：
--   alerts   → acknowledged_at / acknowledged_by
--   profiles → birth_date / display_name / phone
--
-- 如果 profiles 这里出现了 role，说明列级授权没生效，
-- 患者就能把自己的 role 改成 admin。
--
-- 注：上面第 3 段里 profiles 和 alerts 没有表级 UPDATE，那是正确现象——
-- revoke + grant(列) 会把表级权限整个拿掉，只剩列级。
-- 其余三张表（care_links / devices / rehab_sessions）是表级 UPDATE，
-- 在 information_schema 里会展开成所有列，所以这里把它们排除掉，避免噪音。
select table_name, column_name
from information_schema.column_privileges
where table_schema = 'public'
  and grantee = 'authenticated'
  and privilege_type = 'UPDATE'
  and table_name in ('profiles', 'alerts')
order by table_name, column_name;


-- ---------------------------------------------------------------------------
-- 5. 函数清单
-- ---------------------------------------------------------------------------
-- 期望：my_role / is_caregiver_of / is_patient_of / can_access_patient /
--       enforce_care_link_transition / handle_new_user / ping_keepalive
--       的 security_definer 均为 true（touch_updated_at 除外，它不需要）
select p.proname,
       p.prosecdef    as security_definer,
       p.provolatile  as volatility
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
order by p.proname;


-- ---------------------------------------------------------------------------
-- 6. 触发器
-- ---------------------------------------------------------------------------
-- 期望：profiles / care_links / devices 各一条 touch_updated_at，
--       care_links 一条 enforce_care_link_transition，
--       auth.users 一条 on_auth_user_created
select event_object_schema as schema,
       event_object_table  as tbl,
       trigger_name,
       action_timing,
       event_manipulation
from information_schema.triggers
where event_object_schema in ('public', 'auth')
order by schema, tbl, trigger_name;


-- ---------------------------------------------------------------------------
-- 7. 心跳表与 ping 函数（这一段会写数据）
-- ---------------------------------------------------------------------------
select * from public.keepalive;

select public.ping_keepalive();   -- 期望返回 {"last_ping": "...", "ping_count": 1}

select * from public.keepalive;   -- 期望 ping_count 变成 1


-- ---------------------------------------------------------------------------
-- 8.（可选）模拟普通用户身份，验证 RLS 真的拦得住
-- ---------------------------------------------------------------------------
-- 光看策略定义不够，最好实际以低权限身份跑一次查询。
-- 把 <患者A的uuid> / <患者B的uuid> 换成 profiles 表里两个真实用户的 id
-- （没有用户的话，先去 Authentication → Users 手动建两个，
--   触发器会自动为他们生成 profiles 记录）。
--
-- 期望：以 A 的身份只能查到 A 自己的训练记录，B 的查不到，条数为 0。
-- ---------------------------------------------------------------------------

-- begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<患者A的uuid>","role":"authenticated"}';
--
--   select auth.uid() as 当前身份;                                     -- 应为 A
--   select count(*) from public.rehab_sessions;                        -- 只含 A 的
--   select count(*) from public.rehab_sessions
--    where patient_id = '<患者B的uuid>';                               -- 期望 0
--   select count(*) from public.profiles;                              -- 应看不到 B
-- rollback;   -- 回滚，不留痕迹
