/**
 * dsh-liubian-embed —— 入口壳
 *
 * 与 dsh-liubian 同一个套路：name/inject 静态导出，实现放在 impl.mjs，
 * 用 `?t=<时间戳>` 动态导入绕过 Node 的 ESM 模块缓存
 * （本机 DSH 的 loader.internal 不可用，反注入再注入拿到的仍是旧模块）。
 * 所以改 impl.mjs 后重新注入即热生效，不需要重启 DSH。
 */
export const name = 'dsh-liubian-embed'
export const inject = ['tools']

export async function apply(ctx, input = {}) {
  const url = new URL(`./impl.mjs?t=${Date.now()}`, import.meta.url).href
  const impl = await import(url)
  return impl.apply(ctx, input)
}
