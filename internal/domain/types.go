package domain

// Agent represents a code-agent configuration within a project.
type Agent struct {
	Name    string         `json:"name"`
	Command string         `json:"command"`
	Color   string         `json:"color"`
	CLIType string         `json:"cli_type"`
	MCPs    map[string]any `json:"mcps,omitempty"`
	WorkDir string         `json:"work_dir,omitempty"`
}

// Project represents a workspace with agents and knowledge bases.
type Project struct {
	Name   string   `json:"name"`
	Path   string   `json:"path"`
	KBDocs []string `json:"kb_docs,omitempty"`
	Agents []Agent  `json:"agents"`
}

// Session represents an active terminal session.
type Session struct {
	ID        string
	Project   string
	AgentName string
	CLIType   string // kiro, gemini, claude
	HomeDir   string // temp HOME for this session
	Active    bool
}

// Message represents one turn in a conversation.
type Message struct {
	ID        int64
	SessionID string
	Project   string
	Agent     string
	Role      string // "user" | "assistant"
	Content   string
	Embedding []float32
}

// KBChunk represents an indexed piece of documentation.
type KBChunk struct {
	ID         int64
	Project    string
	SourceFile string
	Content    string
	ChunkIndex int
	Embedding  []float32
}

// SearchResult from knowledge or conversation search.
type SearchResult struct {
	Source  string  // "kb" | "conversation"
	Content string
	Score   float32
	File    string
}
