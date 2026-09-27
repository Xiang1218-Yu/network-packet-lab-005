# Network Packet Lab · 网络协议数据包可视化实验室

项目 10：一个用于学习和演示网络协议解析过程的可视化实验室。当前版本聚焦模拟 HTTP / TCP 数据包，提供输入、场景选择、协议层级字段树、十六进制数据、解析时间线，以及可供 React 管理界面调用的 Node.js API。

## 技术栈

- **前端**：React 18、Vite、TypeScript
- **后端**：Node.js、Express、TypeScript
- **工程**：前后端共享 `shared/types.ts` 类型，根目录统一管理脚本

## 目录结构

```text
network-packet-lab/
├── client/
│   ├── index.html
│   └── src/
│       ├── App.tsx
│       ├── main.tsx
│       └── styles.css
├── server/
│   └── index.ts
├── shared/
│   └── types.ts
├── package.json
├── tsconfig.json
├── tsconfig.server.json
├── vite.config.ts
└── .gitignore
```

## 功能

1. **模拟数据选择**：在 HTTP / TCP 协议之间切换，并选择请求、响应或 TCP 握手场景。
2. **数据包输入**：编辑原始 HTTP 文本或 TCP 模拟摘要，点击“解析数据包”重新生成可视化结果。
3. **协议字段树**：HTTP 展示起始行、Header、Payload；TCP 展示 Ethernet、IPv4、TCP 和 Payload 层级，并支持折叠。
4. **十六进制视图**：以 offset、hex bytes、ASCII 三列展示当前 payload 的 UTF-8 字节。
5. **传输时间线**：展示抓包、解析、传输层解码和结构化输出等阶段。
6. **字段注释与书签**：在字段树的任意字段（起始行、单个 Header、TCP 层字段、Payload）或十六进制行上点击 ✎，创建带颜色和文字的标记。字段标记锚定真实字段路径并记录 key/value 指纹，字节标记锚定字节范围并记录内容样本；重新解析内容变化时，无法对应的标记会显示为“已失效”，而不会被错误套用到新字段上。切换字段树 / 十六进制视图时标记关联保持不变。
7. **捕获帧保存与导出**：`保存捕获帧` 将当前数据包连同全部标记持久化到服务端（`server/data/captures.json`），可随时重新载入、继续编辑或导出 JSON。标记编辑先落到本地状态再同步；接口失败时未提交的编辑保留在前端，可一键重试。
8. **解析 API / 模拟数据 API**：Express 服务提供 `/api/parse`、`/api/simulate`、`/api/packets`、`/api/captures` 和 `/api/health`。

## 启动方式

当前只完整落盘项目文件，**没有安装依赖**。准备运行时，在本目录执行：

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

浏览器访问 `http://localhost:5173`。如需更换 API 地址，可设置 `VITE_API_BASE`，例如：

```bash
VITE_API_BASE=http://localhost:3001 npm run dev:client
```

生产构建：

```bash
npm run build
npm start
```

> `npm start` 会启动编译后的 API 服务；前端静态产物位于 `dist/client`，可交给任意静态服务器托管。

## API 示例

### 获取模拟数据

```bash
curl 'http://localhost:3001/api/simulate?protocol=HTTP&scenario=request'
curl 'http://localhost:3001/api/simulate?protocol=TCP&scenario=handshake'
```

### 解析输入数据包

```bash
curl -X POST 'http://localhost:3001/api/parse' \
  -H 'Content-Type: application/json' \
  -d '{"protocol":"HTTP","scenario":"request","raw":"GET /health HTTP/1.1\\r\\nHost: lab.local\\r\\n\\r\\n"}'
```

### 获取某协议的全部示例

```bash
curl 'http://localhost:3001/api/packets?protocol=TCP'
```

### 保存带标记的捕获帧

```bash
curl -X POST 'http://localhost:3001/api/captures' \
  -H 'Content-Type: application/json' \
  -d '{"packet":{...},"markers":[{"id":"mk-1","anchor":{"kind":"field","path":["http-headers","header-0"],"fieldKey":"Host","fieldValue":"lab.local"},"color":"amber","note":"虚拟主机入口","createdAt":"...","updatedAt":"..."}]}'
```

### 捕获帧管理

```bash
curl 'http://localhost:3001/api/captures'                      # 列表（含标记数量）
curl 'http://localhost:3001/api/captures/<id>'                 # 载入完整帧与标记
curl -X PUT 'http://localhost:3001/api/captures/<id>/markers' \
  -H 'Content-Type: application/json' -d '{"markers":[...]}'   # 同步标记
curl -X DELETE 'http://localhost:3001/api/captures/<id>'       # 删除
curl -OJ 'http://localhost:3001/api/captures/<id>/export'      # 导出 JSON 文件
```

## 说明

本项目是教学用模拟器，不执行真实网卡抓包，也不声称校验真实 TCP 校验和。十六进制内容由当前输入字符串的 UTF-8 字节生成，字段解析为面向演示的轻量级解析结果。
