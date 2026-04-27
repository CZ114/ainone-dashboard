# Whisper-Local Debug Journey

> v1.0.0 + post-v1 修复落地之后，本轮在 `dev` 分支把 Whisper 本地 STT 从"能跑"
> 推到"能用"：流式质量、GPU 加速、可配置 UI、缓存管理、热重启。每一段都是
> 一个独立的坑，按时间顺序记录"症状 → 误判 → 真因 → 修法 → 教训"。
>
> 主线索：**CT2 + CUDA + Windows + faster-whisper** 这四个东西的交叉点。
> 每一个单独都没问题，叠在一起就会以最反直觉的方式失败。
>
> 相关结构性变化的实现细节见 [`SPEC.md` § 15](SPEC.md)，本文只讲"过程"。
> 提交散落在 `dev` 分支当前的未提交工作树（13 modified + 2 new files）。

日期：**2026-04-27**

---

## Round 1：3 秒切口的语义断崖

### 症状

Whisper 跑起来了，转写也出文字，但每隔几秒文本就有一处奇怪的断点：句子被
切成两半，第二半的开头大概率是模型重新"猜出来"的版本——同一个词出现两次
（`你好你好`），或者一个词被劈成两个不存在的词（`spec specification`）。

### 第一假设

beam_size 不够大，模型在低信号情况下乱选 token。把 `beam_size` 从 5 调到
10。质量微提升但断崖还在。这条线索是错的。

### 真因

`CHUNK_SECONDS = 3.0` 把 UDP 流硬切 3 秒一段，每段独立 decode：

```
chunk N        chunk N+1
[......你好...][...好世界...]
              │
              └─ 边界。chunk N 把"你好"读完了；
                 chunk N+1 不知道"你好"已被读过，
                 又把残余尾音重新解码成"好"。
```

两个独立问题：
- **声学边界**：一个发音横跨切口时，两边各拿到半个音节，模型对两边各猜一遍。
- **语言学不连续**：模型每次 decode 都是"从空提示开始"，没有上下文，所以
  人名、缩写、专业词每段都重新猜，互相不一致。

### 修法

[`whisper_local.py:952-969`](backend/app/extensions/whisper_local.py#L952-L969)
+ [`1200-1220`](backend/app/extensions/whisper_local.py#L1200-L1220)
+ [`1283-1290`](backend/app/extensions/whisper_local.py#L1283-L1290)

三件事一起做：

1. **窗口缩短 + 重叠**：`CHUNK_SECONDS 3.0 → 1.5`，引入 `OVERLAP_SECONDS = 0.3`。
   每次切下整个 chunk 大小的音频，但只把 `chunk - overlap` 字节从 buffer
   里移除——尾部 overlap 留作下一 chunk 的开头。同一个跨界单词必然在
   至少一个 chunk 里完整出现。
2. **跨窗 prompt 续接**：把上一 chunk 的 raw 文本（截尾 ~120 字）作为
   `initial_prompt` 喂给下一次 `transcribe()`。Whisper 有一个 ~224 token 的
   prompt 槽，最近的尾巴最相关。
3. **字符级 dedup**：因为 overlap 区域会被解码两次，broadcast 之前必须
   去重。`_strip_overlap_prefix(prev, new)` 找最长 `k` 使得 `prev[-k:] ==
   new[:k]`，4 字符下限避免误伤"the"、"了"这种短词；60 字符上限避免极端情况。
   字符级而不是词级——这样 CJK 和空格分隔语言走同一条代码路径。

关键设计：维护**两个**文本变量，
[`whisper_local.py:275-283`](backend/app/extensions/whisper_local.py#L275-L283)：
- `_last_raw_text`：模型原始输出，喂给下一轮的 `initial_prompt`，也是 dedup 的
  比对基线。
- `_last_text`：dedup 之后的版本，是真正广播给前端的。

两者不能混。早期版本只有一个变量，结果 dedup 之后再喂回去当 prompt，第二
轮模型就缺了"之前已经说过这句"的上下文，整个续接的意义垮掉了。

如果整个新 chunk 都在 overlap 区域内（罕见但可能——讲话节奏快/window 长），
broadcast 跳过，但 `_last_raw_text` 仍要更新，否则下一轮的 prompt 还指向
更早的内容，dedup 比对错位。
[`whisper_local.py:1044-1053`](backend/app/extensions/whisper_local.py#L1044-L1053)。

### 教训

切口处的字面 dedup 只是表面功夫。真正的修复是**语言学连续性**——让模型
看见过去说了什么。`initial_prompt` 是 faster-whisper API 里被严重低估的
特性。

---

## Round 2：GPU 加载成功，转写永远不返回（最重要的一节）

### 症状

切到 `large-v3-turbo`，模型加载日志清楚写着：

```
[whisper] loaded on CUDA (float16) — model=large-v3-turbo
[whisper] warmup transcribe complete in 4823 ms — kernels primed
```

看起来一切就绪。然后用户对着 ESP32 麦说话：

- ESP32 → UDP 帧收到
- buffer 累计到 chunk 阈值
- `dispatch chunk #1: 48000B` 日志打出
- ……然后什么都没了

进程不崩，CPU 不忙，GPU 利用率 0%，event loop 没死（其它 HTTP 请求正常响应）。
单个 transcribe 永远不返回。前端转写 WS 永远等不到 `partial`，看上去就像
backend hang 死了。

### 误判 #1：CUDA driver 版本不对

第一反应：肯定 CUDA driver / cuDNN 版本不匹配。重装 `nvidia-cudnn-cu12`，
重装 `ctranslate2`，没用。

### 误判 #2：模型坏了

下一反应：模型权重下崩了。删掉 `VoiceModel/models--mobiuslabsgmbh--*`
重新下，没用。

### 误判 #3：是不是 vad_filter 把音频吞了

把 `vad_filter=True` 改成 `False`，让模型必须 decode 这段音频。还是 hang。
说明问题在 model 本身的 forward path，不在前置 VAD。

### 真因（用一个独立 repro 脚本验证）

写一个最小复现，绕开 FastAPI / asyncio / UDP，直接：

```python
from faster_whisper import WhisperModel
m = WhisperModel("large-v3-turbo", device="cuda", compute_type="float16")
import numpy as np
audio = np.random.randn(16000).astype("float32") * 0.01
segments, _ = m.transcribe(audio)
for s in segments:
    print(s)
```

在 venv 内执行——hang 在第一次迭代 segments 时。换言之：**问题在 CT2 内部**，
不在我们的代码。

加 `import os; os.add_dll_directory(...)` 把 `<venv>/Lib/site-packages/nvidia/cublas/bin/`
加进去——还是 hang。

加 `os.environ["PATH"] = nvidia_bin + ";" + os.environ["PATH"]` —— 这次成功
返回了。

把 `os.environ["PATH"]` 那行去掉，只保留 `os.add_dll_directory` —— 又 hang 了。

原因终于找到：

- `WhisperModel(...)` 构造时只需要 `nvcuda.dll`，这个 DLL 在
  `C:\Windows\System32`，永远找得到——所以加载日志会打 "loaded on CUDA"，
  误导我们以为一切正常。
- 第一次真正的 matmul 需要 `cublas64_12.dll`、`cudnn_*.dll`，这些 DLL 在
  `nvidia-cublas-cu12` / `nvidia-cudnn-cu12` 的 wheel 里，路径
  `<venv>/Lib/site-packages/nvidia/cublas/bin/`——**默认不在 DLL 搜索路径上**。
- 找不到 cuBLAS DLL 时，CT2 的 native code（不是 Python 部分）走的是 bare
  `LoadLibrary`，这个 API 只看**遗留 DLL 搜索顺序**（PATH 是其中最后一项）。
- `os.add_dll_directory` 只对 Python 自己用 `LoadLibraryEx` +
  `LOAD_LIBRARY_SEARCH_USER_DIRS` 加载的 DLL 生效，**对 CT2 native 的 bare
  `LoadLibrary` 无效**。
- 关键变态点：DLL miss 时 CT2 的 generator 内部 worker thread **不会抛错**，
  而是无声 hang。warmup 之所以"成功"，是因为 warmup 只 1 秒白噪声，模型
  做的事情少得可能没碰到那条 DLL miss 的具体路径——这是误导信号。

### 修法

[`whisper_local.py:467-491`](backend/app/extensions/whisper_local.py#L467-L491)

Windows 上启动时把所有 `<venv>/Lib/site-packages/nvidia/*/bin` 同时
prepend 到：

1. `os.environ["PATH"]` —— 给 CT2 的 bare `LoadLibrary` 用，**这条是必须的**。
2. `os.add_dll_directory(...)` —— 给任何用 `LoadLibraryEx` 现代 API 的调用者
   用，防御性的。

```python
nvidia_root = Path(sys.prefix) / "Lib" / "site-packages" / "nvidia"
extra_paths = [str(p) for p in nvidia_root.glob("*/bin") if p.is_dir()]
if extra_paths:
    os.environ["PATH"] = os.pathsep.join(extra_paths) + os.pathsep + os.environ["PATH"]
    if hasattr(os, "add_dll_directory"):
        for p in extra_paths:
            try: os.add_dll_directory(p)
            except (OSError, FileNotFoundError): pass
```

macOS / Linux 完全跳过这段——CT2 的 `.dylib` / `.so` 打包在 `ctranslate2`
wheel 内部，OS 动态加载器走 `@rpath` / RPATH 自己解决。

### 教训

1. **加载成功 ≠ 能用。** CUDA 模型能 load 不代表能 inference。warmup pass
   要做得激进点（白噪声而不是 silence，避免 VAD 短路）才能真的练到 forward
   path。
2. **`os.add_dll_directory` 在原生扩展里不是万灵药。** 现代 Python C 扩展
   通常按这个 API 来加载，但任何用 bare `LoadLibrary` 的 native lib（CT2、
   一些 OpenCV build、CUDA runtime 自己）只看 PATH。Belt-and-suspenders。
3. **当 hang 而不是 raise 时，怀疑 native deadlock。** Python traceback 里
   只看到 await 一个 future，要降到 native（gdb / windbg / verbose dll
   loader）才看得到根因。这次靠 repro 脚本绕过了 native debug，但下次未必
   这么幸运。
4. **写一个独立 repro 脚本** 是诊断这类问题最便宜的工具。20 行隔离掉所有
   FastAPI/asyncio/UDP 的脏复杂度。

---

## Round 3：第一次启动 backend 假死 3 分钟

### 症状

把默认模型从 `small` 切到 `large-v3-turbo`、删掉本地缓存重启 backend：

- 启动脚本卡在 `[whisper] Loading Whisper model...`
- 前端打开页面，splash 一直转——所有 `/api/*` 请求 ECONNREFUSED
- 浏览器开发者工具：`AggregateError [EACCES]: ECONNREFUSED 127.0.0.1:8080`
- 几分钟后 backend 突然就活了，所有积压请求 200 返回

### 真因

`on_start` 是 FastAPI lifespan 的一部分，被 uvicorn 直接 `await`。`on_start`
里 `await asyncio.to_thread(self._load_model_blocking)` —— 这个 thread 里在
做 1.5 GB 的 HuggingFace 下载 + CT2 模型构造 + warmup。

整个过程 90-180 秒。这段时间内 lifespan 没完成 → uvicorn 没开始 accept
连接 → 监听 socket 没 listen → 浏览器 ECONNREFUSED。

### 修法

[`whisper_local.py:595-619`](backend/app/extensions/whisper_local.py#L595-L619)

`on_start` 改成"开火不等"：

```python
async def on_start(self, app):
    # 先订阅 audio bridge，将来收到的 frame 至少能进 buffer
    self._conn_manager.audio_bridge.add_audio_consumer(self._on_frame)
    # 然后把 model load 作为后台任务发出去——立即返回
    if self._model is None and not self._model_loading:
        self._load_task = asyncio.create_task(self._load_model_async())
```

`_on_frame` 加三道闸 [`whisper_local.py:976-987`](backend/app/extensions/whisper_local.py#L976-L987)：

- `self._model is None` → 增加 `_not_ready_drop_count`，每 20 个丢一次
  日志，避免日志洪水
- 上一次 transcribe 还在飞 → 增加 `_drop_count`
- event loop 还没设上 → 警告

`on_stop` 必须取消 in-flight load
[`whisper_local.py:660-684`](backend/app/extensions/whisper_local.py#L660-L684)，
否则后台任务可能在 `on_stop` 返回**之后**才完成，把 `self._model` 赋成
新对象，然后没人 own，CUDA context 泄漏。

### 教训

FastAPI 的 lifespan `await` 是硬阻塞——任何在那里 await 的耗时操作都会让
整个服务无法响应。**重资源加载必须 `create_task` + 状态门控**，让事件循环
立即返回继续 accept 连接，资源就绪状态由调用点检查。

---

## Round 4：In-Process 切换模型——三次尝试，三次崩（带不出 traceback）

### 症状

用户在 Settings 把模型从 `tiny` 改到 `medium` 点 Apply。后端预期：旧模型
释放，新模型加载，下一个 chunk 用新模型转写。**实际：backend 进程直接退出**。

退出码 `0xC0000005`（Windows access violation）。stdout 没有 Python
traceback——崩在 native code 里，Python 来不及打印。日志只有：

```
[whisper] model_name change: tiny → medium (model_currently_loaded=True)
[whisper] starting in-process reload
<EOF>
```

### 尝试 1：sync reload + gc.collect

```python
self._model = None
gc.collect()
self._model = WhisperModel("medium", ...)
```

崩。

### 尝试 2：异步 reload（先释放，等几秒再加载）

```python
old, self._model = self._model, None
del old
gc.collect()
await asyncio.sleep(2)
self._model = WhisperModel("medium", ...)
```

也崩。崩点稍微不一样——有时候是新 model 构造时崩，有时候是旧 model 析构时
崩。

### 尝试 3：`del` 之前先 sync to GPU

`torch.cuda.synchronize()` 类似的操作（CT2 没暴露这个 API，用 raw stream
拿不到）。无效。

### 真因（推断）

CT2 + CUDA + Windows 的析构路径在某些状态下不可重入——更具体地，CUDA
runtime 在两个相邻的 model 实例（一个正在析构、一个正在构造）共享 device
context 的窗口里会有 race。Python GIL 不保护 native code，gc.collect()
也不保证立即释放（refcount 之外可能还有 cuBLAS handle、CT2 内部缓存等
持有引用）。

这种东西理论上可以在 native 层加更多的 sync 来修，但：
- 我们改不了 CT2 内部代码
- 即使加了 sleep / sync，也只是把崩的概率降低，不是消除

### 修法

放弃 in-process 切换。
[`whisper_local.py:828-862`](backend/app/extensions/whisper_local.py#L828-L862)

`on_config_change` 收到 `model_name` 变更时：
1. 持久化（manager 已经做完了）
2. 日志说清楚"现在不会切，重启后生效"
3. **回滚 `self._model_name` 在内存里的值**，让 `status()` 返回的
   名字和实际加载的模型一致——否则前端会显示"已配置 medium"但实际跑的还是
   tiny，更让人困惑

UX 补：[`backend/run.py`](backend/run.py) 改成 supervisor，
[`backend/app/api/system.py`](backend/app/api/system.py) 加 `POST
/api/system/restart`，`os._exit(42)` 1 秒延迟以让 HTTP 响应 flush 完。
supervisor 看到 42 自动重启子进程。前端 ConfigPanel 加一个 "Restart now"
按钮 + 3 分钟 polling 状态机
[`ExtensionConfigPanel.tsx:160-205`](frontend/src/components/settings/ExtensionConfigPanel.tsx#L160-L205)。

加 `requires_reload: true` 字段到 schema，前端渲染琥珀色 "Restart required"
徽章 + 重启按钮。从用户视角：点 Apply → 看到徽章 → 点 Restart now → 等 30 秒
~ 3 分钟（取决于是否要下载新模型）→ 自动恢复。

### 教训

1. **不可调试的 native crash 是认输信号。** 你可以花一周加各种 sync 和
   barrier，最后还是会在某种边角情况下崩。直接绕过它。
2. **重启进程是合法的 UX 工具**——只要做得透明（自动重启、明显的进度
   反馈、保留持久化状态）。VS Code、Docker Desktop 都靠这个。
3. **持久化-then-生效** 比 **生效-then-持久化** 安全。我们先把新值写盘，
   再尝试应用——即使应用失败（或像这里直接放弃了），下次启动还能用。

---

## Round 5：跨盘 mv 撕成两半

### 症状

把模型从 `~/.cache/huggingface/hub/`（在 C: 盘）迁到 `<repo>/VoiceModel/`
（在 D: 盘），用 bash：

```bash
mv ~/.cache/huggingface/hub/models--Systran--faster-whisper-* \
   /d/Imperial/individual/esp32_sensor_dashboard/VoiceModel/
```

部分目录 mv 完了，剩下的报错 `Invalid cross-device link`。重试一次，**新报错**：
`File exists`——因为部分文件已经成功复制过去，rename 失败 fallback 到 cp+rm，
中间某些文件已经存在。

### 真因

bash `mv` 跨文件系统的实现：先 `rename(2)`，跨 filesystem 时 rename 报错
`EXDEV (Invalid cross-device link)`，然后 fallback 到 cp 全部 + rm 源。

中断之后再跑：`mv` 看到目标已经有部分内容，**不会**自动认作"continue"，
要么覆盖（不是默认）要么报错（默认）。结果是源目录半空、目标目录半满，
两边都不完整。

### 修法

```bash
rm -rf /d/.../VoiceModel/models--Systran--faster-whisper-*
cp -r ~/.cache/huggingface/hub/models--Systran--faster-whisper-* \
      /d/.../VoiceModel/
rm -rf ~/.cache/huggingface/hub/models--Systran--faster-whisper-*
```

显式 `cp -r` 然后 `rm -rf` 源。比 `mv` 更慢但每一步都是幂等可重启的。

### 教训

跨盘的 `mv` 不要用——它假装是原子的但其实不是。`cp` + `rm` 步骤明确，
失败可重启。在 Windows 上特别要小心，因为驱动器盘符暗示了 filesystem
边界，但 bash 用户不一定意识到。

---

## Round 6：Vite 代理 404 ——配置改了没生效

### 症状

前端调 `restartBackend()`：

```
POST http://localhost:5173/api/system/restart  →  404 Not Found
```

但 backend 直连测试 `curl -X POST http://localhost:8080/api/system/restart`
是 200。所以 backend 路由没问题，是 vite 代理没把这条路径转发过去。

### 第一次修

打开 `frontend/vite.config.ts`，加：

```ts
'/api/system': {
  target: 'http://localhost:8080',
  changeOrigin: true,
},
```

保存。还是 404。

### 真因

vite 的 proxy 配置**不**热更新。改了 `vite.config.ts` 之后 dev server 自己
不会重新加载这个文件——必须 Ctrl+C / 重启 `npm run dev`。

### 修法

重启 vite。404 立刻消失。

[`frontend/vite.config.ts:68-71`](frontend/vite.config.ts#L68-L71) 现在
有 `/api/system → :8080` 的条目。注意：vite.config 里同时还有一条更早的
`/api/system → :3000`（给 claude backend 的——见
[`vite.config.ts:27-30`](frontend/vite.config.ts#L27-L30)），但 vite 的
proxy 用最后匹配赢，所以 :8080 那条覆盖了 :3000 的——这是无意之得，但目前
没有冲突，因为 claude backend 上没有 `/api/system/*` 路由。如果将来加，
要么改成更具体的前缀（比如 `/api/system/claude/*`），要么删掉那条死规则。

### 教训

每次改 dev tooling 的配置文件——`vite.config.*`、`tsconfig.json`、
`webpack.config.*`——都要假设需要重启 dev server。HMR 只覆盖**应用代码**，
不覆盖**编译/代理本身的设定**。404 在新加路由的场景里是 90% 概率的"配置
没生效"信号。

---

## 经验提炼

### 1. CT2 + CUDA + Windows 的"加载成功"是误导信号

加载只用最少的 DLL，inference 才需要完整的 cuBLAS/cuDNN。任何把"模型加载完成"
当作"准备好转写"的代码都会在跨域调用时埋雷。**warmup pass 必须激进**——用
真音频（白噪声），跑完整个 forward path，否则 warmup 的"pass"也是误导的。

### 2. `os.add_dll_directory` 不能替代 `PATH`

现代 Python 文档推这个 API，但只对 `LoadLibraryEx` 调用有效。任何用 bare
`LoadLibrary` 的 native lib（包括很多预编译扩展）只看 PATH。一定 PATH +
add_dll_directory 双保险。

### 3. Lifespan await 是禁区

任何在 FastAPI lifespan 里 await 的耗时操作都会让监听 socket 推迟 listen。
重资源 → `create_task` + 状态门控，这是 web 服务里最普遍的模式之一，
但很容易在写 extension 时忘记。

### 4. 不可调试的 native crash 是认输信号，绕过它不丢人

我们花了几个小时尝试在 Python 层修复 CT2 模型替换的 segfault，最后承认：
有些东西从 Python 不可达。建一个 supervisor，restart 处理所有"不能在进程内
完成的状态变化"。**重启不是失败模式，是合法的 UX**——只要做得透明。

### 5. 持久化-then-生效

写盘要在尝试应用之前。这样即使应用爆炸了（segfault、OOM、网络中断），下次
启动还能用。`manager.update_config` 严格遵守这个顺序：写盘 → notify
running instance → 把 instance error 记到 last_error，但持久化不回滚。

### 6. 跨盘 `mv` 不是原子的

`rename(2)` 跨 filesystem 报 EXDEV，shell 默默 fallback 到 cp+rm。中断后
半成品状态没人会自动收拾。明确用 `cp -r && rm -rf` 替换，每一步幂等。

### 7. Dev server 配置改了要重启

`vite.config.*` / `tsconfig.json` / `webpack.config.*` 不走 HMR。新加 proxy /
新加 alias / 新改 plugins，都必须 Ctrl+C 重启。改了之后看到 404，先想"是不是
我没重启 vite"——比"是不是 backend 路由错了"概率高 10 倍。

---

## 文件落地总结

新文件：
- [`backend/app/api/system.py`](backend/app/api/system.py) — `POST /api/system/restart`
- [`frontend/src/components/settings/ExtensionConfigPanel.tsx`](frontend/src/components/settings/ExtensionConfigPanel.tsx)
- [`frontend/src/components/settings/ExtensionCachePanel.tsx`](frontend/src/components/settings/ExtensionCachePanel.tsx)

主要修改：
- [`backend/app/extensions/whisper_local.py`](backend/app/extensions/whisper_local.py) — 几乎重写
- [`backend/app/extensions/base.py`](backend/app/extensions/base.py) — 新 hook
- [`backend/app/extensions/manager.py`](backend/app/extensions/manager.py) — `update_config` + 配置在 `on_start` 之前 apply
- [`backend/app/api/extensions.py`](backend/app/api/extensions.py) — 新 endpoints
- [`backend/app/api/recordings.py`](backend/app/api/recordings.py) — 文件批量转写
- [`backend/run.py`](backend/run.py) — supervisor 重写
- [`frontend/vite.config.ts`](frontend/vite.config.ts) — `/api/system` proxy
- [`.gitignore`](.gitignore) — `VoiceModel/`

工作树状态（截至 2026-04-27）：13 modified + 2 new files，未提交。本文写
就之时尚未执行 `git commit`——交付决定权在用户。
