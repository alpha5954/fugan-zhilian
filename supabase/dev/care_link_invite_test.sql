-- ============================================================================
-- 监护邀请码的行为测试
-- ============================================================================
-- request_care_link 是 security definer 函数 —— 它在建立关系**之前**执行，
-- 那时家属看不到患者的任何资料，所以必须绕过 RLS。这类函数每一条分支都要
-- 验证：既要能正常建立申请，又不能被用来直接建立生效的关系、或探测他人账号。
--
-- 另外回填那段跑在真实数据库上时，面对的是既有用户（我们的测试账号），
-- 这里专门模拟一次「已有用户没有邀请码」的情况。
--
-- ⚠️ 注意：PERFORM 是 PL/pgSQL 语法，不能直接写在 SQL 脚本里。
--    要在测试脚本里调一个不用结果的函数，写 SELECT 即可。
--    写 PERFORM 会报 "syntax error at or near perform"，而报错位置
--    在下一行，很不好找。
-- ============================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 准备两个用户
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-aaaa-aaaa-aaaa-111111111111', 'p@t.local', '{"role":"patient"}'),
  ('22222222-bbbb-bbbb-bbbb-222222222222', 'c@t.local', '{"role":"family"}')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 断言工具
-- ---------------------------------------------------------------------------
create or replace function public.t_eq(p_label text, p_actual text, p_expect text)
returns text language plpgsql as $$
begin
  if p_actual is distinct from p_expect then
    return p_label || ' → FAIL（期望 ' || coalesce(p_expect, 'null') ||
           '，实际 ' || coalesce(p_actual, 'null') || '）';
  end if;
  return p_label || ' → PASS（' || coalesce(p_actual, 'null') || '）';
end $$;

create or replace function public.t_no(p_label text, p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return p_label || ' → FAIL（本应被拒绝，却执行成功）';
exception when others then
  return p_label || ' → PASS（已拒绝：' || sqlerrm || '）';
end $$;

-- security definer：下面要在「家属」身份下调用它取患者的邀请码，
-- 而 profiles 的 RLS 不允许家属在建立关系前读患者资料，普通函数会拿到 null。
-- 这只是测试辅助，真实流程里家属永远看不到别人的码。
create or replace function public.t_code()
returns text language sql stable security definer
set search_path = public as $$
  select invite_code from public.profiles
   where id = '11111111-aaaa-aaaa-aaaa-111111111111';
$$;

-- 注意参数个数要和定义一致：t_eq 是三个参数，写错个数会报
-- "function public.t_eq(text, text) does not exist"，而报错位置在 GRANT 上、
-- 看着像函数没建成功，容易误导。
grant execute on function
  public.t_eq(text, text, text),
  public.t_no(text, text),
  public.t_code()
  to authenticated;


-- ---------------------------------------------------------------------------
-- 1. 邀请码生成
-- ---------------------------------------------------------------------------
select public.t_eq('新用户自动获得邀请码（触发器）',
  (select case when invite_code is not null then '有' else '无' end
     from public.profiles where id = '11111111-aaaa-aaaa-aaaa-111111111111'),
  '有');

select public.t_eq('邀请码为 6 位',
  (select length(invite_code)::text from public.profiles
    where id = '11111111-aaaa-aaaa-aaaa-111111111111'),
  '6');

select public.t_eq('不含形近字符 IL0O1（要念给家人听）',
  (select case when invite_code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$'
               then '合规' else '含违规字符：' || invite_code end
     from public.profiles where id = '11111111-aaaa-aaaa-aaaa-111111111111'),
  '合规');

select public.t_eq('两人邀请码不同',
  (select case when (select count(distinct invite_code) from public.profiles) = 2
               then '不同' else '重复' end),
  '不同');


-- ---------------------------------------------------------------------------
-- 2. 回填（模拟真实库中已有用户没有码的情况）
-- ---------------------------------------------------------------------------
reset role;
update public.profiles set invite_code = null;

do $$
declare r record;
begin
  for r in select id from public.profiles where invite_code is null loop
    update public.profiles set invite_code = public.gen_invite_code() where id = r.id;
  end loop;
end $$;

select public.t_eq('回填后所有用户都有邀请码',
  (select case when count(*) filter (where invite_code is null) = 0
               then '全部有' else '仍有缺失' end from public.profiles),
  '全部有');

select public.t_eq('回填后仍然唯一',
  (select case when count(distinct invite_code) = count(*) then '唯一' else '重复' end
     from public.profiles),
  '唯一');


-- ---------------------------------------------------------------------------
-- 3. 发起申请（以家属身份）
-- ---------------------------------------------------------------------------
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"22222222-bbbb-bbbb-bbbb-222222222222","role":"authenticated"}';

  select public.t_eq('无效邀请码',
    (public.request_care_link('ZZZZZZ') ->> 'reason'), 'not_found');

  select public.t_eq('空邀请码',
    (public.request_care_link('   ') ->> 'reason'), 'invalid_code');

  -- 用患者自己的码，且申请人就是本人
  select public.t_eq('不能把自己加为监护对象',
    (public.request_care_link(
       (select invite_code from public.profiles
         where id = '22222222-bbbb-bbbb-bbbb-222222222222')) ->> 'reason'),
    'self');

  select public.t_eq('非法关系类型',
    (public.request_care_link(public.t_code(), 'stranger') ->> 'reason'),
    'invalid_relation');

  select public.t_eq('合法申请创建成功',
    (public.request_care_link(public.t_code(), 'family') ->> 'reason'), 'created');

  -- 大小写和空格都应当被容错
  select public.t_eq('重复申请返回 already_pending',
    (public.request_care_link(lower(public.t_code()), 'family') ->> 'reason'),
    'already_pending');
rollback;


-- ---------------------------------------------------------------------------
-- 4. 关键：申请只能创建 pending，不能直接生效
-- ---------------------------------------------------------------------------
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"22222222-bbbb-bbbb-bbbb-222222222222","role":"authenticated"}';
  select public.request_care_link(public.t_code(), 'family');
  reset role;

  select public.t_eq('★ 申请状态只能是 pending（不能自助生效）',
    (select status from public.care_links
      where caregiver_id = '22222222-bbbb-bbbb-bbbb-222222222222'),
    'pending');
rollback;


-- ---------------------------------------------------------------------------
-- 5. 重复申请与撤销后重新申请
-- ---------------------------------------------------------------------------
-- ⚠️ 切换身份要把 role 和 JWT claims **一起**切。只 reset role 而留着上一个
--    身份的 claims，auth.uid() 仍返回原来那个人 —— 触发器会以"你不是本人"
--    为由拒绝，看起来像功能坏了，实际是测试写错了。
begin;
  set local role authenticated;

  -- 家属发起申请
  set local request.jwt.claims = '{"sub":"22222222-bbbb-bbbb-bbbb-222222222222","role":"authenticated"}';
  select public.request_care_link(public.t_code(), 'family');

  -- 患者确认（换成患者的 claims）
  set local request.jwt.claims = '{"sub":"11111111-aaaa-aaaa-aaaa-111111111111","role":"authenticated"}';
  update public.care_links set status = 'active'
   where caregiver_id = '22222222-bbbb-bbbb-bbbb-222222222222';

  -- 家属再申请
  set local request.jwt.claims = '{"sub":"22222222-bbbb-bbbb-bbbb-222222222222","role":"authenticated"}';
  select public.t_eq('已生效时再次申请返回 already_active',
    (public.request_care_link(public.t_code(), 'family') ->> 'reason'), 'already_active');

  -- 患者撤销
  set local request.jwt.claims = '{"sub":"11111111-aaaa-aaaa-aaaa-111111111111","role":"authenticated"}';
  update public.care_links set status = 'revoked'
   where caregiver_id = '22222222-bbbb-bbbb-bbbb-222222222222';

  -- 家属重新申请
  set local request.jwt.claims = '{"sub":"22222222-bbbb-bbbb-bbbb-222222222222","role":"authenticated"}';
  select public.t_eq('撤销后可以重新申请（状态回到 pending）',
    (public.request_care_link(public.t_code(), 'family') ->> 'reason'), 'reopened');

  reset role;
  select public.t_eq('重新申请后确实是 pending',
    (select status from public.care_links
      where caregiver_id = '22222222-bbbb-bbbb-bbbb-222222222222'),
    'pending');
rollback;


-- ---------------------------------------------------------------------------
-- 6. 邀请码不可被本人修改
-- ---------------------------------------------------------------------------
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"11111111-aaaa-aaaa-aaaa-111111111111","role":"authenticated"}';
  -- 允许改的列：先改，再回读确认真的改到了
  update public.profiles set display_name = '新昵称'
   where id = '11111111-aaaa-aaaa-aaaa-111111111111';
  reset role;
  select public.t_eq('可以改昵称（列级授权内的列）',
    (select display_name from public.profiles
      where id = '11111111-aaaa-aaaa-aaaa-111111111111'),
    '新昵称');
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"11111111-aaaa-aaaa-aaaa-111111111111","role":"authenticated"}';

  -- 不允许改的列
  select public.t_no('不能改自己的邀请码（否则可冒用别人的码接收申请）',
    $q$ update public.profiles set invite_code = 'AAAAAA'
         where id = '11111111-aaaa-aaaa-aaaa-111111111111' $q$);
rollback;


-- ---------------------------------------------------------------------------
-- 7. 匿名不可调用
-- ---------------------------------------------------------------------------
begin;
  set local role anon;
  set local request.jwt.claims = '{"role":"anon"}';
  select public.t_no('匿名调用 request_care_link',
    $q$ select public.request_care_link('AAAAAA', 'family') $q$);
rollback;


-- ---------------------------------------------------------------------------
-- 清理
-- ---------------------------------------------------------------------------
drop function if exists public.t_eq(text,text);
drop function if exists public.t_no(text,text);
drop function if exists public.t_code();
