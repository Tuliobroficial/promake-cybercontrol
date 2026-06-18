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

def _pg_dump():
    url = get_db_url()
    if not url:
        return None
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"backup_{ts}.sql"
    filepath = BACKUP_DIR / filename
    try:
        env = os.environ.copy()
        # Strip pgpass-style password from env for security
        result = subprocess.run(
            ["pg_dump", url, "--no-owner", "--no-acl", "-f", str(filepath)],
            capture_output=True, text=True, timeout=120, env=env
        )
        if result.returncode != 0:
            raise RuntimeError(f"pg_dump failed: {result.stderr}")
        _cleanup_old()
        return {"filename": filename, "size": filepath.stat().st_size, "timestamp": ts}
    except FileNotFoundError:
        return {"error": "pg_dump not installed"}
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
