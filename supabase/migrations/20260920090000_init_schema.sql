-- ============================================================================
-- 复感智联 · 智能评估系统 —— 基础表结构
-- 迁移 1/3：建表、索引、updated_at 触发器、新用户自动建档
-- ============================================================================
--
-- 表间关系概览：
--
--   auth.users ──1:1── profiles          用户资料与角色
--                        │
--                        ├── care_links ── 患者 ↔ 家属/治疗师 的多对多监护关系
--                        │
--                        ├── devices ───── 柔性传感器设备，归属某位患者
--                        │
--                        ├── rehab_sessions ── 一次康复训练记录（含波形）
--                        │        │
--                        └── alerts ──────── 预警事件（温度超标、动作异常等）
--                                 └─ session_id 可回溯到触发它的那次训练
--
-- ============================================================================


-- ---------------------------------------------------------------------------
-- profiles：用户资料
-- ---------------------------------------------------------------------------
-- 主键直接复用 auth.users.id，不做代理键。这样所有业务表引用 patients 时
-- 引用的就是 auth.uid()，RLS 策略里可以少一层 join。
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  role         text not null default 'patient'
                 check (role in ('patient', 'family', 'therapist', 'admin')),
  display_name text,
  phone        text,
  birth_date   date,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table  public.profiles      is '用户资料，主键与 auth.users.id 一一对应';
comment on column public.profiles.role is '角色：patient 患者 / family 家属 / therapist 治疗师 / admin 管理员';


-- ---------------------------------------------------------------------------
-- care_links：患者 ↔ 家属/治疗师 的监护关系
-- ---------------------------------------------------------------------------
-- 家属远程查看患者数据、治疗师跟踪康复进度，都靠这张表授权。
-- RLS 策略不认 role 字段，只认这里有没有一条 status='active' 的记录——
-- 角色决定"这个人是干什么的"，关联关系才决定"这个人能看谁的数据"。
--
-- 一条记录的生命周期：pending（待患者确认）→ active（生效）→ revoked（已解除）
-- 家属/治疗师可以自己发起（insert 时把 caregiver_id 设为自己），
-- 但只有患者本人能把 status 改成 active。
-- ---------------------------------------------------------------------------
create table if not exists public.care_links (
  id          uuid primary key default gen_random_uuid(),
  patient_id  uuid not null references public.profiles(id) on delete cascade,
  caregiver_id uuid not null references public.profiles(id) on delete cascade,
  relation    text not null default 'family'
                check (relation in ('family', 'therapist')),
  status      text not null default 'pending'
                check (status in ('pending', 'active', 'revoked')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint care_links_unique_pair unique (patient_id, caregiver_id),
  -- 不能自己监护自己
  constraint care_links_no_self     check (patient_id <> caregiver_id)
);

comment on table public.care_links is '患者与家属/治疗师的监护关系，RLS 凭此放行跨用户读取';


-- ---------------------------------------------------------------------------
-- devices：柔性传感器设备
-- ---------------------------------------------------------------------------
create table if not exists public.devices (
  id           uuid primary key default gen_random_uuid(),
  serial_no    text not null unique,
  owner_id     uuid references public.profiles(id) on delete set null,
  model        text not null default 'FSIFSTS',
  status       text not null default 'offline'
                 check (status in ('online', 'offline', 'maintenance')),
  battery_pct  smallint check (battery_pct between 0 and 100),
  firmware     text,
  last_seen_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table  public.devices           is '柔性应变-温度双模式传感器设备';
comment on column public.devices.model     is '设备型号，FSIFSTS 为项目自研型号';
comment on column public.devices.owner_id  is '归属患者；设备解绑时置 null 而非删行，保留历史训练记录的关联';


-- ---------------------------------------------------------------------------
-- rehab_sessions：康复训练记录
-- ---------------------------------------------------------------------------
-- 两种数据粒度并存：
--   * 标量列（rep_count / rom_deg / confidence …）—— 画趋势图用，可索引可聚合
--   * waveform（jsonb）—— 画单次训练曲线用，降采样后存
--
-- waveform 用「列式」结构而不是「行式」，体积能小一半以上，且正好是
-- ECharts 直接吃的格式：
--   {"t_ms": [0, 20, 40, ...], "r_ohm": [1024.5, ...], "temp_c": [...]}
-- 三个数组长度必须一致，索引 i 对应同一时刻。
-- 建议降采样到 1000 点以内再存，写入前在应用层做体积检查。
-- 这里刻意不加 pg_column_size 的 CHECK 约束——该函数是 stable 而非
-- immutable，放进约束会导致建表直接报错。
-- ---------------------------------------------------------------------------
create table if not exists public.rehab_sessions (
  id           uuid primary key default gen_random_uuid(),
  patient_id   uuid not null references public.profiles(id) on delete cascade,
  device_id    uuid references public.devices(id) on delete set null,

  joint        text not null default 'knee'
                 check (joint in ('knee', 'shoulder', 'elbow', 'wrist', 'ankle')),
  exercise     text not null,              -- 实际执行的康复动作（患者所选）
  recognized   text,                       -- 双向 LSTM 判定的动作，与上者不一致即识别偏差

  started_at   timestamptz not null,
  ended_at     timestamptz,
  duration_s   integer check (duration_s >= 0),

  rep_count    smallint check (rep_count >= 0),
  rom_deg      numeric(5, 2),              -- 关节活动度（度）
  temp_c       numeric(4, 2),              -- 该次训练期间的局部皮温峰值
  confidence   numeric(4, 3) check (confidence >= 0 and confidence <= 1),

  waveform     jsonb,
  notes        text,
  created_at   timestamptz not null default now(),

  constraint rehab_sessions_time_order check (ended_at is null or ended_at >= started_at)
);

comment on table  public.rehab_sessions            is '一次康复训练记录';
comment on column public.rehab_sessions.exercise   is '患者实际执行的动作';
comment on column public.rehab_sessions.recognized is 'LSTM 模型判定的动作，与 exercise 不一致说明动作可能不标准';
comment on column public.rehab_sessions.waveform   is '降采样波形，列式 jsonb：{t_ms:[], r_ohm:[], temp_c:[]}';


-- ---------------------------------------------------------------------------
-- alerts：预警事件
-- ---------------------------------------------------------------------------
-- 覆盖三类真实场景：热敷温度超标、康复动作异常、设备离线。
-- 家属手机收到的推送、App 里的红点提醒，数据源都是这张表。
-- ---------------------------------------------------------------------------
create table if not exists public.alerts (
  id           uuid primary key default gen_random_uuid(),
  patient_id   uuid not null references public.profiles(id) on delete cascade,
  device_id    uuid references public.devices(id) on delete set null,
  session_id   uuid references public.rehab_sessions(id) on delete set null,

  kind         text not null
                 check (kind in ('temp_high', 'temp_low', 'motion_abnormal',
                                 'device_offline', 'low_compliance')),
  severity     text not null default 'warning'
                 check (severity in ('info', 'warning', 'critical')),
  message      text,
  value        numeric,                    -- 触发时的实测值
  threshold    numeric,                    -- 当时的阈值，便于事后解释为什么报警

  occurred_at      timestamptz not null default now(),
  acknowledged_at  timestamptz,
  acknowledged_by  uuid references public.profiles(id) on delete set null,
  created_at       timestamptz not null default now()
);

comment on table  public.alerts           is '预警事件';
comment on column public.alerts.kind      is 'temp_high 温度超标 / temp_low 温度过低 / motion_abnormal 动作异常 / device_offline 设备离线 / low_compliance 依从性不足';
comment on column public.alerts.threshold is '触发阈值。存下来而不只存实测值，是为了事后能解释"当时为什么报"';


-- ---------------------------------------------------------------------------
-- keepalive：保活心跳
-- ---------------------------------------------------------------------------
-- Supabase 免费版项目连续 7 天无活动会被暂停。外部定时任务定期 update
-- 这一行即可维持活跃。刻意设计成只能有一行（id 恒为 1），避免数据堆积。
-- ---------------------------------------------------------------------------
create table if not exists public.keepalive (
  id        smallint primary key default 1 check (id = 1),
  last_ping timestamptz not null default now(),
  ping_count bigint not null default 0,
  note      text
);

comment on table public.keepalive is '外部定时任务的心跳表，用于防止免费版项目被暂停';


-- ---------------------------------------------------------------------------
-- 索引
-- ---------------------------------------------------------------------------
-- 查询模式基本都是"按患者取最近 N 条"，所以索引一律带上时间列做降序。
-- ---------------------------------------------------------------------------
create index if not exists idx_care_links_patient   on public.care_links (patient_id) where status = 'active';
create index if not exists idx_care_links_caregiver on public.care_links (caregiver_id) where status = 'active';

create index if not exists idx_devices_owner        on public.devices (owner_id);

create index if not exists idx_sessions_patient_time on public.rehab_sessions (patient_id, started_at desc);
create index if not exists idx_sessions_device       on public.rehab_sessions (device_id);

create index if not exists idx_alerts_patient_time   on public.alerts (patient_id, occurred_at desc);
-- 未处理的告警是首页要优先展示的，用部分索引把已确认的排除在外
create index if not exists idx_alerts_unacked        on public.alerts (patient_id, occurred_at desc)
                                                       where acknowledged_at is null;


-- ---------------------------------------------------------------------------
-- updated_at 自动维护
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

create trigger care_links_touch_updated_at
  before update on public.care_links
  for each row execute function public.touch_updated_at();

create trigger devices_touch_updated_at
  before update on public.devices
  for each row execute function public.touch_updated_at();


-- ---------------------------------------------------------------------------
-- 注册时自动建档
-- ---------------------------------------------------------------------------
-- 用户在 auth.users 里注册成功后，自动往 profiles 插一条对应记录——
-- 否则每个新用户第一次打开 App 都会因为查不到自己的 profile 而白屏。
--
-- ⚠️ role 不能直接照抄前端传来的 raw_user_meta_data：
--    那个字段是客户端可控的，攻击者注册时带上 {"role":"admin"} 就能提权。
--    所以这里只白名单放行 patient / family，therapist 和 admin 必须由
--    后台手动提升，线上注册无法自助获得。
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, role, display_name)
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
    )
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
