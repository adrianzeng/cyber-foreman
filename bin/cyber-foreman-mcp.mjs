#!/usr/bin/env node
/**
 * CyberForeman（赛博包工头）标准 STDIO MCP Server 入口（cyber-foreman-mcp）。
 *
 * 保持极度轻量：只把 MCP tools/list 与 tools/call 通过 HTTP 转发给本地
 * CyberForeman 服务（默认 http://127.0.0.1:4647，可用 CYBER_FOREMAN_URL 或 DSH_HUB_URL 覆盖），
 * 不在 MCP 进程内维护队列、状态机或账号凭证。
 *
 * 注意：STDIO 模式下 stdout 专供 JSON-RPC 协议帧，日志一律写 stderr。
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "../src/mcp/server.mjs";

async function main() {
  const { server } = createMcpServer({
    hubUrl: process.env.CYBER_FOREMAN_URL || process.env.DSH_HUB_URL,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
