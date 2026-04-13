<div align="center">

# 🐄 CATTLE

### **Coordinated Agents Through Transparent Linked Execution**

*Multi-agent orchestrator that turns CLI coding assistants into a collaborative swarm.*

[![Python 3.10+](https://img.shields.io/badge/python-3.10+-blue.svg)](https://python.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.100+-teal.svg)](https://fastapi.tiangolo.com)

[English](#english) · [Português](#português)

---

<img src="https://img.shields.io/badge/kiro--cli-supported-blue?style=flat-square" alt="kiro-cli">
<img src="https://img.shields.io/badge/gemini--cli-supported-orange?style=flat-square" alt="gemini-cli">

</div>

---

<a name="english"></a>

## 🇺🇸 English

### What is CATTLE?

CATTLE is a **multi-agent orchestrator** that wraps multiple CLI coding assistants (kiro-cli, gemini-cli) via isolated PTYs and coordinates them through a visual web UI. Think of it as a **swarm of AI developers** working together on your codebase — each with a specialized role, communicating through a structured protocol.

### ✨ Key Features

| Feature | Description |
|---------|-------------|
| 🤖 **Multi-CLI Support** | Orchestrate kiro-cli and gemini-cli agents side by side |
| 🔀 **Visual Flow Editor** | Drag-and-drop Drawflow editor to design agent communication graphs |
| 📡 **Real-time Streaming** | Live SSE streaming grid showing each agent's work in real time |
| 💬 **Agent Chat** | Talk directly to any agent or broadcast to the entire swarm |
| 🔄 **@handoff / @done Protocol** | Agents pass tasks to each other with structured handoffs |
| 📊 **Cost Tracking** | Per-agent token estimation and USD cost display |
| 🔒 **Git Checkpoints** | Automatic git commit per round, rollback on errors |
| 🗂️ **Multi-Project Tabs** | Run multiple projects simultaneously with independent sessions |
| ⚙️ **Configurable Headers** | Protocol, wrapper, and handoff templates with placeholders |
| 📋 **Data Collection** | Optional MySQL logging with hashed project paths for anonymity |

### 🚀 Quick Start

```bash
# Clone
git clone https://github.com/JoaoLucasMoraisOrtiz/CATTLE.git
cd CATTLE

# Install
pip install -r requirements.txt

# Run (Web UI on port 8420)
./run.sh web
```

Open **http://localhost:8420** and you're ready to go.

### 🏗️ How It Works

```
You → Web UI → Orchestrator → Agent 1 (kiro-cli) ──@handoff──→ Agent 2 (gemini-cli)
                                  ↑                                    │
                                  └────────────@handoff────────────────┘
```

1. **Agents** are spawned as isolated PTY processes (kiro-cli or gemini-cli)
2. **Flows** define which agents can communicate (visual graph editor)
3. **Protocol** — agents end responses with `@handoff(agent_id): task` or `@done: summary`
4. **Orchestrator** routes messages based on the flow graph
5. **Git checkpoints** are created each round; auto-compact after `@done`

### 📁 Architecture

```
app/
├── core/           # PTY engine, agent driver, protocol parser
├── controllers/    # FastAPI routes (thin layer)
├── services/       # Business logic (session, headers, costs)
└── models/         # Dataclasses & Pydantic schemas

static/
├── index.html      # Single-page app
├── css/app.css     # Dark theme UI
└── js/             # Modular JS (agents, flow, run, settings)
```

---

<a name="português"></a>

## 🇧🇷 Português

### O que é o CATTLE?

CATTLE é um **orquestrador multi-agente** que envolve múltiplos assistentes de código CLI (kiro-cli, gemini-cli) via PTYs isolados e os coordena através de uma interface web visual. Pense nele como um **enxame de desenvolvedores IA** trabalhando juntos no seu código — cada um com um papel especializado, comunicando-se através de um protocolo estruturado.

### ✨ Funcionalidades

| Funcionalidade | Descrição |
|----------------|-----------|
| 🤖 **Suporte Multi-CLI** | Orquestre agentes kiro-cli e gemini-cli lado a lado |
| 🔀 **Editor Visual de Fluxos** | Editor Drawflow drag-and-drop para desenhar grafos de comunicação |
| 📡 **Streaming em Tempo Real** | Grid SSE ao vivo mostrando o trabalho de cada agente |
| 💬 **Chat com Agentes** | Fale diretamente com qualquer agente ou envie para o swarm inteiro |
| 🔄 **Protocolo @handoff / @done** | Agentes passam tarefas entre si com handoffs estruturados |
| 📊 **Rastreamento de Custos** | Estimativa de tokens e custo em USD por agente |
| 🔒 **Checkpoints Git** | Commit automático por rodada, rollback em caso de erro |
| 🗂️ **Abas Multi-Projeto** | Execute múltiplos projetos simultaneamente com sessões independentes |
| ⚙️ **Headers Configuráveis** | Templates de protocolo, wrapper e handoff com placeholders |
| 📋 **Coleta de Dados** | Logging opcional em MySQL com hash de caminhos para anonimato |

### 🚀 Início Rápido

```bash
# Clone
git clone https://github.com/JoaoLucasMoraisOrtiz/CATTLE.git
cd CATTLE

# Instale
pip install -r requirements.txt

# Execute (Web UI na porta 8420)
./run.sh web
```

Abra **http://localhost:8420** e pronto.

### 🏗️ Como Funciona

```
Você → Web UI → Orquestrador → Agente 1 (kiro-cli) ──@handoff──→ Agente 2 (gemini-cli)
                                    ↑                                      │
                                    └──────────@handoff────────────────────┘
```

1. **Agentes** são criados como processos PTY isolados (kiro-cli ou gemini-cli)
2. **Fluxos** definem quais agentes podem se comunicar (editor visual de grafos)
3. **Protocolo** — agentes terminam respostas com `@handoff(id_agente): tarefa` ou `@done: resumo`
4. **Orquestrador** roteia mensagens baseado no grafo de fluxo
5. **Checkpoints git** são criados a cada rodada; auto-compactação após `@done`

### 🛠️ Requisitos

- Python 3.10+
- `kiro-cli` e/ou `gemini-cli` instalados e autenticados
- Node.js (para gemini-cli)

---

<div align="center">

**Built with ❤️ by [João Lucas Morais Ortiz](https://github.com/JoaoLucasMoraisOrtiz)**

*CATTLE — porque até IAs trabalham melhor em equipe.* 🐄

</div>
