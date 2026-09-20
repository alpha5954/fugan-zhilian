-- ============================================================================
-- 迁移 4：为 rehab_sessions 补充肌电 RMS 列
-- ============================================================================
--
-- 【为什么需要这一列】
-- 康复评估页每次都会算出肌电 RMS（均方根，肌肉激活强度的标准指标），
-- 也界面上展示了，但保存时没有写库 —— 建表时漏了这一列。
--
-- 事后无法补算：rehab_sessions.waveform 存的是**电阻**和**温度**，
-- 不是原始 sEMG。RMS 是肌电信号的统计量，从电阻波形反推不出来。
--
-- 而计划书的答题要求里，「均方根值（RMS）信号分析，用于肌肉活动强度评估」
-- 是明确点名的交付内容。数据分析页要做各动作的肌力对比，也依赖这个字段。
--
-- 【安全性】
-- 纯新增列，可空，无默认值。已有行该列为 null，不影响任何现有查询与策略。
-- 重复执行安全。
-- ============================================================================

alter table public.rehab_sessions
  add column if not exists rms_mv numeric(6, 4);

-- 约束单独加，便于重复执行（add column if not exists 不会重复加约束，
-- 但约束本身没有 if not exists 语法，所以用 do 块判断）
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'rehab_sessions_rms_nonneg'
      and conrelid = 'public.rehab_sessions'::regclass
  ) then
    alter table public.rehab_sessions
      add constraint rehab_sessions_rms_nonneg check (rms_mv is null or rms_mv >= 0);
  end if;
end
$$;

comment on column public.rehab_sessions.rms_mv is
  '本次训练的肌电均方根值（mV），肌肉激活强度指标';
