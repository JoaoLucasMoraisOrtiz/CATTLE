package terminal

import (
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"unsafe"

	"github.com/creack/pty"
)

// PtyTerminal wraps a real PTY process.
type PtyTerminal struct {
	cmd    *exec.Cmd
	ptmx   *os.File
	output chan []byte
	alive  bool
	mu     sync.Mutex
}

// Spawn creates a new PTY terminal running the given command.
func Spawn(command, workDir string, env map[string]string) (*PtyTerminal, error) {
	parts := strings.Fields(command)
	cmd := exec.Command(parts[0], parts[1:]...)
	cmd.Dir = workDir
	cmd.Env = os.Environ()
	// Ensure terminal env vars are set
	cmd.Env = append(cmd.Env, "TERM=xterm-256color")
	cmd.Env = append(cmd.Env, "COLORTERM=truecolor")
	for k, v := range env {
		// Override existing env vars
		found := false
		for i, e := range cmd.Env {
			if strings.HasPrefix(e, k+"=") {
				cmd.Env[i] = k + "=" + v
				found = true
				break
			}
		}
		if !found {
			cmd.Env = append(cmd.Env, k+"="+v)
		}
	}

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: 24, Cols: 80})
	if err != nil {
		return nil, err
	}

	t := &PtyTerminal{
		cmd:    cmd,
		ptmx:   ptmx,
		output: make(chan []byte, 256),
		alive:  true,
	}

	// Read goroutine
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				data := make([]byte, n)
				copy(data, buf[:n])
				select {
				case t.output <- data:
				default: // drop if channel full
				}
			}
			if err != nil {
				if err != io.EOF {
					// terminal closed
				}
				t.mu.Lock()
				t.alive = false
				t.mu.Unlock()
				close(t.output)
				return
			}
		}
	}()

	return t, nil
}

func (t *PtyTerminal) Write(input string) error {
	_, err := t.ptmx.WriteString(input)
	return err
}

func (t *PtyTerminal) Read() <-chan []byte {
	return t.output
}

func (t *PtyTerminal) Resize(rows, cols int) error {
	ws := struct {
		Row, Col, Xpixel, Ypixel uint16
	}{uint16(rows), uint16(cols), 0, 0}
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, t.ptmx.Fd(),
		syscall.TIOCSWINSZ, uintptr(unsafe.Pointer(&ws)))
	if errno != 0 {
		return errno
	}
	return nil
}

func (t *PtyTerminal) Kill() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.alive = false
	t.ptmx.Close()
	if t.cmd.Process != nil {
		return t.cmd.Process.Kill()
	}
	return nil
}

func (t *PtyTerminal) IsAlive() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.alive
}

func (t *PtyTerminal) Fd() *os.File {
	return t.ptmx
}
