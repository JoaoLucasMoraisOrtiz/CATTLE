package main

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/wailsapp/wails/v2/pkg/runtime"

	"github.com/jlortiz/redo/internal/domain"
	"github.com/jlortiz/redo/internal/infra/terminal"
)

// App is the Wails bridge — its exported methods are callable from JS.
type App struct {
	ctx       context.Context
	config    domain.ConfigRepository
	terminals map[string]*terminal.PtyTerminal
	sessions  map[string]*domain.Session
	mu        sync.Mutex
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
}

// --- Methods exposed to frontend ---

// GetProjects returns all configured projects.
func (a *App) GetProjects() []domain.Project {
	projects, _ := a.config.LoadProjects()
	return projects
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

	driver := terminal.Drivers[session.AgentName]
	if driver == nil {
		return nil
	}

	// Kiro: pass workdir (key in SQLite). Gemini: pass isolated HOME.
	var path string
	switch session.AgentName {
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
		fmt.Printf("[GetConversation] %s error: %v\n", session.AgentName, err)
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
