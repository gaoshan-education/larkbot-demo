/**
 * Tavily MCP Stdio Server
 * 提供互联网搜索工具 (通过 Tavily API)
 * Provides internet search tools via Tavily API
 *
 * 运行 / Run:
 *   ts-node src/mcp/tavily.ts
 * 作为一个 MCP 服务器通过 stdio 与客户端通讯
 */

import { config } from '../config';

interface TavilySearchRequest {
  api_key: string;
  query: string;
  search_depth?: 'basic' | 'advanced';
  max_results?: number;
}

interface TavilySearchResultItem {
  title: string;
  url: string;
  content: string;
  score?: number;
}

interface TavilySearchResponse {
  query: string;
  results: TavilySearchResultItem[];
}

// ---- Minimal MCP stdio protocol helpers ----
/**
 * 我们沿用简单 JSON-RPC 2.0 风格
 */
interface JsonRpcRequest { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: any }
interface JsonRpcSuccess { jsonrpc: '2.0'; id: string | number | null; result: any }
interface JsonRpcError { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string; data?: any } }

const TOOLS: Record<string, {
  name: string;
  description: string;
  inputSchema: any;
  run: (input: any) => Promise<any>;
}> = {
  tavily_search: {
    name: 'tavily_search',
    description: 'Perform a web search using Tavily API. 输入自然语言查询，返回最新互联网信息摘要。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query / 搜索关键词' },
        max_results: { type: 'number', description: 'Max results (1-10)', minimum: 1, maximum: 10 },
        depth: { type: 'string', enum: ['basic', 'advanced'], description: 'Search depth' },
      },
      required: ['query'],
    },
    run: async (input: any) => {
      if (!config.tavily.apiKey) {
        throw new Error('Tavily API key missing. 请在环境变量中设置 TAVILY_API_KEY');
      }

      const body: TavilySearchRequest = {
        api_key: config.tavily.apiKey,
        query: input.query,
        max_results: Math.min(input.max_results || config.tavily.maxResults, 10),
        search_depth: input.depth === 'advanced' ? 'advanced' : 'basic',
      };

      const resp = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Tavily API error: ${resp.status} ${text}`);
      }
      const data = (await resp.json()) as TavilySearchResponse;

      // 返回简洁结构，避免过长
      return {
        query: data.query,
        results: data.results.slice(0, body.max_results).map(r => ({
          title: r.title,
          url: r.url,
          content: r.content.slice(0, 500),
        })),
      };
    },
  },
};

async function handleRpc(req: JsonRpcRequest): Promise<JsonRpcSuccess | JsonRpcError> {
  if (req.jsonrpc !== '2.0') {
    return { jsonrpc: '2.0', id: req.id ?? null, error: { code: -32600, message: 'Invalid JSON-RPC version' } };
  }
  try {
    switch (req.method) {
      case 'ping':
        return { jsonrpc: '2.0', id: req.id ?? null, result: { pong: true } };
      case 'listTools':
        return {
          jsonrpc: '2.0',
          id: req.id ?? null,
            result: Object.values(TOOLS).map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        };
      case 'callTool': {
        const { name, input } = req.params || {};
        if (typeof name !== 'string' || !(name in TOOLS)) throw new Error(`Tool not found: ${name}`);
        const tool = TOOLS[name];
        const result = await tool.run(input || {});
        return { jsonrpc: '2.0', id: req.id ?? null, result };
      }
      default:
        return { jsonrpc: '2.0', id: req.id ?? null, error: { code: -32601, message: `Method not found: ${req.method}` } };
    }
  } catch (e: any) {
    return { jsonrpc: '2.0', id: req.id ?? null, error: { code: -32000, message: e?.message || 'Internal error', data: e?.stack } };
  }
}

// ---- stdio loop ----
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const req = JSON.parse(line) as JsonRpcRequest;
      handleRpc(req).then(resp => process.stdout.write(JSON.stringify(resp) + '\n'));
    } catch (e) {
      const err: JsonRpcError = {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error', data: (e as any)?.message },
      };
      process.stdout.write(JSON.stringify(err) + '\n');
    }
  }
});

process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, result: { ready: true, tools: Object.keys(TOOLS) } }) + '\n');
