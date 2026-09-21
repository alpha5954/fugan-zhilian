"""预警列表页的链路验证（对真实 Supabase 项目执行）。

补这个页面之前，预警是"只写不读"的 —— 实时监测页会往里写，
但没有任何地方能看、能标记已读。这里验证新页面用到的每一个操作：
筛选查询、标记已读、取消已读、删除，以及那条列级授权是否真的挡住了
"把 critical 降级成 info"这种操作。

用法：
    python supabase/dev/e2e_alerts.py

⚠️ 前置：Confirm email 必须关闭。
⚠️ 会创建测试账号与若干预警记录，结束时清理。
"""
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

sys.stdout.reconfigure(encoding="utf-8")

URL = "https://uliujvggrsnbdejmscny.supabase.co"
KEY = "sb_publishable_uuOmJBII0P1m-muljncfOQ_VbekMGKH"

RUN = str(int(time.time()))[-6:]
EMAIL = f"e2e-alert-{RUN}@fugan-test.invalid"
PW = "Test-Password-2026"

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


print("=" * 70)
print("0. 注册测试账号")
print("=" * 70)
st, b = call("POST", "/auth/v1/signup",
             {"email": EMAIL, "password": PW, "data": {"role": "patient"}})
token = b.get("access_token") if isinstance(b, dict) else None
uid = b["user"]["id"] if isinstance(b, dict) and b.get("user") else None
check("注册并拿到 session", bool(token), f"HTTP {st}")
if not token:
    print("\n  注册失败 —— 检查 Confirm email 是否已关闭。")
    sys.exit(1)

created = []

try:
    now = datetime.now(timezone.utc)

    print()
    print("=" * 70)
    print("1. 造三条不同等级、不同状态的预警")
    print("=" * 70)
    rows = [
        {"kind": "temp_high", "severity": "critical", "message": "热敷温度超标",
         "value": 48.5, "threshold": 45.0, "occurred_at": (now - timedelta(minutes=5)).isoformat()},
        {"kind": "device_offline", "severity": "warning", "message": "信号中断",
         "occurred_at": (now - timedelta(minutes=30)).isoformat()},
        {"kind": "motion_abnormal", "severity": "info", "message": "动作特征不典型",
         "occurred_at": (now - timedelta(hours=3)).isoformat(),
         "acknowledged_at": now.isoformat(), "acknowledged_by": uid},
    ]
    for r in rows:
        st, data = call("POST", "/rest/v1/alerts", {"patient_id": uid, **r}, token=token)
        if st in (200, 201) and data:
            created.append(data[0]["id"])
    check("三条预警写入成功", len(created) == 3, f"{len(created)}/3")

    print()
    print("=" * 70)
    print("2. 列表页用到的筛选查询")
    print("=" * 70)
    st, all_rows = call("GET", "/rest/v1/alerts?select=*&order=occurred_at.desc", token=token)
    check("不带筛选 → 全部三条", st == 200 and len(all_rows or []) == 3, f"{len(all_rows or [])} 条")
    check("按发生时间倒序（最新的在最前）",
          all_rows and all_rows[0]["message"] == "热敷温度超标",
          all_rows[0]["message"] if all_rows else "?")

    st, unack = call("GET", "/rest/v1/alerts?select=*&acknowledged_at=is.null", token=token)
    check("仅未处理 → 两条", st == 200 and len(unack or []) == 2, f"{len(unack or [])} 条")

    st, crit = call("GET", "/rest/v1/alerts?select=*&severity=eq.critical", token=token)
    check("仅严重 → 一条", st == 200 and len(crit or []) == 1, f"{len(crit or [])} 条")

    st, both = call("GET",
                    "/rest/v1/alerts?select=*&acknowledged_at=is.null&severity=eq.critical",
                    token=token)
    check("未处理 + 严重 → 一条", st == 200 and len(both or []) == 1, f"{len(both or [])} 条")

    # 计数用的 head 请求
    req = urllib.request.Request(
        URL + "/rest/v1/alerts?select=*&acknowledged_at=is.null&patient_id=eq." + uid,
        method="HEAD")
    req.add_header("apikey", KEY)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Prefer", "count=exact")
    with urllib.request.urlopen(req, timeout=30) as r:
        cr = r.headers.get("Content-Range", "")
    check("计数请求返回 2", cr.endswith("/2"), cr)

    print()
    print("=" * 70)
    print("3. 标记已读 / 取消已读")
    print("=" * 70)
    target = created[0]  # 那条 critical

    st, up = call("PATCH", f"/rest/v1/alerts?id=eq.{target}",
                  {"acknowledged_at": now.isoformat(), "acknowledged_by": uid},
                  token=token)
    st2, row = call("GET", f"/rest/v1/alerts?select=acknowledged_at,acknowledged_by&id=eq.{target}",
                    token=token)
    check("标记已读成功", st in (200, 204) and row and row[0]["acknowledged_at"] is not None)
    check("记录了处理人", row and row[0]["acknowledged_by"] == uid)

    st, unack2 = call("GET", "/rest/v1/alerts?select=*&acknowledged_at=is.null", token=token)
    check("未处理数相应减少到 1", len(unack2 or []) == 1, f"{len(unack2 or [])} 条")

    st, _ = call("PATCH", f"/rest/v1/alerts?id=eq.{target}",
                 {"acknowledged_at": None, "acknowledged_by": None}, token=token)
    st2, row = call("GET", f"/rest/v1/alerts?select=acknowledged_at&id=eq.{target}", token=token)
    check("取消已读成功", row and row[0]["acknowledged_at"] is None)

    print()
    print("=" * 70)
    print("4. 列级授权：只能改已读状态")
    print("=" * 70)
    st, err = call("PATCH", f"/rest/v1/alerts?id=eq.{target}",
                   {"severity": "info"}, token=token)
    check("不能把 critical 降级成 info（列级授权拦截）", st >= 400, f"HTTP {st}")

    st, row = call("GET", f"/rest/v1/alerts?select=severity&id=eq.{target}", token=token)
    check("等级未被改动", row and row[0]["severity"] == "critical",
          row[0]["severity"] if row else "?")

    st, err = call("PATCH", f"/rest/v1/alerts?id=eq.{target}",
                   {"patient_id": uid}, token=token)
    check("不能改预警的归属患者", st >= 400, f"HTTP {st}")

    print()
    print("=" * 70)
    print("5. 删除")
    print("=" * 70)
    st, _ = call("DELETE", f"/rest/v1/alerts?id=eq.{created[2]}", token=token)
    st2, rest = call("GET", "/rest/v1/alerts?select=*", token=token)
    check("删除成功", st in (200, 204) and len(rest or []) == 2, f"剩余 {len(rest or [])} 条")
    if st in (200, 204):
        created.remove(created[2])

finally:
    print()
    print("=" * 70)
    print("6. 清理")
    print("=" * 70)
    if created:
        st, _ = call("DELETE", f"/rest/v1/alerts?id=in.({','.join(created)})", token=token)
        check(f"删除 {len(created)} 条测试预警", st in (200, 204), f"HTTP {st}")
    st, left = call("GET", "/rest/v1/alerts?select=id", token=token)
    check("预警已清空", st == 200 and len(left or []) == 0, f"剩余 {len(left or [])} 条")

print()
print("=" * 70)
passed = sum(1 for _, ok, _ in results if ok)
print(f"结果：{passed}/{len(results)} 项通过")
for label, ok, _ in results:
    if not ok:
        print(f"  未通过：{label}")
print("=" * 70)
print(f"测试账号（去 Authentication -> Users 搜 'e2e-' 删除）：{EMAIL}")
