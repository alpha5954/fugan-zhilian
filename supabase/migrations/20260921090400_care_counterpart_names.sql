-- ============================================================================
-- 迁移 8：监护关系对方姓名
-- ============================================================================
--
-- 【为什么需要它】
-- profiles_select 策略放行的是「自己 + **已生效**关系的对方」，因为
-- is_caregiver_of / is_patient_of 都要求 status='active'。
--
-- 于是申请的**待确认阶段**双方互相看不见：
--   * 患者收到一条申请，但不知道是谁提交的 —— 没法决定批不批
--   * 家属提交后，列表里只显示「等待确认」，不知道申请的是谁
--
-- 【为什么不直接放宽 profiles_select】
-- 最省事的做法是让策略也放行 pending 关系。但那等于：任何人只要拿到一个
-- 邀请码、提交一次申请，就能读到对方的**完整资料行** —— 包括手机号和
-- 出生日期。邀请码是患者主动分享的，出示姓名给对方是合理的，但连带
-- 手机号、出生日期一起暴露就过头了。
--
-- 【做法】
-- 收成一个只返回姓名的函数：SECURITY DEFINER 绕过 RLS，但**返回值里
-- 只有 display_name**，不返回任何其他字段，也无法用来遍历别人的资料
-- （函数内部限定只看与调用者相关的关系行）。
-- ============================================================================

create or replace function public.get_care_counterparts()
returns table (
  link_id        uuid,
  counterpart_id uuid,
  display_name   text
)
language sql
stable
security definer
set search_path = public
as $$
  select cl.id,
         case when cl.patient_id = auth.uid()
              then cl.caregiver_id
              else cl.patient_id
         end as counterpart_id,
         p.display_name
    from public.care_links cl
    join public.profiles p
      on p.id = case when cl.patient_id = auth.uid()
                     then cl.caregiver_id
                     else cl.patient_id
                end
   where cl.patient_id = auth.uid()
      or cl.caregiver_id = auth.uid();
$$;

comment on function public.get_care_counterparts() is
  '返回当前用户所有监护关系（含待确认）中对方的 user id 与显示名。只暴露姓名，不暴露其他字段';

-- 只授权给已登录用户。匿名无从谈起监护关系
revoke all on function public.get_care_counterparts() from public;
grant execute on function public.get_care_counterparts() to authenticated;
