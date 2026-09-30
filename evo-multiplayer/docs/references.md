# 别人怎么做的，我们借鉴了什么

按“对任意人数实时互动”这个问题，逐一对照做过同类事情的项目。每条写明它解决了什么、我们拿来了什么、没拿什么和原因。

## 大规模同屏互动

### Reddit r/place（2017、2022）
- 2022 年 4 天里上百万用户放了 1.6 亿个像素，峰值约 9 万并发、每秒最多 8 千次写入。画布拆成 4 块 1000×1000，先给一张完整图，之后每 0.25–0.5 秒通过 WebSocket 推一张**差量图**；2017 版用位图 + Redis + WebSocket + RabbitMQ。
- **借鉴**：先发关键帧再发差量（我们的 `S_CHUNK` 关键帧/增量）；画布分块、只推你看的那块（兴趣管理）；每人操作有冷却（工具冷却 + 令牌桶）。
- **不同**：r/place 的状态只由玩家改变，我们的世界还在自己演化，所以状态变化远多于玩家输入，必须用权威模拟 + 快照而不是事件日志。
- 参考：[Fastly: Reddit on building & scaling r/place](https://fastly.com/blog/reddit-on-building-scaling-rplace)、[Reddit Place and how they did it](https://jonathanmh.com/p/reddit-place-and-how-they-did-it)

### slither.io / agar.io（.io 游戏）
- 纯 WebSocket 的 HTML5 游戏；slither.io 作者说最难的是让每台服务器稳定承载 600 人，并且为了避开云厂商的高带宽费用不用 AWS。
- **借鉴**：浏览器 + WebSocket 足够做实时游戏；**带宽是主要成本**，所以我们在字节上花了大力气（量化、差分 id、只发变化字段、场下采样），每人从 63 KB/s 压到约 19 KB/s。
- **不同**：.io 游戏是“很多个 600 人的房间”，人满了就开新房间；我们要的是**同一个世界**里任意多人，所以用分片 + 网关代替分房间。
- 参考：[Slither.io – Wikipedia](https://en.wikipedia.org/wiki/Slither.io)、[Pocket Gamer 访谈](https://www.pocketgamer.com/articles/070063/interview-the-future-of-slither-io-and-tips-direct-from-the-developer/)

## 一个世界、多台服务器

### SpatialOS（Improbable）
- 一切皆“实体 + 组件”；**同一时刻一个组件只有一个 worker 拥有权威**；worker 通过**兴趣查询**订阅自己权威实体周围的东西。
- **借鉴**：实体唯一主人（包含它的区块的主人分片）、主人之外只读（幽灵）、权威随位置转移（迁移）、客户端也只订阅兴趣范围。
- **没拿**：SpatialOS 的组件级权威和查询式兴趣很通用但很重；我们用“区块”为粒度，拓扑是纯函数，任何进程都能算出谁拥有什么。
- 参考：Improbable 专利 [Simulation systems and methods using query-based interest](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10579434)、[Load balancing for spatially-optimized simulations](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10303821)

### Star Citizen 服务器网格（Server Meshing）
- 多台服务器无缝拼成一个大世界；“动态网格”可以按人群密度把一块区域继续细分给更多服务器。2024 年 12 月 4.0 首次上线静态网格，每个 shard 500 人。
- **借鉴**：静态网格是我们的现状，动态重划分是列在 architecture.md 里的下一步（区块状态已经自包含，便于搬迁）。
- 参考：[Server meshing – Star Citizen Wiki](https://starcitizen.tools/Server_meshing)、[MassivelyOP 2026-02 进展](https://massivelyop.com/2026/02/06/star-citizen-cto-outlines-progress-on-server-meshing/)

### Screeps（MMO 编程游戏）
- 世界由房间组成，**处理阶段各房间并行**，并行数等于 CPU 核数；一个房间由一个核同步处理，避免竞态。引擎分 main / runners（玩家代码）/ processors（意图处理）。后来从“星型”改为“多个松耦合的星”（world shards）。
- **借鉴**：以空间单元为并行粒度、单元内单线程、单元之间只通过消息（我们的迁移 + 幽灵）；玩家输入先变成“意图”，由拥有该位置的进程执行（我们的 `I_ACTIONS` 按坐标路由）。
- 参考：[Screeps server-side architecture](https://docs.screeps.com/architecture.html)、[Screeps world shards](https://blog.screeps.com/2017/08/shards/)

## 过载时怎么办

### EVE Online 时间膨胀（TiDi，2011）
- 单星系上千人大战时服务器过载，TiDi 让游戏时钟变慢（极端时 5%，常见约 30%），每个请求都被公平、及时地处理，只是一切都慢了几倍。
- **借鉴**：分片算不完就整体变慢，不跳帧、不放大 dt、不丢玩家输入；把当前流速显示给玩家（HUD“时间流速”）。压测中 2000 机器人一共播种了几万个生物，流速降到 73%，没有卡死或爆炸。
- 参考：[Introducing Time Dilation (TiDi)](https://www.eveonline.com/news/view/introducing-time-dilation-tidi)、[EVE University: Time dilation](https://wiki.eveuniversity.org/Time_dilation)

## 同步与压缩

### Gaffer on Games（Glenn Fiedler）
- 快照相对一个**基线**做增量；通过 ack 更新基线以应对丢包；**量化**去掉不需要的精度；有损压缩的量化最好在本地也同样应用。
- **借鉴**：量化位置（1/8 单位）、只发变化字段、zigzag 变长整数、关键帧 + 增量。
- **不同**：他的方案针对 UDP（会丢包），每个客户端的基线不同，所以要为每个人单独编码。我们在 WebSocket（可靠有序）上用**流内上一帧**作为基线，于是所有观众共享一份编码结果，这正是“任意人数”的关键。代价是新观众要从关键帧追上，由网关缓存链解决。
- 参考：[Snapshot Compression](https://gafferongames.com/post/snapshot_compression/)、[Networked Physics (2004)](https://gafferongames.com/post/networked_physics_2004)

### Colyseus
- 房间制 Node.js 多人框架，状态用 Schema 描述，自动追踪变化并以二进制增量按 patchRate（默认 50ms）发给客户端，用 Redis 做跨节点 presence。
- **借鉴**：二进制增量、服务端权威、固定发送频率。
- **没用它本身**：Colyseus 以“房间”为单位，一个房间的状态在一个进程里、对房间所有人广播；我们需要一个跨进程的连续世界和按视野订阅，所以自己实现了分片 + 网关。如果你的游戏将来有“房间/副本”玩法，Colyseus 是很好的选择。
- 参考：[Colyseus 概念](https://docs.colyseus.io/concepts)、[跨节点状态同步讨论](https://github.com/orgs/colyseus/discussions/578)

## 同题材：互联网上的人工生命

### Network Tierra（Thomas Ray，1990 年代）
- 把 Tierra 数字生物放进由成千上万志愿者电脑组成的网络，生物可以把自己的**基因组通过网络发送到别的机器**，在网络里迁移、竞争、演化；甚至会“追着夜晚跑”，因为夜里空闲 CPU 多。
- **借鉴**：生物跨机器迁移时带着完整基因（我们的 `encodeMigration` 把基因组、神经网络状态一起带走）；环境资源随时间在空间中移动（我们的光照斑块缓慢漂移，种群必须跟着走）。
- 参考：[Network Tierra FAQ](https://www.tomray.me/tierra/netfaq.html)、[California Wild 1994 报道](https://research.calacademy.org/calwild/1994summer/stories/horizons.htm)

## 部署

### Cloudflare Tunnel
- 快速隧道（trycloudflare）无需账号即可把本机端口暴露为 `https://随机名.trycloudflare.com`，支持 WebSocket；但**同时在途请求上限 200**（每条 WebSocket 都算一个），没有 SLA，只适合测试。注册免费账号建命名隧道没有这个上限。
- **借鉴**：`scripts/tunnel.sh` 一条命令公网试玩；文档里写清楚 200 人上限和升级路径。
- 参考：[TryCloudflare 文档](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)、[Quick Tunnels 指南](https://flaviocopes.com/cloudflare-quick-tunnels/)
