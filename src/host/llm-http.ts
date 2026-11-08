/**
 * 独立运行器用 LLM 端口：OpenAI 兼容流式接口（DeepSeek API 兼容）。
 * 仅用于 CLI 开发/演示；DSH 插件内一律走宿主 ctx.llm（需求 #7）。
 * 环境变量：OPENAI_API_KEY（必填）、OPENAI_BASE_URL（默认 https://api.deepseek.com）。
 */
import type { LlmPort, LlmRequest } from './ports.js';

export class HttpLlm implements LlmPort {
  constructor(private modelId: string, private baseUrl = process.env['OPENAI_BASE_URL'] ?? 'https://api.deepseek.com') {}

  async *stream(req: LlmRequest): AsyncIterable<string> {
    const key = process.env['OPENAI_API_KEY'];
    if (!key) throw new Error('未配置 OPENAI_API_KEY（独立运行器需要；DSH 插件内请走宿主模型）');
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: this.modelId,
        messages: req.messages,
        temperature: req.temperature ?? 1,
        max_tokens: req.maxTokens ?? 2048,
        stream: true,
      }),
    });
    if (!res.ok || res.body === null) {
      throw new Error(`LLM 请求失败：HTTP ${res.status} ${await res.text().catch(() => '')}`);
    }
    // SSE 解析：data: {"choices":[{"delta":{"content":"..."}}]}
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk as Uint8Array, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          const obj = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
          const piece = obj.choices?.[0]?.delta?.content;
          if (piece) yield piece;
        } catch { /* 跳过不完整行 */ }
      }
    }
  }
}
