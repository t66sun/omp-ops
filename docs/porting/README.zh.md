# omp 移植版

[English](README.md)

`omp/` 把 dsh-ops 的核心算法移植为 omp 宿主的扩展。它不是另起一套工具集的第二个插件：它观察宿主的 `tool_result` 事件，
在宿主自己的回答会误导模型时改写模型看到的内容，并提供一个活在 `eval` 单元里的 SDK。

`src/` 中的 DSH 插件保持不变、照旧发布。`omp/` 不依赖它，也不引用它；删除 `omp/` 不会影响 DSH 插件。

## 为什么做这件事

移植的价值由三个主张支撑。单看每个都不大；合在一起，它们消掉了一类比任何单个工具都更贵的失败。

1. **诚实的反馈能终止重试循环。** 一个不说清「到底改没改」的失败，会诱使模型盲目重放——重放一次写入、一条命令、一个
   `eval` 单元。每个被分类的失败都会发布它能证明的东西：`effectState`（`none` / `applied` / `partial` / `unknown`）以及
   由它推出的 `retry` 策略。副作用优先：可能已经写入过东西的失败调用，永远不会建议再试一次。
2. **小 schema 省 token。** 扩展不注册工具、不注册命令、不注册快捷键，因此不增加任何工具 schema 的 token，也不改变工具列表。
   常驻成本只是一个 `tool_result` 处理器和几个字段读取函数。
3. **渐进披露。** 事先什么都不广播。结果行只出现在状态不是 `completed` 的结果上；PTC 提示只出现在未经加载就伸手去够 `ops`
   的单元里；去重只替换模型已经看过的正文。

## 已交付

| 能力 | 一句话承诺 |
| --- | --- |
| 诚实的结果 | 每个被分类的失败都在 `details["outcome.v1"]` 里说明它可能改动了什么、重试是否有用。 |
| 一行模型可见文本 | 失败结果恰好获得一行 `[outcome: <status> · effect <state> · retry <policy>] <message>`；成功结果逐字节不变。 |
| 读取去重 | 重读未变化的文件时，返回一行简短的引用，指名已经持有正文的那次工具调用，而不是再发一遍正文。 |
| PTC SDK | 在 `eval` 单元里 `await ops.read({…})` 返回同一个类型化的 `Outcome`；由于 omp 不向扩展提供 prelude API，它经宿主的 `%load` 加载。 |

承诺背后的契约——字段形状、适用条件、字节上限，以及诚实的局限——见 [contract.zh.md](contract.zh.md)。移植绕开的宿主行为，
连同复现与数字，见 [host-defects.zh.md](host-defects.zh.md)。

## 安装

插件包根是 `omp/`，不是仓库根。它的清单是 `package.json#omp`，指向 `./src/extension/index.ts`。

这个布局决定了安装渠道。**`omp plugin install <git-url>` 在这里不工作。** 该命令把 git URL 解析成包根，而本仓库的根是
DSH 插件、不是 omp 包；命令的 spec 里没有可以下探的子目录。受支持的渠道是 marketplace 目录里的一条带 `git-subdir` 源的条目：

```json
{
  "name": "omp-ops",
  "source": {
    "source": "git-subdir",
    "url": "https://github.com/t66sun/omp-ops.git",
    "path": "omp",
    "ref": "main"
  }
}
```

把这条条目加进你的 omp 所读取的目录，然后从它安装 `omp-ops`。marketplace 路径会缓存源码，并把符号链接放进
`<scope>/plugins/node_modules`；它不安装依赖，这也是 `omp/` 保持零依赖的原因（其 `package.json` 未声明任何依赖）。

本地开发时，直接链接目录：

```sh
omp plugin link /absolute/path/to/repo/omp
```

## 状态

| 轮次 | 工作 | 状态 | 原因 |
| --- | --- | --- | --- |
| 1 | 诚实层：内核规则、`outcome.v1`、一行渲染文本 | 已交付 | 核心能力；之后每一轮都使用它的词汇。 |
| 2 | 带证据链与 epoch 的读/搜去重 | 已交付 | 纯输出层改动；不需要宿主配合。 |
| 3 | PTC SDK（`ops`）与 `%load` 助手 | 已交付 | `eval` 里本来就有 `tool.<name>`；只需构建类型化投影。 |
| 4 | 原生模块 | 无 | 被计划自己的规则取消：原生模块必须先有一个可复现的失败，而没有任何候选满足。grep 的覆盖度可以从 `details` 已有的数字推出；严格 CSV/TSV 解析是 O(bytes)，32 MiB 以下 TypeScript 足够；文档解析已由宿主自带的读取器覆盖；唯一可能值得原生的部分（Windows DACL 保留、只读拒绝）没有观察到失败。计划的决策规则是「没有失败场景，就没有第 4 轮」。 |
| 5 | 表格与批处理工具（`ops_read_table`、plan/run/resume） | 未构建 | 在计划里是可选项，而它会增加工具——正是本移植要避免的 schema 成本。第 1–3 轮没有任何东西依赖它，树里也没有 `omp/src/table` 或 `omp/src/batch`。若观察到真实的解析失败，可以重新考虑严格 CSV。 |
| 6 | 发布：打包、证据、本文档 | 本次变更 | — |

## 证据

- [spike-report.md](spike-report.md) —— 从 omp 18.12.6 逐字捕获的宿主载荷。
- [prelude-findings.md](prelude-findings.md) —— 为什么没有 prelude API，以及 `%load` 做了什么。
- [testing.zh.md](testing.zh.md) —— 门禁、五个活体场景、单元套件与手工探针配方。
