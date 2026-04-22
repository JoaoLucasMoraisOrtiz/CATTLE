package config

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/jlortiz/redo/internal/domain"
)

type fileConfig struct {
	MySQLDSN    string           `json:"mysql_dsn"`
	GeminiKey   string           `json:"gemini_api_key"`
	Projects    []domain.Project `json:"projects"`
}

type JSONConfig struct {
	path string
	data fileConfig
}

func NewJSONConfig() *JSONConfig {
	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, ".redo")
	os.MkdirAll(dir, 0755)
	return &JSONConfig{path: filepath.Join(dir, "projects.json")}
}

func (c *JSONConfig) LoadProjects() ([]domain.Project, error) {
	raw, err := os.ReadFile(c.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	if err := json.Unmarshal(raw, &c.data); err != nil {
		return nil, err
	}
	return c.data.Projects, nil
}

func (c *JSONConfig) SaveProjects(projects []domain.Project) error {
	c.data.Projects = projects
	raw, err := json.MarshalIndent(c.data, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(c.path, raw, 0644)
}

func (c *JSONConfig) MySQLDSN() string  { return c.data.MySQLDSN }
func (c *JSONConfig) GeminiKey() string { return c.data.GeminiKey }
