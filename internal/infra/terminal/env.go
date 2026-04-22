package terminal

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/jlortiz/redo/internal/domain"
)

var homeAllowlist = []string{".config", ".local", ".bashrc", ".bash_profile", ".profile", ".zshrc", ".nvm"}
var homeCopylist = []string{".kiro", ".gemini", ".claude"}

// BuildEnv creates an isolated HOME with symlinks + MCP config for an agent.
// Returns env vars map and the temp home path.
func BuildEnv(agent domain.Agent, projectPath string) (env map[string]string, homeDir string, err error) {
	realHome, _ := os.UserHomeDir()
	homeDir, err = os.MkdirTemp("", "redo_agent_")
	if err != nil {
		return nil, "", err
	}

	// Symlink allowlisted items
	for _, item := range homeAllowlist {
		src := filepath.Join(realHome, item)
		if _, err := os.Stat(src); err == nil {
			os.Symlink(src, filepath.Join(homeDir, item))
		}
	}

	// Deep copy CLI-specific dirs
	for _, item := range homeCopylist {
		src := filepath.Join(realHome, item)
		if info, err := os.Stat(src); err == nil && info.IsDir() {
			copyDir(src, filepath.Join(homeDir, item))
		}
	}

	// Write MCP config based on CLI type
	if len(agent.MCPs) > 0 {
		writeMCPConfig(agent, homeDir)
	}

	env = map[string]string{"HOME": homeDir}
	return env, homeDir, nil
}

func writeMCPConfig(agent domain.Agent, homeDir string) {
	switch agent.CLIType {
	case "kiro":
		dir := filepath.Join(homeDir, ".kiro", "settings")
		os.MkdirAll(dir, 0755)
		data, _ := json.Marshal(map[string]any{"mcpServers": agent.MCPs})
		os.WriteFile(filepath.Join(dir, "mcp.json"), data, 0644)
	case "gemini":
		dir := filepath.Join(homeDir, ".gemini")
		os.MkdirAll(dir, 0755)
		settings := map[string]any{"mcpServers": agent.MCPs}
		data, _ := json.Marshal(settings)
		os.WriteFile(filepath.Join(dir, "settings.json"), data, 0644)
	}
}

func copyDir(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // skip errors
		}
		rel, _ := filepath.Rel(src, path)
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, info.Mode())
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		return os.WriteFile(target, data, info.Mode())
	})
}

// CleanupEnv removes a temp HOME directory.
func CleanupEnv(homeDir string) {
	os.RemoveAll(homeDir)
}
