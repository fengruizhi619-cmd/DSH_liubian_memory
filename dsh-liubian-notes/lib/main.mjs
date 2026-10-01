/**
 * dsh-liubian-notes —— 入口壳
 *
 * 与 dsh-liubian 同款两层结构：name / inject 静态导出（宿主要读），
 * 实现全部在 impl.mjs，用 `?t=<时间戳>` 动态导入绕过 Node ESM 模块缓存——
 * 改 impl.mjs 重新注入即热生效，不用重启 DSH。
 * 本文件只在「改 name/inject」时才需要动，且改后需重启 DSH。
 */
export const name = 'dsh-liubian-notes'
export const inject = ['tools']

export async function apply(ctx, input = {}) {
  const url = new URL(`./impl.mjs?t=${Date.now()}`, import.meta.url).href
  const impl = await import(url)
  return impl.apply(ctx, input)
}
