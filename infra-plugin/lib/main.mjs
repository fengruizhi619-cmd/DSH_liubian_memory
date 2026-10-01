/**
 * dsh-liubian-infra 入口壳（家族标准 §1：静态壳 + impl.mjs?t= 缓存戳动态导入）
 * 改实现请改 impl.mjs —— uninject + inject 即热生效，本文件几乎永不改动。
 */
export const name = 'dsh-liubian-infra'
export const inject = ['tools']

export async function apply(ctx, input = {}) {
  const url = new URL(`./impl.mjs?t=${Date.now()}`, import.meta.url).href
  const impl = await import(url)
  return impl.apply(ctx, input)
}
