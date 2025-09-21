// mcp-server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import OpenAI from "openai";
import fs from "fs";
import dotenv from "dotenv";
import { Pool } from "pg";
import fetch from "node-fetch";
import osmtogeojson from "osmtogeojson";
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
async function queryGoogleForParking(neighborhood) {
    const query = `parking near ${neighborhood}, Seattle, WA`;
    const url = `https://serpapi.com/search.json?engine=google_maps&q=${encodeURIComponent(query)}&location=Seattle&api_key=${process.env.SERPAPI_API_KEY}`;
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        return data;
    }
    catch (error) {
        console.error("Error fetching data from SerpApi:", error);
        return null; // Return null on failure to handle gracefully.
    }
}
function parseParkingDetails(raw, neighborhood) {
    if (!raw || !raw.places_results)
        return [];
    return raw.places_results.map((place) => ({
        name: place.title,
        address: place.address,
        hourlyRate: extractRate(place.snippet),
        hours: extractHours(place.snippet),
        neighborhood,
        sourceUrl: place.link,
    }));
}
function extractRate(snippet) {
    const match = snippet.match(/\$(\d+(\.\d{1,2})?)\/hr/);
    return match ? parseFloat(match[1]) : null;
}
function extractHours(snippet) {
    const match = snippet.match(/Open\s([\d\s\w\-:]+)/);
    return match ? match[1].trim() : null;
}
// Define a new Zod schema for the GeoJSON resource type
const GeoJsonResourceSchema = z.object({
    type: z.literal("resource"),
    resource: z.object({
        text: z.string(),
        uri: z.string(),
        mimeType: z.string().optional(),
    }),
});
// -------------------------------------------------------------
// MCP Server Tools
// -------------------------------------------------------------
server.tool("speechToText", "Convert base64 audio into text using OpenAI Whisper", {
    audioBase64: z.string().describe("Base64 encoded audio file"),
    filetype: z.string().default("wav").describe("Audio file type (wav, mp3, m4a)"),
}, async ({ audioBase64, filetype }) => {
    const buffer = Buffer.from(audioBase64, "base64");
    const tmpFilePath = `/tmp/audio.${filetype}`;
    await fs.promises.writeFile(tmpFilePath, buffer);
    const transcription = await openai.audio.transcriptions.create({
        model: "whisper-1",
        file: fs.createReadStream(tmpFilePath),
    });
    return {
        content: [{ type: "text", text: transcription.text }],
    };
});
server.tool("textToSpeech", "Convert text into speech using OpenAI TTS", {
    text: z.string().describe("Text to convert to speech"),
    voice: z.string().default("alloy").describe("Voice style (alloy, verse, etc.)"),
}, async ({ text, voice }) => {
    const outputFile = `/tmp/output.mp3`;
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
});
server.tool("saveParkingInfo", "Fetches parking information from Google Maps and saves it to the database.", {
    neighborhood: z.string().describe("The neighborhood to search for parking in."),
}, async ({ neighborhood }) => {
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
    }
    catch (error) {
        let errorMessage = "An unknown error occurred while saving parking data.";
        if (error instanceof Error) {
            errorMessage = error.message;
        }
        console.error("Error in saveParkingInfo tool:", error);
        return {
            content: [{ type: "text", text: `An error occurred while saving parking data: ${errorMessage}` }],
        };
    }
});
server.tool("fetchOverpassData", "Fetches parking data from Overpass API and saves it to a structured database table.", {
    lat: z.number().describe("Latitude for the query center point."),
    lon: z.number().describe("Longitude for the query center point."),
    radius: z.number().default(500).describe("Radius in meters for the search."),
}, async ({ lat, lon, radius }) => {
    const client = await pool.connect();
    try {
        await client.query(`
        CREATE TABLE IF NOT EXISTS enriched_parking (
          id SERIAL PRIMARY KEY,
          overpass_id BIGINT UNIQUE,
          latitude DOUBLE PRECISION,
          longitude DOUBLE PRECISION,
          name TEXT,
          amenity TEXT,
          source TEXT,
          retrieved_at TIMESTAMPTZ,
          confidence DOUBLE PRECISION,
          other_tags JSONB
        );
      `);
        const overpassQuery = `[out:json][timeout:25]; nwr["amenity"="parking"](around:${radius},${lat},${lon}); out tags geom;`;
        const response = await fetch("https://overpass-api.de/api/interpreter", {
            method: "POST",
            body: `data=${encodeURIComponent(overpassQuery)}`,
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const rawOverpassData = await response.json();
        const geojsonData = osmtogeojson(rawOverpassData);
        const source = "https://overpass-api.de/api/interpreter";
        const retrievedAt = new Date().toISOString();
        const confidence = 0.95;
        await client.query("BEGIN");
        const insertQuery = `
        INSERT INTO enriched_parking (overpass_id, latitude, longitude, name, amenity, source, retrieved_at, confidence, other_tags)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (overpass_id) DO UPDATE SET
          latitude = EXCLUDED.latitude,
          longitude = EXCLUDED.longitude,
          name = EXCLUDED.name,
          amenity = EXCLUDED.amenity,
          source = EXCLUDED.source,
          retrieved_at = EXCLUDED.retrieved_at,
          confidence = EXCLUDED.confidence,
          other_tags = EXCLUDED.other_tags;
      `;
        for (const feature of geojsonData.features) {
            const { id, properties, geometry } = feature;
            if (!geometry || geometry.type !== "Point" || !geometry.coordinates)
                continue;
            const [longitude, latitude] = geometry.coordinates;
            const { name, amenity, ...otherTags } = properties;
            await client.query(insertQuery, [
                id,
                latitude,
                longitude,
                name || null,
                amenity || null,
                source,
                retrievedAt,
                confidence,
                otherTags,
            ]);
        }
        await client.query("COMMIT");
        return {
            content: [{ type: "text", text: `✅ Successfully fetched and saved ${geojsonData.features.length} parking spots to the database.` }],
        };
    }
    catch (error) {
        await client.query("ROLLBACK");
        let errorMessage = "An unknown error occurred.";
        if (error instanceof Error) {
            errorMessage = error.message;
        }
        console.error("❌ Error in fetchOverpassData tool:", error);
        return {
            content: [{ type: "text", text: `❌ An error occurred while fetching parking data: ${errorMessage}` }],
        };
    }
    finally {
        client.release();
    }
});
server.tool("getParkingDataForFrontend", "Retrieves parking data from the database and returns it as a GeoJSON object.", {}, async () => {
    const client = await pool.connect();
    try {
        const result = await client.query("SELECT * FROM enriched_parking");
        const parkingRows = result.rows;
        const geojsonFeatures = parkingRows.map(row => {
            const { latitude, longitude, ...properties } = row;
            return {
                type: "Feature",
                geometry: {
                    type: "Point",
                    coordinates: [longitude, latitude],
                },
                properties,
            };
        });
        const geojson = {
            type: "FeatureCollection",
            features: geojsonFeatures,
        };
        const geojsonString = JSON.stringify(geojson, null, 2);
        return {
            content: [{
                    type: "resource",
                    resource: {
                        text: "parking_locations.geojson",
                        uri: "data:application/json;base64," + Buffer.from(geojsonString).toString("base64"),
                        mimeType: "application/geo+json"
                    },
                }],
        };
    }
    catch (error) {
        let errorMessage = "An unknown error occurred while retrieving parking data.";
        if (error instanceof Error) {
            errorMessage = error.message;
        }
        console.error("❌ Error in getParkingDataForFrontend tool:", error);
        return {
            content: [{ type: "text", text: `❌ An error occurred while retrieving parking data: ${errorMessage}` }],
        };
    }
    finally {
        client.release();
    }
});
// -------------------------------------------------------------
// Start the MCP Server
// -------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
