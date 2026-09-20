-- ============================================================================
-- 监护关系的权限边界测试
-- ============================================================================
-- 这套策略是全项目最复杂的一处权限设计，保护对象（患者健康数据）也比
-- 设备序列号敏感得多。这里在本地把每一条边界都过一遍。
--
-- 其中「家属改 relation」一条是端到端测试在真实环境里发现的真实缺陷：
-- RLS 只约束了"能改哪一行"，触发器只拦了 status，relation 无人看管。
-- 迁移 6 用列级授权把可更新列收窄到只有 status。
-- ============================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 准备
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('aaaaaaaa-1111-1111-1111-111111111111', 'p@t.local', '{"role":"patient"}'),
  ('cccccccc-3333-3333-3333-333333333333', 'c@t.local', '{"role":"family"}')
on conflict (id) do nothing;

insert into public.care_links (id, patient_id, caregiver_id, relation, status) values
  ('e0000001-0000-0000-0000-000000000001',
   'aaaaaaaa-1111-1111-1111-111111111111',
   'cccccccc-3333-3333-3333-333333333333', 'family', 'pending')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 断言工具
-- ---------------------------------------------------------------------------
create or replace function public.t_ok(p_label text, p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return p_label || ' → PASS';
exception when others then
  return p_label || ' → FAIL（本应成功，却报错：' || sqlerrm || '）';
end $$;

create or replace function public.t_no(p_label text, p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return p_label || ' → FAIL（本应被拒绝，却执行成功）';
exception when others then
  return p_label || ' → PASS（已拒绝：' || sqlerrm || '）';
end $$;

grant execute on function public.t_ok(text, text), public.t_no(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 以家属身份
-- ---------------------------------------------------------------------------
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"cccccccc-3333-3333-3333-333333333333","role":"authenticated"}';

  -- 迁移 6 修的就是这一条
  select public.t_no('家属改 relation 为 therapist',
    $q$ update public.care_links set relation = 'therapist'
         where id = 'e0000001-0000-0000-0000-000000000001' $q$);

  select public.t_no('家属把监护对象换成别人（改 patient_id）',
    $q$ update public.care_links set patient_id = 'cccccccc-3333-3333-3333-333333333333'
         where id = 'e0000001-0000-0000-0000-000000000001' $q$);

  select public.t_ok('家属退出监护（改 status=revoked，应允许）',
    $q$ update public.care_links set status = 'revoked'
         where id = 'e0000001-0000-0000-0000-000000000001' $q$);

  -- 触发器负责的那条：列级授权放行了 status，但语义上只有患者能批准
  select public.t_no('家属自己批准关系（改 status=active）',
    $q$ update public.care_links set status = 'active'
         where id = 'e0000001-0000-0000-0000-000000000001' $q$);
rollback;

-- ---------------------------------------------------------------------------
-- 以患者身份
-- ---------------------------------------------------------------------------
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-1111-1111-1111-111111111111","role":"authenticated"}';

  select public.t_ok('患者确认关系（改 status=active，应允许）',
    $q$ update public.care_links set status = 'active'
         where id = 'e0000001-0000-0000-0000-000000000001' $q$);

  -- 列级授权对所有人一致，患者也改不了 relation。
  -- 这是刻意的：允许就地改关系类型，等于给了绕过确认流程的入口
  select public.t_no('患者也改不了 relation（填错需撤销重建）',
    $q$ update public.care_links set relation = 'therapist'
         where id = 'e0000001-0000-0000-0000-000000000001' $q$);
rollback;

-- ---------------------------------------------------------------------------
-- 清理
-- ---------------------------------------------------------------------------
drop function if exists public.t_ok(text, text);
drop function if exists public.t_no(text, text);
