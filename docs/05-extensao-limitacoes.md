# ReDo! — Pontos de Extensão e Limitações Conhecidas

## Pontos de Extensão

### 1. Adicionar Novos Agentes
- Editar `agents.json` ou usar a UI (web/TUI)
- Cada agente precisa: `id`, `name`, `persona`, `color`, opcionalmente `model` e `mcps`
- MCPs são configurados por agente: cada um pode ter ferramentas diferentes
- Exemplo: um agente com MCP de browser, outro com MCP de banco de dados

### 2. Modificar o Grafo de Fluxo
- Editar `flow.json` ou usar a UI web (drag-and-drop de nós)
- Adicionar/remover arestas controla quem pode fazer handoff para quem
- `start_node` define qual agente recebe a primeira mensagem
- Topologias possíveis: linear, hub-spoke, mesh parcial, etc.

### 3. Customizar MCPs por Agente
- Campo `mcps` no `agents.json` aceita qualquer servidor MCP
- Formato: `{"nome": {"command": "...", "args": [...], "timeout": N}}`
- O `pty_agent.py:make_clean_env()` escreve o `mcp.json` no HOME temporário
- Cada agente pode ter um conjunto completamente diferente de ferramentas

### 4. Implementar Novos EventCallbacks
- `session_service.py:EventCallback` é uma interface com métodos: `on_orch`, `on_agent`, `on_error`, `on_summary`, `on_done`
- Implementações existentes: `SSECallback` (em `controllers/session.py`), `TuiLogger` (TUI)
- Pode-se criar callbacks para: Slack, Discord, arquivo de log, métricas, etc.

### 5. Substituir o Logger
- `logger.py:Logger` é passado ao `run_swarm()` como parâmetro
- `app.py` já demonstra isso com `TuiLogger` que herda de `Logger`
- Pode-se criar loggers para qualquer destino

### 6. Customizar a Persona do GOD_AGENT
- `config.py:GOD_PERSONA` pode ser editada para mudar critérios de supervisão
- Pode-se adicionar novos comandos (requer mudança em `god.py:_CMD_RE` e no orchestrator)

### 7. Adicionar Novos Endpoints na API Web
- `main.py` usa FastAPI com controllers modulares — adicionar rotas é trivial
- O estado da sessão é encapsulado em `SessionState` (classe com `__slots__` em `controllers/session.py`)

### 8. Customizar Header Templates
- Headers são gerenciados via `header_service.py` com CRUD completo
- Três tipos: `protocol` (instruções de protocolo), `wrapper` (envolve 1ª mensagem), `handoff` (mensagem de handoff)
- Placeholders disponíveis por tipo definidos em `app/models/header.py:AVAILABLE_PLACEHOLDERS`
- Headers podem ser atribuídos por nó do flow ou como default do flow

### 9. Coleta de Training Data
- `data_collector.py` salva pares input/output em MySQL remoto
- Configurável via `.env` (MYSQL_HOST, MYSQL_DB, etc.)
- Desativável via `settings_service` (`data_collection: false`)

### 10. Estender o Environment Manager (env-manager)
- `env_mcp_server.py` expõe 5 tools via MCP — novas tools podem ser adicionadas com decorators do SDK `mcp`
- Ring buffer configurável via `ENV_MCP_BUFFER_LINES` em `config.py`
- Injeção automática desativável via `ENV_MCP_AUTO_INJECT=False` em `config.py`
- Extensões futuras planejadas: port forwarding awareness, health checks HTTP, monitoramento de CPU/memória, integração Docker

## Limitações Conhecidas

### 1. Sessão Única (Web)
- Apenas uma `SwarmSession` ativa por vez (encapsulada em `SessionState` em `controllers/session.py`)
- Não suporta múltiplos usuários/projetos simultâneos
- Abrir nova sessão fecha a anterior

### 2. Dependência do kiro-cli
- O sistema depende do `kiro-cli` estar instalado e autenticado
- Mudanças no formato do prompt do kiro-cli (`\d+%\s*!>`) quebram a detecção
- Mudanças nos comandos `/chat save`, `/chat load`, `/compact`, `/quit` quebram funcionalidades

### 3. Detecção de Resposta Frágil
- Baseada em heurísticas: keywords de processamento + regex de prompt
- Se o kiro-cli mudar o formato de output, a detecção falha
- `PROMPT_TAIL_CHARS=50` pode não ser suficiente se o prompt mudar

### 4. Sem Comunicação Direta Entre Agentes
- Toda comunicação passa pelo orchestrator
- Agentes não podem "conversar" entre si em tempo real
- O protocolo é request-response síncrono (um agente por vez)

### 5. GOD_AGENT Limitado
- Só monitora saúde técnica, não qualidade das respostas
- Detecção de loop é simples (contagem de chamadas consecutivas)
- Não tem visão do conteúdo das respostas, apenas metadata

### 6. Sem Paralelismo de Agentes
- Apenas um agente processa por vez (loop sequencial)
- Não há suporte para fan-out (enviar para múltiplos agentes em paralelo)
- O flow graph é dirigido mas a execução é linear

### 7. Git Checkpoint Limitado
- Faz `git add -A` (adiciona tudo, incluindo arquivos indesejados)
- Não tem `.gitignore` awareness específico
- Stash pode conflitar com stashes existentes do usuário
- `--allow-empty` cria commits vazios desnecessários

### 8. Persistência de Sessão Frágil
- Depende do comando `/chat save` do kiro-cli funcionar corretamente
- Timeout fixo de 30s para save pode não ser suficiente
- Resume pode falhar se o formato de sessão do kiro-cli mudar

### 9. Sem Autenticação na API Web
- Endpoints REST não têm autenticação
- Qualquer pessoa na rede pode controlar o swarm
- Porta 8420 hardcoded

### 10. Escalabilidade
- Cada agente é um processo PTY completo (pesado em memória)
- `MAX_HANDOFF_ROUNDS=10` limita a profundidade da conversa
- Sem mecanismo de garbage collection de contexto (além do `/compact` do GOD)

### 11. Tratamento de Erros
- Muitos `try/except` com `pass` silencioso (especialmente em persistência)
- Falha no save de estado não interrompe a execução
- Erros do GOD_AGENT são silenciados

### 12. Configuração Estática de Agentes
- `agents.json` e `flows.json` são lidos no startup
- Mudanças durante execução não são refletidas (exceto via API web que recarrega)
- Não há hot-reload de personas ou configurações

### 13. Bug: `_init_agent` Duplicada no Orchestrator
- `orchestrator.py` define `_init_agent` duas vezes — a segunda sobrescreve a primeira
- A primeira usa `compose_persona()` de `agent_helpers`, a segunda reimplementa inline
- Impacto: a versão com `agent_helpers` nunca é executada no modo batch

## Limitações Resolvidas

### ~~execute_bash Bloqueante~~ (resolvido pelo Environment Manager)
- **Problema**: `execute_bash` do kiro-cli é síncrono — comandos long-running (servidores, builds) bloqueavam o agente indefinidamente. Impossível subir múltiplos serviços ou ver erros de runtime.
- **Solução**: MCP `env-manager` injetado automaticamente em todo agente, expondo `env_run`/`env_status`/`env_logs`/`env_stop`/`env_input` para gerenciamento de processos background sem bloqueio.
- **Limitações residuais do env-manager**:
  - Ring buffer de 500 linhas — logs muito longos perdem linhas antigas
  - Sem detecção automática de portas abertas pelos processos
  - Sem health checks HTTP automáticos
  - `state_dir` em `/tmp/` — perdido em reboot do sistema
