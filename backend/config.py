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

    # ??? 百度 Embedding（千帆/文心）???
    BAIDU_EMBED_API_KEY: str = ""
    BAIDU_EMBED_SECRET_KEY: str = ""
    BAIDU_EMBED_MODEL: str = "bge-large-zh"

    # ??? Vision-Language (VLM) ???
    # 用于 RTC 实时通话中的原生多模态分析；留空则使用检测摘要 + 文本 LLM 回退方案
    VLM_PROVIDER: str = ""  # openai / azure_openai / ollama
    VLM_MODEL: str = "gpt-4o"
    VLM_BASE_URL: str = ""
    VLM_API_KEY: str = ""
    VLM_MAX_IMAGE_LONG_SIDE: int = 768
    VLM_IMAGE_QUALITY: int = 80

    # ??? Realtime Analysis ???
    REALTIME_FRAME_MODEL_KEY: str = "auto"
    REALTIME_FRAME_CONF: float = 0.15
    REALTIME_FRAME_DEVICE: str = "cpu"
    REALTIME_FRAME_INTERVAL_MS: int = 2000
    REALTIME_MIN_ANOMALY_FRAMES: int = 2
    REALTIME_ALERT_COOLDOWN_SECONDS: float = 10.0
    REALTIME_ENABLE_LLM_ON_NORMAL: bool = False

    # ??? ???? ???
    LLM_TEMPERATURE: float = 0.1
    LLM_MAX_TOKENS: int = 4096
    RAG_TOP_K: int = 2
    RAG_SIMILARITY_THRESHOLD: float = 0.7
    RAG_USE_HYBRID: bool = False
    RAG_VECTOR_WEIGHT: float = 0.5
    MAX_RETRY: int = 3

    JWT_SECRET: str = ""
    JWT_EXPIRE_MINUTES: int = 60 * 24 * 7

    RTC_APP_ID: str = ""
    RTC_APP_KEY: str = ""
    RTC_DEFAULT_ROOM: str = ""
    RTC_ROOM_PREFIX: str = "faulttree"
    RTC_TOKEN_EXPIRE_SECONDS: int = 60 * 60 * 24
    RTC_AI_USER_PREFIX: str = "ai-bot"
    RTC_AI_DISPLAY_NAME: str = "故障检修系统"
    RTC_AI_WELCOME_MESSAGE: str = "我已接通。你可以直接语音提问，也可以让我持续观察摄像头画面并做故障判断。"

    # RTC AI Bot（Linux SDK）
    RTC_BOT_ENABLED: bool = False
    RTC_BOT_SO_PATH: str = ""
    RTC_BOT_SAMPLE_RATE: int = 16000
    RTC_BOT_CHANNELS: int = 1
    RTC_BOT_FRAME_MS: int = 20

    # RTC ASR/TTS
    RTC_ASR_PROVIDER: str = "volcengine"  # baidu_vop / openai / volcengine
    RTC_TTS_PROVIDER: str = "baidu_vop"  # baidu_vop / openai / volcengine
    RTC_TTS_MODEL: str = "tts-1"
    RTC_TTS_VOICE: str = "alloy"

    # 火山引擎语音（豆包 Seed-ASR / Seed-TTS）
    # 新版控制台统一 API Key（单 key 鉴权），优先级高于 APP_ID/ACCESS_KEY
    VOLCENGINE_API_KEY: str = ""
    # 旧版控制台鉴权：应用 ID + Access Key（或 Access Token）
    VOLCENGINE_APP_ID: str = ""
    VOLCENGINE_ACCESS_TOKEN: str = ""
    VOLCENGINE_ACCESS_KEY: str = ""

    # ASR 可单独配置；未配置时回退到全局火山引擎 key
    VOLCENGINE_ASR_API_KEY: str = ""
    VOLCENGINE_ASR_APP_ID: str = ""
    VOLCENGINE_ASR_ACCESS_KEY: str = ""
    VOLCENGINE_ASR_RESOURCE_ID: str = "volc.bigasr.auc_turbo"  # 大模型录音文件识别极速版（同步）

    # TTS 可单独配置；未配置时回退到全局火山引擎 key
    VOLCENGINE_TTS_API_KEY: str = ""
    VOLCENGINE_TTS_APP_ID: str = ""
    VOLCENGINE_TTS_ACCESS_KEY: str = ""
    VOLCENGINE_TTS_RESOURCE_ID: str = "seed-tts-2.0"            # 豆包语音合成 2.0
    VOLCENGINE_TTS_VOICE_TYPE: str = "zh_female_wanqudashu_moon_bigtts"
    VOLCENGINE_TTS_SPEAKER: str = "zh_female_wanqudashu_moon_bigtts"
    VOLCENGINE_TTS_EMOTION: str = ""                            # 情感标签，如 happy、neutral
    VOLCENGINE_TTS_SPEED_RATIO: float = 1.0
    VOLCENGINE_TTS_SAMPLE_RATE: int = 24000                     # 豆包 TTS 输出采样率，常见 24000

    # ??? ???? ???
    MANUALS_PATH: str = str(Path(__file__).resolve().parent.parent / "data" / "manuals")
    SAMPLES_PATH: str = str(Path(__file__).resolve().parent.parent / "data" / "samples")
    SKIP_EMBED_ON_FAIL: bool = True

    # ??? ???? ???
    FEISHU_ENABLED: bool = False
    FEISHU_APP_ID: str = ""
    FEISHU_APP_SECRET: str = ""
    FEISHU_ENCRYPT_KEY: str = ""
    FEISHU_VERIFICATION_TOKEN: str = ""
    FEISHU_BOT_NAME: str = "故障检索机器人"
    FEISHU_WEBHOOK_PATH: str = "/api/feishu/webhook"
    FEISHU_REPLY_MAX_LENGTH: int = 3000
    # 飞书视频排查入口域名，留空则使用相对路径 /static/rtc-call.html
    FEISHU_RTC_BASE_URL: str = ""
    # 飞书机器人打开的网页端地址，例如 https://192.168.1.226:8443
    FEISHU_WEB_APP_URL: str = ""

    class Config:
        env_file = str(Path(__file__).resolve().parent.parent / ".env")
        env_file_encoding = "utf-8"
        populate_by_name = True
        extra = "ignore"


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
