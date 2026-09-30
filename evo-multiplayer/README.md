# evo-multiplayer · 二维物理生物化学演化游戏的公网多人底座

让**任意数量的人**通过浏览器同时进入同一个二维生命演化世界并互相影响：投放营养、播种自己的谱系、搅动水流、释放信号素、看到彼此的光标和聊天。
服务端是权威模拟（防作弊、结果一致），世界切成区块由多个分片进程并行模拟，前面一层网关把快照扇出给所有玩家——人数上来就加网关，世界算不动就加分片。

![截图](docs/screenshot.png)

自带一个可玩的演示游戏“原始汤”（`src/game/soup.js`）：光照驱动营养再生、代谢产生废物、信号素扩散；每个生物有一个小神经网络，分裂时基因突变，颜色随基因漂移，谱系会自然分化。**它只是一个可替换的模块**，你自己的游戏按 [docs/game-interface.md](docs/game-interface.md) 实现同样的几个函数就能直接跑在这套网络层上。

## 30 秒跑起来

```bash
cd evo-multiplayer
npm install
npm start                     # 默认：CPU 数自动决定分片/网关数量，端口 8080
# 打开 http://localhost:8080
```

常用参数：`node src/launch.js --shards 4 --gateways 2 --port 8080 --world 24x24`

## 放到公网（三选一）

| 方式 | 适合 | 命令 |
|---|---|---|
| **Cloudflare 快速隧道**（家里电脑直接公网，不用域名/公网 IP/端口转发） | 朋友试玩，≈200 人以内 | `./scripts/tunnel.sh` → 输出 `https://xxx.trycloudflare.com` |
| **一台 VPS + Docker Compose + Caddy**（自动 HTTPS、多网关负载均衡） | 正式上线，几千人 | `cd deploy && DOMAIN=你的域名 CLUSTER_SECRET=… TOKEN_SECRET=… docker compose up -d --scale gateway=3` |
| **Fly.io 单机** | 不想管服务器 | `fly deploy --config deploy/fly.toml` |

多台机器、上万人的部署方式、安全清单见 [docs/deploy.md](docs/deploy.md)。

## 架构一图

```
 浏览器 ×N ──wss──┐
 浏览器 ×N ──wss──┤   负载均衡(Caddy/Cloudflare/任意 L4/L7，无需粘性会话)
 浏览器 ×N ──wss──┘
        │
   ┌────┴─────┬──────────┐        网关层：只管连接，无状态，可随意加
   │ 网关 A   │ 网关 B   │ …      · 兴趣管理：每个玩家只订阅视野内区块
   └────┬─────┴────┬─────┘        · 同一区块对一个网关只订阅一次（引用计数）
        │  内网 ws  │              · 分片编码好的字节原样转发 + 每人每 tick 合并成 1 条消息
   ┌────┴───┬──────┴──┬────────┐   · 慢客户端：不堆积，从关键帧重新同步
   │ 分片 0 │ 分片 1  │ 分片 2 │ … 分片层：权威模拟，各管一块矩形区块
   └───┬────┴────┬────┴────┬───┘  · 边界实体以“幽灵”只读复制给邻居（碰撞/感知跨缝）
       └── 迁移 + 幽灵 ──┘         · 实体越界 → 连同基因整体迁移给新主人，id 不变
                                   · 过载时整体放慢（时间膨胀），不跳帧不爆炸
```

关键设计（详细见 [docs/architecture.md](docs/architecture.md)）：

1. **编码一次，扇出 N 次**：每个区块每个网络帧只编码一次（关键帧 + 增量），网关原样转发给所有观看者。观众多少不影响分片 CPU。
2. **兴趣管理 + LOD**：只收视野内区块的完整数据；缩得很远时改收全世界低清概览（每区块人口/主色/营养）。
3. **“最新者为准”的客户端合并**：区块流之间没有全局顺序（跨分片交接、网关回放缓存），客户端用分片时钟判断谁的信息更新，保证不会丢实体或重影——端到端测试逐个实体对比服务器真值。
4. **一切可测**：`npm test` 会启动真实的 4 分片 + 网关，连真实客户端，冻结模拟后逐个核对实体位置。

## 实测（单台 4 核容器，分片/网关/压测机器人都挤在同一台）

| 场景 | 结果 |
|---|---|
| 1 网关 1000 人 | 网关 CPU 37%，出口 37.7 MB/s，RTT p50 1ms / p95 15ms，0 失步 |
| 2 网关 2000 人 | 均分 999/1001，总出口 93 MB/s，RTT p50 ≈10ms / p95 ≈55ms，0 失步 |
| 模拟 | ≈2.3 µs / 生物 / tick；2 分片各 1 万实体时触发时间膨胀（73% 速度），加分片即可 |
| Docker Compose 4 分片 + 网关 | 跨容器运行、2×2 分片角落交接，0 失步 |

每位玩家下行带宽 ≈ 视野内实体数 × ~25 字节/秒（画面里 450 个生物 ≈ 19 KB/s ≈ 150 kbps）。完整数据和方法见 [docs/benchmarks.md](docs/benchmarks.md)。

## 参考了谁、借鉴了什么

r/place（百万人同画布：差量推送、冷却限速）、EVE Online（时间膨胀）、Screeps（按房间并行处理的 MMO）、SpatialOS / Star Citizen 服务器网格（空间分区 + 权威转移 + 兴趣管理）、Gaffer on Games（快照增量 + 量化）、slither.io / agar.io（WebSocket .io 游戏单服规模）、Colyseus（房间 + 二进制增量）、Network Tierra（数字生物在互联网上迁移演化）。逐条对照见 [docs/references.md](docs/references.md)。

## 目录

```
src/shared/     浏览器和服务器共用：二进制编解码、协议、拓扑、客户端世界副本
src/server/     shard-node.js 分片 · gateway-node.js 网关 · region.js 区块/幽灵/迁移
                snapshot.js 快照编码 · link.js 内部连接 · game-loader.js
src/game/       soup.js 演示游戏（替换成你的）
src/launch.js   单机一键启动（多进程）
public/         浏览器客户端（Canvas 2D，支持触屏）
bench/          bots.js 压测机器人（同时校验协议一致性）· headless.js 无网络模拟调参
test/           单元测试 + 端到端真值对比
deploy/         docker-compose.yml · Caddyfile · fly.toml
scripts/        tunnel.sh 一键公网 · dev-bg.sh / dev-stop.sh
docs/           架构、协议、接入指南、部署、参考、压测
```

## 常用命令

```bash
npm test                                             # 12 个测试，含真实网络端到端
node bench/headless.js --shards 4 --world 16x16      # 不开网络，看生态/性能
node bench/bots.js --url ws://localhost:8080/ws --n 500 --duration 60   # 压测
curl localhost:8080/metrics                          # 网关指标
curl localhost:9100/metrics                          # 分片指标（内网）
```
