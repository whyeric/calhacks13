FROM ghcr.io/astral-sh/uv:0.13.5 AS uv
FROM python:3.13-slim
COPY --from=uv /uv /uvx /bin/
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev
COPY *.py ./
COPY prompts ./prompts
COPY tools ./tools
# Build with: docker build --build-context fixtures=../fixtures agent
COPY --from=fixtures walmart ./fixtures/walmart
RUN useradd --create-home --uid 10001 agent
USER agent
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1 PORT=8000 WALMART_FIXTURES_DIR=/app/fixtures/walmart
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/status', timeout=3)"
CMD ["python", "main.py"]
