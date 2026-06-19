import json, os, re, html, time, base64, io, hmac, hashlib
from datetime import datetime, timedelta
from functools import wraps
from pathlib import Path

from flask import request, jsonify, g, current_app
import pyotp
import qrcode

BASE_DIR = Path(__file__).parent.parent

# ─── RBAC Roles ──────────────────────────────

ROLES = {
    "super_admin": {
        "label": "Super Admin",
        "priority": 100,
        "inherits": None,
        "modules": "__all__"
    },
    "admin": {
        "label": "Administrador",
        "priority": 90,
        "inherits": None,
        "modules": "__all__"
    },
    "developer": {
        "label": "Desenvolvedor",
        "priority": 50,
        "inherits": None,
        "modules": {
            "dashboard": "admin",
            "projects": "admin",
            "clients": "view",
            "design": "admin",
            "notes": "admin",
            "files": "admin",
            "chat": "admin",
            "calendar": "edit",
            "developments": "admin",
            "tickets": "view",
            "team": "view",
        }
    },
    "finance": {
        "label": "Financeiro",
        "priority": 60,
        "inherits": None,
        "modules": {
            "dashboard": "view",
            "finance": "admin",
            "contracts": "edit",
            "clients": "view",
            "projects": "view",
            "reports": "admin",
            "notifications": "view",
        }
    },
    "support": {
        "label": "Suporte",
        "priority": 40,
        "inherits": None,
        "modules": {
            "dashboard": "view",
            "tickets": "admin",
            "clients": "view",
            "projects": "view",
            "service_orders": "edit",
            "notifications": "edit",
            "chat": "edit",
            "calendar": "view",
            "files": "view",
        }
    },
    "client": {
        "label": "Cliente",
        "priority": 10,
        "inherits": None,
        "modules": {
            "dashboard": "view",
            "projects": "view",
            "service_orders": "view",
            "finance": "view",
            "calendar": "view",
            "files": "view",
            "tickets": "create",
            "developments": "view",
        }
    }
}

PERMISSION_HIERARCHY = {"view": 1, "create": 2, "edit": 3, "delete": 4, "admin": 5}

ACL_MODULES = [
    "dashboard", "clients", "projects", "leads", "contracts",
    "service_orders", "finance", "team", "settings", "design",
    "marketing", "calendar", "notifications", "files", "tickets",
    "developments", "landing", "youtube", "spotify", "chat",
    "notes", "reports", "super_admin"
]

def get_role_permissions(role_name):
    role = ROLES.get(role_name)
    if not role:
        return {}
    if role["modules"] == "__all__":
        return {m: "admin" for m in ACL_MODULES}
    return role["modules"].copy()

def permission_level(perm):
    return PERMISSION_HIERARCHY.get(perm, 0)

def has_permission(user_role, module, required_level):
    role_perms = get_role_permissions(user_role)
    granted = role_perms.get(module, "none")
    return permission_level(granted) >= permission_level(required_level)

# ─── Decorators ──────────────────────────────

def require_role(*roles):
    def decorator(f):
        @wraps(f)
        def decorated(*args, **kwargs):
            user = g.get("current_user")
            if not user:
                return jsonify({"error": "Nao autenticado"}), 401
            if user["role"] not in roles:
                return jsonify({"error": "Sem permissao de acesso"}), 403
            return f(*args, **kwargs)
        return decorated
    return decorator

def require_permission(module, level="view"):
    def decorator(f):
        @wraps(f)
        def decorated(*args, **kwargs):
            user = g.get("current_user")
            if not user:
                return jsonify({"error": "Nao autenticado"}), 401
            if not has_permission(user["role"], module, level):
                return jsonify({"error": f"Sem permissao para {module}:{level}"}), 403
            return f(*args, **kwargs)
        return decorated
    return decorator

def require_mfa(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        user = g.get("current_user")
        if not user:
            return jsonify({"error": "Nao autenticado"}), 401
        if user.get("mfa_enabled"):
            mfa_verified = request.headers.get("X-MFA-Token", "")
            if not mfa_verified:
                return jsonify({"error": "MFA necessario", "mfa_required": True}), 403
        return f(*args, **kwargs)
    return decorated

def audit_log(action, entity_type, entity_id=None, description="", details=None):
    try:
        user = g.get("current_user")
        from db_adapter import get_db
        db = get_db()
        db.execute(
            """INSERT INTO audit_log
               (user_id, user_name, user_role, action, entity_type, entity_id,
                description, details, ip_address, user_agent, timestamp)
               VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))""",
            (
                user["id"] if user else None,
                user["name"] if user else "Sistema",
                user["role"] if user else "system",
                action,
                entity_type,
                str(entity_id) if entity_id else None,
                description[:500] if description else "",
                json.dumps(details) if details else None,
                request.headers.get("X-Forwarded-For", request.remote_addr) if request else None,
                request.headers.get("User-Agent", "")[:300] if request else None,
            )
        )
        db.commit()
    except Exception:
        pass

# ─── MFA (Google Authenticator) ──────────────

def generate_mfa_secret():
    return pyotp.random_base32()

def get_mfa_provisioning_uri(secret, email):
    return pyotp.totp.TOTP(secret).provisioning_uri(name=email, issuer_name="Promake ERP")

def generate_mfa_qrcode_base64(secret, email):
    uri = get_mfa_provisioning_uri(secret, email)
    img = qrcode.make(uri)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return base64.b64encode(buf.getvalue()).decode()

def verify_mfa_code(secret, code):
    totp = pyotp.TOTP(secret)
    return totp.verify(code, valid_window=1)

def generate_recovery_codes(count=8):
    import random as rnd
    codes = set()
    while len(codes) < count:
        codes.add(''.join(rnd.choices('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', k=10)))
    return list(codes)

# ─── Input Sanitization (XSS Protection) ─────

ALLOWED_TAGS = {"b", "i", "u", "a", "br", "p", "strong", "em", "span", "div", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "code", "img", "table", "tr", "td", "th", "thead", "tbody", "hr"}

def sanitize_html(text):
    if not text or not isinstance(text, str):
        return text
    text = html.escape(text)
    return text

def sanitize_input(value, allow_html=False):
    if isinstance(value, str):
        if allow_html:
            return value
        return html.escape(value.strip())
    if isinstance(value, dict):
        return {k: sanitize_input(v, allow_html) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [sanitize_input(v, allow_html) for v in value]
    return value

def sanitize_request_data(data):
    if isinstance(data, dict):
        return {k: sanitize_input(v) for k, v in data.items()}
    return data

# ─── OWASP Security Headers ──────────────────

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "X-XSS-Protection": "0",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://promake-cybercontrol.onrender.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' https:; connect-src 'self' https:; frame-src 'none'; media-src 'self'",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
    "Cache-Control": "no-store, max-age=0",
    "Pragma": "no-cache",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
}

def apply_security_headers(resp):
    for header, value in SECURITY_HEADERS.items():
        resp.headers[header] = value
    return resp

# ─── CSRF Protection ─────────────────────────

def generate_csrf_token():
    import secrets
    token = secrets.token_hex(32)
    g.csrf_token = token
    return token

def validate_csrf_token():
    token = request.headers.get("X-CSRF-Token", "")
    stored = getattr(g, "csrf_token", None)
    if not stored or not hmac.compare_digest(stored, token):
        return False
    return True

def require_csrf(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if request.method in ("POST", "PUT", "DELETE", "PATCH"):
            if not validate_csrf_token():
                return jsonify({"error": "CSRF token invalido"}), 403
        return f(*args, **kwargs)
    return decorated

# ─── Rate Limit (advanced) ───────────────────

RATE_LIMIT_STORE = {}
RATE_LIMIT_WINDOW = 60
RATE_LIMIT_DEFAULT_MAX = 60

def get_client_ip():
    return request.headers.get("X-Forwarded-For", request.remote_addr or "0.0.0.0")

def check_rate_limit(key_prefix="", max_requests=None, window=None):
    if max_requests is None:
        max_requests = RATE_LIMIT_DEFAULT_MAX
    if window is None:
        window = RATE_LIMIT_WINDOW
    ip = get_client_ip()
    now = time.time()
    window_key = int(now / window)
    key = f"{key_prefix}:{ip}:{window_key}"
    store_key = f"{key_prefix}:{ip}:rate"
    entry = RATE_LIMIT_STORE.get(store_key, {"window": window_key, "count": 0})
    if entry["window"] != window_key:
        entry = {"window": window_key, "count": 0}
    entry["count"] += 1
    RATE_LIMIT_STORE[store_key] = entry
    if entry["count"] > max_requests:
        return False
    return True

def rate_limit_advanced(limit=None, per=60, key="default"):
    def decorator(f):
        @wraps(f)
        def wrapper(*args, **kwargs):
            if not check_rate_limit(key_prefix=key, max_requests=limit, window=per):
                retry_after = per
                resp = jsonify({"error": "Muitas requisicoes. Tente novamente em breve."})
                resp.headers["Retry-After"] = str(retry_after)
                resp.headers["X-RateLimit-Limit"] = str(limit)
                resp.headers["X-RateLimit-Reset"] = str(int(time.time()) + retry_after)
                return resp, 429
            return f(*args, **kwargs)
        return wrapper
    return decorator

# ─── SQL Injection protection helpers ───────

def validate_sql_identifier(name):
    if not re.match(r'^[a-zA-Z_][a-zA-Z0-9_]*$', name):
        raise ValueError(f"Invalid identifier: {name}")
    return name

def sanitize_order_by(field, table_prefix=None):
    allowed = re.sub(r'[^a-zA-Z0-9_,.\s]', '', field)
    return allowed

# ─── Session security ────────────────────────

def invalidate_other_sessions(user_id, current_token_jti=None):
    from db_adapter import get_db
    db = get_db()
    if current_token_jti:
        db.execute(
            "UPDATE refresh_tokens SET revoked=1 WHERE user_id=? AND token!=?",
            (user_id, current_token_jti)
        )
    else:
        db.execute(
            "UPDATE refresh_tokens SET revoked=1 WHERE user_id=?",
            (user_id,)
        )
    db.commit()

# ─── Super Admin monitoring ──────────────────

def get_security_summary():
    from db_adapter import get_db
    db = get_db()
    now = datetime.now()
    today = now.strftime("%Y-%m-%d")
    result = {}
    try:
        result["total_users"] = db.execute("SELECT COUNT(*) as c FROM users").fetchone()["c"]
        result["active_today"] = db.execute(
            "SELECT COUNT(DISTINCT user_id) as c FROM audit_log WHERE date(timestamp)=?", (today,)
        ).fetchone()["c"]
        result["failed_logins_24h"] = db.execute(
            """SELECT COUNT(*) as c FROM audit_log
               WHERE action='login_failed' AND timestamp > datetime('now','-1 day')"""
        ).fetchone()["c"]
        result["mfa_enabled"] = db.execute(
            "SELECT COUNT(*) as c FROM users WHERE mfa_secret IS NOT NULL AND mfa_secret != ''"
        ).fetchone()["c"]
        result["blocked_ips"] = len([k for k in RATE_LIMIT_STORE if "blocked" in k])
        _is_pg = bool(os.environ.get("DATABASE_URL"))
        _exp_cond = "CAST(expires_at AS timestamp) > NOW()" if _is_pg else "expires_at>datetime('now','localtime')"
        result["active_refresh_tokens"] = db.execute(
            f"SELECT COUNT(*) as c FROM refresh_tokens WHERE revoked=0 AND {_exp_cond}"
        ).fetchone()["c"]
        result["recent_audit"] = rows_to_list(db.execute(
            "SELECT * FROM audit_log ORDER BY id DESC LIMIT 20"
        ).fetchall())
    except Exception:
        pass
    return result

# ─── IP Blocking ─────────────────────────────

IP_BLOCKLIST = set()

def block_ip(ip, duration_hours=24):
    expires = time.time() + (duration_hours * 3600)
    IP_BLOCKLIST.add(ip)
    RATE_LIMIT_STORE[f"blocked:{ip}"] = expires

def is_ip_blocked(ip):
    entry = RATE_LIMIT_STORE.get(f"blocked:{ip}")
    if entry:
        if time.time() < entry:
            return True
        del RATE_LIMIT_STORE[f"blocked:{ip}"]
    return False

def check_blocklist():
    now = time.time()
    expired = [k for k, v in RATE_LIMIT_STORE.items() if k.startswith("blocked:") and now >= v]
    for k in expired:
        del RATE_LIMIT_STORE[k]

def require_not_blocked(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        ip = get_client_ip()
        if is_ip_blocked(ip):
            return jsonify({"error": "IP temporariamente bloqueado por atividade suspeita"}), 403
        return f(*args, **kwargs)
    return wrapper

# ─── Monitoring scan (detect attacks) ────────

SUSPICIOUS_PATTERNS = [
    (r"(%27|%22|%3C|%3E|%3D|%00|select\s+.*\s+from|union\s+.*\s+select|insert\s+into|drop\s+table|exec\s+|xp_cmdshell|sp_executesql)", "SQL Injection"),
    (r"(<script|javascript:|onerror=|onload=|onclick=|\balert\s*\()", "XSS"),
    (r"(\.\./|\.\.\\|%2e%2e%2f|%2e%2e%5c)", "Path Traversal"),
    (r"(\b0x[0-9a-fA-F]+\b|char\s*\(|convert\s*\(|cast\s*\()", "SQL Injection"),
    (r"(/etc/passwd|/etc/shadow|c:\\windows|boot\.ini)", "Path Traversal"),
    (r"(cmd=|exec=|system\(|passthru\(|shell_exec\()", "Command Injection"),
    (r"(--\s|#\s|\bOR\b.*=.*\bOR\b|\bAND\b.*=.*\bAND\b)", "SQL Injection"),
]

def scan_request_for_attacks():
    ip = get_client_ip()
    data_to_scan = ""
    data_to_scan += request.path + " "
    data_to_scan += json.dumps(request.args.to_dict()) + " "
    if request.data:
        try:
            data_to_scan += request.get_json() and json.dumps(request.get_json()) or ""
        except Exception:
            data_to_scan += str(request.data)
    for pattern, attack_type in SUSPICIOUS_PATTERNS:
        if re.search(pattern, data_to_scan, re.IGNORECASE):
            from db_adapter import get_db
            db = get_db()
            db.execute(
                """INSERT INTO security_events
                   (ip_address, event_type, detail, path, user_agent, blocked, timestamp)
                   VALUES (?,?,?,?,?,1,datetime('now','localtime'))""",
                (ip, attack_type, data_to_scan[:500], request.path,
                 request.headers.get("User-Agent", "")[:200])
            )
            db.commit()
            block_ip(ip, 1)
            return True
    return False

def security_monitor_scan():
    check_blocklist()
    from db_adapter import get_db
    db = get_db()
    db.execute("""
        CREATE TABLE IF NOT EXISTS security_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ip_address TEXT,
            event_type TEXT,
            detail TEXT,
            path TEXT,
            user_agent TEXT,
            blocked INTEGER DEFAULT 0,
            timestamp TEXT DEFAULT (datetime('now','localtime'))
        )
    """)
    db.commit()

# ─── Utility ─────────────────────────────────

def rows_to_list(rows):
    return [dict(r) for r in rows]

# ─── Export all ──────────────────────────────

__all__ = [
    "ROLES", "ACL_MODULES", "PERMISSION_HIERARCHY",
    "has_permission", "get_role_permissions",
    "require_role", "require_permission", "require_mfa",
    "audit_log",
    "generate_mfa_secret", "generate_mfa_qrcode_base64",
    "verify_mfa_code", "generate_recovery_codes",
    "sanitize_html", "sanitize_input", "sanitize_request_data",
    "apply_security_headers", "SECURITY_HEADERS",
    "generate_csrf_token", "require_csrf",
    "rate_limit_advanced", "check_rate_limit",
    "validate_sql_identifier", "sanitize_order_by",
    "invalidate_other_sessions",
    "get_security_summary",
    "block_ip", "is_ip_blocked", "require_not_blocked",
    "scan_request_for_attacks", "security_monitor_scan",
    "IP_BLOCKLIST", "RATE_LIMIT_STORE",
]
