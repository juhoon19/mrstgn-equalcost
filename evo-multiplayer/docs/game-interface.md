# 把你的游戏接进来

网络层（分片、网关、快照、客户端副本）对游戏内容一无所知。服务器端所有游戏逻辑在一个模块里，默认是 `src/game/soup.js`。写一个同样导出这些东西的文件，启动时 `GAME=你的文件路径` 或 `--game ./path/to/mygame.js` 即可。

**从模板开始**：`src/game/template.js` 是一个 100 行左右、注释齐全的最小游戏（粒子在热场里漂移、玩家可以放粒子/加热/推动），覆盖了所有钩子。复制它改名开始写，`node src/launch.js --game template` 可以直接跑。`test/games.test.js` 会对 `src/game/` 下列出的每个游戏跑一遍跨分片迁移和快照往返测试，把你的游戏名加进去即可。

## 必须导出

```js
export const fieldDiffusion = [70, 50, 320]; // 每个化学通道的扩散系数（单位²/秒）
export const fieldDecay     = [0, 0.01, 0.9]; // 每个通道的衰减率（1/秒）

export function init(region) {}              // 分片启动时：给自己拥有的区块放初始实体/初始化学场
export function step(region, dt) {}          // 每 tick：更新 region.local 里的所有实体
export function onAction(region, action, player) {}  // 玩家工具 → 返回 true 表示生效（会广播特效）
export function encodeData(entity, writer) {}         // 迁移时序列化 entity.data（基因、脑状态…）
export function decodeData(entity, reader) {}         // 对应反序列化
```

可选：

```js
export function react(region, chunk, dt) {}  // 每次化学步：直接改 chunk.field（反应、光照、源汇）
```

`src/server/game-loader.js` 启动时会检查必须的导出是否齐全。

## 实体（Entity）

网络层识别的字段（客户端据此绘制）：

| 字段 | 含义 | 发给客户端的精度 |
|---|---|---|
| `x, y` | 世界坐标 | 1/8 单位 |
| `vx, vy` | 速度（只在服务器、迁移时带上） | — |
| `r` | 半径 | 1/4 单位，最大 63.75 |
| `kind` | 类型 0–255，客户端按它选择画法 | 1 字节 |
| `rgb` | 颜色 0xRRGGBB | 3 字节 |
| `owner` | 所属玩家 pid（谱系），0 = 野生 | varint |
| `level` | 0–255 的任意“等级”（演示里是能量），发送时量化到 16 档 | 1 字节 |
| `energy, age` | 服务器用，迁移时带上 | — |
| `data` | 你的任意对象，经 `encodeData/decodeData` 迁移 | — |

新建：`region.spawn({ kind, x, y, r, rgb, owner, energy })`，返回实体，下一 tick 生效（坐标不在本分片时会自动迁移过去）。
删除：`region.kill(e)`。

## region 提供的工具

```js
region.local                 // 本分片所有活实体（本 tick）
region.near(x, y, R, fn)     // 遍历附近实体（含幽灵 e.ghost===true，只读！）
region.nearest(x, y, R, exclude, kind)   // 最近的某类实体，无分配
region.sampleField(x, y, ch) // 化学场取值
region.fieldGradient(x, y, ch)           // 梯度 [gx, gy]
region.fieldAdd(x, y, ch, amount)        // 改一个格子，返回实际改动量（不会低于 0）
region.fieldSplash(x, y, R, ch, amount)  // 圆形范围内平均加
region.rng() / region.rng.gauss()        // 可复现的随机数
region.players.get(pid)      // { name, rgb, hue }
region.tick, region.time, region.world, region.topo
```

## 两条硬规则（跨分片正确性）

1. **只改本地实体**。`near()` 会给你幽灵（`e.ghost === true`），它们属于邻居分片：可以读（碰撞、感知、决策），不能改、不能 kill。对称的相互作用（如推开）只改自己那一方——对面分片会对它的实体做同样的事。
2. **`entity.data` 必须能完整序列化**。实体越过分片边界时只有 `encodeData` 写出的东西会过去。

## 客户端

`public/client.js` 按 `kind` 画圆（1 = 生物，2 = 碎屑）。你的游戏新增 kind 时，在 `render()` 的实体循环里加对应的画法；化学场的着色在 `fieldImage()`。工具按钮在 `index.html` 的 `#tools`，动作编号在 `src/shared/protocol.js` 的 `ACTIONS` 和 `ACTION_COOLDOWN_MS`（网关按它限速，只要新增编号和冷却即可，网关不需要改）。

## 调参流程

```bash
node bench/headless.js --shards 4 --world 16x16 --seconds 600   # 看种群/能量/迁移/每 tick 耗时
node --test test/*.test.js                                      # 包含一条“跨分片 ids 唯一、种群不崩溃”的测试
```

## 世界参数

`TOPOLOGY` 里的 `world` 可改：`chunksX, chunksY`（区块数）、`chunkSize`（≤ 8191）、`fieldRes`（每区块场网格，需能被 `FIELD_NET_RES` 整除）、`channels`（化学通道数，默认 3，客户端着色用前 3 个；游戏的 `fieldDiffusion` 比它短时，多出的通道保持为 0）。
