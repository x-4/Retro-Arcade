# NEON PIXEL // Retro Arcade

零外部 NPM 依赖的复古像素街机四合一 Web 游戏与实时竞技状态同步服务（**贪吃蛇 Neon Snake** + **打砖块 Cyber Breakout** + **星际战机 Galaxy Invaders** + **赛博疾行 Cyber Runner**）。

基于原生 HTML5 Canvas、WebAudio 8-Bit 芯片音乐合成器、实时在线电台流、Gamepad 物理手柄震动反馈、PWA 离线缓存与 Node.js（推荐 `>= 20.0.0` LTS，向下兼容 `>= 18.0.0`）构建，单端口原生支持 `HTTP/1.1 + h2c`、IPv4/IPv6 双栈监听与容器 cgroup 内存自适应调优，无缝兼容本地裸机、VPS 容器及各类云原生 PaaS 平台部署。

---

## 目录

- [游戏列表与核心玩法](#游戏列表与核心玩法)
- [快捷键与操控指南](#快捷键与操控指南)
- [街机视听与系统特性](#街机视听与系统特性)
- [详细部署指南](#详细部署指南)
  - [1. 本地或 VPS 裸机运行](#1-本地或-vps-裸机运行)
  - [2. Docker Compose 部署（推荐生产环境）](#2-docker-compose-部署推荐生产环境)
  - [3. Docker 单命令运行](#3-docker-单命令运行)
  - [4. 云原生 PaaS 平台部署](#4-云原生-paas-平台部署)
  - [5. 前置 TLS Web 网关配置示例（可选）](#5-前置-tls-web-网关配置示例可选)
- [配置参数与 CLI 命令手册](#配置参数与-cli-命令手册)
- [运维控制台与接口说明](#运维控制台与接口说明)
- [数据持久化与常见排障](#数据持久化与常见排障)

---

## 游戏列表与核心玩法

### 1. 🐍 贪吃蛇 (`NEON SNAKE`)
- **黄金能量果与穿墙护盾**：随全服实时能量场倍率（`1.0x ~ 3.0x`）动态刷出限时黄金果与蓝青色护盾果。
- **Combo 连击系统**：6 秒内连续进食触发连击倍率加成与浮动飘字反馈。
- **动态网格呼吸与蛇眼朝向**：随等级提升平滑加速，支持穿墙护盾自动消耗抵消碰撞。

### 2. 🧱 打砖块 (`CYBER BREAKOUT`)
- **四种特殊道具砖块**：
  - `GOLD`：双倍高分金砖
  - `MULTI`：分裂多球（同屏最多 4 球并发）
  - `WIDE`：12 秒宽拍扩充加成
  - `HARD`：双层装甲砖块，需击打两次
- **激光尾迹与微震屏反馈**：球体高速运动附带霓虹渐变残影，击碎砖块触发粒子爆裂与屏幕微震。

### 3. 🚀 星际战机 (`GALAXY INVADERS`)
- **五类像素外星编队与 Boss 旗舰波次**：每 3 波降临巨型 Boss 旗舰并释放扇形弹幕。
- **三类随机掉落强化胶囊**：
  - `[W]`：双发/三发散射激光升级
  - `[S]`：战机能量护盾（抵消一次敌弹或碰撞）
  - `[R]`：极速射速超频（持续 10 秒）

### 4. ⚡ 赛博疾行 (`CYBER RUNNER`)
- **透视霓虹地平线与实时关卡种子**：服务端帧序列引擎实时生成动态关卡地形种子（`stageSeed`）与多车道障碍排列。
- **二段跳与量子相位冲刺（Phase Dash）**：支持空中二段跳、急速下潜以及无敌相位冲刺直接撞碎红色激光障壁赢取额外加分。
- **全服幽灵残影同屏竞速**：实时录制并回放全服玩家近期关键操作轨迹，在赛道上呈现半透明幽灵残影。

---

## 快捷键与操控指南

支持 **键盘**、**触屏虚拟按键**（移动设备自动适配方向盘/左右滑板）及 **USB/蓝牙游戏手柄** 三种操控方式：

| 按键 / 输入 | 功能说明 |
| :--- | :--- |
| `1` / `2` / `3` / `4` | 快速切换四款街机游戏（贪吃蛇 / 打砖块 / 星际战机 / 赛博疾行） |
| `W A S D` 或 `方向键` | 控制移动方向；赛博疾行中 `↑/W` 跳跃、`↓/S` 俯冲滑铲、`→/D` 或 `Shift` 量子冲刺 |
| `Space`（空格键） | 开始游戏 / 打砖块发球 / 星际战机开火 / 赛博疾行跳跃 / 暂停恢复 |
| `G` | 播放当前游戏的冠军幽灵高分操作回放（回放中按 `Esc` 或 `Space` 退出） |
| `O` | 开启 / 关闭 **8-Bit 街机在线电台广播流**（实时流式合成音频） |
| `B` | 开启 / 关闭本地 WebAudio 芯片合成器背景音乐（BGM） |
| `M` | 全局音效静音 / 恢复 |
| `L` | 展开全服风云榜榜单视图 |
| `P` / `R` / `F` | `P` 暂停或继续 · `R` 立即重开当前局 · `F` 切换沉浸式全屏街机框体 |

---

## 街机视听与系统特性

- **双音源系统（本地 WebAudio 合成器 + 服务端实时电台流）**：内置四首程序化芯片乐曲与动作音效，同时提供 `8000Hz` 单声道 WAV 实时字节流电台广播（`O(1)` 全局按需广播池驱动，零听众时零 CPU 损耗）。
- **物理手柄即插即用（Gamepad API）**：连接 Xbox / PlayStation / Switch Pro 手柄自动激活摇杆、十字键与得分/碰撞双马达触觉震动。
- **街机成就墙与幽灵录像馆**：内置 6 枚跨游戏成就徽章与全服 Top 排行榜，自动录制高分操作序列供全服玩家回放观摩。
- **工业级自治守护架构**：
  - **cgroup 真实内存感知**：自动识别 `256MB / 512MB` 小内存容器与大内存主机，动态调整缓冲区上限与高水位主动回收阈值。
  - **自愈看门狗**：内置本地回环存活自检、跨区同步工作进程健康探针（数据报受阻时 `1.5s` 自动切换 `http2` 稳定通道）与优雅停机排空机制。

---

## 详细部署指南

### 1. 本地或 VPS 裸机运行

无需执行 `npm install`（项目零第三方依赖，开箱即用）：

```bash
# 1. 克隆仓库并进入目录
git clone https://github.com/x-4/Retro-Arcade.git
cd Retro-Arcade

# 2. （可选）创建并编辑环境变量配置
cp .env.example .env

# 3. 预检运行环境与配置合法性
npm run check

# 4. 启动服务（默认双栈监听 [::]:8080，浏览器访问 http://localhost:8080）
npm start
```

如需在 Linux VPS 上以 `systemd` 后台常驻运行，可创建 `/etc/systemd/system/neon-arcade.service`：

```ini
[Unit]
Description=NEON PIXEL Retro Arcade Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/Retro-Arcade
EnvironmentFile=-/opt/Retro-Arcade/.env
ExecStart=/usr/bin/node /opt/Retro-Arcade/index.js
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

启用并查看运行状态：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now neon-arcade
sudo systemctl status neon-arcade
```

---

### 2. Docker Compose 部署（推荐生产环境）

镜像内置 `tini` 进程守护与 `amd64` / `arm64` 双架构运行库支持，并通过命名卷 `arcade-cache` 自动持久化凭证、排行榜与组件缓存：

```bash
# 1. 复制环境变量模板并按需修改
cp .env.example .env

# 2. 构建并后台启动容器
docker compose up -d --build

# 3. 查看实时启动日志与健康检查状态
docker compose logs -f
docker compose ps
```

**常用运维命令：**

```bash
# 查看首次启动自动生成并持久化的 UUID 凭证（未手动指定 UUID 时）
docker exec neon-arcade cat /app/.cache-sync/uuid

# 单独执行容器内健康探针自检
docker exec neon-arcade node /app/index.js --healthcheck

# 拉取最新代码后无缝滚动升级（.cache-sync 卷中的 UUID 与排行榜数据完好保留）
git pull
docker compose up -d --build

# 停止服务（保留持久化数据卷）
docker compose down
```

> **最小端口暴露提示**：若已配置 `TOKEN` 启用跨区状态同步、无需直接通过宿主机公网 IP 访问端口，可在 `.env` 中设置 `LISTEN_IP=127.0.0.1`，实现宿主机公网网卡零端口暴露。

---

### 3. Docker 单命令运行

```bash
# 构建镜像
docker build -t neon-pixel-arcade:latest .

# 启动容器（挂载持久化卷，支持通过 -e 传入配置）
docker run -d \
  --name neon-arcade \
  --restart unless-stopped \
  -p 8080:8080 \
  -e PORT=8080 \
  -e UUID="" \
  -e TOKEN="" \
  -v arcade-cache:/app/.cache-sync \
  neon-pixel-arcade:latest
```

---

### 4. 云原生 PaaS 平台部署

本项目原生适配基于 Dockerfile 或 Node.js Buildpack 的各类云原生容器平台：

1. **构建与启动命令**：
   - Dockerfile 模式：直接识别仓库根目录 `Dockerfile`，无需额外参数。
   - Node Buildpack 模式：构建命令留空（零依赖），启动命令填写 `npm start`（即 `node index.js`）。
2. **环境变量建议**：
   - `PORT`：平台通常自动注入，服务会自动读取并绑定（无需手动干预）。
   - `UUID`：**强烈建议在平台环境变量面板中显式填写一个固定标准 UUID**（可通过 `uuidgen` 或 `node -e "console.log(crypto.randomUUID())"` 生成），确保无状态实例重建或扩缩容后管理凭证恒定不变。
   - `TOKEN`：按需选填跨区同步扩展令牌；留空则直接通过平台自带的 HTTPS 域名对外提供完整服务。
3. **探针与资源适配**：
   - 存活探针路径填 `/healthz`，就绪探针路径填 `/readyz`。
   - 程序会自动检测容器 `256MB / 512MB` cgroup 内存上限切换紧凑缓冲档位，并在只读根文件系统下自动回退至 `/tmp/neon-arcade` 运行。

---

### 5. 前置 TLS Web 网关配置示例（可选）

在独立域名 VPS 部署且未启用 `TOKEN` 时，建议在 `.env` 中设 `LISTEN_IP=127.0.0.1`，并前置 **Caddy 2** 或 **Nginx** 提供 HTTPS（TLS 1.3 + HTTP/2）：

**Caddyfile 示例（推荐，默认支持无缓冲双向流转发）：**

```caddyfile
arcade.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

**Nginx 站点配置要点（需关闭请求与响应缓冲以保障实时流低延迟）：**

```nginx
server {
    listen 443 ssl http2;
    server_name arcade.example.com;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_read_timeout 360s;
        proxy_send_timeout 360s;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## 配置参数与 CLI 命令手册

### 环境变量

支持通过系统环境变量、根目录 `.env` 文件或 `*_FILE` 密钥文件挂载三种方式传入（优先级：`CLI 参数 > 环境变量 > *_FILE 文件 > .env 文件 > 默认值`）：

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `PORT` | `8080` | HTTP/1.1 + h2c 统一服务监听端口（同步支持 `PORT_FILE`） |
| `UUID` | *(自动生成)* | 运维控制台与联机档案授权凭证；支持英文逗号分隔配置多个有效 UUID（同步支持 `UUID_FILE`） |
| `TOKEN` | *(空)* | 跨区状态同步扩展令牌（可选，兼容完整安装命令粘贴提取；同步支持 `TOKEN_FILE`） |
| `LISTEN_IP` | `0.0.0.0` | 仅用于 `docker-compose.yml` 宿主机端口映射绑定地址（如 `127.0.0.1` 或 `0.0.0.0`） |

### CLI 命令行选项

```bash
# 查看命令行帮助说明（零模块加载极速输出）
node index.js --help

# 校验当前环境变量、.env 配置与内置字典完整性（不启动监听，用于上线前检查）
npm run check          # 等价于 node index.js --check

# 探测本地运行实例的 /healthz 存活状态（返回码 0 为正常，1 为异常，用于容器 HEALTHCHECK）
npm run healthcheck    # 等价于 node index.js --healthcheck [--port 8080]

# 临时通过命令行参数覆盖端口或凭证启动
node index.js --port 9000 --uuid "你的-UUID"
```

---

## 运维控制台与接口说明

> **获取 `<UUID>` 凭证**：若未通过环境变量显式指定，首次启动后可在宿主机执行 `cat uuid`（Docker 容器执行 `docker exec neon-arcade cat /app/.cache-sync/uuid`）查看。

### 1. 授权管理与联机档案端点（需 `<UUID>` 凭证）

| 路径 | 方法 | 说明 |
| :--- | :--- | :--- |
| `/api/v1/console/<UUID>` | `GET` | **内嵌式复古 CRT 运维控制台**：含实时流量波形示波器、自检状态、跨区连接拓扑、联机配置地址一键复制/预览及近期自愈告警表 |
| `/api/v1/profile/<UUID>` | `GET` | **联机配置档案与云存档同步入口**：普通浏览器直接访问展示玩家游戏云存档与成就校验快照；专用客户端按 `User-Agent` 自动分发适配配置（附加 `?export=1` 可显式导出原始编码配置） |
| `/api/v1/metrics/<UUID>` | `GET` | **JSON 运行状态快照**：附加 `?detail=1` 可列出当前活跃会话时长与队列详情 |
| `/api/v1/metrics/<UUID>?format=prometheus` | `GET` | **Prometheus 指标导出**：提供 `arcade_selfcheck_ok`、`arcade_active_channels`、`arcade_bytes_up_total`、`arcade_bytes_down_total`、`arcade_edge_ready` 等标准监控指标 |

### 2. 公开游戏、实时电台与探针端点

| 路径 | 方法 | 说明 |
| :--- | :--- | :--- |
| `/` | `GET` | 复古像素街机四合一主舞台 Web 界面（支持 ETag / Gzip 与 PWA 离线安装） |
| `/api/v1/state` | `GET` | 大厅能量脉冲倍率、动态关卡种子与四游戏排行榜快照 JSON |
| `/api/v1/events` | `GET` | 实时大厅能量场与榜单刷新 SSE 事件广播流 |
| `/api/v1/radio/stream` | `GET/HEAD` | 实时 8-Bit 芯片音乐在线电台 `audio/wav` 音频流 |
| `/api/v1/score` | `POST` | 玩家单局高分战绩提交（含单 IP 速率限制保护） |
| `/api/v1/replays` | `GET/POST` | 查询幽灵高分回放列表（支持 `?game=runner` 筛选）、读取单条录像 `/api/v1/replays/<id>` 或上传回放轨迹 |
| `/api/v1/telemetry` | `POST` | 街机操作遥测帧上报与实时序列通道同步接口 |
| `/healthz` | `GET` | 容器存活探针（Liveness），正常返回 `200 ok` |
| `/readyz` | `GET` | 负载均衡就绪探针（Readiness），正常返回 `200 ready`，停机排空或通道满载时返回 `503` |

---

## 数据持久化与常见排障

### 状态文件存储优先级
服务按以下顺序自动选择可写持久化目录保存 `uuid`、`arcade-scores.json`（高分榜）及跨区同步组件缓存：
1. **`.cache-sync/` 子目录**（Docker / Compose 默认持久化卷挂载点，容器重建升级不丢失数据）；
2. **项目根目录**（本地或 VPS 裸机直接运行且未创建 `.cache-sync` 时默认使用，并支持向 `.cache-sync` 自动平滑迁移旧凭证）；
3. **系统临时目录 `/tmp/neon-arcade`**（当容器开启只读根文件系统 `readOnlyRootFilesystem` 时自动回退）。

### 全链路自动化回归测试
修改配置或升级环境后，可随时运行内置全量测试套件验证 HTTP/1.1、h2c、流式与分包会话、静态缓存、电台流及安全策略：

```bash
npm test
```

### 常见问题排查（FAQ）
1. **启动报错 `EADDRINUSE: address already in use`**
   - 说明默认 `8080` 端口已被占用，修改 `.env` 中的 `PORT=9080`（Docker Compose 会自动同步映射新端口）后重启即可。
2. **启用 `TOKEN` 后控制台显示 `SYNCING` 或告警日志提示自动切换 `http2`**
   - 部分云主机或容器网络限制出站 UDP 数据报时，内置守护引擎会在 `1.5 秒` 内自动检测并无缝重拉切换至基于 TCP 的 `http2` 稳定模式，无需人工干预，看到日志输出 `✔ 跨区能量场与排行榜同步通道已就绪` 即表示已正常连通。
3. **容器更新重建后为什么客户端凭证变化了？**
   - 若使用 `docker run` 单命令启动且既未设置 `-e UUID=...` 也未挂载 `-v arcade-cache:/app/.cache-sync`，容器销毁后临时层生成的 `uuid` 会随之清空。固定设置 `UUID` 环境变量或挂载 `/app/.cache-sync` 卷即可永久保持不变。
