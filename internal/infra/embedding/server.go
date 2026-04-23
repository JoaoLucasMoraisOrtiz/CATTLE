package embedding

import (
	_ "embed"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

//go:embed embed_server.py
var serverScript []byte

type Server struct {
	cmd  *exec.Cmd
	port int
}

func StartServer(port int) (*Server, error) {
	home, _ := os.UserHomeDir()
	venvPython := filepath.Join(home, ".redo", "embed-venv", "bin", "python")
	scriptPath := filepath.Join(home, ".redo", "embed_server.py")

	if _, err := os.Stat(venvPython); err != nil {
		return nil, fmt.Errorf("venv not found — run install.sh first")
	}

	// Kill any existing embed server on this port
	exec.Command("fuser", "-k", fmt.Sprintf("%d/tcp", port)).Run()
	time.Sleep(500 * time.Millisecond)

	// Always overwrite script with latest embedded version
	os.MkdirAll(filepath.Dir(scriptPath), 0755)
	os.WriteFile(scriptPath, serverScript, 0644)

	cmd := exec.Command(venvPython, scriptPath, fmt.Sprintf("%d", port))
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start failed: %w", err)
	}

	s := &Server{cmd: cmd, port: port}
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
