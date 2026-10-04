/**
 * BaseJsonlFile —— **JSONL 数据文件即接口**的形态基类（协议 §19、§7 #19/#21）。
 * 提取自便签 pending_promotions 账目（青简 v0.7.3，第二实现；infra 墓碑流外第一个 JSONL）。
 *
 * **零家族依赖**：只依赖 node:fs / node:path。
 *
 * 形态（每条都有事故出处）：
 *   1. **首行 `_meta`**：`{"_meta":true,"schema":"<名>","version":N}`——写方宿主内补插（幂等）、
 *      存量文件由此升级、读侧容忍缺失。⚠ **meta 行禁带 id**（§7 #19：归因反解按 id 精确匹配，
 *      meta 带 id 会被误中）。
 *   2. **按键摘除**：jsonl 无唯一键 → 整表重写是唯一安全路径；谓词只删命中行、**坏行与 _meta
 *      行原样保留**；原子写（tmp + rename）。真实事故：同 id 二次送审按 (session_key,id) 摘除，
 *      把历史那条一并摘掉——**键不够唯一时，删除比写入更危险**。
 *   3. **-1 = 写失败**（与 0 = 没删到严格区分）：调用方必须如实回告，不得假装成功。
 *   4. 读侧纪律：逐行 parse、容忍 BOM / 坏行 / 未知字段；`rows()` 跳过 _meta 与坏行。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export class BaseJsonlFile {
  /**
   * @param {object} o
   * @param {string} o.file     jsonl 文件绝对路径
   * @param {string} o.schema   _meta 里的 schema 名（如 'pending-promotions'）
   * @param {number} [o.version=1]           _meta 里的 version
   * @param {(row:object)=>string} [o.keyOf] 可选：行 → 键串（供 removeByKey 便捷层）。
   *        ⚠ 键的组成是**业务决定**，必须取够字段保证唯一、宁长勿短；拼接分隔符要选**字段值中
   *        不可能出现的字符**（字段值不可控时用 `JSON.stringify([...parts])` 组键），
   *        防两行因字段值含分隔符而撞键。
   */
  constructor({ file, schema = '', version = 1, keyOf = null } = {}) {
    this.file = String(file || '')
    this.schema = String(schema || '')
    this.version = Number(version) || 1
    this.keyOf = typeof keyOf === 'function' ? keyOf : null
  }

  _metaLine() {
    return JSON.stringify({ _meta: true, schema: this.schema, version: this.version })
  }
  _stripBom(s) {
    return String(s || '').replace(/^\uFEFF/, '')
  }
  _firstIsMeta(lines) {
    if (!lines.length) return false
    try { return JSON.parse(this._stripBom(lines[0]))._meta === true } catch { return false }
  }

  /** 首行是否已是 _meta（容忍 BOM；文件不存在 = 无）。 */
  hasMeta() {
    if (!existsSync(this.file)) return false
    return this._firstIsMeta(this.rawLines())
  }

  /**
   * 首行 `_meta` 补插（幂等；写方在宿主内调用——**带外改文件会被活会话的内存快照回滚**，
   * 见便签 2026-10-01 事故）。返回 { inserted: boolean, error? }。
   */
  ensureMeta() {
    if (this.hasMeta()) return { inserted: false }
    const lines = this.rawLines()
    lines.unshift(this._metaLine())
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, lines.join('\n') + '\n', 'utf8')
      return { inserted: true }
    } catch (e) {
      return { inserted: false, error: (e && e.message) || String(e) }
    }
  }

  /** 读全部**数据行**（跳过 _meta 行与坏行；容忍 BOM / 未知字段）。 */
  rows() {
    const out = []
    for (const line of this.rawLines()) {
      try {
        const e = JSON.parse(this._stripBom(line))
        if (e && e._meta === true) continue
        if (e) out.push(e)
      } catch { /* 坏行跳过 */ }
    }
    return out
  }

  /** 原始行（含 _meta 与坏行）——摘除与对账用，保证无损。 */
  rawLines() {
    try { return readFileSync(this.file, 'utf8').split('\n').filter(l => l.trim()) } catch { return [] }
  }

  /** 追加一条（自动 ensureMeta）。返回 { ok }；false = 写失败（调用方如实回告）。 */
  append(entry) {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const lines = this.rawLines()
      if (!this._firstIsMeta(lines)) lines.unshift(this._metaLine())
      lines.push(JSON.stringify(entry))
      writeFileSync(this.file, lines.join('\n') + '\n', 'utf8')
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) }
    }
  }

  /**
   * 按谓词摘除（**只删命中行**；_meta 行与坏行原样保留）。原子写（tmp + rename）。
   * 🔴 v0.2.1（青简源作者复核建议）：重写时顺手过 `ensureMeta` 语义——**凡写必带 meta**，
   * 存量无 meta 的文件经一次摘除即升级，不必等下一次 append。
   * @returns {number} removed 条数；**-1 = 写失败**（与 0 = 没删到严格区分，调用方必须如实回告）
   */
  removeWhere(match) {
    if (typeof match !== 'function') return -1
    let lines = this.rawLines()
    const keep = []
    let removed = 0
    for (const line of lines) {
      let e = null
      try { e = JSON.parse(this._stripBom(line)) } catch { keep.push(line); continue }
      if (e && e._meta === true) { keep.push(line); continue }
      let hit = false
      try { hit = !!match(e) } catch { hit = false }
      if (hit) { removed += 1; continue }
      keep.push(line)
    }
    if (!removed) return 0
    if (!this._firstIsMeta(keep)) keep.unshift(this._metaLine())   // 凡写必带 meta
    try {
      const tmp = `${this.file}.tmp-${process.pid}`
      writeFileSync(tmp, keep.join('\n') + '\n', 'utf8')
      renameSync(tmp, this.file)
      return removed
    } catch {
      return -1
    }
  }

  /** 便捷层：按构造时给的 `keyOf` 摘除（键的组成是业务决定，宁长勿短——三元组起）。 */
  removeByKey(keyValue) {
    if (!this.keyOf) return -1
    const want = String(keyValue ?? '')
    return this.removeWhere(row => {
      try { return this.keyOf(row) === want } catch { return false }
    })
  }
}
