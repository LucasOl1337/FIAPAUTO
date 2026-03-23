from __future__ import annotations

import argparse
import ctypes
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
import webbrowser
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
PUBLIC_API_BASE_FILE = FRONTEND_DIR / "engineweb" / "publicApiBase.ts"
FRONTEND_OLLAMA_FILE = FRONTEND_DIR / "engineweb" / "api" / "ollamaCloud.ts"
BACKEND_PROVIDER_ROUTER_FILE = BACKEND_DIR / "connections" / "llm" / "providerRouter.ts"
BACKEND_ENV_FILE = BACKEND_DIR / ".env.local"
FRONTEND_ENV_FILE = FRONTEND_DIR / ".env.local"
OLLAMA_KEYS_FILE = Path.home() / "Desktop" / "KEYS" / "ollamaKeys.local"
PROFILES_FILE = ROOT_DIR / "launcher_profiles.json"

HOST = "127.0.0.1"
EXPECTED_PUBLIC_MODEL = "qwen3.5:397b-cloud"
DEFAULT_BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
}
RESET = "\033[0m"
COLOR_MAP = {
    "launcher": "\033[96m",
    "heartbeat": "\033[92m",
    "feedback": "\033[97;1m",
    "qwen-prompt": "\033[94m",
    "qwen-output": "\033[95m",
    "traffic": "\033[93m",
    "model": "\033[93m",
    "warning": "\033[93m",
    "error": "\033[91m",
    "raw": "\033[90m",
}
ANSI_ENABLED = False


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
        frontend_url: str,
        interval_seconds: float,
        admin_token: str | None,
        public_site_url: str | None,
        public_api_url: str | None,
        public_check_timeout: float,
        enable_remote_checks: bool,
    ) -> None:
        self.api_url = api_url.rstrip("/")
        self.frontend_url = frontend_url.rstrip("/")
        self.interval_seconds = interval_seconds
        self.admin_token = admin_token or ""
        self.public_site_url = public_site_url.rstrip("/") if public_site_url else ""
        self.public_api_url = public_api_url.rstrip("/") if public_api_url else ""
        self.public_check_timeout = public_check_timeout
        self.enable_remote_checks = enable_remote_checks
        self._last_snapshot: dict[str, Any] | None = None
        self._last_heartbeat_at = 0.0

    def run_forever(self, stop_event: threading.Event) -> None:
        while not stop_event.wait(1.0):
            try:
                snapshot = self.collect_snapshot()
                now = time.time()
                should_print_heartbeat = now - self._last_heartbeat_at >= self.interval_seconds
                self.print_snapshot(snapshot, force_heartbeat=should_print_heartbeat)
                if should_print_heartbeat:
                    self._last_heartbeat_at = now
            except Exception as exc:  # noqa: BLE001
                log("error", f"falha ao coletar status: {exc}")

    def collect_snapshot(self) -> dict[str, Any]:
        health = self._fetch_json("/api/health")
        bot_status_error = ""
        public_monitor_error = ""
        try:
            bot_status = self._fetch_json("/api/bot/status", admin=True)
        except Exception as exc:  # noqa: BLE001
            bot_status = {}
            bot_status_error = str(exc)

        try:
            public_monitor = self._fetch_json("/api/public/monitor/status", admin=True)
        except Exception as exc:  # noqa: BLE001
            public_monitor = {}
            public_monitor_error = str(exc)

        validated_answers = read_json_file(VALIDATED_ANSWERS_FILE, default=[])
        llm_debug_lines = count_lines(LLM_DEBUG_HISTORY_FILE)
        assignments_report = read_json_file(RUNTIME_DIR / "jobs" / "assignments-report.json", default={"assignments": []})
        ready_lessons_file = read_json_file(RUNTIME_DIR / "jobs" / "ready-lessons.json", default=[])
        jobs_file = read_json_file(RUNTIME_DIR / "jobs" / "jobs-state.json", default=[])
        provider_health = read_json_file(PROVIDER_HEALTH_FILE, default={"providers": []})
        topics_payload = safe_http_get_json(f"{self.api_url}/api/public/topics")
        remote_public = self._collect_remote_public_snapshot()
        ollama_probe = probe_ollama_connectivity()
        model_origins = collect_model_origins()

        topics = bot_status.get("topics", []) if isinstance(bot_status, dict) else []
        workspace_report = bot_status.get("workspaceReport", {}) if isinstance(bot_status, dict) else {}
        ready_lessons = bot_status.get("readyLessons", ready_lessons_file if isinstance(ready_lessons_file, list) else [])
        jobs = bot_status.get("jobs", jobs_file if isinstance(jobs_file, list) else [])
        llm = bot_status.get("llm", {}) if isinstance(bot_status, dict) else {}
        latest_validated = validated_answers[0] if isinstance(validated_answers, list) and validated_answers else None
        public_traffic = public_monitor.get("traffic", {}) if isinstance(public_monitor, dict) else {}
        recent_chats = public_traffic.get("recentChats", []) if isinstance(public_traffic, dict) else []
        latest_chat = (
            public_traffic.get("latestStarted")
            or public_traffic.get("latestCompleted")
            or public_traffic.get("latestFallback")
            or public_traffic.get("latestFailure")
            or (recent_chats[0] if isinstance(recent_chats, list) and recent_chats else {})
        )
        public_topics = topics_payload.get("topics", []) if isinstance(topics_payload, dict) else []

        return {
            "health_ok": bool(health.get("ok")),
            "frontend_ok": probe_http_ok(self.frontend_url),
            "public_api_ok": isinstance(public_topics, list),
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
            "public_monitor_error": public_monitor_error,
            "public_monitor": public_monitor,
            "public_traffic": public_traffic,
            "latest_chat": latest_chat if isinstance(latest_chat, dict) else {},
            "latest_model": str(public_monitor.get("latestModel", "") if isinstance(public_monitor, dict) else ""),
            "latest_provider": str(public_monitor.get("latestProviderUsed", "") if isinstance(public_monitor, dict) else ""),
            "model_warning": public_monitor.get("modelWarning", {}) if isinstance(public_monitor, dict) else {},
            "provider_summary": summarize_providers(provider_health.get("providers", [])),
            "ollama_probe": ollama_probe,
            "model_origins": model_origins,
            "public_topics": len(public_topics) if isinstance(public_topics, list) else 0,
            "remote_public": remote_public,
            "remote_checks_enabled": self.enable_remote_checks,
        }

    def print_snapshot(self, snapshot: dict[str, Any], force_heartbeat: bool = False) -> None:
        latest_question = snapshot["latest_validated_question"] or "-"
        latest_at = format_timestamp(snapshot["latest_validated_at"])
        scanned_at = format_timestamp(snapshot["scanned_at"])
        remote_public = snapshot["remote_public"]
        latest_chat = snapshot["latest_chat"] if isinstance(snapshot["latest_chat"], dict) else {}
        public_traffic = snapshot["public_traffic"] if isinstance(snapshot["public_traffic"], dict) else {}
        model_warning = snapshot["model_warning"] if isinstance(snapshot["model_warning"], dict) else {}
        details_changed = snapshot != self._last_snapshot

        cloud_ok = remote_public.get("api_ok", True) if snapshot["remote_checks_enabled"] else True
        sync_ok = remote_public.get("counts_match", True) if snapshot["remote_checks_enabled"] else True
        llm_ok = snapshot["llm_enabled"] and snapshot["ollama_probe"]["ok"]

        if force_heartbeat:
            log(
                "heartbeat",
                (
                    f"backend={'ok' if snapshot['health_ok'] else 'down'} "
                    f"frontend={'ok' if snapshot['frontend_ok'] else 'down'} "
                    f"api_publica={'ok' if snapshot['public_api_ok'] else 'down'} "
                    f"llm={'ok' if llm_ok else 'warn'} "
                    f"nuvem={'ok' if cloud_ok else 'warn'} "
                    f"sync={'ok' if sync_ok else 'warn'} "
                    f"heartbeat={int(self.interval_seconds)}s"
                ),
            )
        if not details_changed:
            self._last_snapshot = snapshot
            return
        log(
            "launcher",
            (
                f"auth={snapshot['auth_status']} topicos={snapshot['topics']} atribuicoes={snapshot['assignments']} "
                f"jobs={snapshot['jobs']} aulas_prontas={snapshot['ready_lessons']} llm={snapshot['llm_model']} "
                f"eventos_llm={snapshot['llm_debug_events']} feedback_validado={snapshot['validated_answers']} "
                f"ultimo_feedback={latest_at} pergunta={truncate_text(latest_question, 120)} ultimo_scan={scanned_at}"
            ),
        )
        log("launcher", f"providers={snapshot['provider_summary']}")
        log(
            "launcher",
            (
                f"modelo_publico_esperado={EXPECTED_PUBLIC_MODEL} "
                f"ultimo_provider={snapshot['latest_provider'] or '-'} "
                f"ultimo_modelo={snapshot['latest_model'] or '-'} "
                f"ollama_base={snapshot['ollama_probe']['base_url']} "
                f"probe={'ok' if snapshot['ollama_probe']['ok'] else 'falha'} key={snapshot['ollama_probe']['key_name']}"
            ),
        )

        if latest_chat:
            log(
                "feedback",
                (
                    f"req={latest_chat.get('requestId', '-')} ip={latest_chat.get('clientIp', 'unknown')} "
                    f"topic={latest_chat.get('topicId', '-')} fase={latest_chat.get('phase', 'completed') or 'completed'}"
                ),
            )
            log("feedback", f"user_prompt={latest_chat.get('questionPreview', '-') or '-'}")
            if latest_chat.get("llmPromptPreview"):
                log("qwen-prompt", f"qwen_prompt={latest_chat.get('llmPromptPreview', '-') or '-'}")
            elif latest_chat.get("phase") == "started":
                log("qwen-prompt", "qwen_prompt=aguardando_montagem_do_prompt")
            if latest_chat.get("llmOutputPreview"):
                log("qwen-output", f"qwen_output={latest_chat.get('llmOutputPreview', '-') or '-'}")
            elif latest_chat.get("phase") == "started":
                log("qwen-output", "qwen_output=aguardando_resposta_do_qwen")
            log(
                "launcher",
                (
                    f"provider={latest_chat.get('providerUsed', '-')} model={latest_chat.get('model', '-') or '-'} "
                    f"strategy={latest_chat.get('strategyUsed', '-')} quality={latest_chat.get('qualityStatus', '-')} "
                    f"pass={latest_chat.get('answeredByPass', '-')}"
                ),
            )
        else:
            log("feedback", "sem chats publicos observados ainda.")

        log(
            "traffic",
            (
                f"ips_ativos_60s={public_traffic.get('totalActiveIps', 0)} "
                f"requisicoes_60s={public_traffic.get('totalRecentRequests', 0)} "
                f"topicos_publicos={snapshot['public_topics']}"
            ),
        )
        for entry in public_traffic.get("activeIps", [])[:4] if isinstance(public_traffic.get("activeIps", []), list) else []:
            if not isinstance(entry, dict):
                continue
            log(
                "traffic",
                (
                    f"ip={entry.get('clientIp', 'unknown')} reqs={entry.get('requestCount', 0)} "
                    f"ultimo={format_timestamp(str(entry.get('lastSeenAt', '')))}"
                ),
            )

        if model_warning:
            log(
                "warning",
                (
                    f"model_drift expected={model_warning.get('expectedModel', EXPECTED_PUBLIC_MODEL)} "
                    f"actual={model_warning.get('actualModel', '-') or '-'} "
                    f"provider={model_warning.get('providerUsed', '-') or '-'} "
                    f"source={model_warning.get('source', '-')}"
                ),
            )
        for origin in snapshot["model_origins"][:4]:
            log("model", f"model_warning={origin}")

        if snapshot["runtime_error"]:
            log("error", f"runtime_error={snapshot['runtime_error']}")
        if latest_chat.get("qualityStatus") == "fallback":
            log("error", "chat_publico_caiu_em_fallback_local")
        if latest_chat.get("error"):
            log("error", f"ultimo_erro_publico={latest_chat['error']}")
        if snapshot["public_monitor_error"]:
            log("warning", f"public_monitor_indisponivel={snapshot['public_monitor_error']}")
        if snapshot["bot_status_error"]:
            log("warning", f"bot_status_indisponivel={snapshot['bot_status_error']}")
        if snapshot["remote_checks_enabled"] and remote_public.get("error"):
            log("warning", f"public_remote_erro={remote_public['error']}")

        self._last_snapshot = snapshot

    def _fetch_json(self, path: str, admin: bool = False) -> dict[str, Any]:
        headers: dict[str, str] = {"Accept": "application/json"}
        if admin and self.admin_token:
            headers["X-FIAPAUTO-Admin-Token"] = self.admin_token

        response = http_get_json(f"{self.api_url}{path}", headers=headers)
        if not isinstance(response, dict):
            raise LauncherError(f"resposta inesperada em {path}")
        return response

    def _collect_remote_public_snapshot(self) -> dict[str, Any]:
        snapshot = {
            "checked": self.enable_remote_checks and bool(self.public_site_url or self.public_api_url),
            "site_topics_count": 0,
            "api_topics_count": 0,
            "api_ok": not bool(self.public_api_url),
            "counts_match": not bool(self.public_api_url),
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
                if snapshot["site_topics_count"] > 0 and snapshot["api_topics_count"] == 0:
                    snapshot["error"] = "api_publica_remota_sem_topicos"
        except Exception as exc:  # noqa: BLE001
            snapshot["error"] = str(exc)

        return snapshot


def main(profile_name: str) -> int:
    parser = argparse.ArgumentParser(description="Launcher local do FIAPAUTO")
    parser.add_argument("--api-port", type=int, default=0)
    parser.add_argument("--web-port", type=int, default=0)
    parser.add_argument("--health-timeout", type=float, default=90.0)
    parser.add_argument("--health-interval", type=float, default=0.0)
    parser.add_argument("--public-check-timeout", type=float, default=15.0)
    parser.add_argument("--no-frontend", action="store_true")
    parser.add_argument("--skip-public-checks", action="store_true")
    parser.add_argument("--public-site-url", default="")
    parser.add_argument("--public-api-url", default="")
    parser.add_argument("--once", action="store_true", help="sobe, valida e encerra")
    args = parser.parse_args()

    enable_ansi_colors()
    profile = load_profile(profile_name)
    ensure_runtime_dirs()

    lan_ip = detect_lan_ip()
    api_port = find_available_port(args.api_port or int(profile["api_port"]))
    blocked_ports = {api_port}
    web_port = find_available_port(args.web_port or int(profile["web_port"]), blocked_ports=blocked_ports)
    api_bind_host = str(profile["api_bind_host"])
    web_bind_host = str(profile["web_bind_host"])
    api_public_host = lan_ip if profile.get("public_api_base_host") == "lan" and lan_ip else HOST
    frontend_url = f"http://{HOST}:{web_port}"
    frontend_lan_url = f"http://{lan_ip}:{web_port}" if profile.get("show_lan_url") and lan_ip else ""
    api_url = f"http://{HOST}:{api_port}"
    api_public_url = f"http://{api_public_host}:{api_port}"
    admin_token = resolve_admin_token()
    public_api_url = "" if args.skip_public_checks else (args.public_api_url.strip() or detect_public_api_url())
    public_site_url = "" if args.skip_public_checks else (args.public_site_url.strip() or str(profile.get("public_site_url", "")))
    remote_checks_enabled = bool(profile.get("remote_checks_enabled")) and not args.skip_public_checks
    heartbeat_seconds = args.health_interval or float(profile.get("heartbeat_seconds", 15))

    write_dev_ports_file(
        {
            "host": api_bind_host,
            "webPort": web_port,
            "apiPort": api_port,
            "frontendUrl": frontend_url,
            "frontendLanUrl": frontend_lan_url,
            "apiUrl": api_url,
            "apiPublicUrl": api_public_url,
            "updatedAt": datetime.now(timezone.utc).isoformat(),
            "profile": profile_name,
        }
    )

    log("launcher", f"perfil={profile_name} frontend_local={frontend_url} backend_local={api_url}")
    if frontend_lan_url:
        log("launcher", f"frontend_lan={frontend_lan_url}")
    log("launcher", f"api_publica_local={api_public_url}")
    log("launcher", f"modelo_publico_esperado={EXPECTED_PUBLIC_MODEL}")
    if profile_name == "lab_preview":
        log("warning", f"LAB_PREVIEW_ATIVO use_esta_url={frontend_url}")
        if frontend_lan_url:
            log("warning", f"LAB_PREVIEW_LAN use_esta_url={frontend_lan_url}")
    log("launcher", f"frontend previsto em {frontend_url}")
    log("launcher", f"backend previsto em {api_url}")

    shared_env = os.environ.copy()
    shared_env["FIAPAUTO_API_PORT"] = str(api_port)
    shared_env["FIAPAUTO_API_HOST"] = api_bind_host
    shared_env["FIAPAUTO_WEB_PORT"] = str(web_port)
    shared_env["FIAPAUTO_WEB_ORIGIN"] = "*" if profile.get("web_origin_mode") == "wildcard" else frontend_url
    shared_env["PUBLIC_LLM_MODEL"] = EXPECTED_PUBLIC_MODEL
    shared_env["LLM_MODEL"] = EXPECTED_PUBLIC_MODEL
    shared_env["LLM_MODEL_NAME"] = EXPECTED_PUBLIC_MODEL
    shared_env["OLLAMA_MODEL"] = EXPECTED_PUBLIC_MODEL
    shared_env["VITE_PUBLIC_LLM_MODEL"] = EXPECTED_PUBLIC_MODEL
    shared_env["VITE_OLLAMA_MODEL"] = EXPECTED_PUBLIC_MODEL
    shared_env["VITE_LAUNCHER_PROFILE"] = profile_name
    shared_env["VITE_PUBLIC_API_PORT"] = str(api_port)
    shared_env["VITE_API_PORT"] = str(api_port)
    shared_env["VITE_API_PROXY_TARGET"] = api_public_url
    shared_env["VITE_PUBLIC_API_BASE_URL"] = api_public_url
    shared_env["VITE_API_BASE_URL"] = api_public_url
    shared_env["VITE_PUBLIC_CHAT_TIMEOUT_MS"] = os.environ.get("VITE_PUBLIC_CHAT_TIMEOUT_MS", "90000")
    shared_env["VITE_LAB_FRONTEND_URL"] = frontend_url
    shared_env["VITE_LAB_FRONTEND_LAN_URL"] = frontend_lan_url
    shared_env["VITE_LAB_API_URL"] = api_url
    shared_env["VITE_LAB_API_PUBLIC_URL"] = api_public_url

    api_service = ServiceProcess(
        name="api",
        command=build_workspace_command("@fiapauto/backend", "dev"),
        cwd=ROOT_DIR,
    )
    web_service = (
        None
        if args.no_frontend
        else ServiceProcess(
            name="web",
            command=build_frontend_command(profile, web_port, web_bind_host),
            cwd=ROOT_DIR,
        )
    )
    services = [api_service] + ([web_service] if web_service else [])

    stop_event = threading.Event()
    monitor = RuntimeMonitor(
        api_url=api_url,
        frontend_url=frontend_url,
        interval_seconds=heartbeat_seconds,
        admin_token=admin_token,
        public_site_url=public_site_url,
        public_api_url=public_api_url,
        public_check_timeout=args.public_check_timeout,
        enable_remote_checks=remote_checks_enabled,
    )
    signal.signal(signal.SIGINT, lambda signum, frame: stop_event.set())
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, lambda signum, frame: stop_event.set())

    try:
        start_service(api_service, shared_env)
        wait_for_api(api_url, timeout_seconds=args.health_timeout)
        log("heartbeat", "backend respondeu em /api/health")
        if web_service:
            if profile.get("build_before_web"):
                run_workspace_command(build_workspace_command("@fiapauto/frontend", "build"), shared_env, "frontend-build")
            start_service(web_service, shared_env)
            wait_for_http(frontend_url, timeout_seconds=45.0)
            log("heartbeat", f"frontend respondeu em {frontend_url}")
            log_useful_links(frontend_url, frontend_lan_url, api_url, api_public_url)
            if profile.get("auto_open_browser"):
                maybe_open_browser(frontend_url)

        snapshot = monitor.collect_snapshot()
        monitor.print_snapshot(snapshot, force_heartbeat=True)
        monitor._last_heartbeat_at = time.time()

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
        log("error", str(exc))
        return 1
    finally:
        stop_event.set()
        for service in services:
            stop_service(service)
        wait_for_port_release(api_port)
        if web_service:
            wait_for_port_release(web_port)
        clear_dev_ports_file()
        log("launcher", "servicos_encerrados e portas_liberadas")


def ensure_runtime_dirs() -> None:
    for directory in [RUNTIME_DIR, LOGS_DIR, KNOWLEDGE_DIR]:
        directory.mkdir(parents=True, exist_ok=True)


def load_profile(profile_name: str) -> dict[str, Any]:
    profiles = read_json_file(PROFILES_FILE, default={})
    if not isinstance(profiles, dict) or profile_name not in profiles:
        raise LauncherError(f"perfil desconhecido: {profile_name}")
    profile = profiles[profile_name]
    if not isinstance(profile, dict):
        raise LauncherError(f"perfil invalido: {profile_name}")
    return profile


def build_workspace_command(workspace: str, script: str, extra_args: list[str] | None = None) -> list[str]:
    command = ["npm.cmd" if os.name == "nt" else "npm", "run", script, "-w", workspace]
    if extra_args:
        command.extend(["--", *extra_args])
    return command


def build_frontend_command(profile: dict[str, Any], web_port: int, bind_host: str) -> list[str]:
    script = "preview" if profile.get("web_mode") == "preview" else "dev"
    return build_workspace_command(
        "@fiapauto/frontend",
        script,
        ["--host", bind_host, "--port", str(web_port), "--strictPort"],
    )


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


def run_workspace_command(command: list[str], env: dict[str, str], label: str) -> None:
    log("launcher", f"executando {label}: {' '.join(command)}")
    completed = subprocess.run(
        command,
        cwd=str(ROOT_DIR),
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    for stream_name, content in [("stdout", completed.stdout or ""), ("stderr", completed.stderr or "")]:
        for raw_line in content.splitlines():
            line = raw_line.strip()
            if line:
                log("raw", f"[{label}:{stream_name}] {line}")
    if completed.returncode != 0:
        raise LauncherError(f"comando {label} falhou com codigo {completed.returncode}")


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
        service.process = None
        return

    process.terminate()
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        log("launcher", f"forcando encerramento de {service.name}")
        process.kill()
    service.process = None


def wait_for_port_release(port: int, timeout_seconds: float = 8.0) -> None:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        if not is_port_open(HOST, port):
            return
        time.sleep(0.2)


def is_port_open(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.5)
        return probe.connect_ex((host, port)) == 0


def clear_dev_ports_file() -> None:
    try:
        if DEV_PORTS_FILE.exists():
            DEV_PORTS_FILE.unlink()
    except OSError:
        pass


def start_stream_thread(label: str, stream: Any) -> None:
    if stream is None:
        return

    def pump() -> None:
        for line in iter(stream.readline, ""):
            content = line.rstrip()
            rendered = normalize_service_line(label, content)
            if rendered:
                log("raw", f"[{label}] {rendered}")

    threading.Thread(target=pump, daemon=True).start()


def log_useful_links(frontend_url: str, frontend_lan_url: str, api_url: str, api_public_url: str) -> None:
    log("warning", "links_uteis_laboratorio")
    for label, url in [
        ("app_local", frontend_url),
        ("app_lan", frontend_lan_url),
        ("api_local", api_url),
        ("api_publica_local", api_public_url),
        ("health", f"{api_url}/api/health"),
        ("public_topics", f"{api_url}/api/public/topics"),
        ("public_monitor", f"{api_url}/api/public/monitor/status"),
    ]:
        if url:
            log("warning", f"{label}={url}")


def maybe_open_browser(url: str) -> None:
    try:
        opened = webbrowser.open(url, new=2, autoraise=True)
        if opened:
            log("warning", f"navegador_aberto={url}")
        else:
            log("warning", f"abra_no_navegador={url}")
    except Exception as exc:  # noqa: BLE001
        log("warning", f"nao_foi_possivel_abrir_navegador={exc} url={url}")


def normalize_service_line(label: str, content: str) -> str:
    text = content.strip()
    if not text or text.startswith("> @fiapauto") or text.startswith("> vite") or text.startswith("> tsx"):
        return ""
    lowered = text.lower()
    if label == "web" and ("hmr update" in lowered or "re-optimizing dependencies" in lowered or "press h + enter" in lowered):
        return ""
    if label == "web" and "[vite] (client)" in text:
        return ""
    if label == "api" and not any(token in lowered for token in ["[public-chat]", "[api] listening", "error", "unhandled", "uncaught"]):
        return ""
    return text


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


def wait_for_http(url: str, timeout_seconds: float) -> None:
    deadline = time.time() + timeout_seconds
    last_error = "sem resposta"
    while time.time() < deadline:
        try:
            req = request.Request(url, headers={"Accept": "text/html,*/*"}, method="GET")
            with request.urlopen(req, timeout=5) as response:
                if 200 <= response.status < 500:
                    return
        except Exception as exc:  # noqa: BLE001
            last_error = str(exc)
        time.sleep(1.5)
    raise LauncherError(f"frontend nao respondeu dentro de {timeout_seconds:.0f}s: {last_error}")


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


def safe_http_get_json(url: str) -> Any:
    try:
        return http_get_json(url, headers={"Accept": "application/json"})
    except Exception:  # noqa: BLE001
        return {}


def write_dev_ports_file(payload: dict[str, Any]) -> None:
    DEV_PORTS_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def resolve_admin_token() -> str:
    candidates = [
        os.environ.get("FIAPAUTO_ADMIN_TOKEN"),
        os.environ.get("VITE_ADMIN_TOKEN"),
        read_env_file(BACKEND_ENV_FILE).get("FIAPAUTO_ADMIN_TOKEN", ""),
        read_env_file(FRONTEND_ENV_FILE).get("VITE_ADMIN_TOKEN", ""),
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
        parse_hardcoded_public_api_url(),
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


def parse_hardcoded_public_api_url() -> str:
    if not PUBLIC_API_BASE_FILE.exists():
        return ""
    source = PUBLIC_API_BASE_FILE.read_text(encoding="utf-8", errors="replace")
    marker = "const PUBLIC_API_TUNNEL ="
    if marker not in source:
        return ""
    for quote in ["'", '"']:
        prefix = f"{marker} {quote}"
        start = source.find(prefix)
        if start >= 0:
            rest = source[start + len(prefix) :]
            end = rest.find(quote)
            if end > 0:
                return rest[:end].strip()
    return ""


def read_env_file(file_path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not file_path.exists():
        return values

    for raw_line in file_path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip("'\"")
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
        backend_env.get("PUBLIC_LLM_MODEL")
        or backend_env.get("LLM_MODEL")
        or backend_env.get("LLM_MODEL_NAME")
        or frontend_env.get("VITE_PUBLIC_LLM_MODEL")
        or EXPECTED_PUBLIC_MODEL
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
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.2)
        if probe.connect_ex((HOST, port)) == 0:
            return False

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind(("", port))
        except OSError:
            return False
    return True


def detect_lan_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0]
    except OSError:
        return ""


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


def truncate_text(value: str, limit: int) -> str:
    cleaned = value.replace("\n", " ").strip()
    if len(cleaned) <= limit:
        return cleaned
    return f"{cleaned[: limit - 3]}..."


def probe_http_ok(url: str) -> bool:
    try:
        wait_for_http(url, 4.0)
        return True
    except Exception:  # noqa: BLE001
        return False


def collect_model_origins() -> list[str]:
    origins: list[str] = []
    backend_env = read_env_file(BACKEND_ENV_FILE)
    frontend_env = read_env_file(FRONTEND_ENV_FILE)
    for key in ["PUBLIC_LLM_MODEL", "LLM_MODEL", "LLM_MODEL_NAME"]:
        value = backend_env.get(key, "").strip()
        if value and value != EXPECTED_PUBLIC_MODEL:
            origins.append(f"backend/.env.local:{key} desvia para {value}")
    for key in ["VITE_OLLAMA_MODEL", "VITE_PUBLIC_LLM_MODEL"]:
        value = frontend_env.get(key, "").strip()
        if value and value != EXPECTED_PUBLIC_MODEL:
            origins.append(f"frontend/.env.local:{key} desvia para {value}")
    for source_file, needle in [
        (FRONTEND_OLLAMA_FILE, "gpt-oss:20b"),
        (BACKEND_PROVIDER_ROUTER_FILE, "gpt-oss:20b"),
    ]:
        if source_file.exists():
            source = source_file.read_text(encoding="utf-8", errors="replace")
            if needle in source:
                origins.append(f"{source_file.relative_to(ROOT_DIR)} ainda contém {needle}")
    return origins


def enable_ansi_colors() -> None:
    global ANSI_ENABLED
    if os.name != "nt":
        ANSI_ENABLED = True
        return
    try:
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.GetStdHandle(-11)
        mode = ctypes.c_uint()
        if kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            kernel32.SetConsoleMode(handle, mode.value | 0x0004)
            ANSI_ENABLED = True
    except Exception:  # noqa: BLE001
        ANSI_ENABLED = False


def log(scope: str, message: str) -> None:
    timestamp = datetime.now().strftime("%H:%M:%S")
    color = COLOR_MAP.get(scope, "")
    if ANSI_ENABLED and color:
        print(f"{color}[{timestamp}] [{scope}] {message}{RESET}", flush=True)
        return
    print(f"[{timestamp}] [{scope}] {message}", flush=True)


if __name__ == "__main__":
    sys.exit(main("prod_local"))
