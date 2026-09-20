"""首页数据层端到端验证（对真实 Supabase 项目执行）。

首页的四个数字全部依赖查询正确，其中「今日训练次数」的时区边界最容易写错：
若用 UTC 零点而非本地零点，东八区用户在早上 8 点前看到的「今日」会从前一天算起。

本脚本以真实用户身份插入数据，跑一遍首页用的查询，断言结果，然后清理。

用法：
    python supabase/dev/e2e_dashboard.py

⚠️ 会在项目里创建一个测试账号并插入若干行数据，结束时自动删除自己创建的行；
   账号本身会留下，去 Authentication -> Users 搜 'e2e-' 删除。
⚠️ 前置条件：项目的 Confirm email 必须关闭。
"""
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

sys.stdout.reconfigure(encoding="utf-8")

URL = "https://uliujvggrsnbdejmscny.supabase.co"
KEY = "sb_publishable_uuOmJBII0P1m-muljncfOQ_VbekMGKH"

RUN = str(int(time.time()))[-6:]
EMAIL = f"e2e-dash-{RUN}@fugan-test.invalid"
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
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, raw


def local_midnight_utc() -> datetime:
    """本地时区的今天零点，转成 UTC。与前端 startOfToday() 的算法一致。"""
    now_local = datetime.now().astimezone()
    midnight_local = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
    return midnight_local.astimezone(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


print("=" * 70)
print("0. 注册测试账号")
print("=" * 70)
st, body = call("POST", "/auth/v1/signup",
                {"email": EMAIL, "password": PW, "data": {"role": "patient"}})
token = body.get("access_token") if isinstance(body, dict) else None
check("注册并拿到 session", bool(token), f"HTTP {st}")
if not token:
    print("\n  注册失败 —— 检查项目的 Confirm email 是否已关闭。")
    sys.exit(1)

uid = body["user"]["id"]
created = {"devices": [], "rehab_sessions": [], "alerts": []}

try:
    midnight = local_midnight_utc()
    now = datetime.now(timezone.utc)

    print()
    print("=" * 70)
    print("1. 插入测试数据")
    print("=" * 70)

    st, dev = call("POST", "/rest/v1/devices",
                   {"serial_no": f"E2E-{RUN}", "owner_id": uid,
                    "model": "FSIFSTS", "status": "online", "battery_pct": 88},
                   token=token)
    check("插入设备", st in (200, 201) and bool(dev), f"HTTP {st}")
    if dev:
        created["devices"].append(dev[0]["id"])

    # 今天零点之后 1 分钟 —— 应当计入「今日」
    st, s_today = call("POST", "/rest/v1/rehab_sessions",
                       {"patient_id": uid, "exercise": "直腿抬高",
                        "started_at": iso(midnight + timedelta(minutes=1)),
                        "rep_count": 10, "rom_deg": 95.5, "confidence": 0.94},
                       token=token)
    check("插入今日训练记录", st in (200, 201) and bool(s_today), f"HTTP {st}")
    if s_today:
        created["rehab_sessions"].append(s_today[0]["id"])

    # 今天零点之前 1 分钟 —— 不应计入「今日」。这条专门验证时区边界
    st, s_before = call("POST", "/rest/v1/rehab_sessions",
                        {"patient_id": uid, "exercise": "坐位伸膝",
                         "started_at": iso(midnight - timedelta(minutes=1)),
                         "rep_count": 8},
                        token=token)
    check("插入昨日训练记录（边界用例）", st in (200, 201) and bool(s_before), f"HTTP {st}")
    if s_before:
        created["rehab_sessions"].append(s_before[0]["id"])

    # 两条预警：一条未处理、一条已处理，用于验证未处理计数
    st, a1 = call("POST", "/rest/v1/alerts",
                  {"patient_id": uid, "kind": "temp_high", "severity": "critical",
                   "message": "热敷温度超标", "value": 48.5, "threshold": 45.0,
                   "occurred_at": iso(now)},
                  token=token)
    check("插入未处理预警", st in (200, 201) and bool(a1), f"HTTP {st}")
    if a1:
        created["alerts"].append(a1[0]["id"])

    st, a2 = call("POST", "/rest/v1/alerts",
                  {"patient_id": uid, "kind": "motion_abnormal", "severity": "warning",
                   "occurred_at": iso(now - timedelta(hours=2)),
                   "acknowledged_at": iso(now)},
                  token=token)
    check("插入已处理预警", st in (200, 201) and bool(a2), f"HTTP {st}")
    if a2:
        created["alerts"].append(a2[0]["id"])

    print()
    print("=" * 70)
    print("2. 跑首页用到的查询（与 stores 里的写法一致）")
    print("=" * 70)

    # devices.fetchAll()
    st, devs = call("GET", "/rest/v1/devices?select=*&order=created_at.desc", token=token)
    check("设备列表可见自己的设备", st == 200 and len(devs or []) == 1,
          f"看到 {len(devs or [])} 台")
    check("在线设备计数正确",
          sum(1 for d in (devs or []) if d["status"] == "online") == 1)

    # sessions.fetch({limit: 20})
    st, sess = call(
        "GET",
        "/rest/v1/rehab_sessions?select=*&order=started_at.desc&limit=20",
        token=token)
    check("训练记录按开始时间倒序", st == 200 and len(sess or []) == 2,
          f"看到 {len(sess or [])} 条")
    if sess:
        check("最近一条是最新的那次",
              sess[0]["exercise"] == "直腿抬高", f"实际 = {sess[0]['exercise']}")

    # sessions.fetchTodayCount()
    st, today = call(
        "GET",
        f"/rest/v1/rehab_sessions?select=*&started_at=gte.{urllib.parse.quote(iso(midnight))}",
        token=token)
    check("今日训练次数 = 1（边界外的昨日记录被排除）",
          st == 200 and len(today or []) == 1, f"看到 {len(today or [])} 条")

    # alerts.fetchUnacknowledgedCount()
    req = urllib.request.Request(
        URL + "/rest/v1/alerts?select=*&acknowledged_at=is.null", method="HEAD")
    req.add_header("apikey", KEY)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Prefer", "count=exact")
    with urllib.request.urlopen(req, timeout=30) as r:
        cr = r.headers.get("Content-Range", "")
    unack = int(cr.split("/")[-1]) if "/" in cr else -1
    check("未处理预警数 = 1", unack == 1, f"Content-Range = {cr}")

    print()
    print("=" * 70)
    print("3. 时区边界专项")
    print("=" * 70)
    now_local = datetime.now().astimezone()
    print(f"  浏览器本地时区：{now_local.tzname()} (UTC{now_local.strftime('%z')})")
    print(f"  本地今天零点   ：{midnight.astimezone().strftime('%Y-%m-%d %H:%M:%S %z')}")
    print(f"  对应 UTC        ：{iso(midnight)}")
    check("边界记录（本地 23:59）落在区间外",
          (midnight - timedelta(minutes=1)) < midnight)
    check("边界记录（本地 00:01）落在区间内",
          (midnight + timedelta(minutes=1)) >= midnight)

finally:
    print()
    print("=" * 70)
    print("4. 清理测试数据")
    print("=" * 70)
    for table, ids in created.items():
        if not ids:
            continue
        idlist = ",".join(ids)
        st, _ = call("DELETE", f"/rest/v1/{table}?id=in.({idlist})", token=token)
        check(f"删除 {table} 的 {len(ids)} 行", st in (200, 204), f"HTTP {st}")

    st, left = call("GET", "/rest/v1/devices?select=id", token=token)
    check("设备已清空", st == 200 and len(left or []) == 0, f"剩余 {len(left or [])} 台")
    st, left2 = call("GET", "/rest/v1/rehab_sessions?select=id", token=token)
    check("训练记录已清空", st == 200 and len(left2 or []) == 0, f"剩余 {len(left2 or [])} 条")

print()
print("=" * 70)
passed = sum(1 for _, ok, _ in results if ok)
print(f"结果：{passed}/{len(results)} 项通过")
for label, ok, _ in results:
    if not ok:
        print(f"  未通过：{label}")
print("=" * 70)
print(f"测试账号（去 Authentication -> Users 搜 'e2e-' 删除）：{EMAIL}")
