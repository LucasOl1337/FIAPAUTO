from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib import error, parse, request


ROOT_DIR = Path(__file__).resolve().parent
BACKEND_DIR = ROOT_DIR / "backend"
FRONTEND_DIR = ROOT_DIR / "frontend"
RUNTIME_DIR = BACKEND_DIR / "runtime"
LOGS_DIR = RUNTIME_DIR / "logs"
KNOWLEDGE_DIR = RUNTIME_DIR / "knowledge" / "catalog"
DEV_PORTS_FILE = RUNTIME_DIR / "dev-ports.json"
VALIDATED_ANSWERS_FILE = KNOWLEDGE_DIR / "validated-answers.json"
LLM_DEBUG_HISTORY_FILE = LOGS_DIR / "llm-debug-history.jsonl"
PROVIDER_HEALTH_FILE = LOGS_DIR / "provider-health.json"
PUBLIC_API_SOURCE_FILE = FRONTEND_DIR / "engineweb" / "api" / "publicApi.ts"
BACKEND_ENV_FILE = BACKEND_DIR / ".env.local"
FRONTEND_ENV_FILE = FRONTEND_DIR / ".env.local"
OLLAMA_KEYS_FILE = Path.home() / "Desktop" / "KEYS" / "ollamaKeys.local"

HOST = "127.0.0.1"
DEFAULT_WEB_PORT = 43871
DEFAULT_API_PORT = 43872
DEFAULT_BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
}


@dataclass
class ServiceProcess:
    name: str
    command: list[str]
    cwd: Path
    process: subprocess.Popen[str] | None = None


class LauncherError(RuntimeError):
    pass


class RuntimeMonitor:
    def __init__(
        self,
        api_url: str,
        interval_seconds: float,
        admin_token: str | None,
        public_site_url: str | None,
        public_api_url: str | None,
        public_check_timeout: float,
    ) -> None:
        self.api_url = api_url.rstrip("/")
        self.interval_seconds = interval_seconds
        self.admin_token = admin_token or ""
        self.public_site_url = public_site_url.rstrip("/") if public_site_url else ""
        self.public_api_url = public_api_url.rstrip("/") if public_api_url else ""
        self.public_check_timeout = public_check_timeout
        self._last_snapshot: dict[str, Any] | None = None

    def run_forever(self, stop_event: threading.Event) -> None:
        while not stop_event.wait(self.interval_seconds):
            try:
                snapshot = self.collect_snapshot()
                self.print_snapshot(snapshot)
            except Exception as exc:  # noqa: BLE001
                log("monitor", f"falha ao coletar status: {exc}")

    def collect_snapshot(self) -> dict[str, Any]:
        health = self._fetch_json("/api/health")
        bot_status_error = ""
        try:
            bot_status = self._fetch_json("/api/bot/status", admin=True)
        except Exception as exc:  # noqa: BLE001
            bot_status = {}
            bot_status_error = str(exc)
        validated_answers = read_json_file(VALIDATED_ANSWERS_FILE, default=[])
        llm_debug_lines = count_lines(LLM_DEBUG_HISTORY_FILE)
        topics_index = read_json_file(RUNTIME_DIR / "subjects" / "topics.json", default=[])
        assignments_report = read_json_file(RUNTIME_DIR / "jobs" / "assignments-report.json", default={"assignments": []})
        ready_lessons_file = read_json_file(RUNTIME_DIR / "jobs" / "ready-lessons.json", default=[])
        jobs_file = read_json_file(RUNTIME_DIR / "jobs" / "jobs-state.json", default=[])

        topics = bot_status.get("topics", topics_index if isinstance(topics_index, list) else [])
        workspace_report = bot_status.get("workspaceReport", {})
        ready_lessons = bot_status.get(
            "readyLessons",
            ready_lessons_file if isinstance(ready_lessons_file, list) else [],
        )
        jobs = bot_status.get("jobs", jobs_file if isinstance(jobs_file, list) else [])
        llm = bot_status.get("llm", {})
        latest_validated = validated_answers[0] if isinstance(validated_answers, list) and validated_answers else None
        local_public = self._collect_local_public_snapshot()
        remote_public = self._collect_remote_public_snapshot()

        return {
            "health_ok": bool(health.get("ok")),
            "admin_protection_enabled": bool(health.get("adminProtectionEnabled")),
            "auth_status": workspace_report.get("authStatus", "unknown"),
            "assignments": len(
                workspace_report.get("assignments", [])
                if isinstance(workspace_report.get("assignments", []), list)
                else assignments_report.get("assignments", [])
            ),
            "live_meetings": len(workspace_report.get("liveMeetings", [])),
            "topics": len(topics),
            "jobs": len(jobs),
            "ready_lessons": len(ready_lessons),
            "llm_enabled": bool(llm.get("enabled")),
            "llm_model": llm.get("model") or "n/a",
            "llm_has_api_key": bool(llm.get("hasApiKey")),
            "llm_debug_events": llm_debug_lines,
            "validated_answers": len(validated_answers) if isinstance(validated_answers, list) else 0,
            "latest_validated_question": latest_validated.get("question", "") if isinstance(latest_validated, dict) else "",
            "latest_validated_at": latest_validated.get("createdAt", "") if isinstance(latest_validated, dict) else "",
            "runtime_error": bot_status.get("runtimeError", ""),
            "scanned_at": workspace_report.get("scannedAt", ""),
            "bot_status_error": bot_status_error,
            "local_public": local_public,
            "remote_public": remote_public,
        }

    def print_snapshot(self, snapshot: dict[str, Any]) -> None:
        if snapshot == self._last_snapshot:
            return

        health_label = "ok" if snapshot["health_ok"] else "falha"
        llm_label = "ativo" if snapshot["llm_enabled"] else "desativado"
        auth_label = snapshot["auth_status"]
        validated_label = snapshot["validated_answers"]
        latest_question = snapshot["latest_validated_question"] or "-"
        latest_at = format_timestamp(snapshot["latest_validated_at"])
        scanned_at = format_timestamp(snapshot["scanned_at"])

        log(
            "monitor",
            (
                f"api={health_label} auth={auth_label} topicos={snapshot['topics']} atribuicoes={snapshot['assignments']} "
                f"jobs={snapshot['jobs']} aulas_prontas={snapshot['ready_lessons']} llm={llm_label}({snapshot['llm_model']}) "
                f"eventos_llm={snapshot['llm_debug_events']} feedback_validado={validated_label} ultimo_scan={scanned_at}"
            ),
        )
        log(
            "feedback",
            f"ultimo_feedback={latest_at} pergunta={latest_question}",
        )
        local_public = snapshot["local_public"]
        remote_public = snapshot["remote_public"]

        if local_public["checked"]:
            log(
                "public-local",
                (
                    f"topicos={local_public['topics_count']} chat_ok={local_public['chat_ok']} "
                    f"provider={local_public['provider_used']} strategy={local_public['strategy_used']} "
                    f"quality={local_public['quality_status']}"
                ),
            )
            if local_public["error"]:
                log("alerta", f"public_local_erro={local_public['error']}")

        if remote_public["checked"]:
            log(
                "public-remote",
                (
                    f"site_static_topicos={remote_public['site_topics_count']} api_topicos={remote_public['api_topics_count']} "
                    f"api_ok={remote_public['api_ok']} sincronizado={remote_public['counts_match']}"
                ),
            )
            if remote_public["api_chat_checked"]:
                log(
                    "public-remote-chat",
                    (
                        f"chat_ok={remote_public['api_chat_ok']} provider={remote_public['api_provider_used']} "
                        f"strategy={remote_public['api_strategy_used']} quality={remote_public['api_quality_status']}"
                    ),
                )
            if remote_public["error"]:
                log("alerta", f"public_remote_erro={remote_public['error']}")
            if self.public_api_url and remote_public["site_topics_count"] > 0 and remote_public["api_topics_count"] == 0:
                log(
                    "alerta",
                    "o site publicado tem topicos estaticos, mas a API publica configurada esta vazia. a experiencia publica nao esta consistente.",
                )

        if snapshot["runtime_error"]:
            log("alerta", f"runtime_error={snapshot['runtime_error']}")
        if snapshot["bot_status_error"]:
            log("alerta", f"bot_status_indisponivel={snapshot['bot_status_error']}")

        self._last_snapshot = snapshot

    def _fetch_json(self, path: str, admin: bool = False) -> dict[str, Any]:
        headers: dict[str, str] = {"Accept": "application/json"}
        if admin and self.admin_token:
            headers["X-FIAPAUTO-Admin-Token"] = self.admin_token

        response = http_get_json(f"{self.api_url}{path}", headers=headers)
        if not isinstance(response, dict):
            raise LauncherError(f"resposta inesperada em {path}")
        return response

    def _collect_local_public_snapshot(self) -> dict[str, Any]:
        snapshot = {
            "checked": True,
            "topics_count": 0,
            "chat_ok": False,
            "provider_used": "-",
            "strategy_used": "-",
            "quality_status": "-",
            "error": "",
        }
        try:
            payload = http_get_json(f"{self.api_url}/api/public/topics", headers={"Accept": "application/json"})
            topics = payload.get("topics", []) if isinstance(payload, dict) else []
            snapshot["topics_count"] = len(topics) if isinstance(topics, list) else 0
            if not topics:
                snapshot["error"] = "api_local_publica_sem_topicos"
                return snapshot

            first_topic = topics[0]
            if not isinstance(first_topic, dict) or not first_topic.get("id"):
                snapshot["error"] = "topico_publico_local_invalido"
                return snapshot

            chat_payload = http_post_json(
                f"{self.api_url}/api/public/chat/topic",
                body={
                    "topicId": first_topic["id"],
                    "question": "Resuma em uma frase o que preciso fazer agora.",
                },
                headers={"Accept": "application/json", "Content-Type": "application/json"},
            )
            snapshot["chat_ok"] = True
            snapshot["provider_used"] = str(chat_payload.get("providerUsed", "-"))
            snapshot["strategy_used"] = str(chat_payload.get("strategyUsed", "-"))
            snapshot["quality_status"] = str(chat_payload.get("qualityStatus", "-"))

            if snapshot["provider_used"] == "local":
                snapshot["error"] = "chat_publico_local_caiu_em_fallback_local"
        except Exception as exc:  # noqa: BLE001
            snapshot["error"] = str(exc)

        return snapshot

    def _collect_remote_public_snapshot(self) -> dict[str, Any]:
        snapshot = {
            "checked": bool(self.public_site_url or self.public_api_url),
            "site_topics_count": 0,
            "api_topics_count": 0,
            "api_ok": not bool(self.public_api_url),
            "counts_match": not bool(self.public_api_url),
            "api_chat_checked": False,
            "api_chat_ok": False,
            "api_provider_used": "-",
            "api_strategy_used": "-",
            "api_quality_status": "-",
            "error": "",
        }
        if not snapshot["checked"]:
            return snapshot

        try:
            if self.public_site_url:
                site_topics = http_get_json(
                    f"{self.public_site_url}/published/topics.json",
                    headers={
                        **DEFAULT_BROWSER_HEADERS,
                        "Referer": f"{self.public_site_url}/",
                        "Sec-Fetch-Site": "same-origin",
                        "Sec-Fetch-Mode": "cors",
                        "Sec-Fetch-Dest": "empty",
                    },
                    timeout_seconds=self.public_check_timeout,
                )
                if isinstance(site_topics, list):
                    snapshot["site_topics_count"] = len(site_topics)

            if self.public_api_url:
                api_topics_payload = http_get_json(
                    f"{self.public_api_url}/api/public/topics",
                    headers={
                        **DEFAULT_BROWSER_HEADERS,
                        "Referer": f"{self.public_site_url or self.public_api_url}/",
                    },
                    timeout_seconds=self.public_check_timeout,
                )
                api_topics = api_topics_payload.get("topics", []) if isinstance(api_topics_payload, dict) else []
                snapshot["api_topics_count"] = len(api_topics) if isinstance(api_topics, list) else 0
                snapshot["api_ok"] = True
                snapshot["counts_match"] = snapshot["site_topics_count"] == snapshot["api_topics_count"]

                if isinstance(api_topics, list) and api_topics:
                    first_topic = api_topics[0]
                    if isinstance(first_topic, dict) and first_topic.get("id"):
                        snapshot["api_chat_checked"] = True
                        chat_payload = http_post_json(
                            f"{self.public_api_url}/api/public/chat/topic",
                            body={
                                "topicId": first_topic["id"],
                                "question": "Resuma em uma frase o que preciso fazer agora.",
                            },
                            headers={
                                **DEFAULT_BROWSER_HEADERS,
                                "Content-Type": "application/json",
                                "Referer": f"{self.public_site_url or self.public_api_url}/",
                            },
                            timeout_seconds=self.public_check_timeout,
                        )
                        snapshot["api_chat_ok"] = True
                        snapshot["api_provider_used"] = str(chat_payload.get("providerUsed", "-"))
                        snapshot["api_strategy_used"] = str(chat_payload.get("strategyUsed", "-"))
                        snapshot["api_quality_status"] = str(chat_payload.get("qualityStatus", "-"))

                        if snapshot["api_provider_used"] == "local":
                            snapshot["error"] = "chat_publico_remoto_caiu_em_fallback_local"
                elif snapshot["site_topics_count"] > 0:
                    snapshot["error"] = "api_publica_remota_sem_topicos"
        except Exception as exc:  # noqa: BLE001
            snapshot["error"] = str(exc)

        return snapshot


def main() -> int:
    parser = argparse.ArgumentParser(description="Launcher local do FIAPAUTO")
    parser.add_argument("--api-port", type=int, default=DEFAULT_API_PORT)
    parser.add_argument("--web-port", type=int, default=DEFAULT_WEB_PORT)
    parser.add_argument("--health-timeout", type=float, default=90.0)
    parser.add_argument("--health-interval", type=float, default=10.0)
    parser.add_argument("--public-check-timeout", type=float, default=15.0)
    parser.add_argument("--no-frontend", action="store_true")
    parser.add_argument("--skip-public-checks", action="store_true")
    parser.add_argument("--public-site-url", default="https://fiapflow.com.br")
    parser.add_argument("--public-api-url", default="")
    parser.add_argument("--once", action="store_true", help="sobe, valida e encerra")
    args = parser.parse_args()

    ensure_runtime_dirs()

    api_port = find_available_port(args.api_port)
    blocked_ports = {api_port}
    web_port = find_available_port(args.web_port, blocked_ports=blocked_ports)
    frontend_url = f"http://{HOST}:{web_port}"
    api_url = f"http://{HOST}:{api_port}"
    admin_token = resolve_admin_token()
    public_api_url = "" if args.skip_public_checks else (args.public_api_url.strip() or detect_public_api_url())
    public_site_url = "" if args.skip_public_checks else args.public_site_url.strip()

    write_dev_ports_file(
        {
            "host": HOST,
            "webPort": web_port,
            "apiPort": api_port,
            "frontendUrl": frontend_url,
            "apiUrl": api_url,
            "updatedAt": datetime.now(timezone.utc).isoformat(),
        }
    )

    log("launcher", "analise do problema")
    log(
        "launcher",
        "o site depende de backend e sinais de IA locais, mas hoje isso roda em processos soltos, logs espalhados e sem um supervisor unico.",
    )
    log(
        "launcher",
        "este launcher centraliza subida, healthcheck da API, leitura de feedback validado e saude dos providers no mesmo console.",
    )
    log("launcher", f"frontend previsto em {frontend_url}")
    log("launcher", f"backend previsto em {api_url}")

    shared_env = os.environ.copy()
    shared_env["FIAPAUTO_API_PORT"] = str(api_port)
    shared_env["FIAPAUTO_WEB_PORT"] = str(web_port)
    shared_env["FIAPAUTO_WEB_ORIGIN"] = frontend_url
    shared_env["VITE_API_PROXY_TARGET"] = api_url
    shared_env["VITE_PUBLIC_API_BASE_URL"] = api_url

    api_service = ServiceProcess(
        name="api",
        command=build_workspace_command("@fiapauto/backend"),
        cwd=ROOT_DIR,
    )
    web_service = (
        None
        if args.no_frontend
        else ServiceProcess(
            name="web",
            command=build_workspace_command("@fiapauto/frontend"),
            cwd=ROOT_DIR,
        )
    )
    services = [api_service] + ([web_service] if web_service else [])

    stop_event = threading.Event()
    monitor = RuntimeMonitor(
        api_url=api_url,
        interval_seconds=args.health_interval,
        admin_token=admin_token,
        public_site_url=public_site_url,
        public_api_url=public_api_url,
        public_check_timeout=args.public_check_timeout,
    )
    signal.signal(signal.SIGINT, lambda signum, frame: stop_event.set())
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, lambda signum, frame: stop_event.set())

    try:
        start_service(api_service, shared_env)
        wait_for_api(api_url, timeout_seconds=args.health_timeout)
        log("health", "API respondeu em /api/health")
        if web_service:
            start_service(web_service, shared_env)

        snapshot = monitor.collect_snapshot()
        monitor.print_snapshot(snapshot)

        local_public_is_valid = not snapshot["local_public"]["error"]

        if not local_public_is_valid and not (
            snapshot["remote_public"]["api_ok"] and snapshot["remote_public"]["api_chat_ok"]
        ):
            log("alerta", "o backend local subiu, mas o fluxo publico com IA nao ficou valido.")
        if public_api_url and snapshot["remote_public"]["error"]:
            log("alerta", "o site publico nao esta consistente com a API publica/IA neste momento.")

        if args.once:
            log("launcher", "modo --once concluido, encerrando processos.")
            return 0

        monitor_thread = threading.Thread(target=monitor.run_forever, args=(stop_event,), daemon=True)
        monitor_thread.start()

        while not stop_event.is_set():
            for service in services:
                if service.process is None:
                    continue
                code = service.process.poll()
                if code is not None:
                    raise LauncherError(f"processo {service.name} terminou com codigo {code}")
            time.sleep(1.0)

        return 0
    except LauncherError as exc:
        log("erro", str(exc))
        return 1
    finally:
        stop_event.set()
        for service in services:
            stop_service(service)


def ensure_runtime_dirs() -> None:
    for directory in [RUNTIME_DIR, LOGS_DIR, KNOWLEDGE_DIR]:
        directory.mkdir(parents=True, exist_ok=True)


def build_workspace_command(workspace: str) -> list[str]:
    if os.name == "nt":
        return ["npm.cmd", "run", "dev", "-w", workspace]
    return ["npm", "run", "dev", "-w", workspace]


def start_service(service: ServiceProcess, env: dict[str, str]) -> None:
    log("launcher", f"subindo {service.name}: {' '.join(service.command)}")
    creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) if os.name == "nt" else 0
    process = subprocess.Popen(
        service.command,
        cwd=str(service.cwd),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        creationflags=creationflags,
    )
    service.process = process
    start_stream_thread(service.name, process.stdout)
    start_stream_thread(service.name, process.stderr)


def stop_service(service: ServiceProcess) -> None:
    process = service.process
    if process is None or process.poll() is not None:
        return

    log("launcher", f"encerrando {service.name}")
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        try:
            process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            process.kill()
        return

    process.terminate()
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        log("launcher", f"forcando encerramento de {service.name}")
        process.kill()


def start_stream_thread(label: str, stream: Any) -> None:
    if stream is None:
        return

    def pump() -> None:
        for line in iter(stream.readline, ""):
            content = line.rstrip()
            if content:
                log(label, content)

    threading.Thread(target=pump, daemon=True).start()


def wait_for_api(api_url: str, timeout_seconds: float) -> None:
    deadline = time.time() + timeout_seconds
    last_error = "sem resposta"

    while time.time() < deadline:
        try:
            payload = http_get_json(f"{api_url}/api/health", headers={"Accept": "application/json"})
            if isinstance(payload, dict) and payload.get("ok") is True:
                return
            last_error = f"payload_invalido={payload!r}"
        except Exception as exc:  # noqa: BLE001
            last_error = str(exc)
        time.sleep(1.5)

    raise LauncherError(f"API nao respondeu dentro de {timeout_seconds:.0f}s: {last_error}")


def http_get_json(url: str, headers: dict[str, str], timeout_seconds: float = 8) -> Any:
    req = request.Request(url, headers=headers, method="GET")
    try:
        with request.urlopen(req, timeout=timeout_seconds) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            content = response.read().decode(charset)
            return json.loads(content)
    except error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise LauncherError(f"http_{exc.code} em {url}: {body}") from exc
    except error.URLError as exc:
        raise LauncherError(f"nao foi possivel acessar {url}: {exc.reason}") from exc


def http_post_json(url: str, body: dict[str, Any], headers: dict[str, str], timeout_seconds: float = 8) -> Any:
    payload = json.dumps(body).encode("utf-8")
    req = request.Request(url, data=payload, headers=headers, method="POST")
    try:
        with request.urlopen(req, timeout=timeout_seconds) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            content = response.read().decode(charset)
            return json.loads(content)
    except error.HTTPError as exc:
        body_text = exc.read().decode("utf-8", errors="replace")
        raise LauncherError(f"http_{exc.code} em {url}: {body_text}") from exc
    except error.URLError as exc:
        raise LauncherError(f"nao foi possivel acessar {url}: {exc.reason}") from exc


def write_dev_ports_file(payload: dict[str, Any]) -> None:
    DEV_PORTS_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def resolve_admin_token() -> str:
    candidates = [
        os.environ.get("FIAPAUTO_ADMIN_TOKEN"),
        os.environ.get("VITE_ADMIN_TOKEN"),
    ]
    for candidate in candidates:
        if candidate and candidate.strip():
            return candidate.strip()
    return ""


def detect_public_api_url() -> str:
    backend_env = read_env_file(BACKEND_ENV_FILE)
    frontend_env = read_env_file(FRONTEND_ENV_FILE)
    candidates = [
        os.environ.get("FIAPAUTO_PUBLIC_API_URL", ""),
        os.environ.get("VITE_PUBLIC_API_BASE_URL", ""),
        frontend_env.get("VITE_PUBLIC_API_BASE_URL", ""),
        frontend_env.get("VITE_API_BASE_URL", ""),
        backend_env.get("FIAPAUTO_PUBLIC_API_URL", ""),
    ]

    for candidate in candidates:
        normalized = candidate.strip()
        if normalized and not should_ignore_public_api_url(normalized):
            return normalized.rstrip("/")

    return ""


def should_ignore_public_api_url(value: str) -> bool:
    try:
        hostname = (parse.urlparse(value).hostname or "").strip().lower()
    except Exception:  # noqa: BLE001
        return False

    if hostname in {"127.0.0.1", "localhost"}:
        return True

    return False


def read_env_file(file_path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not file_path.exists():
        return values

    for raw_line in file_path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def read_ollama_key_candidates() -> list[tuple[str, str]]:
    candidates: list[tuple[str, str]] = []
    backend_env = read_env_file(BACKEND_ENV_FILE)
    frontend_env = read_env_file(FRONTEND_ENV_FILE)

    for key_name, env_key in [
        ("backend-env", "OLLAMA_API_KEY"),
        ("frontend-env", "VITE_OLLAMA_API_KEY"),
    ]:
        env_source = backend_env if key_name == "backend-env" else frontend_env
        value = env_source.get(env_key, "").strip()
        if value:
            candidates.append((key_name, value))

    if OLLAMA_KEYS_FILE.exists():
        for raw_line in OLLAMA_KEYS_FILE.read_text(encoding="utf-8", errors="replace").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                label, value = line.split("=", 1)
                label = label.strip() or "ollama-local"
                value = value.strip()
            else:
                label = "ollama-local"
                value = line
            if value:
                candidates.append((label, value))

    return candidates


def probe_ollama_connectivity() -> dict[str, Any]:
    backend_env = read_env_file(BACKEND_ENV_FILE)
    frontend_env = read_env_file(FRONTEND_ENV_FILE)
    base_url = (
        backend_env.get("OLLAMA_PROVIDER_BASE_URL")
        or backend_env.get("OLLAMA_BASE_URL")
        or frontend_env.get("VITE_OLLAMA_BASE_URL")
        or "https://ollama.com"
    ).rstrip("/")
    model = (
        backend_env.get("OLLAMA_MODEL")
        or frontend_env.get("VITE_OLLAMA_MODEL")
        or "gpt-oss:20b"
    ).strip()

    for key_name, api_key in read_ollama_key_candidates():
        try:
            payload = http_post_json(
                f"{base_url}/api/chat",
                body={
                    "model": model,
                    "stream": False,
                    "messages": [
                        {
                            "role": "user",
                            "content": "Responda apenas OK.",
                        }
                    ],
                },
                headers={
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {api_key}",
                },
                timeout_seconds=20,
            )
            message = payload.get("message", {}) if isinstance(payload, dict) else {}
            content = message.get("content", "") if isinstance(message, dict) else ""
            if isinstance(content, str) and content.strip():
                return {
                    "ok": True,
                    "base_url": base_url,
                    "model": model,
                    "key_name": key_name,
                    "error": "",
                }
        except Exception as exc:  # noqa: BLE001
            last_error = str(exc)
            continue

    return {
        "ok": False,
        "base_url": base_url,
        "model": model,
        "key_name": "-",
        "error": locals().get("last_error", "nenhuma_chave_ollama_disponivel"),
    }


def find_available_port(preferred_port: int, blocked_ports: set[int] | None = None) -> int:
    blocked = blocked_ports or set()
    for candidate in range(preferred_port, preferred_port + 200):
        if candidate in blocked:
            continue
        if is_port_free(candidate):
            return candidate
    raise LauncherError(f"nenhuma porta livre encontrada a partir de {preferred_port}")


def is_port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((HOST, port))
        except OSError:
            return False
    return True


def count_lines(file_path: Path) -> int:
    if not file_path.exists():
        return 0
    with file_path.open("r", encoding="utf-8", errors="replace") as handle:
        return sum(1 for _ in handle)


def read_json_file(file_path: Path, default: Any) -> Any:
    if not file_path.exists():
        return default
    try:
        return json.loads(file_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return default


def summarize_providers(providers: list[dict[str, Any]]) -> str:
    if not providers:
        return "sem_dados"

    parts: list[str] = []
    for provider in providers:
        provider_name = str(provider.get("provider", "unknown"))
        failures = int(provider.get("consecutiveFailures", 0) or 0)
        circuit = provider.get("circuitOpenUntil")
        keys = provider.get("keys", [])
        key_states = []
        if isinstance(keys, list):
            for key in keys[:3]:
                if not isinstance(key, dict):
                    continue
                key_name = str(key.get("keyName", "key"))
                key_state = str(key.get("status", "unknown"))
                key_states.append(f"{key_name}:{key_state}")
        parts.append(
            f"{provider_name}(falhas={failures},circuito={'aberto' if circuit else 'fechado'},keys={','.join(key_states) or 'nenhuma'})"
        )
    return " | ".join(parts)


def format_timestamp(value: str) -> str:
    if not value:
        return "-"
    try:
        normalized = value.replace("Z", "+00:00")
        parsed = datetime.fromisoformat(normalized)
        return parsed.astimezone().strftime("%d/%m %H:%M:%S")
    except ValueError:
        return value


def log(scope: str, message: str) -> None:
    timestamp = datetime.now().strftime("%H:%M:%S")
    print(f"[{timestamp}] [{scope}] {message}", flush=True)


if __name__ == "__main__":
    sys.exit(main())
