package terminal

import (
	_ "embed"
	"os"
	"path/filepath"
	"strings"

	"github.com/jlortiz/redo/internal/domain"
)

//go:embed agent.md
var agentTemplate string

// WriteAgentMD generates a project-specific agent.md in the agent's HOME.
func WriteAgentMD(homeDir string, project domain.Project) {
	cfg := project.CodeCfg
	manifest := detectManifest(cfg.Language)

	r := strings.NewReplacer(
		"{{PROJECT_NAME}}", project.Name,
		"{{PROJECT_PATH}}", project.Path,
		"{{LANGUAGE}}", or(cfg.Language, "not configured"),
		"{{FRAMEWORK}}", or(cfg.Framework, "not configured"),
		"{{ENTRY_FILE}}", or(cfg.EntryFile, "auto-detect"),
		"{{BUILD_CMD}}", or(cfg.BuildCmd, "not configured"),
		"{{TEST_CMD}}", or(cfg.TestCmd, "not configured"),
		"{{MANIFEST}}", manifest,
	)
	content := r.Replace(agentTemplate)

	// Write to locations agents typically read
	// Kiro: .kiro/settings/steering/default.md
	kiroDir := filepath.Join(homeDir, ".kiro", "settings", "steering")
	os.MkdirAll(kiroDir, 0755)
	os.WriteFile(filepath.Join(kiroDir, "default.md"), []byte(content), 0644)

	// Claude: CLAUDE.md in project root (symlinked)
	os.WriteFile(filepath.Join(homeDir, "CLAUDE.md"), []byte(content), 0644)

	// Gemini: GEMINI.md in project root
	os.WriteFile(filepath.Join(homeDir, "GEMINI.md"), []byte(content), 0644)
}

func detectManifest(lang string) string {
	switch lang {
	case "java":
		return "pom.xml or build.gradle"
	case "typescript", "javascript":
		return "package.json"
	case "python":
		return "pyproject.toml or requirements.txt"
	case "go":
		return "go.mod"
	default:
		return "project manifest"
	}
}

func or(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
