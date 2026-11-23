#!/usr/bin/env node
/**
 * 向后兼容入口（dsh-agent-hub → cyber-foreman）。
 * 保留旧命令名，确保现有本地配置、快捷方式与脚本无缝过渡。
 */
import "./cyber-foreman.mjs";
