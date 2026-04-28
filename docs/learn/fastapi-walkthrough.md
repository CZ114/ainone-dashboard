---
type: learn
status: active
last_updated: 2026-04-21
tags: [fastapi, learning, backend-architecture]
---

# ESP32 Sensor Dashboard - 从零理解后端架构

> 目标：理解 Python 后端如何把传感器数据送到网页上

---

## 第一部分：什么是 FastAPI？

### 1.1 最简单的理解

**FastAPI 就是一个 Python 网站框架。**

就像 Flask、Django，但它更适合做"数据 API"。

**对比理解：**

| 框架 | 类比 | 适合场景 |
|------|------|---------|
| Django | 全能型超市 | 大型网站，需要 ORM、Admin |
| Flask | 便利店 | 简单网站、微服务 |
| **FastAPI** | **快餐店柜台** | **API 接口、数据服务** |

### 1.2 FastAPI 的核心概念

```
请求 (浏览器/前端)
      ↓
┌─────────────────────┐
│   FastAPI 应用       │
│   路由: /api/xxx    │  ← URL 路径
│   方法: GET/POST    │  ← 操作类型
└────────┬────────────┘
         ↓
┌─────────────────────┐
│   处理函数           │
│   读数据、做处理      │
└────────┬────────────┘
         ↓
响应 (JSON 数据)
```

**一个最简单的 FastAPI 示例：**

```python
from fastapi import FastAPI

app = FastAPI()

# 定义一个 GET 接口
@app.get("/hello")
def say_hello():
    return {"message": "你好！"}
```

访问 `http://localhost:8080/hello` 会返回 JSON。

### 1.3 本项目 FastAPI 做了什么？

```
┌─────────────────────────────────────────────────────────┐
│                    FastAPI 后端 (Python)                 │
│                       :8080                             │
├─────────────────────────────────────────────────────────┤
│                                                         │
│   接收前端请求：                                         │
│   POST /api/serial/connect  → 连接串口                   │
│   POST /api/ble/scan        → 扫描蓝牙设备               │
│   POST /api/audio/start     → 开始接收音频               │
│   GET  /api/serial/status   → 获取连接状态               │
│                                                         │
├─────────────────────────────────────────────────────────┤
│                                                         │
│   推送数据给前端：                                       │
│   WebSocket /ws → 实时推送传感器数据                     │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## 第二部分：数据是怎么从传感器跑到网页的？

### 2.1 整体数据流

```
传感器设备 (ESP32)
      │
      │  (USB 串口 或 蓝牙)
      ▼
┌─────────────────────────────────────────────────────────┐
│  Python 后端 (8080)                                      │
│                                                         │
│   线程 1: serial_bridge.py  ← 持续读取串口数据          │
│   线程 2: ble_bridge.py     ← 持续读取蓝牙数据          │
│   线程 3: audio_bridge.py   ← 持续读取音频数据          │
│           ↓                                             │
│   线程 4: connection_manager.py  ← 50Hz 统一处理数据     │
│           ↓                                             │
│   线程 5: websocket_manager.py ← 推送给浏览器            │
│                                                         │
└─────────────────────────────────────────────────────────┘
                    │
                    │ WebSocket (ws://...)
                    ▼
┌─────────────────────────────────────────────────────────┐
│  浏览器 (前端 :5173)                                     │
│                                                         │
│   websocket.ts ← 接收数据                               │
│       ↓                                                  │
│   App.tsx      ← 更新 Zustand 状态                      │
│       ↓                                                  │
│   ChannelCard.tsx ← React 自动重渲染，显示数据          │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 2.2 逐行代码解析：数据怎么从 Python 到网页

#### 步骤 1: Python 后端接收传感器数据

文件：`backend/app/core/serial_bridge.py`

```python
# 这是个独立线程，持续运行
def read_from_serial():
    while self.running:
        # 从串口读取一行数据
        line = self.serial_port.readline()  # 例如: "PPG:72,IMU:1.2,3.4,5.6\n"
        if line:
            # 把原始数据放到队列里
            self.data_queue.put(line.decode())
```

**关键点：**
- `serial_port.readline()` 是阻塞的，一直等待数据
- `data_queue.put()` 把数据放到队列，交给其他线程处理
- 这是**生产者模式**：这个线程负责生产数据

#### 步骤 2: 统一处理数据

文件：`backend/app/core/connection_manager.py`

```python
# 这是 _data_loop 线程，每秒运行 50 次
def _data_loop(self):
    while self.running:
        # 从队列取出数据（不阻塞）
        while not self._data_queue.empty():
            raw_data = self._data_queue.get()

            # 解析数据
            parsed = DataProcessor.parse_csv_line(raw_data)
            # parsed = {"channels": ["PPG", "IMU"], "values": [72, 1.2, 3.4, 5.6]}

            # 计算统计数据
            stats = DataProcessor.calculate_stats(parsed)
            # stats = {"min": [70, 1.0], "max": [74, 3.5], "avg": [72, 2.3]}

            # 打包成 WebSocket 消息
            ws_message = {
                "type": "sensor_data",
                "timestamp": time.time(),
                "channels": parsed["channels"],
                "values": parsed["values"],
                "waveforms": self._ring_buffers,  # 波形数据
                "stats": stats
            }

            # 放入广播队列
            self._broadcast_queue.put_nowait(ws_message)
```

**关键点：**
- `_data_loop` 每秒运行 50 次（50Hz），定期检查新数据
- `DataProcessor.parse_csv_line()` 解析 CSV 格式数据
- 消息格式是字典，最后会转成 JSON 发送给前端

#### 步骤 3: WebSocket 推送

文件：`backend/app/core/websocket_manager.py`

```python
# 这是异步任务，定期检查广播队列
async def _broadcast_loop(self):
    while True:
        # 非阻塞取出广播消息
        if not self._broadcast_queue.empty():
            message = self._broadcast_queue.get_nowait()

            # 发送给所有连接的浏览器
            for client in self.clients:
                await client.send_json(message)  # 发送 JSON 数据
```

**关键点：**
- `send_json()` 自动把 Python 字典转成 JSON 字符串
- `self.clients` 是所有连接的浏览器 WebSocket

#### 步骤 4: 前端接收 WebSocket

文件：`frontend/src/api/websocket.ts`

```typescript
// 创建 WebSocket 连接
const ws = new WebSocket('ws://localhost:8080/ws');

ws.onmessage = (event) => {
  // event.data 是 JSON 字符串
  const data = JSON.parse(event.data);

  // 根据 type 处理不同消息
  switch (data.type) {
    case 'sensor_data':
      // data = {channels, values, waveforms, stats}
      updateSensorData(data);  // 更新状态
      break;
    case 'audio_level':
      setAudioLevel(data);
      break;
  }
};
```

**关键点：**
- `JSON.parse()` 把 JSON 字符串转回 JavaScript 对象
- 前端收到的是和 Python 发送时结构完全一样的字典

#### 步骤 5: 前端更新界面

文件：`frontend/src/App.tsx`

```typescript
function App() {
  const channels = useStore((s) => s.channels);  // 从 Zustand 读取状态

  // 这个函数会被 WebSocket 消息调用
  const updateSensorData = (data: SensorData) => {
    useStore.getState().updateSensorData(data);
    // Zustand 会自动触发 React 重新渲染
  };
}
```

**关键点：**
- `useStore.getState()` 获取当前状态
- Zustand 状态变化 → React 自动重新渲染 → 页面更新

---

## 第三部分：哪些是"服务包装"（与前端互动的部分）

### 3.1 快速识别

```
与前端互动 = REST API 或 WebSocket
不与前端互动 = 内部线程、工具函数
```

### 3.2 REST API 端点（前端主动请求）

**文件位置：** `backend/app/api/` 下的各个文件

| 文件 | 端点 | 做什么 |
|------|------|-------|
| `serial.py` | GET `/api/serial/ports` | 获取可用串口列表 |
| `serial.py` | POST `/api/serial/connect` | 连接指定串口 |
| `serial.py` | GET `/api/serial/status` | 获取串口状态 |
| `ble.py` | POST `/api/ble/scan` | 开始扫描蓝牙设备 |
| `audio.py` | POST `/api/audio/start` | 开始接收音频 |
| `recording.py` | POST `/api/recording/start` | 开始录音 |

**理解方式：** 这些都是前端"请求"，后端"响应"。

#### 看一个具体例子：获取串口列表

文件：`backend/app/api/serial.py`

```python
from fastapi import APIRouter

router = APIRouter()  # 创建一个路由

@router.get("/ports")  # ← 装饰器：定义 GET /api/serial/ports
def get_serial_ports():
    """获取所有可用的串口"""
    ports = serial.tools.list_ports.comports()  # ← 调用系统 API 获取串口
    return {
        "ports": [
            {"name": p.name, "device": p.device}
            for p in ports
        ]
    }
```

前端调用：
```typescript
// frontend/src/api/client.ts
const response = await fetch('http://localhost:8080/api/serial/ports');
const data = await response.json();
// data = {ports: [{name: "COM3", device: "COM3"}, ...]}
```

### 3.3 WebSocket 端点（后端主动推送）

**文件位置：** `backend/app/api/websocket.py`

```python
from fastapi import WebSocket

@router.websocket("/ws")  # ← WebSocket 端点
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()  # ← 接受连接

    # 加入客户端列表
    websocket_manager.add_client(websocket)

    try:
        while True:
            # 保持连接，等待广播消息
            await asyncio.sleep(0.1)
    finally:
        websocket_manager.remove_client(websocket)
```

**前端代码：**
```typescript
const ws = new WebSocket('ws://localhost:8080/ws');
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  // data 是后端主动推送过来的
};
```

**理解方式：** 前端建立连接后，后端会在有新数据时**主动推送**，不用前端一直问。

### 3.4 服务包装图解

```
┌─────────────────────────────────────────────────────────────┐
│                        前端 (浏览器)                          │
│                     localhost:5173                           │
└─────────────────────────┬───────────────────────────────────┘
                          │
        ┌─────────────────┴─────────────────┐
        │                                   │
        ▼                                   ▼
┌───────────────┐                 ┌───────────────────┐
│  HTTP 请求      │                │  WebSocket 连接    │
│ (fetch/axios) │                 │  (持续连接)        │
│               │                 │                   │
│ /api/serial/* │                 │  /ws              │
│ /api/ble/*    │                 │                   │
│ /api/audio/*  │                 │                   │
└───────┬───────┘                 └─────────┬─────────┘
        │                                   │
        │         Python 后端 :8080          │
        │                                   │
┌───────┴───────┐                 ┌─────────┴─────────┐
│  REST API     │                 │  WebSocket        │
│  路由处理器    │                 │  广播服务         │
│               │                 │                   │
│ api/serial.py │                 │ websocket_manager │
│ api/ble.py    │                 │                   │
│ api/audio.py  │                 │                   │
└───────┬───────┘                 └─────────┬─────────┘
        │                                   │
        │         内部线程                   │
        ▼                                   ▼
┌───────────────┐                 ┌───────────────────┐
│  业务逻辑      │                 │  数据推送          │
│               │                 │                   │
│ serial_bridge │                 │ _broadcast_loop   │
│ ble_bridge    │                 │                   │
│ audio_bridge  │                 │                   │
└───────────────┘                 └───────────────────┘
        │                                   │
        ▼                                   ▼
   硬件设备                           广播队列
  (ESP32)                              │
   ═════                               │
  传感器数据                            ▼
                               所有连接的浏览器
```

---

## 第四部分：逐行阅读关键文件

### 4.1 FastAPI 入口

文件：`backend/app/main.py`

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()  # ← 创建 FastAPI 应用

# 配置 CORS（允许跨域访问）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],  # ← 允许这个前端访问
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 注册路由
# 这些 include_router 会把 api/ 下的所有端点注册到 /api/ 下
app.include_router(serial.router, prefix="/api/serial")
app.include_router(ble.router, prefix="/api/ble")
app.include_router(audio.router, prefix="/api/audio")
app.include_router(recording.router, prefix="/api/recording")
```

### 4.2 一个完整的 API 请求流程

**场景：前端点击"连接串口"**

**1. 前端发起请求**

```typescript
// frontend/src/components/layout/ConnectionPanel.tsx
const connectSerial = async () => {
  const response = await fetch('http://localhost:8080/api/serial/connect', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({port: 'COM3', baud_rate: 115200})
  });
};
```

**2. 后端接收请求**

```python
# backend/app/api/serial.py
@router.post("/connect")
async def connect_serial(request: SerialConnectRequest):
    # request = {port: 'COM3', baud_rate: 115200}

    # 调用连接管理器
    success = connection_manager.connect_serial(
        port=request.port,
        baud_rate=request.baud_rate
    )

    return {"connected": success, "port": request.port}
```

**3. 后端返回响应**

```python
# Python 字典自动转成 JSON
# {"connected": true, "port": "COM3"}
```

**4. 前端处理响应**

```typescript
const data = await response.json();
if (data.connected) {
  setSerialConnected(true);  // 更新 UI 状态
}
```

---

## 第五部分：关键文件清单

### 5.1 后端文件（按重要性排序）

| 优先级 | 文件 | 为什么重要 |
|--------|------|-----------|
| ⭐⭐⭐ | `backend/app/main.py` | FastAPI 入口，所有路由在这注册 |
| ⭐⭐⭐ | `backend/app/api/websocket.py` | WebSocket 端点，数据从这里推送 |
| ⭐⭐⭐ | `backend/app/services/connection_manager.py` | 数据处理中枢 |
| ⭐⭐ | `backend/app/core/serial_bridge.py` | 串口读取线程 |
| ⭐⭐ | `backend/app/core/ble_bridge.py` | 蓝牙读取线程 |
| ⭐⭐ | `backend/app/api/serial.py` | 串口 REST API |
| ⭐ | `backend/app/core/data_processor.py` | 数据解析工具 |

### 5.2 前端文件（按重要性排序）

| 优先级 | 文件 | 为什么重要 |
|--------|------|-----------|
| ⭐⭐⭐ | `frontend/src/App.tsx` | 根组件，WebSocket 连接在这 |
| ⭐⭐⭐ | `frontend/src/api/client.ts` | Python 后端 API 调用 |
| ⭐⭐⭐ | `frontend/src/api/websocket.ts` | WebSocket 客户端 |
| ⭐⭐ | `frontend/src/store/index.ts` | Zustand 状态定义 |
| ⭐⭐ | `frontend/src/components/channels/ChannelCard.tsx` | 数据展示组件 |

---

## 总结：数据流动的完整路径

```
用户点击"连接"
    ↓
前端 fetch('/api/serial/connect')
    ↓
FastAPI 接收 POST 请求
    ↓
connection_manager.connect_serial()
    ↓
serial_bridge 线程开始读取数据
    ↓
数据放入 data_queue
    ↓
_ data_loop 线程每秒 50 次取出数据
    ↓
解析、计算、放入 broadcast_queue
    ↓
broadcast_loop 推送给所有 WebSocket 客户端
    ↓
前端 ws.onmessage 收到数据
    ↓
Zustand store 更新
    ↓
React 组件自动重渲染
    ↓
页面显示新数据
```

---

## 第六部分：Debug 日志（API Key 问题）

### 问题现象

- Claude Code SDK 报错：`Invalid API key · Please run /login`
- 但用户 CLI 本身运行正常（显示 `MiniMax-M2.7 with high effort`）

### 错误尝试

**1. 以为是 MCP 配置问题**

认为 MiniMax MCP server 配置有误，但 MCP 状态显示 `connected`，问题不在这里。

**2. 尝试通过 `process.env` 传递**

修改 `chat.ts` 添加环境变量：
```typescript
env: {
  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN || "",
  ANTHROPIC_BASE_URL: "https://api.minimaxi.com/anthropic",
  ANTHROPIC_MODEL: "MiniMax-M2.7",
}
```

但 `apiKeySource: 'none'` 说明 token 仍然没传进去。

### 根本原因

- 用户的认证信息存在 `~/.claude/settings.json`，Claude CLI 会自动加载它
- 但后端 SDK spawn 的子进程 `process.env` 里没有这些值
- `apiKeySource: 'none'` 说明 CLI 根本没有拿到任何 API key

### 最终解决方案

在 `chat.ts` 里新增函数直接从 `~/.claude/settings.json` 读取用户配置：

```typescript
async function getUserEnvFromSettings(): Promise<Record<string, string>> {
  const homeDir = getHomeDir();
  const settingsPath = `${homeDir}/.claude/settings.json`;
  const content = await readTextFile(settingsPath);
  const settings = JSON.parse(content);
  // 返回 { ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, ANTHROPIC_MODEL }
}
```

然后在 `query()` 调用时合并环境变量：
```typescript
env: {
  ...process.env,
  ...userEnv,           // 从 settings.json 读取的 token
  ANTHROPIC_MODEL: "MiniMax-M2.7",
}
```

### 关键教训

`settings.json` 是 Claude CLI 的配置文件，不等同于环境变量。SDK spawn 的子进程默认不会加载它，必须显式读取并传递。

---

*文档创建日期: 2026-04-18*
*重点：FastAPI 入门 + 数据流 + 服务包装识别*
