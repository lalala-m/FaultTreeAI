@echo off
cd /d d:\AllProject\FaultTreeAI
git add .
git commit -m "fix: use Ollama for embeddings (nomic-embed-text, 768 dim)"
git push
