FROM python:3.10-alpine

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

RUN adduser -D mailhedgehog
WORKDIR /home/mailhedgehog
USER mailhedgehog

COPY --chown=mailhedgehog:mailhedgehog pyproject.toml uv.lock README.md ./
COPY --chown=mailhedgehog:mailhedgehog src ./src
RUN uv sync --no-dev --frozen

EXPOSE 1025 8025
ENV MH_HTTP_HOST=0.0.0.0 MH_SMTP_HOST=0.0.0.0

ENTRYPOINT ["uv", "run", "--no-dev", "mailhedgehog"]
