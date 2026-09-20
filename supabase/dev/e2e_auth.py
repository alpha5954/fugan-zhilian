"""认证链路端到端验证（对真实 Supabase 项目执行）。

验证内容：
  1. 注册时在 metadata 里伪造 role=admin -> 数据库白名单应把它降级为 patient
  2. 正常注册 -> handle_new_user 触发器自动建档，display_name / role 正确写入
  3. 邮箱密码登录；错误密码被拒
  4. RLS 跨用户隔离

用法：
    python supabase/dev/e2e_auth.py

⚠️ 会在项目里创建测试账号（每次运行两个，邮箱带时间戳后缀）。
   跑完去 Authentication -> Users 搜索 "e2e-" 批量删除。

⚠️ 前置条件：项目的「Confirm email」必须关闭。
   开着的话注册不会返回 session，本脚本第一步就会失败。
   路径：Authentication -> Sign In / Providers -> Email -> 关掉 Confirm email
"""
import json
import sys
import time
import urllib.error
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")

URL = "https://uliujvggrsnbdejmscny.supabase.co"
# 公开密钥，会打包进前端，写在这里不构成泄露
KEY = "sb_publishable_uuOmJBII0P1m-muljncfOQ_VbekMGKH"

RUN = str(int(time.time()))[-6:]
PW = "Test-Password-2026"
EVIL = f"e2e-evil-{RUN}@fugan-test.invalid"
FAMILY = f"e2e-family-{RUN}@fugan-test.invalid"

results = []


def check(label, ok, detail=""):
    results.append((label, ok, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}" + (f"  ->  {detail}" if detail else ""))


def call(method, path, body=None, token=None):
    req = urllib.request.Request(
        URL + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
    )
    req.add_header("apikey", KEY)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, raw


def signup(email, password, meta):
    return call("POST", "/auth/v1/signup",
                {"email": email, "password": password, "data": meta})


def signin(email, password):
    return call("POST", "/auth/v1/token?grant_type=password",
                {"email": email, "password": password})


print("=" * 68)
print("1. 注册时伪造 role=admin")
print("=" * 68)
st, body = signup(EVIL, PW, {"role": "admin", "display_name": "越权尝试者"})
check("注册返回 2xx", 200 <= st < 300, f"HTTP {st}")

evil_token = body.get("access_token") if isinstance(body, dict) else None
check("直接拿到 session（邮箱确认已关闭）", bool(evil_token))
if not evil_token:
    print("\n  注册没返回 session —— 检查项目的 Confirm email 是否已关闭。")
    sys.exit(1)

st2, prof = call("GET", "/rest/v1/profiles?select=*", token=evil_token)
check("触发器已自动建档", st2 == 200 and bool(prof), f"HTTP {st2}")

if prof:
    p = prof[0]
    check("role 被白名单降级为 patient",
          p.get("role") == "patient", f"实际 role = {p.get('role')}")
    check("display_name 正确写入",
          p.get("display_name") == "越权尝试者", f"实际 = {p.get('display_name')}")
    check("id 与 auth 用户一致",
          p.get("id") == body.get("user", {}).get("id"))

print()
print("=" * 68)
print("2. 正常注册 role=family")
print("=" * 68)
st, body2 = signup(FAMILY, PW, {"role": "family", "display_name": "测试家属"})
check("注册返回 2xx", 200 <= st < 300, f"HTTP {st}")
fam_token = body2.get("access_token") if isinstance(body2, dict) else None

if fam_token:
    st2, prof2 = call("GET", "/rest/v1/profiles?select=*", token=fam_token)
    if prof2:
        check("role = family（白名单内正常放行）",
              prof2[0].get("role") == "family", f"实际 = {prof2[0].get('role')}")

print()
print("=" * 68)
print("3. 邮箱密码登录")
print("=" * 68)
st, login = signin(EVIL, PW)
check("登录返回 2xx", 200 <= st < 300, f"HTTP {st}")
check("拿到 access_token", isinstance(login, dict) and bool(login.get("access_token")))

st, _ = signin(EVIL, "wrong-password-xxx")
check("错误密码被拒绝", st >= 400, f"HTTP {st}")

print()
print("=" * 68)
print("4. RLS 跨用户隔离")
print("=" * 68)
if evil_token and fam_token:
    st, prof = call("GET", "/rest/v1/profiles?select=*", token=evil_token)
    check("只能看到自己一行", st == 200 and len(prof) == 1,
          f"看到 {len(prof) if prof else '?'} 行")

    evil_uid = body["user"]["id"]
    st, other = call("GET", f"/rest/v1/profiles?select=*&id=eq.{evil_uid}", token=fam_token)
    check("查不到无关用户", st == 200 and len(other or []) == 0,
          f"看到 {len(other or [])} 行")

    st, sess = call("GET", "/rest/v1/rehab_sessions?select=*", token=evil_token)
    check("训练记录查询不报错且为空", st == 200 and len(sess or []) == 0, f"HTTP {st}")

    st, dev = call("GET", "/rest/v1/devices?select=*", token=evil_token)
    check("设备查询不报错", st == 200, f"HTTP {st}")

    # keepalive 是刻意开放只读的（表里只有一个心跳时间戳），
    # 所以这里期望 200 而不是 403 —— 策略定义见 RLS 迁移的 keepalive 段
    st, ka = call("GET", "/rest/v1/keepalive?select=*", token=evil_token)
    check("可读 keepalive（策略有意开放只读）",
          st == 200 and len(ka or []) == 1, f"HTTP {st}")

    st, upd = call("PATCH", "/rest/v1/keepalive?id=eq.1",
                   {"last_ping": "2020-01-01T00:00:00Z"}, token=evil_token)
    check("不能改 keepalive（无 UPDATE 授权）", st >= 400, f"HTTP {st}")

    st, upd2 = call("PATCH", f"/rest/v1/profiles?id=eq.{evil_uid}",
                    {"role": "admin"}, token=evil_token)
    check("不能把自己的 role 改成 admin", st >= 400, f"HTTP {st}")

print()
print("=" * 68)
passed = sum(1 for _, ok, _ in results if ok)
print(f"结果：{passed}/{len(results)} 项通过")
for label, ok, _ in results:
    if not ok:
        print(f"  未通过：{label}")
print("=" * 68)
print("测试账号（跑完去 Authentication -> Users 搜 'e2e-' 删除）：")
print(f"  {EVIL}")
print(f"  {FAMILY}")
print(f"  密码：{PW}")
