/**
 * Plan B 静态 HTML 导出（需求 #8 降级路径：引擎落盘静态 HTML，浏览器直接打开）。
 * 与面板共享极简 Markdown 渲染逻辑。
 */
export function mdToHtml(text: string): string {
  const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  const lines = esc(text).split('\n');
  let html = '', inList = false;
  for (const raw of lines) {
    const line = raw.trim();
    const out = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    if (/^# /.test(line)) { if (inList) { html += '</ul>'; inList = false; } html += `<h1>${out.slice(2)}</h1>`; }
    else if (/^## /.test(line)) { if (inList) { html += '</ul>'; inList = false; } html += `<h2>${out.slice(3)}</h2>`; }
    else if (/^[-*] /.test(line)) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${out.slice(2)}</li>`; }
    else { if (inList) { html += '</ul>'; inList = false; } if (line) html += `<p>${out}</p>`; }
  }
  if (inList) html += '</ul>';
  return html;
}

export function wrapStandaloneHtml(title: string, markdown: string): string {
  return [
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">',
    `<title>${title}</title>`,
    '<style>body{background:#0f1115;color:#d7dce6;font:15px/1.7 -apple-system,"PingFang SC",sans-serif;max-width:760px;margin:40px auto;padding:0 20px}',
    'h1{font-size:20px}h2{font-size:17px}strong{color:#7dd3fc}.foot{color:#8b93a3;font-size:12px;margin-top:40px;text-align:center}</style>',
    '</head><body>',
    mdToHtml(markdown),
    '<div class="foot">韭菜军团 · 模拟沙盘，仅供娱乐与研究，不构成任何投资建议。（#28）</div>',
    '</body></html>',
  ].join('\n');
}
