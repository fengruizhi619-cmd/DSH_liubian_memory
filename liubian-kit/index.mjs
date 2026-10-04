/**
 * liubian-kit —— 流变家族跨插件服务的**形态基类套件**（协议 §19，contract-version 1.0）。
 *
 * 定位（管理员 2026-10-05 终审：B 案共享依赖，四批迁移，基建+向量为第一批）：
 *   - 只收**形态**、不收**业务**——业务逻辑留在各组件，kit 不长成第二个单体；
 *   - **零家族依赖**：本套件不 import 任何家族插件/文件/服务（内层依赖不许成链）；
 *   - kit 改动 = 可装载变更：**必涨版本** + 桩测强制 + 迁移窗口适用 + 消费方 pin 版本；
 *   - 挂载行必须带 kit 版本（`｜liubian-kit v<N>`）——版本漂移可观测。
 *
 * 分发（单源）：家族仓库 `liubian-kit/` 为唯一源；消费方以 junction
 *   `<插件>/node_modules/liubian-kit → <家族仓库>/liubian-kit` 接入，bare import 即可解析。
 */
export { KIT_VERSION } from './lib/version.mjs'
export { BaseLiubianService, consumeLiubianService } from './lib/base-liubian-service.mjs'
export { BaseTombstones } from './lib/base-tombstones.mjs'
export { BaseJsonlFile } from './lib/base-jsonl-file.mjs'
