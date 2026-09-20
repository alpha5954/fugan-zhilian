"""监护关系（care_links）的端到端验证（对真实 Supabase 项目执行）。

这套策略是整个项目里**最复杂的一处权限设计**：它决定了家属和治疗师
能看到哪些患者的数据，而保护的对象（患者健康数据）比设备序列号敏感得多。
之前只在本地 Postgres 上跑过，这里在真实的 PostgREST + GoTrue 环境下验证。

验证的关键性质：
  - 未建立关系时，家属看不到患者的任何数据
  - 家属可以发起申请，但**不能自己批准**（只有患者本人能改成 active）
  - 关系生效后，家属能看患者的训练记录/设备，但仍**不能改**患者资料
  - 撤销关系后，访问立刻失效
  - 无关第三方始终看不到

用法：
    python supabase/dev/e2e_care_links.py

⚠️ 前置：Confirm email 必须关闭。
⚠️ 会创建 3 个测试账号并插入若干数据，结束时清理自己插入的行。
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
PATIENT = f"e2e-cl-patient-{RUN}@fugan-test.invalid"
CARER = f"e2e-cl-carer-{RUN}@fugan-test.invalid"
OUTSIDER = f"e2e-cl-outsider-{RUN}@fugan-test.invalid"

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


def signup(email, role="patient"):
    st, b = call("POST", "/auth/v1/signup",
                 {"email": email, "password": PW, "data": {"role": role}})
    if isinstance(b, dict) and b.get("access_token"):
        return b["access_token"], b["user"]["id"]
    return None, None


print("=" * 70)
print("0. 注册三个账号")
print("=" * 70)
tok_p, uid_p = signup(PATIENT, "patient")
tok_c, uid_c = signup(CARER, "family")
tok_o, uid_o = signup(OUTSIDER, "family")
check("患者注册", bool(tok_p))
check("家属注册（role=family）", bool(tok_c))
check("无关第三方注册", bool(tok_o))
if not (tok_p and tok_c and tok_o):
    print("\n  注册失败 —— 检查 Confirm email 是否已关闭。")
    sys.exit(1)

created = {"rehab_sessions": [], "devices": [], "alerts": [], "care_links": []}


def cleanup():
    print()
    print("=" * 70)
    print("9. 清理")
    print("=" * 70)
    for table, ids in created.items():
        if not ids:
            continue
        st, _ = call("DELETE", f"/rest/v1/{table}?id=in.({','.join(ids)})", token=tok_p)
        if st >= 400:  # care_links 用患者的 token 可能删不掉（策略限制），换家属试
            st, _ = call("DELETE", f"/rest/v1/{table}?id=in.({','.join(ids)})", token=tok_c)
        check(f"删除 {table} 的 {len(ids)} 行", st in (200, 204), f"HTTP {st}")


try:
    # -----------------------------------------------------------------------
    print()
    print("=" * 70)
    print("1. 患者产生一些数据")
    print("=" * 70)
    st, sess = call("POST", "/rest/v1/rehab_sessions",
                    {"patient_id": uid_p, "exercise": "屈膝滑动",
                     "started_at": "2026-09-21T02:00:00Z", "rom_deg": 95.5,
                     "rep_count": 10, "confidence": 0.94},
                    token=tok_p)
    check("插入训练记录", st in (200, 201) and bool(sess), f"HTTP {st}")
    if sess:
        created["rehab_sessions"].append(sess[0]["id"])

    st, dev = call("POST", "/rest/v1/devices",
                   {"serial_no": f"E2E-CL-{RUN}", "owner_id": uid_p,
                    "status": "online", "firmware": "1.0.0"},
                   token=tok_p)
    check("插入设备", st in (200, 201) and bool(dev), f"HTTP {st}")
    if dev:
        created["devices"].append(dev[0]["id"])

    st, al = call("POST", "/rest/v1/alerts",
                  {"patient_id": uid_p, "kind": "temp_high", "severity": "critical",
                   "message": "热敷温度超标", "value": 48.5, "threshold": 45.0},
                  token=tok_p)
    check("插入预警", st in (200, 201) and bool(al), f"HTTP {st}")
    if al:
        created["alerts"].append(al[0]["id"])

    # -----------------------------------------------------------------------
    print()
    print("=" * 70)
    print("2. 关系建立前：家属什么都看不到")
    print("=" * 70)
    st, r = call("GET", "/rest/v1/rehab_sessions?select=*", token=tok_c)
    check("家属看不到患者的训练记录", st == 200 and len(r or []) == 0, f"看到 {len(r or [])} 条")
    st, r = call("GET", "/rest/v1/devices?select=*", token=tok_c)
    check("家属看不到患者的设备", st == 200 and len(r or []) == 0, f"看到 {len(r or [])} 台")
    st, r = call("GET", f"/rest/v1/profiles?select=*&id=eq.{uid_p}", token=tok_c)
    check("家属看不到患者的资料", st == 200 and len(r or []) == 0, f"看到 {len(r or [])} 行")

    # -----------------------------------------------------------------------
    print()
    print("=" * 70)
    print("3. 家属发起申请（pending）")
    print("=" * 70)
    st, link = call("POST", "/rest/v1/care_links",
                    {"patient_id": uid_p, "caregiver_id": uid_c,
                     "relation": "family", "status": "pending"},
                    token=tok_c)
    check("家属可以发起监护申请", st in (200, 201) and bool(link), f"HTTP {st}")
    if not link:
        print(f"  错误详情：{link}")
        cleanup()
        sys.exit(1)
    link_id = link[0]["id"]
    created["care_links"].append(link_id)

    st, r = call("GET", "/rest/v1/rehab_sessions?select=*", token=tok_c)
    check("pending 状态下仍然看不到数据", st == 200 and len(r or []) == 0,
          f"看到 {len(r or [])} 条")

    # -----------------------------------------------------------------------
    print()
    print("=" * 70)
    print("4. 家属不能自己批准（这是防越权的关键）")
    print("=" * 70)
    st, upd = call("PATCH", f"/rest/v1/care_links?id=eq.{link_id}",
                   {"status": "active"}, token=tok_c)
    check("家属自己改 status=active 被拒绝", st >= 400, f"HTTP {st}")
    if st >= 400 and isinstance(upd, dict):
        print(f"        拒绝原因：{upd.get('message', upd)}")

    st, r = call("GET", f"/rest/v1/care_links?select=status&id=eq.{link_id}", token=tok_c)
    check("关系仍为 pending（未被改动）",
          r and r[0]["status"] == "pending", r[0]["status"] if r else "?")

    # 家属也不能伪造一条 active 的关系
    st, fake = call("POST", "/rest/v1/care_links",
                    {"patient_id": uid_p, "caregiver_id": uid_c,
                     "relation": "family", "status": "active"},
                    token=tok_c)
    check("家属直接插入 active 关系被拒绝", st >= 400, f"HTTP {st}")

    # -----------------------------------------------------------------------
    print()
    print("=" * 70)
    print("5. 患者确认后，家属获得访问权")
    print("=" * 70)
    st, act = call("PATCH", f"/rest/v1/care_links?id=eq.{link_id}",
                   {"status": "active"}, token=tok_p)
    check("患者本人可以确认关系", st in (200, 204), f"HTTP {st}")

    st, r = call("GET", f"/rest/v1/care_links?select=status&id=eq.{link_id}", token=tok_p)
    check("关系已生效", r and r[0]["status"] == "active", r[0]["status"] if r else "?")

    st, r = call("GET", f"/rest/v1/rehab_sessions?select=*&patient_id=eq.{uid_p}", token=tok_c)
    check("★ 家属现在能看到患者的训练记录", st == 200 and len(r or []) == 1,
          f"看到 {len(r or [])} 条")

    st, r = call("GET", f"/rest/v1/devices?select=*", token=tok_c)
    check("家属能看到患者的设备", st == 200 and len(r or []) == 1, f"看到 {len(r or [])} 台")

    st, r = call("GET", f"/rest/v1/profiles?select=*&id=eq.{uid_p}", token=tok_c)
    check("家属能看到患者的资料", st == 200 and len(r or []) == 1, f"看到 {len(r or [])} 行")

    st, r = call("GET", f"/rest/v1/alerts?select=*&patient_id=eq.{uid_p}", token=tok_c)
    check("家属能看到患者的预警", st == 200 and len(r or []) == 1, f"看到 {len(r or [])} 条")

    # -----------------------------------------------------------------------
    print()
    print("=" * 70)
    print("6. 家属的权限边界：能读但不能改")
    print("=" * 70)
    st, r = call("PATCH", f"/rest/v1/profiles?id=eq.{uid_p}",
                 {"display_name": "被家属改了"}, token=tok_c)
    st2, after = call("GET", f"/rest/v1/profiles?select=display_name&id=eq.{uid_p}", token=tok_p)
    check("家属不能修改患者资料（RLS 静默过滤，值未变）",
          not (after and after[0]["display_name"] == "被家属改了"),
          f"display_name = {after[0]['display_name'] if after else '?'}")

    st, r = call("PATCH", f"/rest/v1/care_links?id=eq.{link_id}",
                 {"relation": "therapist"}, token=tok_c)
    st2, after = call("GET", f"/rest/v1/care_links?select=relation&id=eq.{link_id}", token=tok_p)
    check("家属不能自行变更关系类型",
          after and after[0]["relation"] == "family",
          f"relation = {after[0]['relation'] if after else '?'}")

    # 家属可以标记预警已读 —— 这是他们最常用的操作
    st, r = call("PATCH", f"/rest/v1/alerts?id=eq.{created['alerts'][0]}",
                 {"acknowledged_at": "2026-09-21T03:00:00Z", "acknowledged_by": uid_c},
                 token=tok_c)
    st2, after = call("GET", f"/rest/v1/alerts?select=acknowledged_by&id=eq.{created['alerts'][0]}",
                      token=tok_p)
    check("家属可以标记患者预警为已读",
          after and after[0]["acknowledged_by"] == uid_c,
          f"acknowledged_by = {after[0]['acknowledged_by'] if after else '?'}")

    # -----------------------------------------------------------------------
    print()
    print("=" * 70)
    print("7. 无关第三方始终看不到")
    print("=" * 70)
    st, r = call("GET", f"/rest/v1/rehab_sessions?select=*&patient_id=eq.{uid_p}", token=tok_o)
    check("★ 无关用户看不到患者数据", st == 200 and len(r or []) == 0, f"看到 {len(r or [])} 条")
    st, r = call("GET", f"/rest/v1/care_links?select=*&patient_id=eq.{uid_p}", token=tok_o)
    check("无关用户看不到他人的监护关系", st == 200 and len(r or []) == 0, f"看到 {len(r or [])} 条")
    st, r = call("POST", "/rest/v1/care_links",
                 {"patient_id": uid_p, "caregiver_id": uid_o,
                  "relation": "family", "status": "active"}, token=tok_o)
    check("无关用户不能给自己伪造 active 关系", st >= 400, f"HTTP {st}")

    # -----------------------------------------------------------------------
    print()
    print("=" * 70)
    print("8. 撤销关系后访问立即失效")
    print("=" * 70)
    st, _ = call("PATCH", f"/rest/v1/care_links?id=eq.{link_id}",
                 {"status": "revoked"}, token=tok_p)
    check("患者撤销关系", st in (200, 204), f"HTTP {st}")

    st, r = call("GET", f"/rest/v1/rehab_sessions?select=*&patient_id=eq.{uid_p}", token=tok_c)
    check("★ 撤销后家属立刻看不到数据", st == 200 and len(r or []) == 0,
          f"看到 {len(r or [])} 条")

    st, r = call("GET", f"/rest/v1/devices?select=*", token=tok_c)
    check("撤销后也看不到设备", st == 200 and len(r or []) == 0, f"看到 {len(r or [])} 台")

finally:
    cleanup()

print()
print("=" * 70)
passed = sum(1 for _, ok, _ in results if ok)
print(f"结果：{passed}/{len(results)} 项通过")
for label, ok, _ in results:
    if not ok:
        print(f"  未通过：{label}")
print("=" * 70)
print("测试账号（去 Authentication -> Users 搜 'e2e-' 删除）：")
print(f"  {PATIENT}\n  {CARER}\n  {OUTSIDER}")
