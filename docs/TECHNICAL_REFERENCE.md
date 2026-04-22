# ReDo! v2 — Technical Reference

> Complete specification of every file, struct, function, and interaction.
> Consult this document during development to ensure consistency.

---

## 1. `cmd/redo/main.go`

Entry point. Initializes dependencies and starts the TUI.

```go
func main()
  // 1. Load config from ~/.redo/projects.json
  // 2. Connect to MySQL
  // 3. Initialize Gemini embedding client
  // 4. Wire services (dependency injection)
  // 5. Start bubbletea program with ui.NewApp(...)
```

**Dependencies created here (injected into services):**
- `config.JSONConfig` → reads/writes projects.json
- `persistence.MySQLConn` → MySQL connection pool
- `embedding.GeminiClient` → Gemini API for embeddings
- All services receive interfaces, not concrete types

---

## 2. `internal/domain/` — Entities & Interfaces

Zero external dependencies. Pure data structures and interface definitions.

### 2.1 `agent.go`

```go
// Agent represents a code-agent configuration within a project.
type Agent struct {
    Name    string            // unique within project, e.g. "backend"
    Command string            // spawn command, e.g. "kiro-cli chat"
    Color   string            // hex color for UI, e.g. "#f0883e"
    CLIType string            // "kiro" | "gemini" | "claude" | "codex"
    MCPs    map[string]any    // MCP server configs to inject
    WorkDir string            // override workdir (empty = project path)
}
```

### 2.2 `project.go`

```go
// Project represents a workspace with agents and knowledge bases.
type Project struct {
    Name   string   // display name
    Path   string   // absolute path to project root
    KBDocs []string // relative paths to docs for KB indexing (e.g. "docs/", "README.md")
    Agents []Agent  // agents configured for this project
}
```

### 2.3 `session.go`

```go
// Session represents an active terminal session (one agent running).
type Session struct {
    ID        string    // UUID
    ProjectID string    // which project
    AgentName string    // which agent
    StartedAt time.Time
    Active    bool
}
```

### 2.4 `message.go`

```go
// Message represents one turn in a conversation.
type Message struct {
    ID        int64
    SessionID string
    Project   string
    Agent     string
    Role      string    // "user" | "assistant"
    Content   string
    Timestamp time.Time
    Embedding []float32 // nil until computed
}
```

### 2.5 `kb_chunk.go`

```go
// KBChunk represents an indexed piece of documentation.
type KBChunk struct {
    ID         int64
    Project    string
    SourceFile string    // relative path of original doc
    Content    string
    ChunkIndex int       // position within the source file
    Embedding  []float32
}
```

### 2.6 `ports.go`

All interfaces that infrastructure must implement. Services depend ONLY on these.

```go
// --- Persistence ---

type MessageRepository interface {
    Save(msg *Message) error
    FindBySession(sessionID string) ([]Message, error)
    FindRelevant(project string, embedding []float32, limit int) ([]Message, error)
    SaveCompressedSummary(sessionID string, summary string) error
    GetCompressedSummary(sessionID string) (string, error)
}

type KBRepository interface {
    SaveChunk(chunk *KBChunk) error
    FindRelevant(project string, embedding []float32, limit int) ([]KBChunk, error)
    DeleteBySource(project string, sourceFile string) error
}

type ConfigRepository interface {
    LoadProjects() ([]Project, error)
    SaveProjects(projects []Project) error
}

// --- Terminal ---

// TerminalDriver knows how to interact with a specific CLI agent type.
type TerminalDriver interface {
    Name() string                          // "kiro", "gemini", "claude"
    SpawnCommand(agent Agent) string       // full command to spawn
    SessionSavePath(homeDir string) string // where this agent saves conversation files
    ParseSessionFile(path string) ([]Message, error) // parse saved session into messages
    WriteSessionFile(path string, messages []Message) error // rewrite session with curated messages
}

// Terminal represents a running PTY process.
type Terminal interface {
    Write(input string) error
    Read() <-chan []byte   // channel of raw output bytes
    Resize(rows, cols int) error
    Kill() error
    IsAlive() bool
}

// --- Embedding ---

type EmbeddingProvider interface {
    Embed(text string) ([]float32, error)
    EmbedBatch(texts []string) ([][]float32, error)
}

// --- LLM (for compression) ---

type LLMProvider interface {
    Compress(messages []Message) (string, error) // summarize messages into compact text
}
```

---

## 3. `internal/service/` — Business Logic

Each service has a single responsibility. Depends only on `domain` interfaces.

### 3.1 `terminal_service.go`

Manages PTY lifecycle and input routing.

```go
type TerminalService struct {
    drivers map[string]TerminalDriver // "kiro" -> KiroDriver, etc.
    active  map[string]Terminal       // sessionID -> running terminal
    envBuilder *terminal.EnvBuilder   // builds clean HOME + MCPs
}

// SpawnAgent creates a PTY for an agent in a project.
// 1. Build clean HOME via envBuilder (temp dir, symlinks, MCP config)
// 2. Get driver for agent.CLIType
// 3. Spawn PTY with driver.SpawnCommand()
// 4. Return Session + Terminal
func (s *TerminalService) SpawnAgent(project Project, agent Agent) (*Session, Terminal, error)

// SendInput writes user text to one or more terminals.
// Called by UI when user submits from the central input box.
// If injectedContext != "", prepends it to the input.
func (s *TerminalService) SendInput(sessionIDs []string, text string, injectedContext string) error

// KillSession terminates a terminal.
func (s *TerminalService) KillSession(sessionID string) error

// ActiveSessions returns all running sessions for a project.
func (s *TerminalService) ActiveSessions(projectName string) []Session

// GetTerminal returns the Terminal for reading output (used by UI).
func (s *TerminalService) GetTerminal(sessionID string) Terminal
```

**Interactions:**
- Called by `ui/app.go` when user creates/kills agents or sends input
- Uses `infra/terminal/pty.go` for PTY spawn
- Uses `infra/terminal/env.go` for HOME setup
- Uses `infra/terminal/driver.go` for CLI-specific behavior

### 3.2 `conversation_service.go`

Captures conversations from agent save files and persists them.

```go
type ConversationService struct {
    repo       MessageRepository
    embedder   EmbeddingProvider
    drivers    map[string]TerminalDriver // to know where/how each agent saves
    watcher    *watcher.SessionWatcher
    sessions   map[string]*Session       // active sessions being watched
}

// StartWatching begins monitoring the save file for a session.
// 1. Get driver for the agent type
// 2. Resolve save file path (driver.SessionSavePath)
// 3. Start fsnotify watcher on that path
// 4. On change: parse new messages, compute embeddings, save to MySQL
func (c *ConversationService) StartWatching(session *Session, homeDir string) error

// StopWatching stops monitoring a session.
func (c *ConversationService) StopWatching(sessionID string)

// GetHistory returns all messages for a session from MySQL.
func (c *ConversationService) GetHistory(sessionID string) ([]Message, error)

// SearchRelevant finds messages relevant to a query across all sessions of a project.
// Used by KnowledgeService and CurationService.
func (c *ConversationService) SearchRelevant(project string, query string, limit int) ([]Message, error)
```

**Interactions:**
- Started by `TerminalService.SpawnAgent` (after spawn, start watching)
- Uses `infra/watcher/session_watcher.go` for fsnotify
- Uses `TerminalDriver.ParseSessionFile` to read agent saves
- Uses `EmbeddingProvider` to compute embeddings
- Uses `MessageRepository` to persist
- Called by `CurationService` and `KnowledgeService` for search

### 3.3 `knowledge_service.go`

Indexes documentation and provides semantic search across KB + conversations.

```go
type KnowledgeService struct {
    kbRepo   KBRepository
    convSvc  *ConversationService // for searching conversations too
    embedder EmbeddingProvider
}

// IndexDocument reads a file, chunks it, computes embeddings, saves to MySQL.
// Chunk strategy: split by headings (markdown) or by N lines (code/text).
func (k *KnowledgeService) IndexDocument(project string, filePath string) error

// IndexDirectory indexes all supported files in a directory recursively.
func (k *KnowledgeService) IndexDirectory(project string, dirPath string) error

// Search finds relevant chunks from KB docs + past conversations.
// Returns unified results sorted by relevance.
func (k *KnowledgeService) Search(project string, query string, limit int) ([]SearchResult, error)

// RemoveDocument removes all chunks for a source file.
func (k *KnowledgeService) RemoveDocument(project string, filePath string) error

// SearchResult combines KB chunks and conversation messages.
type SearchResult struct {
    Source  string  // "kb" | "conversation"
    Content string
    Score   float32
    File    string  // source file (KB) or session ID (conversation)
}
```

**Interactions:**
- Called by `InjectionService` to find context for prompt injection
- Called by `CurationService` to rank messages
- Uses `ConversationService.SearchRelevant` for conversation search
- Uses `KBRepository` for KB chunk search
- Uses `EmbeddingProvider` for query embedding

### 3.4 `curation_service.go`

Manages context window: selects relevant messages, compresses the rest, rewrites session files.

```go
type CurationService struct {
    convSvc    *ConversationService
    knowledgeSvc *KnowledgeService
    embedder   EmbeddingProvider
    llm        LLMProvider           // for compressing discarded messages
    drivers    map[string]TerminalDriver
    maxTokens  int                   // configurable token budget
}

// CurateContext prepares an optimized session file before sending user input.
// 1. Get full history from MySQL
// 2. Embed the user's new input
// 3. Rank all messages by relevance to the input
// 4. Select: last N messages (continuity) + top-K relevant (detail)
// 5. Compress the rest into a summary (LLM call, cached)
// 6. Rewrite the agent's session file: [summary] + selected messages
// 7. Return stats (tokens saved, messages filtered)
func (c *CurationService) CurateContext(session *Session, homeDir string, userInput string) (*CurationResult, error)

type CurationResult struct {
    TotalMessages    int
    SelectedMessages int
    CompressedCount  int
    TokensBefore     int // estimated
    TokensAfter      int // estimated
    SummaryText      string
}

// getOrCreateSummary returns cached summary or creates new one.
// Only recompresses when new discarded messages accumulate above threshold.
func (c *CurationService) getOrCreateSummary(sessionID string, discarded []Message) (string, error)
```

**Interactions:**
- Called by `ui/app.go` BEFORE sending input to terminal
- Uses `ConversationService.GetHistory` for full message list
- Uses `EmbeddingProvider` to embed user input for ranking
- Uses `LLMProvider.Compress` for summary generation
- Uses `TerminalDriver.WriteSessionFile` to rewrite the agent's session
- Uses `MessageRepository.SaveCompressedSummary` to cache summaries

### 3.5 `injection_service.go`

Prepends KB context to user input.

```go
type InjectionService struct {
    knowledgeSvc *KnowledgeService
    enabled      bool // user can toggle
}

// EnrichInput searches KB for context relevant to the user's input
// and prepends it as a context block.
// Returns the enriched input + what was injected (for UI display).
func (i *InjectionService) EnrichInput(project string, userInput string) (enriched string, injected string, err error)

// SetEnabled toggles injection on/off.
func (i *InjectionService) SetEnabled(enabled bool)
```

**Interactions:**
- Called by `ui/app.go` BEFORE sending input to terminal (after curation)
- Uses `KnowledgeService.Search` to find relevant context
- Returns enriched text that `TerminalService.SendInput` sends to PTY

---

## 4. `internal/infra/` — Concrete Implementations

### 4.1 `terminal/pty.go`

```go
// PtyTerminal wraps a real PTY process.
type PtyTerminal struct {
    cmd     *exec.Cmd
    pty     *os.File       // from creack/pty
    output  chan []byte     // buffered output channel
    alive   bool
}

func NewPtyTerminal(command string, workDir string, env map[string]string) (*PtyTerminal, error)
// Spawns process via creack/pty.Start(), starts goroutine reading output into channel.

func (p *PtyTerminal) Write(input string) error   // writes to pty fd
func (p *PtyTerminal) Read() <-chan []byte         // returns output channel
func (p *PtyTerminal) Resize(rows, cols int) error // pty.Setsize
func (p *PtyTerminal) Kill() error                 // signal + wait
func (p *PtyTerminal) IsAlive() bool
```

### 4.2 `terminal/driver.go`

```go
// Registry of CLI drivers. Each knows how its agent saves sessions.
var Drivers = map[string]TerminalDriver{
    "kiro":   &KiroDriver{},
    "gemini": &GeminiDriver{},
    "claude": &ClaudeDriver{},
}

// --- KiroDriver ---
type KiroDriver struct{}
func (d *KiroDriver) Name() string { return "kiro" }
func (d *KiroDriver) SpawnCommand(a Agent) string { return a.Command } // "kiro-cli chat"
func (d *KiroDriver) SessionSavePath(homeDir string) string
    // Returns ~/.kiro/chats/ directory — watch for new/modified .json files
func (d *KiroDriver) ParseSessionFile(path string) ([]Message, error)
    // Reads kiro's JSON format, extracts role + content per message
func (d *KiroDriver) WriteSessionFile(path string, msgs []Message) error
    // Writes back in kiro's format (for context curation)

// --- GeminiDriver ---
type GeminiDriver struct{}
// Same interface, different paths and formats (~/.gemini/conversations/)

// --- ClaudeDriver ---
type ClaudeDriver struct{}
// Same interface, different paths and formats (~/.claude/)
```

### 4.3 `terminal/env.go`

```go
// EnvBuilder creates isolated HOME directories for agents.
type EnvBuilder struct {
    homeAllowlist []string // symlinked from real HOME: .config, .local, .bashrc, etc.
    homeCopylist  []string // deep-copied: .kiro, .gemini, .claude
}

// BuildEnv creates a temp HOME with symlinks + MCP config for an agent.
// 1. mkdtemp
// 2. Symlink allowlisted items from real HOME
// 3. Copy CLI-specific dirs (e.g. .kiro/)
// 4. Write MCP config (mcp.json for kiro, settings.json for gemini)
// 5. Return env map with HOME=tmpdir
func (e *EnvBuilder) BuildEnv(agent Agent) (env map[string]string, homeDir string, err error)

// Cleanup removes a temp HOME.
func (e *EnvBuilder) Cleanup(homeDir string)
```

### 4.4 `persistence/mysql.go`

```go
type MySQLConn struct {
    db *sql.DB
}

func NewMySQLConn(dsn string) (*MySQLConn, error)
// Opens connection pool, runs migrations (CREATE TABLE IF NOT EXISTS)

func (m *MySQLConn) MessageRepo() *MySQLMessageRepo
func (m *MySQLConn) KBRepo() *MySQLKBRepo
```

### 4.5 `persistence/conversation_repo.go`

Implements `domain.MessageRepository`.

```go
type MySQLMessageRepo struct { db *sql.DB }

func (r *MySQLMessageRepo) Save(msg *Message) error
    // INSERT INTO conversations (project, agent, role, content, timestamp, embedding, session_id)

func (r *MySQLMessageRepo) FindBySession(sessionID string) ([]Message, error)
    // SELECT * FROM conversations WHERE session_id = ? ORDER BY timestamp

func (r *MySQLMessageRepo) FindRelevant(project string, emb []float32, limit int) ([]Message, error)
    // Load all embeddings for project, compute cosine similarity in Go, return top-N
    // (MySQL doesn't have native vector search — we do it in-memory)

func (r *MySQLMessageRepo) SaveCompressedSummary(sessionID string, summary string) error
    // INSERT/UPDATE in a summaries table

func (r *MySQLMessageRepo) GetCompressedSummary(sessionID string) (string, error)
```

### 4.6 `persistence/kb_repo.go`

Implements `domain.KBRepository`.

```go
type MySQLKBRepo struct { db *sql.DB }

func (r *MySQLKBRepo) SaveChunk(chunk *KBChunk) error
func (r *MySQLKBRepo) FindRelevant(project string, emb []float32, limit int) ([]KBChunk, error)
func (r *MySQLKBRepo) DeleteBySource(project string, sourceFile string) error
```

### 4.7 `embedding/gemini.go`

Implements `domain.EmbeddingProvider`.

```go
type GeminiClient struct {
    apiKey string
    model  string // "text-embedding-004"
}

func NewGeminiClient(apiKey string) *GeminiClient

func (g *GeminiClient) Embed(text string) ([]float32, error)
    // POST to Gemini embedding API, return vector

func (g *GeminiClient) EmbedBatch(texts []string) ([][]float32, error)
    // Batch embed, respecting rate limits
```

### 4.8 `watcher/session_watcher.go`

```go
type SessionWatcher struct {
    fsWatcher *fsnotify.Watcher
    callbacks map[string]func(path string) // path -> callback on change
}

func NewSessionWatcher() (*SessionWatcher, error)

// Watch starts monitoring a file/directory for changes.
func (w *SessionWatcher) Watch(path string, onChange func(path string)) error

// Unwatch stops monitoring.
func (w *SessionWatcher) Unwatch(path string)

// Run starts the event loop (call in goroutine).
func (w *SessionWatcher) Run(ctx context.Context)
```

### 4.9 `config/json_config.go`

Implements `domain.ConfigRepository`.

```go
type JSONConfig struct {
    path string // ~/.redo/projects.json
}

func NewJSONConfig() *JSONConfig
    // Uses ~/.redo/projects.json, creates if not exists

func (c *JSONConfig) LoadProjects() ([]Project, error)
func (c *JSONConfig) SaveProjects(projects []Project) error
```

---

## 5. `internal/ui/` — Bubbletea Views

### 5.1 `app.go`

Root bubbletea model. Composes all views.

```go
type App struct {
    // Services (injected)
    termSvc     *service.TerminalService
    convSvc     *service.ConversationService
    knowledgeSvc *service.KnowledgeService
    curationSvc *service.CurationService
    injectionSvc *service.InjectionService
    configRepo  domain.ConfigRepository

    // UI state
    projects    []domain.Project
    activeTab   int              // which project tab is active
    panes       []*TerminalPane  // terminal panes for active project
    inputBox    *InputBox
    focusedPane int              // which pane has focus (for @-less input)
    width, height int
}

func NewApp(...services) *App

func (a *App) Init() tea.Cmd
    // Load projects, restore last state

func (a *App) Update(msg tea.Msg) (tea.Model, tea.Cmd)
    // Route key events:
    //   Ctrl+N → spawn new agent (prompt for config)
    //   Ctrl+W → kill focused agent
    //   Ctrl+Tab → cycle focus between panes
    //   Tab in input → autocomplete @agent names
    //   Enter in input → process input (see below)
    //   Resize → propagate to panes

    // On Enter in input box:
    // 1. Parse @mentions from input text
    // 2. Resolve target session IDs
    // 3. CurationService.CurateContext (rewrite session file)
    // 4. InjectionService.EnrichInput (prepend KB context)
    // 5. TerminalService.SendInput (write to PTY)

func (a *App) View() string
    // Compose: project tabs + split panes + input box + status bar
```

### 5.2 `project_tabs.go`

```go
type ProjectTabs struct {
    projects []domain.Project
    active   int
}

func (t *ProjectTabs) View(width int) string
    // Render horizontal tabs: [Project A] [Project B] [Project C]
    // Active tab highlighted with lipgloss
```

### 5.3 `terminal_pane.go`

```go
type TerminalPane struct {
    session  *domain.Session
    terminal domain.Terminal
    agent    domain.Agent
    buffer   []string  // rendered lines (from PTY output)
    scroll   int       // scroll offset
    focused  bool
    width, height int
}

func NewTerminalPane(session *Session, terminal Terminal, agent Agent) *TerminalPane

func (p *TerminalPane) Update(msg tea.Msg) tea.Cmd
    // Read from terminal.Read() channel, append to buffer
    // Handle scroll (mouse wheel, Page Up/Down)

func (p *TerminalPane) View() string
    // Render: agent name header (colored) + terminal output buffer
    // Border color = agent.Color, thicker if focused
```

### 5.4 `split_layout.go`

```go
type SplitLayout struct {
    panes []*TerminalPane
    width, height int
}

func (s *SplitLayout) View() string
    // If 1 pane: full width
    // If 2 panes: 50/50 horizontal split
    // If 3+ panes: grid layout
    // Each pane gets (width/cols, height/rows) minus borders

func (s *SplitLayout) AddPane(pane *TerminalPane)
func (s *SplitLayout) RemovePane(index int)
func (s *SplitLayout) Resize(width, height int)
```

### 5.5 `input_box.go`

```go
type InputBox struct {
    text       string
    cursor     int
    agents     []string // available agent names for autocomplete
    injected   string   // last injected context (shown to user)
    showInject bool     // toggle visibility of injection preview
}

func (i *InputBox) Update(msg tea.Msg) tea.Cmd
    // Handle typing, cursor movement, Tab (autocomplete @agent), Enter (submit)

func (i *InputBox) View() string
    // Render: [injection preview if any] + text input + agent indicators

func (i *InputBox) Submit() (text string, targets []string)
    // Parse @mentions from text, return clean text + list of target agent names
    // "@backend @frontend fix the bug" → ("fix the bug", ["backend", "frontend"])

func (i *InputBox) SetInjected(text string)
    // Show what KB context was injected (for transparency)
```

### 5.6 `kb_sidebar.go`

```go
type KBSidebar struct {
    results   []service.SearchResult // last KB search results
    visible   bool
    width     int
}

func (s *KBSidebar) View() string
    // Render: list of relevant KB snippets found for current context
    // Each result shows: source (file or conversation), score, preview

func (s *KBSidebar) SetResults(results []service.SearchResult)
func (s *KBSidebar) Toggle()
```

### 5.7 `styles.go`

```go
// Lipgloss style definitions
var (
    TabStyle       lipgloss.Style // inactive tab
    ActiveTabStyle lipgloss.Style // active tab
    PaneStyle      lipgloss.Style // terminal pane border
    FocusedPane    lipgloss.Style // focused pane border (brighter)
    InputStyle     lipgloss.Style // input box
    SidebarStyle   lipgloss.Style // KB sidebar
    StatusStyle    lipgloss.Style // bottom status bar
)

// AgentColor returns a lipgloss.Color from hex string.
func AgentColor(hex string) lipgloss.Color
```

---

## 6. Data Flow Summary

### User sends a message:
```
InputBox.Submit()
  → parse @mentions → target agents
  → CurationService.CurateContext(session, homeDir, userInput)
      → ConversationService.GetHistory(sessionID) → all messages from MySQL
      → EmbeddingProvider.Embed(userInput) → query vector
      → rank messages by cosine similarity
      → select top-K + last N
      → LLMProvider.Compress(discarded) → summary (cached)
      → TerminalDriver.WriteSessionFile(curated messages)
      → return CurationResult
  → InjectionService.EnrichInput(project, userInput)
      → KnowledgeService.Search(project, userInput)
      → prepend context block to input
      → return enriched input + injected text
  → TerminalService.SendInput(sessionIDs, enrichedInput)
      → PtyTerminal.Write(enrichedInput) for each target
  → InputBox.SetInjected(injectedText) → show in UI
```

### Agent produces output:
```
PtyTerminal goroutine reads PTY fd
  → sends bytes to output channel
  → TerminalPane.Update() reads channel
  → appends to display buffer
  → UI re-renders

Meanwhile (async):
  Agent saves session to file
  → fsnotify detects change
  → ConversationService callback fires
  → TerminalDriver.ParseSessionFile() → new messages
  → EmbeddingProvider.EmbedBatch(new messages)
  → MessageRepository.Save() → MySQL
```

### User opens project:
```
App.switchProject(index)
  → load project config
  → for each agent in project:
      → TerminalService.SpawnAgent(project, agent)
          → EnvBuilder.BuildEnv(agent) → temp HOME + MCPs
          → PtyTerminal.New(command, workDir, env)
          → ConversationService.StartWatching(session, homeDir)
      → create TerminalPane
  → SplitLayout.AddPane() for each
```

---

## 7. MySQL Schema

```sql
CREATE TABLE conversations (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    project VARCHAR(255) NOT NULL,
    agent VARCHAR(100) NOT NULL,
    role ENUM('user', 'assistant') NOT NULL,
    content TEXT NOT NULL,
    timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    embedding BLOB,
    session_id VARCHAR(36) NOT NULL,
    INDEX idx_project (project),
    INDEX idx_session (session_id),
    FULLTEXT idx_content (content)
);

CREATE TABLE kb_chunks (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    project VARCHAR(255) NOT NULL,
    source_file VARCHAR(500),
    content TEXT NOT NULL,
    embedding BLOB,
    chunk_index INT DEFAULT 0,
    INDEX idx_project (project),
    FULLTEXT idx_content (content)
);

CREATE TABLE summaries (
    session_id VARCHAR(36) PRIMARY KEY,
    summary TEXT NOT NULL,
    message_count INT NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

---

## 8. Config File Format

`~/.redo/projects.json`:

```json
{
  "mysql_dsn": "user:pass@tcp(localhost:3306)/redo",
  "gemini_api_key": "...",
  "curation": {
    "max_tokens": 16000,
    "keep_last_n": 5,
    "top_k_relevant": 15,
    "recompress_threshold": 20
  },
  "projects": [
    {
      "name": "SGABE",
      "path": "/home/joao/Documentos/sgabePrototipos",
      "kb_docs": ["docs/", "Knowledge.md"],
      "agents": [
        {
          "name": "backend",
          "command": "kiro-cli chat",
          "color": "#f0883e",
          "cli_type": "kiro",
          "mcps": {}
        },
        {
          "name": "frontend",
          "command": "gemini",
          "color": "#1f6feb",
          "cli_type": "gemini",
          "mcps": {}
        }
      ]
    }
  ]
}
```

---

## 9. Key Design Decisions

1. **Services depend on interfaces (ports.go), not implementations** — swap MySQL for Postgres, Gemini for OpenAI, without touching business logic.

2. **Drivers are the extension point for new agents** — add a new `TerminalDriver` implementation, register in `driver.go`, done. No other code changes.

3. **Curation happens BEFORE input is sent** — the session file is rewritten, then the input goes to the PTY. The agent reads the curated history naturally.

4. **Conversation capture is async** — fsnotify watches save files in background. No blocking on the main UI thread.

5. **Embeddings are computed on save, not on search** — messages get embedded when captured. Search is just cosine similarity on pre-computed vectors.

6. **Summary compression is cached** — only recompresses when new discarded messages exceed threshold. Avoids redundant LLM calls.
