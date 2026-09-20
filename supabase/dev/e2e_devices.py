"""设备管理页的链路验证（对真实 Supabase 项目执行）。

重点验证 claim_device() —— 它是 security definer 函数，绕过 RLS 执行，
写错一行就能让任何人把别人的设备夺过去。本地 Postgres 上已验过一遍，
这里再确认在真实的 PostgREST + GoTrue 环境下行为一致。

同时验证那个当初的死胡同确实修好了：
    绑定 → 解绑（owner_id 置 null）→ 设备不可见 → 用同一序列号重新认领

用法：
    python supabase/dev/e2e_devices.py

⚠️ 前置：必须已执行迁移 5（20260921090100_device_claim_rpc.sql）。
⚠️ 会创建测试账号与设备，结束时删掉自己创建的行。
⚠️ 项目的 Confirm email 必须关闭。
"""
import json
import sys
import time
import urllib.error
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")

URL = "https://uliujvggrsnbdejmscny.supabase.co"
KEY = "sb_publishable_uuOmJBII0P1m-muljncfOQ_VbekMGKH"

RUN = str(int(time.time()))[-6:]
PW = "Test-Password-2026"
EMAIL_A = f"e2e-dev-a-{RUN}@fugan-test.invalid"
EMAIL_B = f"e2e-dev-b-{RUN}@fugan-test.invalid"
SERIAL = f"E2E-DEV-{RUN}"

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
    req.add_header("Prefer", "return=representation")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            txt = r.read().decode()
            return r.status, (json.loads(txt) if txt else None)
    except urllib.error.HTTPError as e:
        txt = e.read().decode()
        try:
            return e.code, json.loads(txt)
        except json.JSONDecodeError:
            return e.code, txt


def signup(email):
    st, b = call("POST", "/auth/v1/signup",
                 {"email": email, "password": PW, "data": {"role": "patient"}})
    return (b.get("access_token") if isinstance(b, dict) else None), (
        b.get("user", {}).get("id") if isinstance(b, dict) else None
    ), st


def claim(serial, token):
    return call("POST", "/rest/v1/rpc/claim_device", {"p_serial": serial}, token=token)


print("=" * 70)
print("0. 注册两个测试账号")
print("=" * 70)
tok_a, uid_a, st_a = signup(EMAIL_A)
tok_b, uid_b, st_b = signup(EMAIL_B)
check("A 注册成功", bool(tok_a), f"HTTP {st_a}")
check("B 注册成功", bool(tok_b), f"HTTP {st_b}")
if not (tok_a and tok_b):
    print("\n  注册失败 —— 检查 Confirm email 是否已关闭。")
    sys.exit(1)

created_device_ids = []

try:
    print()
    print("=" * 70)
    print("1. A 登记新设备")
    print("=" * 70)
    st, rows = call("POST", "/rest/v1/devices",
                    {"serial_no": SERIAL, "owner_id": uid_a, "model": "FSIFSTS",
                     "status": "online", "battery_pct": 96, "firmware": "1.0.0"},
                    token=tok_a)
    check("登记成功", st in (200, 201) and bool(rows), f"HTTP {st}")
    if not rows:
        print(f"  错误详情：{rows}")
        sys.exit(1)
    dev_id = rows[0]["id"]
    created_device_ids.append(dev_id)

    st, mine = call("GET", "/rest/v1/devices?select=*", token=tok_a)
    check("A 能看到自己的设备", st == 200 and len(mine or []) == 1)

    st, b_sees = call("GET", "/rest/v1/devices?select=*", token=tok_b)
    check("B 看不到 A 的设备（RLS 过滤）", st == 200 and len(b_sees or []) == 0,
          f"B 看到 {len(b_sees or [])} 台")

    print()
    print("=" * 70)
    print("2. 解绑 → 重新认领（当初的死胡同）")
    print("=" * 70)
    st, _ = call("PATCH", f"/rest/v1/devices?id=eq.{dev_id}",
                 {"owner_id": None}, token=tok_a)
    check("A 解绑成功", st in (200, 204), f"HTTP {st}")

    st, after = call("GET", "/rest/v1/devices?select=*", token=tok_a)
    check("解绑后设备对 A 不可见（RLS 过滤 owner_id is null）",
          st == 200 and len(after or []) == 0, f"看到 {len(after or [])} 台")

    st, r = claim(SERIAL, tok_a)
    ok = st == 200 and isinstance(r, dict) and r.get("ok")
    check("★ 用同一序列号重新认领成功（死胡同已修复）", ok,
          f"{r.get('reason') if isinstance(r, dict) else r}：{r.get('message') if isinstance(r, dict) else ''}")

    st, back = call("GET", "/rest/v1/devices?select=*", token=tok_a)
    check("重新认领后设备回到 A 的列表", st == 200 and len(back or []) == 1)

    print()
    print("=" * 70)
    print("3. 认领 RPC 的边界与权限")
    print("=" * 70)
    st, r = claim(SERIAL, tok_a)
    check("重复认领自己的设备 → already_owned",
          isinstance(r, dict) and r.get("reason") == "already_owned",
          r.get("reason") if isinstance(r, dict) else str(r))

    st, r = claim(SERIAL, tok_b)
    check("★ B 认领 A 的设备被拒 → taken",
          isinstance(r, dict) and not r.get("ok") and r.get("reason") == "taken",
          r.get("reason") if isinstance(r, dict) else str(r))

    st, still = call("GET", "/rest/v1/devices?select=owner_id", token=tok_a)
    check("A 的归属未被 B 的认领尝试改动",
          st == 200 and still and still[0]["owner_id"] == uid_a)

    st, r = claim(f"NO-SUCH-{RUN}", tok_a)
    check("不存在的序列号 → not_found",
          isinstance(r, dict) and r.get("reason") == "not_found",
          r.get("reason") if isinstance(r, dict) else str(r))

    st, r = claim("   ", tok_a)
    check("空白序列号 → invalid_serial",
          isinstance(r, dict) and r.get("reason") == "invalid_serial",
          r.get("reason") if isinstance(r, dict) else str(r))

    # 匿名（不带 token）调用 —— anon 没有 EXECUTE 授权
    st, r = call("POST", "/rest/v1/rpc/claim_device", {"p_serial": SERIAL})
    check("匿名调用被拒（防序列号探测）", st >= 400, f"HTTP {st}")

    print()
    print("=" * 70)
    print("4. 固件升级与校准")
    print("=" * 70)
    st, up = call("PATCH", f"/rest/v1/devices?id=eq.{dev_id}",
                  {"firmware": "1.1.0", "last_seen_at": "2026-09-21T00:00:00Z"},
                  token=tok_a)
    check("固件版本写库", st in (200, 204), f"HTTP {st}")
    st, row = call("GET", f"/rest/v1/devices?select=firmware,last_seen_at&id=eq.{dev_id}",
                   token=tok_a)
    check("固件版本已更新为 1.1.0", row and row[0]["firmware"] == "1.1.0",
          str(row[0]["firmware"]) if row else "?")

    st, _ = call("PATCH", f"/rest/v1/devices?id=eq.{dev_id}",
                 {"last_seen_at": "2026-09-21T01:00:00Z"}, token=tok_a)
    st, row = call("GET", f"/rest/v1/devices?select=last_seen_at&id=eq.{dev_id}", token=tok_a)
    check("校准刷新最后在线时间", row and row[0]["last_seen_at"].startswith("2026-09-21T01"),
          str(row[0]["last_seen_at"]) if row else "?")

finally:
    print()
    print("=" * 70)
    print("5. 清理")
    print("=" * 70)
    if created_device_ids:
        idlist = ",".join(created_device_ids)
        st, _ = call("DELETE", f"/rest/v1/devices?id=in.({idlist})", token=tok_a)
        check(f"删除 {len(created_device_ids)} 台测试设备", st in (200, 204), f"HTTP {st}")
    st, left = call("GET", "/rest/v1/devices?select=id", token=tok_a)
    check("设备已清空", st == 200 and len(left or []) == 0, f"剩余 {len(left or [])} 台")

print()
print("=" * 70)
passed = sum(1 for _, ok, _ in results if ok)
print(f"结果：{passed}/{len(results)} 项通过")
for label, ok, _ in results:
    if not ok:
        print(f"  未通过：{label}")
print("=" * 70)
print("测试账号（去 Authentication -> Users 搜 'e2e-' 删除）：")
print(f"  {EMAIL_A}")
print(f"  {EMAIL_B}")
