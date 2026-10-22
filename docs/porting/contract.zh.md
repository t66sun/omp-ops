# 消费方契约

[English](contract.md)

本页说明消费方可以依赖什么。它描述的是已交付的代码，而不是意图：下面的每个形状都在 `omp/src/` 里，并由测试固定。
没有写在这里的内容都是实现细节，可能变化。

## 1. `Outcome` 形状

`omp/src/kernel/outcome.ts` 定义这套词汇。每个值都是四种效果状态之一、四种重试策略之一：

```ts
type EffectState = 'none' | 'applied' | 'partial' | 'unknown'
type RetryPolicy = 'never' | 'after-input-change' | 'after-state-change' | 'bounded-transient'
type FailureStatus = 'rejected' | 'conflict' | 'error' | 'unknown'

interface OpsErrorPayload {
  code: string
  effectState: EffectState
  retry: RetryPolicy
  message: string
  nextAction?: string
}

type Outcome<T> =
  | { status: 'completed'; data: T; coverage?: CoverageMeta & { isComplete: true } }
  | { status: 'partial'; data: T; coverage: CoverageMeta & { isComplete: false }; continuation: string }
  | { status: FailureStatus; error: OpsErrorPayload; data?: T }
```

`partial` 结果必定带一个 `isComplete: false` 的 `coverage` 记录和一个 `continuation` 字符串；`completed` 结果若带
`coverage`，其类型被收窄为 `isComplete: true`，消费方无法把完整结果读成部分结果。`CoverageMeta` 为
`{ scannedFiles, matchedCount, isComplete, truncatedBy? }`，其中 `truncatedBy` 取 `scan-budget`、`output-budget`、
`time-limit`、`row-limit` 之一。

### 效果优先于重试建议

`errorPolicy(code, effectState)` 是唯一把失败变成建议的地方：

```ts
if (effectState === 'unknown' || code === 'RESULT_UNKNOWN' || code === 'EXECUTION_RESTRICTED') return unknown
if (effectState !== 'none') return settled
return ERROR_POLICIES[code] ?? settled
```

因此，可能已经改动过东西的调用永远不会建议重复执行：`unknown` 映射为 `status: 'unknown'`、`retry: 'never'`，
其余任何非 `none` 的效果映射为 `status: 'error'`、`retry: 'never'`。只有已被证明的 `effectState: 'none'` 才去查
代码表。

有一个刻意的例外，且只出现在 Bash 失败载荷上：命令正常跑完但退出码非零时，保留 `effectState: 'unknown'`
（写入可能已经落地），但报 `retry: 'after-input-change'`，因为退出码和输出是模型可以读到的证据，读完再决定。
`errorPolicy('EXIT_CODE', 'unknown')` 本身仍回答 `unknown`/`never`；例外在生产者里，不在规则里。查看输出不是重放命令。

## 2. 发布的事实与渲染行

规则在 `details["outcome.v1"]` 下写一条冻结记录：

```ts
interface OutcomeFacts {
  status: 'completed' | 'partial' | 'rejected' | 'conflict' | 'error' | 'unknown'
  effectState: EffectState
  retry: RetryPolicy
  message: string
  code?: string
  nextAction?: string
  coverage?: CoverageMeta
}
```

`v1` 是键的一部分：后续形状必须换用新键，这样旧渲染器仍能工作，「没有意见」也始终能与「有我读不懂的意见」区分开。
读取是严格的——记录缺少 `status`、`effectState`、`retry`、`message` 中任何一项，都被当作不存在，而不是半懂的结果。

渲染器（`omp/src/render/outcome-line.ts`）把事实变成恰好一行，追加到结果的最后一个文本块：

```
[outcome: <status> · effect <state> · retry <policy>] <message>
```

若存在 `nextAction`，同一行末尾再追加 ` Next: <nextAction>`。保证如下：

- **只有失败才有行。** `status: 'completed'` 不产生任何文本；成功结果与宿主产出逐字节相同。
- **恰好一行。** 对同一结果再次运行不会追加；匹配的是块末尾的整行，不是子串。
- **只碰一个文本块。** 结果没有文本块（只有图片、空数组）时，不臆造任何内容。
- **替换块而不是就地修改**，因为扩展按身份检测内容是否变化。

每个变换都是全函数：不得抛异常、不得在别处新增内容、不得翻转 `isError`。抛异常的变换会被捕获、按名字记录，
并让结果保持宿主产出的样子。

## 3. 读取去重

去重是纯输出层操作。它替换符合条件结果中的那一个文本块；从不写 `details`，也不改 `isError`。

### 适用条件

`read` 只有在以下条件全部成立时才适用：

- 调用成功（`isError` 为 false）且结果恰好是一个文本块；
- 正文不含 `TruncatedBy: output-budget`（被截断的正文是前缀，不是文件）；
- `details.meta.source` 为 `{ type: 'path', value: <绝对路径> }`；
- `stat` 确认该路径是普通文件，且能读到身份（`dev`、`ino`、`size`、`mtimeNs`、`ctimeNs`）；
- 键——工具名、原始参数与该身份的 JSON 元组——能够序列化。

`grep` 只有在以下条件全部成立时才适用：

- 结果恰好是一个文本块，且既不是 `No matches found`，也不是 `No more results` 续页；
- `details.matchCount` 与 `details.fileCount` 都是数字，且 `fileCount > 0`；
- `truncated`、`fileLimitReached`、`perFileLimitReached`、`linesTruncated` 都不为真（看的是存在性；limit 字段命中时
  是数字，未命中时键不存在）；
- `skip` 不存在或 `<= 0`——分页调用永远不是首页；
- 能计算出 revision（正文文本的 SHA-256）。

### 有效性与上限

记录以 agent key、上下文 epoch 与候选键为键。存储有界：

| 上限 | 值 |
| --- | --- |
| agent 数 | 16 |
| 每个 agent 的记录数 | 32 |
| 全存储正文字节 | 2 MiB |

触到上限时淘汰最旧的记录。没有 agent key 时（宿主上下文里的 `agent:<id>`，否则 `session:<PI_SESSION_ID>`），
去重完全不做：无键记录是对一个无法识别的上下文的主张。

已记录正文的有效期止于：

- 成功的 `edit`、`write` 或 `bash` 调用清空该 agent 的全部记录；
- 上下文 epoch 前进——`session_before_compact`、`session_compact`、`session_before_switch` 或
  `session_before_branch`——因为模型的上下文已不是记录正文时的那个；
- 身份证明失败，此时记录保持未命中，而不是被刷新。

命中时，只有压缩后的形态严格短于正文才改写，并且指名真正持有正文的那次调用：

```
[Notice: Unchanged file range; body already present in the current model context in tool call "<id>". Fresh read revalidated the revision above.]
```

活体实测：夹具第一次读取返回 1101 B，第二次返回 173 B。七次活体观测中有一次未命中，重新返回完整的 1101 B；
这是设计上允许的失败方向——未命中只花字节，不损正确性。

## 4. PTC SDK

`omp/src/ptc/` 把八个宿主工具暴露为一个带类型的表面：

```ts
type OpsTool = 'read' | 'write' | 'edit' | 'glob' | 'grep' | 'bash' | 'eval' | 'task'
type Ops = { readonly [K in OpsTool]: (args: CanonicalData) => Promise<Outcome<CanonicalData>> }
```

`CanonicalData` 是一个 JSON 对象。投影优先读 `details["outcome.v1"]`；只有完全没有事实时才查看原始载荷。规则：

- 计数必须是非负安全整数；其它任何值（`NaN`、`-1`、`1.5`、`'7'`、缺失字段）都读作 `0`，因为读不懂的计数不是计数的近似；
- 拼作 `time` 的截断原因（搜索报告里的拼法）归一化为 `time-limit`；
- 没有事实的失败变成 `RESULT_UNKNOWN` / `effectState: 'unknown'` / `retry: 'never'`，绝不猜成成功；
- 没有安全续读方式的 `partial` 结果得到一条明确说明，而不是伪造的游标。

### 如何加载

omp 18.12.6 没有面向扩展的 prelude API，因此无法注入 SDK。渠道是 `eval` 工具的 `%load`，它在内核里运行一个脚本。
只有当宿主回答 `'load-file'` 时，扩展才注册加载提示；在真正提供注册器的宿主上，提示从不注册。

JavaScript：

```
%load "<abs>/omp/src/ptc/js/ops.mjs"
const ops = createOps((name, args) => tool[name](args))
const out = await ops.read({ path: 'data.txt' })
```

这个文件刻意是脚本。`%load` 拒绝模块 `export`（`Unexpected keyword 'export' at <parse>`），所以助手没有 `import`、
也没有 `export`；它在末尾发布一个名字 `globalThis.createOps`。用纯 JavaScript 是因为 Bun worker 加载不了本项目的
TypeScript。

Python：

```
%load "<abs>/omp/src/ptc/py/ops.py"
ops = create_ops(tool)
out = await ops.read({"path": "data.txt"})
```

`create_ops(await_tool)` 把调用点当作可调用对象接收，不导入任何东西。两个助手都由调用方传入桥接；它们自己从不伸手去够宿主。

提示只有一行，追加到失败的 `eval` 结果上：该结果提到 `ops`、`createOps` 或 `create_ops`，却不含 `%load`。提示给出两个
绝对路径，且在同一段对话里不会重复。

## 5. 局限

以下性质来自宿主或设计，不是应当被悄悄修掉的 bug。消费方必须据此规划。

1. **去重键包含原始参数。** `notes.txt` 与 `./notes.txt` 是不同键，所以用不同拼写抵达同一个文件是一次安全未命中：
   正文会重新完整返回。这是刻意的——归一化路径或行区间会让不同的行区间撞键，而未命中的代价只是字节。七次活体
   探针中唯一一次未命中就是这种形态，且不可复现。
2. **被拒调用根本不产生 `tool_result`。** 在审批路径上，宿主发出 `tool_execution_start`/`tool_execution_end` 与一个审批
   事件，但没有结果载荷。扩展因此没有事实、也不为拒绝渲染任何行；`denied` 事实只能在 `tool_execution_end` 路径上生成，
   而本移植不处理该路径。
3. **分页 grep 永远不会被报成完整。** 宿主在内部 2000 个匹配处停止收集，并可能返回一个看起来干净的空页（见
   [host-defects.zh.md](host-defects.zh.md)）。由于这个上限不可见，`skip > 0` 一律报为 `partial`，`truncatedBy: 'row-limit'`
   ——即使该页恰好是最后一页。只有首页且没有任何截断标志时，才声称覆盖完整。

还有两条更小的，写在这里以免日后才发现：只有失败会被分类，所以成功的文件读取不携带 `outcome.v1` 事实；而 `read`
的成功路径属于去重的职责，不属于诚实层。
