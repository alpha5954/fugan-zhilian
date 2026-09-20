-- ============================================================================
-- 迁移 5：设备认领 RPC
-- ============================================================================
--
-- 【解决什么问题】
-- 解绑设备时把 owner_id 置 null（而不是删行，为了保留历史训练记录对设备的
-- 关联）。但 devices_select 策略用 can_access_patient(owner_id) 判定可见性，
-- 而它对这个 null 返回 false —— 于是**未绑定设备对任何普通用户都不可见**。
--
-- 结果是一个死胡同：用户解绑后想重新绑定，无论走 SELECT 还是 UPDATE 都够不到
-- 那一行，序列号又受唯一约束保护、不能重复插入。设备就此永久孤立。
--
-- 【为什么必须用 security definer】
-- 认领的前提是"能看见未绑定的设备"，而这恰恰是 RLS 要挡住的东西。
-- 如果为此放宽 devices_select，就会把全部设备序列号和状态暴露给所有人。
-- 正确做法是把这个动作收敛成一个受控入口：函数以属主身份执行、绕过 RLS，
-- 但内部自己做完整的校验，只放行"把无主设备绑到自己名下"这一种操作。
--
-- 【已知的信息泄露】
-- 该函数会区分"设备不存在"与"设备已被他人绑定"，这等于允许探测某个序列号
-- 是否存在于系统中。对当前场景可接受（序列号不是敏感信息，且需要已登录）。
-- 若将来序列号可预测、或设备量级很大，应改为统一返回"无法绑定"。
-- ============================================================================

create or replace function public.claim_device(p_serial text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id    uuid;
  v_owner uuid;
  v_serial text;
begin
  -- 未登录直接拒绝。security definer 函数绕过 RLS，这一步是它自己的门禁
  if auth.uid() is null then
    return jsonb_build_object(
      'ok', false, 'reason', 'not_authenticated', 'message', '请先登录后再绑定设备'
    );
  end if;

  v_serial := btrim(coalesce(p_serial, ''));
  if v_serial = '' then
    return jsonb_build_object(
      'ok', false, 'reason', 'invalid_serial', 'message', '请填写设备序列号'
    );
  end if;

  select id, owner_id into v_id, v_owner
    from public.devices
   where serial_no = v_serial;

  if v_id is null then
    return jsonb_build_object(
      'ok', false, 'reason', 'not_found', 'message', '系统中没有这个序列号的设备'
    );
  end if;

  if v_owner = auth.uid() then
    return jsonb_build_object(
      'ok', true, 'reason', 'already_owned', 'id', v_id,
      'message', '该设备已经在你的账号下'
    );
  end if;

  -- 别人名下的设备不许抢。这里必须显式判断 —— 下面的 UPDATE 若不限定
  -- owner_id is null，就能把别人的设备夺过来。
  if v_owner is not null then
    return jsonb_build_object(
      'ok', false, 'reason', 'taken', 'message', '该设备已被其他账号绑定'
    );
  end if;

  update public.devices
     set owner_id = auth.uid()
   where id = v_id
     and owner_id is null;   -- 双重保险：并发下两个请求同时认领，只有一个能成功

  if not found then
    -- 走到这里说明上面那条 select 与这条 update 之间，设备被别人抢先绑走了
    return jsonb_build_object(
      'ok', false, 'reason', 'taken', 'message', '该设备刚刚被其他账号绑定'
    );
  end if;

  return jsonb_build_object(
    'ok', true, 'reason', 'claimed', 'id', v_id, 'message', '绑定成功'
  );
end;
$$;

comment on function public.claim_device(text) is
  '按序列号把无主设备绑定到当前用户。security definer 绕过 RLS，内部自校验所有权';

-- 默认所有函数对 PUBLIC 开放 EXECUTE，先收回再精确授权。
-- 刻意**不授权给 anon** —— 未登录用户不应能探测设备序列号。
revoke all on function public.claim_device(text) from public;
grant execute on function public.claim_device(text) to authenticated;
