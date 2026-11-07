# NEON PIXEL // Retro Arcade

零外部依赖的复古像素街机四合一 Web 游戏与实时竞技状态服务（**贪吃蛇 Neon Snake** + **打砖块 Cyber Breakout** + **星际战机 Galaxy Invaders** + **赛博疾行 Cyber Runner**），基于原生 HTML5 Canvas、WebAudio 8-Bit 芯片音乐合成器、Gamepad 手柄震动反馈、PWA 离线缓存与 Node.js（`>= 18`）构建。

## 游戏列表与核心玩法

### 1. 🐍 贪吃蛇 (`NEON SNAKE`)
- **黄金能量果与穿墙护盾**：随全服实时能量场倍率（`1.0x ~ 3.0x`）动态刷出限时黄金果与蓝青色护盾果。
- **Combo 连击系统**：6 秒内连续进食触发连击倍率加成与浮动飘字反馈。
- **动态网格呼吸与蛇眼朝向**：随等级提升平滑加速，支持穿墙护盾自动消耗抵消碰撞。

### 2. 🧱 打砖块 (`CYBER BREAKOUT`)
- **四种特殊道具砖块**：
  - `GOLD`（双倍高分金砖）
  - `MULTI`（分裂多球，同屏最多 4 球并发）
  - `WIDE`（12 秒宽拍扩充加成）
  - `HARD`（双层装甲砖块，需击打两次）
- **激光尾迹与微震屏反馈**：球体高速运动附带霓虹渐变残影，击碎砖块触发粒子爆裂与屏幕微震。

### 3. 🚀 星际战机 (`GALAXY INVADERS`)
- **五类像素外星编队与 Boss 旗舰波次**：每 3 波降临巨型 Boss 旗舰并释放扇形弹幕。
- **三类随机掉落强化胶囊**：
  - `[W]` 双发/三发散射激光升级
  - `[S]` 战机能量护盾（抵消一次敌弹或碰撞）
  - `[R]` 极速射速超频（持续 10 秒）

### 4. ⚡ 赛博疾行 (`CYBER RUNNER`)
- **透视霓虹地平线与实时关卡种子**：服务端帧序列引擎实时生成动态关卡地形种子（`stageSeed`）与多车道障碍排列。
- **二段跳与量子相位冲刺（Phase Dash）**：支持空中二段跳、急速下潜以及无敌相位冲刺直接撞碎红色激光障壁赢取额外加分。
- **全服幽灵残影同屏竞速**：实时录制并回放全服玩家近期关键操作轨迹，在赛道上呈现半透明幽灵残影。

## 街机视听与交互特性

- **纯 WebAudio 8-Bit 合成音效与程序化芯片音乐（BGM）**：内置四首风格各异的合成器背景乐曲与多声部动作音效，支持音效/BGM 独立开关（自动持久化至 `localStorage`）。
- **物理游戏手柄（Gamepad API）与触觉震动支持**：即插即用支持 Xbox / PlayStation / Switch Pro 等标准手柄摇杆、十字键与双马达震动回馈。
- **街机成就徽章墙与沉浸式全屏模式**：内置 6 枚跨游戏街机成就徽章（解锁时触发顶部霓虹横幅），支持一键切换全屏街机框体视图與 PWA 桌面安装。
- **全服四榜独立排行 (`arcade-scores.json`)**：四款游戏独立保存 Top 排行榜，支持玩家输入昵称提交高分并通过 SSE 事件流实时广播刷新。

## 快速开始

### 1. 本地运行

```bash
# 检查运行环境与配置有效性
npm run check

# 启动街机服务（默认监听 http://localhost:8080）
npm start

# 运行全链路自动化回归测试
npm test
```

### 2. Docker / Docker Compose 运行

```bash
cp .env.example .env
docker compose up -d --build
```

## 环境变量说明

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `PORT` | `8080` | 服务监听端口（HTTP 服务与容器健康检查探针均使用此端口） |
| `UUID` | *(自动生成)* | 街机管理控制台与联机档案接口授权凭证（留空时首次启动自动生成并持久化至 `uuid` 文件） |
| `TOKEN` | *(空)* | 跨区状态同步扩展令牌（可选，留空时仅以单机模式运行） |

## 街机接口与运维监控端点

### 1. 公开游戏与实时状态接口
- **街机主舞台页面**：`GET /`
- **全服能量脉冲与排行榜快照**：`GET /api/v1/state`
- **实时能量场 SSE 广播流**：`GET /api/v1/events`
- **操作遥测帧上报**：`POST /api/v1/telemetry`
- **高分战绩提交**：`POST /api/v1/score`

### 2. 联机档案与可视化运维控制台（需 `<UUID>` 凭证）
首次启动后可通过 `cat uuid`（或容器内 `docker exec neon-arcade cat /app/uuid`）查看自动生成的 `<UUID>` 凭证：

- **联机配置档案导出**：`GET /api/v1/profile/<UUID>`（依据请求端 `User-Agent` 自动返回适配的联机配置档案）
- **内嵌式复古 CRT 运维控制台**：`GET /api/v1/console/<UUID>`
- **运行状态与告警快照（JSON）**：`GET /api/v1/metrics/<UUID>[?detail=1]`
- **Prometheus 监控指标**：`GET /api/v1/metrics/<UUID>?format=prometheus`

### 3. 容器与负载均衡探针
- **存活探针（Liveness）**：`GET /healthz`（返回 `200 ok`）
- **就绪探针（Readiness）**：`GET /readyz`（正常返回 `200 ready`，停机排空或过载时返回 `503`）
