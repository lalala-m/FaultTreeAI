import os
from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    # ─── 数据库配置 ───
    DB_HOST: str = "localhost"
    DB_PORT: int = 5432
    DB_USER: str = "postgres"
    DB_PASSWORD: str = "your_postgres_password"
    DB_NAME: str = "faulttree"

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

    # ─── LLM Provider ───
    LLM_PROVIDER: str = "minimax"

    # ─── MiniMax ───
    MINIMAX_API_KEY: str = ""
    MINIMAX_GROUP_ID: str = ""
    MINIMAX_MODEL: str = "MiniMax-M2"
    MINIMAX_EMBED_MODEL: str = "embo-01"

    # ─── OpenAI ───
    OPENAI_API_KEY: str = ""
    OPENAI_BASE_URL: str = "https://api.openai.com/v1"
    LLM_MODEL: str = "gpt-4o"

    # ─── Anthropic ───
    ANTHROPIC_API_KEY: str = ""
    ANTHROPIC_MODEL: str = "claude-3-5-sonnet-20241022"

    # ─── Azure OpenAI ───
    AZURE_OPENAI_KEY: str = ""
    AZURE_OPENAI_ENDPOINT: str = ""
    AZURE_OPENAI_DEPLOYMENT: str = "gpt-4o"
    AZURE_OPENAI_API_VERSION: str = "2024-06-01"

    # ─── Embedding ───
    EMBED_PROVIDER: str = "minimax"
    EMBED_MODEL: str = "embo-01"
    EMBED_DIM: int = 1024

    # ─── 生成参数 ───
    LLM_TEMPERATURE: float = 0.1
    LLM_MAX_TOKENS: int = 4096
    RAG_TOP_K: int = 5
    RAG_SIMILARITY_THRESHOLD: float = 0.7
    MAX_RETRY: int = 3

    # ─── 文件存储 ───
    MANUALS_PATH: str = "data/manuals"
    SAMPLES_PATH: str = "data/samples"

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
