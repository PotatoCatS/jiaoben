# jiaoben

一个**零依赖、纯 Node** 的「脚本管理器」核心引擎：花名册存储、JS/Python 脚本运行、cron 定时、开机补跑、长驻守护、日志管道，以及**收纳管理**（候选扫描 / 收编 / 不收编名单 / 子目录与自动收纳开关 / 分组 / 停用）。从桌宠工程（pet-sq）的脚本管理器功能中抽出，可作为：

- **路线 B（本包本体）**：任意 Node ≥ 22 应用直接 `import` 的引擎库；
- **路线 A（electron/ 适配层）**：Electron 应用的即插即用功能插件（IPC 注册 + preload 桥 + 普通窗口款面板 UI）。

```
src/
  scripts.mjs    核心引擎：花名册存储 + 运行器 + 调度器 + cron 解析（零依赖）
  examples.mjs   示例库存储（用户自己的脚本收藏夹）
  index.mjs      统一出口
electron/        路线 A：Electron 适配层（ipc.mjs / preload / ui 面板）
demo/            路线 A：最小 Electron 演示应用
```

## 快速开始（路线 B：纯 Node）

```js
import { createScriptsStore, createScriptRunner, createScriptScheduler, detectPython } from 'jiaoben'

const dataDir = './data' // 数据目录：花名册与调度心跳存在这里
const log = (msg) => console.log('[jiaoben] ' + msg)

const store = createScriptsStore({ dataDir, log })
store.setDir('D:/我的脚本') // 用户自选脚本目录，脚本文件本体放这里
store.rescan()              // 把目录里已有的 .js/.py 收编进花名册

const runner = createScriptRunner({
  store,
  sendLog: (batch) => { /* 把批量日志推给你的 UI */ },
  getPython: () => null, // 或检测结果；null = 禁用 .py 运行
  log,
})

const scheduler = createScriptScheduler({
  store,
  runner,
  dataDir,
  log,
  ready: () => Promise.resolve(), // 宿主就绪后返回的 Promise，就绪前不启动脚本
})
scheduler.start()   // 随启动 / 定时 / 长驻 / 开机补跑 全部开始工作
// 宿主退出前：
//   await runner.stopAll()  杀光所有脚本子进程
//   scheduler.stop()
```

## 引擎接口契约

### createScriptsStore({ dataDir, log }) → 花名册存储

数据落盘 `dataDir/scripts.json`，原子写（`.tmp-<pid>` 写完再 rename）。只存**元数据**（id / 名字 / 文件名 / 语言 / 定时配置），脚本文件本体在用户选的脚本目录里，宿主不碰文件内容。

| 方法 | 行为 |
|---|---|
| `read()` | 读花名册 → `{ dir, items, excluded, pythonPath, groups, opts }`（文件坏掉时返回空花名册，不抛；老版本文件自动补齐新字段默认值） |
| `setDir(dir)` | 换脚本目录；`excluded`（不收编名单）跟着作废 |
| `save(input)` | 新建/更新条目。名字空、撞文件名、超 100 个会被拒；同 id 更新保留 createdAt；**没传的可选字段（如 enabled/group）沿用旧值**，不会被默认值冲掉 |
| `remove(id, deleteFile)` | 删条目；`deleteFile=true` 连文件删，`false` 只移出花名册（文件名进 excluded，防 rescan 捡回） |
| `rescan()` | 目录对账（内部调 `scanCandidates()`）：收编一级（或开子目录收纳后递归）的 .js/.py 新文件（大小写不敏感去重）；旧条目「找不到文件」不自动删 |
| `scanCandidates()` | 对账目录：返回「花名册没有 + 名单里没有」的候选清单 `{ ok, deep, candidates:[{ path, file, lang, rel }] }`。子目录收纳开关打开时递归、否则只看一级 |
| `adopt(files)` | 把候选文件登记进花名册，返回 `{ ok, added:[...], failed:[{file, error}] }`（单个失败不影响其他）；支持带相对路径的子目录文件（`file` 字段存相对路径）；已登记 / 名单里的文件重复收编会被跳过或放行 |
| `ignore(files)` | 把文件名加进 `excluded[]`（不收编名单） |
| `unexclude(file)` | 从名单移除（「恢复收纳」） |
| `listExcluded()` | 返回名单数组 |
| `setDeepAdopt(on)` / `setAutoAdopt(on)` | 两个开关落盘（`opts: { deepAdopt, autoAdopt }`，默认都关） |
| `groupCreate(name)` / `groupRename(id, name)` / `groupRemove(id)` / `groupMove(scriptId, groupId)` | 分组增删改移（名字 60 字符内、大小写不敏感去重；删分组时组内脚本 group 归 null；groupId 为 null = 未分组） |
| `setEnabled(id, on)` | 停用/启用（默认 true）；停用**只拦自动运行**（定时/补跑/随启动/长驻），手动 `runOne` 不拦；停用瞬间先停掉该脚本的长驻实例 |
| `clone(id)` | 复制文件生成「xxx 副本.js」（撞名自动加 2、3…）并登记 |
| `rename(id, newBase)` | 磁盘真改名 + 花名册同步（扩展名可带可不带；非法字符/撞名被拒） |
| `importFile(src)` | 把任意路径的 .js/.py 复制进脚本目录一级并登记，撞名加序号不覆盖 |
| `setPythonPath(p)` / `clearPythonPath()` | 自填 Python 解释器路径的落盘（**验证不在这里**，宿主先 probePython 过了再存） |

条目字段：`id, name, file, lang('js'|'py'), cron, cronCatchUp, onStartup, daemon, closeAfterRun, group, enabled, createdAt, updatedAt`。

### createScriptRunner({ store, sendLog, getPython, log }) → 运行器

每个脚本单独 spawn 子进程，和宿主隔离：

- **JS** → `process.execPath` + `ELECTRON_RUN_AS_NODE=1`（Electron 宿主里用内置 Node，不依赖用户装 Node）；
- **Python** → `getPython()` 返回 `[cmd, ...args]`（如 `['py','-3']`），自动设 `PYTHONIOENCODING=utf-8`；返回 `null` 时拒绝跑 .py；
- cwd = 脚本目录（脚本里的相对路径能找到旁边的文件）；
- **日志管道**：攒 100ms 批量 `sendLog(batch)`（脚本狂 print 不会刷爆 IPC），同时给每个脚本留 500 行环形缓冲。

| 方法 | 行为 |
|---|---|
| `runOne(item, dir, opts)` | 跑一个实例，返回 `{ok, inst}`。opts：`intent`（manual/startup/daemon/cron）、`label`（覆盖启动行标签）、`timeoutMs>0`（到点强杀）、`onExit(info)`（仅 daemon 由调度器挂） |
| `stop(id, instId?)` | 停止；Windows 上 `taskkill /T /F` 杀**整个进程树**（脚本自己开的子进程一起带走）。instId 不给则停全部实例 |
| `stopAll()` | 宿主退出前调用，杀掉所有在跑子进程，返回 Promise |
| `history(id)` | 拉环形缓冲（面板关着也能补历史） |
| `status()` | `{ [scriptId]: [{inst, startedAt, exitRequested, pid}] }` |
| `running()` | 运行表的 Map 本体（调度器/宿主查活口用） |
| `sysLine(id, text)` | 往某脚本日志插一条系统行（如「文件不存在，定时未启动」） |

### createScriptScheduler({ store, runner, dataDir, log, ready }) → 调度器

- **tick**：每秒一次，只在「分钟数变化」的瞬间检查 cron，一分钟最多触发一次；防重表只留最近 5 分钟。心跳 `lastMinute` 落盘 `dataDir/scripts-schedule.json`（原子写）。
- **开机补跑**：重启时按心跳算错过多少分钟。gap ≤ 1 不补（同分钟重启）；> 7 天放弃；中间这段对勾了 `cronCatchUp` 的脚本，补跑错过的**最后一次**触发点（日志标「开机补跑」）。
- **随启动**：等 `ready()` 落定（最多 3 秒）后，`daemon` 脚本以长驻启动，普通 `onStartup` 脚本跑一次。
- **长驻守护**：daemon 实例意外退出（非用户停止）→ 1 秒后自动拉起；**30 秒窗口内崩 3 次** → 停止自动拉起并标红。
- **停用跳过**：`enabled === false` 的脚本，定时 / 开机补跑 / 随启动 / 长驻拉起四个自动环节全部跳过（手动 `runOne` 不拦）。
- **自动收纳轮询**：构造参数可给 `autoAdoptMs`（默认 0 = 关）与 `onAdopt(added)` 回调。开关（`store.setAutoAdopt(true)`）打开后每 30 秒扫一次候选，有新文件自动 `adopt()` 并回调通知（如「自动收纳 N 个新脚本」）。选轮询不选文件监听：Windows 上 `fs.watch` 对拖入文件、编辑器保存的事件不可靠，30 秒一次 readdir 零坑。
- `start()` / `stop()`；`getAlarm(id)` 返回标红文案或 null；`clearAlarm(id)` 清报警。

### cron（自写解析器，不引依赖）

5 字段（分 时 日 月 周），支持 `*` `,` `-` `*/N` 和单值。两条语义约定：

- **日和周同时受限按「或」**——任一匹配就触发（经典 cron 语义）；
- **无解表达式快速失败**（如 `0 0 30 2 *`）——算下次运行时直接报「没有有效时间」，不空转四年。

```js
import { parseCron, cronNext, cronMatchesMinute, cronNextParsed } from 'jiaoben'

parseCron('*/5 9-17 * * 1-5')   // → {ok:true, min:[...], hour:[...], ...} 或 {ok:false, error}
cronNext('0 0 * * *', Date.now())     // → {ok:true, time} 下次触发时间戳（ms）
cronMatchesMinute(parsed, ms)         // 某分钟是否命中（调度器每秒 tick 用）
cronNextParsed(parsed, fromMs)        // 已解析结果直接算，省重复解析
```

周字段 `7` 会归一成 `0`（都表示周日）；回绕写法（`5-2`）、步长 0、超范围、字段数不对都直接报错，错误文案可直接给用户看。

### Python 探测

```js
import { detectPython, probePython, langOf } from 'jiaoben'

detectPython({ log })  // 按 py -3 → py → python 顺序，以「能打印版本号」为准
                       // → {ok:true, cmd, args, version} 或 {ok:false}
probePython('C:/Python/python.exe') // 自填路径验证：--version 打得出来才算数
langOf('a.py')                      // 'py'；其它一律 'js'
```

### createExamplesStore({ dataDir, log }) → 示例库

用户自己的脚本样例收藏夹：`dataDir/examples/` 放文件本体，`examples.json` 只存元数据。`list()` / `readCode(id)` / `create(input, {autoRename})` / `update(id, input)` / `remove(id)`。

## 行为约定（读代码前先看这里）

1. **停止永远有效**：停止 = 杀进程树，不是「发信号请它退出」。
2. **手动跑的实例挂掉不自动拉起**——只有 intent=daemon 的实例挂了才拉起，且靠 `exitRequested` 标记区分「人停的」和「崩的」。
3. **定时运行 10 分钟封顶**，到点强杀，防脚本死循环拖累宿主。
4. **脚本文件不存在时**：手动运行报错、定时/补跑在日志里插一行「⚠ 文件不存在」说明，不崩调度器。
5. **换目录 = 换地盘**：excluded 名单、调度心跳都不跨目录迁移；心跳在 `dataDir` 下所以换目录不影响补跑判定。
6. **停用只拦自动**：`enabled=false` 只暂停定时/补跑/随启动/长驻，手动运行不拦；停用瞬间先停掉该脚本的长驻实例（不留半死进程）。
7. **待收纳清单不落盘**：候选 =「目录 vs 花名册 vs 名单」三者对账的临时视图，每次现算，天然不会脏。
8. **引擎对宿主零硬耦合**：只有 `dataDir / log / sendLog / getPython` 四个注入点，其余全是 Node 内置模块。

## 开发与测试

```bash
npm test            # node --test test/（cron 纯函数 + store + runner + scheduler 集成）
node --check src/scripts.mjs src/examples.mjs src/index.mjs
```

测试要点：日期断言一律用**本地时间**构造（`new Date(y, m-1, d, h, mi)`），调度器测试靠「种心跳文件」伪造 lastMinute 来控制时间线，全部用真实子进程短等待验证。

## 路线 A：Electron 插件（electron/ 目录）

- `electron/ipc.mjs`：`registerJiaobenIpc({ ipcMain, dialog, shell, ... })`，把引擎能力接成 `jb:*` 频道的 IPC 处理器；
- `electron/preload.cjs`：`window.jiaoben` 桥（contextBridge）；
- `electron/ui/panel.mjs` + `panel.css`：普通窗口款脚本管理器面板（可嵌进任何 Electron 应用的窗口里）；
- `demo/`：最小可跑演示（改 demo/main.js 里的数据目录即可体验）。

具体用法见 `demo/README.md`（随路线 A 交付）。

## 版本历史

- **0.1.1**：收纳管理——候选扫描 `scanCandidates` / 收编 `adopt` / 不收编名单 `ignore`/`unexclude`/`listExcluded` / 子目录与自动收纳开关 / 分组增删改移 / 停用（只停自动）；调度器停用跳过 + 30 秒自动收纳轮询；面板收纳管理 UI（清单/名单/开关/分组视图/搜索排序/批量/停用）；14 条收纳测试，`npm test` 74/74。
- **0.1.0**：引擎层从桌宠工程抽出（花名册存储、运行器、调度器、cron 解析、示例库），带 60 条测试。
