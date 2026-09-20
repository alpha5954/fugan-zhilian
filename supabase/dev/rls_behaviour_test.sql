-- ============================================================================
-- RLS 行为测试：模拟真实用户身份，验证策略真的拦得住
-- ============================================================================
-- 元数据检查（策略存在、授权存在）只能证明"写进去了"，
-- 证明不了"拦得住"。这个脚本用 SET ROLE + 伪造 JWT 身份实际跑一遍。
-- ============================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 准备：造四个用户，其中一个试图在注册时把自己写成 admin
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'patient.a@test.local', '{"role":"patient","display_name":"患者A"}'),
  ('22222222-2222-2222-2222-222222222222', 'patient.b@test.local', '{"role":"patient","display_name":"患者B"}'),
  ('33333333-3333-3333-3333-333333333333', 'family.c@test.local',  '{"role":"family","display_name":"家属C"}'),
  ('44444444-4444-4444-4444-444444444444', 'evil@test.local',      '{"role":"admin","display_name":"越权尝试者"}')
on conflict (id) do nothing;

select '测试0：注册触发器自动建档，且 role 白名单拦住提权' as 测试,
       case when count(*) = 4 then 'PASS' else 'FAIL' end as 结果
from public.profiles;

select id, role, display_name
from public.profiles order by display_name;

select '测试0b：越权者注册时带 role=admin，应被降级为 patient' as 测试,
       case when (select role from public.profiles
                  where id = '44444444-4444-4444-4444-444444444444') = 'patient'
            then 'PASS' else 'FAIL' end as 结果;


-- ---------------------------------------------------------------------------
-- 测试工具
-- ---------------------------------------------------------------------------
-- 以指定身份执行一段 SQL，断言它"应该成功"或"应该被拒绝"。
-- 这两个函数临时建在 public 下，脚本末尾会删掉。
-- （原本想放 pg_temp，但 pg_temp 只是别名，GRANT 语句不认，
--   而 authenticated 角色需要 schema USAGE 权限才能调用，只好放 public。）
-- ---------------------------------------------------------------------------
create or replace function public.test_expect_ok(p_label text, p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return p_label || ' → PASS';
exception when others then
  return p_label || ' → FAIL（本应成功，却报错：' || sqlerrm || '）';
end $$;

create or replace function public.test_expect_denied(p_label text, p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return p_label || ' → FAIL（本应被拒绝，却执行成功）';
exception when others then
  return p_label || ' → PASS（已拒绝：' || sqlerrm || '）';
end $$;

-- ⚠️ 关键区别：RLS 对 SELECT / UPDATE 是「静默过滤」，不抛异常——
--    查别人的数据返回空集，改别人的数据影响 0 行。
--    这两种情况必须用行数断言，用 expect_denied 会误判为 FAIL。
create or replace function public.test_expect_rows(p_label text, p_sql text, p_expected int)
returns text language plpgsql as $$
declare v_cnt int;
begin
  execute 'select count(*) from (' || p_sql || ') t' into v_cnt;
  if v_cnt = p_expected then
    return p_label || ' → PASS（返回 ' || v_cnt || ' 行）';
  else
    return p_label || ' → FAIL（期望 ' || p_expected || ' 行，实际 ' || v_cnt || ' 行）';
  end if;
end $$;

create or replace function public.test_expect_affected(p_label text, p_sql text, p_expected int)
returns text language plpgsql as $$
declare v_cnt int;
begin
  execute p_sql;
  get diagnostics v_cnt = row_count;
  if v_cnt = p_expected then
    return p_label || ' → PASS（影响 ' || v_cnt || ' 行）';
  else
    return p_label || ' → FAIL（期望影响 ' || p_expected || ' 行，实际 ' || v_cnt || ' 行）';
  end if;
end $$;



-- ---------------------------------------------------------------------------
-- 以患者A 的身份操作
-- ---------------------------------------------------------------------------
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

  select public.test_expect_ok('A 为自己插入训练记录', $q$
    insert into public.rehab_sessions (patient_id, exercise, started_at, rep_count)
    values ('11111111-1111-1111-1111-111111111111', '直腿抬高', now(), 10)
  $q$);

  select public.test_expect_denied('A 为患者B 插入训练记录（冒名写入）', $q$
    insert into public.rehab_sessions (patient_id, exercise, started_at)
    values ('22222222-2222-2222-2222-222222222222', '伪造记录', now())
  $q$);

  select public.test_expect_denied('A 把自己提权成 admin（列级授权应拦住）', $q$
    update public.profiles set role = 'admin'
     where id = '11111111-1111-1111-1111-111111111111'
  $q$);

  select public.test_expect_ok('A 修改自己的昵称（允许的列）', $q$
    update public.profiles set display_name = '患者甲'
     where id = '11111111-1111-1111-1111-111111111111'
  $q$);

  select public.test_expect_rows('A 读自己的资料', $q$
    select * from public.profiles where id = '11111111-1111-1111-1111-111111111111'
  $q$, 1);

  -- RLS 对 SELECT 是静默过滤：查得到 0 行，但不报错
  select public.test_expect_rows('A 读患者B 的资料（应返回空集）', $q$
    select * from public.profiles where id = '22222222-2222-2222-2222-222222222222'
  $q$, 0);

  select 'A 看到的 profiles 行数（应为 1）' as 检查,
         (select count(*)::text from public.profiles) as 实际;
rollback;


-- ---------------------------------------------------------------------------
-- 以家属C 的身份操作
-- ---------------------------------------------------------------------------
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';

  select public.test_expect_ok('C 发起对 A 的监护申请（pending）', $q$
    insert into public.care_links (patient_id, caregiver_id, relation, status)
    values ('11111111-1111-1111-1111-111111111111',
            '33333333-3333-3333-3333-333333333333', 'family', 'pending')
  $q$);

  select public.test_expect_denied('C 直接把自己设为 active（跳过患者确认）', $q$
    insert into public.care_links (patient_id, caregiver_id, relation, status)
    values ('22222222-2222-2222-2222-222222222222',
            '33333333-3333-3333-3333-333333333333', 'family', 'active')
  $q$);

  select public.test_expect_denied('C 在自己发起的申请上直接改成 active（触发器应拦住）', $q$
    update public.care_links set status = 'active'
     where caregiver_id = '33333333-3333-3333-3333-333333333333'
  $q$);

  select 'pending 状态下 C 看到的 A 的训练记录数（应为 0）' as 检查,
         (select count(*)::text from public.rehab_sessions
           where patient_id = '11111111-1111-1111-1111-111111111111') as 实际;
rollback;


-- ---------------------------------------------------------------------------
-- 患者A 确认监护关系后，家属C 应能看到 A 的数据
-- ---------------------------------------------------------------------------
begin;
  -- 先由 A 建立一条 active 关系
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
  insert into public.rehab_sessions (patient_id, exercise, started_at, rep_count)
  values ('11111111-1111-1111-1111-111111111111', '坐位伸膝', now(), 12);

  -- 补一条告警，否则下面 C 的"标记已读"会影响 0 行、测试形同虚设
  insert into public.alerts (patient_id, kind, severity, message, value, threshold)
  values ('11111111-1111-1111-1111-111111111111', 'temp_high', 'critical',
          '热敷温度超标', 48.5, 45.0);

  insert into public.care_links (patient_id, caregiver_id, relation, status)
  values ('11111111-1111-1111-1111-111111111111',
          '33333333-3333-3333-3333-333333333333', 'family', 'active');

  reset role;

  -- 换 C 的身份
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';

  select 'active 后 C 能看到 A 的训练记录（应为 1）' as 检查,
         (select count(*)::text from public.rehab_sessions
           where patient_id = '11111111-1111-1111-1111-111111111111') as 实际;

  select public.test_expect_affected('C 标记 A 的告警为已读（应影响 1 行）', $q$
    update public.alerts set acknowledged_at = now()
     where patient_id = '11111111-1111-1111-1111-111111111111'
  $q$, 1);

  select public.test_expect_denied('C 篡改告警等级 critical→info（列级授权应拦住）', $q$
    update public.alerts set severity = 'info'
     where patient_id = '11111111-1111-1111-1111-111111111111'
  $q$);

  -- RLS 对 UPDATE 同样是静默过滤：影响 0 行，但不报错
  select public.test_expect_affected('C 修改 A 的资料（监护者只读，应影响 0 行）', $q$
    update public.profiles set display_name = '被改了'
     where id = '11111111-1111-1111-1111-111111111111'
  $q$, 0);
rollback;


-- ---------------------------------------------------------------------------
-- 匿名角色：只能读心跳、调 ping，不能碰业务表
-- ---------------------------------------------------------------------------
begin;
  set local role anon;
  set local request.jwt.claims = '{"role":"anon"}';

  select '匿名可读 keepalive' as 检查,
         (select count(*)::text from public.keepalive) as 实际;

  select '匿名调用 ping_keepalive 的返回' as 检查,
         public.ping_keepalive()::text as 实际;

  select public.test_expect_denied('匿名直接 UPDATE keepalive（无权限）', $q$
    update public.keepalive set last_ping = now()
  $q$);

  select public.test_expect_denied('匿名读 profiles（业务表不该开放）', $q$
    select * from public.profiles
  $q$);
rollback;


-- ---------------------------------------------------------------------------
-- 清理测试函数
-- ---------------------------------------------------------------------------
drop function if exists public.test_expect_ok(text, text);
drop function if exists public.test_expect_denied(text, text);
drop function if exists public.test_expect_rows(text, text, int);
drop function if exists public.test_expect_affected(text, text, int);
