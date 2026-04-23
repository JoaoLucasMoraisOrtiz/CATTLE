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

//go:embed requirements.txt
var requirements []byte

type Server struct {
	cmd  *exec.Cmd
	port int
}

func StartServer(port int) (*Server, error) {
	home, _ := os.UserHomeDir()
	redoDir := filepath.Join(home, ".redo")
	venvDir := filepath.Join(redoDir, "embed-venv")
	venvPython := filepath.Join(venvDir, "bin", "python")
	scriptPath := filepath.Join(redoDir, "embed_server.py")
	reqPath := filepath.Join(redoDir, "requirements.txt")

	os.MkdirAll(redoDir, 0755)

	// Always update script + requirements
	os.WriteFile(scriptPath, serverScript, 0644)
	os.WriteFile(reqPath, requirements, 0644)

	// Auto-install if venv missing
	if _, err := os.Stat(venvPython); err != nil {
		fmt.Println("[Embed] First run — setting up Python environment...")
		if err := setup(venvDir, reqPath); err != nil {
			return nil, fmt.Errorf("auto-setup failed: %w (run install.sh manually)", err)
		}
	}

	// Kill existing on this port
	exec.Command("fuser", "-k", fmt.Sprintf("%d/tcp", port)).Run()
	time.Sleep(500 * time.Millisecond)

	cmd := exec.Command(venvPython, scriptPath, fmt.Sprintf("%d", port))
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start failed: %w", err)
	}

	s := &Server{cmd: cmd, port: port}
	url := fmt.Sprintf("http://127.0.0.1:%d/health", port)
	for i := 0; i < 60; i++ {
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
	return nil, fmt.Errorf("server did not start in 60s")
}

func setup(venvDir, reqPath string) error {
	// Create venv
	fmt.Println("[Embed] Creating Python venv...")
	if err := exec.Command("python3", "-m", "venv", venvDir).Run(); err != nil {
		return fmt.Errorf("venv: %w", err)
	}

	// Ensure pip
	pip := filepath.Join(venvDir, "bin", "pip")
	if _, err := os.Stat(pip); err != nil {
		fmt.Println("[Embed] Installing pip...")
		exec.Command(filepath.Join(venvDir, "bin", "python"), "-m", "ensurepip", "--upgrade").Run()
	}

	// Install deps
	fmt.Println("[Embed] Installing dependencies (this may take a few minutes)...")
	cmd := exec.Command(pip, "install", "-q", "-r", reqPath)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("pip install: %w", err)
	}

	fmt.Println("[Embed] Setup complete!")
	return nil
}

func (s *Server) Stop() {
	if s.cmd != nil && s.cmd.Process != nil {
		s.cmd.Process.Kill()
		s.cmd.Wait()
	}
}
