// SPDX-License-Identifier: Apache-2.0
/**
 * MCP Streamable HTTP transport adapter
 *
 * Wraps the official MCP TypeScript SDK's Streamable HTTP server.
 * Implements JSON-RPC endpoints with session management, host validation,
 * and integration with AskTurret's dispatcher.
 *
 * SDK import boundary: This is the ONLY package that imports from @modelcontextprotocol/sdk.
 * NOTE: Enforcement via dependency-cruiser/ESLint is planned but not yet configured.
 * For now, this boundary is maintained by convention and code review.
 */

import { randomUUID } from 'crypto';
import type {
  RegistrySnapshot,
  CommandDispatcher,
  OperationCommand,
  MCPResult,
} from '@askturret/mcp-core';
import { createDispatcher } from '@askturret/mcp-core';
import type {
  HttpTransport,
  HttpTransportOptions,
  SessionStore,
  SessionData,
} from './types.js';
import { createInMemorySessionStore } from './session-store.js';

// MCP SDK imports - ONLY here, nowhere else in the codebase
// @ts-expect-error - SDK is a peer dependency, may not be installed during development
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

/**
 * Create an HTTP transport adapter
 *
 * @param options - Transport configuration
 * @returns HttpTransport instance
 */
export function createHttpTransport(options: HttpTransportOptions): HttpTransport {
  return new StreamableHttpTransport(options);
}

/**
 * Streamable HTTP transport implementation
 */
class StreamableHttpTransport implements HttpTransport {
  private readonly registry;
  private readonly dispatcher: CommandDispatcher;
  private readonly basePath: string;
  private readonly sessionStore: SessionStore | null;
  private readonly allowedHosts: Set<string>;
  private readonly deadlineMs: number;
  private readonly maxRequestBodySize: number;
  private readonly maxResponseSize: number;

  constructor(options: HttpTransportOptions) {
    this.registry = options.registry;
    this.dispatcher = createDispatcher(options.registry, options.hooks);
    this.basePath = options.basePath ?? '/mcp';
    this.deadlineMs = options.deadlineMs ?? 30000;
    this.maxRequestBodySize = options.maxRequestBodySize ?? 1048576; // 1 MiB
    this.maxResponseSize = options.maxResponseSize ?? 1048576; // 1 MiB

    // Session store setup
    if (options.session === 'inMemory') {
      this.sessionStore = createInMemorySessionStore();
    } else if (options.session) {
      this.sessionStore = options.session;
    } else {
      this.sessionStore = null; // Stateless
    }

    // Host-header validation (DNS rebinding mitigation)
    const defaultHosts = ['localhost', '127.0.0.1', '[::1]'];
    this.allowedHosts = new Set(options.allowedHosts ?? defaultHosts);
  }

  handler() {
    return async (req: any, res: any) => {
      try {
        // Host-header validation (DNS rebinding mitigation)
        const host = req.headers.host || req.headers[':authority'];
        if (!this.isHostAllowed(host)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                code: -32600,
                message: 'Invalid Host header',
              },
            }),
          );
          return;
        }

        // Route by method and path
        const url = new URL(req.url || '/', `http://${host}`);

        if (url.pathname !== this.basePath) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: -32601, message: 'Not found' } }));
          return;
        }

        if (req.method === 'POST') {
          await this.handleJsonRpc(req, res);
        } else if (req.method === 'GET') {
          await this.handleSse(req, res);
        } else if (req.method === 'DELETE') {
          await this.handleSessionTermination(req, res);
        } else {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: -32601, message: 'Method not allowed' } }));
        }
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: -32603,
              message: 'Internal server error',
            },
          }),
        );
      }
    };
  }

  private isHostAllowed(host: string | undefined): boolean {
    if (!host) {
      return false;
    }

    // Strip port if present
    const hostname = host.split(':')[0] || host;
    return this.allowedHosts.has(hostname);
  }

  private async handleJsonRpc(req: any, res: any): Promise<void> {
    // Read request body with size limit
    const body = await this.readRequestBody(req, this.maxRequestBodySize);

    let jsonRpcRequest;
    try {
      jsonRpcRequest = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: -32700,
            message: 'Parse error',
          },
        }),
      );
      return;
    }

    // Extract session ID from headers (if sessions enabled)
    const sessionId = this.sessionStore ? this.getSessionId(req) : null;

    // Handle JSON-RPC method
    const response = await this.handleMethod(jsonRpcRequest, sessionId);

    // Check response size
    const responseBody = JSON.stringify(response);
    if (responseBody.length > this.maxResponseSize) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: jsonRpcRequest.id,
          error: {
            code: 'OUTPUT_TOO_LARGE',
            message: 'Response exceeds size limit',
          },
        }),
      );
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(responseBody);
  }

  private async handleMethod(request: any, sessionId: string | null): Promise<any> {
    const { method, params, id } = request;

    try {
      switch (method) {
        case 'initialize':
          return await this.handleInitialize(params, sessionId);

        case 'tools/list':
          return await this.handleToolsList(sessionId);

        case 'tools/call':
          return await this.handleToolsCall(params, sessionId);

        case 'ping':
          return { jsonrpc: '2.0', id, result: { status: 'ok' } };

        default:
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32601,
              message: `Method not found: ${method}`,
            },
          };
      }
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: 'Internal error',
        },
      };
    }
  }

  private async handleInitialize(params: any, sessionId: string | null): Promise<any> {
    // Negotiate MCP protocol version
    const protocolVersion = '2024-11-05'; // MCP SDK version 0.5.0

    // Store session data if sessions enabled
    if (this.sessionStore && sessionId) {
      const sessionData: SessionData = {
        clientInfo: params.clientInfo,
        createdAt: new Date(),
        lastActivityAt: new Date(),
      };
      await this.sessionStore.set(sessionId, sessionData);
    }

    return {
      jsonrpc: '2.0',
      id: params.id || randomUUID(),
      result: {
        protocolVersion,
        serverInfo: {
          name: '@askturret/mcp',
          version: '0.1.0',
        },
        capabilities: {
          tools: {},
        },
      },
    };
  }

  private async handleToolsList(sessionId: string | null): Promise<any> {
    // Update session activity if sessions enabled
    if (this.sessionStore && sessionId) {
      const session = await this.sessionStore.get(sessionId);
      if (session) {
        await this.sessionStore.set(sessionId, {
          ...session,
          lastActivityAt: new Date(),
        });
      }
    }

    // Get current registry snapshot
    const snapshot: RegistrySnapshot = this.registry.current();

    // Convert operations to MCP tools format
    const tools = Array.from(snapshot.operations.values()).map((op) => ({
      name: op.name,
      description: op.description,
      inputSchema: op.input,
    }));

    return {
      jsonrpc: '2.0',
      result: {
        tools,
      },
    };
  }

  private async handleToolsCall(params: any, sessionId: string | null): Promise<any> {
    // Update session activity and get client info if sessions enabled
    let clientInfo;
    if (this.sessionStore && sessionId) {
      const session = await this.sessionStore.get(sessionId);
      if (session) {
        await this.sessionStore.set(sessionId, {
          ...session,
          lastActivityAt: new Date(),
        });
        clientInfo = session.clientInfo;
      }
    }

    // Get current registry snapshot
    const snapshot: RegistrySnapshot = this.registry.current();

    // Build OperationCommand with full context
    const deadline = new Date(Date.now() + this.deadlineMs);
    const abortController = new AbortController();
    const requestId = params.id || randomUUID();
    const traceId = params._meta?.traceId || randomUUID();

    const command: OperationCommand = {
      requestId,
      traceId,
      ...(clientInfo !== undefined && { clientInfo }),
      operationId: params.name,
      input: params.arguments || {},
      deadline,
      signal: abortController.signal,
      registryHash: snapshot.hash,
    };

    // Enforce deadline using Promise.race (same pattern as viaHandler fix in #14)
    const deadlineMs = deadline.getTime() - Date.now();
    let timeoutId: NodeJS.Timeout | undefined;

    const dispatchPromise = this.dispatcher.dispatch(command);
    const timeoutPromise = new Promise<MCPResult>((resolve) => {
      timeoutId = setTimeout(() => {
        abortController.abort(); // Signal cancellation
        resolve({
          isError: true,
          error: {
            code: 'TIMEOUT',
            message: 'Request exceeded deadline',
          },
        });
      }, deadlineMs);
    });

    // Race dispatch against deadline
    const result: MCPResult = await Promise.race([dispatchPromise, timeoutPromise]);

    // Clean up timeout
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }

    // Map to MCP wire format
    if (result.isError) {
      return {
        jsonrpc: '2.0',
        id: requestId,
        error: {
          code: result.error!.code,
          message: result.error!.message,
        },
      };
    }

    return {
      jsonrpc: '2.0',
      id: requestId,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result.content),
          },
        ],
      },
    };
  }

  private async handleSse(req: any, res: any): Promise<void> {
    // v0.1: SSE heartbeat/ping only
    // Full bi-directional SSE support deferred to v0.2

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // Send periodic heartbeat
    const interval = setInterval(() => {
      res.write('event: ping\ndata: {}\n\n');
    }, 30000);

    req.on('close', () => {
      clearInterval(interval);
    });
  }

  private async handleSessionTermination(req: any, res: any): Promise<void> {
    if (!this.sessionStore) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    const sessionId = this.getSessionId(req);
    if (sessionId) {
      await this.sessionStore.delete(sessionId);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  }

  private getSessionId(req: any): string | null {
    // Try X-Session-ID header first
    let sessionId = req.headers['x-session-id'];
    if (sessionId) {
      return sessionId;
    }

    // Try Cookie header
    const cookie = req.headers.cookie;
    if (cookie) {
      const match = cookie.match(/sessionId=([^;]+)/);
      if (match) {
        return match[1];
      }
    }

    return null;
  }

  private async readRequestBody(req: any, maxSize: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;

      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxSize) {
          reject(new Error('Request body too large'));
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf-8'));
      });

      req.on('error', reject);
    });
  }

  async shutdown(): Promise<void> {
    // Cleanup resources
    // In v0.1, we don't have persistent connections to clean up
  }
}
