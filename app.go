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
	a.optimizer = ctxopt.NewOptimizer(a.embedder, a.msgRepo, a.kbRepo)
	a.tokenCache = ctxopt.NewTokenCache(a.embedder)

	// Background token refresh every 2 min
	go a.tokenRefreshLoop()

	if a.msgRepo != nil {
		// TODO: conversation ingestion — define strategy later
		// a.startIngestionLoop()
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

func (a *App) GetCommits(projectName string, limit int) []codeview.Commit {
	path := a.getProjectPath(projectName)
	if path == "" {
		return nil
	}
	if limit <= 0 {
		limit = 30
	}
	commits, _ := codeview.ListCommitsMulti(path, limit)
	return commits
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
			return graph
		}
	}
	return nil
}
// --- Context Optimization ---

// CompressAgent compresses an agent's conversation context.
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
func (a *App) CheckTokens(sessionID string) map[string]int {
	tokens, msgs := a.tokenCache.Get(sessionID)
	return map[string]int{"tokens": tokens, "messages": msgs, "threshold": ctxopt.TokenThreshold}
}

// tokenRefreshLoop updates token counts every 2 min for all active sessions.
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

		// Ingest only new messages
		newMsgs := msgs[len(existing):]
		fmt.Printf("[Ingest] %s/%s: %d new messages\n", s.Project, s.AgentName, len(newMsgs))

		// Batch embed
		texts := make([]string, len(newMsgs))
		for i, m := range newMsgs {
			texts[i] = m.Content
		}
		vecs, err := a.embedder.EmbedBatch(texts)
		if err != nil {
			fmt.Printf("[Ingest] embed error: %v (saving without embeddings)\n", err)
			vecs = make([][]float32, len(newMsgs))
		}

		for i, m := range newMsgs {
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
