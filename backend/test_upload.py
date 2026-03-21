import sys
sys.path.insert(0, 'D:/AllProject/FaultTreeAI/backend')

import asyncio
from core.parser.document import parse_document
from core.rag.retriever import add_chunks

async def test():
    chunks = parse_document('D:/AllProject/FaultTreeAI/data/manuals/通用型驱动系统故障数据（原始数据）.pdf')
    print(f"解析完成，共 {len(chunks)} 个分块")
    print("第一块内容：", chunks[0]['text'][:100] if chunks else "无")
    print("开始向量化入库...")
    await add_chunks(chunks, "test001")
    print("向量化完成！")

    from core.rag.retriever import retrieve
    results = await retrieve("驱动系统失效")
    print(f"检索测试，召回 {len(results)} 条：")
    for r in results:
        print(f"  [{r['ref_id']}] {r['text'][:60]}")

asyncio.run(test())
