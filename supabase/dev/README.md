# 本地数据库验证环境

用 Docker 起一个原生 PostgreSQL，把 Supabase 托管环境的最小骨架补出来，用来在**不影响线上库**的前提下验证迁移和 RLS 策略。

## 为什么需要它

Supabase 控制台的 SQL Editor 是唯一能直接改线上库的地方，但两个问题：

1. **改错了要手工收拾**。表建歪了、策略写错了，得自己写 `drop` 清理
2. **元数据检查证明不了策略真的拦得住**。"策略存在"和"策略生效"是两回事——RLS 写得对不对，只有拿低权限身份实际跑一次查询才知道

本地跑一遍的成本只有几十秒，比在线上试错便宜得多。

## 前置

Docker Desktop 需要在运行。验证用的镜像：

```bash
docker pull postgres:17-alpine    # Supabase 当前也是 PG17，版本对得上
```

## 用法

```bash
# 1. 起容器
docker rm -f fugan-pgtest 2>/dev/null
docker run -d --name fugan-pgtest \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=fugan_test \
  -p 55432:5432 postgres:17-alpine

# 2. 建 Supabase 骨架 + 按序应用迁移
for f in supabase/dev/00_supabase_stub.sql supabase/migrations/*.sql; do
  docker exec -i fugan-pgtest psql -U postgres -d fugan_test -v ON_ERROR_STOP=1 -q < "$f"
done

# 3. 跑 RLS 行为测试
docker exec -i fugan-pgtest psql -U postgres -d fugan_test < supabase/dev/rls_behaviour_test.sql

# 4. 用完清理
docker rm -f fugan-pgtest
```

重新验证时先重建库，避免上次的数据干扰：

```bash
docker exec fugan-pgtest psql -U postgres -d postgres \
  -c "drop database if exists fugan_test;" -c "create database fugan_test;"
```

## 两个文件的作用

| 文件 | 作用 |
|---|---|
| `00_supabase_stub.sql` | 补出 Supabase 托管环境才有的东西：`auth` schema、`auth.users` 表、`auth.uid()` / `auth.role()` 函数、`anon` / `authenticated` 角色。原生 postgres 镜像里没有这些，迁移会报"关系不存在" |
| `rls_behaviour_test.sql` | 造 4 个测试用户（含一个试图注册成 admin 的），用 `SET ROLE` + 伪造 JWT 身份实际跑一遍读写，断言每一条策略的行为 |

## 与线上环境的差异

本地验证能覆盖绝大部分问题，但下面这些替换不了，上线前仍需在真实项目里确认一次：

- **`auth` schema 是手工搭的**，只实现了迁移用到的部分。Supabase 真实的 `auth.uid()` 还会读 `request.jwt.claim.sub` 这个旧式单值变量
- **`postgres` 在容器里是超级用户**，而 Supabase 里不是。测试用 `SET ROLE` 切到 `authenticated` 来绕开这个差异，但如果某条策略依赖超级用户行为，本地测不出来
- **不含 GoTrue / PostgREST**。注册流程、JWT 签发、REST 层的实际行为都没覆盖
- **不含 Supabase 的默认权限设置**。线上项目的 `anon` / `authenticated` 默认权限由项目创建时的选项决定，本地是手工 grant 的

## 写应用代码时要知道的事

RLS 的拒绝方式分两种，**不都会报错**：

| 操作 | 拒绝时的表现 | 客户端能否感知 |
|---|---|---|
| INSERT 违反 `WITH CHECK` | 抛异常 | ✅ 有 `error` |
| 列级授权不足 | 抛异常 | ✅ 有 `error` |
| SELECT 无权读的行 | **静默过滤** | ❌ 返回空数组，无 `error` |
| UPDATE / DELETE 无权改的行 | **静默过滤** | ❌ 影响 0 行，无 `error` |

也就是说：

```js
// 危险写法：无权修改时会安静地什么都不做，但代码以为成功了
await supabase.from('profiles').update({ display_name: 'x' }).eq('id', id)

// 正确写法：回读确认
const { data, error } = await supabase
  .from('profiles').update({ display_name: 'x' }).eq('id', id).select()
if (error) { /* 真出错 */ }
if (!data?.length) { /* 没权限或行不存在，需要区分 */ }
```

凡是 UPDATE / DELETE，都要检查 `data.length` 或受影响行数，不能只看 `error`。
