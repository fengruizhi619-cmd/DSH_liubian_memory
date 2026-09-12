import sys
f = open('C:/Users/Feng/.codex/skills/memory-skill/scripts/memory.py', 'r', encoding='utf-8')
c = f.read()
f.close()
r = 'import sys; sys.stderr.write(\"SYS.ARGV: \" + repr(sys.argv) + \"\\n\"); sys.stderr.flush()\n'
i = c.find('def cmd_search(')
c = c[:i] + r + c[i:]
f = open('C:/Users/Feng/.codex/skills/memory-skill/scripts/memory_patch.py', 'w', encoding='utf-8')
f.write(c)
f.close()
print('Patched')
