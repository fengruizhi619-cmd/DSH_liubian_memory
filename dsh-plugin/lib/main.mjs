/**
 * @dsh-external/dsh-liubian —— 入口壳
 *
 * name / inject 必须静态导出（宿主要读），实现全部放在 impl.mjs，
 * 用 `?t=<时间戳>` 动态导入 —— 绕过 Node ESM 的模块缓存。
 *
 * 为什么需要这个壳：插件是「热注入」的（super-injector 建 junction + loader 加载），
 * 但 Node 按 URL 缓存 ESM 模块，反注入再注入拿到的仍是旧模块，改了代码不生效。
 * 实测踩到过：改完 tools.mjs 重新注入，运行日志还是旧版本的字符串。
 * 有了这个壳，之后改 impl.mjs 就能真正热生效，不需要重启 DSH。
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
