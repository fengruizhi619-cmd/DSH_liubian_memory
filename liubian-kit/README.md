# liubian-kit

流变家族跨插件服务的**形态基类套件**（协议 §19，contract-version 1.0）。纯形态、零家族依赖。

## 纪律（协议 §19，违反即评审打回）

1. **零家族依赖**：本套件不 import 任何家族插件/文件/服务；`DatabaseSync` 等由调用方传入。
2. **入 kit 门槛 = ≥2 个已验证实现**：只有一个实现的能力**不提取**（预留区等第二个出现）。
3. **基类只收形态、不收业务**：业务逻辑留在各组件。
4. kit 改动 = 可装载变更：**必涨版本** + 桩测强制 + 迁移窗口适用 + 消费方 pin 版本。
5. **桩测夹具用普通目录**，绝不 junction 真实仓库（2026-10-01 青芷事故：链接 + `rmSync recursive` = 删真库）。

## 分发（单源）

唯一源 = 家族仓库 `liubian-kit/`。消费方接入：

```powershell
New-Item -ItemType Junction -Path "<插件>/node_modules/liubian-kit" -Target "E:\DSH_data\流变系统\liubian-kit"
```

代码里 `import { BaseLiubianService } from 'liubian-kit'` 即可（bare specifier 沿 node_modules 解析）。
**kit 版本出现在服务挂载行**（`…｜liubian-kit v<N>`）——版本漂移可观测。

## BaseLiubianService（提供方形态）

```js
import { BaseLiubianService } from 'liubian-kit'

const svc = new BaseLiubianService({
  name: 'liubianMySvc',
  version: 1,
  methods: {
    async doThing({ x }) { return { ok: true, x } },   // 业务异常直接 throw，kit 折成 {ok:false,error}
  },
  logger: ctx.logger,
  pluginName: 'my-plugin',
  kitVersion: '0.1.0',
})
ctx.effect(() => svc.mount(ctx), 'my-plugin: 跨插件服务')
```

免费获得：**绝不抛**（异常折 `{ok:false,error}`）｜挂载三态（provide → reflect → warn 缺席）｜
服务戳行含 `(via)` 与 kit 版本｜`svc.call(method, args)` 的未知方法名显式报错。

消费方三行：

```js
import { consumeLiubianService } from 'liubian-kit'
const svc = consumeLiubianService(ctx, 'liubianMySvc')
if (!svc) return '[错误] liubianMySvc 服务不可用'   // 必须显式报错，禁止静默降级
```

## BaseTombstones（追加式墓碑事件流，SQLite 单源）

```js
import { BaseTombstones } from 'liubian-kit'
const t = new BaseTombstones(db, { keyColumn: 'session_hash' })   // 既有库列名不同可配，不要求迁移
t.ensureSchema()                                                  // 幂等；既有库已自行建表可不调

t.markForgotten(key, { actor, reason })   // 幂等：重复标记不重复追加
t.isForgotten(key)                        // 最新事件是 forget？
t.markLifted(key, { actor, reason })      // 复活也留痕，历史不删
const { seq, events, forgotten } = t.changesSince(mySeq)   // 查态读 forgotten；消费走 events 推水位
```

⚠ **本类不带事务**：多步业务（解绑 + 清登记 + 写墓碑）由调用方 `BEGIN/COMMIT` 包住本类调用——
部分失败零写入是消费方的纪律，kit 不替你决定事务边界。

## 合规桩测模板

`_dev/stub_test.mjs` 即模板：新组件继承后**照抄断言结构**、替换业务参数即可自证合规。
kit 自身桩测数随 `package.json` 版本公示（当前见文件头注释）。
