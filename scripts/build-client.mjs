// 韭菜军团 client 半构建：esbuild 打包 src/panel → dist/client.js（C2 构建链）。
//
// 产物契约（dsh-client-modules 宿主协议，与官方 dsh-client-ui-* 包头尾一致）：
//   banner 声明 window.__ModuleLoader__.load({ id, factory }) —— id 必须等于包名
//   "dsh-jiucai-legion"，否则 loader arrive() 报 "loaded without registering"；
//   factory(require) 内是 esbuild 的 CJS 输出体；footer 返回 module.exports。
//
// external 必须是官方种子词全集（dsh-web-frontend dist 的 YZ() 种子表，逐词核对）：
//   运行时 require 命中种子表或已注册模块；引入任何非种子 require 须同步本表与
//   package.json dsh.client 声明两处，否则运行时报 "build-time externals drift"。
import { build } from 'esbuild';

// 种子词全集：与 dsh-web-frontend YZ() 一一对应，精确到子路径。
const externals = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
];

// banner 单行形（与官方包语义一致，验收按此字面 grep 头部）：
const banner =
  'window.__ModuleLoader__.load({id:"dsh-jiucai-legion", factory:(require)=>{var module={exports:{}};var exports=module.exports;Object.defineProperty(exports,Symbol.toStringTag,{value:"Module"});';

const footer = 'return module.exports;\n}});';

const result = await build({
  entryPoints: ['src/panel/client.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  outfile: 'dist/client.js',
  sourcemap: true,
  // 面板树用 JSX（automatic runtime → require("react/jsx-runtime")），
  // 主面板体用 createElement（require("react")）——两条 react 通道都保留。
  jsx: 'automatic',
  external: externals,
  banner: { js: banner },
  footer: { js: footer },
  logLevel: 'info',
});

if (result.errors.length > 0) {
  console.error('client bundle 构建失败');
  process.exit(1);
}
console.log('client bundle 构建完成: dist/client.js');
