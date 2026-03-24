import asyncio
from sqlalchemy import text
from backend.core.database.connection import AsyncSessionLocal

async def test():
    async with AsyncSessionLocal() as s:
        r = await s.execute(text('SELECT 1'))
        print('✓ 数据库连接成功!')

asyncio.run(test())
