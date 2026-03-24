import asyncio
import asyncpg

async def test():
    try:
        conn = await asyncpg.connect(
            host='localhost', port=5432,
            user='postgres', password='faulttree123',
            database='faulttree', timeout=5
        )
        print('connected ok')

        ext = await conn.fetchrow("SELECT * FROM pg_extension WHERE extname='vector'")
        print('pgvector:', ext)

        tables = await conn.fetch("SELECT tablename FROM pg_tables WHERE schemaname='public'")
        for t in tables:
            print('table:', t['tablename'])

        await conn.close()
    except Exception as e:
        print('error:', type(e).__name__, e)

asyncio.run(test())
