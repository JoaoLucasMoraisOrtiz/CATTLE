package domain

import "os"

// Terminal represents a running PTY process.
type Terminal interface {
	Write(input string) error
	Read() <-chan []byte
	Resize(rows, cols int) error
	Kill() error
	IsAlive() bool
	Fd() *os.File // raw PTY fd for direct terminal rendering
}

// TerminalDriver knows how to interact with a specific CLI agent type.
type TerminalDriver interface {
	Name() string
	SpawnCommand(agent Agent) string
	ResumeCommand(agent Agent) string
	SessionSavePath(homeDir string) string
	ParseSessionFile(path string) ([]Message, error)
	WriteSessionFile(path string, messages []Message) error
}

// ConfigRepository loads/saves project configuration.
type ConfigRepository interface {
	LoadProjects() ([]Project, error)
	SaveProjects(projects []Project) error
}

// MessageRepository persists conversation messages.
type MessageRepository interface {
	Save(msg *Message) error
	FindBySession(sessionID string) ([]Message, error)
	FindRelevant(project string, embedding []float32, limit int) ([]Message, error)
	SaveCompressedSummary(sessionID string, summary string) error
	GetCompressedSummary(sessionID string) (string, error)
}

// KBRepository persists knowledge base chunks.
type KBRepository interface {
	SaveChunk(chunk *KBChunk) error
	FindRelevant(project string, embedding []float32, limit int) ([]KBChunk, error)
	DeleteBySource(project string, sourceFile string) error
}

// EmbeddingProvider computes text embeddings.
type EmbeddingProvider interface {
	Embed(text string) ([]float32, error)
	EmbedBatch(texts []string) ([][]float32, error)
}

// LLMProvider for compression/summarization.
type LLMProvider interface {
	Compress(messages []Message) (string, error)
}
