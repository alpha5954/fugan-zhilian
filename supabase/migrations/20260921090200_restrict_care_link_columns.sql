-- ============================================================================
-- 迁移 6：收窄 care_links 的可更新列
-- ============================================================================
--
-- 【发现的问题】
-- 端到端测试（supabase/dev/e2e_care_links.py）中：
--
--     家属可以把 care_links.relation 从 'family' 改成 'therapist'
--
-- 根因是权限只约束到了"行"这一层：
--   * RLS 策略 care_links_update 限定「只有关系双方能改这一行」
--   * 触发器 enforce_care_link_transition 只拦了 status 字段的非法跃迁
--   → relation 这一列没有任何保护
--
-- 【影响范围】
-- 已核查全部 RLS 策略：判定用的都是 status='active' 和 caregiver_id，
-- **没有一处读 relation**。所以这**不构成越权**——家属改完之后拿到的
-- 数据和不改完全一样。
--
-- 但它是数据完整性问题：家属可以自称"治疗师"，界面上会显示错误的身份标签。
-- 对一个面向医疗场景的产品，身份标识错误本身就不该被允许。
--
-- 【修法】
-- 与 profiles / alerts 用同样的手法：列级授权。RLS 管"能改哪些行"，
-- 列级授权管"能改哪些列"，两者互补。
--
-- 收窄到只剩 status：
--   * 家属仍可主动退出（改成 revoked）—— 这是合理需求
--   * 患者仍可确认/撤销（改成 active / revoked），触发器会拦住非患者本人
--   * relation / patient_id / caregiver_id 一律改不动
--
-- 关系类型填错了怎么办？撤销后重建。这比允许就地修改更安全 ——
-- 不然"改一下关系类型"就成了绕过确认流程的入口。
-- ============================================================================

revoke update on public.care_links from authenticated;
grant  update (status) on public.care_links to authenticated;

comment on column public.care_links.relation is
  '监护者与患者的关系。注册后不可变更（列级授权只开放 status），填错需撤销后重建';
