// mcp-server.ts

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import OpenAI from "openai";
import fs from "fs";
import dotenv from "dotenv";
import { Pool } from "pg";
import fetch from "node-fetch";

// Load environment variables from .env file
dotenv.config();

// -------------------------------------------------------------
// Database Connection
// -------------------------------------------------------------
// Use a connection pool for efficient database connections
const pool = new Pool({
  connectionString: process.env.NEON_DB_URL,
  ssl: { rejectUnauthorized: false }, 
});

// Verify the database connection on startup
pool.connect()
  .then(client => {
    console.log("✅ Successfully connected to Neon database.");
    client.release();
  })
  .catch(err => {
    console.error("❌ Failed to connect to Neon database:", err);
    process.exit(1);
  });

// -------------------------------------------------------------
// OpenAI Client and MCP Server Setup
// -------------------------------------------------------------
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const server = new McpServer({
  name: "parknav",
  version: "1.0.0",
  capabilities: {
    resources: {},
    tools: {},
  },
});

// -------------------------------------------------------------
// Parking Data Helper Functions
// -------------------------------------------------------------
// Note: These are helper functions, not MCP tools themselves.
// The tools will call these functions.

interface ParkingInfo {
  name: string;
  address: string;
  hourlyRate: number | null;
  hours: string | null;
  neighborhood: string;
  sourceUrl: string;
}

async function queryGoogleForParking(neighborhood: string): Promise<any> {
  const query = `parking near ${neighborhood}, Seattle, WA`;
  const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&location=Seattle&api_key=${process.env.SERPAPI_API_KEY}`;
  
  const response = await fetch(url);
  const data = await response.json();
  return data;
}

function parseParkingDetails(raw: any, neighborhood: string): ParkingInfo[] {
  if (!raw || !raw.places_results) return [];

  return raw.places_results.map((place: any) => ({
    name: place.title,
    address: place.address,
    hourlyRate: extractRate(place.snippet),
    hours: extractHours(place.snippet),
    neighborhood,
    sourceUrl: place.link,
  }));
}

function extractRate(snippet: string): number | null {
  const match = snippet.match(/\$(\d+(\.\d{1,2})?)\/hr/);
  return match ? parseFloat(match[1]) : null;
}

function extractHours(snippet: string): string | null {
  const match = snippet.match(/Open\s([\d\s\w\-:]+)/);
  return match ? match[1].trim() : null;
}

// -------------------------------------------------------------
// MCP Server Tools
// -------------------------------------------------------------
// Fix: Use a raw object literal (ZodRawShape) for the schema
server.tool(
  "speechToText",
  "Convert base64 audio into text using OpenAI Whisper",
  { 
    audioBase64: z.string().describe("Base64 encoded audio file"),
    filetype: z.string().default("wav").describe("Audio file type (wav, mp3, m4a)"),
  },
  async ({ audioBase64, filetype }) => { 
    const buffer = Buffer.from(audioBase64, "base64");
    const tmpFilePath = `/tmp/audio.${filetype}`;
    await fs.promises.writeFile(tmpFilePath, buffer);
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const transcription = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file: fs.createReadStream(tmpFilePath),
    });
    return {
      content: [{ type: "text", text: transcription.text }],
    };
  }
);

// Fix: Use a raw object literal (ZodRawShape) for the schema
server.tool(
  "textToSpeech",
  "Convert text into speech using OpenAI TTS",
  {
    text: z.string().describe("Text to convert to speech"),
    voice: z.string().default("alloy").describe("Voice style (alloy, verse, etc.)"),
  },
  async ({ text, voice }) => {
    const outputFile = `/tmp/output.mp3`;
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice,
      input: text,
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.promises.writeFile(outputFile, buffer);
    return {
      content: [{ type: "audio", mimeType: "audio/mp3", data: buffer.toString("base64") }],
    };
  }
);

// Fix: Use a raw object literal (ZodRawShape) for the schema
server.tool(
  "saveParkingInfo",
  "Fetches parking information from Google Maps and saves it to the database.",
  { 
    neighborhood: z.string().describe("The neighborhood to search for parking in."),
  },
  async ({ neighborhood }) => { 
    try {
      const rawData = await queryGoogleForParking(neighborhood);
      const parsedData = parseParkingDetails(rawData, neighborhood);
      if (parsedData.length === 0) {
        return {
          content: [{ type: "text", text: `No parking data found for ${neighborhood}.` }],
        };
      }
      const client = await pool.connect();
      await client.query("BEGIN");
      const query = `
        INSERT INTO seattle_parking (name, address, hourly_rate, hours, neighborhood, source_url)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (source_url) DO UPDATE SET
          name = EXCLUDED.name,
          address = EXCLUDED.address,
          hourly_rate = EXCLUDED.hourly_rate,
          hours = EXCLUDED.hours,
          neighborhood = EXCLUDED.neighborhood;
      `;
      for (const info of parsedData) {
        await client.query(query, [
          info.name,
          info.address,
          info.hourlyRate,
          info.hours,
          info.neighborhood,
          info.sourceUrl,
        ]);
      }
      await client.query("COMMIT");
      client.release();
      return {
        content: [{ type: "text", text: `Successfully saved ${parsedData.length} parking spots for ${neighborhood}.` }],
      };
    } catch (error) {
      console.error("Error in saveParkingInfo tool:", error);
      return {
        content: [{ type: "text", text: "An error occurred while saving parking data." }],
      };
    }
  }
);

// -------------------------------------------------------------
// Start the MCP Server
// -------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);