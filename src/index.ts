/**
 * 韭菜军团 — DSH 插件入口（需求 #1）。
 *
 * 真实 cordis 插件契约（2026-11-07 首日装载验证确定）：
 * - 插件 = 一个函数，带可选的 `inject` 字段（声明依赖的服务键）与 `apply(ctx)`；
 * - **default 导出**是 DSH bundle patch（cordis.patch.yml → name: 'dsh-jiucai-legion'）
 *   解析的目标——真实宿主里 ctx 是惰性服务代理，只能读 inject 声明过的键；
 * - package.json 的 `dsh.bundle.patch` 指向 ./cordis.patch.yml（bundle 层清单）。
 */
import { activatePlugin, type InjectedServices } from './host/dsh-adapter.js';

export const name = 'dsh-jiucai-legion';

/** cordis 插件函数：inject 声明依赖 → ctx 上才允许读这些键（缺一即抛，宁缺勿探） */
export function plugin(ctx: InjectedServices): void {
  activatePlugin(ctx);
}
// cordis 读取函数上的 inject 字段来解析依赖（等待服务就绪后才执行 apply）
(plugin as { inject?: string[] }).inject = ['llm', 'subprocess', 'commands'];

export function apply(ctx: InjectedServices): void {
  plugin(ctx);
}

export default plugin;
