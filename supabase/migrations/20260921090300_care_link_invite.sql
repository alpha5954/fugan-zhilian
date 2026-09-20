-- ============================================================================
-- 迁移 7：监护邀请码
-- ============================================================================
--
-- 【为什么需要邀请码】
-- 家属要发起监护申请，必须知道患者的 user id —— 但客户端拿不到：
--   * profiles 表里没有 email（邮箱在 auth.users，不对客户端暴露）
--   * 就算加一列 email，RLS 也只允许看自己和已监护对象的资料，
--     家属在建立关系**之前**恰恰看不到患者
--
-- 自然的做法是「按邮箱查人」，但那会引入**邮箱枚举漏洞**：任何登录用户
-- 都能拿它逐个试探哪些邮箱注册过。Supabase 的注册接口刻意对已存在的邮箱
-- 返回假用户，就是为了堵这个口子 —— 我们不该在别处再开一个。
--
-- 所以用邀请码：患者在界面上看到一串 6 位码，通过微信之类发给子女，
-- 子女输入即可申请。既不暴露任何账号信息，也符合国内家庭类应用的习惯。
--
-- 【为什么用 security definer RPC】
-- 家属在建立关系前看不到患者的任何资料，所以「按邀请码找到患者」这一步
-- 必然要绕过 RLS。收敛成一个受控入口：函数自己校验码的有效性，只允许
-- **创建一条 pending 申请**，不能直接建立生效的关系，也不能读回患者资料。
-- 是否生效仍由患者本人在界面上确认。
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. profiles 增加邀请码列
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists invite_code text;

-- 唯一约束单独加，便于重复执行
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_invite_code_key'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles add constraint profiles_invite_code_key unique (invite_code);
  end if;
end
$$;

comment on column public.profiles.invite_code is
  '监护邀请码。患者把它发给家属，家属凭码发起监护申请';


-- ---------------------------------------------------------------------------
-- 2. 邀请码生成
-- ---------------------------------------------------------------------------
-- 字符集刻意去掉了 I / L / O / 0 / 1 —— 这串码是要念给家人听、
-- 或者手输的，形近字符会显著增加出错率。
-- 剩下 31 个字符，6 位约有 8.9 亿种组合，配合下面的唯一性重试足够。
create or replace function public.gen_invite_code()
returns text
language plpgsql
volatile
as $$
declare
  chars constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  code  text;
  i     int;
begin
  loop
    code := '';
    for i in 1..6 loop
      code := code || substr(chars, 1 + floor(random() * length(chars))::int, 1);
    end loop;

    -- 撞了重来。31^6 的取值空间下，重试几乎不会发生
    exit when not exists (select 1 from public.profiles where invite_code = code);
  end loop;
  return code;
end;
$$;


-- ---------------------------------------------------------------------------
-- 3. 回填已有用户
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in select id from public.profiles where invite_code is null loop
    update public.profiles set invite_code = public.gen_invite_code() where id = r.id;
  end loop;
end
$$;


-- ---------------------------------------------------------------------------
-- 4. 新用户自动获得邀请码
-- ---------------------------------------------------------------------------
-- 重写 handle_new_user：除原有的建档案外，多生成一个邀请码。
-- 注意这段必须在迁移 1 之后执行（那里第一次定义了同名函数）。
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, role, display_name, invite_code)
  values (
    new.id,
    case
      when new.raw_user_meta_data ->> 'role' in ('patient', 'family')
        then new.raw_user_meta_data ->> 'role'
      else 'patient'
    end,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'display_name', ''),
      split_part(coalesce(new.email, ''), '@', 1)
    ),
    public.gen_invite_code()
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

-- 注意：不要在一条 UPDATE 里对多行调用 gen_invite_code()。那函数内部会查
-- profiles 判重，而同一语句内先更新的行是否对它可见、取决于快照时机，
-- 容易出现两行拿到同一个码然后撞唯一约束。上面第 3 节的逐行循环是安全的。

-- 邀请码不允许被本人修改 —— 允许改就等于允许冒用别人的码去接收申请。
-- 列级授权只开放原有的三列，invite_code 天然不在其中，这里只是显式声明意图。
revoke update on public.profiles from authenticated;
grant  update (display_name, phone, birth_date) on public.profiles to authenticated;


-- ---------------------------------------------------------------------------
-- 5. 按邀请码发起监护申请
-- ---------------------------------------------------------------------------
create or replace function public.request_care_link(
  p_code     text,
  p_relation text default 'family'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_patient  uuid;
  v_relation text := coalesce(nullif(btrim(p_relation), ''), 'family');
  v_link_id  uuid;
  -- 所有变量都在函数顶部声明。plpgsql 允许在 IF 内嵌 BEGIN...DECLARE 块，
  -- 但那样可读性差、也容易在缩进上出错，不如集中声明。
  v_status   text;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated',
                              'message', '请先登录');
  end if;

  if v_relation not in ('family', 'therapist') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_relation',
                              'message', '关系类型只能是家属或治疗师');
  end if;

  if p_code is null or btrim(p_code) = '' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_code',
                              'message', '请输入邀请码');
  end if;

  -- 统一大写并去掉空格 —— 用户手输时很容易带上空格或写成小写
  select id into v_patient
    from public.profiles
   where invite_code = upper(replace(btrim(p_code), ' ', ''));

  if v_patient is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found',
                              'message', '邀请码无效，请与对方核对');
  end if;

  if v_patient = v_uid then
    return jsonb_build_object('ok', false, 'reason', 'self',
                              'message', '不能添加自己为监护对象');
  end if;

  -- 已存在关系？区分对待，给出准确提示而不是撞唯一约束报错
  select id into v_link_id
    from public.care_links
   where patient_id = v_patient and caregiver_id = v_uid;

  if v_link_id is not null then
    select status into v_status from public.care_links where id = v_link_id;

    if v_status = 'active' then
      return jsonb_build_object('ok', true, 'reason', 'already_active',
                                'message', '你们已经建立了监护关系');
    elsif v_status = 'pending' then
      return jsonb_build_object('ok', true, 'reason', 'already_pending',
                                'message', '申请已提交，等待对方确认');
    else
      -- 曾经被撤销，允许重新申请：把状态改回 pending
      update public.care_links set status = 'pending' where id = v_link_id;
      return jsonb_build_object('ok', true, 'reason', 'reopened',
                                'message', '已重新提交申请，等待对方确认');
    end if;
  end if;

  -- 只能创建 pending —— 是否生效由患者本人在界面上确认。
  -- 这一点与 care_links_insert 策略一致，是防越权的关键。
  insert into public.care_links (patient_id, caregiver_id, relation, status)
  values (v_patient, v_uid, v_relation, 'pending')
  returning id into v_link_id;

  return jsonb_build_object('ok', true, 'reason', 'created', 'id', v_link_id,
                            'message', '申请已提交，请等待对方在系统中确认');
end;
$$;

comment on function public.request_care_link(text, text) is
  '凭邀请码向患者发起监护申请，只能创建 pending 状态；是否生效由患者本人确认';

revoke all on function public.request_care_link(text, text) from public;
grant execute on function public.request_care_link(text, text) to authenticated;
