-- ============================================================================
-- 设备认领 RPC 的行为测试
-- ============================================================================
-- claim_device 是 security definer 函数 —— 它绕过 RLS 执行。这类函数是
-- 权限体系里最危险的一环：写错一行就能让任何人把别人的设备夺过来。
-- 所以必须逐条验证它的每个分支，尤其是"不许抢别人设备"这一条。
-- ============================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 准备：两个用户、三台设备
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('aaaaaaaa-1111-1111-1111-111111111111', 'a@test.local', '{"role":"patient"}'),
  ('bbbbbbbb-2222-2222-2222-222222222222', 'b@test.local', '{"role":"patient"}')
on conflict (id) do nothing;

insert into public.devices (id, serial_no, owner_id, status, firmware) values
  ('d0000001-0000-0000-0000-000000000001', 'DEV-A-001',
   'aaaaaaaa-1111-1111-1111-111111111111', 'online', '1.0.0'),
  ('d0000002-0000-0000-0000-000000000002', 'DEV-B-001',
   'bbbbbbbb-2222-2222-2222-222222222222', 'online', '1.0.0'),
  ('d0000003-0000-0000-0000-000000000003', 'DEV-FREE-001',
   null, 'offline', '1.0.0')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 测试工具
-- ---------------------------------------------------------------------------
create or replace function public.test_claim(
  p_label text, p_serial text, p_expect_ok boolean, p_expect_reason text
) returns text language plpgsql as $$
declare r jsonb;
begin
  r := public.claim_device(p_serial);
  if (r->>'ok')::boolean = p_expect_ok
     and (p_expect_reason is null or r->>'reason' = p_expect_reason) then
    return p_label || ' → PASS（' || (r->>'reason') || '：' || (r->>'message') || '）';
  end if;
  return p_label || ' → FAIL（期望 ok=' || p_expect_ok || ' reason=' ||
         coalesce(p_expect_reason, '任意') || '，实际 ok=' || (r->>'ok') ||
         ' reason=' || (r->>'reason') || '）';
end $$;

create or replace function public.test_owner(p_serial text)
returns text language sql stable as $$
  select coalesce(owner_id::text, '(无主)') from public.devices where serial_no = p_serial;
$$;

grant execute on function public.test_claim(text, text, boolean, text) to authenticated;
grant execute on function public.test_owner(text) to authenticated;

-- 断言某段 SQL 会抛错。
-- 注意不能用裸的 begin/exception —— 那是 PL/pgSQL 语法，写在 SQL 脚本里会
-- 报 "syntax error at or near perform"。必须包在函数里。
create or replace function public.test_denied(p_label text, p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return p_label || ' → FAIL（本应被拒绝，却执行成功）';
exception when others then
  return p_label || ' → PASS（已拒绝：' || sqlerrm || '）';
end $$;


-- ---------------------------------------------------------------------------
-- 以患者A 的身份操作
-- ---------------------------------------------------------------------------
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-1111-1111-1111-111111111111","role":"authenticated"}';

  select public.test_claim('A 认领无主设备', 'DEV-FREE-001', true, 'claimed');
  select '  DEV-FREE-001 现在的归属' as 检查, public.test_owner('DEV-FREE-001') as 实际;

  select public.test_claim('A 重复认领自己的设备（幂等）', 'DEV-FREE-001', true, 'already_owned');
  select public.test_claim('A 认领自己的另一台设备', 'DEV-A-001', true, 'already_owned');

  -- ⚠️ 最关键的一条：不许把别人的设备夺过来
  select public.test_claim('A 试图认领 B 的设备（必须失败）', 'DEV-B-001', false, 'taken');
  select '  B 的设备归属未被改动' as 检查, public.test_owner('DEV-B-001') as 实际;

  select public.test_claim('A 认领不存在的序列号', 'NO-SUCH-DEVICE', false, 'not_found');
  select public.test_claim('A 提交空序列号', '   ', false, 'invalid_serial');
  select public.test_claim('A 提交 null 序列号', null, false, 'invalid_serial');

  select 'A 可见的设备数（应为 2：自己的两台）' as 检查,
         (select count(*)::text from public.devices) as 实际;
rollback;


-- ---------------------------------------------------------------------------
-- 解绑 → 重新认领的完整闭环（这正是当初的死胡同）
-- ---------------------------------------------------------------------------
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-1111-1111-1111-111111111111","role":"authenticated"}';

  -- 解绑：认领成功后产生的设备，把它置回无主
  reset role;
  update public.devices set owner_id = null where serial_no = 'DEV-FREE-001';

  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-1111-1111-1111-111111111111","role":"authenticated"}';

  select '解绑后设备对 A 不可见（RLS 过滤，符合预期）' as 检查,
         (select count(*)::text from public.devices where serial_no = 'DEV-FREE-001') as 实际;

  select public.test_claim('解绑后能重新认领（不再死胡同）', 'DEV-FREE-001', true, 'claimed');
  select '  重新认领后的归属' as 检查, public.test_owner('DEV-FREE-001') as 实际;
rollback;


-- ---------------------------------------------------------------------------
-- 未登录用户：不该能探测设备序列号
-- ---------------------------------------------------------------------------
begin;
  set local role anon;
  set local request.jwt.claims = '{"role":"anon"}';
  -- anon 没有 EXECUTE 授权，调用应当直接报权限错误而非返回 ok=false
  select public.test_denied('匿名调用 claim_device',
                            $q$ select public.claim_device('DEV-FREE-001') $q$);
  select public.test_denied('匿名读 devices',
                            $q$ select count(*) from public.devices $q$);
rollback;


-- ---------------------------------------------------------------------------
-- 清理
-- ---------------------------------------------------------------------------
drop function if exists public.test_claim(text, text, boolean, text);
drop function if exists public.test_owner(text);
drop function if exists public.test_denied(text, text);
