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
- `session.py:EventCallback` é uma interface com métodos: `on_orch`, `on_agent`, `on_error`, `on_summary`, `on_done`
- Implementações existentes: `SSECallback` (web), `TuiLogger` (TUI)
- Pode-se criar callbacks para: Slack, Discord, arquivo de log, métricas, etc.

### 5. Substituir o Logger
- `logger.py:Logger` é passado ao `run_swarm()` como parâmetro
- `app.py` já demonstra isso com `TuiLogger` que herda de `Logger`
- Pode-se criar loggers para qualquer destino

### 6. Customizar a Persona do GOD_AGENT
- `config.py:GOD_PERSONA` pode ser editada para mudar critérios de supervisão
- Pode-se adicionar novos comandos (requer mudança em `god.py:_CMD_RE` e no orchestrator)

### 7. Adicionar Novos Endpoints na API Web
- `server.py` usa FastAPI — adicionar rotas é trivial
- O `active_session` é global e acessível de qualquer endpoint

## Limitações Conhecidas

### 1. Sessão Única (Web)
- Apenas uma `SwarmSession` ativa por vez (`active_session` global em `server.py`)
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
- `agents.json` e `flow.json` são lidos no startup
- Mudanças durante execução não são refletidas (exceto via API web que recarrega)
- Não há hot-reload de personas ou configurações
