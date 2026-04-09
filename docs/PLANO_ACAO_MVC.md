# ReDo! — Plano de Ação: Reestruturação MVC

## Contexto

O projeto cresceu de um MCP experimental para um sistema completo de orquestração multi-agente com 3 interfaces (Web, TUI, CLI). Atualmente:

- **15 módulos Python** flat na raiz — sem package structure
- **1 arquivo HTML monolítico** de 1291 linhas (71KB) — HTML + CSS + JS misturados
- **Sem separação MVC** — `server.py` mistura rotas com lógica de negócio
- **Imports frágeis** — tudo importa tudo diretamente pela raiz

O projeto continuará sendo um **monolito distribuível**, mas precisa de organização interna para manutenção e expansão.

---

## Arquitetura Alvo

```
kiro-swarm/
├── run.sh                          # Entry point unificado
├── requirements.txt
├── .env / .env.example
│
├── app/                            # Package Python principal
│   ├── __init__.py
│   ├── main.py                     # FastAPI factory + uvicorn
│   ├── config.py                   # Constantes e configuração
│   │
│   ├── models/                     # [M] Modelos de dados
│   │   ├── __init__.py             # Re-exports
│   │   ├── agent.py                # AgentDef
│   │   ├── flow.py                 # Node, Edge, Flow, FlowDef
│   │   ├── project.py              # Project
│   │   ├── header.py               # HeaderDef
│   │   ├── protocol.py             # Signal
│   │   └── schemas.py              # Pydantic request/response models
│   │
│   ├── controllers/                # [C] Rotas HTTP (thin layer)
│   │   ├── __init__.py             # router aggregation
│   │   ├── agents.py
│   │   ├── flows.py
│   │   ├── projects.py
│   │   ├── headers.py
│   │   ├── settings.py
│   │   └── session.py
│   │
│   ├── services/                   # Lógica de negócio
│   │   ├── __init__.py
│   │   ├── registry.py             # Agent CRUD + persistence
│   │   ├── flow_service.py         # Flow CRUD + persistence
│   │   ├── project_service.py      # Project CRUD
│   │   ├── header_service.py       # Header CRUD + composition
│   │   ├── settings_service.py     # User settings
│   │   ├── session_service.py      # SwarmSession (web/interativo)
│   │   ├── orchestrator.py         # run_swarm (CLI batch)
│   │   └── data_collector.py       # Training data → MySQL
│   │
│   ├── core/                       # Engine (PTY, agentes, protocolo)
│   │   ├── __init__.py
│   │   ├── pty_agent.py            # PtyProcess + make_clean_env
│   │   ├── agent.py                # Agent (high-level)
│   │   ├── protocol.py             # Parse @handoff/@done
│   │   ├── output_parser.py        # ANSI strip, prompt detect
│   │   ├── god.py                  # GOD_AGENT watchdog
│   │   ├── checkpoint.py           # Git auto-commit/rollback
│   │   └── swarm_state.py          # Session persistence
│   │
│   ├── tui/                        # Interface Textual
│   │   ├── __init__.py
│   │   └── app.py
│   │
│   └── utils/                      # Utilitários
│       ├── __init__.py
│       └── logger.py
│
├── static/                         # [V] Frontend
│   ├── index.html                  # Shell HTML (estrutura + imports)
│   ├── css/
│   │   └── app.css                 # Estilos extraídos
│   └── js/
│       ├── app.js                  # Init, tabs, SSE handler
│       ├── api.js                  # Fetch wrapper
│       ├── state.js                # Estado global
│       ├── utils.js                # Helpers (escHtml, ts, etc.)
│       ├── agents.js               # Tab Agentes
│       ├── flow.js                 # Tab Flow (Drawflow)
│       ├── headers.js              # Tab Headers
│       ├── run.js                  # Tab Executar (chat, grid)
│       └── projects.js             # CRUD projetos
│
└── docs/                           # Documentação
```

---

## Fases de Execução

### Fase 1 — Estrutura e Models
1. Criar árvore de diretórios + `__init__.py`
2. Migrar `config.py` → `app/config.py`
3. Extrair dataclasses de `registry.py`, `flow.py`, `projects.py`, `headers.py`, `protocol.py` → `app/models/`
4. Criar `app/models/schemas.py` com os Pydantic models que estavam em `server.py`

### Fase 2 — Core Engine
5. Migrar `pty_agent.py`, `output_parser.py` → `app/core/` (imports de config atualizados)
6. Migrar `agent.py` → `app/core/agent.py`
7. Migrar `protocol.py` (parse function) → `app/core/protocol.py`
8. Migrar `god.py`, `checkpoint.py`, `swarm_state.py` → `app/core/`

### Fase 3 — Services
9. Migrar lógica CRUD de `registry.py`, `flow.py`, `projects.py`, `headers.py`, `settings.py` → `app/services/`
10. Migrar `session.py` → `app/services/session_service.py`
11. Migrar `orchestrator.py` → `app/services/orchestrator.py`
12. Migrar `data_collector.py` → `app/services/data_collector.py`

### Fase 4 — Controllers + Main
13. Extrair rotas de `server.py` → `app/controllers/` (um arquivo por domínio)
14. Criar `app/main.py` — FastAPI factory, mount static, include routers

### Fase 5 — TUI + Utils
15. Migrar `app.py` → `app/tui/app.py`
16. Migrar `logger.py` → `app/utils/logger.py`

### Fase 6 — Frontend Split
17. Extrair `<style>` → `static/css/app.css`
18. Extrair `<script>` → módulos JS separados em `static/js/`
19. Reduzir `index.html` a shell HTML com `<link>` e `<script src>`

### Fase 7 — Entry Points + Cleanup
20. Atualizar `run.sh` para apontar para `app/main.py`, `app/tui/app.py`, `app/services/orchestrator.py`
21. Remover arquivos `.py` antigos da raiz
22. Limpar `__pycache__/` da raiz

---

## Riscos e Mitigações

| Risco | Impacto | Mitigação |
|-------|---------|-----------|
| Imports circulares entre services e core | App não inicia | Models são puros (sem imports de services); services importam core, nunca o contrário |
| Path do `static/` muda | Frontend 404 | `app/main.py` usa `Path(__file__).parent.parent / 'static'` |
| TUI importa de paths antigos | TUI quebra | Atualizar todos os imports em `app/tui/app.py` |
| JS modules com CORS em dev | JS não carrega | Usar `<script>` tags normais (não ES modules) com ordem de carregamento |
| `__pycache__` stale | Import errors | Limpar todos os `__pycache__` antes de testar |

---

## Critérios de Sucesso

- [ ] `./run.sh web` inicia o servidor na porta 8420
- [ ] `./run.sh tui` abre a TUI Textual
- [ ] `./run.sh run` executa o orchestrator CLI
- [ ] Todas as tabs da UI web funcionam (Agentes, Flow, Headers, Executar)
- [ ] SSE streaming funciona
- [ ] Nenhum arquivo `.py` na raiz (exceto se necessário para compatibilidade)
- [ ] Frontend carrega sem erros no console
