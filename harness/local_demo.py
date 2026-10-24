"""Run the laptop voice demo, tunnel it, and route the existing Cartesia number."""

import argparse
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

import httpx
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[1]


def wait_for_health(client, url, process, timeout=15):
    last_result = "no response"
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("The local voice server exited")
        try:
            response = client.get(url + "/status")
            if response.is_success and response.json().get("service") == "cartesia-line":
                return
            last_result = f"HTTP {response.status_code}"
        except (httpx.HTTPError, ValueError) as error:
            last_result = type(error).__name__
            # Some venue resolvers cache NXDOMAIN for newly created tunnel hostnames.
            # curl's DoH fallback preserves normal HTTPS certificate verification.
            if url.startswith("https://") and shutil.which("curl"):
                probe = subprocess.run(
                    [
                        "curl",
                        "--silent",
                        "--fail",
                        "--connect-timeout",
                        "2",
                        "--max-time",
                        "5",
                        "--doh-url",
                        "https://cloudflare-dns.com/dns-query",
                        url + "/status",
                    ],
                    check=False,
                    capture_output=True,
                    text=True,
                )
                try:
                    if (
                        probe.returncode == 0
                        and json.loads(probe.stdout).get("service") == "cartesia-line"
                    ):
                        return
                except ValueError:
                    pass
        time.sleep(1)
    raise RuntimeError(f"Health check failed for {url}: {last_result}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8010)
    parser.add_argument("--cloudflared", default=shutil.which("cloudflared"))
    args = parser.parse_args()
    binary = args.cloudflared or "/tmp/errand-line-demo/cloudflared"
    if not Path(binary).is_file():
        raise RuntimeError("Install cloudflared with 'brew install cloudflared' first")
    config = dotenv_values(ROOT / "agent" / ".env")
    required = [
        "ANTHROPIC_API_KEY",
        "CARTESIA_API_KEY",
        "CONVEX_SITE_URL",
        "AGENT_SECRET",
        "CARTESIA_AGENT_ID",
        "CARTESIA_PHONE_NUMBER_ID",
    ]
    missing = [name for name in required if not config.get(name)]
    if missing:
        raise RuntimeError("Missing configuration: " + ", ".join(missing))
    env = {
        **os.environ,
        **{k: v for k, v in config.items() if v is not None},
        "LOGURU_LEVEL": "WARNING",
    }
    server = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "main:app.fastapi_app",
            "--host",
            "127.0.0.1",
            "--port",
            str(args.port),
            "--log-level",
            "warning",
        ],
        cwd=ROOT / "agent",
        env=env,
    )
    children = [server]
    try:
        with httpx.Client(timeout=3) as client:
            wait_for_health(client, f"http://127.0.0.1:{args.port}", server)
        print("Local voice server is ready.", flush=True)
        tunnel = subprocess.Popen(
            [
                binary,
                "tunnel",
                "--url",
                f"http://127.0.0.1:{args.port}",
                "--protocol",
                "http2",
                "--no-autoupdate",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        children.append(tunnel)
        urls = queue.Queue()

        def drain_tunnel():
            # Drain the pipe for the whole demo; don't expose unrelated tunnel diagnostics.
            for line in tunnel.stderr:
                match = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
                if match:
                    urls.put(match.group())

        threading.Thread(target=drain_tunnel, daemon=True).start()
        try:
            url = urls.get(timeout=45)
        except queue.Empty as error:
            raise RuntimeError("Cloudflare did not return a tunnel URL") from error
        print("Checking the temporary HTTPS tunnel: " + url, flush=True)
        with httpx.Client(timeout=3) as client:
            wait_for_health(client, url, server, timeout=90)
        headers = {"X-API-Key": config["CARTESIA_API_KEY"], "Cartesia-Version": "2026-08-14"}
        with httpx.Client(
            base_url="https://api.cartesia.ai", headers=headers, timeout=20
        ) as client:
            agent_path = "/agents/" + config["CARTESIA_AGENT_ID"]
            response = client.patch(agent_path, json={"self_hosted_deployment_url": url})
            response.raise_for_status()
            number_path = "/agents/phone-numbers/" + config["CARTESIA_PHONE_NUMBER_ID"]
            response = client.patch(number_path, json={"agent_id": config["CARTESIA_AGENT_ID"]})
            response.raise_for_status()
            agent = client.get(agent_path)
            agent.raise_for_status()
            registered = agent.json().get("self_hosted_deployment_url") or ""
            # Cartesia stores the HTTPS endpoint as a hostname, without the scheme.
            if registered.removeprefix("https://").rstrip("/") != url.removeprefix("https://"):
                raise RuntimeError("Cartesia did not retain the tunnel URL")
            number = client.get(number_path)
            number.raise_for_status()
            if (number.json().get("agent") or {}).get("id") != config["CARTESIA_AGENT_ID"]:
                raise RuntimeError("Cartesia did not retain the phone assignment")
        # Keep the current URL private and refresh it on every restart.
        path = ROOT / "agent" / ".env"
        lines = [
            line
            for line in path.read_text().splitlines()
            if not line.startswith("CARTESIA_SELF_HOSTED_URL=")
        ]
        path.write_text("\n".join(lines + ["CARTESIA_SELF_HOSTED_URL=" + url]) + "\n")
        path.chmod(0o600)
        print("Local voice agent and HTTPS tunnel are ready.", flush=True)
        print("Call " + (config.get("CARTESIA_PHONE_NUMBER") or "your Cartesia number"), flush=True)
        print("Keep this terminal and laptop awake. Ctrl+C stops the demo.", flush=True)
        while True:
            if any(child.poll() is not None for child in children):
                raise RuntimeError("A demo process exited; restart this command")
            time.sleep(1)
    finally:
        for child in reversed(children):
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("Demo stopped.")
    except (RuntimeError, httpx.HTTPError) as error:
        # A provider error may include URLs, but never print credential-bearing request headers.
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from None
