#!/usr/bin/env python3
"""ReDo! TUI — manage agents and run swarm conversations."""

from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.widgets import (
    Header, Footer, Static, Button, Input, TextArea, ListView, ListItem, Label,
    RichLog,
)
from textual.screen import ModalScreen
from textual import on, work

import registry
from registry import AgentDef


# ── Agent Form Modal ──────────────────────────────────────────────────────

class AgentFormScreen(ModalScreen[AgentDef | None]):
    """Modal for creating/editing an agent."""

    CSS = """
    AgentFormScreen { align: center middle; }
    #form-box {
        width: 70; height: auto; max-height: 80%;
        border: thick $accent; padding: 1 2; background: $surface;
    }
    #form-box Input, #form-box TextArea { margin-bottom: 1; }
    #form-buttons { height: 3; align: center middle; }
    """

    def __init__(self, agent: AgentDef | None = None):
        super().__init__()
        self.agent = agent

    def compose(self) -> ComposeResult:
        a = self.agent
        with Vertical(id="form-box"):
            yield Label("Editar Agente" if a else "Novo Agente", id="form-title")
            yield Label("ID (único, sem espaços):")
            yield Input(value=a.id if a else "", id="f-id", disabled=bool(a))
            yield Label("Nome:")
            yield Input(value=a.name if a else "", id="f-name")
            yield Label("Cor (red/green/blue/yellow/cyan/magenta):")
            yield Input(value=a.color if a else "white", id="f-color")
            yield Label("Modelo (vazio = auto):")
            yield Input(value=a.model or "" if a else "", id="f-model")
            yield Label("Persona:")
            yield TextArea(a.persona if a else "", id="f-persona")
            with Horizontal(id="form-buttons"):
                yield Button("Salvar", variant="primary", id="btn-save")
                yield Button("Cancelar", id="btn-cancel")

    @on(Button.Pressed, "#btn-save")
    def save(self) -> None:
        agent_id = self.query_one("#f-id", Input).value.strip()
        name = self.query_one("#f-name", Input).value.strip()
        color = self.query_one("#f-color", Input).value.strip() or "white"
        model = self.query_one("#f-model", Input).value.strip() or None
        persona = self.query_one("#f-persona", TextArea).text.strip()
        if not agent_id or not name or not persona:
            self.notify("ID, Nome e Persona são obrigatórios", severity="error")
            return
        self.dismiss(AgentDef(id=agent_id, name=name, persona=persona, color=color, model=model))

    @on(Button.Pressed, "#btn-cancel")
    def cancel(self) -> None:
        self.dismiss(None)


# ── Main App ──────────────────────────────────────────────────────────────

class SwarmApp(App):
    CSS = """
    #main { height: 1fr; }
    #sidebar { width: 30; border-right: solid $accent; padding: 0 1; }
    #sidebar-buttons { height: 3; dock: bottom; }
    #content { width: 1fr; padding: 1 2; }
    #agent-detail { height: 1fr; }
    #run-section { height: auto; dock: bottom; padding: 1; border-top: solid $accent; }
    #run-log { height: 20; }
    .agent-item { height: 3; padding: 0 1; }
    """

    BINDINGS = [
        ("a", "add_agent", "Adicionar"),
        ("d", "delete_agent", "Remover"),
        ("e", "edit_agent", "Editar"),
        ("r", "run_swarm", "Rodar Swarm"),
        ("q", "quit", "Sair"),
    ]

    def __init__(self):
        super().__init__()
        self.agents: list[AgentDef] = registry.load()
        self.selected_id: str | None = None

    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        with Horizontal(id="main"):
            with Vertical(id="sidebar"):
                yield Label("🐝 Agentes", id="sidebar-title")
                yield ListView(id="agent-list")
                with Horizontal(id="sidebar-buttons"):
                    yield Button("+", variant="success", id="btn-add")
                    yield Button("✎", id="btn-edit")
                    yield Button("✕", variant="error", id="btn-del")
            with Vertical(id="content"):
                yield VerticalScroll(Static("Selecione um agente", id="agent-detail"))
                with Vertical(id="run-section"):
                    yield Label("Pergunta inicial:")
                    yield Input(
                        placeholder="Ex: Como podemos melhorar esse projeto?",
                        id="run-input",
                    )
                    yield Button("▶ Rodar Swarm", variant="primary", id="btn-run")
                    yield RichLog(id="run-log", wrap=True, markup=True)
        yield Footer()

    def on_mount(self) -> None:
        self._refresh_list()

    def _refresh_list(self) -> None:
        self.agents = registry.load()
        lv = self.query_one("#agent-list", ListView)
        lv.clear()
        for a in self.agents:
            lv.append(ListItem(Label(f"[{a.color}]● {a.name}[/] ({a.id})")))

    def _show_detail(self, agent: AgentDef) -> None:
        detail = self.query_one("#agent-detail", Static)
        detail.update(
            f"[bold]{agent.name}[/] ({agent.id})\n"
            f"Cor: [{agent.color}]●[/] {agent.color}\n"
            f"Modelo: {agent.model or 'auto'}\n\n"
            f"[dim]Persona:[/]\n{agent.persona}"
        )

    @on(ListView.Selected, "#agent-list")
    def on_agent_selected(self, event: ListView.Selected) -> None:
        idx = event.list_view.index
        if idx is not None and idx < len(self.agents):
            self.selected_id = self.agents[idx].id
            self._show_detail(self.agents[idx])

    # ── CRUD ──────────────────────────────────────────────────────

    @on(Button.Pressed, "#btn-add")
    def action_add_agent(self) -> None:
        def on_result(result: AgentDef | None) -> None:
            if result:
                try:
                    registry.add(result)
                    self._refresh_list()
                    self.notify(f"Agente '{result.name}' criado")
                except ValueError as e:
                    self.notify(str(e), severity="error")
        self.push_screen(AgentFormScreen(), callback=on_result)

    @on(Button.Pressed, "#btn-edit")
    def action_edit_agent(self) -> None:
        agent = registry.get(self.selected_id) if self.selected_id else None
        if not agent:
            self.notify("Selecione um agente", severity="warning")
            return
        def on_result(result: AgentDef | None) -> None:
            if result:
                registry.update(result)
                self._refresh_list()
                self._show_detail(result)
                self.notify(f"Agente '{result.name}' atualizado")
        self.push_screen(AgentFormScreen(agent), callback=on_result)

    @on(Button.Pressed, "#btn-del")
    def action_delete_agent(self) -> None:
        if not self.selected_id:
            self.notify("Selecione um agente", severity="warning")
            return
        registry.remove(self.selected_id)
        self.selected_id = None
        self._refresh_list()
        self.query_one("#agent-detail", Static).update("Selecione um agente")
        self.notify("Agente removido")

    # ── Run Swarm ─────────────────────────────────────────────────

    @on(Button.Pressed, "#btn-run")
    def action_run_swarm(self) -> None:
        question = self.query_one("#run-input", Input).value.strip()
        if not question:
            self.notify("Digite uma pergunta", severity="warning")
            return
        if len(self.agents) < 2:
            self.notify("Cadastre pelo menos 2 agentes", severity="warning")
            return
        self._run_swarm(question)

    @work(thread=True)
    def _run_swarm(self, question: str) -> None:
        """Run the swarm orchestrator in a background thread."""
        log = self.query_one("#run-log", RichLog)
        log.clear()
        log.write("[bold yellow]Starting swarm...[/]")

        from orchestrator import run_swarm
        from logger import Logger

        class TuiLogger(Logger):
            def __init__(self, rich_log: RichLog):
                super().__init__()
                self._log = rich_log

            def orch(self, msg: str) -> None:
                self._log.write(f"[yellow][ORCH][/] {msg}")

            def agent(self, name: str, event: str, text: str) -> None:
                color = "white"
                for a in registry.load():
                    if a.name == name:
                        color = a.color
                        break
                self._log.write(f"[{color}][{name}][/] [dim]{event}[/]")
                if text:
                    for line in text.split('\n')[:20]:
                        self._log.write(f"  [{color}]│[/] {line}")
                    if text.count('\n') > 20:
                        self._log.write(f"  [{color}]│[/] ... ({text.count(chr(10))} lines total)")

            def error(self, msg: str) -> None:
                self._log.write(f"[red][ERROR][/] {msg}")

        tui_log = TuiLogger(log)
        try:
            run_swarm(question, '.', tui_log)
        except Exception as e:
            log.write(f"[red]Error: {e}[/]")


if __name__ == '__main__':
    SwarmApp().run()
