// 韭菜军团侧栏面板（首版 stub，C3 接入预测/沙盘/军团档案三视图）。
// 两条 react 通道都保留：主面板体走 createElement（react 种子词），
// 空态子组件走 JSX automatic runtime（react/jsx-runtime 种子词）——
// 与官方 client 半产物一致（如 dsh-client-ui-sidebar 同时 require 两者）。
import { createElement } from 'react';

/** 空态视图：C3 接入真实数据前的占位（JSX 通道样例）。 */
export function EmptyState() {
  return <p className="jiucai-legion-empty">数据加载中……</p>;
}

/** 侧栏面板首版 stub：标题 + 占位文案。 */
export function LegionPanel() {
  return createElement(
    'section',
    { className: 'jiucai-legion-panel' },
    createElement('h3', null, '韭菜军团 · 模拟沙盘'),
    createElement(EmptyState),
  );
}
