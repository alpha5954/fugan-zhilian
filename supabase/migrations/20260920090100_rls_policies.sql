-- ============================================================================
-- 复感智联 · 智能评估系统 —— 行级安全策略（RLS）
-- 迁移 2/3：辅助函数、启用 RLS、策略、权限授权
-- ============================================================================
--
-- 【为什么前端拿着公开密钥也安全】
-- 前端的 anon / publishable key 会打包进 JS，谁都能看到。它本身不构成
-- 权限边界——真正的边界是这里定义的 RLS 策略。请求带上某个用户的 JWT 后，
-- Postgres 按 auth.uid() 逐行判断能不能读/写，密钥泄露本身无害。
--
-- 【一个必须先解决的坑：策略递归】
-- 要判断"我能不能看这个患者的数据"，得查 care_links；
-- 而 care_links 自己的策略又要查当前用户身份。两张表的策略互相引用，
-- Postgres 会抛 "infinite recursion detected in policy"。
-- 解法：把跨表判断封装成 security definer 函数。这类函数以属主
-- （postgres）身份执行，不触发被查表的 RLS，递归就断开了。
-- 下面所有策略一律只调用这些函数，不再直接查别的表。
--
-- ⚠️ security definer 函数必须显式 set search_path，否则调用者可以通过
--    伪造同名对象劫持函数内部的名称解析，越权访问。这是 Supabase 的
--    安全扫描会重点检查的项。
--
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 辅助函数
-- ---------------------------------------------------------------------------

-- 当前用户的角色
create or replace function public.my_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

comment on function public.my_role() is '当前登录用户的角色；security definer 以规避 profiles 的 RLS 递归';

-- 我是否是 p_patient 的活跃监护者（家属或治疗师）
create or replace function public.is_caregiver_of(p_patient uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.care_links
    where patient_id   = p_patient
      and caregiver_id = auth.uid()
      and status       = 'active'
  );
$$;

comment on function public.is_caregiver_of(uuid) is '当前用户是否为该患者的活跃监护者；只认 status=active，pending 不放行';

-- 反向：我是否是该监护者监护下的患者（用于让患者看到自己监护者的资料）
create or replace function public.is_patient_of(p_caregiver uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.care_links
    where caregiver_id = p_caregiver
      and patient_id   = auth.uid()
      and status       = 'active'
  );
$$;

comment on function public.is_patient_of(uuid) is '反向判断：当前用户是否是该监护者监护的患者';

-- 统一的"能不能看这个患者的数据"判断，业务表策略全部复用它
create or replace function public.can_access_patient(p_patient uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    p_patient is not null
    and (
      p_patient = auth.uid()               -- 本人
      or public.is_caregiver_of(p_patient) -- 活跃监护者
      or public.my_role() = 'admin'        -- 管理员
    );
$$;

comment on function public.can_access_patient(uuid) is '业务表读写策略的统一入口：本人 / 活跃监护者 / admin';


-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;

create policy profiles_select on public.profiles
  for select to authenticated
  using (
    id = auth.uid()
    or public.is_caregiver_of(id)
    or public.is_patient_of(id)
    or public.my_role() = 'admin'
  );

create policy profiles_insert on public.profiles
  for insert to authenticated
  with check (id = auth.uid());

create policy profiles_update on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- 不开放 delete：删用户走 Supabase Auth 的注销流程，级联删除由外键处理


-- ---------------------------------------------------------------------------
-- care_links
-- ---------------------------------------------------------------------------
alter table public.care_links enable row level security;

create policy care_links_select on public.care_links
  for select to authenticated
  using (
    patient_id = auth.uid()
    or caregiver_id = auth.uid()
    or public.my_role() = 'admin'
  );

-- 患者可以直接建立关系（active）；监护者只能发起申请（pending），
-- 必须等患者确认——否则任何人都能自己"贴"到别人身上读数据。
create policy care_links_insert on public.care_links
  for insert to authenticated
  with check (
    (patient_id = auth.uid()   and status in ('pending', 'active'))
    or
    (caregiver_id = auth.uid() and status = 'pending')
  );

create policy care_links_update on public.care_links
  for update to authenticated
  using (patient_id = auth.uid() or caregiver_id = auth.uid())
  with check (patient_id = auth.uid() or caregiver_id = auth.uid());

create policy care_links_delete on public.care_links
  for delete to authenticated
  using (patient_id = auth.uid() or caregiver_id = auth.uid());

-- 上面那条 update 策略允许双方各自更新，但"谁能把 pending 改成 active"
-- 无法用行级条件表达（同一行、同一策略）。用触发器补上这条规则。
create or replace function public.enforce_care_link_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 关系的两端不允许变更，否则等同于把一条已授权的记录偷换给别人
  if new.patient_id <> old.patient_id or new.caregiver_id <> old.caregiver_id then
    raise exception '监护关系的双方不可变更，请撤销后重新建立';
  end if;

  -- 只有患者本人有资格确认关系生效
  if new.status = 'active' and old.status is distinct from 'active' then
    if auth.uid() <> old.patient_id then
      raise exception '只有患者本人可以确认监护关系';
    end if;
  end if;

  return new;
end;
$$;

create trigger care_links_enforce_transition
  before update on public.care_links
  for each row execute function public.enforce_care_link_transition();


-- ---------------------------------------------------------------------------
-- devices
-- ---------------------------------------------------------------------------
alter table public.devices enable row level security;

create policy devices_select on public.devices
  for select to authenticated
  using (public.can_access_patient(owner_id));

create policy devices_insert on public.devices
  for insert to authenticated
  with check (owner_id = auth.uid());

create policy devices_update on public.devices
  for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy devices_delete on public.devices
  for delete to authenticated
  using (owner_id = auth.uid());

-- 注意：owner_id 为 null 的"未绑定设备"对普通用户不可见（can_access_patient
-- 对 null 返回 false）。设备认领流程后续需要单独做一个 security definer 的
-- RPC（按序列号绑定），不能靠放宽这里的选择策略来解决，否则会泄露全部设备序列号。


-- ---------------------------------------------------------------------------
-- rehab_sessions
-- ---------------------------------------------------------------------------
alter table public.rehab_sessions enable row level security;

create policy sessions_select on public.rehab_sessions
  for select to authenticated
  using (public.can_access_patient(patient_id));

create policy sessions_insert on public.rehab_sessions
  for insert to authenticated
  with check (patient_id = auth.uid());

create policy sessions_update on public.rehab_sessions
  for update to authenticated
  using (patient_id = auth.uid())
  with check (patient_id = auth.uid());

create policy sessions_delete on public.rehab_sessions
  for delete to authenticated
  using (patient_id = auth.uid());


-- ---------------------------------------------------------------------------
-- alerts
-- ---------------------------------------------------------------------------
alter table public.alerts enable row level security;

create policy alerts_select on public.alerts
  for select to authenticated
  using (public.can_access_patient(patient_id));

create policy alerts_insert on public.alerts
  for insert to authenticated
  with check (patient_id = auth.uid());

-- 家属和治疗师也能把告警标成已读——这是他们最常用的操作。
-- 能改的列由下面的列级授权限制为仅 acknowledged_at / acknowledged_by，
-- 防止有人把 critical 改成 info 把告警"降级"掉。
create policy alerts_update on public.alerts
  for update to authenticated
  using (public.can_access_patient(patient_id))
  with check (public.can_access_patient(patient_id));

create policy alerts_delete on public.alerts
  for delete to authenticated
  using (patient_id = auth.uid());


-- ---------------------------------------------------------------------------
-- keepalive
-- ---------------------------------------------------------------------------
-- 这张表要给匿名访问：保活心跳由外部的定时任务（GitHub Actions 之类）发起，
-- 它只持有公开密钥，没有用户身份。
--
-- 读写权限分离：匿名只能 SELECT，写入一律走迁移 3 里的 ping_keepalive()
-- 函数。那个函数是 security definer，绕开 RLS 执行，所以外部任务不需要
-- UPDATE 权限——权限收得更紧，也避免定时任务要"先读再写"算 ping_count。
-- ---------------------------------------------------------------------------
alter table public.keepalive enable row level security;

create policy keepalive_select on public.keepalive
  for select to anon, authenticated
  using (true);

-- 刻意不建 insert / update / delete 策略：没有策略即为拒绝。
-- 写入只走 ping_keepalive()。


-- ---------------------------------------------------------------------------
-- 权限授权
-- ---------------------------------------------------------------------------
-- ⚠️ 建项目时取消了 "Automatically expose new tables"，新建的表不会自动
--    授权给 anon / authenticated。以下 grant 是必需的——少了这些语句，
--    即使 RLS 策略写得完全正确，前端请求也会一律返回 403。
--
--    同理，以后新加表也要手动 grant，不能指望默认权限。

revoke all on public.profiles, public.care_links, public.devices,
              public.rehab_sessions, public.alerts
  from anon;

grant select, insert, update, delete on public.profiles       to authenticated;
grant select, insert, update, delete on public.care_links     to authenticated;
grant select, insert, update, delete on public.devices        to authenticated;
grant select, insert, update, delete on public.rehab_sessions to authenticated;
grant select, insert, update, delete on public.alerts         to authenticated;

revoke all on public.keepalive from anon, authenticated;
grant select on public.keepalive to anon, authenticated;

-- 列级授权：把"能改哪些列"收窄到业务真正需要的范围。
-- RLS 管的是"能改哪些行"，列级授权管的是"能改哪些列"，两者互补。
-- 这两条是防提权的关键：没有它们，患者可以自己把 role 改成 admin。

revoke update on public.profiles from authenticated;
grant  update (display_name, phone, birth_date) on public.profiles to authenticated;

revoke update on public.alerts from authenticated;
grant  update (acknowledged_at, acknowledged_by) on public.alerts to authenticated;
