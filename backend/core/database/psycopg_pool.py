"""
psycopg2 连接池兼容层
用于兼容 main.py 中的 init_pg_pool / close_pg_pool 调用。
当前后端大多数接口已使用按需直连 psycopg2，这里保持轻量实现避免启动报错。
"""

_initialized = False


def init_pg_pool():
    global _initialized
    _initialized = True


def close_pg_pool():
    global _initialized
    _initialized = False


def is_pool_initialized() -> bool:
    return _initialized

