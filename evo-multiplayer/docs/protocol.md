# 协议

WebSocket，路径 `/ws`。二进制消息第一个字节是类型；文本消息是 JSON。所有多字节整数小端序；`varint` = 无符号 LEB128；`svarint` = zigzag + varint；`str` = varint 长度 + UTF-8。实现见 `src/shared/codec.js` 和 `src/shared/protocol.js`（浏览器、机器人、服务器共用同一份代码）。

## 握手（JSON）

客户端 → `{"t":"hello","name":"阿星","hue":0.33,"token":"<上次 welcome 给的 token，可省>","session":"<登录会话 token，可省>"}`

带 `session` 且有效时，玩家以账号身份进入：`pid` = 账号 id，名字和颜色取自账号，`welcome.account` 是账号信息；无效时以游客身份进入，并收到一条 `{"t":"ev","ev":{"type":"session-expired"}}`。游客的 `pid` 在 `[2^30, 2^31)` 范围内。

服务器 → `{"t":"welcome","v":1,"pid":123,"token":"123.xxxx","name":"阿星","hue":0.33,"rgb":…,
"world":{"chunksX":24,"chunksY":24,"chunkSize":256,"fieldRes":16,"channels":3},
"posQuant":8,"netHz":10,"maxChunks":30,"maxChunksLo":80,"viewMargin":96,"cooldowns":{"1":250,…},"gateway":"ab12cd34","zones":null,"zone":-1,
"account":{"id":7,"name":"阿星","role":"player","hue":0.33,"totp":false,"privacyDm":"everyone","mutedUntil":0} 或 null,"meta":true}`

10 秒内不发 hello 会被断开。

## 客户端 → 服务器

| 类型 | 名称 | 布局 | 频率建议 |
|---|---|---|---|
| 10 | `C_VIEW` | f32 x0, y0, x1, y1（世界坐标视口），可选 u8 档位（0 = 10Hz，1 = 2.5Hz） | 变化时，≤10/秒 |
| 11 | `C_ACTION` | u8 工具, f32 x, y, dx, dy | 按冷却 |
| 12 | `C_CURSOR` | f32 x, y | ≤7/秒 |
| 13 | `C_PING` | u32 任意值（原样返回） | 1/秒 |
| JSON | 聊天 | `{"t":"chat","text":"…"}` ≤200 字，1.2 秒一条；经过自动审核，被拦截时收到 `notice` | |
| JSON | 调用 | `{"t":"rpc","id":1,"m":"dm.send","a":{"to":7,"text":"hi"}}`，每连接 5 次/秒（突发 20） | |

工具编号：1 营养、2 播种、3 搅动（dx,dy 为方向）、4 信号素。消息 > 4KB 会被断开连接；超速消息被丢弃，持续超速会被断开。

## 服务器 → 客户端

| 类型 | 名称 | 内容 |
|---|---|---|
| 6 | `S_BATCH` | 重复 (varint 长度, 子消息)，同一 tick 的多条消息合并 |
| 1 | `S_CHUNK` | 区块实体帧（下详） |
| 2 | `S_FIELD` | varint 区块, u8 res, res×res×通道 个 u8（值 = 2^(q/40) − 1） |
| 3 | `S_SUMMARY` | varint chunksX, chunksY，然后每区块 u16 人口, u24 主色, u8 营养 |
| 4 | `S_PONG` | u32 回显 |
| 5 | `S_EVENTS` | 区块的光标与一次性事件（下详） |
| JSON | `stats` | `{"t":"stats","online","cells","entities","tidi","top":[[pid,name,count],…]}` 每秒 |
| JSON | `rpcr` | 调用结果：`{"t":"rpcr","id":1,"ok":true,"r":…}` 或 `{"t":"rpcr","id":1,"ok":false,"code":"BLOCKED","msg":"对方不接收你的消息"}` |
| JSON | `ev` | 实时推送：`{"t":"ev","ev":{"type":…}}`，type 有 `dm`、`friend`、`presence`、`trade`、`sold`、`muted`、`banned`、`session-expired` |
| JSON | `notice` | 系统提示文字 |

关闭码：4001 被踢出（10 秒后可重连），4003 被封禁（不要重连），4004 同一账号在别的页面打开。

### 调用（rpc）方法

全部列表在 `src/meta/methods.js`（`CLIENT_METHODS`，`true` = 需要登录），名字之外的方法一律被网关拒绝。

| 类别 | 方法 |
|---|---|
| 账号 | `auth.register {name,password,hue}` → `{account,token,recoveryCodes}`；`auth.login {name,password,totp?}` → `{account,token}`；`auth.recover {name,code,newPassword}`；`auth.logout`；`auth.logoutAll`；`auth.sessions`；`auth.password {old,new}`；`auth.totpSetup` → `{secret,uri}`；`auth.totpEnable {code}`；`auth.totpDisable {code}`；`auth.privacy {dm:"everyone"/"friends"/"nobody"}`；`auth.me` |
| 背包 | `wallet.get` → `{balance,items}`；`item.capture {entityId,x,y}`（只能收集自己谱系、视野内的生物）；`item.release {item,x,y}` |
| 市场 | `market.browse {maxPrice?,page?}`；`market.list {item,price}`；`market.cancel {listing}`；`market.buy {listing}`；`market.mine` |
| 交易 | `trade.open {with 或 name}`；`trade.get {id}`；`trade.mine`；`trade.offer {id,items,coins}`；`trade.confirm {id,version}`；`trade.cancel {id}` |
| 好友 | `friends.list`；`friends.request {to 或 name}`；`friends.respond {from,accept}`；`friends.remove {id}`；`block.add {id}`；`block.remove {id}`；`block.list`；`player.find {name}` |
| 私信 | `dm.send {to,text}`；`dm.history {with,before?}`；`dm.unread`；`dm.read {with}`；`report.create {target,reason}` |

登录 / 注册成功后，客户端把 token 存起来，重新连接并在 hello 里带上 `session`（身份变了，世界里的 pid 也要换）。

### S_CHUNK

```
u8 1, varint chunkId, varint frameNo, u8 flags(bit0=关键帧, bit1=低频档), u32 分片时钟(ms mod 2^32)
关键帧:  varint n, n × 完整记录
增量帧:  varint 删除数, 删除 id（升序，逐个差分）
         varint 新增数, 完整记录…
         varint 移动数, 移动记录…（按 id 升序）
完整记录: varint id, u8 kind, u16 qx, u16 qy, u8 r×4, u24 rgb, varint owner, u8 level
移动记录: varint (id差 << 2 | 标志), svarint dqx, svarint dqy,
          [u8 r×4 若 标志&1], [u8 level 若 标志&2]
```

`qx, qy` 为区块内坐标 × posQuant。高低两档是各自独立的流（各自的 frameNo 和基线）；客户端对一个区块只会收到一个档位。增量帧只能应用在 `frameNo = 上一帧 + 1` 之上；否则等待下一个关键帧（网关在订阅、积压恢复时会自动补发“关键帧 + 之后的增量”）。

**多区块合并规则**（见 `ClientWorld`）：同一实体可能先后出现在不同区块的流里。以分片时钟较新的信息为准；某区块说“删除”时，只有当它是该实体当前归属时才删除，并记录墓碑时间，比墓碑更旧的信息不再复活该实体。

### S_EVENTS

```
u8 5, varint chunkId,
varint 光标数, 每个: varint pid, u16 qx, u16 qy, u24 rgb, str 名字
varint 事件数, 每个: u8 种类, varint pid, u16 qx, u16 qy,
    种类 1 聊天: str 名字, str 文本
    种类 2 工具: u8 工具编号, u24 rgb
```

光标列表是该区块的**当前全集**（空列表 = 清空）。

## 内部协议（网关 ↔ 分片，分片 ↔ 分片）

同样是 WebSocket。连接后第一条是 `{"t":"hello","role":"gateway|shard","id":…,"secret":CLUSTER_SECRET}`。

- 网关 → 分片 JSON：`sub`/`unsub`（区块列表 + `tier`）、`player`（pid/名字/颜色注册）、`chat`、`online`（该网关在线数，发给 0 号分片汇总）。
- 网关 → 分片二进制：`I_ACTIONS`(101)、`I_CURSORS`(100)，每 50ms 按分片批量。
- 分片 → 网关：`S_BATCH` 包着 `S_CHUNK`/`S_FIELD`/`S_EVENTS`/`I_SUMMARY`(102)；JSON `lb`（排行榜/人口/tidi/在线）。
- 分片 → 分片：`I_GHOST`(111) 每 tick；`I_MIGRATE`(110) 按需，对方回 JSON `mack`；`I_XFER`(112) 整块交接，对方回 `xack`。迁移和交接都带（发送方纪元 u32, 序号 varint）用于确认和去重。
- 分片 ↔ 协调者（0 号分片）JSON：`claim`（启动/重连时：是否在运行、当前地图、快照里有哪些区块和快照 tick）、`load`（每秒：tick 耗时、实体数、持有的区块及实体数）、`moved`（交接完成/拒绝）；协调者发 `move`（把某区块交给谁）和 `map`（`{version, owner:[每个区块的分片号]}`，也发给所有网关）。

**内部端口不要暴露到公网**（共享密钥只防误连，不是安全边界）。
