# Autonomous Website Cloning Agent

An AI-powered agent that clones websites by analyzing DOM structure, styles, and layout, then generating React components with Tailwind CSS.

## Features

- **Scout Node**: Extracts DOM structure, computed styles, layout data, and downloads assets
- **Architect Node**: Creates component plans using LLM (OpenAI GPT-4o, Claude, or Gemini)
- **Coder Node**: Generates React + TypeScript + Tailwind CSS code
- **QA Node**: Validates clones using vision AI (GPT-4o Vision or Gemini Vision)
- **Real-time Streaming**: Live progress updates via Server-Sent Events
- **Asset Caching**: Reuses downloaded assets across jobs
- **Model Fallback**: Automatically switches models on quota errors

## Tech Stack

- **Next.js 14** (App Router)
- **LangGraph** (Agent orchestration)
- **Playwright** (Browser automation)
- **Redis** (State persistence)
- **OpenAI GPT-4o** / **Claude** / **Gemini** (LLMs)

## Quick Start

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Set up Redis:**
   ```bash
   docker-compose up -d
   ```

3. **Configure environment variables** (`.env.local`):
   ```env
   OPENAI_API_KEY=your-openai-key
   ARCHITECT_MODEL=openai
   CODER_MODEL=openai
   QA_MODEL=gpt-4o
   REDIS_URL=redis://localhost:6379
   ```

4. **Run the development server:**
   ```bash
   npm run dev
   ```

5. **Open** [http://localhost:3000](http://localhost:3000)

## Usage

Enter a website URL and click "Clone Website". The agent will:
1. Analyze the website structure
2. Create a component plan
3. Generate React code
4. Validate with vision AI
5. Display results with live preview

## Model Configuration

Set in `.env.local`:
- `ARCHITECT_MODEL`: `openai` | `claude` | `gemini`
- `CODER_MODEL`: `openai` | `claude` | `gemini`
- `QA_MODEL`: `gpt-4o` | `gemini`

## Project Structure

```
lib/
  agent/
    nodes/        # Agent nodes (scout, architect, coder, qa)
    graph.ts     # LangGraph orchestration
  config.ts      # Model configuration
  types.ts       # TypeScript interfaces
app/
  api/
    clone/       # Clone endpoint
    stream/      # SSE streaming endpoint
  page.tsx       # Main UI
```

## License

MIT
