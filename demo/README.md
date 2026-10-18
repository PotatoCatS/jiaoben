# jiaoben 演示应用（路线 A）

一个最小 Electron 宿主，演示怎么把 jiaoben 面板嵌进**普通窗口**：

- `main.js` —— 建窗口 + 注册 `jb:*` IPC + 启动引擎 + 退出时收掉脚本子进程；
- `app.html` —— 一个按钮 + 一个容器 div，调用 `mountJiaobenPanel(root)` 挂面板；
- `data\` —— 运行时数据目录（花名册 / 调度心跳 / 示例库），已 gitignore。

## 跑起来

用任意工程里的 electron 二进制（本仓库不装 electron，把它当纯库）：

```
E:\Scode\pet-sq\node_modules\.bin\electron.cmd E:\Scode\jiaoben\demo\main.js
```

环境变量：

- `JB_DATA` —— 换数据目录（默认 `demo\data`），想干净重来就删掉目录或换个路径。

## 面板能干什么

打开后点「选择脚本目录」，之后就是完整功能：新建/编辑/保存、运行/停止、日志、导入本地文件、粘贴代码保存、克隆/重命名/删除、定时/开机补跑/随启动/长驻、Python 解释器管理、示例库、在 VS Code 中打开。

## 接入你自己的应用（三行）

```js
// main 进程
import { registerJiaobenIpc } from 'jiaoben/electron'
const jb = registerJiaobenIpc({
  ipcMain, dialog, shell, clipboard,
  dataDir: '你的数据目录',
  send: (channel, payload) => win.webContents.send(channel, payload),
  getWindow: () => win,
})
app.whenReady().then(() => jb.start())          // 引擎 + 调度器开工
app.on('will-quit', (e) => { e.preventDefault(); jb.stopAll().finally(() => app.quit()) })
```

```js
// 渲染进程（页面里给面板一个容器即可）
import { mountJiaobenPanel } from 'jiaoben/electron/ui/panel'
import 'jiaoben/electron/ui/panel.css'
mountJiaobenPanel(document.getElementById('容器'), { onClose: () => {} })
```

preload 用 `jiaoben/electron/preload`（暴露 `window.jiaoben` 桥）。
