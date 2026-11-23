#!/usr/bin/env node
/**
 * 向后兼容入口（dsh-agent-hub-mcp → cyber-foreman-mcp）。
 * 保留旧命令名，确保现有桌面端 MCP 配置无需立即修改即可继续运行。
 */
import "./cyber-foreman-mcp.mjs";
