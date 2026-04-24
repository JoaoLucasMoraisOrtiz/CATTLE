package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/wailsapp/wails/v2/pkg/runtime"

	"github.com/jlortiz/redo/internal/domain"
	"github.com/jlortiz/redo/internal/infra/config"
	"github.com/jlortiz/redo/internal/infra/embedding"
	"github.com/jlortiz/redo/internal/infra/store"
	"github.com/jlortiz/redo/internal/infra/terminal"
	"github.com/jlortiz/redo/internal/service/codeview"
	ctxopt "github.com/jlortiz/redo/internal/service/context"
	"github.com/jlortiz/redo/internal/service/kb"
)

// App is the Wails bridge — its exported methods are callable from JS.
type App struct {
	ctx         context.Context
	config      domain.ConfigRepository
	terminals   map[string]*terminal.PtyTerminal
	sessions    map[string]*domain.Session
	mu          sync.Mutex
	msgRepo     *store.MessageRepo
	kbRepo      *store.KBRepo
	embedder    *embedding.Client
	embedServer *embedding.Server
	optimizer   *ctxopt.Optimizer
	tokenCache  *ctxopt.TokenCache
}

func NewApp(config domain.ConfigRepository) *App {
	return &App{
		config:    config,
		terminals: make(map[string]*terminal.PtyTerminal),
		sessions:  make(map[string]*domain.Session),
	}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	// Try to connect MySQL + embeddings (non-fatal if unavailable)
	a.initServices()
}

func (a *App) initServices() {
	cfg := a.config.(*config.JSONConfig)

	// SQLite — only if enabled
	if cfg.SQLiteEnabled() {
		db, err := store.Open()
		if err != nil {
			fmt.Printf("[Store] open failed: %v\n", err)
		} else {
			a.msgRepo = store.NewMessageRepo(db)
			a.kbRepo = store.NewKBRepo(db)
			fmt.Println("[Store] SQLite ready")
		}
	} else {
		a.msgRepo = nil
		a.kbRepo = nil
	}

	a.embedder = embedding.NewClient("")

	// Start Python embed server (updates script from embedded copy)
	go func() {
		srv, err := embedding.StartServer(9999)
		if err != nil {
			fmt.Printf("[Embed] %v\n", err)
			return
		}
		a.embedServer = srv
	}()

	a.optimizer = ctxopt.NewOptimizer(a.embedder, a.msgRepo, a.kbRepo)
	a.tokenCache = ctxopt.NewTokenCache(a.embedder)

	// LEGACY: token refresh disabled — see CompressAgent
	// go a.tokenRefreshLoop()

	if a.msgRepo != nil {
		a.startIngestionLoop()
	}
}

func (a *App) shutdown(ctx context.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for sid, pty := range a.terminals {
		pty.Kill()
		if s, ok := a.sessions[sid]; ok {
			terminal.CleanupEnv(s.HomeDir)
		}
	}
	if a.embedServer != nil {
		a.embedServer.Stop()
	}
}

// --- Methods exposed to frontend ---

// GetProjects returns all configured projects.
func (a *App) GetProjects() []domain.Project {
	projects, _ := a.config.LoadProjects()
	return projects
}

// GetSettings returns global settings.
func (a *App) GetSettings() map[string]string {
	cfg := a.config.(*config.JSONConfig)
	sqliteOn := "true"
	if !cfg.SQLiteEnabled() {
		sqliteOn = "false"
	}
	return map[string]string{
		"gemini_api_key": cfg.GeminiKey(),
		"sqlite_enabled": sqliteOn,
	}
}

// SaveSettings persists global settings and reinitializes services.
func (a *App) SaveSettings(geminiKey string, sqliteOn bool) string {
	cfg := a.config.(*config.JSONConfig)
	if err := cfg.SaveSettings(geminiKey, sqliteOn); err != nil {
		return "error: " + err.Error()
	}
	a.initServices()
	return "ok"
}

// WipeSQLite deletes the SQLite database.
func (a *App) WipeSQLite() string {
	home, _ := os.UserHomeDir()
	dbPath := filepath.Join(home, ".redo", "redo.db")
	a.msgRepo = nil
	a.kbRepo = nil
	if err := os.Remove(dbPath); err != nil && !os.IsNotExist(err) {
		return "error: " + err.Error()
	}
	// Also remove WAL/SHM
	os.Remove(dbPath + "-wal")
	os.Remove(dbPath + "-shm")
	return "ok"
}

// SaveProjects persists project configuration.
func (a *App) SaveProjects(projects []domain.Project) error {
	return a.config.SaveProjects(projects)
}

// SpawnAgent starts a terminal for an agent in a project.
// Returns the session ID or error message prefixed with "error:".
func (a *App) SpawnAgent(projectName, agentName, command, color, cliType string) string {
	projects, _ := a.config.LoadProjects()

	var proj *domain.Project
	for i := range projects {
		if projects[i].Name == projectName {
			proj = &projects[i]
			break
		}
	}
	if proj == nil {
		return "error:project not found: " + projectName
	}

	agent := domain.Agent{
		Name:    agentName,
		Command: command,
		Color:   color,
		CLIType: cliType,
	}

	workDir := proj.Path

	driver, ok := terminal.Drivers[agent.CLIType]
	if !ok {
		driver = terminal.Drivers["kiro"]
	}

	env, homeDir, err := terminal.BuildEnv(agent, proj.Path)
	if err != nil {
		return "error:env build failed: " + err.Error()
	}
	terminal.WriteAgentMD(homeDir, *proj)

	cmd := driver.SpawnCommand(agent)
	pty, err := terminal.Spawn(cmd, workDir, env)
	if err != nil {
		terminal.CleanupEnv(homeDir)
		return "error:spawn failed: " + err.Error()
	}

	sessionID := uuid.New().String()[:8]
	session := &domain.Session{
		ID:        sessionID,
		Project:   projectName,
		AgentName: agentName,
		CLIType:   cliType,
		HomeDir:   homeDir,
		Active:    true,
	}

	a.mu.Lock()
	a.terminals[sessionID] = pty
	a.sessions[sessionID] = session
	a.mu.Unlock()

	// Read PTY output and emit to frontend
	go func() {
		for data := range pty.Read() {
			a.mu.Lock()
			if s, ok := a.sessions[sessionID]; ok {
				s.LastOutputTime = time.Now().UnixMilli()
			}
			a.mu.Unlock()
			runtime.EventsEmit(a.ctx, "pty:output:"+sessionID, string(data))
		}
		runtime.EventsEmit(a.ctx, "pty:exit:"+sessionID, nil)
	}()

	// Persist agent in project config for respawn
	a.saveAgentToProject(projectName, agent)

	return sessionID
}

// SendInput writes text to terminals, char by char to simulate typing.
func (a *App) SendInput(sessionIDs []string, text string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, sid := range sessionIDs {
		if pty, ok := a.terminals[sid]; ok {
			for _, ch := range text {
				pty.Write(string(ch))
				time.Sleep(3 * time.Millisecond)
			}
			time.Sleep(10 * time.Millisecond)
			pty.Write("\r")
			time.Sleep(10 * time.Millisecond)
			pty.Write("\r")
		}
	}
}

// SpawnShell creates a plain shell PTY in the given project's directory.
func (a *App) SpawnShell(projectName string) string {
	projects, _ := a.config.LoadProjects()
	var workDir string
	for _, p := range projects {
		if p.Name == projectName {
			workDir = p.Path
			break
		}
	}
	if workDir == "" {
		return "error:project not found"
	}

	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/bash"
	}

	pty, err := terminal.Spawn(shell, workDir, nil)
	if err != nil {
		return "error:" + err.Error()
	}

	sid := "sh-" + uuid.New().String()[:6]
	a.mu.Lock()
	a.terminals[sid] = pty
	a.sessions[sid] = &domain.Session{ID: sid, Project: projectName, AgentName: "shell", CLIType: "shell", Active: true}
	a.mu.Unlock()

	go func() {
		for data := range pty.Read() {
			runtime.EventsEmit(a.ctx, "pty:output:"+sid, string(data))
		}
		runtime.EventsEmit(a.ctx, "pty:exit:"+sid, nil)
	}()

	return sid
}

// SendRaw writes raw data to a terminal (from xterm.js keyboard input).
func (a *App) SendRaw(sessionID string, data string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if pty, ok := a.terminals[sessionID]; ok {
		fmt.Printf("[DEBUG SendRaw] session=%s data=%q\n", sessionID, data)
		pty.Write(data)
	}
}

// KillSession terminates a terminal process (does NOT remove agent from project config).
func (a *App) KillSession(sessionID string) {
	a.mu.Lock()
	session := a.sessions[sessionID]
	if pty, ok := a.terminals[sessionID]; ok {
		pty.Kill()
		delete(a.terminals, sessionID)
	}
	if session != nil {
		terminal.CleanupEnv(session.HomeDir)
		delete(a.sessions, sessionID)
	}
	a.mu.Unlock()
}

// RemoveAgent kills the session AND removes the agent from project config.
func (a *App) RemoveAgent(sessionID string) {
	a.mu.Lock()
	session := a.sessions[sessionID]
	a.mu.Unlock()

	a.KillSession(sessionID)

	if session != nil {
		a.removeAgentFromProject(session.Project, session.AgentName)
	}
}

// ResizeTerminal updates PTY size.
func (a *App) ResizeTerminal(sessionID string, rows, cols int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if pty, ok := a.terminals[sessionID]; ok {
		pty.Resize(rows, cols)
	}
}

// GetSessions returns active sessions.
func (a *App) GetSessions() map[string]*domain.Session {
	a.mu.Lock()
	defer a.mu.Unlock()
	result := make(map[string]*domain.Session)
	for k, v := range a.sessions {
		result[k] = v
	}
	return result
}

// GetConversation reads the saved conversation for a session from the agent's storage.
func (a *App) GetConversation(sessionID string) []domain.Message {
	a.mu.Lock()
	session, ok := a.sessions[sessionID]
	a.mu.Unlock()
	if !ok {
		return nil
	}

	driver := terminal.Drivers[session.CLIType]
	if driver == nil {
		return nil
	}

	// Kiro: pass workdir (key in SQLite). Gemini: pass isolated HOME.
	var path string
	switch session.CLIType {
	case "kiro":
		projects, _ := a.config.LoadProjects()
		for _, p := range projects {
			if p.Name == session.Project {
				path = p.Path
				break
			}
		}
	default:
		path = session.HomeDir
	}
	if path == "" {
		return nil
	}

	msgs, err := driver.ParseSessionFile(path)
	if err != nil {
		fmt.Printf("[GetConversation] %s error: %v\n", session.CLIType, err)
		return nil
	}
	return msgs
}

// RespawnProject respawns all saved agents for a project with --resume.
// Returns a map of agentName → sessionID.
func (a *App) RespawnProject(projectName string) map[string]string {
	projects, _ := a.config.LoadProjects()
	var proj *domain.Project
	for i := range projects {
		if projects[i].Name == projectName {
			proj = &projects[i]
			break
		}
	}
	if proj == nil || len(proj.Agents) == 0 {
		fmt.Printf("[RespawnProject] project %q not found or no agents\n", projectName)
		return nil
	}

	fmt.Printf("[RespawnProject] project %q has %d agents\n", projectName, len(proj.Agents))
	result := make(map[string]string)
	for _, agent := range proj.Agents {
		driver := terminal.Drivers[agent.CLIType]
		if driver == nil {
			fmt.Printf("[RespawnProject] no driver for %q\n", agent.CLIType)
			continue
		}

		env, homeDir, err := terminal.BuildEnv(agent, proj.Path)
		if err != nil {
			fmt.Printf("[RespawnProject] BuildEnv error for %s: %v\n", agent.Name, err)
			continue
		}
		terminal.WriteAgentMD(homeDir, *proj)

		// Try resume first, fallback to normal spawn
		cmd := driver.ResumeCommand(agent)
		pty, err := terminal.Spawn(cmd, proj.Path, env)
		if err != nil {
			fmt.Printf("[RespawnProject] resume failed for %s (%s), trying normal spawn: %v\n", agent.Name, cmd, err)
			cmd = driver.SpawnCommand(agent)
			pty, err = terminal.Spawn(cmd, proj.Path, env)
			if err != nil {
				fmt.Printf("[RespawnProject] normal spawn also failed for %s: %v\n", agent.Name, err)
				terminal.CleanupEnv(homeDir)
				continue
			}
		}

		sessionID := uuid.New().String()[:8]
		session := &domain.Session{
			ID:        sessionID,
			Project:   projectName,
			AgentName: agent.Name,
			CLIType:   agent.CLIType,
			HomeDir:   homeDir,
			Active:    true,
		}

		a.mu.Lock()
		a.terminals[sessionID] = pty
		a.sessions[sessionID] = session
		a.mu.Unlock()

		go func(sid string) {
			for data := range pty.Read() {
				runtime.EventsEmit(a.ctx, "pty:output:"+sid, string(data))
			}
			runtime.EventsEmit(a.ctx, "pty:exit:"+sid, nil)
		}(sessionID)

		result[agent.Name] = sessionID
		fmt.Printf("[RespawnProject] spawned %s -> session %s (cmd: %s)\n", agent.Name, sessionID, cmd)
	}
	return result
}

func (a *App) saveAgentToProject(projectName string, agent domain.Agent) {
	projects, _ := a.config.LoadProjects()
	for i := range projects {
		if projects[i].Name == projectName {
			// Avoid duplicates
			for _, existing := range projects[i].Agents {
				if existing.Name == agent.Name {
					return
				}
			}
			projects[i].Agents = append(projects[i].Agents, agent)
			a.config.SaveProjects(projects)
			return
		}
	}
}

func (a *App) removeAgentFromProject(projectName, agentName string) {
	projects, _ := a.config.LoadProjects()
	for i := range projects {
		if projects[i].Name == projectName {
			agents := projects[i].Agents
			for j := range agents {
				if agents[j].Name == agentName {
					projects[i].Agents = append(agents[:j], agents[j+1:]...)
					a.config.SaveProjects(projects)
					return
				}
			}
		}
	}
}

// PickFile opens a native file dialog and returns the selected path.
func (a *App) PickFile() string {
	path, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select Knowledge Document",
		Filters: []runtime.FileFilter{
			{DisplayName: "Documents", Pattern: "*.md;*.txt;*.py;*.go;*.js;*.ts;*.json;*.yaml;*.yml;*.toml"},
			{DisplayName: "All Files", Pattern: "*"},
		},
	})
	if err != nil {
		return ""
	}
	return path
}

// PickFiles opens a native file dialog for multiple selection.
func (a *App) PickFiles() []string {
	paths, err := runtime.OpenMultipleFilesDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select Knowledge Documents",
		Filters: []runtime.FileFilter{
			{DisplayName: "Documents", Pattern: "*.md;*.txt;*.py;*.go;*.js;*.ts;*.json;*.yaml;*.yml;*.toml;*.pdf;*.png;*.jpg"},
			{DisplayName: "All Files", Pattern: "*"},
		},
	})
	if err != nil {
		return nil
	}
	return paths
}

// PickDirectory opens a native directory dialog.
func (a *App) PickDirectory() string {
	path, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select Directory",
	})
	if err != nil {
		return ""
	}
	return path
}

// --- KB Management ---

// AddKBDoc adds a file to the project's KB and ingests it.
func (a *App) AddKBDoc(projectName, filePath string) string {
	// Save to project config
	projects, _ := a.config.LoadProjects()
	for i := range projects {
		if projects[i].Name == projectName {
			for _, existing := range projects[i].KBDocs {
				if existing == filePath {
					return "already added"
				}
			}
			projects[i].KBDocs = append(projects[i].KBDocs, filePath)
			a.config.SaveProjects(projects)
			break
		}
	}

	// Ingest to SQLite
	if a.kbRepo != nil {
		n, err := kb.Ingest(a.kbRepo, a.embedder, projectName, filePath)
		if err != nil {
			fmt.Printf("[AddKBDoc] ingest error: %v\n", err)
			return fmt.Sprintf("error: %v", err)
		}
		fmt.Printf("[AddKBDoc] %s: %d chunks indexed\n", filePath, n)
		return fmt.Sprintf("ok: %d chunks indexed", n)
	}
	return "ok: saved (database not available)"
}

// RemoveKBDoc removes a file from the project's KB.
func (a *App) RemoveKBDoc(projectName, filePath string) {
	projects, _ := a.config.LoadProjects()
	for i := range projects {
		if projects[i].Name == projectName {
			docs := projects[i].KBDocs
			for j := range docs {
				if docs[j] == filePath {
					projects[i].KBDocs = append(docs[:j], docs[j+1:]...)
					break
				}
			}
			a.config.SaveProjects(projects)
			break
		}
	}
	if a.kbRepo != nil {
		a.kbRepo.DeleteBySource(projectName, filePath)
	}
}

// GetKBChunks returns the chunks for a KB doc (from MySQL or re-chunked on the fly).
func (a *App) GetKBChunks(projectName, filePath string) []string {
	if a.kbRepo != nil {
		chunks, err := a.kbRepo.GetChunksBySource(projectName, filePath)
		if err == nil && len(chunks) > 0 {
			result := make([]string, len(chunks))
			for i, c := range chunks {
				result[i] = c.Content
			}
			return result
		}
	}
	// Fallback: read and chunk locally
	content := a.ReadFileContent(filePath)
	if content == "" {
		return nil
	}
	return kb.Chunk(content)
}

// ReadFileContent reads a file. For PDFs, extracts text via Python helper.
func (a *App) ReadFileContent(filePath string) string {
	ext := strings.ToLower(filepath.Ext(filePath))
	switch ext {
	case ".pdf":
		return a.extractPDF(filePath)
	case ".png", ".jpg", ".jpeg", ".gif", ".webp":
		return a.describeImage(filePath)
	default:
		data, err := os.ReadFile(filePath)
		if err != nil {
			return ""
		}
		return string(data)
	}
}

func (a *App) extractPDF(path string) string {
	home, _ := os.UserHomeDir()
	python := filepath.Join(home, ".redo", "embed-venv", "bin", "python")
	out, err := exec.Command(python, "-c", fmt.Sprintf(
		`import fitz; doc=fitz.open(%q); print("\n\n".join(p.get_text() for p in doc))`, path,
	)).Output()
	if err != nil {
		fmt.Printf("[PDF] extract error: %v\n", err)
		return ""
	}
	return string(out)
}

func (a *App) describeImage(path string) string {
	home, _ := os.UserHomeDir()
	python := filepath.Join(home, ".redo", "embed-venv", "bin", "python")
	geminiKey := a.config.(*config.JSONConfig).GeminiKey()
	if geminiKey == "" {
		return "[Image: " + filepath.Base(path) + " — set Gemini API Key in Settings to enable image description]"
	}
	cmd := exec.Command(python, "-c", fmt.Sprintf(`
import google.generativeai as genai, PIL.Image
genai.configure(api_key=%q)
img = PIL.Image.open(%q)
model = genai.GenerativeModel("gemini-2.0-flash")
r = model.generate_content(["Describe this image in detail for a knowledge base. Include all text, diagrams, and technical details.", img])
print(r.text)
`, geminiKey, path))
	out, err := cmd.Output()
	if err != nil {
		fmt.Printf("[Image] describe error: %v\n", err)
		return "[Image: " + filepath.Base(path) + "]"
	}
	return string(out)
}

// ReindexKB re-ingests all KB docs for a project.
func (a *App) ReindexKB(projectName string) string {
	if a.kbRepo == nil {
		return "error: database not available"
	}
	projects, _ := a.config.LoadProjects()
	for _, p := range projects {
		if p.Name == projectName {
			total := 0
			for _, doc := range p.KBDocs {
				n, err := kb.Ingest(a.kbRepo, a.embedder, projectName, doc)
				if err != nil {
					fmt.Printf("[ReindexKB] %s: %v\n", doc, err)
					continue
				}
				total += n
			}
			return fmt.Sprintf("ok: %d chunks indexed from %d docs", total, len(p.KBDocs))
		}
	}
	return "error: project not found"
}

// ChunkHit represents a search result for the frontend preview.
type ChunkHit struct {
	Source  string `json:"source"`
	Content string `json:"content"`
	Type    string `json:"type"` // "kb" or "conversation"
}

// SearchChunks returns top-N relevant KB chunks for a query (for live preview).
func (a *App) SearchChunks(projectName, query string, limit int) []ChunkHit {
	fmt.Printf("[SearchChunks] project=%s query=%q kbRepo=%v\n", projectName, query, a.kbRepo != nil)
	if a.kbRepo == nil || query == "" {
		return nil
	}
	if limit <= 0 {
		limit = 3
	}

	var queryVec []float32
	if a.embedder != nil {
		queryVec, _ = a.embedder.Embed(query)
	}

	chunks, _ := a.kbRepo.FindRelevant(projectName, query, queryVec, limit)
	var hits []ChunkHit
	for _, c := range chunks {
		name := c.SourceFile
		if idx := strings.LastIndex(name, "/"); idx >= 0 {
			name = name[idx+1:]
		}
		hits = append(hits, ChunkHit{
			Source:  name,
			Content: c.Content,
			Type:    "kb",
		})
	}
	return hits
}


// --- Code Viewer ---

func (a *App) getProjectPath(name string) string {
	projects, _ := a.config.LoadProjects()
	for _, p := range projects {
		if p.Name == name {
			return p.Path
		}
	}
	return ""
}


// --- File Tree APIs ---

// ListDirectory returns files/dirs at a relative path, respecting .gitignore.
func (a *App) ListDirectory(projectName, relativePath string) []map[string]interface{} {
	projPath := a.getProjectPath(projectName)
	if projPath == "" {
		return nil
	}
	projPath = strings.TrimRight(projPath, "/")
	dir := projPath
	if relativePath != "" && relativePath != "." {
		dir = filepath.Join(projPath, relativePath)
	}

	// Use git ls-files to respect .gitignore
	tracked := map[string]bool{}
	for _, repo := range codeview.FindGitRepos(projPath) {
		out, err := exec.Command("git", "-C", repo, "ls-files", "--cached", "--others", "--exclude-standard").Output()
		if err == nil {
			for _, f := range strings.Split(strings.TrimSpace(string(out)), "\n") {
				if f != "" {
					full := filepath.Join(repo, f)
					// Mark all parent dirs as tracked too
					rel, _ := filepath.Rel(projPath, full)
					if rel != "" {
						tracked[rel] = true
						for p := filepath.Dir(rel); p != "." && p != ""; p = filepath.Dir(p) {
							tracked[p+"/"] = true
						}
					}
				}
			}
		}
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}

	var result []map[string]interface{}
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, ".") || name == "node_modules" || name == "__pycache__" || name == "target" || name == "build" || name == "dist" {
			continue
		}
		rel := name
		if relativePath != "" && relativePath != "." {
			rel = filepath.Join(relativePath, name)
		}
		// Filter: only show tracked files/dirs (or dirs that contain tracked files)
		if len(tracked) > 0 {
			if e.IsDir() {
				if !tracked[rel+"/"] {
					continue
				}
			} else {
				if !tracked[rel] {
					continue
				}
			}
		}
		info, _ := e.Info()
		size := int64(0)
		if info != nil {
			size = info.Size()
		}
		result = append(result, map[string]interface{}{
			"name":  name,
			"path":  rel,
			"isDir": e.IsDir(),
			"size":  size,
			"ext":   filepath.Ext(name),
		})
	}
	return result
}

// ReadProjectFile reads lines from a file in the project.
func (a *App) ReadProjectFile(projectName, relativePath string) string {
	projPath := a.getProjectPath(projectName)
	if projPath == "" {
		return ""
	}
	full := filepath.Join(strings.TrimRight(projPath, "/"), relativePath)
	info, err := os.Stat(full)
	if err != nil || info.IsDir() || info.Size() > 512*1024 {
		return "" // skip dirs and files > 512KB
	}
	data, err := os.ReadFile(full)
	if err != nil {
		return ""
	}
	return string(data)
}

// GetFileSymbols parses a file and returns its AST symbols.
func (a *App) GetFileSymbols(projectName, relativePath string) []map[string]interface{} {
	projPath := a.getProjectPath(projectName)
	if projPath == "" {
		return nil
	}
	full := filepath.Join(strings.TrimRight(projPath, "/"), relativePath)
	syms, err := codeview.ParseFile("http://127.0.0.1:9999", full)
	if err != nil || len(syms) == 0 {
		return nil
	}
	var result []map[string]interface{}
	for _, s := range syms {
		result = append(result, map[string]interface{}{
			"name":       s.Name,
			"kind":       s.Kind,
			"file":       relativePath,
			"start_line": s.StartLine,
			"end_line":   s.EndLine,
			"calls":      s.Calls,
		})
	}
	return result
}
func (a *App) GetCommits(projectName string, limit int) []codeview.Commit {
	path := a.getProjectPath(projectName)
	if path == "" {
		return nil
	}
	if limit <= 0 {
		limit = 30
	}
	commits, _ := codeview.ListCommitsMulti(path, limit, "")
	return commits
}

// GetCommitsBranch returns commits for a specific branch.
func (a *App) GetCommitsBranch(projectName, branch string, limit int) []codeview.Commit {
	path := a.getProjectPath(projectName)
	if path == "" {
		return nil
	}
	if limit <= 0 {
		limit = 30
	}
	commits, _ := codeview.ListCommitsMulti(path, limit, branch)
	return commits
}

// GetCommitsForRepo returns commits for a specific repo and branch.
func (a *App) GetCommitsForRepo(projectName, repoName, branch string, limit int) []codeview.Commit {
	path := a.getProjectPath(projectName)
	if path == "" {
		return nil
	}
	if limit <= 0 {
		limit = 30
	}
	// Find the actual repo path
	for _, repo := range codeview.FindGitRepos(path) {
		rel, _ := filepath.Rel(path, repo)
		if rel == "." {
			rel = filepath.Base(repo)
		}
		if rel == repoName {
			commits, _ := codeview.ListCommits(repo, limit, branch)
			return commits
		}
	}
	return nil
}

// GetBranches returns all branches for the project's git repos.
func (a *App) GetBranches(projectName string) []codeview.Branch {
	path := a.getProjectPath(projectName)
	if path == "" {
		return nil
	}
	seen := map[string]bool{}
	var all []codeview.Branch
	for _, repo := range codeview.FindGitRepos(path) {
		for _, b := range codeview.ListBranches(repo) {
			if !seen[b.Name] {
				seen[b.Name] = true
				all = append(all, b)
			}
		}
	}
	return all
}

// GetBranchesForRepo returns branches for a specific repo.
func (a *App) GetBranchesForRepo(projectName, repoName string) []codeview.Branch {
	path := a.getProjectPath(projectName)
	if path == "" {
		return nil
	}
	for _, repo := range codeview.FindGitRepos(path) {
		rel, _ := filepath.Rel(path, repo)
		if rel == "." {
			rel = filepath.Base(repo)
		}
		if rel == repoName {
			return codeview.ListBranches(repo)
		}
	}
	return nil
}

func (a *App) GetGitRepos(projectName string) []string {
	path := a.getProjectPath(projectName)
	if path == "" {
		return nil
	}
	repos := codeview.FindGitRepos(path)
	names := make([]string, len(repos))
	for i, r := range repos {
		rel, _ := filepath.Rel(path, r)
		if rel == "" || rel == "." {
			rel = filepath.Base(r)
		}
		names[i] = rel
	}
	return names
}


func (a *App) GetCommitDetail(projectName, hash string) *codeview.Commit {
	for _, repo := range codeview.FindGitRepos(a.getProjectPath(projectName)) {
		if c := codeview.GetCommitDetail(repo, hash); c != nil {
			return c
		}
	}
	return nil
}
func (a *App) GetDiffFiles(projectName, hash string) []codeview.FileDiff {
	for _, repo := range codeview.FindGitRepos(a.getProjectPath(projectName)) {
		if files, err := codeview.GetDiffFiles(repo, hash); err == nil && len(files) > 0 {
			return files
		}
	}
	return nil
}

func (a *App) GetFilePatch(projectName, hash, filePath string) string {
	for _, repo := range codeview.FindGitRepos(a.getProjectPath(projectName)) {
		if patch, err := codeview.GetFilePatch(repo, hash, filePath); err == nil && patch != "" {
			return patch
		}
	}
	return ""
}

func (a *App) SaveProjectConfig(projectName string, cfg domain.ProjectConfig) string {
	projects, _ := a.config.LoadProjects()
	for i := range projects {
		if projects[i].Name == projectName {
			projects[i].CodeCfg = cfg
			a.config.SaveProjects(projects)
			return "ok"
		}
	}
	return "error: project not found"
}

func (a *App) GetProjectConfig(projectName string) domain.ProjectConfig {
	projects, _ := a.config.LoadProjects()
	for _, p := range projects {
		if p.Name == projectName {
			return p.CodeCfg
		}
	}
	return domain.ProjectConfig{}
}

func (a *App) GetSymbolGraph(projectName, hash string) *codeview.SymbolGraph {
	for _, repo := range codeview.FindGitRepos(a.getProjectPath(projectName)) {
		files, _ := codeview.GetDiffFiles(repo, hash)
		if len(files) == 0 {
			continue
		}
		paths := make([]string, len(files))
		for i, f := range files {
			paths[i] = f.Path
		}
		graph, _ := codeview.BuildGraph("http://127.0.0.1:9999", repo, paths)
		if graph != nil && len(graph.Symbols) > 0 {
			codeview.MarkChanged(graph, repo, hash)
			return graph
		}
	}
	return nil
}

// IsAgentBusy returns true if the agent received output in the last 2 seconds.

// BuildPrompt assembles a rich prompt from graph selection + user intent.
// Also saves the selection as knowledge for future reference.

// SuggestSymbols finds code symbols relevant to a user's prompt.
// Returns symbols with their code snippet for the user to review.
func (a *App) SuggestSymbols(projectName, prompt string) []map[string]string {
	path := a.getProjectPath(projectName)
	if path == "" || a.embedder == nil {
		return nil
	}

	// Embed the prompt
	promptVec, err := a.embedder.Embed(prompt)
	if err != nil {
		return nil
	}

	// Get all KB chunks and find code-related ones
	if a.kbRepo == nil {
		return nil
	}
	chunks, _ := a.kbRepo.FindRelevant(projectName, prompt, promptVec, 10)

	// Also parse recent files for symbols
	repos := codeview.FindGitRepos(path)
	var allSymbols []codeview.Symbol
	for _, repo := range repos {
		// Get files from latest commits
		commits, _ := codeview.ListCommits(repo, 5, "")
		fileSet := map[string]bool{}
		for _, c := range commits {
			files, _ := codeview.GetDiffFiles(repo, c.Hash)
			for _, f := range files {
				fileSet[f.Path] = true
			}
		}
		for f := range fileSet {
			syms, _ := codeview.ParseFile("http://127.0.0.1:9999", filepath.Join(repo, f))
			for i := range syms {
				syms[i].File = f
			}
			allSymbols = append(allSymbols, syms...)
		}
	}

	// Score symbols by embedding similarity to prompt
	type scored struct {
		sym   codeview.Symbol
		score float64
		code  string
	}
	var results []scored

	if len(allSymbols) > 0 {
		// Embed symbol content (name + signature + body, truncated)
		texts := make([]string, len(allSymbols))
		for i, s := range allSymbols {
			code := ""
			for _, repo := range repos {
				code = codeview.ExtractCode(repo, s)
				if code != "" {
					break
				}
			}
			if len(code) > 500 {
				code = code[:500]
			}
			if code != "" {
				texts[i] = s.Kind + " " + s.Name + " in " + s.File + "\n" + code
			} else {
				texts[i] = s.Kind + " " + s.Name + " in " + s.File
			}
		}
		vecs, err := a.embedder.EmbedBatch(texts)
		if err == nil {
			for i, s := range allSymbols {
				cos := cosineSim(promptVec, vecs[i])
				if cos > 0.2 {
					results = append(results, scored{s, cos, texts[i]})
				}
			}
		}
	}

	// Sort by score desc
	for i := range results {
		for j := i + 1; j < len(results); j++ {
			if results[j].score > results[i].score {
				results[i], results[j] = results[j], results[i]
			}
		}
	}

	// Return top 8
	var out []map[string]string
	for i, r := range results {
		if i >= 8 {
			break
		}
		preview := r.code
		if len(preview) > 300 {
			preview = preview[:300] + "..."
		}
		out = append(out, map[string]string{
			"name":     r.sym.Name,
			"kind":     r.sym.Kind,
			"file":     r.sym.File,
			"line":     fmt.Sprintf("%d", r.sym.StartLine),
			"end_line": fmt.Sprintf("%d", r.sym.EndLine),
			"score":    fmt.Sprintf("%.2f", r.score),
		})
	}

	// Also add KB chunk matches
	for _, c := range chunks {
		if len(out) >= 10 {
			break
		}
		name := c.SourceFile
		if idx := strings.LastIndex(name, "/"); idx >= 0 {
			name = name[idx+1:]
		}
		out = append(out, map[string]string{
			"name":    name,
			"kind":    "kb",
			"file":    c.SourceFile,
			"preview": c.Content[:min(300, len(c.Content))],
			"score":   "kb",
		})
	}

	return out
}

func cosineSim(a, b []float32) float64 {
	if len(a) != len(b) {
		return 0
	}
	var dot, na, nb float64
	for i := range a {
		dot += float64(a[i]) * float64(b[i])
		na += float64(a[i]) * float64(a[i])
		nb += float64(b[i]) * float64(b[i])
	}
	if na == 0 || nb == 0 {
		return 0
	}
	return dot / (na * nb)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// ReadSymbolCode reads source lines from a file in the project.

// SearchSymbol finds symbols matching a name query across the project.
func (a *App) SearchSymbol(projectName, query string) []map[string]string {
	projPath := a.getProjectPath(projectName)
	if projPath == "" {
		return nil
	}
	query = strings.ToLower(query)
	var results []map[string]string
	seen := map[string]bool{}

	for _, repo := range codeview.FindGitRepos(projPath) {
		commits, _ := codeview.ListCommits(repo, 10, "")
		fileSet := map[string]bool{}
		for _, c := range commits {
			files, _ := codeview.GetDiffFiles(repo, c.Hash)
			for _, f := range files {
				fileSet[f.Path] = true
			}
		}
		for f := range fileSet {
			syms, _ := codeview.ParseFile("http://127.0.0.1:9999", filepath.Join(repo, f))
			for _, s := range syms {
				key := s.Name + f
				if seen[key] {
					continue
				}
				// Match name OR content
				if strings.Contains(strings.ToLower(s.Name), query) {
					seen[key] = true
				} else {
					code := codeview.ExtractCode(repo, s)
					if code != "" && strings.Contains(strings.ToLower(code), query) {
						seen[key] = true
					}
				}
				if seen[key] {
					results = append(results, map[string]string{
						"name": s.Name, "kind": s.Kind, "file": f,
						"line": fmt.Sprintf("%d", s.StartLine), "end_line": fmt.Sprintf("%d", s.EndLine),
					})
				}
			}
		}
		if len(results) >= 20 {
			break
		}
	}
	return results
}

// ExpandSymbol finds symbols connected to the given symbol (callers + callees).
// Each result includes "edge_from" and "edge_to" for graph rendering.
func (a *App) ExpandSymbol(projectName, symbolName, filePath string) []map[string]string {
	projPath := a.getProjectPath(projectName)
	if projPath == "" {
		return nil
	}

	var results []map[string]string
	seen := map[string]bool{symbolName: true}

	for _, repo := range codeview.FindGitRepos(projPath) {
		full := filepath.Join(repo, filePath)
		syms, err := codeview.ParseFile("http://127.0.0.1:9999", full)
		if err != nil {
			continue
		}

		for _, s := range syms {
			if s.Name == symbolName {
				for _, call := range s.Calls {
					if !seen[call] {
						seen[call] = true
						for _, s2 := range syms {
							if s2.Name == call {
								results = append(results, map[string]string{
									"name": s2.Name, "kind": s2.Kind, "file": filePath,
									"line": fmt.Sprintf("%d", s2.StartLine), "end_line": fmt.Sprintf("%d", s2.EndLine),
									"edge_from": symbolName, "edge_to": call,
								})
								break
							}
						}
					}
				}
			}
			for _, call := range s.Calls {
				if call == symbolName && !seen[s.Name] {
					seen[s.Name] = true
					results = append(results, map[string]string{
						"name": s.Name, "kind": s.Kind, "file": filePath,
						"line": fmt.Sprintf("%d", s.StartLine), "end_line": fmt.Sprintf("%d", s.EndLine),
						"edge_from": s.Name, "edge_to": symbolName,
					})
				}
			}
		}
	}
	return results
}
func (a *App) ReadSymbolCode(projectName, filePath string, startLine, endLine int) string {
	projPath := a.getProjectPath(projectName)
	if projPath == "" {
		return ""
	}
	for _, repo := range codeview.FindGitRepos(projPath) {
		full := filepath.Join(repo, filePath)
		data, err := os.ReadFile(full)
		if err != nil {
			continue
		}
		lines := strings.Split(string(data), "\n")
		s := startLine - 1
		if s < 0 {
			s = 0
		}
		e := endLine
		if e > len(lines) {
			e = len(lines)
		}
		return strings.Join(lines[s:e], "\n")
	}
	return ""
}
func (a *App) BuildPrompt(projectName, hash, intent string, symbols []string) string {
	var parts []string
	parts = append(parts, "## Task\n"+intent)

	if len(symbols) > 0 {
		parts = append(parts, "\n## Relevant Files (use your file read tool to inspect)")
	}

	// Try to get graph for line ranges
	var graph *codeview.SymbolGraph
	if hash != "" {
		graph = a.GetSymbolGraph(projectName, hash)
	}

	for _, name := range symbols {
		found := false
		if graph != nil {
			for _, sym := range graph.Symbols {
				if sym.Name == name {
					parts = append(parts, fmt.Sprintf("- %s `%s` → %s:%d-%d", sym.Kind, sym.Name, sym.File, sym.StartLine, sym.EndLine))
					found = true
					break
				}
			}
		}
		if !found {
			parts = append(parts, fmt.Sprintf("- `%s`", name))
		}
	}

	// Save selection as knowledge
	if a.kbRepo != nil && len(symbols) > 0 {
		knowledge := fmt.Sprintf("Human selected symbols for task: %s\nSymbols: %s", intent, strings.Join(symbols, ", "))
		var emb []float32
		if a.embedder != nil {
			emb, _ = a.embedder.Embed(knowledge)
		}
		a.kbRepo.SaveChunk(&domain.KBChunk{
			Project:    projectName,
			SourceFile: "human-selections",
			Content:    knowledge,
			Embedding:  emb,
		})
	}

	return strings.Join(parts, "\n")
}
func (a *App) IsAgentBusy(sessionID string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	s, ok := a.sessions[sessionID]
	if !ok {
		return false
	}
	return time.Now().UnixMilli()-s.LastOutputTime < 2000
}

// --- Explain Change ---

// SearchMessagesForCode searches agent conversations for messages related to a code snippet.
// Searches both live sessions and stored history in SQLite.
func (a *App) SearchMessagesForCode(projectName, codeSnippet string, commitTimestamp int64) []map[string]string {
	keywords := extractKeywords(codeSnippet)
	if len(keywords) == 0 {
		return nil
	}
	fmt.Printf("[SearchMsgs] project=%s keywords=%v\n", projectName, keywords)

	// 1. Collect from live sessions (assistant only)
	a.mu.Lock()
	var allMsgs []domain.Message
	for _, s := range a.sessions {
		if s.Project == projectName {
			msgs := a.getConversationForSession(s)
			for i := range msgs {
				if msgs[i].Role != "assistant" {
					continue
				}
				msgs[i].Agent = s.AgentName
				msgs[i].SessionID = s.ID
				allMsgs = append(allMsgs, msgs[i])
			}
		}
	}
	a.mu.Unlock()

	// 2. Collect from SQLite (past sessions)
	if a.msgRepo != nil {
		query := strings.Join(keywords, " ")
		var queryVec []float32
		if a.embedder != nil {
			queryVec, _ = a.embedder.Embed(query)
		}
		stored, err := a.msgRepo.FindRelevant(projectName, query, queryVec, 20, commitTimestamp)
		fmt.Printf("[SearchMsgs] SQLite: %d stored msgs (err=%v) for project=%s\n", len(stored), err, projectName)
		// Avoid duplicates with live sessions
		liveIDs := map[string]bool{}
		for _, m := range allMsgs {
			liveIDs[m.SessionID] = true
		}
		for _, m := range stored {
			if !liveIDs[m.SessionID] && m.Role == "assistant" {
				allMsgs = append(allMsgs, m)
			}
		}
	}

	fmt.Printf("[SearchMsgs] total: %d messages to search\n", len(allMsgs))

	if len(allMsgs) == 0 {
		fmt.Printf("[SearchMsgs] no messages found (live=%d, stored search pending)\n", 0)
		return nil
	}

	// 3. Score by keyword match
	type scored struct {
		idx   int
		score int
	}
	var matches []scored
	for i, m := range allMsgs {
		s := 0
		lower := strings.ToLower(m.Content)
		for _, kw := range keywords {
			if strings.Contains(lower, kw) {
				s++
			}
		}
		if s > 0 {
			matches = append(matches, scored{i, s})
		}
	}

	// Sort by score desc
	for i := range matches {
		for j := i + 1; j < len(matches); j++ {
			if matches[j].score > matches[i].score {
				matches[i], matches[j] = matches[j], matches[i]
			}
		}
	}

	// Return top matches with ±2 context
	var result []map[string]string
	seen := map[int]bool{}
	for _, m := range matches {
		if len(result) >= 15 {
			break
		}
		start := m.idx - 2
		if start < 0 {
			start = 0
		}
		end := m.idx + 3
		if end > len(allMsgs) {
			end = len(allMsgs)
		}
		for j := start; j < end; j++ {
			if seen[j] {
				continue
			}
			seen[j] = true
			highlight := ""
			if j == m.idx {
				highlight = "match"
			}
			result = append(result, map[string]string{
				"agent":     allMsgs[j].Agent,
				"role":      allMsgs[j].Role,
				"content":   allMsgs[j].Content,
				"highlight": highlight,
			})
		}
	}
	return result
}

func extractKeywords(code string) []string {
	// Extract meaningful identifiers from code
	words := strings.FieldsFunc(code, func(r rune) bool {
		return !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_')
	})
	seen := map[string]bool{}
	stop := map[string]bool{"the": true, "and": true, "for": true, "int": true, "var": true, "new": true, "return": true, "public": true, "private": true, "void": true, "class": true, "func": true, "def": true, "import": true, "from": true, "this": true, "self": true, "null": true, "true": true, "false": true, "string": true, "if": true, "else": true}
	var kws []string
	for _, w := range words {
		w = strings.ToLower(w)
		if len(w) >= 3 && !seen[w] && !stop[w] {
			seen[w] = true
			kws = append(kws, w)
		}
	}
	if len(kws) > 10 {
		kws = kws[:10]
	}
	return kws
}
// --- Context Optimization ---

// CompressAgent compresses an agent's conversation context.
// LEGACY: Context compression disabled. Destroying cached tokens is more expensive
// than keeping them — providers charge much less for cached vs new tokens.
// Kept for potential future use if context windows become a bottleneck.
func (a *App) CompressAgent(sessionID string) string {
	a.mu.Lock()
	session := a.sessions[sessionID]
	a.mu.Unlock()
	if session == nil || a.optimizer == nil {
		return "error: session or optimizer not available"
	}

	msgs := a.getConversationForSession(session)
	if len(msgs) == 0 {
		return "error: no messages"
	}

	geminiKey := a.config.(*config.JSONConfig).GeminiKey()
	compressed, err := a.optimizer.Compress(msgs, "", geminiKey)
	if err != nil {
		return "error: " + err.Error()
	}

	a.mu.Lock()
	if pty, ok := a.terminals[sessionID]; ok {
		pty.Kill()
	}
	a.mu.Unlock()

	projects, _ := a.config.LoadProjects()
	var agent *domain.Agent
	projPath := ""
	for _, p := range projects {
		if p.Name == session.Project {
			projPath = p.Path
			for i := range p.Agents {
				if p.Agents[i].Name == session.AgentName {
					agent = &p.Agents[i]
					break
				}
			}
		}
	}
	if agent == nil {
		return "error: agent config not found"
	}

	driver := terminal.Drivers[session.CLIType]
	env, homeDir, err := terminal.BuildEnv(*agent, projPath)
	if err != nil {
		return "error: " + err.Error()
	}
	newPty, err := terminal.Spawn(driver.SpawnCommand(*agent), projPath, env)
	if err != nil {
		terminal.CleanupEnv(homeDir)
		return "error: spawn failed"
	}

	a.mu.Lock()
	terminal.CleanupEnv(session.HomeDir)
	a.terminals[sessionID] = newPty
	session.HomeDir = homeDir
	a.mu.Unlock()

	go func() {
		for data := range newPty.Read() {
			a.mu.Lock()
			if s, ok := a.sessions[sessionID]; ok {
				s.LastOutputTime = time.Now().UnixMilli()
			}
			a.mu.Unlock()
			runtime.EventsEmit(a.ctx, "pty:output:"+sessionID, string(data))
		}
		runtime.EventsEmit(a.ctx, "pty:exit:"+sessionID, nil)
	}()

	go func() {
		time.Sleep(3 * time.Second)
		a.mu.Lock()
		p := a.terminals[sessionID]
		a.mu.Unlock()
		if p != nil {
			for _, ch := range compressed {
				p.Write(string(ch))
				time.Sleep(2 * time.Millisecond)
			}
			time.Sleep(10 * time.Millisecond)
			p.Write("\r\r")
		}
	}()

	return fmt.Sprintf("ok: compressed %d messages", len(msgs))
}

// CheckTokens returns cached token count for a session.
// LEGACY: Token counting for compression trigger. See CompressAgent.
func (a *App) CheckTokens(sessionID string) map[string]int {
	tokens, msgs := a.tokenCache.Get(sessionID)
	return map[string]int{"tokens": tokens, "messages": msgs, "threshold": ctxopt.TokenThreshold}
}

// tokenRefreshLoop updates token counts every 2 min for all active sessions.
// LEGACY: Background token refresh for compression. See CompressAgent.
func (a *App) tokenRefreshLoop() {
	ticker := time.NewTicker(2 * time.Minute)
	for range ticker.C {
		a.mu.Lock()
		sessions := make([]*domain.Session, 0, len(a.sessions))
		for _, s := range a.sessions {
			sessions = append(sessions, s)
		}
		a.mu.Unlock()

		for _, s := range sessions {
			msgs := a.getConversationForSession(s)
			tokens, _, changed := a.tokenCache.Update(s.ID, msgs)
			if changed {
				fmt.Printf("[TokenCache] %s/%s: %d tokens (%d msgs)\n", s.Project, s.AgentName, tokens, len(msgs))
				// Notify frontend
				runtime.EventsEmit(a.ctx, "tokens:update:"+s.ID, map[string]int{
					"tokens": tokens, "messages": len(msgs), "threshold": ctxopt.TokenThreshold,
				})
			}
		}
	}
}

// --- Conversation Ingestion ---

// startIngestionLoop polls active sessions every 30s and ingests new messages.
func (a *App) startIngestionLoop() {
	ticker := time.NewTicker(30 * time.Second)
	go func() {
		for range ticker.C {
			a.ingestAll()
		}
	}()
}

// ingestAll reads conversations from all active sessions and saves new messages.
func (a *App) ingestAll() {
	a.mu.Lock()
	sessions := make([]*domain.Session, 0, len(a.sessions))
	for _, s := range a.sessions {
		sessions = append(sessions, s)
	}
	a.mu.Unlock()

	for _, s := range sessions {
		msgs := a.getConversationForSession(s)
		if len(msgs) == 0 {
			continue
		}

		// Check how many we already have
		existing, _ := a.msgRepo.FindBySession(s.ID)
		if len(msgs) <= len(existing) {
			continue
		}

		// Ingest only new assistant messages
		newMsgs := msgs[len(existing):]
		var assistantMsgs []domain.Message
		for _, m := range newMsgs {
			if m.Role == "assistant" {
				assistantMsgs = append(assistantMsgs, m)
			}
		}
		if len(assistantMsgs) == 0 {
			continue
		}
		fmt.Printf("[Ingest] %s/%s: %d new assistant messages\n", s.Project, s.AgentName, len(assistantMsgs))

		texts := make([]string, len(assistantMsgs))
		for i, m := range assistantMsgs {
			texts[i] = m.Content
		}
		vecs, err := a.embedder.EmbedBatch(texts)
		if err != nil {
			fmt.Printf("[Ingest] embed error: %v (saving without embeddings)\n", err)
			vecs = make([][]float32, len(assistantMsgs))
		}

		for i, m := range assistantMsgs {
			m.Project = s.Project
			m.Agent = s.AgentName
			m.SessionID = s.ID
			m.Embedding = vecs[i]
			if err := a.msgRepo.Save(&m); err != nil {
				fmt.Printf("[Ingest] save error: %v\n", err)
			}
		}
	}
}

// getConversationForSession reads conversation from the agent's native storage.
func (a *App) getConversationForSession(s *domain.Session) []domain.Message {
	driver := terminal.Drivers[s.CLIType]
	if driver == nil {
		return nil
	}
	var path string
	switch s.CLIType {
	case "kiro":
		projects, _ := a.config.LoadProjects()
		for _, p := range projects {
			if p.Name == s.Project {
				path = p.Path
				break
			}
		}
	default:
		path = s.HomeDir
	}
	if path == "" {
		return nil
	}
	msgs, _ := driver.ParseSessionFile(path)
	return msgs
}
