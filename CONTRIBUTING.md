# 贡献指南

感谢关注韭菜军团！这是一个 A 股散户群体博弈模拟沙盘（DeepSeek Harness 插件）。

## 开发环境

```sh
npm install                                # Node ≥20（宿主内运行需 DSH 要求的 ≥24.9）
python3 -m venv .venv && .venv/bin/pip install -r python/requirements.txt
npm run build && npx vitest run            # 引擎构建 + 测试（零网络）
.venv/bin/python -m pytest python/tests -q # 数据子进程测试（fixture 驱动，零网络）
```

## 约定

- **需求文档是宪法**：`韭菜军团需求文档.md` 记录了逐条编号的设计决策（#1–#57）。行为改动请先对齐文档，必要时在文末追加新决策编号并说明理由。
- **分层铁律**：`src/engine/**` 不依赖 DSH；宿主能力经 `src/host/ports.ts` 端口注入。新代码请保持这条边界。
- **测试**：行为改动必须带配套测试（vitest 在 `tests/`、pytest 在 `python/tests/`，全部零网络、fixture 驱动）。
- **提交**：Conventional Commits（`feat:` / `fix:` / `docs:` / `chore:`）。

## 提交前自检

1. `npx tsc -p tsconfig.json --noEmit` 零错误
2. `npx vitest run` 与 `.venv/bin/python -m pytest python/tests -q` 全绿
3. 不引入新的出网行为（README「出网行为」表需要同步更新）
4. 模拟沙盘相关输出保留免责声明

## 行为优化的建议流程

对 Agent 心理/群体动力学有想法？欢迎开 Issue 讨论——用学科视角（行为经济学/社会心理学）提出机制级设计，比「调参」更容易被采纳。
