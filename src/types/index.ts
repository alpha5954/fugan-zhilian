// ============================================================================
// 领域类型定义
// ============================================================================
// 数据库行类型与 supabase/migrations/ 中的建表语句严格对应。
// 改表结构时必须同步改动这里，否则类型和实际数据会悄悄对不上。
//
// 每个表配三个类型：
//   Row    —— 查询返回的完整行
//   Insert —— 可写入的字段（id/created_at 等由数据库生成的列已排除）
//   Update —— 可修改的字段
//
// ⚠️ Update 类型刻意只包含**列级授权允许改的列**（见迁移 2 的 grant 语句）。
//    例如 ProfileUpdate 里没有 role —— 写了也改不动，前端不该装作能改。
// ============================================================================


// ---------------------------------------------------------------------------
// 枚举 —— 与数据库里的 check 约束一一对应
// ---------------------------------------------------------------------------

/** profiles.role */
export type UserRole = 'patient' | 'family' | 'therapist' | 'admin'

/** care_links.relation —— 监护者与患者的关系 */
export type CareRelation = 'family' | 'therapist'

/** care_links.status —— 患者确认前为 pending，只有患者本人能改成 active */
export type CareLinkStatus = 'pending' | 'active' | 'revoked'

/** devices.status */
export type DeviceStatus = 'online' | 'offline' | 'maintenance'

/** rehab_sessions.joint —— 当前只做膝关节，其余为后续扩展预留 */
export type JointName = 'knee' | 'shoulder' | 'elbow' | 'wrist' | 'ankle'

/**
 * alerts.kind —— 预警类型
 *   temp_high       热敷温度超标
 *   temp_low        温度过低
 *   motion_abnormal 动作异常
 *   device_offline  设备离线
 *   low_compliance  训练依从性不足
 */
export type AlertKind =
  | 'temp_high'
  | 'temp_low'
  | 'motion_abnormal'
  | 'device_offline'
  | 'low_compliance'

/** alerts.severity */
export type AlertSeverity = 'info' | 'warning' | 'critical'


// ---------------------------------------------------------------------------
// 通用类型
// ---------------------------------------------------------------------------

/** 数据库时间戳统一以 ISO 8601 字符串传输（timestamptz） */
export type Timestamp = string

/**
 * rehab_sessions.waveform 的结构。
 *
 * 采用**列式**而非行式存储：三个数组等长，下标 i 对应同一采样时刻。
 * 相比 [{t, r, temp}, ...] 这种行式写法体积小一半以上，
 * 而且正好是 ECharts 直接能吃的格式，不用前端再转一次。
 *
 * temp_c 可选 —— 只做应变监测的会话没有温度通道。
 */
export interface Waveform {
  /** 相对会话开始的毫秒偏移 */
  t_ms: number[]
  /** 电阻值（欧姆） */
  r_ohm: number[]
  /** 局部温度（摄氏度），可选 */
  temp_c?: number[]
  /**
   * 表面肌电（mV），可选。
   *
   * 与 t_ms 等长，用于做「关节角度与肌电的关联性分析」—— 那是命题答题
   * 要求里点名的一项。不存下来的话，历史会话就做不了这项分析。
   * 早期记录没有这个键，读取方需按可选处理。
   */
  emg_mv?: number[]
}

/** Supabase 返回的统计结果（`.select('...', { count: 'exact' })` 时使用） */
export interface QueryResult<T> {
  data: T | null
  error: string | null
}


// ---------------------------------------------------------------------------
// profiles —— 用户资料
// ---------------------------------------------------------------------------

// ⚠️ 表结构类型一律用 `type` 而非 `interface`，这不是风格偏好：
//    supabase-js 把 Database 泛型约束在 `GenericSchema` 上，其中要求
//    `Row extends Record<string, unknown>`。而 TypeScript 只为**类型别名**
//    推断隐式索引签名，interface 不会——写成 interface 会导致约束校验失败，
//    整个 schema 静默塌成 never，接着所有 .insert()/.update() 的入参
//    都变成 never，报错信息却出现在毫不相干的 store 文件里。
export type Profile = {
  id: string
  role: UserRole
  display_name: string | null
  phone: string | null
  /** 日期，格式 YYYY-MM-DD */
  birth_date: string | null
  /**
   * 监护邀请码，6 位大写字母数字（去掉了 I/L/O/0/1 这些形近字符）。
   * 患者把它发给家属，家属凭码发起监护申请。迁移 7 新增。
   * 不可修改 —— 能改就等于能冒用别人的码接收申请。
   */
  invite_code: string | null
  created_at: Timestamp
  updated_at: Timestamp
}

/** 正常情况下由 handle_new_user 触发器自动建档，前端不需要手动插入 */
export type ProfileInsert = Pick<Profile, 'id'> &
  Partial<Pick<Profile, 'role' | 'display_name' | 'phone' | 'birth_date'>>

/** 只含列级授权允许更新的列（role 不在其中，改不了） */
export type ProfileUpdate = Partial<
  Pick<Profile, 'display_name' | 'phone' | 'birth_date'>
>


// ---------------------------------------------------------------------------
// care_links —— 患者 ↔ 家属/治疗师 的监护关系
// ---------------------------------------------------------------------------

export type CareLink = {
  id: string
  patient_id: string
  caregiver_id: string
  relation: CareRelation
  status: CareLinkStatus
  created_at: Timestamp
  updated_at: Timestamp
}

/**
 * 插入时注意 RLS 的约束：
 *   患者本人发起 → status 可以是 pending 或 active
 *   监护者发起   → status 只能是 pending，等患者确认
 */
export type CareLinkInsert = Pick<CareLink, 'patient_id' | 'caregiver_id'> &
  Partial<Pick<CareLink, 'relation' | 'status'>>

/** 关系双方不可变更；只有患者本人能把 status 改成 active（由触发器强制） */
export type CareLinkUpdate = Pick<CareLink, 'status'>


// ---------------------------------------------------------------------------
// devices —— 柔性传感器设备
// ---------------------------------------------------------------------------

export type Device = {
  id: string
  serial_no: string
  owner_id: string | null
  /** 型号，FSIFSTS 为项目自研型号 */
  model: string
  status: DeviceStatus
  battery_pct: number | null
  firmware: string | null
  last_seen_at: Timestamp | null
  created_at: Timestamp
  updated_at: Timestamp
}

export type DeviceInsert = Pick<Device, 'serial_no'> &
  Partial<Omit<Device, 'id' | 'serial_no' | 'created_at' | 'updated_at'>>

export type DeviceUpdate = Partial<
  Omit<Device, 'id' | 'serial_no' | 'created_at' | 'updated_at'>
>

/** claim_device() 的返回结构 */
export interface ClaimDeviceResult {
  ok: boolean
  reason:
    | 'claimed'
    | 'already_owned'
    | 'taken'
    | 'not_found'
    | 'invalid_serial'
    | 'not_authenticated'
  message: string
  /** 成功时返回设备 id */
  id?: string
}

/** request_care_link() 的返回结构 */
export interface CareLinkRequestResult {
  ok: boolean
  reason:
    | 'created'
    | 'already_pending'
    | 'already_active'
    | 'reopened'
    | 'not_found'
    | 'invalid_code'
    | 'invalid_relation'
    | 'self'
    | 'not_authenticated'
  message: string
  /** 成功时返回关系 id */
  id?: string
}


// ---------------------------------------------------------------------------
// rehab_sessions —— 康复训练记录
// ---------------------------------------------------------------------------

export type RehabSession = {
  id: string
  patient_id: string
  device_id: string | null

  joint: JointName
  /** 患者实际执行的动作 */
  exercise: string
  /** 双向 LSTM 判定的动作；与 exercise 不一致说明动作可能不标准 */
  recognized: string | null

  started_at: Timestamp
  ended_at: Timestamp | null
  duration_s: number | null

  rep_count: number | null
  /** 关节活动度（度）。动态屈伸类动作的判定指标 */
  rom_deg: number | null
  /**
   * 静力动作的**保持角度**（度），动态动作为 null。
   *
   * 靠墙静蹲这类静力动作不能用 rom_deg 判定达标 —— 它的活动范围
   * 天然只有 5~10°，而目标是保持 55°。详见 lib/assessment.ts 的
   * AssessMetric 与迁移 9 的说明。
   *
   * ⚠️ 可空还有一层原因：这列是后加的，**历史记录没有值**，而且无法
   *    还原（当时只在内存里算过，没落库）。读取方一律按"跳过"处理，
   *    不要当成 0。
   */
  hold_deg: number | null
  /** 该次训练期间的局部皮温峰值（摄氏度） */
  temp_c: number | null
  /** 肌电均方根值（mV）—— 肌肉激活强度。迁移 4 新增 */
  rms_mv: number | null
  /** 模型识别置信度，0~1 */
  confidence: number | null

  /** 降采样波形，建议 1000 点以内 */
  waveform: Waveform | null
  notes: string | null
  created_at: Timestamp
}

export type RehabSessionInsert = Pick<
  RehabSession,
  'patient_id' | 'exercise' | 'started_at'
> &
  Partial<Omit<RehabSession, 'id' | 'patient_id' | 'exercise' | 'started_at' | 'created_at'>>

export type RehabSessionUpdate = Partial<
  Omit<RehabSession, 'id' | 'patient_id' | 'created_at'>
>


// ---------------------------------------------------------------------------
// alerts —— 预警事件
// ---------------------------------------------------------------------------

export type Alert = {
  id: string
  patient_id: string
  device_id: string | null
  /** 触发该预警的训练会话，可为空（如设备离线类预警） */
  session_id: string | null

  kind: AlertKind
  severity: AlertSeverity
  message: string | null
  /** 触发时的实测值 */
  value: number | null
  /** 当时的阈值 —— 存下来才能事后解释"为什么报" */
  threshold: number | null

  occurred_at: Timestamp
  /** 为空表示未处理 */
  acknowledged_at: Timestamp | null
  acknowledged_by: string | null
  created_at: Timestamp
}

export type AlertInsert = Pick<Alert, 'patient_id' | 'kind'> &
  Partial<Omit<Alert, 'id' | 'patient_id' | 'kind' | 'acknowledged_at' | 'acknowledged_by' | 'created_at'>>

/** 只能标记已读/取消已读，severity 等列不在列级授权内 */
export type AlertUpdate = Pick<Alert, 'acknowledged_at'> &
  Partial<Pick<Alert, 'acknowledged_by'>>


// ---------------------------------------------------------------------------
// keepalive —— 保活心跳（前端一般不需要读，这里仅为类型完整）
// ---------------------------------------------------------------------------

export type Keepalive = {
  id: number
  last_ping: Timestamp
  ping_count: number
  note: string | null
}


// ---------------------------------------------------------------------------
// 视图模型 —— 前端展示用，不对应数据库表
// ---------------------------------------------------------------------------

/**
 * 监护关系 + 对方姓名。
 *
 * 只带姓名而不是完整 Profile —— 待确认阶段双方读不到对方资料（RLS 只放行
 * 已生效关系），姓名由 get_care_counterparts() 单独提供。
 */
export interface CareLinkWithName extends CareLink {
  /** 关系另一端那个人的 user id */
  counterpart_id: string
  /** 关系另一端那个人的显示名，可能为 null */
  counterpart_name: string | null
}

/** 首页概览数据 */
export interface DashboardSummary {
  /** 今日已完成的训练次数 */
  todaySessions: number
  /** 最近一次训练时间 */
  lastSessionAt: Timestamp | null
  /** 未处理的预警数量 */
  unacknowledgedAlerts: number
  /** 在线设备数量 */
  onlineDevices: number
}


// ---------------------------------------------------------------------------
// Supabase Database 泛型
// ---------------------------------------------------------------------------
// 传给 createClient<Database>() 后，.from('profiles').select() 的返回值
// 会自动带上行类型，不用手动断言。
//
// Views / Functions / Enums / CompositeTypes 用 `[_ in never]: never` 表示"空"
// —— 这是 Supabase CLI 生成类型时的标准写法，等价于一个没有任何键的对象，
// 但比 Record<string, never> 更严格（写 Views: {} 会报错）。
// ---------------------------------------------------------------------------

type TableDef<Row, Insert, Update> = {
  Row: Row
  Insert: Insert
  Update: Update
  Relationships: []
}

export interface Database {
  public: {
    Tables: {
      profiles: TableDef<Profile, ProfileInsert, ProfileUpdate>
      care_links: TableDef<CareLink, CareLinkInsert, CareLinkUpdate>
      devices: TableDef<Device, DeviceInsert, DeviceUpdate>
      rehab_sessions: TableDef<RehabSession, RehabSessionInsert, RehabSessionUpdate>
      alerts: TableDef<Alert, AlertInsert, AlertUpdate>
      keepalive: TableDef<Keepalive, never, never>
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      /** 保活心跳，返回 { last_ping, ping_count } */
      ping_keepalive: {
        Args: Record<string, never>
        Returns: { last_ping: Timestamp; ping_count: number }
      }
      /**
       * 按序列号认领无主设备。
       * security definer 函数 —— 绕过 RLS，内部自校验所有权。
       * 返回值用 reason 区分各种失败，便于前端给出准确提示。
       */
      claim_device: {
        Args: { p_serial: string }
        Returns: ClaimDeviceResult
      }
      /**
       * 凭邀请码发起监护申请。
       * 只能创建 pending 状态 —— 是否生效由患者本人在界面上确认。
       */
      request_care_link: {
        Args: { p_code: string; p_relation?: CareRelation }
        Returns: CareLinkRequestResult
      }
      /**
       * 取监护关系中对方的姓名（含待确认的）。
       * 只返回姓名，不返回其他资料 —— 见迁移 8 的说明。
       */
      get_care_counterparts: {
        Args: Record<string, never>
        Returns: { link_id: string; counterpart_id: string; display_name: string | null }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}
