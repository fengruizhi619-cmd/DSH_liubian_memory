/** kit 自身版本从 ./version.mjs 单源取（防"index 与基类各自一份"的两处真相）。 */
import { KIT_VERSION } from './version.mjs'

/**
 * BaseLiubianService —— 跨插件服务**提供方**的形态基类（协议 §19）。
 * 提取自 infra / 被炉 / 记忆 三处 provide 形态（≥2 已验证实现门槛达成）。
 *
 * **零家族依赖**：本文件不 import 任何家族插件/文件/服务（协议 §19 纪律——内层依赖不许成链）。
 *
 * 子类/实例契约：
 *   name     服务名（`liubian<能力>`，必填）
 *   version  数字版本（消费方启动时校验；可装载变更必涨）
 *   methods  方法表：{ 方法名: async (args) => 任意结果 }
 *
 * 免费获得（协议对应条目）：
 *   - 绝不抛：方法调用经 safeCall 包装，异常一律折成 { ok:false, error }（§3 #4）
 *   - 挂载：ctx.provide 优先 → ctx.reflect.provide 回退 → 皆无 warn + 服务缺席（§3 #2）
 *   - 挂载双行日志：服务戳行含 (via) 后缀 **及 kit 版本**（§7 #7 + 青芷：版本漂移可观测）
 *   - 消费侧三行模板 consumeLiubianService：拿不到返回 null，消费方必须显式报错（§3 #3）
 */
export class BaseLiubianService {
  name = ''
  version = 1
  methods = {}

  constructor({ name, version, methods, logger, pluginName, kitVersion } = {}) {
    if (name) this.name = String(name)
    const declared = Number(version) || 1
    this.version = declared
    if (methods) {
      this.methods = methods
      // 直调形态（协议 §17 消费模板 + 全部既有消费方的调用方式）：把方法铺到实例上，
      // 让 `svc.foo()` 与 `svc.call('foo')` 并存。
      // ⚠ v0.1.1 补（守夜人行使验收权实测）：v0.1.0 只有 call()，infra v0.5.0 装载后
      //   被炉三个消费点的直调（isForgotten/changes/forgetSession）全部落空——
      //   「提供方活着」不等于「消费方可用」，验收必须含一次消费方公开形态的真调。
      Object.assign(this, methods)
      this.version = declared   // 方法表里若带 version 字段，不得覆盖声明的服务版本
    }
    this.logger = logger || null
    this.pluginName = pluginName || ''
    this.kitVersion = kitVersion || null
  }

  /**
   * 绝不抛：调用方法表中的方法，异常一律折成 { ok:false, error }（协议 #4）。
   * 未知方法名 → { ok:false, error }（不是静默兜底成别的方法）。
   * 注意：直调形态（svc.foo()）**不带这层包装**——"方法自身不抛、返回 {ok,error}"
   * 是提供方写方法表时的契约义务（三家现役服务均已守约）。
   */
  async call(method, args = {}) {
    const fn = this.methods[method]
    if (typeof fn !== 'function') return { ok: false, error: `未知方法：${method}` }
    try {
      return await fn(args)
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) }
    }
  }

  /**
   * 挂载（协议 #2 的形态）：ctx.provide 优先 → ctx.reflect.provide 回退 → 皆无 warn + 服务缺席。
   * 返回提供方注册的 disposer（调用方负责用 ctx.effect 包裹与清理）。
   * 服务戳行含 (via) 后缀与 kit 版本——这是消费方与管理员的自检锚点，抄差一个字段判据就散。
   */
  mount(ctx) {
    const arm = (label, fn) => {
      try {
        const disposer = fn(this.name, this)
        this.logger?.info?.(`[${this.pluginName}] 跨插件服务已挂载：${this.name} v${this.version}（${label}${this.kitVersion ? `｜liubian-kit v${this.kitVersion}` : ''}）`)
        return disposer
      } catch (e) {
        // 注意：这里只吞"注册动作"的异常并显式留痕——提供方方法内部的异常由 call() 折成 ok:false
        this.logger?.warn?.(`[${this.pluginName}] 跨插件服务挂载失败（${label}）：${(e && e.message) || e}`)
        return undefined
      }
    }
    if (typeof ctx.provide === 'function') return arm('ctx.provide', (n, v) => ctx.provide(n, v))
    if (typeof ctx.reflect?.provide === 'function') return arm('ctx.reflect.provide', (n, v) => ctx.reflect.provide(n, v))
    this.logger?.warn?.(`[${this.pluginName}] 宿主无 provide 通道（ctx.provide / ctx.reflect.provide 皆不可用）——跨插件服务未挂载；改名/解绑等写动作请显式报错，勿静默降级`)
    return undefined
  }
}

/**
 * 消费侧三行模板（协议 #3 的形态）：拿不到返回 **null**，消费方必须显式报错——
 * 禁止静默降级；如需降级，须按 §14 申报表登记且能分辨"为什么不在"（离线 ≠ 已删 ≠ 显式停止）。
 */
export function consumeLiubianService(ctx, name) {
  try {
    return (ctx.reflect?.get?.(name) ?? ctx.get?.(name)) || null
  } catch {
    return null
  }
}
