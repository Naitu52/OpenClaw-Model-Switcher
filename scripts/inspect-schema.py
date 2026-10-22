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
        # 看 schema_meta 实际结构
        cols = c.execute("PRAGMA table_info(schema_meta)").fetchall()
        # 取第一行
        first = c.execute("SELECT * FROM schema_meta LIMIT 1").fetchone()
        # 找版本
        all_rows = c.execute("SELECT * FROM schema_meta").fetchall()
        print(f'\n=== {n} ===')
        print(f'  cols: {cols}')
        print(f'  first: {first}')
        print(f'  all: {all_rows}')
        c.close()
    except Exception as e:
        print(f'{n} ERR: {e}')