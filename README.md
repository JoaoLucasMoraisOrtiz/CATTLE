<div align="center">

# 🐄 ReDo!

### **Multi-agent orchestrator — desktop app built with Go + Wails**

[![Go 1.23+](https://img.shields.io/badge/go-1.23+-00ADD8.svg)](https://go.dev)
[![Wails v2](https://img.shields.io/badge/wails-v2-8B5CF6.svg)](https://wails.io)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

[English](#english) · [Português](#português)

---

<img src="https://img.shields.io/badge/kiro--cli-supported-blue?style=flat-square" alt="kiro-cli">
<img src="https://img.shields.io/badge/gemini--cli-supported-orange?style=flat-square" alt="gemini-cli">

</div>

---

<a name="english"></a>

## 🇺🇸 English

### What is ReDo?

ReDo is a **desktop multi-agent orchestrator** that spawns CLI coding assistants (kiro-cli, gemini-cli) via isolated PTYs and coordinates them through a native UI. Think of it as a **swarm of AI developers** working together on your codebase — each with a specialized role, communicating through a structured protocol.

### ✨ Key Features

| Feature | Description |
|---------|-------------|
| 🤖 **Multi-CLI Support** | Orchestrate kiro-cli and gemini-cli agents side by side |
| 📡 **Real-time Terminal** | Live xterm.js terminals showing each agent's work |
| 🔄 **@handoff / @done Protocol** | Agents pass tasks to each other with structured handoffs |
| 🗄️ **Knowledge Base** | MySQL-backed message & KB storage with embedding search |
| 🖥️ **Native Desktop App** | Built with Wails — no browser needed |

### 🚀 Quick Start

```bash
# Prerequisites: Go 1.23+, Wails CLI
go install github.com/wailsapp/wails/v2/cmd/wails@latest

# Clone & run
git clone https://github.com/JoaoLucasMoraisOrtiz/CATTLE.git
cd CATTLE
make dev
```

### 📁 Architecture

```
main.go                 # Wails entrypoint
app.go                  # App struct — binds Go ↔ frontend
internal/
├── domain/             # Types & port interfaces
├── service/            # Business logic (terminal service)
└── infra/
    ├── config/         # JSON config loader
    ├── terminal/       # PTY driver, env management
    ├── mysql/          # Message & KB repositories, schema
    ├── embedding/      # Embedding server & client
    ├── persistence/    # File persistence
    └── watcher/        # File watcher
frontend/
├── index.html          # Main HTML shell
├── src/                # JS + CSS (xterm.js UI)
└── lib/                # Vendored libs (xterm)
```

### 🛠️ Requirements

- Go 1.23+
- [Wails CLI](https://wails.io/docs/gettingstarted/installation)
- `kiro-cli` and/or `gemini-cli` installed and authenticated
- MySQL (optional, for data collection)

---

<a name="português"></a>

## 🇧🇷 Português

### O que é o ReDo?

ReDo é um **orquestrador multi-agente desktop** que cria assistentes de código CLI (kiro-cli, gemini-cli) via PTYs isolados e os coordena através de uma UI nativa. Pense nele como um **enxame de desenvolvedores IA** trabalhando juntos no seu código.

### 🚀 Início Rápido

```bash
# Pré-requisitos: Go 1.23+, Wails CLI
go install github.com/wailsapp/wails/v2/cmd/wails@latest

# Clone & execute
git clone https://github.com/JoaoLucasMoraisOrtiz/CATTLE.git
cd CATTLE
make dev
```

### 🛠️ Requisitos

- Go 1.23+
- [Wails CLI](https://wails.io/docs/gettingstarted/installation)
- `kiro-cli` e/ou `gemini-cli` instalados e autenticados
- MySQL (opcional, para coleta de dados)

---

<div align="center">

**Built with ❤️ by [João Lucas Morais Ortiz](https://github.com/JoaoLucasMoraisOrtiz)**

*ReDo — porque até IAs trabalham melhor com humanos.* 🐄

</div>
