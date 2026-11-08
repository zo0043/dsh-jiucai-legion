// 韭菜军团面板样式（C3）：迁移自 static/panel.html 的 <style>，
// 全部选择器加 .jcl- 前缀收拢在面板根类下，避免污染 DSH 宿主 UI；
// 颜色变量改为 --jcl-* 局部作用域（panel.html 用的是 :root 全局）。
// 注入方式见 client.ts（factory 体内 <style data-plugin> 标签，卸载由 loader 清理）。
export const PANEL_CSS = `
.jcl-root{color:#d7dce6;font:14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;--jcl-card:#181b22;--jcl-line:#262b36;--jcl-dim:#8b93a3;--jcl-green:#4ade80;--jcl-red:#f87171;--jcl-amber:#fbbf24;--jcl-accent:#7dd3fc;max-width:1100px;margin:0 auto;padding:16px}
.jcl-tabs{display:flex;gap:8px;margin-bottom:14px}
.jcl-tabs button{background:var(--jcl-card);color:#d7dce6;border:1px solid var(--jcl-line);padding:6px 14px;border-radius:8px;cursor:pointer}
.jcl-tabs button.on{background:var(--jcl-accent);color:#0b0d10;border-color:var(--jcl-accent);font-weight:600}
.jcl-card{background:var(--jcl-card);border:1px solid var(--jcl-line);border-radius:12px;padding:16px;margin-bottom:16px}
.jcl-card h3{font-size:14px;color:var(--jcl-dim);margin:0 0 10px;font-weight:600}
.jcl-row{display:flex;gap:16px;flex-wrap:wrap}
.jcl-row>.jcl-card{flex:1;min-width:280px}
.jcl-big{font-size:34px;font-weight:700}
.jcl-green{color:var(--jcl-green)}
.jcl-red{color:var(--jcl-red)}
.jcl-amber{color:var(--jcl-amber)}
.jcl-dim{color:var(--jcl-dim)}
.jcl-banner{padding:10px 16px;border-radius:10px;background:#13202b;border:1px solid #1e3a4c;margin-bottom:16px}
.jcl-warn{padding:10px 16px;border-radius:10px;background:#2a2113;border:1px solid #4c3a1e;margin-bottom:16px}
.jcl-root select,.jcl-root input[type=range]{accent-color:var(--jcl-accent)}
.jcl-root select{background:#0d0f13;color:#d7dce6;border:1px solid var(--jcl-line);border-radius:8px;padding:6px 10px}
.jcl-act{background:var(--jcl-accent);color:#0b0d10;border:none;border-radius:8px;padding:6px 14px;cursor:pointer;font-weight:600}
.jcl-ghost{background:var(--jcl-card);color:#d7dce6;border:1px solid var(--jcl-line);border-radius:8px;padding:6px 14px;cursor:pointer}
.jcl-quote{border-left:3px solid var(--jcl-accent);padding:6px 10px;margin:8px 0;background:#131720;border-radius:0 8px 8px 0;font-size:13px}
.jcl-md h1{font-size:18px;margin:10px 0 6px}
.jcl-md h2{font-size:16px;margin:10px 0 4px}
.jcl-md li{margin-left:18px}
.jcl-md p{margin:6px 0}
.jcl-md strong{color:var(--jcl-accent)}
.jcl-feed{max-height:320px;overflow-y:auto}
.jcl-item{padding:6px 10px;border-bottom:1px solid var(--jcl-line);font-size:13px}
.jcl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.jcl-pcard{background:#131720;border:1px solid var(--jcl-line);border-radius:10px;padding:10px;cursor:pointer}
.jcl-pcard:hover{border-color:var(--jcl-accent)}
.jcl-nm{font-weight:600}
.jcl-meta{color:var(--jcl-dim);font-size:12px}
.jcl-kv{color:var(--jcl-dim);font-size:12px}
.jcl-light{display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--jcl-green);margin-right:6px}
.jcl-light.jcl-light-warn{background:var(--jcl-amber)}
.jcl-modal{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:60}
.jcl-inner{background:#181b22;border:1px solid #262b36;border-radius:14px;max-width:640px;width:92%;max-height:84vh;overflow-y:auto;padding:20px;color:#d7dce6}
.jcl-root table{width:100%;border-collapse:collapse;font-size:13px}
.jcl-root td,.jcl-root th{padding:5px 8px;border-bottom:1px solid var(--jcl-line);text-align:left}
.jcl-root th{color:var(--jcl-dim);font-weight:500}
.jcl-footer{text-align:center;color:var(--jcl-dim);font-size:12px;padding:12px}
.jcl-btns{display:flex;gap:8px;margin:10px 0;align-items:center;flex-wrap:wrap}
.jcl-campbar{display:flex;height:14px;border-radius:7px;overflow:hidden;margin:10px 0;background:#222}
`;
