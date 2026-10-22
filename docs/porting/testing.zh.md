# 验证移植

[English](testing.md)

验证分两层，回答的是不同的问题。单元套件证明每个变换在隔离状态下正确；活体 smoke 证明真实 omp 会话能加载扩展，
并且模型拿到的工具结果带着承诺的形状。两层都不读模型的话术，所以一段写得很漂亮但做错事的长篇回答无法让它们通过。

## 轮次门禁

在仓库根目录运行：

```sh
node scripts/round-gate.mjs            # 全部七步
node scripts/round-gate.mjs --no-live  # 没有 omp 的机器跳过活体步骤
```

每一步回答一个评审者无法从 diff 里回答的问题：

| # | 步骤 | 命令 | 问题 |
| --- | --- | --- | --- |
| 1 | `size` | `node scripts/check-file-size.mjs` | 有被跟踪的代码文件越过 1000 行规则吗？ |
| 2 | `plugin` | `node scripts/check-omp.mjs` | 清单能解析、每个模块可达、没有发布 marketplace 装不下的东西吗？ |
| 3 | `unit` | `node --test omp/test/*.test.ts` | 每个变换还通过自己的断言吗？ |
| 4 | `stubs` | 扫描 `omp/src/**/*.ts` | 还有哪个切片是 `STUB — replaced by slice …` 的空操作？ |
| 5 | `inert` | 在 `omp/src/{rules,render,dedup}/**` 中找 `apply(...) { }` | 有变换注册了空函数体吗？ |
| 6 | `slices` | `node scripts/check-slices.mjs` | 任意两个切片碰过同一个文件吗？ |
| 7 | `live` | `node omp/scripts/smoke.mjs` | 真实 omp 会话看得到结果吗？（需要 `omp` 在 `PATH` 上） |

通过时每一步打印一行带耗时的 `ok`，并以 `round gate passed: 7 step(s)` 结束。失败步骤的输出打印在 `FAIL` 行下面，
进程以 1 退出并输出 `round gate failed: N of 7 step(s)`。门禁是轮次的合并标准，不是形式：第 3、4 步之所以存在，
是因为空操作的变换能通过所有类型检查和所有「不抛异常」测试。

## 安装校验

轮次门禁是从源码加载扩展的，看不见发布路径特有的失败模式：marketplace 安装只读 `omp.extensions`，于是「功能放在独立
entry 里」的插件能装上、然后什么都不做。改动清单之后手工验一次发布形态：

```sh
omp plugin marketplace add t66sun/omp-ops --scope user
omp plugin install omp-ops@omp-ops --scope user
omp -p "Run the bash command 'false' and report the exact output."
```

回答里必须有那行结果，工具结果必须带 `details["outcome.v1"]`：

```
Command exited with code 1
[outcome: error · effect unknown · retry after-input-change] Command exited with code 1; any file
writes or other side effects before the exit are unknown.
```

全程不带 `-e`：要证明的正是「装完什么都不用做就能生效」。验完用
`omp plugin uninstall omp-ops@omp-ops --scope user` 卸掉。

## 单元套件

```sh
node --test "omp/test/*.test.ts"
```

当前树：**340 个测试，339 通过，1 跳过**。跳过的是 `omp/test/dedup-evidence.test.ts:76` 的
「a symlink to a regular file has no identity」：该测试需要 `fs.symlinkSync` 成功，而没有符号链接权限的 Windows 账户会得到
`EPERM`，于是用例走 `t.skip(...)`（`omp/test/dedup-evidence.test.ts:83`）而不是失败。在 POSIX 主机上，或开启开发者模式的
Windows 上，同一测试会运行，并断言符号链接按它自身判定，不按它指向的目标判定。

套件与源码同放在 `omp/test/` 下，每个关注点一个文件：内核规则、结果投影、渲染行、去重闸门/证据/epoch/上限、PTC 投影与助手、
扩展接线、安装表面。没有测试需要网络或活体会话。

## 活体 smoke

```sh
node omp/scripts/smoke.mjs             # 全部五个场景
node omp/scripts/smoke.mjs dedup       # 单个场景
```

`OMP_BIN` 覆盖二进制（默认 `PATH` 上的 `omp`）；`SMOKE_MAX_TIME` 覆盖每次调用的 `--max-time`（默认 `180` 秒）。
每个场景拿到一个全新的临时目录，里面是 `data.txt`（40 行，`<n> | line <n> of the fixture`），并运行：

```sh
omp -p --mode json -e <repo>/omp/src/extension/index.ts --max-time <SMOKE_MAX_TIME> "<prompt>"
```

harness 把 stdout 按行解析为 JSON，留下带结果的 `tool_execution_end` 事件，并对 `result.content` / `result.details` 断言
——从不针对模型的收尾话术。

| 场景 | 提示 | 断言 |
| --- | --- | --- |
| `honesty` | 用 `bash` 精确执行 `false` | 最后一条 bash 结果的 `details["outcome.v1"]` 为 `effectState: "unknown"`、`retry: "after-input-change"`，且文本含 `[outcome: error · effect unknown · retry after-input-change]` |
| `file` | 用 `edit` 把 `missing.txt` 里的 `alpha` 换成 `beta`，不要创建文件 | 最后一次失败的文件操作带 `code: "NOT_FOUND"`、`effectState: "none"`，以及 `[outcome: error · effect none · retry after-input-change]` |
| `eval` | 在 `js` cell 里运行 `process.exit(3)` | 最后一条 eval 结果带 `code: "RESULT_UNKNOWN"`、`effectState: "unknown"`、`retry: "never"` |
| `dedup` | 读 `data.txt` 两次，不用其它工具 | 至少两次读取；第一次含 `line 7 of the fixture`，第二次含 `body already present in the current model context`，且严格更短 |
| `ptc` | 在 `py` cell 里运行 `await ops.read({"path": "x"})`，不先加载任何东西 | 至少一个 eval cell 带 `%load` 提示，且该行同时指名两个助手：`%load "<…>ops.mjs"` 与 `%load "<…>ops.py"` |

场景天然不确定——它们依赖模型照一行指令行事。通过运行证明的是：扩展被加载、宿主交付了载荷、移植的反应正确；
它不声称每个模型都会走同一条路。

## 手工探针

某个行为没有被场景覆盖时，用同样的形状探测真实会话：

```sh
omp -p --mode json -e /absolute/path/to/omp/src/extension/index.ts --max-time 180 "<prompt>"
```

`--mode json` 输出 `tool_execution_end` 事件，其 `result` 带 `content`、`details`、`isError`，断言需要的东西都在。
`-e` 用绝对路径——相对路径会按探针的工作目录解析。`--max-time` 单位是秒。

**不要**以为 `--no-tools=false` 能重新开启工具。在 omp 18.12.6 上，这个开关只要出现就生效：以「Reply with the single word DONE.」
探测时，带开关报告 91 个输入 token，不带则是 268 个；要求 `read` 的提示更是一个工具执行事件都没产生。
默认（不写开关）就是工具开启，别去动它。

## 通过运行不能证明什么

- 它不测量 token 或延迟相对于基线的变化。这些文档里唯一的大小主张都是线上观察到的字节：夹具正文 1101 B、
  其去重引用 173 B、照抄自宿主载荷的 `matchCount` 与 `fileCount`。
- 它不证明去重总会命中。同一形状的七次活体探针命中六次、未命中一次；未命中会返回完整正文，这是安全的方向。
- 它不证明分页 `grep` 的覆盖完整性：宿主的 2000 匹配截断不可见，移植把每一次这类调用都报成 `partial`
  （见 [host-defects.zh.md](host-defects.zh.md)）。
