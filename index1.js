import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import axios from "axios";

const server = new McpServer({ name: "evidenceGenerationForDrugTesting", version: "1.0.0" });

// Register the tool
server.tool(
    "evidenceGenerationForDrugTesting",
    { drug: z.string() , condition :z.string()},
    async ({ drug , condition }) => ({
      content: [{
        type: "text",
        text: JSON.stringify(await evidenceGenerationForDrugTesting(drug, condition))
      }]
    })
  );
  
  // Start the server
  async function main() {
    await server.connect(new StdioServerTransport());
  }
  
  main().catch(error => {
    console.error("Fatal error:", error);
    process.exit(1);
  });