# memory-mcp-server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that provides persistent memory for AI assistants. Stores, searches, and associates conversation logs using hybrid search (FTS5 full-text + vector similarity) with A-MEM style note structuring.

## Features

- **Hybrid Search** -- FTS5 full-text search + vector similarity with RRF (Reciprocal Rank Fusion)
- **A-MEM Note Structuring** -- Automatic summary, keywords, tags, and context extraction via LLM
- **Associative Search** -- Serendipity-driven discovery through TF-IDF random walk and link exploration
- **Multi-backend Storage** -- SQLite (local), Turso (cloud), or Hybrid (local + cloud sync)
- **MEMORY.md / CLAUDE.md Integration** -- Auto-generated memory index and project context import
- **Data Export/Import** -- JSONL format for backup and migration
- **Structured Logging** -- Configurable log levels, output to stderr (MCP-safe)
- **Embedding Queue** -- Batched, async embedding generation for performance

## Installation

```bash
npm install memory-mcp-server
```

Or run directly:

```bash
npx memory-mcp-server
```

## Quick Start

### Claude Desktop Configuration

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "memory-mcp-server"],
      "env": {
        "MEMORY_DB_PATH": "/path/to/memory.db",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `MEMORY_DB_PATH` | Path to SQLite database file | `./memory.db` |
| `MEMORY_TENANT_ID` | Tenant ID for multi-tenant isolation | `default` |
| `MEMORY_STORAGE_TYPE` | Storage backend: `sqlite`, `turso`, `hybrid` | `sqlite` |
| `OPENAI_API_KEY` | OpenAI API key for embeddings + LLM structuring | _(optional)_ |
| `MEMORY_INDEX_PATH` | Path for auto-generated MEMORY.md | _(optional)_ |
| `CLAUDE_MD_PATH` | Path to CLAUDE.md project context | _(optional)_ |
| `TURSO_DATABASE_URL` | Turso database URL (for turso/hybrid mode) | _(optional)_ |
| `TURSO_AUTH_TOKEN` | Turso auth token (for turso/hybrid mode) | _(optional)_ |
| `MEMORY_SYNC_INTERVAL` | Hybrid sync interval in ms | `30000` |
| `MEMORY_SYNC_ON_WRITE` | Sync to cloud on every write | `false` |
| `MEMORY_LOG_LEVEL` | Log level: `debug`, `info`, `warn`, `error` | `info` |
| `MEMORY_LOG_FORMAT` | Log format: `text` or `json` | `text` |

## MCP Tools

### memory_save

Save a conversation message as a memory note. Automatically generates summary, keywords, tags, embeddings, and links when OpenAI API key is configured.

```
Parameters:
  content    (string, required)  -- The content to save
  role       (enum, required)    -- user | assistant | system | summary
  session_id (string, optional)  -- Session ID
  project    (string, optional)  -- Project name
  keywords   (string[], optional) -- Keywords (auto-generated if omitted)
  tags       (string[], optional) -- Tags (auto-generated if omitted)
```

### memory_search

Search memories using hybrid search (FTS5 + vector similarity with RRF fusion).

```
Parameters:
  query      (string, required)  -- Search query (keywords or natural language)
  date_from  (string, optional)  -- Filter: earliest date (ISO 8601)
  date_to    (string, optional)  -- Filter: latest date (ISO 8601)
  project    (string, optional)  -- Filter: project name
  tags       (string[], optional) -- Filter: tags
  session_id (string, optional)  -- Filter: session ID
  limit      (number, optional)  -- Max results (default: 10)
```

### memory_associate

Discover related memories through associative (serendipity) search.

```
Parameters:
  seed        (string, optional) -- Seed text (random if omitted)
  temperature (number, optional) -- 0.0=focused, 1.0=exploratory (default: 0.5)
  limit       (number, optional) -- Max results (default: 5)
```

### memory_stats

Get statistics about stored memories: total notes, sessions, links, date range, and top keywords.

### memory_summarize

Summarize memories for a given period or project using LLM.

```
Parameters:
  project   (string, optional) -- Filter by project
  date_from (string, optional) -- Start date (ISO 8601)
  date_to   (string, optional) -- End date (ISO 8601)
```

### memory_update_index

Update the MEMORY.md index file and optionally import CLAUDE.md content.

### memory_export

Export memory data as JSON Lines (JSONL) format for backup or migration.

```
Parameters:
  date_from        (string, optional)  -- Export from date
  date_to          (string, optional)  -- Export until date
  include_links    (boolean, optional) -- Include note links (default: true)
  include_sessions (boolean, optional) -- Include sessions (default: true)
```

### memory_import

Import memory data from JSONL format (from a previous export).

```
Parameters:
  data           (string, required) -- JSONL content to import
  merge_strategy (enum, optional)   -- skip (default) or overwrite
```

### memory_migrate

Migrate data between storage backends (e.g., SQLite to Turso).

### memory_sync_status

_(Hybrid mode only)_ Get sync status of the hybrid adapter.

## Architecture

```
                    MCP Client (Claude Desktop, etc.)
                              |
                         stdio transport
                              |
                    +-------------------+
                    |   MCP Server      |
                    |   (10 tools)      |
                    +-------------------+
                              |
          +-------------------+-------------------+
          |                   |                   |
    NoteBuilder         SearchEngine       AssociateEngine
    (LLM + Embed)       (FTS + Vec)        (Random Walk)
          |                   |                   |
          +-------------------+-------------------+
                              |
                    +-------------------+
                    |  StorageAdapter    |
                    |  (interface)       |
                    +---+-------+---+---+
                        |       |       |
                   SQLite   Turso   Hybrid
                  (local)  (cloud)  (sync)
```

### Key Components

- **NoteBuilder** -- A-MEM style note structuring with LLM (summary, keywords, tags, context) and embedding generation
- **SearchEngine** -- Hybrid search combining FTS5 BM25 scoring with vector cosine similarity via RRF
- **AssociateEngine** -- Serendipity search using TF-IDF random walk, link exploration, and vector space exploration with MMR diversity
- **EmbeddingQueue** -- Batched async embedding generation with configurable batch size and flush delay
- **ImportanceScorer** -- Multi-signal importance scoring (content, links, freshness, role)
- **DataTransfer** -- JSONL-based export/import for backup and migration
- **MemoryIndex** -- Auto-generates MEMORY.md with recent memories, frequent topics, and user preferences
- **ClaudeContext** -- Imports CLAUDE.md sections as searchable system notes
- **SessionManager** -- Session lifecycle with timeout-based auto-end and MEMORY.md update triggers
- **Logger** -- Structured logging to stderr with configurable levels (debug/info/warn/error)

### Storage Backends

| Backend | Use Case | Vector Search | FTS5 |
|---|---|---|---|
| **SQLite** | Local development, single machine | Yes (sqlite-vec) | Yes |
| **Turso** | Cloud deployment, multi-device | No | LIKE fallback |
| **Hybrid** | Best of both -- local speed + cloud sync | Yes (via local) | Yes (via local) |

## Graceful Degradation

The server works without an OpenAI API key:

- **Without API key**: FTS-only search, no auto-structuring, no embeddings
- **With API key**: Full hybrid search, LLM structuring, vector embeddings, auto-linking

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Run tests
npm test

# Type check
npm run typecheck

# Build
npm run build
```

## License

MIT
