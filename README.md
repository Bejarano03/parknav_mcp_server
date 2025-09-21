# Parknav AI

Parknav is a multi-agent system designed to find and enrich parking information. It uses a specialized agent to collect basic parking data and another to perform targeted web searches, providing detailed information like hours, pricing, and operator details to a frontend application.

## Features 

- Intelligent Data Collection: Uses the Overpass API to find parking spots within a specified radius.
- Automated Enrichment: An agent automatically performs web searches to find crucial details for each parking location.
- Structured Data Output: All enriched data is stored in a PostgreSQL database and can be retrieved as a GeoJSON object.
- Multi-Agent Architecture: The system uses two specialized agents

## Getting Started

<b>Prerequisites</b>
- Node.js (v8 or higher)
- PostgreSQL Database/Neon
- OpenAI API Key
- SerpAPI API Key

## Installation

1. Clone Repo
1. Installed dependencies via 
    
    ```
    npm install
    ```
1. Set up environment variables by creating a .env file in the root directory and adding the following: 

    ```
    NEON_DB_URL="<YOUR_POSTGRESQL_CONNECTION_STRING>"
    OPENAI_API_KEY="<YOUR_OPENAI_API_KEY>"
    SERPAPI_API_KEY="<YOUR_SERPAPI_API_KEY>"
    ```

## Running server

1. Build mcp server via
    ```
    npm run build
    ```

1. Run via
    ```
    node build/index.js
    ```
