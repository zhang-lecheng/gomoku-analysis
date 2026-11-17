# 落点 · 五子棋分析

一个静态网页中的 15 路自由规则五子棋局面分析器。Rapfi 和网络权重在浏览器内运行；棋局不发送到服务器。支持摆子、指定行棋方、候选变化预览、撤销、分享链接和 JSON 导入/导出。搜索结果是引擎评估，随时间、线程及硬件变化，并非局面已被数学证明。

## 使用

用现代浏览器打开通过 HTTP(S) 提供的页面。首次加载需要下载约 10 MB 网络权重和 WebAssembly 文件，并需要支持 WebAssembly SIMD。不要直接双击 `index.html`：浏览器通常限制 `file://` 下的 Worker 和资源加载。可在本目录执行 `python3 -m http.server 8000`，再打开 `http://localhost:8000/`。

示例局面黑白各七子、黑棋走。点击棋盘摆子，选择黑、白、交替或擦除，并在「下一手」指定实际行棋方。点击「开始分析」，候选行可打开逐步变化预览；修改局面会清除旧分析。「停止」会终止并重新初始化工作线程。正分有利于当前行棋方。`M` 值以半手（ply）为单位：`M+35` 表示引擎认为 35 个半手（约 18 个己方着手）内取胜，它是搜索树内的裁定，不是穷举证明。

分享链接包含完整棋子与行棋方，不包含分析；JSON 格式为 `{"version":1,"black":["F10"],"white":["K8"],"side":"black"}`。坐标左下角是 A1；内部引擎坐标为左上角 `(0,0)`，因此 A1 = `(0,14)`，F11 = `(5,4)`。导入会检查坐标范围和重复点。任意编辑局面可能包含非正常对局顺序，适配器需要插入虚手来表达颜色和行棋方；这可能影响依赖历史的搜索。

线程数取决于浏览器的跨源隔离和 SharedArrayBuffer 支持。随附的 service worker 可在 HTTPS 或 localhost 上为同源静态资源提供隔离，并可能在首次安装后刷新页面；若不可用则使用单线程。长时分析有 24 小时上限；关闭页面会停止计算。

## GitHub Pages 部署

1. 将本目录全部内容提交到 GitHub 仓库的 `main` 分支（包括 `.github/workflows/pages.yml`、`engine/` 和 service worker）。不要遗漏 `.wasm` 和 `.data`。
2. 在仓库 Settings → Pages 中将构建来源设为 **GitHub Actions**。推送到 `main` 或手动运行 Actions 中的 Deploy static site 工作流。
3. 工作流成功后打开 Pages 给出的 URL。资源使用相对路径，适合项目子路径。该仓库包本身不会自动创建 GitHub 仓库或发布站点。

## 收敛与可复现性

搜索以「目标深度」为主停止条件，时间只作上限。到达目标深度时，同一局面、同一设置在任何设备上都应给出同一组节点数、深度与分数；显示「被时间截断」时结果取决于机器快慢。每次分析前都会发送 `YXHASHCLEAR`：引擎的 `YXBOARD` 会重建棋盘但保留置换表，不清理的话第二次分析会接着上一次的哈希继续搜，同一设置的分数会变。

示例局面（见 `TEST_RESULTS.md`）在单线程下需要约 439 万节点、30 层才能稳定给出 `F11 M+35`；15 秒的冷启动只到约 54 万节点、20 层，给出 `+577` 而不是胜负距离，因此该预设只适合快速浏览。多线程使用根并行，结果不保证与单线程一致，也不保证可复现。

## 引擎、构建与许可

本项目整体以 GPL-3.0-or-later 发布（见根目录 `LICENSE`），因为它捆绑并驱动 Rapfi。实际运行的是 Rapfi `1387d11312190ec66665d361ff07a7c70221b78a` 与网络仓库 `7eeb19b55219a48138756293f92211a1539bab4d` 的固定版本，不是模拟搜索。`engine/rapfi-source.tar.gz` 包含对应源代码与构建修改；参见 [engine/SOURCE.md](engine/SOURCE.md)、[ENGINE_API.md](ENGINE_API.md) 及 `build-engine.sh`。Rapfi 使用 GPL-3.0-or-later，随附 [许可文本](engine/COPYING.txt)；网络权重使用 CC0，见 [网络许可](engine/NETWORK_LICENSE.txt)。

验证记录、运行条件和限制见 [TEST_RESULTS.md](TEST_RESULTS.md)。
