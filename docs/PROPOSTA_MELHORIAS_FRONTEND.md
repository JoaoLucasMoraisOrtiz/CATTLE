# ReDo! — Proposta de Melhorias do Frontend

## Diagnóstico do Estado Atual

O frontend é funcional mas frágil. Composto por `index.html` (~230 linhas), `app.css` (~80 linhas) e 8 módulos JS (~900 linhas total). Usa Tailwind CDN + Drawflow CDN. Tema dark hardcoded.

### Problemas Identificados

| Categoria | Problema | Impacto |
|-----------|----------|---------|
| Resiliência | Nenhum `fetch()` tem `try/catch` — qualquer erro de rede quebra silenciosamente | Alto |
| Resiliência | SSE (`EventSource`) sem reconnect automático — se cair, o usuário perde streaming | Alto |
| UX | Sem loading states — cliques em botões não dão feedback visual | Médio |
| UX | Sem sistema de notificações/toasts — erros e sucessos passam despercebidos | Médio |
| UX | Sem validação visual de formulários — campos obrigatórios não indicam erro | Médio |
| UX | Chat não renderiza markdown — respostas dos agentes saem como texto puro | Médio |
| UX | Sem busca/filtro em listas de agentes, headers e flows | Baixo |
| UX | Sem copy-to-clipboard nas respostas dos agentes | Baixo |
| Acessibilidade | Zero atributos ARIA em modais, tabs, botões | Alto |
| Acessibilidade | Modais não travam foco (focus trap) | Médio |
| Acessibilidade | Tabs não usam `role="tablist"` / `role="tab"` / `role="tabpanel"` | Médio |
| Responsividade | Layout quebra em telas < 768px — sidebars fixas, grid não adapta | Médio |
| Código | Estado global em variáveis soltas (`let agents = []`, etc.) — difícil de rastrear | Médio |
| Código | `utils.js` tem apenas 4 funções — falta um wrapper de fetch centralizado | Médio |
| Performance | Tailwind CDN (~300KB) carregado em runtime — deveria ser build-time | Baixo |

---

## Melhorias Propostas

### Fase 1 — Resiliência (Crítico)

#### 1.1 Fetch wrapper com error handling
Criar `api.js` com função centralizada que envolve todos os `fetch()`:
- `try/catch` em toda chamada
- Toast automático em caso de erro HTTP ou rede
- Retorno padronizado `{ ok, data, error }`
- Loading state automático via flag

#### 1.2 SSE com reconnect automático
- Reconnect com backoff exponencial (1s, 2s, 4s, max 30s)
- Indicador visual de conexão perdida no header
- Re-subscribe automático ao reconectar

#### 1.3 Validação de formulários
- Highlight visual em campos obrigatórios vazios
- Mensagens de erro inline nos modais de agente, header e projeto
- Prevenir submit com dados inválidos

### Fase 2 — UX (Importante)

#### 2.1 Sistema de toasts
- Container fixo no canto inferior direito
- Tipos: success (verde), error (vermelho), info (azul), warning (amarelo)
- Auto-dismiss em 4s, com botão de fechar
- Integrado ao fetch wrapper

#### 2.2 Loading states
- Botões mostram spinner durante operações async
- Skeleton loading nas listas ao carregar dados
- Disable de botões durante operações em andamento

#### 2.3 Markdown no chat
- Integrar `marked.js` (CDN, ~30KB) para renderizar respostas dos agentes
- Syntax highlighting com `highlight.js` para blocos de código
- Sanitização via `DOMPurify` para prevenir XSS

#### 2.4 Busca e filtro
- Campo de busca na lista de agentes (filtra por nome/persona)
- Campo de busca na lista de headers (filtra por nome/conteúdo)
- Filtro por tipo nos headers (protocol/wrapper/handoff)

#### 2.5 Copy-to-clipboard
- Botão de copiar em cada resposta de agente no chat
- Botão de copiar em blocos de código renderizados
- Feedback visual (ícone muda para ✓ por 2s)

### Fase 3 — Acessibilidade (Importante)

#### 3.1 ARIA nos tabs
- `role="tablist"` no container de tabs
- `role="tab"` + `aria-selected` em cada botão
- `role="tabpanel"` + `aria-labelledby` em cada view
- Navegação por setas ←→ entre tabs

#### 3.2 ARIA nos modais
- `role="dialog"` + `aria-modal="true"` + `aria-labelledby`
- Focus trap: Tab/Shift+Tab cicla dentro do modal
- Foco automático no primeiro campo ao abrir
- Retorno de foco ao elemento que abriu o modal

#### 3.3 Labels e landmarks
- `aria-label` em botões que só têm ícone (✕, ✎, +)
- `<main>`, `<nav>`, `<aside>` semânticos onde aplicável
- `aria-live="polite"` no container de toasts e status

### Fase 4 — Responsividade (Desejável)

#### 4.1 Layout mobile
- Sidebar de agentes colapsa em drawer no mobile (< 768px)
- Tabs viram menu hamburger ou scroll horizontal
- Grid de agentes no Run vira coluna única
- Modais ocupam tela cheia no mobile

#### 4.2 Flow editor mobile
- Desabilitar drag-and-drop no mobile (tela muito pequena)
- Mostrar aviso "Use desktop para editar flows"
- Permitir visualização read-only do flow

### Fase 5 — Qualidade de Código (Desejável)

#### 5.1 Estado centralizado
- Criar objeto `State` em `state.js` com getters/setters
- Emitir eventos customizados (`CustomEvent`) em mudanças de estado
- Componentes reagem a eventos ao invés de manipular DOM diretamente

#### 5.2 API module
- Mover todas as chamadas fetch para `api.js`
- Cada módulo importa funções do `api.js` ao invés de fazer fetch direto
- Centraliza URL base, headers, error handling

---

## Priorização

| Fase | Esforço | Impacto | Prioridade |
|------|---------|---------|------------|
| 1 — Resiliência | Baixo | Alto | P0 |
| 2 — UX | Médio | Alto | P1 |
| 3 — Acessibilidade | Médio | Médio | P1 |
| 4 — Responsividade | Alto | Médio | P2 |
| 5 — Qualidade de Código | Médio | Médio | P2 |

---

## Arquivos Afetados

| Arquivo | Ações |
|---------|-------|
| `static/js/utils.js` | Adicionar toast system, fetch wrapper |
| `static/js/api.js` | **Novo** — módulo centralizado de API |
| `static/js/state.js` | Refatorar para objeto State com eventos |
| `static/js/agents.js` | Usar api.js, adicionar busca, loading states |
| `static/js/headers.js` | Usar api.js, adicionar busca/filtro, loading states |
| `static/js/flow.js` | Usar api.js, loading states |
| `static/js/run.js` | SSE reconnect, markdown rendering, copy-to-clipboard |
| `static/js/projects.js` | Usar api.js, validação, loading states |
| `static/js/app.js` | ARIA tabs, keyboard nav |
| `static/css/app.css` | Estilos para toasts, loading, responsive |
| `static/index.html` | ARIA attributes, semantic HTML, CDN imports (marked, hljs) |

## Dependências Externas Novas

- `marked.js` (CDN) — renderização markdown
- `highlight.js` (CDN) — syntax highlighting em code blocks
- `DOMPurify` (CDN) — sanitização HTML
