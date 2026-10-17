import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { ToolCallRow } from '../db/toolcalls.ts';
import type { Logger } from '../log/logger.ts';
import { imageContent } from './image.ts';
import { inputSchema } from './schema.ts';
import type { Tool, ToolResult } from './tool.ts';

/** The MCP server name: Claude Code namespaces every tool as `mcp__tars__<name>`. */
export const MCP_SERVER_NAME = 'tars';

export interface McpServerOptions {
  tools: readonly Tool[];
  log: Logger;
  /** Bumped when a tool call starts and ends — the Claude worker reads it as "busy, not wedged". */
  beat(): void;
  audit(row: ToolCallRow): void;
}

/**
 * The local MCP server Claude Code calls tars's tools through: Streamable
 * HTTP with stateful sessions on `127.0.0.1:<ephemeral port>/mcp`, guarded
 * against DNS rebinding. Every call is validated, timed and audited.
 */
export class McpHttpServer {
  private readonly o: McpServerOptions;
  private readonly byName: Map<string, Tool>;
  private readonly listed: { name: string; description: string; inputSchema: Record<string, unknown> }[];
  private readonly sessions = new Map<string, StreamableHTTPServerTransport>();
  private http: HttpServer | undefined;
  private port: number | undefined;

  constructor(options: McpServerOptions) {
    this.o = options;
    this.byName = new Map(options.tools.map((tool) => [tool.name, tool]));
    this.listed = options.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: inputSchema(t.args) }));
  }

  /** Bare names of the registered tools, in registration order. */
  get toolNames(): string[] {
    return this.listed.map((t) => t.name);
  }

  get url(): string {
    if (this.port === undefined) throw new Error('MCP server has not started yet');
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  async start(): Promise<void> {
    const http = createServer((req, res) => void this.handle(req, res));
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    this.http = http;
    this.port = (http.address() as AddressInfo).port;
    this.o.log.info(`MCP server listening on ${this.url}`);
  }

  async stop(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((t) => t.close()));
    this.http?.closeAllConnections();
    await new Promise<void>((resolve) => (this.http ? this.http.close(() => resolve()) : resolve()));
    this.http = undefined;
  }

  /** Handle one tool call; public so tests can call tools without HTTP. */
  async call(name: string, rawArgs: unknown): Promise<CallToolResult> {
    const tool = this.byName.get(name);
    if (!tool) return failure(`Unknown tool: ${name}`);
    const parsed = tool.args.safeParse(rawArgs ?? {});
    if (!parsed.success) return failure(`Invalid arguments:\n${z.prettifyError(parsed.error)}`);
    return this.run(tool, parsed.data);
  }

  private async run(tool: Tool, args: Record<string, unknown>): Promise<CallToolResult> {
    this.o.beat();
    const started = performance.now();
    let result: ToolResult | undefined;
    let error: string | undefined;
    try {
      result = await tool.run(args);
    } catch (err) {
      error = String(err);
      this.o.log.error(`tool ${tool.name} failed`, { err });
    }
    this.o.beat();
    this.audit({ toolName: tool.name, args, result, error, durationMs: performance.now() - started });
    if (!result) return failure(String(error));
    if (result.isError) return failure(result.content);
    if (result.imagePath) return { content: [imageContent(result.imagePath)], isError: false };
    return { content: [{ type: 'text', text: result.content }], isError: false };
  }

  private audit(row: ToolCallRow): void {
    try {
      this.o.audit(row);
    } catch (err) {
      this.o.log.error(`audit log failed for tool ${row.toolName}`, { err });
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    const sessionId = req.headers['mcp-session-id'];
    const known = typeof sessionId === 'string' ? this.sessions.get(sessionId) : undefined;
    if (sessionId !== undefined && !known) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"jsonrpc":"2.0","error":{"code":-32001,"message":"Session not found"},"id":null}');
      return;
    }
    const transport = known ?? (await this.openSession());
    await transport.handleRequest(req, res);
  }

  private async openSession(): Promise<StreamableHTTPServerTransport> {
    const port = this.port ?? 0;
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (id) => {
        // One claude child at a time, and a killed one sends no DELETE: a new session retires the old.
        for (const old of this.sessions.values()) void old.close();
        this.sessions.set(id, transport);
      },
      enableDnsRebindingProtection: true,
      allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`],
      allowedOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`],
    });
    transport.onclose = () => void (transport.sessionId && this.sessions.delete(transport.sessionId));
    const server = new Server({ name: MCP_SERVER_NAME, version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: this.listed }));
    server.setRequestHandler(CallToolRequestSchema, (request) => this.call(request.params.name, request.params.arguments));
    await server.connect(transport);
    return transport;
  }
}

const failure = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });
