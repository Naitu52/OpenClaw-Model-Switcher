import sqlite3
import os

root = os.environ.get('OPENCLAW_AGENTS_DIR') or os.path.join(
    os.environ.get('OPENCLAW_HOME') or os.path.join(os.path.expanduser('~'), '.openclaw'),
    '.openclaw', 'agents')
for n in sorted(os.listdir(root)):
    db = os.path.join(root, n, 'agent', 'openclaw-agent.sqlite')
    if not os.path.exists(db):
        continue
    try:
        c = sqlite3.connect(db)
        row = c.execute("SELECT value FROM schema_meta WHERE key='schema_version'").fetchone()
        ver = row[0] if row else '?'
        size_kb = os.path.getsize(db) // 1024
        print(f'  {n:<12} schema={ver:<6} {size_kb}KB')
        c.close()
    except Exception as e:
        print(f'  {n:<12} ERR: {e}')