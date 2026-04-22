package service

import (
	"fmt"

	"github.com/jlortiz/redo/internal/domain"
	"github.com/jlortiz/redo/internal/infra/terminal"
)

// TerminalService manages PTY lifecycle.
type TerminalService struct {
	active map[string]*terminal.PtyTerminal
	homes  map[string]string // sessionID -> temp home path
}

func NewTerminalService() *TerminalService {
	return &TerminalService{
		active: make(map[string]*terminal.PtyTerminal),
		homes:  make(map[string]string),
	}
}

func (s *TerminalService) Spawn(proj domain.Project, agent domain.Agent) (*domain.Session, *terminal.PtyTerminal, error) {
	workDir := agent.WorkDir
	if workDir == "" {
		workDir = proj.Path
	}

	driver, ok := terminal.Drivers[agent.CLIType]
	if !ok {
		driver = terminal.Drivers["kiro"]
	}

	env, homeDir, err := terminal.BuildEnv(agent, proj.Path)
	if err != nil {
		return nil, nil, err
	}

	cmd := driver.SpawnCommand(agent)
	pty, err := terminal.Spawn(cmd, workDir, env)
	if err != nil {
		terminal.CleanupEnv(homeDir)
		return nil, nil, err
	}

	session := &domain.Session{
		ID:        fmt.Sprintf("%s:%s", proj.Name, agent.Name),
		Project:   proj.Name,
		AgentName: agent.Name,
		HomeDir:   homeDir,
		Active:    true,
	}

	s.active[session.ID] = pty
	s.homes[session.ID] = homeDir
	return session, pty, nil
}

func (s *TerminalService) Kill(sessionID string) {
	if pty, ok := s.active[sessionID]; ok {
		pty.Kill()
		delete(s.active, sessionID)
	}
	if home, ok := s.homes[sessionID]; ok {
		terminal.CleanupEnv(home)
		delete(s.homes, sessionID)
	}
}

func (s *TerminalService) KillAll() {
	for sid := range s.active {
		s.Kill(sid)
	}
}
