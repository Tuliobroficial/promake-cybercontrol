import os, re, sqlite3, threading
from pathlib import Path

_thread_local = threading.local()


def _get_base_dir():
    return Path(__file__).parent.parent


def _parse_pg_url(url):
    import urllib.parse
    url = url.replace("postgres://", "http://").replace("postgresql://", "http://")
    parsed = urllib.parse.urlparse(url)
    host = parsed.hostname or "localhost"
    port = parsed.port or 5432
    user = parsed.username or "postgres"
    password = parsed.password or ""
    dbname = parsed.path.lstrip("/") or "postgres"
    return host, port, user, password, dbname


class _Row:
    def __init__(self, data):
        self._data = data

    def __getitem__(self, key):
        if isinstance(key, int):
            if isinstance(self._data, dict):
                return list(self._data.values())[key]
            return self._data[key]
        return self._data[key]

    def __getattr__(self, key):
        if key in self._data:
            return self._data[key]
        raise AttributeError(key)

    def keys(self):
        return self._data.keys()

    def values(self):
        return self._data.values()

    def __iter__(self):
        return iter(self._data.values())

    def __len__(self):
        return len(self._data)

    def __contains__(self, key):
        return key in self._data


class _Cursor:
    def __init__(self, cursor=None, rows=None, rowid=None, description=None):
        self._cursor = cursor
        self._rows = rows or []
        self._idx = 0
        self._rowid = rowid
        self._description = description
        self._closed = False
        self.rowcount = len(self._rows) if rows else 0

    @property
    def description(self):
        if self._description:
            return self._description
        if self._cursor and self._cursor.description:
            return self._cursor.description
        return None

    def fetchone(self):
        if self._cursor:
            row = self._cursor.fetchone()
            if row is None:
                return None
            if isinstance(row, sqlite3.Row):
                return row
            if hasattr(row, '_mapping'):
                return _Row(row._mapping)
            if isinstance(row, tuple):
                desc = self._cursor.description or []
                cols = [d[0] for d in desc]
                return _Row(dict(zip(cols, row)))
            return row
        if self._idx >= len(self._rows):
            return None
        r = self._rows[self._idx]
        self._idx += 1
        return r

    def fetchall(self):
        if self._cursor:
            rows = self._cursor.fetchall()
            if not rows:
                return []
            if isinstance(rows[0], sqlite3.Row):
                return rows
            if hasattr(rows[0], '_mapping'):
                return [_Row(r._mapping) for r in rows]
            desc = self._cursor.description or []
            cols = [d[0] for d in desc]
            return [_Row(dict(zip(cols, r))) if isinstance(r, tuple) else r for r in rows]
        return self._rows

    def close(self):
        self._closed = True
        if self._cursor:
            self._cursor.close()


class Database:
    _last_rowid = 0

    def __init__(self):
        self._db_url = os.environ.get("DATABASE_URL", "")
        self._is_pg = bool(self._db_url)
        self._conn = None
        self._init()

    def _init(self):
        if self._is_pg:
            self._init_pg()
        else:
            self._init_sqlite()

    def _init_sqlite(self):
        db_path = _get_base_dir() / "backend" / "promake.db"
        self._conn = sqlite3.connect(str(db_path))
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")

    def _init_pg(self):
        import psycopg2
        import psycopg2.extras
        host, port, user, password, dbname = _parse_pg_url(self._db_url)
        self._conn = psycopg2.connect(
            host=host, port=port, user=user, password=password, dbname=dbname
        )
        self._conn.autocommit = False

    @property
    def is_postgres(self):
        return self._is_pg

    def _convert_sql(self, sql):
        if not self._is_pg:
            return sql
        sql = sql.replace("?", "%s")
        sql = sql.replace("datetime('now','localtime')", "NOW()")
        sql = sql.replace("date('now','localtime')", "CURRENT_DATE")
        sql = re.sub(r"date\('now','start of month'\)", "date_trunc('month', NOW())", sql, flags=re.I)
        sql = re.sub(r"strftime\('%m',\s*(\w+)\)", r"EXTRACT(MONTH FROM CAST(\1 AS date))", sql, flags=re.I)
        sql = re.sub(r"strftime\('%Y',\s*(\w+)\)", r"EXTRACT(YEAR FROM CAST(\1 AS date))", sql, flags=re.I)
        sql = re.sub(r"datetime\('now'(?:,'[^']+')+\)", self._convert_datetime_now, sql, flags=re.I)
        sql = re.sub(r"date\('now'(?:,'[^']+')+\)", self._convert_date_now, sql, flags=re.I)
        sql = re.sub(r"\bLIKE\b", "ILIKE", sql)
        sql = re.sub(r"\bINSERT\s+OR\s+IGNORE\b(.*)", lambda m: "INSERT" + m.group(1) + " ON CONFLICT DO NOTHING", sql, flags=re.I)
        sql = re.sub(r"\bINSERT\s+OR\s+REPLACE\b", "INSERT", sql)
        sql = sql.replace("INTEGER PRIMARY KEY AUTOINCREMENT", "SERIAL PRIMARY KEY")
        sql = re.sub(r"(\bINTEGER\b)\s+\bAUTOINCREMENT\b", r"\1", sql)
        sql = sql.replace("BLOB", "BYTEA")
        return sql

    def _convert_datetime_now(self, m):
        inner = m.group(0)
        mods = re.findall(r"'([^']+)'", inner)
        if not mods:
            return "NOW()"
        pg = self._build_date_expr(mods)
        return pg

    def _convert_date_now(self, m):
        inner = m.group(0)
        mods = re.findall(r"'([^']+)'", inner)
        if not mods:
            return "CURRENT_DATE"
        pg = self._build_date_expr(mods)
        return pg

    def _build_date_expr(self, mods):
        intervals = []
        truncs = []
        for m in mods:
            m = m.strip()
            if m == "localtime":
                continue
            if m in ("start of month", "start of year", "start of day"):
                truncs.append(m.replace("start of ", ""))
                continue
            if m in ("end of month", "end of year", "end of day"):
                truncs.append(m.replace("end of ", ""))
                continue
            parsed = re.match(r'(-?\d+)\s+(months|days|years|hours|minutes)', m)
            if parsed:
                num, unit = parsed.groups()
                intervals.append(f"INTERVAL '{num} {unit}'")
        expr = "NOW()"
        for iv in intervals:
            expr = f"({expr} + {iv})"
        for t in truncs:
            expr = f"date_trunc('{t}', {expr})"
        return expr

    def _convert_date_mod(self, mod):
        mod = mod.strip()
        if mod == "start of month":
            return "date_trunc('month', NOW())"
        if mod == "start of year":
            return "date_trunc('year', NOW())"
        m = re.match(r'(-?\d+)\s+(months|days|years|hours|minutes)', mod)
        if m:
            num, unit = m.groups()
            return f"(NOW() + INTERVAL '{num} {unit}')"
        return f"NOW() + INTERVAL '{mod}'"

    def _has_returning(self, sql):
        return "RETURNING" in sql.upper()

    def execute(self, sql, params=None):
        sql_stripped = sql.strip().upper()
        if sql_stripped.startswith("SELECT LAST_INSERT_ROWID"):
            return _Cursor(rows=[(self._last_rowid,)], description=[("id",)])

        sql = self._convert_sql(sql)
        is_insert = sql_stripped.startswith("INSERT")

        if is_insert and self._is_pg and not self._has_returning(sql):
            sql = sql.rstrip(";") + " RETURNING id"
        elif is_insert and not self._is_pg:
            sql = sql.rstrip(";")

        if params is not None:
            if not isinstance(params, (list, tuple)):
                params = (params,)
            if isinstance(params, list):
                params = tuple(params)
            cur = self._conn.cursor()
            try:
                cur.execute(sql, params)
            except Exception:
                self._conn.rollback()
                raise
        else:
            cur = self._conn.cursor()
            try:
                cur.execute(sql)
            except Exception:
                self._conn.rollback()
                raise

        if is_insert and self._is_pg and self._has_returning(sql):
            row = cur.fetchone()
            if row:
                self._last_rowid = row[0]
        elif is_insert and not self._is_pg:
            self._last_rowid = cur.lastrowid or 0

        return _Cursor(cursor=cur)

    def executescript(self, script):
        sql = self._convert_sql(script)
        if not self._is_pg:
            self._conn.executescript(sql)
            return
        cur = self._conn.cursor()
        # psycopg2 cannot execute multiple statements in one execute() call,
        # so we split. Errors propagate — do NOT swallow them.
        for stmt in re.split(r";\s*\n\s*", sql):
            stmt = stmt.strip().rstrip(";").strip()
            if stmt:
                cur.execute(stmt)
        self._conn.commit()

    def commit(self):
        self._conn.commit()

    def rollback(self):
        self._conn.rollback()

    def close(self):
        if self._conn:
            self._conn.close()
            self._conn = None

    @property
    def last_insert_rowid(self):
        return self._last_rowid

    def cursor(self):
        return _Cursor(cursor=self._conn.cursor())

    def get_connection(self):
        return self._conn


def get_db():
    if 'db' not in _thread_local.__dict__:
        _thread_local.db = Database()
    return _thread_local.db


def close_db(e=None):
    db = getattr(_thread_local, 'db', None)
    if db:
        db.close()
        del _thread_local.db


def row_to_dict(row):
    if row is None:
        return None
    if isinstance(row, sqlite3.Row):
        return dict(row)
    if hasattr(row, '_mapping'):
        return dict(row._mapping)
    if hasattr(row, '_data'):
        return dict(row._data)
    return dict(row)


def rows_to_list(rows):
    return [row_to_dict(r) for r in rows]
