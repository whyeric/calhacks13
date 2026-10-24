FROM ghcr.io/astral-sh/uv:0.13.5 AS uv
FROM python:3.13-slim
COPY --from=uv /uv /uvx /bin/
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev
COPY main.py claude.py context.py convex_api.py ./
COPY prompts ./prompts
COPY tools ./tools
RUN useradd --create-home --uid 10001 agent
USER agent
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1 PORT=8000
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/status', timeout=3)"
CMD ["python", "main.py"]
