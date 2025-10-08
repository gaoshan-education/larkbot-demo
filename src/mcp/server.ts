/**
 * Simple MCP Server over SSE
 * 轻量级基于 SSE 的 MCP 服务器示例
 *
 * Usage / 用法:
 *   pnpm ts-node src/mcp/server.ts (or npm/yarn) then connect a MCP client using SSE transport.
 *
 * SSE Endpoint:   GET /mcp/sse (Last-Event-ID supported for simple resume)
 * Command Endpoint: POST /mcp/command  (send JSON-RPC 2.0 request body)
 *
 * This server exposes a minimal tool set for demo purposes.
 */

import express, { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import cors from 'cors';

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: any;
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: any;
}

interface JsonRpcError {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string; data?: any };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

// ------------------------------------------------------------
// Simple in-memory session / event stream management
// ------------------------------------------------------------
interface ClientConn {
  id: string;
  res: Response;
  createdAt: number;
  lastEventId: number;
}

const clients = new Map<string, ClientConn>();
let globalEventSeq = 1; // incremental id for SSE events

function broadcast(event: string, data: any) {
  const payload = JSON.stringify(data);
  for (const c of clients.values()) {
    c.res.write(`id: ${globalEventSeq}\n`);
    c.res.write(`event: ${event}\n`);
    c.res.write(`data: ${payload}\n\n`);
    c.lastEventId = globalEventSeq;
  }
  globalEventSeq++;
}

// ------------------------------------------------------------
// Tool definitions (MCP-like minimal abstraction)
// ------------------------------------------------------------
interface McpTool {
  name: string;
  description: string;
  inputSchema?: any;
  run: (input: any) => Promise<any>;
}

const tools: Record<string, McpTool> = {
  echo: {
    name: 'echo',
    description: 'Return the provided input. / 回显输入内容',
    async run(input: any) {
      return { echo: input };
    },
  },
  now: {
    name: 'now',
    description: 'Return current ISO timestamp. / 返回当前时间戳',
    async run() {
      return { now: new Date().toISOString() };
    },
  },
  sum: {
    name: 'sum',
    description: 'Sum numbers in an array. / 对数组中的数字求和',
    async run(input: any) {
      if (!Array.isArray(input)) {
        throw new Error('Input must be array of numbers');
      }
      const total = input.reduce((acc, v) => acc + Number(v || 0), 0);
      return { total };
    },
  },
};

// ------------------------------------------------------------
// JSON-RPC Handler
// ------------------------------------------------------------
async function handleRpc(reqObj: JsonRpcRequest): Promise<JsonRpcResponse> {
  if (reqObj.jsonrpc !== '2.0') {
    return {
      jsonrpc: '2.0',
      id: reqObj.id ?? null,
      error: { code: -32600, message: 'Invalid JSON-RPC version' },
    };
  }

  try {
    switch (reqObj.method) {
      case 'ping':
        return { jsonrpc: '2.0', id: reqObj.id ?? null, result: { pong: true } };
      case 'listTools':
        return {
          jsonrpc: '2.0',
          id: reqObj.id ?? null,
          result: Object.values(tools).map(t => ({ name: t.name, description: t.description })),
        };
      case 'callTool': {
        const { name, input } = reqObj.params || {};
        if (!name || !tools[name]) {
          throw new Error(`Tool not found: ${name}`);
        }
        const result = await tools[name].run(input);
        return { jsonrpc: '2.0', id: reqObj.id ?? null, result };
      }
      default:
        return {
          jsonrpc: '2.0',
          id: reqObj.id ?? null,
          error: { code: -32601, message: `Method not found: ${reqObj.method}` },
        };
    }
  } catch (err: any) {
    return {
      jsonrpc: '2.0',
      id: reqObj.id ?? null,
      error: { code: -32000, message: err?.message || 'Internal error', data: err?.stack },
    };
  }
}

// ------------------------------------------------------------
// Express App
// ------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Health
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// SSE endpoint
app.get('/mcp/sse', (req: Request, res: Response) => {
  const clientId = randomUUID();
  const lastEventIdHeader = req.header('Last-Event-ID');
  const lastEventId = lastEventIdHeader ? Number(lastEventIdHeader) : 0;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const conn: ClientConn = { id: clientId, res, createdAt: Date.now(), lastEventId };
  clients.set(clientId, conn);
  console.log(`[MCP][SSE] client connected: ${clientId}`);

  // Send a welcome event
  res.write(`id: ${globalEventSeq}\n`);
  res.write('event: welcome\n');
  res.write(`data: ${JSON.stringify({ clientId, serverTime: new Date().toISOString() })}\n\n`);
  conn.lastEventId = globalEventSeq;
  globalEventSeq++;

  req.on('close', () => {
    clients.delete(clientId);
    console.log(`[MCP][SSE] client disconnected: ${clientId}`);
  });
});

// Command endpoint to accept JSON-RPC request and broadcast response via SSE + direct response
app.post('/mcp/command', async (req: Request, res: Response) => {
  const body = req.body as JsonRpcRequest | JsonRpcRequest[];
  const requests = Array.isArray(body) ? body : [body];
  const responses: JsonRpcResponse[] = [];
  for (const r of requests) {
    const resp = await handleRpc(r);
    responses.push(resp);
    // broadcast each response as an event so streaming clients can receive
    broadcast('rpc', resp);
  }
  res.json(Array.isArray(body) ? responses : responses[0]);
});

// Example server-sent tick events
setInterval(() => {
  broadcast('tick', { ts: Date.now() });
}, 10000);

const PORT = process.env.MCP_SSE_PORT ? Number(process.env.MCP_SSE_PORT) : 3333;
app.listen(PORT, () => {
  console.log(`MCP SSE server listening on :${PORT}`);
  console.log(`SSE endpoint: GET http://localhost:${PORT}/mcp/sse`);
  console.log(`Command endpoint: POST http://localhost:${PORT}/mcp/command`);
});
