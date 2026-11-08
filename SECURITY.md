# 安全策略

## 支持范围

- 本仓库的 TypeScript 引擎与插件适配层（`src/**`）
- Python 数据子进程（`python/djiucai_data/**`）
- 本地面板与客户端插件（`static/**`、`src/panel/**`）

## 已知攻击面与当前防护

- **面板 API 路径穿越**：`/api/run/*` 对路径段做白名单校验（对抗审查 F35 修复）。
- **LLM 输出注入**：Agent 输出经 `parseAgentOutput` 严格解析 + clamp；面板渲染统一 HTML 转义（F39 修复）。
- **协议健壮性**：子进程行协议对坏行/超时/崩溃有容错与重启（F31/F37/F33 修复）。
- **零密钥存储**：本插件不存储任何 API key；LLM 凭据由宿主（DSH credentials）或使用方环境变量提供。

## 报告漏洞

请勿在公开 Issue 中披露可利用细节。使用 GitHub Security Advisories（仓库 Security 标签 → Report a vulnerability）私下报告，72 小时内响应。

## 出网声明

插件的全部出网行为已在 [README「出网行为」](./README.md#出网行为必须写明28)逐项列出（行情/情绪/新闻数据源 + 可选 LLM API）。发现未声明的出网即视为安全缺陷，请报告。
