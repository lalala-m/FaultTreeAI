import os
from pathlib import Path
from pydantic_settings import BaseSettings
from pydantic import Field, model_validator
from functools import lru_cache


class Settings(BaseSettings):
    # ??? ????�????
    DATABASE_URL_ENV: str = Field(default="", alias="DATABASE_URL")
    DB_HOST: str = "localhost"
    DB_PORT: int = 5432
    DB_USER: str = "postgres"
    DB_PASSWORD: str = "your_postgres_password"
    DB_NAME: str = "faulttree"

    @model_validator(mode="after")
    def _populate_db_fields_from_database_url(self):
        if not self.DATABASE_URL_ENV:
            return self

        from urllib.parse import urlparse, unquote

        raw = self.DATABASE_URL_ENV.strip()
        normalized = raw.replace("postgresql+asyncpg://", "postgresql://").replace(
            "postgresql+psycopg2://", "postgresql://"
        )
        parsed = urlparse(normalized)

        if parsed.scheme.startswith("postgresql"):
            if parsed.hostname:
                self.DB_HOST = parsed.hostname
            if parsed.port:
                self.DB_PORT = parsed.port
            if parsed.username:
                self.DB_USER = unquote(parsed.username)
            if parsed.password:
                self.DB_PASSWORD = unquote(parsed.password)
            if parsed.path and len(parsed.path) > 1:
                self.DB_NAME = parsed.path.lstrip("/")

        return self

    @property
    def DATABASE_URL(self) -> str:
        from urllib.parse import quote_plus
        user = quote_plus(self.DB_USER)
        password = quote_plus(self.DB_PASSWORD)
        return (
            f"postgresql+asyncpg://{user}:{password}"
            f"@{self.DB_HOST}:{self.DB_PORT}/{self.DB_NAME}"
        )

    @property
    def DATABASE_URL_SYNC(self) -> str:
        return (
            f"postgresql+psycopg2://{self.DB_USER}:{self.DB_PASSWORD}"
            f"@{self.DB_HOST}:{self.DB_PORT}/{self.DB_NAME}"
        )

    # ??? LLM Provider ???
    LLM_PROVIDER: str = "openai"
    LLM_FALLBACK_PROVIDER: str = "openai"

    # ??? MiniMax ???
    MINIMAX_API_KEY: str = ""
    MINIMAX_GROUP_ID: str = ""
    MINIMAX_MODEL: str = "MiniMax-M2"
    MINIMAX_EMBED_MODEL: str = "embo-01"
    MINIMAX_BASE_URL: str = "https://api.minimaxi.com"  # ????�?https://api.minimaxi.com

    # ??? OpenAI ???
    OPENAI_API_KEY: str = ""
    OPENAI_BASE_URL: str = "https://api.openai.com/v1"
    LLM_MODEL: str = "gpt-4o"

    # ??? Baidu VOP ???
    BAIDU_VOP_API_KEY: str = ""
    BAIDU_VOP_SECRET_KEY: str = ""
    BAIDU_VOP_CUID: str = "faulttreeai"
    BAIDU_VOP_DEV_PID: int = 1537

    # ??? Anthropic ???
    ANTHROPIC_API_KEY: str = ""
    ANTHROPIC_MODEL: str = "claude-3-5-sonnet-20241022"

    # ??? Azure OpenAI ???
    AZURE_OPENAI_KEY: str = ""
    AZURE_OPENAI_ENDPOINT: str = ""
    AZURE_OPENAI_DEPLOYMENT: str = "gpt-4o"
    AZURE_OPENAI_API_VERSION: str = "2024-06-01"

    # ??? Ollama ???
    OLLAMA_BASE_URL: str = "http://localhost:11434"
    OLLAMA_MODEL: str = "qwen2.5:14b-instruct"
    OLLAMA_EMBED_MODEL: str = "nomic-embed-text"

    # ??? Embedding ???
    EMBED_PROVIDER: str = "openai"
    EMBED_MODEL: str = "text-embedding-ada-002"
    EMBED_DIM: int = 1024

    # ??? ???? ???
    LLM_TEMPERATURE: float = 0.1
    LLM_MAX_TOKENS: int = 4096
    RAG_TOP_K: int = 3
    RAG_SIMILARITY_THRESHOLD: float = 0.7
    RAG_USE_HYBRID: bool = False
    RAG_VECTOR_WEIGHT: float = 0.5
    MAX_RETRY: int = 3

    JWT_SECRET: str = ""
    JWT_EXPIRE_MINUTES: int = 60 * 24 * 7

    # ??? ???? ???
    MANUALS_PATH: str = str(Path(__file__).resolve().parent.parent / "data" / "manuals")
    SAMPLES_PATH: str = str(Path(__file__).resolve().parent.parent / "data" / "samples")
    SKIP_EMBED_ON_FAIL: bool = True

    class Config:
        env_file = str(Path(__file__).resolve().parent.parent / ".env")
        env_file_encoding = "utf-8"
        populate_by_name = True
        extra = "ignore"


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
