import sys, io, os
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.path.insert(0, os.getcwd())
import semantic_search as ss
print("全工作区向量化开始...")
res = ss.index_all(progress=True)
print("完成:", res)
