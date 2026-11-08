// 韭菜军团 client 半入口（C3：侧栏菜单项 + 主面板两件套）。
// 范本（官方实读）：
//   - apply 两件套 + locale effect：dsh-client-ui-plugin-manager/lib/client.js:7699-7826
//   - main 最简注册：dsh-client-ui-conversation/lib/client.js:23102-23106（{name,key} 形）
//   - 侧栏 PanelIcon 收 {size,active}：dsh-client-ui-sidebar/lib/client.js:226-231
//   - key 与侧栏 id 必须同值，否则 layout.selectPanel throw（dsh-client-ui-layout/lib/client.js:523）
// external 契约：本树只 require 种子词（react / react/jsx-runtime）；引入任何非种子
// require（含 @deepseek-ai/dsh-client-locale 包本身）须同步 package.json dsh.client
// 与 scripts/build-client.mjs external 两处，否则运行时 build-time externals drift。
import { PANEL_CSS } from './styles';
import { PanelIcon, PanelPage } from './components';

/** 依赖的宿主服务（对照 plugin-manager/lib/client.js:7688-7693 的 inject 声明）。 */
export const inject = ['slots', 'locale', 'layout'];

// —— CSS 注入（factory 体内，factory 外零副作用）：迁移自官方头形
// （dsh-client-ui-sidebar/lib/client.js:33-40）。卸载清理由 loader 的
// removeOwnedStyles 按 data-plugin 属性摘除（dsh-client-modules/lib/client.js:308-312）。
const CSS_TAG = 'dsh-jiucai-legion/panel';
if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_TAG}"]`) === null) {
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-jiucai-legion';
  tag.dataset.pluginCss = CSS_TAG;
  tag.textContent = PANEL_CSS;
  document.head.appendChild(tag);
}

const NS = 'jiucaiLegion';

/** 打开菜单界面时注册侧栏入口 + 主面板（两件套）。 */
export function apply(ctx: {
  slots: {
    inject: (slot: string, factory: () => unknown) => unknown;
    register: (meta: Record<string, unknown>, comp: unknown) => unknown;
  };
  locale: { register: (ns: string, dict: Record<string, Record<string, string>>) => unknown };
  effect: (fn: () => unknown, label?: string) => unknown;
}): void {
  // locale 字典（范本 plugin-manager:7700-7708 ctx.effect(() => ctx.locale.register(NS,{zh:{…}}),'…')）
  ctx.effect(
    () => ctx.locale.register(NS, {
      zh: { panel: '韭菜军团', viewPred: '预测页', viewSandbox: '沙盘页', viewLegion: '军团与设置' },
    }),
    'jiucai-legion: dictionaries',
  );

  // 侧栏入口：PanelIcon 收 {size, active}；order:50 让位于官方面板；
  // label 字面量与 locale 并存（resolveSlotLabel 两种路径均覆盖，评审确认）。
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: 'jiucai-legion',
        order: 50,
        label: () => '韭菜军团',
        locale: NS,
      },
      PanelIcon,
    ),
  );

  // 主面板：generator 形（范本 conversation:23102 / plugin-manager:7744）；
  // key 必须 === 侧栏 id 'jiucai-legion'。
  ctx.slots.inject('main', function* () {
    yield ctx.slots.register({ name: 'main', key: 'jiucai-legion', locale: NS }, PanelPage);
  });
}
