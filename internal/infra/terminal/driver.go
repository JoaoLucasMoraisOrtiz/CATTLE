package terminal

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/jlortiz/redo/internal/domain"
	_ "github.com/mattn/go-sqlite3"
)

// Drivers maps CLI type names to their driver implementations.
var Drivers = map[string]domain.TerminalDriver{
	"kiro":   &KiroDriver{},
	"gemini": &GeminiDriver{},
	"claude": &ClaudeDriver{},
	"codex":  &CodexDriver{},
}

// --- Kiro Driver ---

type KiroDriver struct{}

func (d *KiroDriver) Name() string { return "kiro" }
func (d *KiroDriver) SpawnCommand(a domain.Agent) string {
	if a.Command != "" {
		return a.Command
	}
	return "kiro-cli chat"
}

func (d *KiroDriver) ResumeCommand(a domain.Agent) string {
	base := d.SpawnCommand(a)
	return base + " --resume"
}

func (d *KiroDriver) SessionSavePath(homeDir string) string {
	return filepath.Join(homeDir, ".local", "share", "kiro-cli", "data.sqlite3")
}

// ParseSessionFile reads the latest conversation for a workdir from Kiro's SQLite.
// path = workdir to filter by (key column).
func (d *KiroDriver) ParseSessionFile(path string) ([]domain.Message, error) {
	// Kiro's .local is symlinked, so real HOME works
	home, _ := os.UserHomeDir()
	dbPath := d.SessionSavePath(home)

	db, err := sql.Open("sqlite3", dbPath+"?mode=ro")
	if err != nil {
		return nil, err
	}
	defer db.Close()

	var raw string
	err = db.QueryRow(
		"SELECT value FROM conversations_v2 WHERE key = ? ORDER BY updated_at DESC LIMIT 1",
		path,
	).Scan(&raw)
	if err != nil {
		return nil, err
	}

	var conv struct {
		History []struct {
			User      struct{ Content json.RawMessage } `json:"user"`
			Assistant json.RawMessage                    `json:"assistant"`
		} `json:"history"`
	}
	if err := json.Unmarshal([]byte(raw), &conv); err != nil {
		return nil, err
	}

	var msgs []domain.Message
	for _, turn := range conv.History {
		if u := kiroUserText(turn.User.Content); u != "" {
			msgs = append(msgs, domain.Message{Role: "user", Content: u})
		}
		if a := kiroAssistantText(turn.Assistant); a != "" {
			msgs = append(msgs, domain.Message{Role: "assistant", Content: a})
		}
	}
	return msgs, nil
}

func (d *KiroDriver) WriteSessionFile(_ string, _ []domain.Message) error { return nil }

func kiroUserText(raw json.RawMessage) string {
	var obj map[string]json.RawMessage
	if json.Unmarshal(raw, &obj) != nil {
		return ""
	}
	if p, ok := obj["Prompt"]; ok {
		var v struct{ Prompt string }
		if json.Unmarshal(p, &v) == nil && !strings.Contains(v.Prompt, "redacted") {
			return v.Prompt
		}
	}
	return ""
}

func kiroAssistantText(raw json.RawMessage) string {
	var obj map[string]json.RawMessage
	if json.Unmarshal(raw, &obj) != nil {
		return ""
	}
	// Try Text, Response, ToolUse — all have a content/string field
	if v, ok := obj["Text"]; ok {
		var s string
		json.Unmarshal(v, &s)
		return s
	}
	if v, ok := obj["Response"]; ok {
		var r struct{ Content string }
		json.Unmarshal(v, &r)
		return r.Content
	}
	if v, ok := obj["ToolUse"]; ok {
		var r struct{ Content string }
		json.Unmarshal(v, &r)
		return r.Content
	}
	return ""
}

// --- Gemini Driver ---

type GeminiDriver struct{}

func (d *GeminiDriver) Name() string { return "gemini" }
func (d *GeminiDriver) SpawnCommand(a domain.Agent) string {
	if a.Command != "" {
		return a.Command
	}
	return "gemini"
}

func (d *GeminiDriver) ResumeCommand(a domain.Agent) string {
	base := d.SpawnCommand(a)
	return base + " --resume latest"
}

func (d *GeminiDriver) SessionSavePath(homeDir string) string {
	return filepath.Join(homeDir, ".gemini", "tmp")
}

// ParseSessionFile reads a Gemini session JSON.
// path = isolated HOME dir; finds the latest session file automatically.
func (d *GeminiDriver) ParseSessionFile(path string) ([]domain.Message, error) {
	// If path is a directory (HOME), find latest session file under .gemini/tmp/*/chats/
	if info, err := os.Stat(path); err == nil && info.IsDir() {
		latest, err := d.findLatestSession(path)
		if err != nil {
			return nil, err
		}
		path = latest
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var session struct {
		Messages []struct {
			Type    string            `json:"type"`
			Content []json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(data, &session); err != nil {
		return nil, err
	}

	var msgs []domain.Message
	for _, m := range session.Messages {
		if m.Type == "info" || m.Type == "error" {
			continue
		}
		text := geminiContentText(m.Content)
		if text == "" {
			continue
		}
		role := "user"
		if m.Type != "user" {
			role = "assistant"
		}
		msgs = append(msgs, domain.Message{Role: role, Content: text})
	}
	return msgs, nil
}

func (d *GeminiDriver) WriteSessionFile(path string, msgs []domain.Message) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var session map[string]any
	if err := json.Unmarshal(data, &session); err != nil {
		return err
	}

	var out []map[string]any
	for _, m := range msgs {
		t := "user"
		if m.Role == "assistant" {
			t = "model"
		}
		out = append(out, map[string]any{
			"timestamp": time.Now().UTC().Format(time.RFC3339),
			"type":      t,
			"content":   []map[string]string{{"text": m.Content}},
		})
	}
	session["messages"] = out
	session["lastUpdated"] = time.Now().UTC().Format(time.RFC3339)

	b, _ := json.MarshalIndent(session, "", "  ")
	return os.WriteFile(path, b, 0644)
}

func (d *GeminiDriver) findLatestSession(homeDir string) (string, error) {
	base := filepath.Join(homeDir, ".gemini", "tmp")
	var files []string
	filepath.Walk(base, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		if strings.HasPrefix(info.Name(), "session-") && strings.HasSuffix(info.Name(), ".json") {
			files = append(files, path)
		}
		return nil
	})
	if len(files) == 0 {
		return "", os.ErrNotExist
	}
	sort.Slice(files, func(i, j int) bool {
		fi, _ := os.Stat(files[i])
		fj, _ := os.Stat(files[j])
		return fi.ModTime().After(fj.ModTime())
	})
	return files[0], nil
}

func geminiContentText(parts []json.RawMessage) string {
	var sb strings.Builder
	for _, raw := range parts {
		// Try as object {"text": "..."}
		var obj struct{ Text string }
		if json.Unmarshal(raw, &obj) == nil && obj.Text != "" {
			sb.WriteString(obj.Text)
			continue
		}
		// Try as plain string
		var s string
		if json.Unmarshal(raw, &s) == nil {
			sb.WriteString(s)
		}
	}
	return sb.String()
}

// --- Claude Driver ---

type ClaudeDriver struct{}

func (d *ClaudeDriver) Name() string { return "claude" }
func (d *ClaudeDriver) SpawnCommand(a domain.Agent) string {
	if a.Command != "" {
		return a.Command
	}
	return "claude"
}
func (d *ClaudeDriver) ResumeCommand(a domain.Agent) string {
	return d.SpawnCommand(a) + " --resume"
}
func (d *ClaudeDriver) SessionSavePath(homeDir string) string {
	return filepath.Join(homeDir, ".claude", "projects")
}

func (d *ClaudeDriver) ParseSessionFile(path string) ([]domain.Message, error) {
	// Claude saves in ~/.claude/projects/<hash>/<session>.jsonl
	// path = HOME dir, find latest session
	base := filepath.Join(path, ".claude", "projects")
	latest, err := findLatestFile(base, ".jsonl")
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(latest)
	if err != nil {
		return nil, err
	}
	var msgs []domain.Message
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if line == "" {
			continue
		}
		var entry map[string]any
		if json.Unmarshal([]byte(line), &entry) != nil {
			continue
		}
		role, _ := entry["role"].(string)
		if role != "user" && role != "assistant" {
			continue
		}
		content := ""
		if c, ok := entry["content"].(string); ok {
			content = c
		} else if parts, ok := entry["content"].([]any); ok {
			for _, p := range parts {
				if m, ok := p.(map[string]any); ok {
					if t, ok := m["text"].(string); ok {
						content += t
					}
				}
			}
		}
		if content != "" {
			msgs = append(msgs, domain.Message{Role: role, Content: content})
		}
	}
	return msgs, nil
}

func (d *ClaudeDriver) WriteSessionFile(_ string, _ []domain.Message) error { return nil }

// --- Codex Driver ---

type CodexDriver struct{}

func (d *CodexDriver) Name() string { return "codex" }
func (d *CodexDriver) SpawnCommand(a domain.Agent) string {
	if a.Command != "" {
		return a.Command
	}
	return "codex"
}
func (d *CodexDriver) ResumeCommand(a domain.Agent) string {
	return d.SpawnCommand(a) + " --resume"
}
func (d *CodexDriver) SessionSavePath(homeDir string) string {
	return filepath.Join(homeDir, ".codex", "sessions")
}

func (d *CodexDriver) ParseSessionFile(path string) ([]domain.Message, error) {
	// Codex saves in ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
	// path = HOME dir
	base := filepath.Join(path, ".codex", "sessions")
	latest, err := findLatestFile(base, ".jsonl")
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(latest)
	if err != nil {
		return nil, err
	}
	var msgs []domain.Message
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if line == "" {
			continue
		}
		var entry map[string]any
		if json.Unmarshal([]byte(line), &entry) != nil {
			continue
		}
		role, _ := entry["role"].(string)
		if role != "user" && role != "assistant" {
			continue
		}
		content := ""
		if c, ok := entry["content"].(string); ok {
			content = c
		} else if parts, ok := entry["content"].([]any); ok {
			for _, p := range parts {
				if m, ok := p.(map[string]any); ok {
					if t, ok := m["text"].(string); ok {
						content += t
					}
				}
			}
		}
		if content != "" {
			msgs = append(msgs, domain.Message{Role: role, Content: content})
		}
	}
	return msgs, nil
}

func (d *CodexDriver) WriteSessionFile(_ string, _ []domain.Message) error { return nil }

// --- Helpers ---

func findLatestFile(dir, ext string) (string, error) {
	var latest string
	var latestTime time.Time
	filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		if strings.HasSuffix(info.Name(), ext) && info.ModTime().After(latestTime) {
			latest = path
			latestTime = info.ModTime()
		}
		return nil
	})
	if latest == "" {
		return "", os.ErrNotExist
	}
	return latest, nil
}
