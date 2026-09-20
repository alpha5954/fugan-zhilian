-- ============================================================================
-- 复感智联 · 智能评估系统 —— 保活心跳
-- 迁移 3/3：种子数据 + ping 函数
-- ============================================================================
--
-- 【背景】
-- Supabase 免费版项目连续 7 天没有活动会被自动暂停，恢复要手动操作。
-- 外部定时任务（GitHub Actions）定期调一次 ping_keepalive() 即可维持活跃。
--
-- 【为什么封装成函数而不是直接 UPDATE】
--   1. 权限更紧：匿名角色只需要 EXECUTE，不需要表的 UPDATE 权限
--   2. 调用方更简单：一次请求完成"读当前值 → +1 → 写回"，不用先查后写
--      （先查后写并发时会丢计数）
--   3. 换实现不用改调用方
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 种子数据
-- ---------------------------------------------------------------------------
insert into public.keepalive (id, last_ping, ping_count, note)
values (1, now(), 0, '初始记录，由迁移 20260920090200 插入')
on conflict (id) do nothing;


-- ---------------------------------------------------------------------------
-- ping_keepalive()：原子心跳
-- ---------------------------------------------------------------------------
-- 用 upsert 一条语句完成，并发调用不会丢计数。
-- security definer 使其绕开 RLS 执行——这正是匿名角色无需 UPDATE 权限的原因。
-- ---------------------------------------------------------------------------
create or replace function public.ping_keepalive()
returns jsonb
language sql
security definer
set search_path = public
as $$
  with upserted as (
    insert into public.keepalive (id, last_ping, ping_count, note)
    values (1, now(), 1, '由 ping_keepalive 自动补建')
    on conflict (id) do update
      set last_ping  = now(),
          ping_count = keepalive.ping_count + 1
    returning last_ping, ping_count
  )
  select jsonb_build_object(
    'last_ping',  last_ping,
    'ping_count', ping_count
  )
  from upserted;
$$;

comment on function public.ping_keepalive() is '外部定时任务的保活心跳，原子自增计数；匿名可调用';

-- 默认所有函数对 PUBLIC 开放 EXECUTE，这里先收回再精确授权。
revoke all on function public.ping_keepalive() from public;
grant execute on function public.ping_keepalive() to anon, authenticated;
