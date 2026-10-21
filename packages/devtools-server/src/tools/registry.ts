import { FLOW_TOOLS } from '../flows/tools.ts';
import { MOBILE_TOOLS, type MobileTool } from './mobileTools.ts';

/** Every tool the agent, Claude Code (MCP/channel) and scripts can call. */
export const TOOLS: MobileTool[] = [...MOBILE_TOOLS, ...FLOW_TOOLS];

/** Tools that change app state (shown as "acting"; refused after Stop). */
export const CONTROL_TOOLS = new Set(TOOLS.filter((t) => t.kind === 'control').map((t) => t.name));
