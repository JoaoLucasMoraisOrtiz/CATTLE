package embedding

import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

// Server manages the Python embedding server lifecycle.
type Server struct {
	cmd  *exec.Cmd
	port int
}

// StartServer starts the pre-installed Python embedding server.
// Returns error if venv/script not found (run install.sh first).
func StartServer(port int) (*Server, error) {
	home, _ := os.UserHomeDir()
	venvPython := filepath.Join(home, ".redo", "embed-venv", "bin", "python")
	scriptPath := filepath.Join(home, ".redo", "embed_server.py")

	if _, err := os.Stat(venvPython); err != nil {
		return nil, fmt.Errorf("embedding venv not found — run install.sh first")
	}
	if _, err := os.Stat(scriptPath); err != nil {
		return nil, fmt.Errorf("embed_server.py not found — run install.sh first")
	}

	cmd := exec.Command(venvPython, scriptPath, fmt.Sprintf("%d", port))
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("server start failed: %w", err)
	}

	s := &Server{cmd: cmd, port: port}

	// Wait for healthy (model already cached, should be fast)
	url := fmt.Sprintf("http://127.0.0.1:%d/health", port)
	for i := 0; i < 30; i++ {
		time.Sleep(1 * time.Second)
		if resp, err := http.Get(url); err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				fmt.Printf("[Embed] Server ready on port %d\n", port)
				return s, nil
			}
		}
	}
	s.Stop()
	return nil, fmt.Errorf("server did not start in 30s")
}

func (s *Server) Stop() {
	if s.cmd != nil && s.cmd.Process != nil {
		s.cmd.Process.Kill()
		s.cmd.Wait()
	}
}
