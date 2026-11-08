# Changelog

本项目的所有显著变更记录于此文件。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.1.0] - 2026-11-06

### Added
- M0 引擎核：30 Agent 人设池（三维矩阵 + 立场先验 + 行为偏差 + 游资纪律）、标量情绪引擎、记忆与风格漂移度量、分层信息集（含军团上轮倾向回流）、并发编排（重试/部分失败下限）、净流聚合（资金加权 × 游资放大 × 置信度调仓）、冲击映射（一期未校准）、预测模式（第 1 日 K=5 + 第 2–5 日 K=1 递推）、沙盘模式（外生冻结 + 衰减、无价格侧阻尼）、what-if 事件卡（定向注入 + 线性衰减）、总编日报（map-reduce）、对账（双 horizon + 平局剔除）。
- M1 面板：三视图本地面板（预测/沙盘回放/军团档案卡与漂移曲线）、Plan B 静态输出。
- M0 数据子进程：Python（akshare 主 + baostock 交叉校验）、交易日历、情绪/新闻双源冗余、市场宽度指标、分级降级、本地缓存、Asia/Shanghai 固定时区。
- DSH 插件适配层：防御性 API 探测 + Plan B（斜杠命令 Markdown 日报）。
- 产品层：README、MIT LICENSE、CHANGELOG、常驻免责声明。
- 2026-11-06 对抗审查修复（10 组）：5 日对账累计口径（F5）、DSH 沙盘天数参数（F13）、反馈时序与记忆方向结算（F16/F24）、降级期不伪造炸板率（F23）、子进程崩溃恢复竞态（F31/F37）、NaN 协议隔离（F33）、面板 API 路径穿越防护（F35）、沙盘新鲜度硬失败（F25）、预测单轮作废口径（F28）、事件卡确定性可见性（F36）等；新增 `scripts/data_smoke.py` 数据探针。
- 2026-11-07 三专家行为科学迭代（需求文档 v1.3，#53 起）：意见气候块（分风格/资金加权双轨/感知噪声/跨运行注入）、记忆方向结算与置信度校准、情绪惯性（λ 残留 + 负面不对称）、偏差情境点火、社会镜像精度（署名/权重份额/集中度传闻）。
- 2026-11-07 数据流全量分析修复（10 项）：资金面接入 Agent 信息集（per-field asOf）、情绪热度量纲标注、沙盘宽度衰减（F4）、对账账本双路径保全（F20）、mock 运行打标与命中率隔离（F21）、免责声明覆盖全部命令（F1）、沙盘内生推演标注强制（F2）、死旋钮清理（F9）等。
- 2026-11-07 **DSH 宿主装载实测通过**（DSH 0.2.2-rc.1 + Node 24.22.2）：适配层按真实 cordis 契约重写——`dsh.bundle.patch` 指向新增的 `cordis.patch.yml`、插件函数声明 `inject: ['llm','subprocess','commands']`、命令经 `ctx.commands.register` 注册为 CommandDefinition、LLM 经 `ctx.llm.stream(GenerateOptions)`；headless 启动挂载成功并注册 8/8 命令。
- 2026-11-07 **DSH 原生客户端面板（C1–C6 六轮）**：
  - C1 `package.json` 增 exports 三键（`.` / `./package.json` / `./client`）与 `dsh.client {platform:"web", inject:[]}`——client-modules 装载清单（注意与 dist/client.js 同批落地的重启耦合，见 README）。
  - C2 esbuild 客户端构建链：`scripts/build-client.mjs`（external=官方种子词快照 11 项）、tsconfig exclude 增 `src/panel`、scripts 增 `build:client` 并版 `build`；产物头尾按官方 `window.__ModuleLoader__.load({id:…})` 协议。
  - C3 `src/panel/` 三视图 React 化（预测/沙盘/军团与设置）：侧栏入口（`sidebar.panellist`，PanelIcon 收 `{size,active}`）+ 主面板（`main` 槽位，key 与侧栏 id 同值）、locale 字典经 `ctx.effect` 注册、CSS 经 factory 体内 `<style data-plugin>` 注入（卸载由 loader 按 `data-plugin` 摘除）。
  - C4 数据通道：面板数据一律绝对 URL `http://127.0.0.1:3210/api/…`（DSH origin 内相对路径全 404）；panel-server 加 CORS 头（ACAO:* + OPTIONS 预检冗余）；CSP 实测放行（页内 fetch :3210 → 200、零 violation），CORS 路线成立。
  - C5 端到端回归（基线留档 `/tmp/dsh-web.baseline.log`）：重启后日志门三类错误 0、基线前 3 行逐字一致（9/9 命令与 :3210 不受影响）；浏览器验证 `__DSH_BOOT__.entries` 含本插件行、`/plugins/??dsh-jiucai-legion/client.js&rev=…` 200、侧栏切换、CSP 探针全绿；HMR 热更实测（重建后约 1s 内页面 style 内容更新且无整页刷新）。
  - C6 双路径与风险留档（README「DSH 原生客户端面板」节：种子词快照 drift、exports 深导入限制、重启耦合、HMR 行为）。

### Fixed
- e2e 终验链补全（init→predict→sandbox→reconcile→report 全链）与 dist 产物重建时点（对抗审查 P1-P3）。

### 已知限制
- 冲击系数为一期未校准默认值（k=0.8，预测输出与面板明示）。
- 情绪/新闻榜为点态快照，无历史回补能力，冷启动期 Agent 情绪上下文从首跑日积累。
- DSH 命令注册/设置卡片/client bundle 的确切签名需在 DSH ≥ Node 24.9 环境首日装载验证（本仓库单测覆盖适配层逻辑）。
- 雪球情绪源上游断供（需 cookie）期间由东财人气榜备源承担，热度量纲不同（已随值标注）。
- client bundle 的 external 种子表是 `dsh-web-frontend` 当前 minified 产物快照（`YZ()`），DSH 升级增减种子词时按运行时 drift 报错点名的 specifier 补 external（详见 README「DSH 原生客户端面板」节）。
- 插件停用/复用时 panel-server 句柄不随插件卸载关闭（`dsh-adapter.startPanel` 无 dispose），第二次实例化递增端口到 :3211；重启 DSH 恢复单实例 :3210（2026-11-07 实测记录，待后续迭代修复）。
- 插件管理器里仅停用插件不卸载 client 模块（浏览器内 style 标签与侧栏入口驻留，parked 语义）；组合图级卸载以「停用 + 刷新页面」为准（entry/style/侧栏全部消失，复启恢复，2026-11-07 实测记录）。
