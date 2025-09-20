import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const NWS_API_BASE = "";
const USER_AGENT = "";

// Create server instance
const server = new McpServer({
  name: "parknav",
  version: "1.0.0",
  capabilities: {
    resources: {},
    tools: {},
  },
});