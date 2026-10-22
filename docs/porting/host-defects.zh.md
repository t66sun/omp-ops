# 我们绕开的宿主行为

[English](host-defects.md)

以下全部在 omp 18.12.6 上观察到（`omp --version`）。没有一项靠修改宿主解决：移植检测到形状，然后退回到诚实的答案。
复现与数字记录在 `restructuringPLAN.md` §5.4；逐字载荷在 [spike-report.md](spike-report.md) 与
[prelude-findings.md](prelude-findings.md)，下面的数字照抄自那些捕获。

## 1. grep 内部 2000 个匹配的静默截断

**现象.** grep 收满 2000 个匹配后停止收集，并把下一页当成扫描已到树尾返回。一页最多 20 个文件、每文件 20 个匹配，
因此多文件搜索的 `matchCount` 最高只有 200，永远够不到触发停止的 2000。这个上限由此不出现在任何计数、标志或错误里。

**复现.** 300 个文件 `f000..f299`，每个含 10 行匹配；对该目录搜索该模式。

| 调用 | `matchCount` | `fileCount` | `truncated` | 实际 |
| --- | --- | --- | --- | --- |
| 第一页 | 200 | 20 | `true` | 扫描的第 0 页 |
| `skip: 199` | 10 | 1 | — | 该页只剩一个文件 |
| `skip: 200` | 0 | 0 | `false` | `f200..f299` 存在且匹配 |

空页不带任何 limit 键，所以它与「树里再没有更多」在字节上形状相同。触发点是内部的那个 2000：300 文件 × 10 匹配会触发，
120 文件 × 40 匹配也会（停在 96 个文件）。300 文件 × 5 匹配（共 1500）完全不触发上限——所以这个缺陷无法从文件数推出来。

**绕法.** `skip > 0` 的调用永远不报完整：搜索规则发出 `status: 'partial'`、`truncatedBy: 'row-limit'`，并在消息里写明观察到的
这一页以及「total unknown」。第一页只有在没有任何截断标志时才报完整。没有任何代码路径为分页扫描声称 `matchedTotal`。

## 2. `read` 的 `meta.truncation.totalBytes` 是输出大小

**现象.** `details.truncation.totalBytes`（以及 `details.meta.truncation.totalBytes` 里的副本）不是文件大小，而是本页输出的字节数。

**复现.** 读取一个约 61 KB 的文件、输出按预算被截断时，报告 `totalBytes: 1577`，等于 `outputBytes`。在捕获到的
`pipeline.ts:1-5` 分页读取里，载荷在同一方向上自相矛盾：

```json
{
  "truncation": { "truncated": true, "truncatedBy": "lines", "totalLines": 54,
                  "totalBytes": 147, "outputLines": 5, "outputBytes": 147 },
  "fileSize": 1703,
  "meta": { "truncation": { "direction": "head", "nextOffset": 6 } }
}
```

`totalLines: 54` 是正确的，`fileSize: 1703` 是正确的，而 `totalBytes: 147` 恰好就是展示出来的五行。

**绕法.** 续读用 `details.meta.truncation.nextOffset`；永远不要用 `totalBytes` 来定缓冲区或进度条的大小。去重也不读它：
记录以 `stat` 身份（`dev`、`ino`、`size`、`mtimeNs`、`ctimeNs`）为键，不以线上字段为键。

## 3. grep 的 limit 字段：命中时是数字，未命中时不存在

**现象.** `fileLimitReached` 与 `perFileLimitReached` 不是布尔值。上限被触及时，宿主写入上限值；没触及时，键不存在。
恰好落在上限上的结果**不算**被截断：它报 `truncated: false`，并省略两个键。

**复现.** 十个文件、恰好落在上限上的结果：

```json
{ "matchCount": 20, "fileCount": 10, "truncated": false }
```

两个上限同时命中（在 `src` 上搜一个常见 token）：

```json
{ "matchCount": 379, "fileCount": 20, "truncated": true,
  "fileLimitReached": 20, "perFileLimitReached": 20 }
```

**绕法.** 把「存在」或「为真」当作信号；永远不要与 `true` 比较，也永远不要把该值当作计数读。搜索规则对四个标志
（`truncated`、`fileLimitReached`、`perFileLimitReached`、`linesTruncated`）一律用 `Boolean(details[flag])`，去重的闸门
用的是同一个测试。

## 4. `eval` 超时没有 `exitCode`

**现象.** `eval` 的失败载荷是
`{ language, languages, cells: [{ code, language, output, status, exitCode?, durationMs }], isError? }`。
被期限杀掉的 cell 有 `durationMs` 和一行 `[eval cell timed out …]`，但**没有** `exitCode`；内核退出的那行会出现在同一段文本里。
JS worker 退出表现为 `Error: JS eval worker exited with code N`，内核死亡表现为
`[Kernel died during execution; completion is uncertain…]`。

**复现.** 跑一个超过期限的 cell，检查 `details.cells[0]`。`exitCode` 缺失是超时的正常形状，不是 cell 成功的迹象。

**绕法.** 分类按文本哨兵、从最具体到最宽泛排序：`cell timed out` 先于 `eval worker exited with code`，再先于
`kernel died during execution`，最后是 `[kernel] … exited with code`。超时必须赢，因为它的文本里也含内核退出那行。
每一种失败都发布 `RESULT_UNKNOWN`、`effectState: 'unknown'`、`retry: 'never'`：一个 cell 可以在第 1 行写文件、在第 2 行抛异常。
`exitCode` 从不被用作成功的证据。

## 5. 没有面向扩展的 eval prelude API

**现象.** prelude 在 `createAgentSession` 里由四个内建定义拼成，各自受一个宿主设置控制。扩展够不到任何注册槽：

- `grep -a "registerEval" omp.exe` 无命中；注册器名字在二进制里不存在。
- 扩展 API 没有匹配 `/prelude/i` 的成员（实例与原型都查过）；探针输出：`PROBE1 undefined object`——内建的 `browser`
  prelude 已安装，`ops` 是 undefined。
- `pi.registerEvalPrelude(...)`、`pi.registerEvalPreludes([...])`、`pi.extensionData.preludes` 都不存在；模块级
  `export const preludes = [...]` 与包清单里的 `omp.preludes` 能加载，但被忽略。

唯一可行的渠道是 `eval` 工具的 `%load`，它在内核里运行**脚本**，并拒绝 ESM 语法（`Unexpected keyword 'export' at <parse>`）。

**绕法.** `prelude.ts` 对真实宿主返回 `'load-file'`，并发布由 `import.meta.url` 解析出的绝对路径 `OPS_PRELUDE_PATH`。
JS 助手是脚本（无 import、无 export，末尾一个 `globalThis.createOps`）；Python 助手发布 `create_ops`。加载提示只对
`'load-file'` 注册，并且只在一个失败的 cell 提到 SDK 之后出现，所以从不使用 PTC 的会话为此分文不付。
