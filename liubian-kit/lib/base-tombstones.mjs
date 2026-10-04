/**
 * BaseTombstones —— **追加式墓碑事件流**的形态基类（协议 §19）。
 * 提取自 infra 的 SQLite 形态（**单源**：被炉侧 2026-10-05 明示放弃双源提取——
 * SQLite 事件表 vs JSON 文件存储异构，捏成两栖抽象违反"只收形态不收业务"的纪律）。
 *
 * **零家族依赖**：不 import 任何家族插件/文件/服务；DatabaseSync 实例由调用方传入（鸭子类型）。
 *
 * 形态（2026-10-01/02 两天事故沉淀，每条都有出处）：
 *   1. 事件表**只增不改**：forget / lift 各是一条新事件。若写成「一行一状态 + 更新列」，
 *      按水位轮询的消费方**永远看不到复活事件**（实测：lift 只改列不改 id，水位直接漏）。
 *   2. 当前状态 = 该 key 中 **id 最大**那行的 op。
 *   3. `changesSince` 返回 **增量事件 + 全量快照**：查"是否被删"走快照（forgotten），
 *      消费事件走增量推水位——**两用途别混**（用 since:0 查态再顺手推水位 = 漏事件，实测踩过）。
 *   4. 幂等：重复 forget 不再追加事件；重复 lift 同理。
 *   5. **不带事务**：调用方负责事务包裹（协议：部分失败零写入）——本类只做事件流本身，
 *      多步业务（如"解绑+清登记+写墓碑"）由消费方 BEGIN/COMMIT 包住本类调用。
 *
 * key 列名可配（默认 `key`）：既有库已用别的列名（如 infra 的 `session_hash`）时传
 * `keyColumn`，**不要求迁移既有表**。
 */
export class BaseTombstones {
  constructor(db, { table = 'tombstones', keyColumn = 'key', forgetOp = 'forget', liftOp = 'lift' } = {}) {
    this.db = db
    this.table = String(table)
    this.keyColumn = String(keyColumn)
    this.forgetOp = String(forgetOp)
    this.liftOp = String(liftOp)
  }

  /** 建表（幂等）。既有库已自行建表的可以不调——DDL 与 infra 现表同构（列序一致）。 */
  ensureSchema() {
    const t = this.table, k = this.keyColumn
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${t} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ${k} TEXT NOT NULL,
        op TEXT NOT NULL,
        at TEXT NOT NULL,
        actor TEXT,
        reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_${t}_${k} ON ${t}(${k}, id);
    `)
  }

  /** 该 key 当前 id 最大的一行（null = 从无记录）。 */
  latest(key) {
    const t = this.table, k = this.keyColumn
    return this.db.prepare(`SELECT * FROM ${t} WHERE ${k} = ? ORDER BY id DESC LIMIT 1`).get(String(key)) || null
  }

  /** 是否处于「已忘记」态：最新一条事件是 forgetOp。 */
  isForgotten(key) {
    const r = this.latest(key)
    return !!r && r.op === this.forgetOp
  }

  /** 追加一条事件（**不自带事务**）。返回 { id, at } 供调用方落自己的账。 */
  append(key, op, { actor, reason } = {}) {
    const t = this.table, k = this.keyColumn
    const at = new Date().toISOString()
    const info = this.db
      .prepare(`INSERT INTO ${t} (${k}, op, at, actor, reason) VALUES (?,?,?,?,?)`)
      .run(String(key), String(op), at, actor == null ? null : String(actor), reason == null ? null : String(reason))
    return { id: Number(info.lastInsertRowid), at }
  }

  /** 标记忘记（幂等：已在墓碑态则**不重复追加**）。返回 { appended }。 */
  markForgotten(key, { actor, reason } = {}) {
    if (this.isForgotten(key)) return { appended: false }
    this.append(key, this.forgetOp, { actor, reason })
    return { appended: true }
  }

  /** 复活（幂等：不在墓碑态则不追加）。复活也留痕——**历史不删**。 */
  markLifted(key, { actor, reason } = {}) {
    if (!this.isForgotten(key)) return { appended: false }
    this.append(key, this.liftOp, { actor, reason })
    return { appended: true }
  }

  /**
   * 同步游标：**增量事件 + 全量快照**。
   * @returns { seq, events:[{id,key,op,at,actor,reason}], forgotten:[key…] }
   *   - 消费事件：处理 events 后把水位推到 seq；
   *   - 查态：读 forgotten（**不要**用 since:0 拉全量事件流查态——那次调用若顺手推了水位会漏事件）。
   */
  changesSince(since = 0) {
    const t = this.table, k = this.keyColumn
    const from = Number.isFinite(Number(since)) ? Number(since) : 0
    const events = this.db
      .prepare(`SELECT id, ${k} AS key, op, at, actor, reason FROM ${t} WHERE id > ? ORDER BY id`)
      .all(from)
    const m = this.db.prepare(`SELECT MAX(id) AS m FROM ${t}`).get()
    const forgotten = this.db
      .prepare(`SELECT ${k} AS key FROM ${t} x WHERE x.op = ? AND x.id = (SELECT MAX(id) FROM ${t} WHERE ${k} = x.${k}) ORDER BY key`)
      .all(this.forgetOp)
      .map(r => r.key)
    return { seq: m && m.m ? m.m : 0, events, forgotten }
  }
}
