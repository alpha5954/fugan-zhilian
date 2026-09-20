"""康复评估页的入库链路验证（对真实 Supabase 项目执行）。

评估页点「保存到训练记录」时会往 rehab_sessions 写一行，包含：
患者、设备、动作、识别结果、各项指标，以及一段 jsonb 波形。
这条链路涉及 RLS 插入策略、jsonb 类型、多个 numeric 的 check 约束 ——
任一不匹配都只在点保存时才报错，所以值得单独实测。

用法：
    python supabase/dev/e2e_assessment.py

⚠️ 会创建测试账号并插入一行训练记录，结束时删掉自己插入的行。
   账号本身会留下，去 Authentication -> Users 搜 'e2e-' 删除。
⚠️ 前置条件：项目的 Confirm email 必须关闭。
"""
import json
import math
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

sys.stdout.reconfigure(encoding="utf-8")

URL = "https://uliujvggrsnbdejmscny.supabase.co"
KEY = "sb_publishable_uuOmJBII0P1m-muljncfOQ_VbekMGKH"

RUN = str(int(time.time()))[-6:]
EMAIL = f"e2e-assess-{RUN}@fugan-test.invalid"
PW = "Test-Password-2026"

results = []


def check(label, ok, detail=""):
    results.append((label, ok, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}" + (f"  ->  {detail}" if detail else ""))


def call(method, path, body=None, token=None, headers=None, raw=False):
    req = urllib.request.Request(
        URL + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
    )
    req.add_header("apikey", KEY)
    req.add_header("Content-Type", "application/json")
    req.add_header("Prefer", "return=representation")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            txt = r.read().decode()
            return r.status, (txt if raw else (json.loads(txt) if txt else None))
    except urllib.error.HTTPError as e:
        txt = e.read().decode()
        try:
            return e.code, json.loads(txt)
        except json.JSONDecodeError:
            return e.code, txt


# ---------------------------------------------------------------------------
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
created_ids = []

try:
    # -----------------------------------------------------------------------
    # 构造与 Assessment.vue 的 save() 完全一致的载荷
    # -----------------------------------------------------------------------
    print()
    print("=" * 70)
    print("1. 构造载荷（结构与 Assessment.vue 的 save() 一致）")
    print("=" * 70)

    # 320 点的降采样波形，列式结构 {t_ms, r_ohm, temp_c}
    n = 320
    waveform = {
        "t_ms": [i * 100 for i in range(n)],
        "r_ohm": [round(1000 * (1 + 0.3 * math.sin(i / 20) / 1), 2) for i in range(n)],
        "temp_c": [round(33 + 0.4 * math.sin(i / 60), 2) for i in range(n)],
    }
    print(f"  波形：{n} 点，JSON {len(json.dumps(waveform)) / 1024:.1f} KB")

    started = datetime.now(timezone.utc) - timedelta(seconds=32)
    payload = {
        "patient_id": uid,
        "device_id": None,
        "joint": "knee",
        "exercise": "直腿抬高",
        "recognized": "直腿抬高",
        "started_at": started.isoformat(),
        "ended_at": datetime.now(timezone.utc).isoformat(),
        "duration_s": 32,
        "rep_count": 8,
        "rom_deg": 12.22,
        "temp_c": 33.44,
        "confidence": 0.915,
        "waveform": waveform,
        "notes": "e2e 测试记录",
    }

    # -----------------------------------------------------------------------
    print()
    print("=" * 70)
    print("2. 写入 rehab_sessions")
    print("=" * 70)
    st, rows = call("POST", "/rest/v1/rehab_sessions", payload, token=token)
    ok = st in (200, 201) and bool(rows)
    check("插入成功", ok, f"HTTP {st}")
    if not ok:
        print(f"  错误详情：{rows}")
        sys.exit(1)
    row_id = rows[0]["id"]
    created_ids.append(row_id)

    # -----------------------------------------------------------------------
    print()
    print("=" * 70)
    print("3. 回读校验")
    print("=" * 70)
    st, back = call("GET", f"/rest/v1/rehab_sessions?select=*&id=eq.{row_id}", token=token)
    r = back[0]

    check("waveform 原样存取（jsonb 往返无损）",
          r["waveform"]["t_ms"] == waveform["t_ms"]
          and len(r["waveform"]["r_ohm"]) == n
          and r["waveform"]["temp_c"][:3] == waveform["temp_c"][:3],
          f"{len(r['waveform']['t_ms'])} 点")
    check("rom_deg 精度保留", abs(r["rom_deg"] - 12.22) < 1e-9, str(r["rom_deg"]))
    check("confidence 落在 [0,1]（数据库 check 约束）",
          0 <= r["confidence"] <= 1, str(r["confidence"]))
    check("recognized 字段写入", r["recognized"] == "直腿抬高", str(r["recognized"]))
    check("ended_at 晚于 started_at",
          r["ended_at"] > r["started_at"], f"{r['started_at']} → {r['ended_at']}")

    # -----------------------------------------------------------------------
    print()
    print("=" * 70)
    print("4. 约束与权限（这些失败才是好事）")
    print("=" * 70)

    bad = dict(payload)
    bad["confidence"] = 1.5
    st, _ = call("POST", "/rest/v1/rehab_sessions", bad, token=token)
    check("confidence > 1 被 check 约束拒绝", st >= 400, f"HTTP {st}")

    bad2 = dict(payload)
    bad2["rep_count"] = -1
    st, _ = call("POST", "/rest/v1/rehab_sessions", bad2, token=token)
    check("rep_count < 0 被 check 约束拒绝", st >= 400, f"HTTP {st}")

    bad3 = dict(payload)
    bad3["joint"] = "finger"
    st, _ = call("POST", "/rest/v1/rehab_sessions", bad3, token=token)
    check("非法 joint 值被 check 约束拒绝", st >= 400, f"HTTP {st}")

    bad4 = dict(payload)
    bad4["ended_at"] = (started - timedelta(minutes=5)).isoformat()
    st, _ = call("POST", "/rest/v1/rehab_sessions", bad4, token=token)
    check("ended_at 早于 started_at 被拒绝", st >= 400, f"HTTP {st}")

    # 以他人身份插入 —— RLS 应当拒绝
    st2, other = call("POST", "/auth/v1/signup",
                      {"email": f"e2e-other-{RUN}@fugan-test.invalid",
                       "password": PW, "data": {"role": "patient"}})
    other_token = other.get("access_token") if isinstance(other, dict) else None
    if other_token:
        stolen = dict(payload)
        st, _ = call("POST", "/rest/v1/rehab_sessions", stolen, token=other_token)
        check("冒用他人 patient_id 插入被 RLS 拒绝", st >= 400, f"HTTP {st}")

        st, _ = call("PATCH", f"/rest/v1/rehab_sessions?id=eq.{row_id}",
                     {"rom_deg": 99}, token=other_token)
        st2, check_row = call("GET", f"/rest/v1/rehab_sessions?select=rom_deg&id=eq.{row_id}",
                              token=token)
        check("他人无法修改我的记录（RLS 静默过滤，值未变）",
              abs(check_row[0]["rom_deg"] - 12.22) < 1e-9,
              f"rom_deg 仍为 {check_row[0]['rom_deg']}")

finally:
    print()
    print("=" * 70)
    print("5. 清理")
    print("=" * 70)
    if created_ids:
        idlist = ",".join(created_ids)
        st, _ = call("DELETE", f"/rest/v1/rehab_sessions?id=in.({idlist})", token=token)
        check(f"删除插入的 {len(created_ids)} 行", st in (200, 204), f"HTTP {st}")
    st, left = call("GET", "/rest/v1/rehab_sessions?select=id", token=token)
    check("训练记录已清空", st == 200 and len(left or []) == 0, f"剩余 {len(left or [])} 条")

print()
print("=" * 70)
passed = sum(1 for _, ok, _ in results if ok)
print(f"结果：{passed}/{len(results)} 项通过")
for label, ok, _ in results:
    if not ok:
        print(f"  未通过：{label}")
print("=" * 70)
print(f"测试账号（去 Authentication -> Users 搜 'e2e-' 删除）：{EMAIL}")
