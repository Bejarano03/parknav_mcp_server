import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const NWS_API_BASE = "";
const USER_AGENT = "";

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
})

// Create server instance
const server = new McpServer({
  name: "parknav",
  version: "1.0.0",
  capabilities: {
    resources: {},
    tools: {},
  },
});

// Define the raw shape (not z.object)
const speechToTextShape: z.ZodRawShape = {
  audioBase64: z.string().describe("Base64 encoded audio file"),
  filetype: z.string().default("wav").describe("Audio file type (wav, mp3, m4a)"),
};

// Register the tool
server.tool(
  "speechToText",
  "Convert base64 audio into text using OpenAI Whisper",
  speechToTextShape,
  async ({ input }) => {
    const { audioBase64, filetype } = input as { audioBase64: string; filetype?: string };

    // Save to temporary file
    const buffer = Buffer.from(audioBase64, "base64");
    const tmpFilePath = `/tmp/audio.${filetype}`;
    await fs.promises.writeFile(tmpFilePath, buffer);

    // Call OpenAI Whisper API
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const transcription = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file: fs.createReadStream(tmpFilePath),
    });

    return {
      content: [
        {
          type: "text",
          text: transcription.text,
        },
      ],
    };
  }
);

server.tool(
  "textToSpeech",
  "Convert text into speech using OpenAI TTS",
  {
    schema: z.object({
      text: z.string().describe("Text to convert to speech"),
      voice: z.string().default("alloy").describe("Voice style (alloy, verse, etc.)"),
    }),
  },
  async ({ schema: { text, voice } }) => { // Corrected: Destructure 'text' and 'voice' from the 'schema' property
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
      content: [
        {
          type: "audio",
          mimeType: "audio/mp3",
          data: buffer.toString("base64"),
        },
      ],
    };
  }
);

// Connect transport
const transport = new StdioServerTransport();
await server.connect(transport);