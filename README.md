# ReDo! MVP

Sistema de orquestração multi-agente que coordena múltiplas instâncias do `kiro-cli` via PTYs isolados.

## Requisitos

- `kiro-cli` instalado e autenticado
- Python 3.10+
- `pip install -r requirements.txt`

## Uso

```bash
cd kiro-swarm
chmod +x run.sh

# Web UI (porta 8420)
./run.sh web

# TUI (Textual)
./run.sh tui

# CLI batch
./run.sh run /caminho/do/projeto "pergunta"
```

## Arquitetura

```
app/
├── main.py              # FastAPI entry point
├── config.py            # Constantes e configuração
├── models/              # Dataclasses e schemas Pydantic
├── controllers/         # Rotas HTTP (thin layer)
├── services/            # Lógica de negócio
├── core/                # Engine (PTY, agentes, protocolo)
├── tui/                 # Interface Textual
└── utils/               # Logger e utilitários

static/
├── index.html           # HTML shell
├── css/app.css          # Estilos
└── js/                  # Módulos JS (agents, flow, headers, run, etc.)
```

## O que acontece

1. Agentes kiro-cli são iniciados em PTYs isolados (sem MCPs, startup rápido)
2. Comunicação via protocolo `@handoff(agent_id)` / `@done`
3. Grafo de fluxo dirigido define quais agentes podem se comunicar
4. GOD_AGENT monitora saúde técnica do swarm
5. Git checkpoints a cada round, rollback em caso de erro
6. Transcript salvo em `<projeto>/.kiro-swarm/`

## Observabilidade

- Web: SSE streaming em tempo real, grid de agentes, chat por agente
- TUI: Output colorido com CRUD de agentes
- CLI: Logs coloridos no terminal + transcript JSON
