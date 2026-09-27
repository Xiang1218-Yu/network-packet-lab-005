# Network Packet Lab · 网络协议数据包可视化实验室

项目 10：一个用于学习和演示网络协议解析过程的可视化实验室。当前版本聚焦模拟 HTTP / TCP 数据包，提供输入、场景选择、协议层级字段树、十六进制数据、解析时间线，**字段注释与书签**，以及可供 React 管理界面调用的 Node.js API。

## 技术栈

- **前端**：React 18、Vite、TypeScript
- **后端**：Node.js、Express、TypeScript
- **工程**：前后端共享 `shared/types.ts` 类型与 `shared/markers.ts` 锚定/迁移逻辑，根目录统一管理脚本

## 目录结构

```text
network-packet-lab/
├── client/src/
│   ├── App.tsx                 # 工作台、同步状态、迁移提示
│   ├── api.ts / storage.ts     # API 客户端 / localStorage
│   └── annotations/            # 注释与书签功能
│       ├── useAnnotations.ts   # local-first 编辑、同步、迁移、捕获帧
│       ├── FieldTree.tsx       # 字段树（字段书签）
│       ├── HexView.tsx         # 十六进制（拖拽选区、整行书签）
│       ├── MarkersPanel.tsx    # 当前帧的标记列表
│       ├── MarkerDialog.tsx    # 颜色 + 文字编辑
│       └── CapturesPanel.tsx   # 捕获帧保存 / 导入 / 导出
├── server/
│   ├── index.ts                # HTTP 与标记 API
│   ├── frame.ts                # 帧解析（稳定字段路径 + 真实字节范围）
│   └── markerStore.ts          # 标记持久化（data/markers.json）
├── shared/
│   ├── types.ts                # 前后端共享类型
│   └── markers.ts              # 帧身份、锚点解析、迁移、校验
└── test/integration.tsx        # jsdom 端到端行为测试
```

## 功能

1. **模拟数据选择**：在 HTTP / TCP 协议之间切换，并选择请求、响应或 TCP 握手场景。
2. **数据包输入**：编辑原始 HTTP 文本或 TCP 模拟摘要，点击“解析数据包”重新生成可视化结果。
3. **协议字段树**：HTTP 展示起始行、Header、Payload；TCP 展示 Ethernet、IPv4、TCP 和 Payload 层级，并支持折叠。
4. **十六进制视图**：以 offset、hex bytes、ASCII 三列逐字节展示，支持拖拽选择字节范围。
5. **传输时间线**：展示抓包、解析、传输层解码和结构化输出等阶段。
6. **注释与书签**：
   - 可在**起始行、单个 header、TCP 层字段、payload、单个字节、字节范围、十六进制整行**上创建带 5 种颜色和文字的标记；
   - 标记锚定**语义字段路径**（如 `http.headers["Content-Type"]`、`tcp.flags`）或**真实 UTF-8 字节范围**（带内容快照）；
   - 切换“字段树 / 十六进制”视图时标记保持关联并互相联动高亮；
   - 重新解析时严格迁移：路径仍存在 / 字节仍一致才跟随，否则标记脱落并随旧帧自动归档，**绝不会错误套用到新内容**；
   - 捕获帧（包 + 标记）可保存、重新载入、导入、导出为 JSON。
7. **离线优先同步**：所有编辑先写入 localStorage，再异步提交服务端；接口失败时未提交编辑完整保留，恢复后（含刷新页面后）自动重试。可勾选“模拟标记接口故障”验证。
8. **解析 API / 模拟数据 API**：Express 服务提供 `/api/parse`、`/api/simulate`、`/api/packets`、`/api/markers`、`/api/markers-export` 和 `/api/health`。

## 锚点模型（为什么不会张冠李戴）

- **帧身份**：`frameId = 协议-场景-内容哈希`，同内容重载自动归位，不同内容天然隔离。
- **字段锚点**：存语义路径而非数组下标。删除 header、重排顺序后，路径解析不到即脱落；TCP flags 在不同场景间路径相同则跟随并指向新值。
- **字节锚点**：存 `[start, end)` + 创建时的字节 hex 快照。范围越界或快照不一致都不自动重挂。
- 服务端 `PUT /api/markers/:frameId` 会强制把标记归入 URL 指定帧并做字段消毒，双重保险。

## 启动方式

```bash
npm install
```

然后打开两个终端：

```bash
# 终端 1：启动 API 服务（默认 3001）
npm run dev:server

# 终端 2：启动 Vite 管理界面（默认 5173）
npm run dev:client
```

浏览器访问 `http://localhost:5173`。如需更换 API 地址，可设置 `VITE_API_BASE`。

生产构建与测试：

```bash
npm run build   # 编译 API 与前端静态产物
npm start       # 启动编译后的 API 服务（dist/client 为前端产物）
npm test        # 启动临时 API 端口并运行端到端行为测试
```

## API 示例

### 获取模拟数据

```bash
curl 'http://localhost:3001/api/simulate?protocol=HTTP&scenario=request'
```

### 读取 / 保存某帧的标记

```bash
curl 'http://localhost:3001/api/markers?frameId=http-response-6b237d5b'

curl -X PUT 'http://localhost:3001/api/markers/http-response-6b237d5b' \
  -H 'Content-Type: application/json' \
  -d '{"markers":[{"id":"m1","frameId":"http-response-6b237d5b","color":"amber",
       "note":"Content-Type 决定 body 解析方式",
       "anchor":{"kind":"field","path":"http.headers[\"Content-Type\"]","label":"Content-Type"},
       "createdAt":"2026-09-27T10:00:00Z","updatedAt":"2026-09-27T10:00:00Z"}]}'
```

> 添加请求头 `X-Fail-Markers: 1` 可让标记接口返回 503，用于演练“接口失败时前端保留未提交编辑”。

## 说明

本项目是教学用模拟器，不执行真实网卡抓包，也不声称校验真实 TCP 校验和。十六进制内容由当前输入字符串的 UTF-8 字节生成，字段的字节范围基于同一字节序列精确计算；字段解析为面向演示的轻量级解析结果。
