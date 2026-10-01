/**
 * dsh-liubian —— 入口壳
 *
 * name / inject 必须静态导出（宿主要读），实现全部放在 impl.mjs，
 * 用 `?t=<时间戳>` 动态导入 —— 绕过 Node ESM 的模块缓存。
 *
 * 为什么需要这个壳：Node 按 URL 缓存 ESM 模块，同一 URL 的重复 apply
 * 拿到的仍是旧模块，改了 impl.mjs 代码不生效。有了这个壳，每次 apply
 * 都是新 URL → 新模块实例，impl.mjs 的改动就能真正生效。
 *
 * 装配方式：profile bundle（`dependencies` link: + `bundles` 名单 + 包内
 * cordis.patch.yml），与 super-injector 无依赖——改 impl.mjs 后的生效
 * 路径 = touch profile patch 触发重装配，或重启 DSH（二者取一）。
 *
 * 本文件只在「改 name/inject」时才需要动，且改后需重启 DSH 才会重新读。
 */
export const name = 'dsh-liubian'
export const inject = ['tools']

export async function apply(ctx, input = {}) {
  const url = new URL(`./impl.mjs?t=${Date.now()}`, import.meta.url).href
  const impl = await import(url)
  return impl.apply(ctx, input)
}
