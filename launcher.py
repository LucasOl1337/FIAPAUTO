from __future__ import annotations

import os
import queue
import shutil
import signal
import subprocess
import sys
import threading
import time
from collections import deque
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

if os.name == "nt":
    import msvcrt


ROOT_DIR = Path(__file__).resolve().parent
BOT_LOG_FILE = ROOT_DIR / "bot" / "output" / "automation.log"
WEB_URL = "http://127.0.0.1:43871"
API_URL = "http://127.0.0.1:43872"
MAX_RECENT_EVENTS = 14


class Ansi:
    RESET = "\033[0m"
    BOLD = "\033[1m"
    DIM = "\033[2m"
    CYAN = "\033[36m"
    BLUE = "\033[34m"
    GREEN = "\033[32m"
    YELLOW = "\033[33m"
    RED = "\033[31m"
    MAGENTA = "\033[35m"
    WHITE = "\033[37m"
    GRAY = "\033[90m"


LEVEL_COLORS = {
    "INFO": Ansi.CYAN,
    "WARN": Ansi.YELLOW,
    "ERROR": Ansi.RED,
    "CALL": Ansi.MAGENTA,
    "PROC": Ansi.BLUE,
    "OK": Ansi.GREEN,
}

SOURCE_COLORS = {
    "launcher": Ansi.WHITE,
    "web": Ansi.MAGENTA,
    "api": Ansi.CYAN,
    "bot": Ansi.GREEN,
    "bot-log": Ansi.YELLOW,
}


@dataclass(slots=True)
class Event:
    timestamp: datetime
    source: str
    level: str
    message: str
    raw: str = ""


@dataclass(slots=True)
class ProcessSpec:
    name: str
    command: list[str]
    cwd: Path
    accent: str
    startup_hint: str
    enabled: bool = True


@dataclass(slots=True)
class ManagedProcess:
    spec: ProcessSpec
    process: subprocess.Popen[str] | None = None
    started_at: float | None = None
    lines_seen: int = 0
    last_line: str = ""
    status: str = "stopped"
    restart_count: int = 0
    status_note: str = ""


class BotLogTailer(threading.Thread):
    def __init__(self, log_path: Path, events: "queue.Queue[Event]", stop_event: threading.Event):
        super().__init__(daemon=True)
        self.log_path = log_path
        self.events = events
        self.stop_event = stop_event

    def run(self) -> None:
        position = 0
        while not self.stop_event.is_set():
            try:
                if self.log_path.exists():
                    current_size = self.log_path.stat().st_size
                    if current_size < position:
                        position = 0

                    with self.log_path.open("r", encoding="utf-8", errors="replace") as handle:
                        handle.seek(position)
                        while True:
                            line = handle.readline()
                            if not line:
                                break
                            position = handle.tell()
                            event = parse_bot_log_line(line.rstrip("\r\n"))
                            if event:
                                self.events.put(event)
            except OSError:
                pass

            self.stop_event.wait(0.6)


class LauncherConsole:
    def __init__(self) -> None:
        self.events: "queue.Queue[Event]" = queue.Queue()
        self.stop_event = threading.Event()
        self.interactive = sys.stdout.isatty() and sys.stdin.isatty()
        self.auto_exit_seconds = read_auto_exit_seconds()
        self.processes: dict[str, ManagedProcess] = {
            spec.name: ManagedProcess(spec)
            for spec in (
                ProcessSpec(
                    name="api",
                    command=["npm", "run", "dev:api"],
                    cwd=ROOT_DIR,
                    accent=Ansi.CYAN,
                    startup_hint=API_URL,
                ),
                ProcessSpec(
                    name="web",
                    command=["npm", "run", "dev:web"],
                    cwd=ROOT_DIR,
                    accent=Ansi.MAGENTA,
                    startup_hint=WEB_URL,
                ),
                ProcessSpec(
                    name="bot",
                    command=["npm", "run", "bot:worker"],
                    cwd=ROOT_DIR,
                    accent=Ansi.GREEN,
                    startup_hint=str(BOT_LOG_FILE),
                    enabled=False,
                ),
            )
        }
        self.recent_events: deque[Event] = deque(maxlen=MAX_RECENT_EVENTS)
        self.start_time = time.time()
        self.screen_lock = threading.Lock()
        self.tailer = BotLogTailer(BOT_LOG_FILE, self.events, self.stop_event)

    def run(self) -> int:
        configure_terminal()
        self.log_launcher("PROC", "Verificando dependencias do ambiente")

        if not shutil.which("npm"):
            self.log_launcher("ERROR", "npm nao foi encontrado. Instale Node.js e tente novamente.")
            self.render()
            return 1

        self.tailer.start()
        self.start_process("api")
        self.start_process("web")
        self.render()

        try:
            while not self.stop_event.is_set():
                self.drain_events()
                self.poll_processes()
                self.handle_keyboard()
                self.render()
                if self.auto_exit_seconds and (time.time() - self.start_time) >= self.auto_exit_seconds:
                    self.log_launcher("WARN", "Autoencerramento de teste atingido.")
                    self.stop_event.set()
                    continue
                time.sleep(0.2)
        except KeyboardInterrupt:
            self.log_launcher("WARN", "Interrupcao manual recebida. Encerrando orquestrador.")
        finally:
            self.stop_event.set()
            self.stop_all_processes()
            self.render()

        return 0

    def log_launcher(self, level: str, message: str) -> None:
        self.events.put(Event(timestamp=datetime.now(), source="launcher", level=level, message=message, raw=message))

    def start_process(self, name: str) -> None:
        managed = self.processes[name]
        if managed.process and managed.process.poll() is None:
            self.log_launcher("WARN", f"Processo {name} ja esta em execucao.")
            return

        if name == "api":
            self.resolve_conflicting_project_process(port=43872, process_name="api")
        elif name == "web":
            self.resolve_conflicting_project_process(port=43871, process_name="web")

        env = os.environ.copy()
        env.setdefault("FORCE_COLOR", "1")
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
        command = resolve_command(managed.spec.command)

        try:
            process = subprocess.Popen(
                command,
                cwd=managed.spec.cwd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                text=True,
                bufsize=1,
                universal_newlines=True,
                env=env,
                creationflags=creationflags,
            )
        except OSError as error:
            managed.status = "failed"
            self.log_launcher("ERROR", f"Falha ao iniciar {name}: {error}")
            return

        managed.process = process
        managed.started_at = time.time()
        managed.status = "running"
        managed.status_note = ""
        self.log_launcher("PROC", f"start_process({name}) -> {' '.join(command)}")
        self.log_launcher("INFO", f"{name} escutando em {managed.spec.startup_hint}")

        thread = threading.Thread(target=self.capture_output, args=(managed,), daemon=True)
        thread.start()

    def stop_process(self, name: str) -> None:
        managed = self.processes[name]
        process = managed.process
        if not process or process.poll() is not None:
            managed.status = "stopped"
            return

        self.log_launcher("PROC", f"stop_process({name})")
        terminate_process(process)
        managed.status = "stopped"
        managed.status_note = ""

    def restart_process(self, name: str) -> None:
        self.log_launcher("CALL", f"restart_process({name})")
        self.stop_process(name)
        time.sleep(0.4)
        self.processes[name].restart_count += 1
        self.start_process(name)

    def start_bot(self) -> None:
        managed = self.processes["bot"]
        managed.spec.enabled = True
        self.start_process("bot")

    def stop_bot(self) -> None:
        self.stop_process("bot")
        self.processes["bot"].spec.enabled = False

    def capture_output(self, managed: ManagedProcess) -> None:
        assert managed.process is not None
        stream = managed.process.stdout
        if stream is None:
            return

        for line in iter(stream.readline, ""):
            if self.stop_event.is_set():
                break

            clean = line.rstrip("\r\n")
            if not clean:
                continue

            managed.lines_seen += 1
            managed.last_line = strip_ansi(clean)
            self.events.put(parse_process_line(managed.spec.name, clean))

        exit_code = managed.process.poll()
        if exit_code is None:
            return

        status_note = detect_process_failure_note(managed.spec.name, managed.last_line)
        if status_note:
            managed.status_note = status_note
            self.events.put(
                Event(
                    timestamp=datetime.now(),
                    source="launcher",
                    level="WARN",
                    message=f"{managed.spec.name}: {status_note}",
                    raw=status_note,
                )
            )

        level = "OK" if exit_code == 0 else "ERROR"
        message = f"{managed.spec.name} finalizado com codigo {exit_code}"
        self.events.put(Event(timestamp=datetime.now(), source=managed.spec.name, level=level, message=message, raw=message))

    def drain_events(self) -> None:
        while True:
            try:
                event = self.events.get_nowait()
            except queue.Empty:
                return
            self.recent_events.append(event)
            if not self.interactive:
                print(self.render_event(event), flush=True)

    def poll_processes(self) -> None:
        for managed in self.processes.values():
            process = managed.process
            if process is None:
                continue
            exit_code = process.poll()
            if exit_code is None:
                managed.status = "running"
                continue
            if managed.status != "exited":
                managed.status = "exited"

    def handle_keyboard(self) -> None:
        if os.name != "nt" or not self.interactive:
            return
        while msvcrt.kbhit():
            key = msvcrt.getwch().lower()
            if key == "q":
                self.log_launcher("WARN", "Tecla q recebida. Encerrando launcher.")
                self.stop_event.set()
                return
            if key == "b":
                bot = self.processes["bot"]
                if bot.process and bot.process.poll() is None:
                    self.stop_bot()
                else:
                    self.start_bot()
            if key == "a":
                self.restart_process("api")
            if key == "w":
                self.restart_process("web")
            if key == "r":
                self.restart_process("api")
                self.restart_process("web")
                if self.processes["bot"].spec.enabled:
                    self.restart_process("bot")
            if key == "o":
                self.open_browser()

    def open_browser(self) -> None:
        self.log_launcher("CALL", f"open_browser({WEB_URL})")
        if os.name == "nt":
            os.startfile(WEB_URL)  # type: ignore[attr-defined]

    def resolve_conflicting_project_process(self, port: int, process_name: str) -> None:
        owner = get_port_owner_details(port)
        if not owner:
            return

        command_line = owner.get("command", "")
        if str(ROOT_DIR).lower() not in command_line.lower():
            self.log_launcher(
                "WARN",
                f"porta {port} ja esta ocupada por PID {owner['pid']} ({owner['name']}); conflito externo nao sera encerrado",
            )
            return

        self.log_launcher(
            "WARN",
            f"encerrando instancia anterior de {process_name} na porta {port} (PID {owner['pid']})",
        )
        kill_process_tree(int(owner["pid"]))

    def stop_all_processes(self) -> None:
        for name in ("bot", "web", "api"):
            self.stop_process(name)

    def render(self) -> None:
        if not self.interactive:
            return
        with self.screen_lock:
            lines = []
            lines.append("\033[2J\033[H")
            lines.append(
                f"{Ansi.BOLD}{Ansi.WHITE}FIAPAUTO Launcher{Ansi.RESET} "
                f"{Ansi.DIM}python launcher.py{Ansi.RESET}"
            )
            lines.append(self.render_status_line())
            lines.append(self.render_controls())
            lines.append("")
            lines.append(f"{Ansi.BOLD}Processos{Ansi.RESET}")
            for name in ("api", "web", "bot"):
                lines.append(self.render_process(self.processes[name]))
            lines.append("")
            lines.append(f"{Ansi.BOLD}Timeline em tempo real{Ansi.RESET}")
            if self.recent_events:
                for event in list(self.recent_events):
                    lines.append(self.render_event(event))
            else:
                lines.append(f"{Ansi.DIM}Aguardando eventos...{Ansi.RESET}")

            sys.stdout.write("\n".join(lines) + Ansi.RESET)
            sys.stdout.flush()

    def render_status_line(self) -> str:
        uptime = format_duration(time.time() - self.start_time)
        running = sum(
            1
            for managed in self.processes.values()
            if managed.process is not None and managed.process.poll() is None
        )
        return (
            f"{Ansi.DIM}Uptime:{Ansi.RESET} {uptime}   "
            f"{Ansi.DIM}Ativos:{Ansi.RESET} {running}/{len(self.processes)}   "
            f"{Ansi.DIM}API:{Ansi.RESET} {API_URL}   "
            f"{Ansi.DIM}Web:{Ansi.RESET} {WEB_URL}"
        )

    def render_controls(self) -> str:
        return (
            f"{Ansi.DIM}Controles:{Ansi.RESET} "
            "[o] abrir web  [a] restart api  [w] restart web  [b] toggle bot  [r] restart tudo  [q] sair"
        )

    def render_process(self, managed: ManagedProcess) -> str:
        status = managed.status
        if managed.process and managed.process.poll() is None:
            status = "running"
            color = Ansi.GREEN
        elif status == "exited":
            color = Ansi.YELLOW if managed.process and managed.process.returncode == 0 else Ansi.RED
        elif status == "failed":
            color = Ansi.RED
        else:
            color = Ansi.GRAY

        last_line = trim_text(managed.last_line or "sem eventos ainda", 92)
        note = f" | {trim_text(managed.status_note, 54)}" if managed.status_note else ""
        return (
            f"{managed.spec.accent}{Ansi.BOLD}{managed.spec.name.upper():<4}{Ansi.RESET} "
            f"{color}{status:<8}{Ansi.RESET} "
            f"{Ansi.DIM}logs:{Ansi.RESET} {managed.lines_seen:<4} "
            f"{Ansi.DIM}restarts:{Ansi.RESET} {managed.restart_count:<2} "
            f"{Ansi.DIM}ultimo:{Ansi.RESET} {last_line}{note}"
        )

    def render_event(self, event: Event) -> str:
        level_color = LEVEL_COLORS.get(event.level, Ansi.WHITE)
        source_color = SOURCE_COLORS.get(event.source, Ansi.WHITE)
        timestamp = event.timestamp.strftime("%H:%M:%S")
        return (
            f"{Ansi.DIM}{timestamp}{Ansi.RESET} "
            f"{level_color}{event.level:<5}{Ansi.RESET} "
            f"{source_color}{event.source:<8}{Ansi.RESET} "
            f"{trim_text(event.message, 120)}"
        )


def configure_terminal() -> None:
    if os.name == "nt" and sys.stdout.isatty():
        os.system("")


def terminate_process(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return

    if os.name == "nt":
        try:
            subprocess.Popen(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            ).wait(timeout=5)
        except (subprocess.TimeoutExpired, KeyboardInterrupt, OSError):
            pass
        try:
            process.wait(timeout=5)
        except (subprocess.TimeoutExpired, KeyboardInterrupt):
            try:
                process.kill()
                process.wait(timeout=5)
            except (subprocess.TimeoutExpired, KeyboardInterrupt, OSError):
                pass
        return

    try:
        process.terminate()
    except OSError:
        pass

    try:
        process.wait(timeout=5)
    except (subprocess.TimeoutExpired, KeyboardInterrupt):
        try:
            process.kill()
            process.wait(timeout=5)
        except (subprocess.TimeoutExpired, KeyboardInterrupt, OSError):
            pass


def resolve_command(command: list[str]) -> list[str]:
    if not command:
        return command

    resolved = shutil.which(command[0])
    if os.name == "nt" and not resolved:
        resolved = shutil.which(f"{command[0]}.cmd") or shutil.which(f"{command[0]}.exe")

    if resolved:
        return [resolved, *command[1:]]

    return command


def detect_process_failure_note(name: str, last_line: str) -> str:
    if name != "api":
        return ""

    owner = get_port_owner(API_URL.rsplit(":", 1)[-1])
    if owner:
        return f"porta 43872 ja esta em uso por PID {owner['pid']} ({owner['name']})"

    if "EADDRINUSE" in last_line:
        return "porta 43872 ja esta em uso"

    return ""


def get_port_owner(port_text: str) -> dict[str, str] | None:
    try:
        port = int(port_text)
    except ValueError:
        return None

    if os.name != "nt":
        return None

    try:
        netstat = subprocess.check_output(["netstat", "-ano"], text=True, encoding="utf-8", errors="replace")
    except (subprocess.SubprocessError, OSError):
        return None

    pid = None
    for line in netstat.splitlines():
        if f"127.0.0.1:{port}" not in line or "LISTENING" not in line:
            continue
        parts = line.split()
        if parts:
            pid = parts[-1]
            break

    if not pid or pid == "0":
        return None

    details = get_process_details(pid)
    return {"pid": pid, "name": details["name"]}


def get_port_owner_details(port: int) -> dict[str, str] | None:
    owner = get_port_owner(str(port))
    if not owner:
        return None

    details = get_process_details(owner["pid"])
    return {
        "pid": owner["pid"],
        "name": details["name"],
        "command": details["command"],
    }


def get_process_details(pid: str) -> dict[str, str]:
    try:
        result = subprocess.check_output(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                f"$p = Get-CimInstance Win32_Process -Filter \"ProcessId = {pid}\"; "
                "[Console]::WriteLine(($p.Name)); "
                "[Console]::WriteLine(($p.CommandLine))",
            ],
            text=True,
            encoding="utf-8",
            errors="replace",
        ).splitlines()
    except (subprocess.SubprocessError, OSError):
        return {"name": "processo-desconhecido", "command": ""}

    name = result[0].strip() if result else "processo-desconhecido"
    command = result[1].strip() if len(result) > 1 else ""
    return {"name": name or "processo-desconhecido", "command": command}


def kill_process_tree(pid: int) -> None:
    subprocess.run(
        ["taskkill", "/PID", str(pid), "/T", "/F"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )


def parse_process_line(source: str, line: str) -> Event:
    clean = strip_ansi(line)
    lower = clean.lower()
    level = "INFO"
    if any(token in lower for token in ("error", "falha", "failed", "exception")):
        level = "ERROR"
    elif any(token in lower for token in ("warn", "aviso", "nao encontrou", "not found")):
        level = "WARN"
    elif any(
        token in lower
        for token in (
            "starting",
            "iniciando",
            "tentando",
            "coletando",
            "executando",
            "listening",
            "watching",
            "runjobs(",
            "run_jobs(",
        )
    ):
        level = "CALL"
    elif any(token in lower for token in ("ready in", "listening on", "executed jobs", "ok")):
        level = "OK"

    return Event(timestamp=datetime.now(), source=source, level=level, message=clean, raw=line)


def parse_bot_log_line(line: str) -> Event | None:
    if not line.strip():
        return None

    timestamp = datetime.now()
    message = line
    level = "INFO"

    if line.startswith("[") and "]" in line:
        raw_timestamp, remainder = line[1:].split("]", 1)
        try:
            timestamp = datetime.fromisoformat(raw_timestamp.replace("Z", "+00:00")).astimezone().replace(tzinfo=None)
        except ValueError:
            timestamp = datetime.now()
        message = remainder.strip()

    if message.startswith("INFO "):
        message = message[5:]
        level = "INFO"
    elif message.startswith("WARN "):
        message = message[5:]
        level = "WARN"
    elif message.startswith("ERROR "):
        message = message[6:]
        level = "ERROR"

    lowered = message.lower()
    if any(token in lowered for token in ("iniciando", "tentando", "coletando", "abrir", "navegar")):
        level = "CALL" if level == "INFO" else level

    return Event(timestamp=timestamp, source="bot-log", level=level, message=message, raw=line)


def strip_ansi(value: str) -> str:
    chars: list[str] = []
    skip = False
    for char in value:
        if char == "\x1b":
            skip = True
            continue
        if skip:
            if char.isalpha():
                skip = False
            continue
        chars.append(char)
    return "".join(chars)


def trim_text(value: str, max_length: int) -> str:
    if len(value) <= max_length:
        return value
    return value[: max_length - 3] + "..."


def format_duration(seconds: float) -> str:
    total = int(seconds)
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours:02}:{minutes:02}:{secs:02}"
    return f"{minutes:02}:{secs:02}"


def read_auto_exit_seconds() -> float | None:
    raw = os.environ.get("FIAPAUTO_LAUNCHER_AUTO_EXIT")
    if not raw:
        return None
    try:
        value = float(raw)
    except ValueError:
        return None
    return value if value > 0 else None


def main() -> int:
    launcher = LauncherConsole()
    return launcher.run()


if __name__ == "__main__":
    raise SystemExit(main())
