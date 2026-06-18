import os, sys, time, json, subprocess, shutil, threading
from datetime import datetime
from pathlib import Path

BACKUP_DIR = Path(__file__).parent.parent / "backups"
BACKUP_INTERVAL = 3600  # 1 hour
MAX_BACKUPS = 48
_LOCK = threading.Lock()

def get_db_url():
    return os.environ.get("DATABASE_URL", "")

def is_postgres():
    return bool(get_db_url())

def _ensure_dir():
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)

def _cleanup_old():
    backups = sorted(BACKUP_DIR.glob("*.sql"), key=lambda f: f.stat().st_mtime, reverse=True)
    for f in backups[MAX_BACKUPS:]:
        f.unlink(missing_ok=True)

def _pg_dump_python(url):
    """Fallback: dump via SQL COPY commands using psycopg2."""
    import psycopg2
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"backup_{ts}.sql"
    filepath = BACKUP_DIR / filename
    try:
        conn = psycopg2.connect(url)
        conn.autocommit = True
        cur = conn.cursor()
        cur.execute("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")
        tables = [r[0] for r in cur.fetchall()]
        lines = []
        for table in tables:
            cur.execute("SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=%s ORDER BY ordinal_position", (table,))
            cols = cur.fetchall()
            col_names = [c[0] for c in cols]
            lines.append(f"-- Table: {table}")
            lines.append(f"DELETE FROM {table};")
            lines.append(f"INSERT INTO {table} ({', '.join(col_names)}) VALUES")
            cur.execute(f"SELECT * FROM {table}")
            rows = cur.fetchall()
            if not rows:
                lines[-1] = lines[-1].rstrip(" VALUES")
                lines.append(f"INSERT INTO {table} DEFAULT VALUES;")
                continue
            vals = []
            for row in rows:
                esc = []
                for v in row:
                    if v is None:
                        esc.append("NULL")
                    elif isinstance(v, (int, float)):
                        esc.append(str(v))
                    else:
                        esc.append("'" + str(v).replace("'", "''") + "'")
                vals.append("(" + ", ".join(esc) + ")")
            lines.append(",\n".join(vals) + ";")
        lines.append("")
        cur.close()
        conn.close()
        filepath.write_text("\n".join(lines), encoding="utf-8")
        _cleanup_old()
        return {"filename": filename, "size": filepath.stat().st_size, "timestamp": ts}
    except Exception as e:
        return {"error": str(e)}

def _pg_dump():
    url = get_db_url()
    if not url:
        return None
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"backup_{ts}.sql"
    filepath = BACKUP_DIR / filename
    try:
        env = os.environ.copy()
        result = subprocess.run(
            ["pg_dump", url, "--no-owner", "--no-acl", "-f", str(filepath)],
            capture_output=True, text=True, timeout=120, env=env
        )
        if result.returncode != 0:
            raise RuntimeError(f"pg_dump failed: {result.stderr}")
        _cleanup_old()
        return {"filename": filename, "size": filepath.stat().st_size, "timestamp": ts}
    except FileNotFoundError:
        return _pg_dump_python(url)
    except Exception as e:
        return {"error": str(e)}

def _sqlite_dump():
    import sqlite3 as sqlite_mod
    db_path = Path(__file__).parent / "promake.db"
    if not db_path.exists():
        return None
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"backup_{ts}.sql"
    filepath = BACKUP_DIR / filename
    try:
        conn = sqlite_mod.connect(str(db_path))
        lines = []
        for line in conn.iterdump():
            lines.append(line)
        conn.close()
        content = "\n".join(lines)
        filepath.write_text(content, encoding="utf-8")
        _cleanup_old()
        return {"filename": filename, "size": filepath.stat().st_size, "timestamp": ts}
    except Exception as e:
        return {"error": str(e)}

def create_backup():
    with _LOCK:
        _ensure_dir()
        if is_postgres():
            return _pg_dump()
        return _sqlite_dump()

def list_backups():
    _ensure_dir()
    files = []
    for f in sorted(BACKUP_DIR.glob("*.sql"), key=lambda f: f.stat().st_mtime, reverse=True):
        files.append({
            "filename": f.name,
            "size": f.stat().st_size,
            "timestamp": datetime.fromtimestamp(f.stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S")
        })
    return files

def get_backup_path(filename):
    p = BACKUP_DIR / filename
    if p.exists() and p.suffix == ".sql":
        return p
    return None

def backup_worker():
    while True:
        try:
            time.sleep(BACKUP_INTERVAL)
            result = create_backup()
            if result and "error" not in result:
                print(f"[backup] Created: {result['filename']} ({result['size']} bytes)")
        except Exception:
            pass
