-- ============================================================================
-- 模拟 Supabase 托管环境的最小骨架（仅用于本地验证迁移，不属于项目交付物）
-- ============================================================================
-- 原生的 postgres 镜像里没有 Supabase 提供的这些东西，需要自己补出来，
-- 否则迁移里的 auth.users / auth.uid() / anon / authenticated 都会报不存在。
-- ============================================================================

-- ---------- auth schema ----------
create schema if not exists auth;

-- auth.users：只保留迁移和触发器用到的列
create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

-- auth.uid()：从会话变量里取当前用户 id。
-- Supabase 真实实现会先看 request.jwt.claim.sub 这个旧式单值变量，
-- 再回退到 request.jwt.claims 里的 sub 字段。这里只实现后者
-- ——迁移代码只用 auth.uid()，两种实现对外行为一致。
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;

-- auth.role()：Supabase 也有这个函数，一并补上以备后用
create or replace function auth.role()
returns text
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
$$;

-- ---------- anon / authenticated 角色 ----------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
end
$$;

-- Supabase 默认就有这两条 schema 级授权
grant usage on schema public to anon, authenticated;
grant usage on schema auth   to anon, authenticated;
