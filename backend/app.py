import json, os, sys, time, re, hashlib, hmac, threading, smtplib, random, string
from datetime import datetime, timedelta, date, timezone
from decimal import Decimal
from pathlib import Path
from functools import wraps
from uuid import uuid4
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import urllib.request, urllib.parse, urllib.error
import bcrypt
import jwt
import html
import base64
import pyotp

BASE_DIR = Path(__file__).parent.parent
BACKEND_DIR = Path(__file__).parent
sys.path.insert(0, str(BACKEND_DIR))

from security_module import (
    ROLES, ACL_MODULES, has_permission, get_role_permissions,
    require_role, require_permission, require_mfa, audit_log,
    generate_mfa_secret, generate_mfa_qrcode_base64, verify_mfa_code,
    generate_recovery_codes, sanitize_html, sanitize_input,
    sanitize_request_data, apply_security_headers,
    generate_csrf_token, require_csrf,
    rate_limit_advanced, check_rate_limit, get_client_ip,
    invalidate_other_sessions, get_security_summary,
    scan_request_for_attacks, security_monitor_scan,
    require_not_blocked, SECURITY_HEADERS,
)

PYLIB = BASE_DIR / "pylib"
if PYLIB.exists():
    sys.path.insert(0, str(PYLIB))

from flask import Flask, jsonify, request, send_from_directory, send_file, g, Response
from flask.json.provider import DefaultJSONProvider
from fpdf import FPDF
from db_adapter import get_db, close_db, row_to_dict, rows_to_list, Database, _Row

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "promake-secret-change-in-production")
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"

class CustomJSONProvider(DefaultJSONProvider):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        if isinstance(obj, (bytes, bytearray)):
            return obj.decode("utf-8", errors="replace")
        return super().default(obj)
app.json = CustomJSONProvider(app)

@app.errorhandler(500)
def _handle_500(e):
    return jsonify({"error": "Erro interno do servidor"}), 500

@app.route("/api/deploy-info")
def api_deploy_info():
    return jsonify({"commit": os.environ.get("RENDER_GIT_COMMIT", "dev")})

JWT_SECRET = os.environ.get("JWT_SECRET", "promake-jwt-secret-change-in-production")
JWT_ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRES_MINUTES = 15
REFRESH_TOKEN_EXPIRES_DAYS = 30

_RATE_LIMIT = {}
_RATE_LIMIT_WINDOW = 60
_RATE_LIMIT_MAX = 60

def rate_limit(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        ip = request.headers.get("X-Forwarded-For", request.remote_addr or "0.0.0.0")
        now = time.time()
        window = int(now / _RATE_LIMIT_WINDOW)
        key = f"{ip}:{window}"
        count = _RATE_LIMIT.get(key, 0) + 1
        _RATE_LIMIT[key] = count
        if count > _RATE_LIMIT_MAX:
            return jsonify({"error": "Muitas requisicoes. Tente novamente em breve."}), 429
        return f(*args, **kwargs)
    return wrapper

HOLIDAYS = {
    "01-01": {"title":"Ano Novo","type":"holiday","desc":"Confraternização Universal"},
    "02-14": {"title":"Dia dos Namorados","type":"seasonal","desc":"Valentine's Day"},
    "03-20": {"title":"Início do Outono","type":"seasonal","desc":"Equinócio de Outono"},
    "04-21": {"title":"Tiradentes","type":"holiday","desc":"Feriado Nacional"},
    "05-01": {"title":"Dia do Trabalho","type":"holiday","desc":"Feriado Nacional"},
    "06-12": {"title":"Dia dos Namorados BR","type":"seasonal","desc":"Dia dos Namorados brasileiro"},
    "06-21": {"title":"Início do Inverno","type":"seasonal","desc":"Solstício de Inverno"},
    "09-07": {"title":"Independência do Brasil","type":"holiday","desc":"Feriado Nacional"},
    "09-22": {"title":"Início da Primavera","type":"seasonal","desc":"Equinócio de Primavera"},
    "10-12": {"title":"Nossa Senhora Aparecida","type":"holiday","desc":"Feriado Nacional - Padroeira do Brasil"},
    "10-15": {"title":"Dia do Professor","type":"seasonal","desc":"Homenagem aos professores"},
    "10-31": {"title":"Halloween","type":"seasonal","desc":"Dia das Bruxas"},
    "11-02": {"title":"Finados","type":"holiday","desc":"Feriado Nacional"},
    "11-15": {"title":"Proclamação da República","type":"holiday","desc":"Feriado Nacional"},
    "12-21": {"title":"Início do Verão","type":"seasonal","desc":"Solstício de Verão"},
    "12-24": {"title":"Véspera de Natal","type":"seasonal","desc":"Celebração de Natal"},
    "12-25": {"title":"Natal","type":"holiday","desc":"Feriado Nacional - Natal"},
    "12-31": {"title":"Réveillon","type":"seasonal","desc":"Virada de Ano"}
}

@app.before_request
def before_security_check():
    if request.method == "OPTIONS":
        return
    if request.path.startswith("/api/") and not request.path.startswith("/api/auth/login"):
        if scan_request_for_attacks():
            return jsonify({"error": "Atividade suspeita detectada"}), 403

@app.after_request
def add_cors(resp):
    origin = request.headers.get("Origin", "")
    allowed = {"http://localhost:8081", "http://127.0.0.1:8081", "https://crm.promakeart.com", "http://localhost:3000"}
    if origin in allowed or not os.environ.get("DATABASE_URL"):
        resp.headers["Access-Control-Allow-Origin"] = origin
    elif os.environ.get("DATABASE_URL"):
        resp.headers["Access-Control-Allow-Origin"] = "https://crm.promakeart.com"
    else:
        resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type,Authorization,X-CSRF-Token,X-MFA-Token"
    resp.headers["Access-Control-Allow-Methods"] = "GET,POST,PUT,DELETE,OPTIONS,PATCH"
    resp.headers["Access-Control-Expose-Headers"] = "X-RateLimit-Limit,X-RateLimit-Reset,Retry-After"
    resp.headers.pop("Server", None)
    resp.headers.pop("X-Render-Origin-Server", None)
    apply_security_headers(resp)
    return resp

CONFIG_PATH = BASE_DIR / "backend" / "config.json"

WEATHER_CACHE = {"data": None, "time": 0}
NOTIFICATION_QUEUE = []

# ─── Database ─────────────────────────────────────────

app.teardown_appcontext(close_db)

def init_db():
    db = Database()
    db.executescript("""
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'admin',
        avatar TEXT DEFAULT '',
        phone TEXT DEFAULT '',
        active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT DEFAULT '',
        company TEXT DEFAULT '',
        status TEXT DEFAULT 'active',
        notes TEXT DEFAULT '',
        tags TEXT DEFAULT '',
        created_by INTEGER REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        client_id INTEGER REFERENCES clients(id),
        type TEXT DEFAULT 'Social Media',
        status TEXT DEFAULT 'pending',
        kanban_order INTEGER DEFAULT 0,
        deadline TEXT,
        value REAL DEFAULT 0,
        description TEXT DEFAULT '',
        created_by INTEGER REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS service_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER REFERENCES projects(id),
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        status TEXT DEFAULT 'pending',
        priority TEXT DEFAULT 'media',
        assigned_to INTEGER REFERENCES users(id),
        deadline TEXT,
        estimated_hours REAL DEFAULT 0,
        created_by INTEGER REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service_order_id INTEGER REFERENCES service_orders(id),
        title TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        assigned_to INTEGER REFERENCES users(id),
        deadline TEXT,
        order_idx INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS leads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT,
        phone TEXT DEFAULT '',
        company TEXT DEFAULT '',
        source TEXT DEFAULT 'website',
        status TEXT DEFAULT 'novo',
        value REAL DEFAULT 0,
        notes TEXT DEFAULT '',
        assigned_to INTEGER REFERENCES users(id),
        converted_client_id INTEGER REFERENCES clients(id),
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS contracts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER REFERENCES clients(id),
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        value REAL DEFAULT 0,
        start_date TEXT,
        end_date TEXT,
        renewal_type TEXT DEFAULT 'monthly',
        status TEXT DEFAULT 'active',
        file_url TEXT DEFAULT '',
        created_by INTEGER REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        description TEXT NOT NULL,
        type TEXT NOT NULL,
        category TEXT DEFAULT 'Outros',
        value REAL DEFAULT 0,
        date TEXT,
        client_id INTEGER REFERENCES clients(id),
        project_id INTEGER REFERENCES projects(id),
        contract_id INTEGER REFERENCES contracts(id),
        payment_method TEXT DEFAULT '',
        status TEXT DEFAULT 'pending',
        created_by INTEGER REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS commissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id),
        project_id INTEGER REFERENCES projects(id),
        transaction_id INTEGER REFERENCES transactions(id),
        value REAL DEFAULT 0,
        percentage REAL DEFAULT 0,
        status TEXT DEFAULT 'pending',
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id),
        type TEXT DEFAULT 'info',
        title TEXT NOT NULL,
        message TEXT DEFAULT '',
        read INTEGER DEFAULT 0,
        link TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS calendar_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        date TEXT NOT NULL,
        time TEXT DEFAULT '',
        type TEXT DEFAULT 'evento',
        related_type TEXT DEFAULT '',
        related_id INTEGER DEFAULT 0,
        created_by INTEGER REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS project_status_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER REFERENCES projects(id),
        from_status TEXT,
        to_status TEXT,
        changed_by INTEGER REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS visit_counter (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT UNIQUE NOT NULL,
        count INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        user_name TEXT,
        action TEXT,
        entity_type TEXT,
        entity_id INTEGER,
        description TEXT,
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS user_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        filename TEXT,
        original_name TEXT,
        size INTEGER,
        entity_type TEXT,
        entity_id INTEGER,
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS whatsapp_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS systems (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER REFERENCES clients(id),
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        primary_color TEXT DEFAULT '#6C5CE7',
        logo_url TEXT DEFAULT '',
        portal_password_hash TEXT NOT NULL,
        admin_password_hash TEXT DEFAULT '',
        active INTEGER DEFAULT 1,
        created_by INTEGER REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS system_modules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        system_id INTEGER REFERENCES systems(id),
        module_key TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        UNIQUE(system_id, module_key)
    );
    CREATE TABLE IF NOT EXISTS whatsapp_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        to_phone TEXT,
        message TEXT,
        template_id INTEGER,
        entity_type TEXT,
        entity_id INTEGER,
        status TEXT DEFAULT 'sent',
        response TEXT,
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        price REAL DEFAULT 0,
        billing_cycle TEXT DEFAULT 'monthly',
        features TEXT DEFAULT '[]',
        active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS client_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER REFERENCES clients(id),
        plan_id INTEGER REFERENCES plans(id),
        status TEXT DEFAULT 'active',
        price_override REAL,
        start_date TEXT,
        end_date TEXT,
        auto_renew INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS permissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER UNIQUE REFERENCES users(id),
        permissions TEXT DEFAULT '{}',
        updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS developments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        address TEXT DEFAULT '',
        builder TEXT DEFAULT '',
        status TEXT DEFAULT 'lançamento',
        total_units INTEGER DEFAULT 0,
        delivery_date TEXT,
        image_url TEXT DEFAULT '',
        created_by INTEGER REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS units (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        development_id INTEGER REFERENCES developments(id) NOT NULL,
        tower TEXT DEFAULT '',
        block TEXT DEFAULT '',
        floor TEXT DEFAULT '',
        number TEXT NOT NULL,
        area REAL DEFAULT 0,
        bedrooms INTEGER DEFAULT 0,
        suites INTEGER DEFAULT 0,
        bathrooms INTEGER DEFAULT 0,
        parking_spots INTEGER DEFAULT 0,
        price REAL DEFAULT 0,
        status TEXT DEFAULT 'disponivel',
        notes TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS broker_developments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id) NOT NULL,
        development_id INTEGER REFERENCES developments(id) NOT NULL,
        commission_pct REAL DEFAULT 3.0,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(user_id, development_id)
    );
    CREATE TABLE IF NOT EXISTS slides (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        image_url TEXT DEFAULT '',
        title TEXT DEFAULT '',
        subtitle TEXT DEFAULT '',
        badge_text TEXT DEFAULT '',
        badge_icon TEXT DEFAULT 'fas fa-crown',
        link_text TEXT DEFAULT 'Acessar Agora',
        link_url TEXT DEFAULT '',
        btn2_text TEXT DEFAULT '',
        btn2_url TEXT DEFAULT '',
        sort_order INTEGER DEFAULT 0,
        active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS landing_config (
        section TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT DEFAULT '',
        PRIMARY KEY (section, key)
    );
    CREATE TABLE IF NOT EXISTS youtube_playlist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id TEXT NOT NULL,
        title TEXT DEFAULT '',
        channel TEXT DEFAULT '',
        duration TEXT DEFAULT '',
        thumbnail TEXT DEFAULT '',
        added_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS design_projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        client_name TEXT DEFAULT '',
        deadline TEXT,
        status TEXT DEFAULT 'active',
        created_by INTEGER REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS design_cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER REFERENCES design_projects(id),
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        stage TEXT DEFAULT 'briefing',
        color_tag TEXT DEFAULT '',
        deadline TEXT,
        assigned_to TEXT DEFAULT '',
        order_idx INTEGER DEFAULT 0,
        created_by INTEGER REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS design_stages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER REFERENCES design_projects(id),
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        color TEXT DEFAULT '#6C5CE7',
        locked INTEGER DEFAULT 0,
        order_idx INTEGER DEFAULT 0,
        created_by INTEGER REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS design_timeline_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER REFERENCES design_projects(id),
        stage_id INTEGER REFERENCES design_stages(id),
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        status TEXT DEFAULT 'pendente',
        color_tag TEXT DEFAULT '',
        assigned_to TEXT DEFAULT '',
        url TEXT DEFAULT '',
        order_idx INTEGER DEFAULT 0,
        created_by INTEGER REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS design_stage_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER REFERENCES design_projects(id),
        from_stage_id INTEGER REFERENCES design_stages(id),
        to_stage_id INTEGER REFERENCES design_stages(id),
        created_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(from_stage_id, to_stage_id)
    );
    CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL DEFAULT 'Sem titulo',
        content TEXT DEFAULT '',
        color TEXT DEFAULT '#FFF8DC',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS design_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER REFERENCES design_projects(id),
        title TEXT NOT NULL DEFAULT 'Sem titulo',
        content TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS festefe_tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        status TEXT DEFAULT 'aberto',
        priority TEXT DEFAULT 'media',
        category TEXT DEFAULT '',
        client_name TEXT DEFAULT '',
        assigned_to INTEGER REFERENCES users(id),
        created_by INTEGER REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS festefe_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER REFERENCES festefe_tickets(id),
        user_id INTEGER REFERENCES users(id),
        message TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS password_resets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id),
        token TEXT UNIQUE NOT NULL,
        expires_at TEXT NOT NULL,
        used INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS email_verifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        code TEXT NOT NULL,
        type TEXT DEFAULT 'signup',
        expires_at TEXT NOT NULL,
        used INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS refresh_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id),
        token TEXT UNIQUE NOT NULL,
        expires_at TEXT NOT NULL,
        revoked INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        user_name TEXT,
        user_role TEXT,
        action TEXT NOT NULL,
        entity_type TEXT,
        entity_id TEXT,
        description TEXT,
        details TEXT,
        ip_address TEXT,
        user_agent TEXT,
        timestamp TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS security_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip_address TEXT,
        event_type TEXT,
        detail TEXT,
        path TEXT,
        user_agent TEXT,
        blocked INTEGER DEFAULT 0,
        timestamp TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS user_backup_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id),
        code TEXT NOT NULL,
        used INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    """)
    # Migration: add MFA columns to users
    for col in ["mfa_secret TEXT DEFAULT ''", "mfa_enabled INTEGER DEFAULT 0", "mfa_recovery TEXT DEFAULT ''"]:
        try:
            if db.is_postgres:
                db.execute(f"ALTER TABLE users ADD COLUMN IF NOT EXISTS {col}")
            else:
                db.execute(f"ALTER TABLE users ADD COLUMN {col}")
        except:
            pass
    # Migration: add locked/x/y columns to design_stages if missing
    for col in ["locked INTEGER DEFAULT 0", "x REAL DEFAULT 0", "y REAL DEFAULT 0"]:
        try:
            db.execute(f"ALTER TABLE design_stages ADD COLUMN {col}")
        except:
            pass
    # Migration: add floating/float_x/float_y to design_timeline_items
    for col in ["floating INTEGER DEFAULT 0", "float_x REAL DEFAULT 0", "float_y REAL DEFAULT 0"]:
        try:
            db.execute(f"ALTER TABLE design_timeline_items ADD COLUMN {col}")
        except:
            pass
    # Migration: add width to design_stages and design_timeline_items
    for col in ["width INTEGER DEFAULT 260"]:
        try:
            db.execute(f"ALTER TABLE design_stages ADD COLUMN {col}")
        except:
            pass
    for col in ["width INTEGER DEFAULT 230"]:
        try:
            db.execute(f"ALTER TABLE design_timeline_items ADD COLUMN {col}")
        except:
            pass
    try:
        db.execute("UPDATE design_stages SET x = (COALESCE(order_idx,0) + 1) * 300 WHERE x = 0 AND y = 0 AND order_idx > 0")
    except:
        pass
    # Seed landing page defaults
    default_config = {
        'hero': [
            ('badge','Ecossistema Completo de Gestão'),
            ('badge_icon','fas fa-crown'),
            ('title','Gestão Inteligente para Agências Digitais, Negócios e Empresas'),
            ('subtitle','CRM, Projetos, Kanban, Financeiro, Relatórios, Marketing Digital e muito mais em um só lugar. O ecossistema definitivo para sua agência ou empresa crescer.'),
            ('btn1_text','Acessar Agora'),
            ('btn2_text','Conhecer Módulos'),
        ],
        'stats': [
            ('1_num','100%'), ('1_label','Gratuito'),
            ('2_num','15+'), ('2_label','Módulos'),
            ('3_num','100 GB'), ('3_label','Banda Grátis'),
            ('4_num','Open Source'), ('4_label','Código Aberto'),
        ],
        'features': [
            ('title','Tudo que sua agência ou empresa precisa'),
            ('subtitle','Módulos integrados para gerenciar leads, projetos, equipe, finanças e operações em um único ecossistema.'),
        ],
        'plans': [
            ('title','Planos de Serviço'),
            ('subtitle','Soluções completas para gestão de marketing digital, vendas e operações da sua empresa.'),
        ],
        'cta': [
            ('title','Pronto para transformar sua gestão?'),
            ('subtitle','Junte-se a centenas de agências e empresas que já utilizam o Promake Ecosystem.'),
            ('btn_text','Começar Agora'),
        ],
        'footer': [
            ('text','Gestão para Agências Digitais, Negócios e Empresas'),
        ],
    }
    for section, pairs in default_config.items():
        for key, value in pairs:
            try:
                db.execute(
                    "INSERT OR IGNORE INTO landing_config (section,key,value) VALUES (?,?,?)",
                    (section, key, value)
                )
            except:
                pass
    db.commit()
    # Seed users if not exists
    _seed_users = [
        ("Administrador","admin@promake.com","admin123","admin"),
        ("Maria Silva","maria@promake.com","maria123","manager"),
        ("Joao Designer","joao@promake.com","joao123","designer"),
    ]
    for name, email, pw, role in _seed_users:
        if not db.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone():
            try:
                db.execute("INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)",
                           (name, email, hash_password(pw), role))
            except:
                pass
    db.commit()
    # Seed sample data if empty
    if not db.execute("SELECT id FROM clients").fetchone():
        db.executescript("""
        INSERT INTO clients (name,email,phone,company,status) VALUES ('Tech Solutions','contato@techsolutions.com','(11) 99999-0001','Tech Solutions Ltda','active');
        INSERT INTO clients (name,email,phone,company,status) VALUES ('Corp Ltda','contato@corp.com','(11) 99999-0002','Corp Ltda','active');
        INSERT INTO clients (name,email,phone,company,status) VALUES ('Negocios SA','contato@negocios.com','(11) 99999-0003','Negocios SA','active');
        INSERT INTO clients (name,email,phone,company,status) VALUES ('Digital Agency','contato@digital.com','(11) 99999-0004','Digital Agency','active');
        """)
        db.executescript("""
        INSERT INTO projects (name,client_id,type,status,deadline,value) VALUES ('Campanha Digital 2026',1,'Social Media','active','2026-06-30',4500);
        INSERT INTO projects (name,client_id,type,status,deadline,value) VALUES ('Site Corporativo',2,'Desenvolvimento Web','active','2026-07-15',12000);
        INSERT INTO projects (name,client_id,type,status,deadline,value) VALUES ('Identidade Visual',3,'Design Grafico','completed','2026-04-01',3200);
        INSERT INTO projects (name,client_id,type,status,deadline,value) VALUES ('Trafego Ads',3,'Trafego Pago','active','2026-08-01',2800);
        INSERT INTO projects (name,client_id,type,status,deadline,value) VALUES ('Conteudo Redes',1,'Marketing de Conteudo','pending','2026-09-01',1900);
        """)
        db.executescript("""
        INSERT INTO transactions (description,type,category,value,date,status) VALUES ('Mensalidade Tech Solutions','income','Mensalidade',4500,'2026-05-01','completed');
        INSERT INTO transactions (description,type,category,value,date,status) VALUES ('Hospedagem Sites','expense','Ferramentas',350,'2026-05-02','completed');
        INSERT INTO transactions (description,type,category,value,date,status) VALUES ('Projeto Negocios SA','income','Projeto',3200,'2026-05-05','completed');
        INSERT INTO transactions (description,type,category,value,date,status) VALUES ('Anuncios Google Ads','expense','Anuncios',1200,'2026-05-07','completed');
        INSERT INTO transactions (description,type,category,value,date,status) VALUES ('Mensalidade Corp Ltda','income','Mensalidade',12000,'2026-05-15','completed');
        INSERT INTO transactions (description,type,category,value,date,status) VALUES ('Freelancer Designer','expense','Freelancer',1500,'2026-05-12','completed');
        """)
        db.executescript("""
        INSERT INTO leads (name,email,phone,company,source,status,value) VALUES ('Carlos Oliveira','carlos@email.com','(11) 98888-0001','Oliveira Corp','indicacao','novo',5000);
        INSERT INTO leads (name,email,phone,company,source,status,value) VALUES ('Ana Santos','ana@email.com','(11) 98888-0002','Santos Ltda','site','contato',8000);
        INSERT INTO leads (name,email,phone,company,source,status,value) VALUES ('Pedro Lima','pedro@email.com','(11) 98888-0003','Lima Associados','instagram','proposta',12000);
        INSERT INTO leads (name,email,phone,company,source,status,value) VALUES ('Lucia Mendes','lucia@email.com','(11) 98888-0004','Mendes Corp','google','qualificado',3000);
        """)
        db.executescript("""
        INSERT INTO contracts (client_id,title,value,start_date,end_date,renewal_type,status) VALUES (1,'Mensalidade Social Media',4500,'2026-01-01','2026-12-31','monthly','active');
        INSERT INTO contracts (client_id,title,value,start_date,end_date,renewal_type,status) VALUES (2,'Manutencao Site',2000,'2026-03-01','2026-12-31','monthly','active');
        """)
        db.executescript("""
        INSERT INTO calendar_events (title,description,date,time,type) VALUES ('Reuniao Tech Solutions','Alinhamento de campanha','2026-05-20','14:00','reuniao');
        INSERT INTO calendar_events (title,description,date,time,type) VALUES ('Entrega Site Corporativo','Prazo final site','2026-05-25','18:00','prazo');
        INSERT INTO calendar_events (title,description,date,time,type) VALUES ('Reuniao Novo Cliente','Apresentacao proposta','2026-05-22','10:00','reuniao');
        """)
        db.executescript("""
        INSERT INTO service_orders (project_id,title,description,status,priority,deadline,estimated_hours) VALUES (1,'Criar Artes Semana 1','Criar 5 artes para feed','active','alta','2026-05-18',8);
        INSERT INTO service_orders (project_id,title,description,status,priority,deadline,estimated_hours) VALUES (1,'Relatorio Mensal','Gerar relatorio de metricas','pending','media','2026-05-25',4);
        INSERT INTO service_orders (project_id,title,description,status,priority,deadline,estimated_hours) VALUES (2,'Desenvolver Homepage','Criar homepage responsiva','active','alta','2026-06-01',40);
        """)
        db.executescript("""
        INSERT INTO tasks (service_order_id,title,status,deadline,order_idx) VALUES (1,'Pesquisa de referencias','completed','2026-05-12',1);
        INSERT INTO tasks (service_order_id,title,status,deadline,order_idx) VALUES (1,'Criar rascunhos','active','2026-05-15',2);
        INSERT INTO tasks (service_order_id,title,status,deadline,order_idx) VALUES (1,'Aprovacao cliente','pending','2026-05-18',3);
        """)
    # Seed design projects if empty (only SQLite path, PG uses separate endpoint)
    if not db.is_postgres:
        try:
            if not db.execute("SELECT id FROM design_projects").fetchone():
                db.execute("INSERT INTO design_projects (name,description,client_name,deadline,created_by) VALUES (?,?,?,?,?)",
                    ("Campanha Redes Sociais - Tech Solutions","Criacao de artes para campanha de midia social - 15 pecas para feed e stories","Tech Solutions","2026-07-15",1))
                dp1 = db.last_insert_rowid
                db.execute("INSERT INTO design_projects (name,description,client_name,deadline,created_by) VALUES (?,?,?,?,?)",
                    ("Identidade Visual Corp Ltda","Desenvolvimento de identidade visual completa: logo, tipografia, paleta de cores e aplicacoes","Corp Ltda","2026-08-01",3))
                dp2 = db.last_insert_rowid
                db.execute("INSERT INTO design_projects (name,description,client_name,deadline,created_by) VALUES (?,?,?,?,?)",
                    ("Material Grafico - Negocios SA","Folder institucional, catalogo de produtos e apresentacao comercial","Negocios SA","2026-07-30",3))
                dp3 = db.last_insert_rowid
                db.commit()
                for pid in [dp1, dp2, dp3]:
                    for idx, (t, c) in enumerate([("Briefing","#6C5CE7"),("Criacao","#00B0FF"),("Revisao","#FFD600"),("Aprovacao","#FF9800"),("Finalizado","#00C853")]):
                        db.execute("INSERT INTO design_stages (project_id,title,description,color,order_idx,created_by) VALUES (?,?,?,?,?,?)",
                            (pid,t,"",c,idx,1))
                db.commit()
                for card in [
                    (dp1,"Posts Instagram - Semana 1","5 posts para feed sobre lancamento","criacao","#E91E63","2026-06-25","Joao Designer",0,3),
                    (dp1,"Stories diarios","15 stories para a semana de lancamento","criacao","#9C27B0","2026-06-26","Joao Designer",1,3),
                    (dp1,"Revisar artes com cliente","Apresentar para aprovacao do cliente","revisao","#FF9800","2026-06-28","Maria Silva",0,1),
                    (dp1,"Ajustes finais","Corrigir feedback do cliente","aprovacao","#F44336","2026-06-30","Joao Designer",0,3),
                    (dp1,"Briefing inicial","Reuniao com cliente para alinhamento","briefing","#4CAF50","2026-06-20","Maria Silva",0,1),
                ]:
                    db.execute("INSERT INTO design_cards (project_id,title,description,stage,color_tag,deadline,assigned_to,order_idx,created_by) VALUES (?,?,?,?,?,?,?,?,?)", card)
                db.commit()
        except Exception:
            pass
    # Seed plans if empty
    if not db.execute("SELECT id FROM plans").fetchone():
        db.executescript("""
        INSERT INTO plans (name,description,price,billing_cycle,features) VALUES ('Basico','Gestao de redes sociais com 8 posts/mes, relatorio mensal e suporte por WhatsApp.',1490,'monthly','["8 posts por mes","Relatorio mensal de metricas","Suporte via WhatsApp","Agendamento de conteudo"]');
        INSERT INTO plans (name,description,price,billing_cycle,features) VALUES ('Profissional','Redes sociais + trafego pago (R$500 de anuncios), 12 posts/mes, relatorio e suporte prioritario.',2990,'monthly','["12 posts por mes","R$500 em anuncios incluido","Relatorio analitico completo","Suporte prioritario","Gestao de trafego pago"]');
        INSERT INTO plans (name,description,price,billing_cycle,features) VALUES ('Enterprise','Pacote completo: social media, trafego, design, site e consultoria estrategica mensal.',5990,'monthly','["Posts ilimitados","R$1500 em anuncios","Criacao de conteudo","Site institucional","Consultoria estrategica","Suporte 24/7 dedicado"]');
        """)
        db.executescript("""
        INSERT INTO client_plans (client_id,plan_id,status,start_date,auto_renew) VALUES (1,2,'active','2026-01-01',1);
        INSERT INTO client_plans (client_id,plan_id,status,start_date,auto_renew) VALUES (2,1,'active','2026-03-01',1);
        INSERT INTO client_plans (client_id,plan_id,status,start_date,auto_renew) VALUES (3,3,'active','2026-04-01',1);
        """)
    db.commit()
    db.close()

# ─── Helpers ────────────────────────────────

def hash_password(pw):
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()

def check_password(password, password_hash):
    if password_hash.startswith("$2"):
        return bcrypt.checkpw(password.encode(), password_hash.encode())
    return hashlib.sha256(password.encode()).hexdigest() == password_hash

def create_access_token(user_id, user_role):
    payload = {
        "sub": str(user_id),
        "role": user_role,
        "iat": datetime.now(tz=timezone.utc),
        "exp": datetime.now(tz=timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRES_MINUTES),
        "type": "access"
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)

def create_refresh_token(user_id):
    token = uuid4().hex
    expires_at = (datetime.now() + timedelta(days=REFRESH_TOKEN_EXPIRES_DAYS)).strftime("%Y-%m-%d %H:%M:%S")
    db = get_db()
    db.execute(
        "INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?,?,?)",
        (user_id, token, expires_at)
    )
    db.commit()
    return token

def verify_access_token(token):
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except (jwt.ExpiredSignatureError, jwt.InvalidTokenError):
        return None

def generate_token():
    return uuid4().hex

def generate_code():
    return ''.join(random.choices(string.digits, k=6))

def send_email(to_email, subject, body_html):
    config = load_config()
    smtp = config.get("smtp", {})
    if not smtp.get("host") or not smtp.get("user") or not smtp.get("password"):
        return False
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = smtp.get("from_email", smtp["user"])
    msg["To"] = to_email
    msg.attach(MIMEText(body_html, "html"))
    try:
        server = smtplib.SMTP(smtp["host"], int(smtp.get("port", 587)))
        server.starttls()
        server.login(smtp["user"], smtp["password"])
        server.sendmail(msg["From"], [to_email], msg.as_string())
        server.quit()
        return True
    except Exception as e:
        print(f"Email error: {e}")
        return False

def row_to_dict(row):
    if row is None: return None
    return dict(row)

def rows_to_list(rows):
    return [dict(r) for r in rows]

def load_config():
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except:
        return {}

def get_setting(*keys, default=None):
    d = load_config()
    for k in keys:
        if isinstance(d, dict):
            d = d.get(k)
        else:
            return default
    return d if d is not None else default

def require_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        auth = request.headers.get("Authorization", "")
        token = auth.replace("Bearer ","")
        if not token:
            return jsonify({"error": "Nao autorizado"}), 401
        payload = verify_access_token(token)
        if not payload:
            return jsonify({"error": "Token invalido ou expirado"}), 401
        db = get_db()
        user = db.execute(
            "SELECT * FROM users WHERE id=? AND active=1",
            (int(payload["sub"]),)
        ).fetchone()
        if not user:
            return jsonify({"error": "Nao autorizado"}), 401
        g.current_user = dict(user)
        return f(*args, **kwargs)
    return decorated

def get_current_user():
    return getattr(g, 'current_user', None)

def log_activity(action, entity_type, entity_id, description=""):
    user = get_current_user()
    db = get_db()
    db.execute(
        "INSERT INTO activity_log (user_id, user_name, action, entity_type, entity_id, description) VALUES (?,?,?,?,?,?)",
        (user["id"] if user else None, user["name"] if user else "Sistema",
         action, entity_type, entity_id, description)
    )
    db.commit()

def create_notification(type, title, message="", link="", target_user_id=None):
    db = get_db()
    if target_user_id:
        db.execute(
            "INSERT INTO notifications (user_id,type,title,message,link) VALUES (?,?,?,?,?)",
            (target_user_id, type, title, message, link)
        )
    else:
        admins = db.execute("SELECT id FROM users WHERE active=1 AND role IN ('admin','manager')").fetchall()
        for a in admins:
            db.execute(
                "INSERT INTO notifications (user_id,type,title,message,link) VALUES (?,?,?,?,?)",
                (a["id"], type, title, message, link)
            )
    db.commit()

def parse_date(d):
    if not d: return None
    return datetime.strptime(d, "%Y-%m-%d")

def today_str():
    return date.today().isoformat()

# ─── Health Check (Render) ────────────────────

@app.route("/api/health")
@rate_limit
def api_health():
    return jsonify({"status": "ok"})

@app.route("/health")
@rate_limit
def health():
    return jsonify({"status": "ok"})

# ─── Config Routes ────────────────────────────

@app.route("/api/config")
@require_auth
def api_get_config():
    return jsonify(load_config())

@app.route("/api/config", methods=["POST"])
@require_auth
def api_save_config():
    data = request.get_json() or {}
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    log_activity("update", "config", 0, "Configuracoes atualizadas")
    return jsonify({"ok": True})

# ─── Auth Routes ─────────────────────────────

@app.route("/api/auth/login", methods=["POST"])
@rate_limit
@rate_limit_advanced(limit=10, per=60, key="login")
def api_login():
    data = request.get_json() or {}
    email = data.get("email", "").strip().lower()
    password = data.get("password", "")
    client_ip = get_client_ip()
    db = get_db()

    # Brute force protection: block IP after 5 failed attempts in 15 min
    failed_key = f"login_fail:{client_ip}"
    failed_count = _RATE_LIMIT.get(failed_key, 0)
    if failed_count >= 5:
        from security_module import block_ip
        block_ip(client_ip, 1)
        return jsonify({"error": "Muitas tentativas. IP bloqueado por 1 hora"}), 429

    user = db.execute("SELECT * FROM users WHERE email=? AND active=1", (email,)).fetchone()
    if not user or not check_password(password, user["password_hash"]):
        _RATE_LIMIT[failed_key] = failed_count + 1
        return jsonify({"error": "Credenciais inválidas"}), 401
    if not user["password_hash"].startswith("$2"):
        new_hash = hash_password(password)
        db.execute("UPDATE users SET password_hash=? WHERE id=?", (new_hash, user["id"]))
        db.commit()
    has_mfa = user["mfa_enabled"] if "mfa_enabled" in user.keys() else 0
    if has_mfa:
        mfa_token = uuid4().hex
        exp = (datetime.now() + timedelta(minutes=5)).strftime("%Y-%m-%d %H:%M:%S")
        db.execute(
            "INSERT INTO password_resets (user_id, token, expires_at) VALUES (?,?,?)",
            (user["id"], mfa_token, exp)
        )
        db.commit()
        audit_log("login_mfa_pending", "user", user["id"], "MFA pendente")
        return jsonify({"mfa_required": True, "mfa_token": mfa_token, "user": row_to_dict(user)})
    access_token = create_access_token(user["id"], user["role"])
    refresh_token = create_refresh_token(user["id"])
    audit_log("login", "user", user["id"], f"Login: {user['email']}")
    result = {"access_token": access_token, "refresh_token": refresh_token, "user": row_to_dict(user)}
    if user["role"] == "client":
        system = db.execute(
            "SELECT s.slug, s.name FROM systems s JOIN clients c ON s.client_id = c.id WHERE c.email=? LIMIT 1",
            (email,)
        ).fetchone()
        if system:
            result["system"] = {"slug": system["slug"], "name": system["name"], "portal_url": f"/portal/{system['slug']}"}
    return jsonify(result)

@app.route("/api/auth/refresh", methods=["POST"])
@rate_limit
def api_refresh():
    data = request.get_json() or {}
    refresh_token = data.get("refresh_token", "")
    if not refresh_token:
        return jsonify({"error": "refresh_token obrigatorio"}), 400
    db = get_db()
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    row = db.execute(
        "SELECT * FROM refresh_tokens WHERE token=? AND revoked=0 AND expires_at>?",
        (refresh_token, now)
    ).fetchone()
    if not row:
        return jsonify({"error": "Refresh token invalido ou expirado"}), 401
    user = db.execute("SELECT * FROM users WHERE id=? AND active=1", (row["user_id"],)).fetchone()
    if not user:
        return jsonify({"error": "Usuario nao encontrado"}), 401
    db.execute("UPDATE refresh_tokens SET revoked=1 WHERE id=?", (row["id"],))
    db.commit()
    new_access = create_access_token(user["id"], user["role"])
    new_refresh = create_refresh_token(user["id"])
    return jsonify({"access_token": new_access, "refresh_token": new_refresh})

@app.route("/api/auth/mfa/challenge", methods=["POST"])
@rate_limit
def api_mfa_challenge():
    data = request.get_json() or {}
    mfa_token = data.get("mfa_token", "")
    code = data.get("code", "").strip()
    if not mfa_token or not code:
        return jsonify({"error": "mfa_token e code obrigatorios"}), 400
    db = get_db()
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    row = db.execute(
        "SELECT * FROM password_resets WHERE token=? AND used=0 AND expires_at>?",
        (mfa_token, now)
    ).fetchone()
    if not row:
        return jsonify({"error": "Token MFA invalido ou expirado"}), 401
    user = db.execute("SELECT * FROM users WHERE id=? AND active=1", (row["user_id"],)).fetchone()
    if not user:
        return jsonify({"error": "Usuario nao encontrado"}), 401
    if not user["mfa_secret"]:
        return jsonify({"error": "MFA nao configurado"}), 400
    if verify_mfa_code(user["mfa_secret"], code):
        db.execute("UPDATE password_resets SET used=1 WHERE id=?", (row["id"],))
        db.commit()
        access_token = create_access_token(user["id"], user["role"])
        refresh_token = create_refresh_token(user["id"])
        audit_log("login", "user", user["id"], "Login com MFA")
        return jsonify({"access_token": access_token, "refresh_token": refresh_token, "user": row_to_dict(user)})
    bc = db.execute(
        "SELECT id FROM user_backup_codes WHERE user_id=? AND code=? AND used=0",
        (user["id"], code)
    ).fetchone()
    if bc:
        db.execute("UPDATE password_resets SET used=1 WHERE id=?", (row["id"],))
        db.execute("UPDATE user_backup_codes SET used=1 WHERE id=?", (bc["id"],))
        db.commit()
        access_token = create_access_token(user["id"], user["role"])
        refresh_token = create_refresh_token(user["id"])
        audit_log("login", "user", user["id"], "Login com codigo de recuperacao MFA")
        return jsonify({"access_token": access_token, "refresh_token": refresh_token, "user": row_to_dict(user)})
    audit_log("login_mfa_failed", "user", user["id"], "Tentativa MFA invalida")
    return jsonify({"error": "Codigo MFA invalido"}), 401

@app.route("/api/auth/logout", methods=["POST"])
@require_auth
def api_logout():
    data = request.get_json() or {}
    refresh_token = data.get("refresh_token", "")
    if refresh_token:
        db = get_db()
        db.execute("UPDATE refresh_tokens SET revoked=1 WHERE token=?", (refresh_token,))
        db.commit()
    return jsonify({"ok": True, "message": "Logout realizado"})

# ─── MFA Endpoints ───────────────────────────

@app.route("/api/auth/mfa/setup", methods=["POST"])
@require_auth
@rate_limit
def api_mfa_setup():
    user = get_current_user()
    db = get_db()
    if user.get("mfa_enabled"):
        return jsonify({"error": "MFA ja esta ativado"}), 400
    secret = generate_mfa_secret()
    qrcode_b64 = generate_mfa_qrcode_base64(secret, user["email"])
    recovery_codes = generate_recovery_codes()
    codes_str = ",".join(recovery_codes)
    db.execute(
        "UPDATE users SET mfa_secret=?, mfa_recovery=? WHERE id=?",
        (secret, codes_str, user["id"])
    )
    for code in recovery_codes:
        db.execute(
            "INSERT INTO user_backup_codes (user_id, code) VALUES (?,?)",
            (user["id"], code)
        )
    db.commit()
    audit_log("mfa_setup", "user", user["id"], "MFA configurado")
    return jsonify({
        "secret": secret,
        "qrcode": qrcode_b64,
        "recovery_codes": recovery_codes
    })

@app.route("/api/auth/mfa/verify", methods=["POST"])
@require_auth
@rate_limit
def api_mfa_verify():
    user = get_current_user()
    data = request.get_json() or {}
    code = data.get("code", "").strip()
    if not code:
        return jsonify({"error": "Codigo obrigatorio"}), 400
    db = get_db()
    row = db.execute("SELECT mfa_secret FROM users WHERE id=?", (user["id"],)).fetchone()
    if not row or not row["mfa_secret"]:
        return jsonify({"error": "MFA nao configurado"}), 400
    if verify_mfa_code(row["mfa_secret"], code):
        db.execute("UPDATE users SET mfa_enabled=1 WHERE id=?", (user["id"],))
        db.commit()
        audit_log("mfa_enable", "user", user["id"], "MFA ativado")
        return jsonify({"ok": True, "message": "MFA ativado com sucesso"})
    bc = db.execute(
        "SELECT id FROM user_backup_codes WHERE user_id=? AND code=? AND used=0",
        (user["id"], code)
    ).fetchone()
    if bc:
        db.execute("UPDATE user_backup_codes SET used=1 WHERE id=?", (bc["id"],))
        db.execute("UPDATE users SET mfa_enabled=1 WHERE id=?", (user["id"],))
        db.commit()
        audit_log("mfa_enable", "user", user["id"], "MFA ativado via codigo de recuperacao")
        return jsonify({"ok": True, "message": "MFA ativado com sucesso"})
    return jsonify({"error": "Codigo invalido"}), 400

@app.route("/api/auth/mfa/disable", methods=["POST"])
@require_auth
@rate_limit
def api_mfa_disable():
    user = get_current_user()
    db = get_db()
    db.execute(
        "UPDATE users SET mfa_secret='', mfa_enabled=0, mfa_recovery='' WHERE id=?",
        (user["id"],)
    )
    db.execute("DELETE FROM user_backup_codes WHERE user_id=?", (user["id"],))
    db.commit()
    audit_log("mfa_disable", "user", user["id"], "MFA desativado")
    return jsonify({"ok": True, "message": "MFA desativado"})

@app.route("/api/auth/mfa/status", methods=["GET"])
@require_auth
def api_mfa_status():
    user = get_current_user()
    db = get_db()
    row = db.execute("SELECT mfa_enabled FROM users WHERE id=?", (user["id"],)).fetchone()
    backup_codes_left = db.execute(
        "SELECT COUNT(*) as c FROM user_backup_codes WHERE user_id=? AND used=0",
        (user["id"],)
    ).fetchone()["c"]
    return jsonify({
        "mfa_enabled": bool(row and row["mfa_enabled"]),
        "backup_codes_left": backup_codes_left
    })

@app.route("/api/auth/mfa/recovery-codes", methods=["POST"])
@require_auth
@rate_limit
def api_mfa_recovery_codes():
    user = get_current_user()
    row = g.get("current_user", {})
    if not row.get("mfa_enabled"):
        return jsonify({"error": "MFA nao esta ativado"}), 400
    codes = generate_recovery_codes()
    db = get_db()
    db.execute("DELETE FROM user_backup_codes WHERE user_id=?", (user["id"],))
    codes_str = ",".join(codes)
    db.execute("UPDATE users SET mfa_recovery=? WHERE id=?", (codes_str, user["id"]))
    for code in codes:
        db.execute(
            "INSERT INTO user_backup_codes (user_id, code) VALUES (?,?)",
            (user["id"], code)
        )
    db.commit()
    return jsonify({"recovery_codes": codes})

# ─── Super Admin Endpoints ────────────────────

@app.route("/api/super-admin/security-summary")
@require_auth
@require_role("super_admin", "admin")
def api_super_admin_security():
    return jsonify(get_security_summary())

@app.route("/api/super-admin/audit-log")
@require_auth
@require_role("super_admin", "admin")
def api_super_admin_audit():
    db = get_db()
    page = request.args.get("page", 1, type=int)
    per_page = request.args.get("per_page", 50, type=int)
    offset = (page - 1) * per_page
    action_filter = request.args.get("action", "")
    user_filter = request.args.get("user_id", "")
    query = "SELECT * FROM audit_log WHERE 1=1"
    params = []
    if action_filter:
        query += " AND action=?"
        params.append(action_filter)
    if user_filter:
        query += " AND user_id=?"
        params.append(int(user_filter))
    query += " ORDER BY id DESC LIMIT ? OFFSET ?"
    params.extend([per_page, offset])
    rows = db.execute(query, params).fetchall()
    total = db.execute(
        "SELECT COUNT(*) as c FROM audit_log"
    ).fetchone()["c"]
    return jsonify({
        "rows": rows_to_list(rows),
        "total": total,
        "page": page,
        "per_page": per_page,
        "pages": -(-total // per_page)
    })

@app.route("/api/super-admin/security-events")
@require_auth
@require_role("super_admin", "admin")
def api_super_admin_security_events():
    db = get_db()
    rows = db.execute(
        "SELECT * FROM security_events ORDER BY id DESC LIMIT 100"
    ).fetchall()
    return jsonify({"rows": rows_to_list(rows)})

@app.route("/api/super-admin/active-sessions")
@require_auth
@require_role("super_admin", "admin")
def api_super_admin_sessions():
    db = get_db()
    is_pg = bool(os.environ.get("DATABASE_URL"))
    expires_cond = "CAST(rt.expires_at AS timestamp) > NOW()" if is_pg else "rt.expires_at > datetime('now','localtime')"
    rows = db.execute(
        f"""SELECT rt.*, u.name, u.email, u.role
           FROM refresh_tokens rt JOIN users u ON rt.user_id = u.id
           WHERE rt.revoked=0 AND {expires_cond}
           ORDER BY rt.created_at DESC LIMIT 100"""
    ).fetchall()
    return jsonify({"rows": rows_to_list(rows)})

@app.route("/api/super-admin/block-ip", methods=["POST"])
@require_auth
@require_role("super_admin", "admin")
def api_super_admin_block_ip():
    data = request.get_json() or {}
    ip = data.get("ip", "")
    hours = data.get("hours", 24)
    if not ip:
        return jsonify({"error": "IP obrigatorio"}), 400
    from security_module import block_ip
    block_ip(ip, hours)
    audit_log("block_ip", "ip", None, f"IP {ip} bloqueado por {hours}h", {"ip": ip, "hours": hours})
    return jsonify({"ok": True, "message": f"IP {ip} bloqueado por {hours}h"})

@app.route("/api/super-admin/revoke-session", methods=["POST"])
@require_auth
@require_role("super_admin", "admin")
def api_super_admin_revoke_session():
    data = request.get_json() or {}
    token = data.get("token", "")
    if not token:
        return jsonify({"error": "Token obrigatorio"}), 400
    db = get_db()
    if token == "ALL":
        db.execute("UPDATE refresh_tokens SET revoked=1 WHERE revoked=0")
        db.commit()
        audit_log("revoke_all_sessions", "session", None, "Todas as sessoes revogadas")
        return jsonify({"ok": True, "message": "Todas as sessoes foram revogadas"})
    db.execute("UPDATE refresh_tokens SET revoked=1 WHERE token=?", (token,))
    db.commit()
    audit_log("revoke_session", "session", None, "Sessao revogada por admin")
    return jsonify({"ok": True, "message": "Sessao revogada"})

@app.route("/api/super-admin/users")
@require_auth
@require_role("super_admin", "admin")
def api_super_admin_users():
    db = get_db()
    rows = db.execute("""
        SELECT id, name, email, role, active, mfa_enabled, created_at,
               (SELECT COUNT(*) FROM audit_log WHERE user_id=users.id) as action_count
        FROM users ORDER BY id
    """).fetchall()
    return jsonify({"rows": rows_to_list(rows)})

# ─── Role info for frontend ──────────────────

@app.route("/api/auth/roles")
@require_auth
def api_auth_roles():
    roles_info = []
    for key, val in ROLES.items():
        roles_info.append({
            "id": key,
            "label": val["label"],
            "priority": val["priority"],
            "modules": get_role_permissions(key)
        })
    return jsonify({"roles": roles_info, "modules": ACL_MODULES, "current_role": get_current_user()["role"]})

@app.route("/api/forgot-password", methods=["POST"])
@rate_limit
@rate_limit_advanced(limit=3, per=300, key="forgot_password")
def api_forgot_password():
    data = request.get_json() or {}
    email = data.get("email", "").strip().lower()
    if not email:
        return jsonify({"error": "Email obrigatorio"}), 400
    db = get_db()
    user = db.execute("SELECT id, name, email FROM users WHERE email=? AND active=1", (email,)).fetchone()
    if not user:
        return jsonify({"ok": True, "message": "Se o email existir, um link sera enviado."})
    token = generate_token()
    expires_at = (datetime.now() + timedelta(hours=1)).strftime("%Y-%m-%d %H:%M:%S")
    db.execute(
        "INSERT INTO password_resets (user_id, token, expires_at) VALUES (?,?,?)",
        (user["id"], token, expires_at)
    )
    db.commit()
    log_activity("solicitou", "recuperar_senha", user["id"], f"Token gerado para: {user['email']}")

    base_url = request.host_url.rstrip("/")
    reset_link = f"{base_url}/?reset_token={token}"
    subject = "Recuperacao de Senha - Promake"
    body_html = f"""<html><body style="font-family:Arial,sans-serif;background:#0F0F1A;padding:40px">
<div style="max-width:560px;margin:auto;background:#1A1A2E;border-radius:12px;padding:40px;border:1px solid #2A2A45">
<div style="text-align:center;margin-bottom:24px">
<div style="font-size:48px;color:#6C5CE7;margin-bottom:8px">&#x1F451;</div>
<h1 style="color:#E0E0E0;font-size:24px;margin:0">Promake Ecosystem</h1>
</div>
<h2 style="color:#E0E0E0;font-size:20px;margin-bottom:16px">Recuperacao de Senha</h2>
<p style="color:#8888AA;font-size:14px;line-height:1.6">Ola, <strong style="color:#E0E0E0">{user['name']}</strong>!</p>
<p style="color:#8888AA;font-size:14px;line-height:1.6">Recebemos uma solicitacao de redefinicao de senha para sua conta no Promake.</p>
<p style="color:#8888AA;font-size:14px;line-height:1.6">Clique no botao abaixo para criar uma nova senha (valido por 1 hora):</p>
<div style="text-align:center;margin:28px 0">
<a href="{reset_link}" style="display:inline-block;padding:14px 32px;background:#6C5CE7;color:#fff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:600">Redefinir Senha</a>
</div>
<p style="color:#8888AA;font-size:13px;line-height:1.6">Se voce nao solicitou esta alteracao, ignore este email. Sua senha permanecera a mesma.</p>
<p style="color:#8888AA;font-size:13px;line-height:1.6;margin-top:20px;padding-top:16px;border-top:1px solid #2A2A45">Atenciosamente,<br><strong style="color:#E0E0E0">Equipe Promake</strong></p>
</div></body></html>"""
    sent = send_email(user["email"], subject, body_html)
    if sent:
        return jsonify({"ok": True, "message": "Email de recuperacao enviado para " + user["email"]})
    smtp_config = load_config().get("smtp", {})
    if smtp_config.get("host"):
        return jsonify({"error": "Erro ao enviar email. Verifique as configuracoes de SMTP."}), 500
    return jsonify({"ok": True, "message": "Se o email existir, um token sera enviado."})

@app.route("/api/auth/reset-password", methods=["POST"])
@rate_limit
@rate_limit_advanced(limit=5, per=300, key="reset_password")
def api_reset_password():
    data = request.get_json() or {}
    token = data.get("token", "").strip()
    new_password = data.get("password", "")
    if not token or not new_password:
        return jsonify({"error": "Token e nova senha obrigatorios"}), 400
    if len(new_password) < 6:
        return jsonify({"error": "Senha deve ter no minimo 6 caracteres"}), 400
    db = get_db()
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    reset = db.execute(
        "SELECT * FROM password_resets WHERE token=? AND used=0 AND expires_at>?",
        (token, now)
    ).fetchone()
    if not reset:
        return jsonify({"error": "Token invalido ou expirado"}), 400
    user_id = reset["user_id"]
    db.execute("UPDATE users SET password_hash=? WHERE id=?", (hash_password(new_password), user_id))
    db.execute("UPDATE password_resets SET used=1 WHERE id=?", (reset["id"],))
    db.commit()
    log_activity("alterou", "senha", user_id, "Senha redefinida via token")
    return jsonify({"ok": True, "message": "Senha redefinida com sucesso"})

@app.route("/api/auth/profile", methods=["GET", "PUT"])
@require_auth
def api_profile():
    if request.method == "PUT":
        data = request.get_json() or {}
        db = get_db()
        user = get_current_user()
        allowed = {k: data[k] for k in ("name","email","phone","avatar") if k in data}
        if allowed:
            sets = ", ".join(f"{k}=?" for k in allowed)
            db.execute(f"UPDATE users SET {sets} WHERE id=?", tuple(allowed.values()) + (user["id"],))
            db.commit()
        return jsonify({"ok": True, "user": dict(db.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone())})
    return jsonify(get_current_user())

@app.route("/api/auth/register", methods=["POST"])
@require_auth
def api_register_user():
    cur = get_current_user()
    if cur["role"] not in ("admin", "manager"):
        return jsonify({"error": "Sem permissao"}), 403
    data = request.get_json() or {}
    name = data.get("name", "").strip()
    email = data.get("email", "").strip().lower()
    password = data.get("password", "")
    if not password:
        password = "123456"
    role = data.get("role", "designer")
    if not name or not email:
        return jsonify({"error": "Nome e email obrigatório"}), 400
    db = get_db()
    if db.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone():
        return jsonify({"error": "Email ja cadastrado"}), 400
    db.execute(
        "INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)",
        (name, email, hash_password(password), role)
    )
    db.commit()
    uid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
    log_activity("criou", "usuario", uid, f"Usuario: {name}")
    create_notification("success", "Novo Membro", f"Membro {name} cadastrado como {role}.", "/team")
    return jsonify({"ok": True, "message": "Usuario cadastrado"})

def _generate_slug(text):
    slug = re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-')
    if not slug:
        slug = "cliente"
    db = get_db()
    existing = db.execute("SELECT id FROM systems WHERE slug=?", (slug,)).fetchone()
    if not existing:
        return slug
    for _ in range(100):
        suffix = ''.join(random.choices(string.ascii_lowercase + string.digits, k=4))
        candidate = f"{slug}-{suffix}"
        if not db.execute("SELECT id FROM systems WHERE slug=?", (candidate,)).fetchone():
            return candidate
    return slug + "-" + str(int(time.time()))

@app.route("/api/auth/send-verification", methods=["POST"])
@rate_limit
@rate_limit_advanced(limit=3, per=300, key="send_verification")
def api_send_verification():
    try:
        data = request.get_json() or {}
        email = data.get("email", "").strip().lower()
        if not email:
            return jsonify({"error": "Email obrigatorio"}), 400
        db = get_db()
        if db.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone():
            return jsonify({"ok": True, "message": "Se o email estiver disponivel, um codigo sera enviado."})
        code = generate_code()
        expires_at = (datetime.now() + timedelta(minutes=10)).strftime("%Y-%m-%d %H:%M:%S")
        try:
            db.execute("INSERT INTO email_verifications (email, code, type, expires_at) VALUES (?,?,?,?)",
                       (email, code, "signup", expires_at))
        except Exception:
            db.execute("""CREATE TABLE IF NOT EXISTS email_verifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL,
                code TEXT NOT NULL,
                type TEXT DEFAULT 'signup',
                expires_at TEXT NOT NULL,
                used INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now','localtime'))
            )""")
            db.execute("INSERT INTO email_verifications (email, code, type, expires_at) VALUES (?,?,?,?)",
                       (email, code, "signup", expires_at))
        db.commit()
        subject = "Codigo de Verificacao - Promake"
        body_html = f"""\
<html><body style="font-family:Arial,sans-serif;padding:20px">
<h2 style="color:#6c5ce7">Verificacao de Email</h2>
<p>Seu codigo de verificacao e:</p>
<h1 style="font-size:32px;letter-spacing:4px;color:#6c5ce7;text-align:center;padding:16px;background:#f0edfe;border-radius:8px">{code}</h1>
<p>Este codigo expira em 10 minutos.</p>
<p style="color:#999;font-size:12px">Promake - Sistema de Gestao</p>
</body></html>"""
        sent = send_email(email, subject, body_html)
        if sent:
            return jsonify({"ok": True, "message": "Codigo enviado para " + email})
        return jsonify({"ok": True, "message": "Codigo enviado para o email informado."})
    except Exception as e:
        return jsonify({"error": "Erro interno: " + str(e)}), 500

@app.route("/api/auth/signup", methods=["POST"])
@rate_limit
@rate_limit_advanced(limit=3, per=300, key="signup")
def api_signup():
    try:
        data = request.get_json() or {}
        name = data.get("name", "").strip()
        email = data.get("email", "").strip().lower()
        password = data.get("password", "")
        company = data.get("company", "").strip()
        code = data.get("code", "").strip()
        if not name or not email or not password:
            return jsonify({"error": "Nome, email e senha obrigatorios"}), 400
        if len(password) < 6:
            return jsonify({"error": "Senha deve ter no minimo 6 caracteres"}), 400
        if not code:
            return jsonify({"error": "Codigo de verificacao obrigatorio"}), 400
        db = get_db()
        if db.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone():
            return jsonify({"error": "Email ja cadastrado"}), 400
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        try:
            ver = db.execute(
                "SELECT id FROM email_verifications WHERE email=? AND code=? AND type='signup' AND used=0 AND expires_at>?",
                (email, code, now)
            ).fetchone()
        except Exception:
            db.execute("""CREATE TABLE IF NOT EXISTS email_verifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL,
                code TEXT NOT NULL,
                type TEXT DEFAULT 'signup',
                expires_at TEXT NOT NULL,
                used INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now','localtime'))
            )""")
            ver = db.execute(
                "SELECT id FROM email_verifications WHERE email=? AND code=? AND type='signup' AND used=0 AND expires_at>?",
                (email, code, now)
            ).fetchone()
        if not ver:
            return jsonify({"error": "Codigo de verificacao invalido ou expirado"}), 400
        db.execute("UPDATE email_verifications SET used=1 WHERE id=?", (ver["id"],))
        client_name = company or name
        slug = _generate_slug(client_name)
        portal_password = ''.join(random.choices(string.ascii_letters + string.digits, k=8))
        db.execute("INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)",
                   (name, email, hash_password(password), "client"))
        uid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
        db.execute("INSERT INTO clients (name,email,status,created_by) VALUES (?,?,'active',?)",
                   (client_name, email, uid))
        cid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
        db.execute("""INSERT INTO systems (client_id, name, slug, portal_password_hash, active, created_by)
                      VALUES (?,?,?,?,1,?)""",
                   (cid, client_name, slug, hash_password(portal_password), uid))
        sid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
        for mk in ("dashboard","projects","service_orders","finance","calendar","files","developments"):
            db.execute("INSERT INTO system_modules (system_id, module_key, enabled) VALUES (?,?,1)", (sid, mk))
        db.commit()
        log_activity("cadastrou", "cliente", cid, f"Cliente: {client_name}")
        create_notification("success", "Novo Cliente", f"Cliente {client_name} se cadastrou no sistema.")
        return jsonify({
            "ok": True,
            "message": "Conta criada com sucesso!",
            "user_id": uid,
            "client_id": cid,
            "system_id": sid,
            "slug": slug,
            "portal_url": f"/portal/{slug}",
            "portal_password": portal_password
        })
    except Exception as e:
        db.rollback()
        return jsonify({"error": "Erro ao criar conta: " + str(e)}), 500

@app.route("/api/auth/send-reset-code", methods=["POST"])
@rate_limit
@rate_limit_advanced(limit=3, per=300, key="send_reset_code")
def api_send_reset_code():
    try:
        data = request.get_json() or {}
        email = data.get("email", "").strip().lower()
        if not email:
            return jsonify({"error": "Email obrigatorio"}), 400
        db = get_db()
        user = db.execute("SELECT id, name, email FROM users WHERE email=? AND active=1", (email,)).fetchone()
        if not user:
            return jsonify({"ok": True, "message": "Se o email existir, um codigo sera enviado."})
        expires_at = (datetime.now() + timedelta(minutes=10)).strftime("%Y-%m-%d %H:%M:%S")
        try:
            db.execute("INSERT INTO email_verifications (email, code, type, expires_at) VALUES (?,?,?,?)",
                       (email, code, "forgot", expires_at))
        except Exception:
            db.execute("""CREATE TABLE IF NOT EXISTS email_verifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL,
                code TEXT NOT NULL,
                type TEXT DEFAULT 'signup',
                expires_at TEXT NOT NULL,
                used INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now','localtime'))
            )""")
            db.execute("INSERT INTO email_verifications (email, code, type, expires_at) VALUES (?,?,?,?)",
                       (email, code, "forgot", expires_at))
        db.commit()
        subject = "Codigo de Recuperacao - Promake"
        body_html = f"""\
<html><body style="font-family:Arial,sans-serif;padding:20px">
<h2 style="color:#6c5ce7">Recuperacao de Senha</h2>
<p>Seu codigo para redefinir a senha e:</p>
<h1 style="font-size:32px;letter-spacing:4px;color:#6c5ce7;text-align:center;padding:16px;background:#f0edfe;border-radius:8px">{code}</h1>
<p>Este codigo expira em 10 minutos.</p>
<p style="color:#999;font-size:12px">Promake - Sistema de Gestao</p>
</body></html>"""
        sent = send_email(user["email"], subject, body_html)
        if sent:
            return jsonify({"ok": True, "message": "Codigo enviado para " + user["email"]})
        return jsonify({"ok": True, "message": "Codigo enviado para o email informado."})
    except Exception as e:
        return jsonify({"error": "Erro interno: " + str(e)}), 500

@app.route("/api/auth/reset-with-code", methods=["POST"])
@rate_limit
@rate_limit_advanced(limit=5, per=300, key="reset_with_code")
def api_reset_with_code():
    try:
        data = request.get_json() or {}
        email = data.get("email", "").strip().lower()
        code = data.get("code", "").strip()
        new_password = data.get("password", "")
        if not email or not code or not new_password:
            return jsonify({"error": "Email, codigo e nova senha obrigatorios"}), 400
        if len(new_password) < 6:
            return jsonify({"error": "Senha deve ter no minimo 6 caracteres"}), 400
        db = get_db()
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        try:
            ver = db.execute(
                "SELECT id FROM email_verifications WHERE email=? AND code=? AND type='forgot' AND used=0 AND expires_at>?",
                (email, code, now)
            ).fetchone()
        except Exception:
            db.execute("""CREATE TABLE IF NOT EXISTS email_verifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL,
                code TEXT NOT NULL,
                type TEXT DEFAULT 'signup',
                expires_at TEXT NOT NULL,
                used INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now','localtime'))
            )""")
            ver = db.execute(
                "SELECT id FROM email_verifications WHERE email=? AND code=? AND type='forgot' AND used=0 AND expires_at>?",
                (email, code, now)
            ).fetchone()
        if not ver:
            return jsonify({"error": "Codigo invalido ou expirado"}), 400
        db.execute("UPDATE email_verifications SET used=1 WHERE id=?", (ver["id"],))
        db.execute("UPDATE users SET password_hash=? WHERE email=? AND active=1",
                   (hash_password(new_password), email))
        db.commit()
        user = db.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()
        if user:
            log_activity("alterou", "senha", user["id"], "Senha redefinida via codigo")
        return jsonify({"ok": True, "message": "Senha redefinida com sucesso"})
    except Exception as e:
        return jsonify({"error": "Erro interno: " + str(e)}), 500

@app.route("/api/team")
@require_auth
def api_team():
    db = get_db()
    users = db.execute("SELECT id,name,email,role,avatar,phone,active,created_at FROM users ORDER BY name").fetchall()
    return jsonify(rows_to_list(users))

@app.route("/api/team/<int:uid>", methods=["PUT", "DELETE"])
@require_auth
def api_team_member(uid):
    cur = get_current_user()
    if cur["role"] not in ("super_admin", "admin", "manager") and cur["id"] != uid:
        return jsonify({"error": "Sem permissao"}), 403
    db = get_db()
    if request.method == "DELETE":
        db.execute("DELETE FROM users WHERE id=?", (uid,))
        db.commit()
        log_activity("excluiu", "usuario", uid, f"Usuario ID: {uid}")
        create_notification("warning", "Membro Removido", f"Membro ID {uid} foi removido da equipe.")
        return jsonify({"ok": True})
    data = request.get_json() or {}
    fields = []
    vals = []
    for k in ("name","email","role","phone","active","avatar"):
        if k in data:
            fields.append(f"{k}=?")
            vals.append(data[k])
    if cur["role"] == "super_admin":
        for k in ("mfa_enabled", "mfa_secret", "mfa_recovery"):
            if k in data:
                fields.append(f"{k}=?")
                vals.append(data[k])
    password = data.get("password", "")
    if password:
        fields.append("password_hash=?")
        vals.append(hash_password(password))
    if fields:
        vals.append(uid)
        db.execute(f"UPDATE users SET {','.join(fields)} WHERE id=?", vals)
        db.commit()
        log_activity("editou", "usuario", uid, f"Usuario ID: {uid}")
        create_notification("info", "Membro Atualizado", f"Dados do membro ID {uid} foram alterados.")
    return jsonify({"ok": True})

# ─── Permissions ──────────────────────────────

@app.route("/api/permissions", methods=["GET", "POST"])
@require_auth
def api_permissions():
    cur = get_current_user()
    if cur["role"] != "admin":
        return jsonify({"error": "Sem permissao"}), 403
    db = get_db()
    if request.method == "POST":
        data = request.get_json() or {}
        user_id = data.get("user_id")
        perms = data.get("permissions", "{}")
        if not user_id:
            return jsonify({"error": "user_id obrigatorio"}), 400
        db.execute("""
            INSERT INTO permissions (user_id, permissions, updated_at)
            VALUES (?, ?, datetime('now','localtime'))
            ON CONFLICT(user_id) DO UPDATE SET permissions=?, updated_at=datetime('now','localtime')
        """, (user_id, json.dumps(perms), json.dumps(perms)))
        db.commit()
        return jsonify({"ok": True})
    perms_list = db.execute("""
        SELECT p.user_id, p.permissions, p.updated_at, u.name, u.email, u.role
        FROM permissions p JOIN users u ON p.user_id = u.id ORDER BY u.name
    """).fetchall()
    result = []
    for row in perms_list:
        result.append({
            "user_id": row["user_id"],
            "name": row["name"],
            "email": row["email"],
            "role": row["role"],
            "permissions": json.loads(row["permissions"]),
            "updated_at": row["updated_at"]
        })
    return jsonify(result)

# ─── Developments ────────────────────────────

@app.route("/api/developments")
@require_auth
def api_developments():
    db = get_db()
    rows = db.execute("SELECT * FROM developments ORDER BY name").fetchall()
    result = []
    for r in rows:
        d = dict(r)
        brokers = db.execute("""
            SELECT bd.user_id, bd.commission_pct, u.name, u.email
            FROM broker_developments bd JOIN users u ON bd.user_id = u.id
            WHERE bd.development_id = ?
        """, (d["id"],)).fetchall()
        d["brokers"] = [dict(b) for b in brokers]
        result.append(d)
    return jsonify(result)

@app.route("/api/developments/<int:dev_id>", methods=["PUT", "DELETE"])
@require_auth
def api_development(dev_id):
    cur = get_current_user()
    if cur["role"] != "admin":
        return jsonify({"error": "Sem permissao"}), 403
    db = get_db()
    if request.method == "DELETE":
        db.execute("DELETE FROM units WHERE development_id=?", (dev_id,))
        db.execute("DELETE FROM broker_developments WHERE development_id=?", (dev_id,))
        db.execute("DELETE FROM developments WHERE id=?", (dev_id,))
        db.commit()
        log_activity("excluiu", "empreendimento", dev_id, f"Empreendimento ID: {dev_id}")
        return jsonify({"ok": True})
    data = request.get_json() or {}
    fields = ["name","builder","status","address","description","delivery_date","total_units","image_url"]
    sets = []
    vals = []
    for f in fields:
        if f in data:
            sets.append(f"{f}=?")
            vals.append(data[f])
    if sets:
        vals.append(dev_id)
        db.execute(f"UPDATE developments SET {','.join(sets)} WHERE id=?", vals)
        db.commit()
        log_activity("editou", "empreendimento", dev_id, f"Empreendimento ID: {dev_id}")
    return jsonify({"ok": True})

@app.route("/api/developments", methods=["POST"])
@require_auth
def api_create_development():
    cur = get_current_user()
    if cur["role"] != "admin":
        return jsonify({"error": "Sem permissao"}), 403
    data = request.get_json() or {}
    name = data.get("name", "").strip()
    if not name:
        return jsonify({"error": "Nome obrigatorio"}), 400
    db = get_db()
    db.execute("""
        INSERT INTO developments (name, builder, status, address, description, delivery_date, total_units, created_by)
        VALUES (?,?,?,?,?,?,?,?)
    """, (name, data.get("builder",""), data.get("status","lançamento"), data.get("address",""),
          data.get("description",""), data.get("delivery_date",""), int(data.get("total_units",0)), cur["id"]))
    db.commit()
    dev_id = db.execute("SELECT last_insert_rowid()").fetchone()[0]
    log_activity("criou", "empreendimento", dev_id, f"Empreendimento: {name}")
    return jsonify({"ok": True, "id": dev_id})

@app.route("/api/developments/<int:dev_id>/units")
@require_auth
def api_units(dev_id):
    db = get_db()
    rows = db.execute("SELECT * FROM units WHERE development_id=? ORDER BY tower, number", (dev_id,)).fetchall()
    return jsonify(rows_to_list(rows))

@app.route("/api/developments/<int:dev_id>/units", methods=["POST"])
@require_auth
def api_create_unit(dev_id):
    cur = get_current_user()
    if cur["role"] not in ("admin", "manager"):
        return jsonify({"error": "Sem permissao"}), 403
    data = request.get_json() or {}
    number = data.get("number", "").strip()
    if not number:
        return jsonify({"error": "Numero da unidade obrigatorio"}), 400
    db = get_db()
    db.execute("""
        INSERT INTO units (development_id, tower, block, floor, number, area, bedrooms, suites, bathrooms, parking_spots, price, status, notes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    """, (dev_id, data.get("tower",""), data.get("block",""), data.get("floor",""), number,
          float(data.get("area",0)), int(data.get("bedrooms",0)), int(data.get("suites",0)),
          int(data.get("bathrooms",0)), int(data.get("parking_spots",0)),
          float(data.get("price",0)), data.get("status","disponivel"), data.get("notes","")))
    db.commit()
    unit_id = db.execute("SELECT last_insert_rowid()").fetchone()[0]
    db.execute("UPDATE developments SET total_units = (SELECT COUNT(*) FROM units WHERE development_id=?) WHERE id=?", (dev_id, dev_id))
    db.commit()
    return jsonify({"ok": True, "id": unit_id})

@app.route("/api/developments/<int:dev_id>/units/<int:unit_id>", methods=["PUT", "DELETE"])
@require_auth
def api_unit(dev_id, unit_id):
    cur = get_current_user()
    if cur["role"] not in ("admin", "manager"):
        return jsonify({"error": "Sem permissao"}), 403
    db = get_db()
    if request.method == "DELETE":
        db.execute("DELETE FROM units WHERE id=? AND development_id=?", (unit_id, dev_id))
        db.commit()
        db.execute("UPDATE developments SET total_units = (SELECT COUNT(*) FROM units WHERE development_id=?) WHERE id=?", (dev_id, dev_id))
        db.commit()
        return jsonify({"ok": True})
    data = request.get_json() or {}
    fields = ["tower","block","floor","number","area","bedrooms","suites","bathrooms","parking_spots","price","status","notes"]
    sets = []
    vals = []
    for f in fields:
        if f in data:
            sets.append(f"{f}=?")
            vals.append(data[f])
    if sets:
        vals.append(unit_id)
        vals.append(dev_id)
        db.execute(f"UPDATE units SET {','.join(sets)} WHERE id=? AND development_id=?", vals)
        db.commit()
    return jsonify({"ok": True})

@app.route("/api/developments/<int:dev_id>/brokers", methods=["GET", "POST"])
@require_auth
def api_dev_brokers(dev_id):
    cur = get_current_user()
    if cur["role"] != "admin":
        return jsonify({"error": "Sem permissao"}), 403
    db = get_db()
    if request.method == "POST":
        data = request.get_json() or {}
        user_id = data.get("user_id")
        pct = float(data.get("commission_pct", 3.0))
        if not user_id:
            return jsonify({"error": "user_id obrigatorio"}), 400
        db.execute("""
            INSERT INTO broker_developments (user_id, development_id, commission_pct)
            VALUES (?,?,?)
            ON CONFLICT(user_id, development_id) DO UPDATE SET commission_pct=?
        """, (user_id, dev_id, pct, pct))
        db.commit()
        return jsonify({"ok": True})
    rows = db.execute("""
        SELECT bd.user_id, bd.commission_pct, u.name, u.email
        FROM broker_developments bd JOIN users u ON bd.user_id = u.id
        WHERE bd.development_id = ?
    """, (dev_id,)).fetchall()
    return jsonify(rows_to_list(rows))

@app.route("/api/developments/<int:dev_id>/brokers/<int:user_id>", methods=["DELETE"])
@require_auth
def api_dev_broker_delete(dev_id, user_id):
    cur = get_current_user()
    if cur["role"] != "admin":
        return jsonify({"error": "Sem permissao"}), 403
    db = get_db()
    db.execute("DELETE FROM broker_developments WHERE development_id=? AND user_id=?", (dev_id, user_id))
    db.commit()
    return jsonify({"ok": True})

# ─── Systems / Portal ─────────────────────────

@app.route("/api/systems")
@require_auth
def api_systems():
    db = get_db()
    rows = db.execute("""
        SELECT s.*, c.name as client_name FROM systems s
        LEFT JOIN clients c ON s.client_id = c.id ORDER BY s.name
    """).fetchall()
    return jsonify(rows_to_list(rows))

@app.route("/api/systems", methods=["POST"])
@require_auth
def api_create_system():
    cur = get_current_user()
    if cur["role"] != "admin":
        return jsonify({"error": "Sem permissao"}), 403
    data = request.get_json() or {}
    name = data.get("name", "").strip()
    slug = data.get("slug", "").strip()
    if not name or not slug:
        return jsonify({"error": "Nome e slug obrigatorios"}), 400
    db = get_db()
    existing = db.execute("SELECT id FROM systems WHERE slug=?", (slug,)).fetchone()
    if existing:
        return jsonify({"error": "Slug ja existe"}), 400
    pw = data.get("portal_password", "1234")
    admin_pw = data.get("admin_password", "")
    db.execute("""
        INSERT INTO systems (client_id, name, slug, primary_color, logo_url, portal_password_hash, admin_password_hash, active, created_by)
        VALUES (?,?,?,?,?,?,?,1,?)
    """, (data.get("client_id"), name, slug, data.get("primary_color","#6C5CE7"),
          data.get("logo_url",""), hash_password(pw) if pw else "",
          hash_password(admin_pw) if admin_pw else "", cur["id"]))
    db.commit()
    sid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
    for mk in ("dashboard","projects","service_orders","finance","calendar","files","developments"):
        db.execute("INSERT INTO system_modules (system_id, module_key, enabled) VALUES (?,?,1)", (sid, mk))
    db.commit()
    log_activity("criou", "sistema", sid, f"Sistema: {name}")
    return jsonify({"ok": True, "id": sid})

@app.route("/api/systems/<int:sid>")
@require_auth
def api_get_system(sid):
    db = get_db()
    row = db.execute("SELECT * FROM systems WHERE id=?", (sid,)).fetchone()
    if not row:
        return jsonify({"error": "Nao encontrado"}), 404
    data = dict(row)
    data["modules"] = rows_to_list(db.execute(
        "SELECT module_key, enabled FROM system_modules WHERE system_id=?", (sid,)
    ).fetchall())
    return jsonify(data)

@app.route("/api/systems/<int:sid>", methods=["PUT"])
@require_auth
def api_update_system(sid):
    cur = get_current_user()
    if cur["role"] != "admin":
        return jsonify({"error": "Sem permissao"}), 403
    data = request.get_json() or {}
    db = get_db()
    fields = ["name", "client_id", "slug", "primary_color", "logo_url", "active"]
    sets = []
    vals = []
    for f in fields:
        if f in data:
            sets.append(f"{f}=?")
            vals.append(data[f])
    pw = data.get("portal_password", "")
    if pw:
        sets.append("portal_password_hash=?")
        vals.append(hash_password(pw))
    admin_pw = data.get("admin_password", "")
    if admin_pw:
        sets.append("admin_password_hash=?")
        vals.append(hash_password(admin_pw))
    if sets:
        vals.append(sid)
        db.execute(f"UPDATE systems SET {','.join(sets)} WHERE id=?", vals)
        db.commit()
        log_activity("editou", "sistema", sid)
    return jsonify({"ok": True})

@app.route("/api/systems/<int:sid>", methods=["DELETE"])
@require_auth
def api_delete_system(sid):
    cur = get_current_user()
    if cur["role"] != "admin":
        return jsonify({"error": "Sem permissao"}), 403
    db = get_db()
    db.execute("DELETE FROM system_modules WHERE system_id=?", (sid,))
    db.execute("DELETE FROM systems WHERE id=?", (sid,))
    db.commit()
    log_activity("excluiu", "sistema", sid)
    return jsonify({"ok": True})

@app.route("/api/systems/<int:sid>/modules", methods=["POST"])
@require_auth
def api_save_modules(sid):
    cur = get_current_user()
    if cur["role"] != "admin":
        return jsonify({"error": "Sem permissao"}), 403
    data = request.get_json() or {}
    db = get_db()
    for mk, enabled in data.items():
        db.execute("""
            INSERT INTO system_modules (system_id, module_key, enabled) VALUES (?,?,?)
            ON CONFLICT(system_id, module_key) DO UPDATE SET enabled=?
        """, (sid, mk, 1 if enabled else 0, 1 if enabled else 0))
    db.commit()
    return jsonify({"ok": True})

# ─── Portal ───────────────────────────────────

@app.route("/portal/<slug>")
def portal_page(slug):
    return send_from_directory(str(BASE_DIR), "portal.html")

@app.route("/api/portal/login", methods=["POST"])
def api_portal_login():
    data = request.get_json() or {}
    slug = data.get("slug", "").strip()
    password = data.get("password", "")
    if not slug or not password:
        return jsonify({"error": "slug e password obrigatorios"}), 400
    db = get_db()
    row = db.execute("SELECT * FROM systems WHERE slug=? AND active=1", (slug,)).fetchone()
    if not row:
        return jsonify({"error": "Portal nao encontrado"}), 404
    system = dict(row)
    if not check_password(password, system["portal_password_hash"]):
        return jsonify({"error": "Senha incorreta"}), 401
    modules = rows_to_list(db.execute(
        "SELECT module_key, enabled FROM system_modules WHERE system_id=?", (system["id"],)
    ).fetchall())
    system["modules"] = modules
    system.pop("portal_password_hash", None)
    return jsonify({"token": slug, "system": system})

@app.route("/api/portal/data")
def api_portal_data():
    auth = request.headers.get("Authorization", "")
    slug = auth.replace("Bearer ", "").strip()
    if not slug:
        return jsonify({"error": "Nao autorizado"}), 401
    db = get_db()
    row = db.execute("SELECT * FROM systems WHERE slug=? AND active=1", (slug,)).fetchone()
    if not row:
        return jsonify({"error": "Token invalido"}), 401
    system = dict(row)
    client_id = system.get("client_id")
    modules = rows_to_list(db.execute(
        "SELECT module_key, enabled FROM system_modules WHERE system_id=?", (system["id"],)
    ).fetchall())
    mod_dict = {m["module_key"]: m["enabled"] for m in modules}
    result = {"modules": mod_dict}
    if client_id:
        if mod_dict.get("dashboard"):
            p_count = db.execute("SELECT COUNT(*) as c FROM projects WHERE client_id=?", (client_id,)).fetchone()["c"]
            p_active = db.execute("SELECT COUNT(*) as c FROM projects WHERE client_id=? AND status='active'", (client_id,)).fetchone()["c"]
            p_completed = db.execute("SELECT COUNT(*) as c FROM projects WHERE client_id=? AND status='completed'", (client_id,)).fetchone()["c"]
            result["projects_summary"] = {"total": p_count, "active": p_active, "completed": p_completed}
        if mod_dict.get("projects"):
            result["projects"] = rows_to_list(db.execute(
                "SELECT * FROM projects WHERE client_id=? ORDER BY created_at", (client_id,)
            ).fetchall())
        if mod_dict.get("service_orders"):
            result["service_orders"] = rows_to_list(db.execute(
                "SELECT so.* FROM service_orders so JOIN projects p ON so.project_id=p.id WHERE p.client_id=? ORDER BY so.created_at", (client_id,)
            ).fetchall())
        if mod_dict.get("finance"):
            result["transactions"] = rows_to_list(db.execute(
                "SELECT * FROM transactions WHERE client_id=? ORDER BY date", (client_id,)
            ).fetchall())
        if mod_dict.get("calendar"):
            result["events"] = rows_to_list(db.execute(
                "SELECT * FROM calendar_events WHERE related_type='client' AND related_id=? ORDER BY date", (client_id,)
            ).fetchall())
        if mod_dict.get("files"):
            result["files"] = rows_to_list(db.execute(
                "SELECT * FROM user_files WHERE entity_type='client' AND entity_id=? ORDER BY created_at", (client_id,)
            ).fetchall())
    if mod_dict.get("developments"):
        result["developments"] = rows_to_list(db.execute(
            "SELECT * FROM developments ORDER BY name"
        ).fetchall())
        dev_ids = [d["id"] for d in result["developments"]]
        if dev_ids:
            placeholders = ",".join("?" * len(dev_ids))
            rows = db.execute(f"SELECT * FROM units WHERE development_id IN ({placeholders}) ORDER BY tower, number", dev_ids).fetchall()
            result["units"] = rows_to_list(rows)
            result["units_summary"] = {
                "total": len(result["units"]),
                "disponivel": sum(1 for u in result["units"] if u["status"] == "disponivel"),
                "reservado": sum(1 for u in result["units"] if u["status"] == "reservado"),
                "vendido": sum(1 for u in result["units"] if u["status"] == "vendido")
            }
    return jsonify(result)

# ─── Admin Portal ─────────────────────────────

def require_admin(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        auth = request.headers.get("Authorization", "")
        slug = auth.replace("Bearer ", "").strip()
        if not slug:
            return jsonify({"error": "Nao autorizado"}), 401
        db = get_db()
        row = db.execute("SELECT * FROM systems WHERE slug=? AND active=1 AND admin_password_hash != ''", (slug,)).fetchone()
        if not row:
            return jsonify({"error": "Token invalido"}), 401
        g.admin_system = dict(row)
        return f(*args, **kwargs)
    return decorated

@app.route("/api/admin/login", methods=["POST"])
def api_admin_login():
    data = request.get_json() or {}
    slug = data.get("slug", "").strip()
    password = data.get("password", "")
    if not slug or not password:
        return jsonify({"error": "slug e password obrigatorios"}), 400
    db = get_db()
    row = db.execute("SELECT * FROM systems WHERE slug=? AND active=1", (slug,)).fetchone()
    if not row:
        return jsonify({"error": "Sistema nao encontrado"}), 404
    system = dict(row)
    admin_hash = system.get("admin_password_hash", "")
    if not admin_hash or not check_password(password, admin_hash):
        return jsonify({"error": "Senha admin incorreta"}), 401
    return jsonify({"token": slug, "system": {"name": system["name"], "slug": system["slug"], "primary_color": system["primary_color"]}})

@app.route("/api/admin/developments")
@require_admin
def api_admin_developments():
    db = get_db()
    rows = db.execute("SELECT * FROM developments ORDER BY name").fetchall()
    result = []
    for r in rows:
        d = dict(r)
        brokers = db.execute("""
            SELECT bd.user_id, bd.commission_pct, u.name, u.email
            FROM broker_developments bd JOIN users u ON bd.user_id = u.id
            WHERE bd.development_id = ?
        """, (d["id"],)).fetchall()
        d["brokers"] = [dict(b) for b in brokers]
        result.append(d)
    return jsonify(result)

@app.route("/api/admin/developments/<int:dev_id>", methods=["PUT", "DELETE"])
@require_admin
def api_admin_development(dev_id):
    db = get_db()
    if request.method == "DELETE":
        db.execute("DELETE FROM units WHERE development_id=?", (dev_id,))
        db.execute("DELETE FROM broker_developments WHERE development_id=?", (dev_id,))
        db.execute("DELETE FROM developments WHERE id=?", (dev_id,))
        db.commit()
        return jsonify({"ok": True})
    data = request.get_json() or {}
    fields = ["name","builder","status","address","description","delivery_date","total_units","image_url"]
    sets = []
    vals = []
    for f in fields:
        if f in data:
            sets.append(f"{f}=?")
            vals.append(data[f])
    if sets:
        vals.append(dev_id)
        db.execute(f"UPDATE developments SET {','.join(sets)} WHERE id=?", vals)
        db.commit()
    return jsonify({"ok": True})

@app.route("/api/admin/developments", methods=["POST"])
@require_admin
def api_admin_create_development():
    data = request.get_json() or {}
    name = data.get("name", "").strip()
    if not name:
        return jsonify({"error": "Nome obrigatorio"}), 400
    db = get_db()
    db.execute("""
        INSERT INTO developments (name, builder, status, address, description, delivery_date, total_units, created_by)
        VALUES (?,?,?,?,?,?,?,?)
    """, (name, data.get("builder",""), data.get("status","lançamento"), data.get("address",""),
          data.get("description",""), data.get("delivery_date",""), int(data.get("total_units",0)), 0))
    db.commit()
    return jsonify({"ok": True, "id": db.execute("SELECT last_insert_rowid()").fetchone()[0]})

@app.route("/api/admin/developments/<int:dev_id>/units")
@require_admin
def api_admin_units(dev_id):
    db = get_db()
    rows = db.execute("SELECT * FROM units WHERE development_id=? ORDER BY tower, number", (dev_id,)).fetchall()
    return jsonify(rows_to_list(rows))

@app.route("/api/admin/developments/<int:dev_id>/units", methods=["POST"])
@require_admin
def api_admin_create_unit(dev_id):
    data = request.get_json() or {}
    number = data.get("number", "").strip()
    if not number:
        return jsonify({"error": "Numero da unidade obrigatorio"}), 400
    db = get_db()
    db.execute("""
        INSERT INTO units (development_id, tower, block, floor, number, area, bedrooms, suites, bathrooms, parking_spots, price, status, notes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    """, (dev_id, data.get("tower",""), data.get("block",""), data.get("floor",""), number,
          float(data.get("area",0)), int(data.get("bedrooms",0)), int(data.get("suites",0)),
          int(data.get("bathrooms",0)), int(data.get("parking_spots",0)),
          float(data.get("price",0)), data.get("status","disponivel"), data.get("notes","")))
    db.commit()
    unit_id = db.execute("SELECT last_insert_rowid()").fetchone()[0]
    db.execute("UPDATE developments SET total_units = (SELECT COUNT(*) FROM units WHERE development_id=?) WHERE id=?", (dev_id, dev_id))
    db.commit()
    return jsonify({"ok": True, "id": unit_id})

@app.route("/api/admin/developments/<int:dev_id>/units/<int:unit_id>", methods=["PUT", "DELETE"])
@require_admin
def api_admin_unit(dev_id, unit_id):
    db = get_db()
    if request.method == "DELETE":
        db.execute("DELETE FROM units WHERE id=? AND development_id=?", (unit_id, dev_id))
        db.commit()
        db.execute("UPDATE developments SET total_units = (SELECT COUNT(*) FROM units WHERE development_id=?) WHERE id=?", (dev_id, dev_id))
        db.commit()
        return jsonify({"ok": True})
    data = request.get_json() or {}
    fields = ["tower","block","floor","number","area","bedrooms","suites","bathrooms","parking_spots","price","status","notes"]
    sets = []
    vals = []
    for f in fields:
        if f in data:
            sets.append(f"{f}=?")
            vals.append(data[f])
    if sets:
        vals.append(unit_id)
        vals.append(dev_id)
        db.execute(f"UPDATE units SET {','.join(sets)} WHERE id=? AND development_id=?", vals)
        db.commit()
    return jsonify({"ok": True})

@app.route("/api/admin/developments/<int:dev_id>/brokers", methods=["GET", "POST"])
@require_admin
def api_admin_brokers(dev_id):
    db = get_db()
    if request.method == "POST":
        data = request.get_json() or {}
        user_id = data.get("user_id")
        pct = float(data.get("commission_pct", 3.0))
        if not user_id:
            return jsonify({"error": "user_id obrigatorio"}), 400
        db.execute("""
            INSERT INTO broker_developments (user_id, development_id, commission_pct)
            VALUES (?,?,?)
            ON CONFLICT(user_id, development_id) DO UPDATE SET commission_pct=?
        """, (user_id, dev_id, pct, pct))
        db.commit()
        return jsonify({"ok": True})
    rows = db.execute("""
        SELECT bd.user_id, bd.commission_pct, u.name, u.email
        FROM broker_developments bd JOIN users u ON bd.user_id = u.id
        WHERE bd.development_id = ?
    """, (dev_id,)).fetchall()
    return jsonify(rows_to_list(rows))

@app.route("/api/admin/developments/<int:dev_id>/brokers/<int:user_id>", methods=["DELETE"])
@require_admin
def api_admin_broker_delete(dev_id, user_id):
    db = get_db()
    db.execute("DELETE FROM broker_developments WHERE development_id=? AND user_id=?", (dev_id, user_id))
    db.commit()
    return jsonify({"ok": True})

@app.route("/api/admin/brokers")
@require_admin
def api_admin_brokers_list():
    db = get_db()
    rows = db.execute("SELECT id, name, email, role, phone FROM users WHERE role='broker' ORDER BY name").fetchall()
    return jsonify(rows_to_list(rows))

@app.route("/api/admin/stats")
@require_admin
def api_admin_stats():
    db = get_db()
    total_devs = db.execute("SELECT COUNT(*) as c FROM developments").fetchone()["c"]
    total_units = db.execute("SELECT COUNT(*) as c FROM units").fetchone()["c"]
    vendidos = db.execute("SELECT COUNT(*) as c FROM units WHERE status='vendido'").fetchone()["c"]
    disponiveis = db.execute("SELECT COUNT(*) as c FROM units WHERE status='disponivel'").fetchone()["c"]
    reservados = db.execute("SELECT COUNT(*) as c FROM units WHERE status='reservado'").fetchone()["c"]
    return jsonify({
        "developments": total_devs,
        "total_units": total_units,
        "disponivel": disponiveis,
        "reservado": reservados,
        "vendido": vendidos
    })

@app.route("/admin/<slug>")
def admin_portal_page(slug):
    return send_from_directory(str(BASE_DIR), "admin-portal.html")

# ─── Dashboard ───────────────────────────────

@app.route("/api/dashboard-html")
@require_auth
def api_dashboard_html():
    file_path = os.path.join(os.path.dirname(__file__), "dashboard_private.html")
    return send_file(file_path, mimetype="text/html")

@app.route("/api/dashboard")
@require_auth
def api_dashboard():
    db = get_db()
    today = today_str()
    month_start = datetime.now().replace(day=1).strftime("%Y-%m-%d")

    active_clients = db.execute("SELECT COUNT(*) as c FROM clients WHERE status='active'").fetchone()["c"]
    active_projects = db.execute("SELECT COUNT(*) as c FROM projects WHERE status='active'").fetchone()["c"]
    total_projects = db.execute("SELECT COUNT(*) as c FROM projects").fetchone()["c"]
    new_leads = db.execute("SELECT COUNT(*) as c FROM leads WHERE status='novo'").fetchone()["c"]

    revenue_month = db.execute(
        "SELECT COALESCE(SUM(value),0) as s FROM transactions WHERE type='income' AND date>=? AND status='completed'",
        (month_start,)
    ).fetchone()["s"]
    expenses_month = db.execute(
        "SELECT COALESCE(SUM(value),0) as s FROM transactions WHERE type='expense' AND date>=? AND status='completed'",
        (month_start,)
    ).fetchone()["s"]

    overdue = db.execute(
        "SELECT COUNT(*) as c FROM projects WHERE status='atrasado' OR (status='active' AND deadline IS NOT NULL AND deadline<?)",
        (today,)
    ).fetchone()["c"]

    revenue_by_month = db.execute(
        "SELECT strftime('%m',date) as mes, SUM(value) as total FROM transactions WHERE type='income' AND status='completed' AND date>=date('now','-11 months','start of month') GROUP BY mes ORDER BY mes"
    ).fetchall()
    expenses_by_month = db.execute(
        "SELECT strftime('%m',date) as mes, SUM(value) as total FROM transactions WHERE type='expense' AND status='completed' AND date>=date('now','-11 months','start of month') GROUP BY mes ORDER BY mes"
    ).fetchall()

    projects_by_status = db.execute(
        "SELECT CASE WHEN p.deadline IS NOT NULL AND p.deadline!='' AND p.deadline<? AND p.status!='completed' THEN 'atrasado' ELSE p.status END as status, COUNT(*) as total FROM projects p GROUP BY 1",
        (today,)
    ).fetchall()

    recent_projects = db.execute(
        "SELECT p.*, c.name as client_name FROM projects p LEFT JOIN clients c ON p.client_id=c.id WHERE p.deadline IS NOT NULL AND p.deadline!='' ORDER BY CASE WHEN p.status='completed' THEN 1 ELSE 0 END, p.deadline ASC LIMIT 5"
    ).fetchall()

    recent_activities = db.execute(
        "SELECT a.id, a.action, a.entity_type, a.entity_id, a.description, a.created_at, COALESCE(u.name, a.user_name) as user_name FROM activity_log a LEFT JOIN users u ON a.user_id=u.id ORDER BY a.created_at DESC LIMIT 10"
    ).fetchall()

    return jsonify({
        "active_clients": active_clients,
        "active_projects": active_projects,
        "total_projects": total_projects,
        "new_leads": new_leads,
        "revenue_month": revenue_month,
        "expenses_month": expenses_month,
        "profit_month": revenue_month - expenses_month,
        "overdue_projects": overdue,
        "revenue_by_month": rows_to_list(revenue_by_month),
        "expenses_by_month": rows_to_list(expenses_by_month),
        "projects_by_status": rows_to_list(projects_by_status),
        "recent_projects": rows_to_list(recent_projects),
        "recent_activities": rows_to_list(recent_activities)
    })

@app.route("/api/stats")
@require_auth
def api_stats():
    db = get_db()
    today = today_str()
    if not request.args.get("refresh"):
        db.execute("INSERT INTO visit_counter (date,count) VALUES (?,1) ON CONFLICT(date) DO UPDATE SET count=count+1", (today,))
        db.commit()
    today_visits = db.execute("SELECT COALESCE(SUM(count),0) FROM visit_counter WHERE date=?", (today,)).fetchone()[0]
    total_visits = db.execute("SELECT COALESCE(SUM(count),0) FROM visit_counter").fetchone()[0]
    diff = datetime.now() - SERVER_START
    d = diff.days
    h, rem = divmod(diff.seconds, 3600)
    m, s = divmod(rem, 60)
    uptime = f"{d}d {h}h {m}m {s}s"
    return jsonify({"today_visits": today_visits, "total_visits": total_visits, "uptime": uptime})

# ─── Clients ─────────────────────────────────

@app.route("/api/activity-log", methods=["GET"])
@require_auth
def api_activity_log():
    limit = request.args.get("limit", 100, type=int)
    entity = request.args.get("entity", "")
    action = request.args.get("action", "")
    db = get_db()
    q = "SELECT * FROM activity_log"
    params = []
    filters = []
    if entity:
        filters.append("entity_type=?")
        params.append(entity)
    if action:
        filters.append("action=?")
        params.append(action)
    if filters:
        q += " WHERE " + " AND ".join(filters)
    q += " ORDER BY created_at DESC LIMIT ?"
    params.append(limit)
    rows = db.execute(q, params).fetchall()
    return jsonify([dict(r) for r in rows])

@app.route("/api/clients", methods=["GET", "POST"])
@require_auth
def api_clients():
    db = get_db()
    if request.method == "POST":
        data = request.get_json() or {}
        db.execute(
            "INSERT INTO clients (name,email,phone,company,status,notes,tags,created_by) VALUES (?,?,?,?,?,?,?,?)",
            (data.get("name"), data.get("email"), data.get("phone"), data.get("company"),
             data.get("status","active"), data.get("notes"), data.get("tags"), get_current_user()["id"])
        )
        db.commit()
        cid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
        log_activity("criou", "cliente", cid, f"Cliente: {data.get('name')}")
        create_notification("success", "Novo Cliente", f"Cliente {data.get('name')} cadastrado.", "/clients")
        return jsonify({"ok": True, "id": cid})
    filters = []
    params = []
    q = request.args.get("q","")
    if q:
        filters.append("(name LIKE ? OR email LIKE ? OR company LIKE ?)")
        params.extend([f"%{q}%", f"%{q}%", f"%{q}%"])
    status = request.args.get("status","")
    if status and status != "todos":
        filters.append("status=?")
        params.append(status)
    where = (" WHERE " + " AND ".join(filters)) if filters else ""
    clients = db.execute(f"SELECT * FROM clients{where} ORDER BY name", params).fetchall()
    return jsonify(rows_to_list(clients))

@app.route("/api/clients/<int:cid>", methods=["GET", "PUT", "DELETE"])
@require_auth
def api_client(cid):
    db = get_db()
    if request.method == "DELETE":
        db.execute("DELETE FROM clients WHERE id=?", (cid,))
        db.commit()
        log_activity("excluiu", "cliente", cid, f"Cliente ID: {cid}")
        create_notification("warning", "Cliente Removido", f"Cliente ID {cid} foi excluído.")
        return jsonify({"ok": True})
    if request.method == "PUT":
        data = request.get_json() or {}
        fields = ["name=?","email=?","phone=?","company=?","status=?","notes=?","tags=?"]
        vals = [data.get(k,"") for k in ("name","email","phone","company","status","notes","tags")]
        vals.append(cid)
        db.execute(f"UPDATE clients SET {','.join(fields)} WHERE id=?", vals)
        db.commit()
        log_activity("editou", "cliente", cid, f"Cliente: {data.get('name')}")
        return jsonify({"ok": True})
    client = db.execute("SELECT * FROM clients WHERE id=?", (cid,)).fetchone()
    return jsonify(row_to_dict(client))

# ─── Projects ────────────────────────────────

@app.route("/api/projects", methods=["GET", "POST"])
@require_auth
def api_projects():
    db = get_db()
    if request.method == "POST":
        data = request.get_json() or {}
        db.execute(
            "INSERT INTO projects (name,client_id,type,status,deadline,value,description,created_by) VALUES (?,?,?,?,?,?,?,?)",
            (data.get("name"), data.get("client_id"), data.get("type"), data.get("status","pending"),
             data.get("deadline"), data.get("value",0), data.get("description"), get_current_user()["id"])
        )
        db.commit()
        pid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
        db.execute(
            "INSERT INTO project_status_log (project_id,from_status,to_status,changed_by) VALUES (?,NULL,?,?)",
            (pid, data.get("status","pending"), get_current_user()["id"])
        )
        db.commit()
        log_activity("criou", "projeto", pid, f"Projeto: {data.get('name')}")
        create_notification("success", "Novo Projeto", f"Projeto {data.get('name')} foi criado.", "/projects")
        return jsonify({"ok": True, "id": pid})
    filters = []
    params = []
    q = request.args.get("q","")
    if q:
        filters.append("p.name LIKE ?")
        params.append(f"%{q}%")
    status = request.args.get("status","")
    if status and status != "todos":
        if status == "atrasado":
            filters.append("p.deadline IS NOT NULL AND p.deadline!='' AND p.deadline<? AND p.status!='completed'")
            params.append(today_str())
        else:
            filters.append("p.status=?")
            params.append(status)
    ptype = request.args.get("type","")
    if ptype and ptype != "todos":
        filters.append("p.type=?")
        params.append(ptype)
    where = (" WHERE " + " AND ".join(filters)) if filters else ""
    projects = db.execute(
        f"SELECT p.*, c.name as client_name FROM projects p LEFT JOIN clients c ON p.client_id=c.id{where} ORDER BY p.created_at DESC",
        params
    ).fetchall()
    return jsonify(rows_to_list(projects))

@app.route("/api/projects/kanban", methods=["GET"])
@require_auth
def api_projects_kanban():
    db = get_db()
    projects = db.execute(
        "SELECT p.*, c.name as client_name, CASE WHEN p.deadline IS NOT NULL AND p.deadline!='' AND p.deadline<? AND p.status!='completed' THEN 'atrasado' ELSE p.status END as eff_status FROM projects p LEFT JOIN clients c ON p.client_id=c.id ORDER BY p.kanban_order, p.created_at DESC",
        (today_str(),)
    ).fetchall()
    cols = {}
    for p in projects:
        s = p["eff_status"] or "pending"
        cols.setdefault(s, []).append(row_to_dict(p))
    return jsonify(cols)

@app.route("/api/projects/kanban/reorder", methods=["POST"])
@require_auth
def api_projects_kanban_reorder():
    data = request.get_json() or {}
    items = data.get("items", [])
    db = get_db()
    for item in items:
        old = db.execute("SELECT name, status FROM projects WHERE id=?", (item["id"],)).fetchone()
        if not old: continue
        db.execute("UPDATE projects SET status=?, kanban_order=? WHERE id=?", (item.get("status"), item.get("order", 0), item["id"]))
        if old["status"] != item.get("status"):
            db.execute("INSERT INTO project_status_log (project_id,from_status,to_status,changed_by) VALUES (?,?,?,?)",
                       (item["id"], old["status"], item.get("status"), get_current_user()["id"]))
            log_activity("moveu", "projeto", item["id"], f"Projeto: {old['name']} de '{old['status']}' para '{item.get('status')}'")
            create_notification("info", "Projeto Movido", f"'{old['name']}' movido de {old['status']} para {item.get('status')}.")
    db.commit()
    return jsonify({"ok": True})

@app.route("/api/projects/<int:pid>", methods=["GET", "PUT", "DELETE"])
@require_auth
def api_project(pid):
    db = get_db()
    if request.method == "GET":
        proj = db.execute("SELECT p.*, c.name as client_name FROM projects p LEFT JOIN clients c ON p.client_id=c.id WHERE p.id=?", (pid,)).fetchone()
        if not proj: return jsonify({"error": "Projeto nao encontrado"}), 404
        return jsonify(row_to_dict(proj))
    if request.method == "DELETE":
        db.execute("DELETE FROM commissions WHERE project_id=?", (pid,))
        db.execute("DELETE FROM tasks WHERE service_order_id IN (SELECT id FROM service_orders WHERE project_id=?)", (pid,))
        db.execute("DELETE FROM service_orders WHERE project_id=?", (pid,))
        db.execute("DELETE FROM transactions WHERE project_id=?", (pid,))
        db.execute("DELETE FROM calendar_events WHERE related_type='project' AND related_id=?", (pid,))
        db.execute("DELETE FROM project_status_log WHERE project_id=?", (pid,))
        db.execute("DELETE FROM projects WHERE id=?", (pid,))
        db.commit()
        log_activity("excluiu", "projeto", pid, f"Projeto ID: {pid}")
        create_notification("warning", "Projeto Removido", f"Projeto ID {pid} foi excluído.")
        return jsonify({"ok": True})
    data = request.get_json() or {}
    fields = []
    vals = []
    for k in ("name","client_id","type","status","deadline","value","description"):
        if k in data:
            fields.append(f"{k}=?")
            vals.append(data[k])
    if fields:
        vals.append(pid)
        db.execute(f"UPDATE projects SET {','.join(fields)} WHERE id=?", vals)
        db.commit()
        name = data.get("name") or db.execute("SELECT name FROM projects WHERE id=?", (pid,)).fetchone()["name"]
        log_activity("editou", "projeto", pid, f"Projeto: {name}")
        create_notification("info", "Projeto Atualizado", f"Projeto {name} foi modificado.")
        return jsonify({"ok": True})

@app.route("/api/leads", methods=["GET", "POST"])
@require_auth
def api_leads():
    db = get_db()
    if request.method == "POST":
        data = request.get_json() or {}
        db.execute(
            "INSERT INTO leads (name,email,phone,company,source,status,value,notes,assigned_to) VALUES (?,?,?,?,?,?,?,?,?)",
            (data.get("name"), data.get("email"), data.get("phone"), data.get("company"),
             data.get("source"), data.get("status","novo"), data.get("value",0),
             data.get("notes"), data.get("assigned_to"))
        )
        db.commit()
        lid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
        log_activity("criou", "lead", lid, f"Lead: {data.get('name')}")
        create_notification("success", "Novo Lead", f"Lead {data.get('name')} cadastrado.", "/leads")
        return jsonify({"ok": True, "id": lid})
    filters = []
    params = []
    q = request.args.get("q","")
    if q:
        filters.append("(name LIKE ? OR email LIKE ? OR company LIKE ?)")
        params.extend([f"%{q}%", f"%{q}%", f"%{q}%"])
    status = request.args.get("status","")
    if status and status != "todos":
        filters.append("status=?")
        params.append(status)
    source = request.args.get("source","")
    if source and source != "todos":
        filters.append("source=?")
        params.append(source)
    where = (" WHERE " + " AND ".join(filters)) if filters else ""
    leads = db.execute(f"SELECT * FROM leads{where} ORDER BY created_at DESC", params).fetchall()
    return jsonify(rows_to_list(leads))

@app.route("/api/leads/<int:lid>", methods=["GET", "PUT", "DELETE"])
@require_auth
def api_lead(lid):
    db = get_db()
    if request.method == "DELETE":
        db.execute("DELETE FROM leads WHERE id=?", (lid,))
        db.commit()
        log_activity("excluiu", "lead", lid, f"Lead ID: {lid}")
        create_notification("warning", "Lead Removido", f"Lead ID {lid} foi excluído.")
        return jsonify({"ok": True})
    if request.method == "PUT":
        data = request.get_json() or {}
        log_activity("editou", "lead", lid, f"Lead: {data.get('name')}")
        fields = ["name=?","email=?","phone=?","company=?","source=?","status=?","value=?","notes=?","assigned_to=?"]
        vals = [data.get(k,"") for k in ("name","email","phone","company","source","status","value","notes","assigned_to")]
        vals.append(lid)
        db.execute(f"UPDATE leads SET {','.join(fields)} WHERE id=?", vals)
        db.commit()
        create_notification("info", "Lead Atualizado", f"Lead {data.get('name')} foi modificado.")
        return jsonify({"ok": True})
    lead = db.execute("SELECT * FROM leads WHERE id=?", (lid,)).fetchone()
    return jsonify(row_to_dict(lead))

@app.route("/api/leads/<int:lid>/convert", methods=["POST"])
@require_auth
def api_lead_convert(lid):
    db = get_db()
    lead = db.execute("SELECT * FROM leads WHERE id=?", (lid,)).fetchone()
    if not lead: return jsonify({"error": "Lead não encontrado"}), 404
    db.execute(
        "INSERT INTO clients (name,email,phone,company,status,notes,created_by) VALUES (?,?,?,?,?,?,?)",
        (lead["name"], lead["email"], lead["phone"], lead["company"], "active", lead["notes"], get_current_user()["id"])
    )
    cid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
    db.execute("UPDATE leads SET status='convertido', converted_client_id=? WHERE id=?", (cid, lid))
    db.commit()
    log_activity("converteu", "lead", lid, f"Lead: {lead['name']} convertido em Cliente ID {cid}")
    create_notification("success", "Lead Convertido", f"Lead {lead['name']} convertido em cliente!", "/clients")
    return jsonify({"ok": True, "client_id": cid})

# ─── Contracts ───────────────────────────────

@app.route("/api/contracts", methods=["GET", "POST"])
@require_auth
def api_contracts():
    db = get_db()
    if request.method == "POST":
        data = request.get_json() or {}
        db.execute(
            "INSERT INTO contracts (client_id,title,description,value,start_date,end_date,renewal_type,status,created_by) VALUES (?,?,?,?,?,?,?,?,?)",
            (data.get("client_id"), data.get("title"), data.get("description"),
             data.get("value",0), data.get("start_date"), data.get("end_date"),
             data.get("renewal_type","monthly"), data.get("status","active"),
             get_current_user()["id"])
        )
        db.commit()
        cid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
        log_activity("criou", "contrato", cid, f"Contrato: {data.get('title')}")
        create_notification("success", "Novo Contrato", f"Contrato {data.get('title')} criado.", "/contracts")
        return jsonify({"ok": True, "id": cid})
    filters = []
    params = []
    status = request.args.get("status","")
    if status and status != "todos":
        filters.append("c.status=?")
        params.append(status)
    q = request.args.get("q","")
    if q:
        filters.append("(c.title LIKE ? OR cl.name LIKE ?)")
        params.extend([f"%{q}%", f"%{q}%"])
    where = (" WHERE " + " AND ".join(filters)) if filters else ""
    contracts = db.execute(
        f"SELECT c.*, cl.name as client_name FROM contracts c LEFT JOIN clients cl ON c.client_id=cl.id{where} ORDER BY c.created_at DESC",
        params
    ).fetchall()
    return jsonify(rows_to_list(contracts))

@app.route("/api/contracts/<int:cid>", methods=["GET", "PUT", "DELETE"])
@require_auth
def api_contract(cid):
    db = get_db()
    if request.method == "DELETE":
        db.execute("DELETE FROM contracts WHERE id=?", (cid,))
        db.commit()
        log_activity("excluiu", "contrato", cid, f"Contrato ID: {cid}")
        create_notification("warning", "Contrato Removido", f"Contrato ID {cid} foi excluído.")
        return jsonify({"ok": True})
    if request.method == "PUT":
        data = request.get_json() or {}
        fields = ["client_id=?","title=?","description=?","value=?","start_date=?","end_date=?","renewal_type=?","status=?"]
        vals = [data.get(k,"") for k in ("client_id","title","description","value","start_date","end_date","renewal_type","status")]
        vals.append(cid)
        db.execute(f"UPDATE contracts SET {','.join(fields)} WHERE id=?", vals)
        db.commit()
        log_activity("editou", "contrato", cid, f"Contrato: {data.get('title')}")
        create_notification("info", "Contrato Atualizado", f"Contrato {data.get('title')} foi modificado.")
        return jsonify({"ok": True})
    contract = db.execute("SELECT c.*, cl.name as client_name FROM contracts c LEFT JOIN clients cl ON c.client_id=cl.id WHERE c.id=?", (cid,)).fetchone()
    return jsonify(row_to_dict(contract))

# ─── Service Orders ──────────────────────────

@app.route("/api/service-orders", methods=["GET", "POST"])
@require_auth
def api_service_orders():
    db = get_db()
    if request.method == "POST":
        data = request.get_json() or {}
        db.execute(
            "INSERT INTO service_orders (project_id,title,description,status,priority,assigned_to,deadline,estimated_hours,created_by) VALUES (?,?,?,?,?,?,?,?,?)",
            (data.get("project_id"), data.get("title"), data.get("description"),
             data.get("status","pending"), data.get("priority","media"),
             data.get("assigned_to"), data.get("deadline"),
             data.get("estimated_hours",0), get_current_user()["id"])
        )
        db.commit()
        sid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
        log_activity("criou", "servico", sid, f"Servico: {data.get('title')}")
        create_notification("info", "Nova OS", f"OS {data.get('title')} foi criada.", "/services")
        return jsonify({"ok": True, "id": sid})
    filters = []
    params = []
    status = request.args.get("status","")
    if status and status != "todos":
        filters.append("s.status=?")
        params.append(status)
    pid = request.args.get("project_id","")
    if pid:
        filters.append("s.project_id=?")
        params.append(pid)
    where = (" WHERE " + " AND ".join(filters)) if filters else ""
    orders = db.execute(
        f"SELECT s.*, p.name as project_name, u.name as assigned_name FROM service_orders s LEFT JOIN projects p ON s.project_id=p.id LEFT JOIN users u ON s.assigned_to=u.id{where} ORDER BY s.created_at DESC",
        params
    ).fetchall()
    return jsonify(rows_to_list(orders))

@app.route("/api/service-orders/<int:sid>", methods=["GET", "PUT", "DELETE"])
@require_auth
def api_service_order(sid):
    db = get_db()
    if request.method == "DELETE":
        db.execute("DELETE FROM tasks WHERE service_order_id=?", (sid,))
        db.execute("DELETE FROM service_orders WHERE id=?", (sid,))
        db.commit()
        log_activity("excluiu", "servico", sid, f"Servico ID: {sid}")
        create_notification("warning", "OS Removida", f"Ordem de serviço ID {sid} foi excluída.")
        return jsonify({"ok": True})
    if request.method == "PUT":
        data = request.get_json() or {}
        fields = ["project_id=?","title=?","description=?","status=?","priority=?","assigned_to=?","deadline=?","estimated_hours=?"]
        vals = [data.get(k,"") for k in ("project_id","title","description","status","priority","assigned_to","deadline","estimated_hours")]
        vals.append(sid)
        db.execute(f"UPDATE service_orders SET {','.join(fields)} WHERE id=?", vals)
        db.commit()
        log_activity("editou", "servico", sid, f"Servico: {data.get('title')}")
        create_notification("info", "OS Atualizada", f"OS {data.get('title')} foi modificada.")
        return jsonify({"ok": True})
    order = db.execute("SELECT s.*, p.name as project_name, u.name as assigned_name FROM service_orders s LEFT JOIN projects p ON s.project_id=p.id LEFT JOIN users u ON s.assigned_to=u.id WHERE s.id=?", (sid,)).fetchone()
    return jsonify(row_to_dict(order))

@app.route("/api/service-orders/<int:sid>/tasks", methods=["GET", "POST"])
@require_auth
def api_service_order_tasks(sid):
    db = get_db()
    if request.method == "POST":
        data = request.get_json() or {}
        db.execute(
            "INSERT INTO tasks (service_order_id,title,status,assigned_to,deadline) VALUES (?,?,?,?,?)",
            (sid, data.get("title"), data.get("status","pending"),
             data.get("assigned_to"), data.get("deadline"))
        )
        db.commit()
        tid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
        log_activity("criou", "tarefa", tid, f"Tarefa: {data.get('title')}")
        create_notification("info", "Nova Tarefa", f"Tarefa {data.get('title')} adicionada à OS #{sid}.")
        return jsonify({"ok": True, "id": tid})
    tasks = db.execute("SELECT * FROM tasks WHERE service_order_id=? ORDER BY order_idx, created_at", (sid,)).fetchall()
    return jsonify(rows_to_list(tasks))

# ─── Tasks ─────────────────────────────────

@app.route("/api/tasks/<int:tid>", methods=["GET", "PUT", "DELETE"])
@require_auth
def api_task(tid):
    db = get_db()
    if request.method == "DELETE":
        db.execute("DELETE FROM tasks WHERE id=?", (tid,))
        db.commit()
        log_activity("excluiu", "tarefa", tid, f"Tarefa ID: {tid}")
        return jsonify({"ok": True})
    if request.method == "PUT":
        data = request.get_json() or {}
        fields = ["title=?","status=?","assigned_to=?","deadline=?","order_idx=?"]
        vals = [data.get(k,"") for k in ("title","status","assigned_to","deadline","order_idx")]
        vals.append(tid)
        db.execute(f"UPDATE tasks SET {','.join(fields)} WHERE id=?", vals)
        db.commit()
        log_activity("editou", "tarefa", tid, f"Tarefa: {data.get('title')}")
        return jsonify({"ok": True})
    task = db.execute("SELECT * FROM tasks WHERE id=?", (tid,)).fetchone()
    return jsonify(row_to_dict(task))

# ─── Finance ─────────────────────────────────

@app.route("/api/finance/transactions", methods=["GET", "POST"])
@require_auth
def api_transactions():
    db = get_db()
    if request.method == "POST":
        data = request.get_json() or {}
        db.execute(
            "INSERT INTO transactions (description,type,category,value,date,client_id,project_id,payment_method,status,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (data.get("description"), data.get("type"), data.get("category"), data.get("value",0),
             data.get("date"), data.get("client_id"), data.get("project_id"),
             data.get("payment_method"), data.get("status","completed"),
             get_current_user()["id"])
        )
        db.commit()
        tid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
        # Auto commission for income
        if data.get("type") == "income" and data.get("commission_pct", 0) > 0:
            db.execute(
                "INSERT INTO commissions (user_id,project_id,transaction_id,value,percentage,status) VALUES (?,?,?,?,?,'pending')",
                (get_current_user()["id"], data.get("project_id"), tid,
                 data.get("value",0) * data.get("commission_pct",0) / 100,
                 data.get("commission_pct",0))
            )
        db.commit()
        log_activity("criou", "transacao", tid, f"Transacao: {data.get('description')}")
        tipo = "Receita" if data.get("type") == "income" else "Despesa"
        create_notification("info", f"Nova {tipo}", f"{tipo}: {data.get('description')} - R$ {data.get('value',0):.2f}", "/finance")
        return jsonify({"ok": True, "id": tid})
    filters = []
    params = []
    q = request.args.get("q","")
    if q:
        filters.append("(description LIKE ? OR category LIKE ?)")
        params.extend([f"%{q}%", f"%{q}%"])
    ttype = request.args.get("type","")
    if ttype and ttype != "todos":
        filters.append("type=?")
        params.append(ttype)
    category = request.args.get("category","")
    if category and category != "todos":
        filters.append("category=?")
        params.append(category)
    start = request.args.get("start","")
    if start:
        filters.append("date>=?")
        params.append(start)
    end = request.args.get("end","")
    if end:
        filters.append("date<=?")
        params.append(end)
    where = (" WHERE " + " AND ".join(filters)) if filters else ""
    transactions = db.execute(
        f"SELECT t.*, c.name as client_name, p.name as project_name FROM transactions t LEFT JOIN clients c ON t.client_id=c.id LEFT JOIN projects p ON t.project_id=p.id{where} ORDER BY t.date DESC, t.id DESC",
        params
    ).fetchall()
    return jsonify(rows_to_list(transactions))

@app.route("/api/finance/transactions/<int:tid>", methods=["PUT", "DELETE"])
@require_auth
def api_transaction(tid):
    db = get_db()
    if request.method == "DELETE":
        db.execute("DELETE FROM commissions WHERE transaction_id=?", (tid,))
        db.execute("DELETE FROM transactions WHERE id=?", (tid,))
        db.commit()
        log_activity("excluiu", "transacao", tid, f"Transacao ID: {tid}")
        create_notification("warning", "Transação Removida", f"Transação ID {tid} foi excluída.")
        return jsonify({"ok": True})
    data = request.get_json() or {}
    fields = ["description=?","type=?","category=?","value=?","date=?","client_id=?","project_id=?","payment_method=?","status=?"]
    vals = [data.get(k,"") for k in ("description","type","category","value","date","client_id","project_id","payment_method","status")]
    vals.append(tid)
    db.execute(f"UPDATE transactions SET {','.join(fields)} WHERE id=?", vals)
    db.commit()
    log_activity("editou", "transacao", tid, f"Transacao: {data.get('description')}")
    create_notification("info", "Transação Atualizada", f"Transação {data.get('description')} foi modificada.")
    return jsonify({"ok": True})

@app.route("/api/finance/summary")
@require_auth
def api_finance_summary():
    db = get_db()
    now = datetime.now()
    month_start = now.replace(day=1).strftime("%Y-%m-%d")
    year_start = now.replace(month=1, day=1).strftime("%Y-%m-%d")

    def sum_trans(type, start):
        return db.execute(
            "SELECT COALESCE(SUM(value),0) as s FROM transactions WHERE type=? AND date>=? AND status='completed'",
            (type, start)
        ).fetchone()["s"]

    revenue_month = sum_trans("income", month_start)
    expenses_month = sum_trans("expense", month_start)
    revenue_year = sum_trans("income", year_start)
    expenses_year = sum_trans("expense", year_start)

    categories_income = db.execute(
        "SELECT category, SUM(value) as total FROM transactions WHERE type='income' AND status='completed' GROUP BY category ORDER BY total DESC"
    ).fetchall()

    categories_expense = db.execute(
        "SELECT category, SUM(value) as total FROM transactions WHERE type='expense' AND status='completed' GROUP BY category ORDER BY total DESC"
    ).fetchall()

    return jsonify({
        "revenue_month": revenue_month,
        "expenses_month": expenses_month,
        "profit_month": revenue_month - expenses_month,
        "revenue_year": revenue_year,
        "expenses_year": expenses_year,
        "profit_year": revenue_year - expenses_year,
        "categories_income": rows_to_list(categories_income),
        "categories_expense": rows_to_list(categories_expense)
    })

@app.route("/api/finance/dre")
@require_auth
def api_finance_dre():
    db = get_db()
    year = request.args.get("year", str(datetime.now().year))
    months = []
    for m in range(1, 13):
        start = f"{year}-{m:02d}-01"
        end = f"{year}-{m:02d}-31"
        rev = db.execute("SELECT COALESCE(SUM(value),0) as s FROM transactions WHERE type='income' AND status='completed' AND date>=? AND date<=?", (start,end)).fetchone()["s"]
        exp = db.execute("SELECT COALESCE(SUM(value),0) as s FROM transactions WHERE type='expense' AND status='completed' AND date>=? AND date<=?", (start,end)).fetchone()["s"]
        months.append({"month": m, "month_name": datetime(2000,m,1).strftime("%b"), "revenue": rev, "expenses": exp, "profit": rev-exp})
    return jsonify({"year": year, "months": months})

@app.route("/api/finance/commissions")
@require_auth
def api_commissions():
    db = get_db()
    commissions = db.execute(
        "SELECT cm.*, u.name as user_name, p.name as project_name FROM commissions cm LEFT JOIN users u ON cm.user_id=u.id LEFT JOIN projects p ON cm.project_id=p.id ORDER BY cm.created_at DESC"
    ).fetchall()
    return jsonify(rows_to_list(commissions))

# ─── Notifications ───────────────────────────

@app.route("/api/notifications", methods=["GET"])
@require_auth
def api_notifications():
    db = get_db()
    user_id = get_current_user()["id"]
    notifs = db.execute(
        "SELECT * FROM notifications WHERE user_id=? OR user_id IS NULL ORDER BY created_at DESC LIMIT 50",
        (user_id,)
    ).fetchall()
    unread = db.execute(
        "SELECT COUNT(*) as c FROM notifications WHERE (user_id=? OR user_id IS NULL) AND read=0",
        (user_id,)
    ).fetchone()["c"]
    return jsonify({"notifications": rows_to_list(notifs), "unread": unread})

@app.route("/api/notifications/read", methods=["POST"])
@require_auth
def api_notifications_read():
    data = request.get_json() or {}
    db = get_db()
    nid = data.get("id")
    if nid:
        db.execute("UPDATE notifications SET read=1 WHERE id=?", (nid,))
    else:
        db.execute("UPDATE notifications SET read=1 WHERE user_id=? OR user_id IS NULL", (get_current_user()["id"],))
    db.commit()
    return jsonify({"ok": True})

@app.route("/api/notifications/<int:nid>", methods=["DELETE"])
@require_auth
def api_notification_delete(nid):
    db = get_db()
    n = db.execute("SELECT * FROM notifications WHERE id=?", (nid,)).fetchone()
    if not n:
        return jsonify({"error": "Notificacao nao encontrada"}), 404
    user = get_current_user()
    if n["user_id"] is not None and n["user_id"] != user["id"]:
        return jsonify({"error": "Sem permissao"}), 403
    db.execute("DELETE FROM notifications WHERE id=?", (nid,))
    db.commit()
    log_activity("excluiu", "notificacao", nid, f"Notificacao ID: {nid}")
    return jsonify({"ok": True})

@app.route("/api/notifications/send", methods=["POST"])
@require_auth
def api_send_notification():
    cur = get_current_user()
    if cur["role"] not in ("admin", "manager"):
        return jsonify({"error": "Sem permissao"}), 403
    data = request.get_json() or {}
    db = get_db()
    db.execute(
        "INSERT INTO notifications (user_id,type,title,message,link) VALUES (?,?,?,?,?)",
        (data.get("user_id"), data.get("type","info"), data.get("title"),
         data.get("message"), data.get("link",""))
    )
    db.commit()
    log_activity("criou", "notificacao", db.execute("SELECT last_insert_rowid()").fetchone()[0], f"Notificacao: {data.get('title')}")
    return jsonify({"ok": True})

# ─── Calendar ────────────────────────────────

@app.route("/api/calendar", methods=["GET", "POST"])
@require_auth
def api_calendar():
    db = get_db()
    if request.method == "POST":
        data = request.get_json() or {}
        db.execute(
            "INSERT INTO calendar_events (title,description,date,time,type,related_type,related_id,created_by) VALUES (?,?,?,?,?,?,?,?)",
            (data.get("title"), data.get("description"), data.get("date"),
             data.get("time"), data.get("type","evento"), data.get("related_type",""),
             data.get("related_id",0), get_current_user()["id"])
        )
        db.commit()
        eid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
        log_activity("criou", "evento", eid, f"Evento: {data.get('title')}")
        return jsonify({"ok": True, "id": eid})
    month = request.args.get("month", "")
    year = request.args.get("year", "")
    filters = []
    params = []
    if month and year:
        filters.append("strftime('%m',date)=? AND strftime('%Y',date)=?")
        params.extend([month.zfill(2), year])
    where = (" WHERE " + " AND ".join(filters)) if filters else ""
    events = db.execute(f"SELECT * FROM calendar_events{where} ORDER BY date, time", params).fetchall()
    tasks = db.execute(
        "SELECT id, title, deadline as date, status FROM tasks WHERE deadline IS NOT NULL AND deadline!=''"
        + (" AND strftime('%m',deadline)=? AND strftime('%Y',deadline)=?" if month and year else ""),
        ([month.zfill(2), year] if month and year else [])
    ).fetchall()
    all_items = rows_to_list(events) + [{"id":None,"title":t["title"],"date":t["date"],"time":"","type":"task","description":t["status"],"related_type":"","related_id":0,"created_by":0,"created_at":""} for t in tasks]
    if month and year:
        m = month.zfill(2)
        for mmdd, h in HOLIDAYS.items():
            if mmdd.startswith(m):
                all_items.append({"id":None,"title":h["title"],"date":f"{year}-{mmdd}","time":"","type":h["type"],"description":h["desc"],"related_type":"","related_id":0,"created_by":0,"created_at":""})
    return jsonify(all_items)

@app.route("/api/calendar/<int:eid>", methods=["PUT", "DELETE"])
@require_auth
def api_calendar_event(eid):
    db = get_db()
    if request.method == "DELETE":
        db.execute("DELETE FROM calendar_events WHERE id=?", (eid,))
        db.commit()
        log_activity("excluiu", "evento", eid, f"Evento ID: {eid}")
        return jsonify({"ok": True})
    data = request.get_json() or {}
    fields = ["title=?","description=?","date=?","time=?","type=?","related_type=?","related_id=?"]
    vals = [data.get(k,"") for k in ("title","description","date","time","type","related_type","related_id")]
    vals.append(eid)
    db.execute(f"UPDATE calendar_events SET {','.join(fields)} WHERE id=?", vals)
    db.commit()
    log_activity("editou", "evento", eid, f"Evento: {data.get('title')}")
    return jsonify({"ok": True})

# ─── Uploads & Files ─────────────────────────

@app.route("/api/upload/photo", methods=["POST"])
@require_auth
def api_upload_photo():
    file = request.files.get("file")
    if not file:
        return jsonify({"error": "Arquivo nao enviado"}), 400
    filename = uuid4().hex + Path(file.filename).suffix
    PHOTO_DIR = BASE_DIR / "backend" / "photos"
    PHOTO_DIR.mkdir(exist_ok=True)
    file.save(str(PHOTO_DIR / filename))
    log_activity("criou", "foto", 0, f"Foto: {file.filename}")
    return jsonify({"filename": filename})

@app.route("/api/photo/<path:filename>")
@require_auth
def api_photo(filename):
    photos_dir = BASE_DIR / "backend" / "photos"
    if not photos_dir.exists():
        photos_dir = BASE_DIR / "uploads"
    return send_from_directory(photos_dir, filename)

@app.route("/api/upload", methods=["POST"])
@require_auth
def api_upload_file():
    db = get_db()
    file = request.files.get("file")
    if not file:
        return jsonify({"error": "Arquivo nao enviado"}), 400
    entity_type = request.form.get("entity_type", "")
    entity_id = request.form.get("entity_id", 0, type=int)
    size = 0
    try:
        file.seek(0, 2)
        size = file.tell()
        file.seek(0)
    except:
        pass
    filename = uuid4().hex + Path(file.filename).suffix
    UPLOAD_DIR = BASE_DIR / "uploads"
    UPLOAD_DIR.mkdir(exist_ok=True)
    file.save(str(UPLOAD_DIR / filename))
    user_id = get_current_user()["id"]
    db.execute(
        "INSERT INTO user_files (user_id,filename,original_name,size,entity_type,entity_id) VALUES (?,?,?,?,?,?)",
        (user_id, filename, file.filename, size, entity_type, entity_id)
    )
    db.commit()
    fid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
    log_activity("criou", "arquivo", fid, f"Arquivo: {file.filename}")
    return jsonify({"filename": filename})

@app.route("/api/files", methods=["GET"])
@require_auth
def api_list_files():
    db = get_db()
    entity_type = request.args.get("entity_type", "")
    entity_id = request.args.get("entity_id", 0, type=int)
    q = "SELECT uf.*, u.name as user_name FROM user_files uf LEFT JOIN users u ON uf.user_id=u.id WHERE uf.entity_type=? AND uf.entity_id=? ORDER BY uf.created_at DESC"
    rows = db.execute(q, (entity_type, entity_id)).fetchall()
    return jsonify([dict(r) for r in rows])

@app.route("/api/files/<int:fid>", methods=["DELETE"])
@require_auth
def api_delete_file(fid):
    db = get_db()
    row = db.execute("SELECT * FROM user_files WHERE id=?", (fid,)).fetchone()
    if not row:
        return jsonify({"error": "Arquivo nao encontrado"}), 404
    db.execute("DELETE FROM user_files WHERE id=?", (fid,))
    db.commit()
    log_activity("excluiu", "arquivo", fid, f"Arquivo: {row['original_name']}")
    return jsonify({"ok": True})

@app.route("/api/files/<int:fid>/download")
@require_auth
def api_download_file(fid):
    row = get_db().execute("SELECT * FROM user_files WHERE id=?", (fid,)).fetchone()
    if not row:
        return jsonify({"error": "Arquivo nao encontrado"}), 404
    return send_from_directory(BASE_DIR / "uploads", row["filename"], as_attachment=True, download_name=row["original_name"])

@app.route("/api/uploads/<path:filename>")
@require_auth
def api_serve_upload(filename):
    return send_from_directory(BASE_DIR / "uploads", filename)

# ─── Marketing ───────────────────────────────

@app.route("/api/marketing/meta/ads", methods=["GET"])
@require_auth
def api_meta_ads():
    return jsonify({"error": "API da Meta nao configurada. Configure em Marketing > Meta Ads."}), 501

@app.route("/api/marketing/google/ads", methods=["GET"])
@require_auth
def api_google_ads():
    return jsonify({"error": "Google Ads API nao configurada. Configure em Integracoes."}), 501

# ─── Client Plans ──────────────────────────

@app.route("/api/client-plans", methods=["GET"])
@require_auth
def api_client_plans_list():
    db = get_db()
    cid = request.args.get("client_id", "")
    q = """SELECT cp.*, p.name as plan_name, p.price as plan_price, p.billing_cycle,
                  p.features, p.description as plan_description,
                  cl.name as client_name
           FROM client_plans cp
           JOIN plans p ON cp.plan_id=p.id
           LEFT JOIN clients cl ON cp.client_id=cl.id"""
    params = []
    if cid:
        q += " WHERE cp.client_id=?"
        params.append(int(cid))
    q += " ORDER BY cp.created_at DESC"
    rows = db.execute(q, params).fetchall()
    result = []
    for r in rows:
        d = dict(r)
        if isinstance(d.get("features"), str):
            try: d["features"] = json.loads(d["features"])
            except: d["features"] = []
        result.append(d)
    return jsonify(result)

@app.route("/api/client-plans", methods=["POST"])
@require_auth
def api_client_plans_create():
    data = request.get_json() or {}
    client_id = data.get("client_id")
    plan_id = data.get("plan_id")
    if not client_id or not plan_id:
        return jsonify({"error": "Cliente e plano obrigatorios"}), 400
    db = get_db()
    db.execute(
        "INSERT INTO client_plans (client_id,plan_id,status,price_override,start_date,end_date,auto_renew) VALUES (?,?,?,?,?,?,?)",
        (client_id, plan_id, data.get("status","active"),
         data.get("price_override"), data.get("start_date"),
         data.get("end_date"), 1 if data.get("auto_renew", True) else 0)
    )
    db.commit()
    cpid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
    create_notification("success", "Plano Atribuido", f"Plano vinculado ao cliente ID {client_id}.", "/clients")
    log_activity("create", "client_plan", cpid, f"Plano ID {plan_id} -> Cliente ID {client_id}")
    return jsonify({"ok": True, "id": cpid}), 201

@app.route("/api/client-plans/<int:cpid>", methods=["PUT", "DELETE"])
@require_auth
def api_client_plans_item(cpid):
    db = get_db()
    if request.method == "DELETE":
        db.execute("DELETE FROM client_plans WHERE id=?", (cpid,))
        db.commit()
        log_activity("excluiu", "plano_cliente", cpid, f"ClientPlan ID: {cpid}")
        return jsonify({"ok": True})
    data = request.get_json() or {}
    fields = []
    vals = []
    for k in ("status","price_override","start_date","end_date","auto_renew","plan_id"):
        if k in data:
            fields.append(f"{k}=?")
            vals.append(data[k])
    if fields:
        vals.append(cpid)
        db.execute(f"UPDATE client_plans SET {','.join(fields)} WHERE id=?", vals)
        db.commit()
        log_activity("editou", "plano_cliente", cpid, f"ClientPlan ID: {cpid}")
    return jsonify({"ok": True})

# ─── Chat AI ───────────────────────────────

CONVERSATIONS = {}

@app.route("/api/chat", methods=["POST"])
@require_auth
def chat():
    data = request.get_json() or {}
    msg = (data.get("message") or "").strip()
    history = data.get("history") or []
    if not msg:
        return jsonify({"response": "Digite uma mensagem."})

    user = get_current_user()
    uid = str(user["id"])
    if uid not in CONVERSATIONS:
        CONVERSATIONS[uid] = []

    db = get_db()
    ctx = {}
    try:
        ctx["clients"] = db.execute("SELECT COUNT(*) c FROM clients").fetchone()["c"]
        ctx["projects"] = db.execute("SELECT COUNT(*) c FROM projects").fetchone()["c"]
        ctx["leads"] = db.execute("SELECT COUNT(*) c FROM leads").fetchone()["c"]
        ctx["revenue"] = db.execute("SELECT COALESCE(SUM(value),0) FROM transactions WHERE type='income'").fetchone()[0]
        ctx["expenses"] = db.execute("SELECT COALESCE(SUM(value),0) FROM transactions WHERE type='expense'").fetchone()[0]
        ctx["contracts"] = db.execute("SELECT COUNT(*) c FROM contracts").fetchone()["c"]
        ctx["services"] = db.execute("SELECT COUNT(*) c FROM service_orders").fetchone()["c"]
        ctx["users"] = db.execute("SELECT COUNT(*) c FROM users WHERE active=1").fetchone()["c"]
        ctx["team"] = db.execute("SELECT name, role FROM users WHERE active=1").fetchall()
        ctx["recent"] = db.execute("SELECT title, status, deadline, value FROM projects ORDER BY id DESC LIMIT 5").fetchall()
        ctx["user_name"] = user.get("name", "Usuário")
    except:
        pass

    try:
        import urllib.request as ureq
        import json as ujson
        ollama_payload = ujson.dumps({
            "model": "llama3.2:latest",
            "messages": [
                {"role": "system", "content": f"Você é um assistente especialista em gestão de agências/projetos. Responda em português de forma clara e concisa. Contexto atual do sistema: {json.dumps(ctx, default=str)}"},
                *[{"role": m["role"], "content": m["content"]} for m in history[-10:]],
                {"role": "user", "content": msg}
            ],
            "stream": False
        }).encode()
        req = ureq.Request("http://localhost:11434/api/chat", data=ollama_payload, headers={"Content-Type": "application/json"})
        resp = ureq.urlopen(req, timeout=10)
        result = ujson.loads(resp.read())
        reply = result["message"]["content"]
    except:
        msg_lower = msg.lower()
        reply = ""
        if any(w in msg_lower for w in ["cliente", "clientes", "quantos cliente"]):
            reply = f"📊 Atualmente você tem **{ctx.get('clients',0)} clientes** cadastrados no sistema."
        elif any(w in msg_lower for w in ["projeto", "projetos", "quantos projeto"]):
            reply = f"📊 Existem **{ctx.get('projects',0)} projetos** registrados."
        elif any(w in msg_lower for w in ["lead", "leads", "quanto lead"]):
            reply = f"📊 Você possui **{ctx.get('leads',0)} leads** no funil de vendas."
        elif any(w in msg_lower for w in ["faturamento", "receita", "receitas", "faturei"]):
            reply = f"💰 O faturamento total é de **R$ {ctx.get('revenue',0):,.2f}** e as despesas somam **R$ {ctx.get('expenses',0):,.2f}**."
        elif any(w in msg_lower for w in ["contrato", "contratos"]):
            reply = f"📄 Há **{ctx.get('contracts',0)} contratos** registrados."
        elif any(w in msg_lower for w in ["equipe", "time", "pessoas", "funcionario", "colaborador"]):
            team = ctx.get("team", [])
            if team:
                names = "\n".join(f"  • {m['name']} ({m['role']})" for m in team)
                reply = f"👥 Sua equipe tem **{len(team)} membros** ativos:\n{names}"
            else:
                reply = "👥 Nenhum membro ativo na equipe."
        elif any(w in msg_lower for w in ["ajuda", "help", "comando", "o que voce faz", "pode fazer"]):
            reply = (
                "🤖 **Olá!** Sou o assistente do Promake. Posso ajudar com:\n\n"
                "• 📊 **Visão geral**: clientes, projetos, leads, financeiro\n"
                "• 📋 **Consultas rápidas**: contratos, equipe, serviços\n"
                "• 💰 **Financeiro**: faturamento, despesas, lucro\n"
                "• 📈 **Relatórios**: resumo do sistema\n\n"
                "Basta perguntar! Exemplo: *\"Quantos clientes ativos?\"*"
            )
        elif any(w in msg_lower for w in ["oi", "olá", "ola", "bom dia", "boa tarde", "boa noite", "hey"]):
            reply = f"Olá, {ctx.get('user_name','')}! 👋 Como posso ajudar na gestão da sua agência hoje?"
        else:
            reply = (
                f"Desculpe, não entendi sua pergunta sobre \"{msg[:60]}\". "
                f"Tente perguntar sobre: **clientes, projetos, leads, financeiro, contratos, equipe** "
                f"ou digite **\"ajuda\"** para ver o que posso fazer."
            )

    CONVERSATIONS[uid].append({"role": "user", "content": msg})
    CONVERSATIONS[uid].append({"role": "assistant", "content": reply})
    if len(CONVERSATIONS[uid]) > 50:
        CONVERSATIONS[uid] = CONVERSATIONS[uid][-50:]

    return jsonify({"response": reply})

# ─── Slides ─────────────────────────────────

@app.route("/api/slides/public")
def api_slides_public():
    db = get_db()
    rows = db.execute(
        "SELECT * FROM slides WHERE active=1 ORDER BY sort_order ASC, id ASC"
    ).fetchall()
    return jsonify([dict(r) for r in rows])

@app.route("/api/slides")
@require_auth
def api_slides_list():
    cur = get_current_user()
    if cur["role"] != "admin":
        return jsonify({"error": "Sem permissao"}), 403
    db = get_db()
    rows = db.execute(
        "SELECT * FROM slides ORDER BY sort_order ASC, id ASC"
    ).fetchall()
    return jsonify([dict(r) for r in rows])

@app.route("/api/slides", methods=["POST"])
@require_auth
def api_slides_create():
    cur = get_current_user()
    if cur["role"] != "admin":
        return jsonify({"error": "Sem permissao"}), 403
    data = request.get_json(silent=True) or {}
    db = get_db()
    db.execute(
        """INSERT INTO slides (image_url,title,subtitle,badge_text,badge_icon,link_text,link_url,btn2_text,btn2_url,sort_order,active)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            data.get("image_url", ""),
            data.get("title", ""),
            data.get("subtitle", ""),
            data.get("badge_text", ""),
            data.get("badge_icon", "fas fa-crown"),
            data.get("link_text", "Acessar Agora"),
            data.get("link_url", ""),
            data.get("btn2_text", ""),
            data.get("btn2_url", ""),
            data.get("sort_order", 0),
            data.get("active", 1)
        )
    )
    db.commit()
    sid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
    row = db.execute("SELECT * FROM slides WHERE id=?", (sid,)).fetchone()
    log_activity("criou", "slide", sid, f"Slide: {data.get('title','')}")
    return jsonify(dict(row)), 201

@app.route("/api/slides/<int:sid>", methods=["PUT"])
@require_auth
def api_slides_update(sid):
    cur = get_current_user()
    if cur["role"] != "admin":
        return jsonify({"error": "Sem permissao"}), 403
    data = request.get_json(silent=True) or {}
    db = get_db()
    db.execute(
        """UPDATE slides SET image_url=?,title=?,subtitle=?,badge_text=?,badge_icon=?,link_text=?,link_url=?,btn2_text=?,btn2_url=?,sort_order=?,active=?
           WHERE id=?""",
        (
            data.get("image_url", ""),
            data.get("title", ""),
            data.get("subtitle", ""),
            data.get("badge_text", ""),
            data.get("badge_icon", "fas fa-crown"),
            data.get("link_text", "Acessar Agora"),
            data.get("link_url", ""),
            data.get("btn2_text", ""),
            data.get("btn2_url", ""),
            data.get("sort_order", 0),
            data.get("active", 1),
            sid
        )
    )
    db.commit()
    row = db.execute("SELECT * FROM slides WHERE id=?", (sid,)).fetchone()
    log_activity("editou", "slide", sid, f"Slide: {data.get('title','')}")
    return jsonify(dict(row)) if row else jsonify({"error": "Not found"}), 404

@app.route("/api/slides/<int:sid>", methods=["DELETE"])
@require_auth
def api_slides_delete(sid):
    cur = get_current_user()
    if cur["role"] != "admin":
        return jsonify({"error": "Sem permissao"}), 403
    db = get_db()
    db.execute("DELETE FROM slides WHERE id=?", (sid,))
    db.commit()
    log_activity("excluiu", "slide", sid, "Slide excluido")
    return jsonify({"ok": True})

# ─── Landing Page Config ────────────────────

@app.route("/api/landing/config")
def api_landing_config():
    db = get_db()
    rows = db.execute("SELECT section, key, value FROM landing_config").fetchall()
    config = {}
    for r in rows:
        sec = r["section"]
        if sec not in config:
            config[sec] = {}
        config[sec][r["key"]] = r["value"]
    return jsonify(config)

@app.route("/api/landing/config", methods=["PUT"])
@require_auth
def api_landing_config_update():
    cur = get_current_user()
    if cur["role"] != "admin":
        return jsonify({"error": "Sem permissao"}), 403
    data = request.get_json(silent=True) or {}
    db = get_db()
    for section, pairs in data.items():
        if not isinstance(pairs, dict):
            continue
        for key, value in pairs.items():
            if isinstance(value, str):
                existing = db.execute("SELECT 1 FROM landing_config WHERE section=? AND key=?", (section, key)).fetchone()
                if existing:
                    db.execute("UPDATE landing_config SET value=? WHERE section=? AND key=?", (value, section, key))
                else:
                    db.execute("INSERT INTO landing_config (section,key,value) VALUES (?,?,?)", (section, key, value))
    db.commit()
    log_activity("editou", "config", 0, "Landing page config atualizada")
    rows = db.execute("SELECT section, key, value FROM landing_config").fetchall()
    config = {}
    for r in rows:
        sec = r["section"]
        if sec not in config:
            config[sec] = {}
        config[sec][r["key"]] = r["value"]
    return jsonify(config)

# ─── Painel Criativo (Miro-style board) ────

@app.route("/api/design-projects", methods=["GET","POST"])
@require_auth
def api_design_projects():
    db = get_db()
    if request.method == "POST":
        data = request.get_json() or {}
        cur = get_current_user()
        db.execute("INSERT INTO design_projects (name,description,client_name,deadline,created_by) VALUES (?,?,?,?,?)",
            (data.get("name"), data.get("description",""), data.get("client_name",""), data.get("deadline"), cur["id"]))
        db.commit()
        pid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
        log_activity("criou", "design_project", pid, f"Projeto criativo: {data.get('name')}")
        return jsonify({"ok":True, "id":pid})
    rows = db.execute("SELECT * FROM design_projects ORDER BY created_at DESC").fetchall()
    return jsonify(rows_to_list(rows))

@app.route("/api/design-projects/<int:pid>", methods=["GET","PUT","DELETE"])
@require_auth
def api_design_project(pid):
    db = get_db()
    if request.method == "DELETE":
        db.execute("DELETE FROM design_timeline_items WHERE project_id=?", (pid,))
        db.execute("DELETE FROM design_stage_links WHERE project_id=?", (pid,))
        db.execute("DELETE FROM design_stages WHERE project_id=?", (pid,))
        db.execute("DELETE FROM design_notes WHERE project_id=?", (pid,))
        db.execute("DELETE FROM design_cards WHERE project_id=?", (pid,))
        db.execute("DELETE FROM design_projects WHERE id=?", (pid,))
        db.commit()
        log_activity("excluiu", "design_project", pid)
        return jsonify({"ok":True})
    if request.method == "PUT":
        data = request.get_json() or {}
        db.execute("UPDATE design_projects SET name=?,description=?,client_name=?,deadline=?,status=? WHERE id=?",
            (data.get("name"), data.get("description",""), data.get("client_name",""), data.get("deadline"), data.get("status","active"), pid))
        db.commit()
        log_activity("editou", "design_project", pid)
        return jsonify({"ok":True})
    row = db.execute("SELECT * FROM design_projects WHERE id=?", (pid,)).fetchone()
    return jsonify(row_to_dict(row))

@app.route("/api/design-projects/<int:pid>/cards", methods=["GET","POST"])
@require_auth
def api_design_cards(pid):
    db = get_db()
    if request.method == "POST":
        data = request.get_json() or {}
        cur = get_current_user()
        max_order = db.execute("SELECT COALESCE(MAX(order_idx),-1) FROM design_cards WHERE project_id=? AND stage=?", (pid, data.get("stage","briefing"))).fetchone()[0]
        db.execute("INSERT INTO design_cards (project_id,title,description,stage,color_tag,deadline,assigned_to,order_idx,created_by) VALUES (?,?,?,?,?,?,?,?,?)",
            (pid, data.get("title"), data.get("description",""), data.get("stage","briefing"), data.get("color_tag",""), data.get("deadline"), data.get("assigned_to",""), max_order+1, cur["id"]))
        db.commit()
        cid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
        return jsonify({"ok":True, "id":cid})
    rows = db.execute("SELECT * FROM design_cards WHERE project_id=? ORDER BY order_idx", (pid,)).fetchall()
    return jsonify(rows_to_list(rows))

@app.route("/api/design-cards/reorder", methods=["PUT"])
@require_auth
def api_design_cards_reorder():
    data = request.get_json() or {}
    items = data.get("items", [])
    db = get_db()
    for item in items:
        db.execute("UPDATE design_cards SET stage=?, order_idx=? WHERE id=?", (item["stage"], item["order"], item["id"]))
    db.commit()
    return jsonify({"ok":True})

@app.route("/api/design-cards/<int:cid>", methods=["PUT","DELETE"])
@require_auth
def api_design_card(cid):
    db = get_db()
    if request.method == "DELETE":
        db.execute("DELETE FROM design_cards WHERE id=?", (cid,))
        db.commit()
        return jsonify({"ok":True})
    data = request.get_json() or {}
    db.execute("UPDATE design_cards SET title=?,description=?,stage=?,color_tag=?,deadline=?,assigned_to=? WHERE id=?",
        (data.get("title"), data.get("description",""), data.get("stage","briefing"), data.get("color_tag",""), data.get("deadline"), data.get("assigned_to",""), cid))
    db.commit()
    return jsonify({"ok":True})

# ─── Design Stages (Timeline) ─────────────

@app.route("/api/design-projects/<int:pid>/stages", methods=["GET","POST"])
@require_auth
def api_design_stages(pid):
    db = get_db()
    if request.method == "POST":
        try:
            data = request.get_json() or {}
            cur = get_current_user()
            max_order = db.execute("SELECT COALESCE(MAX(order_idx),-1) FROM design_stages WHERE project_id=?", (pid,)).fetchone()[0]
            db.execute("INSERT INTO design_stages (project_id,title,description,color,order_idx,created_by) VALUES (?,?,?,?,?,?)",
                (pid, data.get("title"), data.get("description",""), data.get("color","#6C5CE7"), max_order+1, cur["id"]))
            db.commit()
            sid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
            return jsonify({"ok":True, "id":sid})
        except Exception as e:
            db.rollback()
            return jsonify({"error": str(e)}), 500
    rows = db.execute("SELECT * FROM design_stages WHERE project_id=? ORDER BY order_idx", (pid,)).fetchall()
    return jsonify(rows_to_list(rows))

@app.route("/api/design-stages/<int:sid>", methods=["PUT","DELETE"])
@require_auth
def api_design_stage(sid):
    db = get_db()
    if request.method == "DELETE":
        db.execute("DELETE FROM design_timeline_items WHERE stage_id=?", (sid,))
        db.execute("DELETE FROM design_stages WHERE id=?", (sid,))
        db.commit()
        return jsonify({"ok":True})
    data = request.get_json() or {}
    db.execute("UPDATE design_stages SET title=?,description=?,color=?,locked=?,order_idx=?,x=?,y=?,width=? WHERE id=?",
        (data.get("title"), data.get("description",""), data.get("color","#6C5CE7"), data.get("locked",0), data.get("order_idx",0), data.get("x",0), data.get("y",0), data.get("width",260), sid))
    db.commit()
    return jsonify({"ok":True})

@app.route("/api/design-stages/<int:sid>/lock", methods=["POST"])
@require_auth
def api_design_stage_lock(sid):
    data = request.get_json() or {}
    db = get_db()
    db.execute("UPDATE design_stages SET locked=? WHERE id=?", (1 if data.get("locked") else 0, sid))
    db.commit()
    return jsonify({"ok":True})

@app.route("/api/design-stages/<int:sid>/position", methods=["PUT"])
@require_auth
def api_design_stage_position(sid):
    data = request.get_json() or {}
    db = get_db()
    db.execute("UPDATE design_stages SET x=?, y=? WHERE id=?", (data.get("x", 0), data.get("y", 0), sid))
    db.commit()
    return jsonify({"ok":True})

@app.route("/api/design-projects/<int:pid>/links", methods=["GET","POST"])
@require_auth
def api_design_stage_links(pid):
    db = get_db()
    if request.method == "POST":
        data = request.get_json() or {}
        from_sid = data.get("from_stage_id")
        to_sid = data.get("to_stage_id")
        if not from_sid or not to_sid:
            return jsonify({"error":"from_stage_id e to_stage_id obrigatorios"}), 400
        if from_sid == to_sid:
            return jsonify({"error":"Nao pode linkar consigo mesmo"}), 400
        exists = db.execute("SELECT 1 FROM design_stage_links WHERE from_stage_id=? AND to_stage_id=?", (from_sid, to_sid)).fetchone()
        if exists:
            return jsonify({"error":"Link ja existe"}), 400
        db.execute("INSERT INTO design_stage_links (project_id,from_stage_id,to_stage_id) VALUES (?,?,?)",
            (pid, from_sid, to_sid))
        db.commit()
        lid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
        return jsonify({"ok":True, "id":lid})
    rows = db.execute("SELECT * FROM design_stage_links WHERE project_id=?", (pid,)).fetchall()
    return jsonify(rows_to_list(rows))

@app.route("/api/design-stage-links/<int:lid>", methods=["DELETE"])
@require_auth
def api_design_stage_link_delete(lid):
    db = get_db()
    db.execute("DELETE FROM design_stage_links WHERE id=?", (lid,))
    db.commit()
    return jsonify({"ok":True})

@app.route("/api/design-stage-links/by-stages", methods=["DELETE"])
@require_auth
def api_design_stage_link_delete_by_stages():
    data = request.get_json() or {}
    from_sid = data.get("from_stage_id")
    to_sid = data.get("to_stage_id")
    if not from_sid or not to_sid:
        return jsonify({"error":"from_stage_id e to_stage_id obrigatorios"}), 400
    db = get_db()
    db.execute("DELETE FROM design_stage_links WHERE from_stage_id=? AND to_stage_id=?", (from_sid, to_sid))
    db.commit()
    return jsonify({"ok":True})

@app.route("/api/design-projects/<int:pid>/timeline-items", methods=["GET","POST"])
@require_auth
def api_design_timeline_items(pid):
    db = get_db()
    if request.method == "POST":
        data = request.get_json() or {}
        cur = get_current_user()
        max_order = db.execute("SELECT COALESCE(MAX(order_idx),-1) FROM design_timeline_items WHERE project_id=? AND stage_id=?", (pid, data.get("stage_id"))).fetchone()[0]
        db.execute("INSERT INTO design_timeline_items (project_id,stage_id,title,description,status,color_tag,assigned_to,url,order_idx,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (pid, data.get("stage_id"), data.get("title"), data.get("description",""), data.get("status","pendente"), data.get("color_tag",""), data.get("assigned_to",""), data.get("url",""), max_order+1, cur["id"]))
        db.commit()
        iid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
        return jsonify({"ok":True, "id":iid})
    rows = db.execute("SELECT * FROM design_timeline_items WHERE project_id=? ORDER BY order_idx", (pid,)).fetchall()
    return jsonify(rows_to_list(rows))

@app.route("/api/design-timeline-items/<int:iid>", methods=["PUT","DELETE"])
@require_auth
def api_design_timeline_item(iid):
    db = get_db()
    if request.method == "DELETE":
        db.execute("DELETE FROM design_timeline_items WHERE id=?", (iid,))
        db.commit()
        return jsonify({"ok":True})
    data = request.get_json() or {}
    floating = data.get("floating")
    if floating is not None:
        db.execute("UPDATE design_timeline_items SET floating=?,float_x=?,float_y=?,width=? WHERE id=?",
            (1 if floating else 0, data.get("float_x",0), data.get("float_y",0), data.get("width",230), iid))
    else:
        db.execute("UPDATE design_timeline_items SET title=?,description=?,status=?,color_tag=?,assigned_to=?,url=?,stage_id=?,order_idx=?,width=? WHERE id=?",
            (data.get("title"), data.get("description",""), data.get("status","pendente"), data.get("color_tag",""), data.get("assigned_to",""), data.get("url",""), data.get("stage_id"), data.get("order_idx",0), data.get("width",230), iid))
    db.commit()
    return jsonify({"ok":True})

@app.route("/api/design-timeline-items/<int:iid>/float", methods=["POST"])
@require_auth
def api_design_timeline_item_float(iid):
    db = get_db()
    data = request.get_json() or {}
    floating = 1 if data.get("floating", True) else 0
    row = db.execute("SELECT * FROM design_timeline_items WHERE id=?", (iid,)).fetchone()
    if not row:
        return jsonify({"error":"Item nao encontrado"}), 404
    if floating:
        stage = db.execute("SELECT * FROM design_stages WHERE id=?", (row["stage_id"],)).fetchone()
        fx = data.get("float_x", (stage["x"] if stage else 0) + 280)
        fy = data.get("float_y", (stage["y"] if stage else 0))
        db.execute("UPDATE design_timeline_items SET floating=1, float_x=?, float_y=? WHERE id=?", (fx, fy, iid))
    else:
        db.execute("UPDATE design_timeline_items SET floating=0 WHERE id=?", (iid,))
    db.commit()
    return jsonify({"ok":True})

@app.route("/api/design-timeline-items/reorder", methods=["PUT"])
@require_auth
def api_design_timeline_reorder():
    data = request.get_json() or {}
    items = data.get("items", [])
    db = get_db()
    for item in items:
        db.execute("UPDATE design_timeline_items SET stage_id=?, order_idx=? WHERE id=?", (item.get("stage_id"), item["order"], item["id"]))
    db.commit()
    return jsonify({"ok":True})

# ─── Chamado Festefe ──────────────────────

@app.route("/api/festefe/tickets", methods=["GET","POST"])
@require_auth
def api_festefe_tickets():
    db = get_db()
    if request.method == "POST":
        data = request.get_json() or {}
        cur = get_current_user()
        db.execute("INSERT INTO festefe_tickets (title,description,priority,category,client_name,assigned_to,created_by) VALUES (?,?,?,?,?,?,?)",
            (data.get("title"), data.get("description",""), data.get("priority","media"), data.get("category",""), data.get("client_name",""),
             data.get("assigned_to"), cur["id"]))
        db.commit()
        tid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
        log_activity("criou", "festefe_ticket", tid, f"Chamado: {data.get('title')}")
        return jsonify({"ok":True, "id":tid})
    status = request.args.get("status","")
    q = request.args.get("q","")
    query = "SELECT f.*, u.name as assigned_name FROM festefe_tickets f LEFT JOIN users u ON f.assigned_to=u.id"
    where = []
    params = []
    if status and status != "todos":
        where.append("f.status=?")
        params.append(status)
    if q:
        where.append("(f.title LIKE ? OR f.description LIKE ? OR f.client_name LIKE ?)")
        params.extend([f"%{q}%", f"%{q}%", f"%{q}%"])
    if where:
        query += " WHERE " + " AND ".join(where)
    query += " ORDER BY f.created_at DESC"
    rows = db.execute(query, params).fetchall()
    return jsonify(rows_to_list(rows))

@app.route("/api/festefe/tickets/<int:tid>", methods=["GET","PUT","DELETE"])
@require_auth
def api_festefe_ticket(tid):
    db = get_db()
    if request.method == "DELETE":
        db.execute("DELETE FROM festefe_messages WHERE ticket_id=?", (tid,))
        db.execute("DELETE FROM festefe_tickets WHERE id=?", (tid,))
        db.commit()
        return jsonify({"ok":True})
    if request.method == "PUT":
        data = request.get_json() or {}
        db.execute("UPDATE festefe_tickets SET title=?,description=?,status=?,priority=?,category=?,client_name=?,assigned_to=? WHERE id=?",
            (data.get("title"), data.get("description",""), data.get("status","aberto"), data.get("priority","media"), data.get("category",""), data.get("client_name",""), data.get("assigned_to"), tid))
        db.commit()
        log_activity("editou", "festefe_ticket", tid)
        return jsonify({"ok":True})
    row = db.execute("SELECT f.*, u.name as assigned_name FROM festefe_tickets f LEFT JOIN users u ON f.assigned_to=u.id WHERE f.id=?", (tid,)).fetchone()
    return jsonify(row_to_dict(row))

@app.route("/api/festefe/tickets/<int:tid>/status", methods=["POST"])
@require_auth
def api_festefe_ticket_status(tid):
    data = request.get_json() or {}
    db = get_db()
    db.execute("UPDATE festefe_tickets SET status=? WHERE id=?", (data.get("status","aberto"), tid))
    db.commit()
    log_activity("alterou status", "festefe_ticket", tid, f"Status: {data.get('status')}")
    return jsonify({"ok":True})

@app.route("/api/festefe/tickets/<int:tid>/messages", methods=["GET","POST"])
@require_auth
def api_festefe_messages(tid):
    db = get_db()
    if request.method == "POST":
        data = request.get_json() or {}
        cur = get_current_user()
        db.execute("INSERT INTO festefe_messages (ticket_id,user_id,message) VALUES (?,?,?)",
            (tid, cur["id"], data.get("message","")))
        db.commit()
        return jsonify({"ok":True})
    rows = db.execute("SELECT m.*, u.name as user_name FROM festefe_messages m LEFT JOIN users u ON m.user_id=u.id WHERE m.ticket_id=? ORDER BY m.created_at", (tid,)).fetchall()
    return jsonify(rows_to_list(rows))

# ─── Jarvis ──────────────────────────────────

@app.route("/jarvis")
def serve_jarvis():
    return send_from_directory(BASE_DIR, "jarvis.html")

@app.route("/api/jarvis/command", methods=["POST"])
@require_auth
def api_jarvis_command():
    data = request.get_json() or {}
    cmd = (data.get("command") or "").strip().lower()
    db = get_db()
    result = {"spoken": "", "html": ""}

    greetings = ["ola","olá","oi","hey","jarvis","e ai","e aí"]
    if any(g in cmd for g in greetings):
        h = datetime.now().hour
        saud = "Bom dia" if h < 12 else "Boa tarde" if h < 18 else "Boa noite"
        result["spoken"] = f"{saud}! Sou o Jarvis, seu assistente virtual Promake."
        return jsonify(result)

    if "status" in cmd or "painel" in cmd:
        active_clients = db.execute("SELECT COUNT(*) as c FROM clients WHERE status='active'").fetchone()["c"]
        active_projects = db.execute("SELECT COUNT(*) as c FROM projects WHERE status='active'").fetchone()["c"]
        new_leads = db.execute("SELECT COUNT(*) as c FROM leads WHERE status='novo'").fetchone()["c"]
        rev = db.execute("SELECT COALESCE(SUM(value),0) as s FROM transactions WHERE type='income' AND status='completed'").fetchone()["s"]
        exp = db.execute("SELECT COALESCE(SUM(value),0) as s FROM transactions WHERE type='expense' AND status='completed'").fetchone()["s"]
        profit = rev - exp
        result["spoken"] = f"Status do sistema: {active_projects} projetos ativos, {active_clients} clientes ativos, {new_leads} novos leads. Receita total: R$ {rev:,.2f}. Despesas: R$ {exp:,.2f}. Lucro: R$ {profit:,.2f}."
        result["html"] = f"<strong>Status do Sistema</strong><br><span class='highlight'>{active_projects}</span> Projetos ativos &bull; <span class='highlight'>{active_clients}</span> Clientes ativos &bull; <span class='highlight'>{new_leads}</span> Novos leads<br><span class='success'>R$ {rev:,.2f}</span> Receita &bull; <span class='danger'>R$ {exp:,.2f}</span> Despesas &bull; <span class='highlight'>R$ {profit:,.2f}</span> Lucro"
        return jsonify(result)

    if "cliente" in cmd or "clientes" in cmd:
        rows = db.execute("SELECT name, company, email FROM clients ORDER BY name LIMIT 10").fetchall()
        if not rows:
            result["spoken"] = "Nenhum cliente cadastrado."
            return jsonify(result)
        names = ", ".join(r["name"] for r in rows[:6])
        result["spoken"] = f"Encontrei {len(rows)} clientes: {names}."
        result["html"] = f"<strong>Clientes ({len(rows)})</strong><br>" + "<br>".join(f"<span class='highlight'>{r['name']}</span> {r['company'] or ''}" for r in rows)
        return jsonify(result)

    if "projeto" in cmd or "projetos" in cmd:
        rows = db.execute("SELECT p.name, p.status, c.name as client_name FROM projects p LEFT JOIN clients c ON p.client_id=c.id ORDER BY p.id DESC LIMIT 10").fetchall()
        if not rows:
            result["spoken"] = "Nenhum projeto encontrado."
            return jsonify(result)
        names = ", ".join(r["name"] for r in rows[:6])
        result["spoken"] = f"Tenho {len(rows)} projetos: {names}."
        result["html"] = f"<strong>Projetos ({len(rows)})</strong><br>" + "<br>".join(f"<span class='highlight'>{r['name']}</span> <span style='color:var(--text-muted);font-size:12px'>{r['status']}{' - '+r['client_name'] if r['client_name'] else ''}</span>" for r in rows)
        return jsonify(result)

    if "lead" in cmd or "leads" in cmd:
        rows = db.execute("SELECT name, status, company FROM leads ORDER BY id DESC LIMIT 10").fetchall()
        if not rows:
            result["spoken"] = "Nenhum lead cadastrado."
            return jsonify(result)
        names = ", ".join(r["name"] for r in rows[:6])
        result["spoken"] = f"Existem {len(rows)} leads: {names}."
        result["html"] = f"<strong>Leads ({len(rows)})</strong><br>" + "<br>".join(f"<span class='highlight'>{r['name']}</span> <span style='color:var(--text-muted);font-size:12px'>{r['status']}{' - '+r['company'] if r['company'] else ''}</span>" for r in rows)
        return jsonify(result)

    if any(w in cmd for w in ["financeiro","receita","despesa","lucro","faturamento"]):
        rev = db.execute("SELECT COALESCE(SUM(value),0) as s FROM transactions WHERE type='income' AND status='completed' AND date>=date('now','start of month')").fetchone()["s"]
        exp = db.execute("SELECT COALESCE(SUM(value),0) as s FROM transactions WHERE type='expense' AND status='completed' AND date>=date('now','start of month')").fetchone()["s"]
        profit = rev - exp
        result["spoken"] = f"Resumo financeiro do mês: Receita de R$ {rev:,.2f}. Despesas de R$ {exp:,.2f}. Lucro de R$ {profit:,.2f}."
        result["html"] = f"<strong>Resumo Financeiro</strong><br><span style='color:var(--success)'>Receita: R$ {rev:,.2f}</span> &bull; <span style='color:var(--danger)'>Despesas: R$ {exp:,.2f}</span> &bull; <span class='highlight'>Lucro: R$ {profit:,.2f}</span>"
        return jsonify(result)

    if any(w in cmd for w in ["agenda","evento","calendario","compromisso","reuniao"]):
        month = datetime.now().strftime("%m")
        year = datetime.now().strftime("%Y")
        rows = db.execute("SELECT title, date, time FROM calendar_events WHERE strftime('%m',date)=? AND strftime('%Y',date)=? ORDER BY date LIMIT 10", (month, year)).fetchall()
        if not rows:
            result["spoken"] = "Nenhum evento agendado para este mês."
            return jsonify(result)
        titles = ", ".join(f"{r['title']} dia {r['date']}" for r in rows[:5])
        result["spoken"] = f"Encontrei {len(rows)} eventos: {titles}."
        result["html"] = f"<strong>Agenda - {len(rows)} eventos</strong><br>" + "<br>".join(f"<span class='highlight'>{r['title']}</span> <span style='color:var(--text-muted);font-size:12px'>{r['date']}{' às '+r['time'] if r['time'] else ''}</span>" for r in rows)
        return jsonify(result)

    if any(w in cmd for w in ["notificacao","notificação","aviso","alerta"]):
        user_id = get_current_user()["id"]
        count = db.execute("SELECT COUNT(*) as c FROM notifications WHERE (user_id=? OR user_id IS NULL) AND read=0", (user_id,)).fetchone()["c"]
        if count == 0:
            result["spoken"] = "Você não tem notificações não lidas."
            result["html"] = "<span class='success'><i class='fas fa-check-circle'></i> Nenhuma notificação não lida</span>"
        else:
            rows = db.execute("SELECT title, message FROM notifications WHERE (user_id=? OR user_id IS NULL) AND read=0 ORDER BY created_at DESC LIMIT 5", (user_id,)).fetchall()
            titles = ", ".join(r["title"] for r in rows)
            result["spoken"] = f"Você tem {count} notificações não lidas: {titles}."
            result["html"] = f"<strong>{count} Notificações não lidas</strong><br>" + "<br>".join(f"<span class='highlight'>{r['title']}</span> <span style='color:var(--text-muted);font-size:12px'>{r['message'] or ''}</span>" for r in rows)
        return jsonify(result)

    if any(w in cmd for w in ["hora","horas","que horas"]):
        now = datetime.now()
        result["spoken"] = f"Agora são {now.hour:02d} horas e {now.minute:02d} minutos."
        result["html"] = f"<span class='highlight'><i class='fas fa-clock'></i> {result['spoken']}</span>"
        return jsonify(result)

    if any(w in cmd for w in ["data","dia","que dia"]):
        now = datetime.now()
        dias = ["domingo","segunda-feira","terça-feira","quarta-feira","quinta-feira","sexta-feira","sábado"]
        meses = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"]
        result["spoken"] = f"Hoje é {dias[now.weekday()]}, {now.day} de {meses[now.month-1]} de {now.year}."
        result["html"] = f"<span class='highlight'><i class='fas fa-calendar'></i> {result['spoken']}</span>"
        return jsonify(result)

    if "abrir" in cmd:
        apps = {"dashboard":"/","painel":"/","cliente":"#","projeto":"#","calculadora":"calc:","calc":"calc:","bloco de notas":"notepad:","notepad":"notepad:","terminal":"cmd:","cmd":"cmd:","explorer":"explorer:","chrome":"chrome:"}
        for key, url in apps.items():
            if key in cmd:
                result["spoken"] = f"Abrindo {key}..."
                result["action"] = "open"
                result["url"] = url
                return jsonify(result)
        result["spoken"] = "Não encontrei este aplicativo. Tente: Dashboard, Calculadora, Bloco de Notas, Terminal."
        return jsonify(result)

    if any(w in cmd for w in ["tchau","até logo","ate logo","sair","desligar","obrigado","valeu"]):
        result["spoken"] = "Até logo! Estarei aqui quando precisar."
        result["action"] = "stop_listening"
        return jsonify(result)

    if any(w in cmd for w in ["quem é","quem e","quem criou"]):
        result["spoken"] = "Sou o Jarvis, assistente inteligente do Promake CyberControl. Fui criado para ajudar na gestão da sua empresa com comandos de voz."
        return jsonify(result)

    if any(w in cmd for w in ["ajuda","help","comandos","o que sabe"]):
        result["spoken"] = "Comandos disponíveis: Status, Clientes, Projetos, Leads, Financeiro, Agenda, Notificações, Horas, Data, Clima, Abrir Programa, Ajuda. Diga um comando ou clique no microfone."
        result["html"] = """<strong>Comandos Disponíveis</strong><br>
        <span class='highlight'>Status</span> - Status do sistema<br>
        <span class='highlight'>Clientes</span> - Listar clientes<br>
        <span class='highlight'>Projetos</span> - Listar projetos<br>
        <span class='highlight'>Leads</span> - Listar leads<br>
        <span class='highlight'>Financeiro</span> - Resumo financeiro<br>
        <span class='highlight'>Agenda</span> - Eventos do mês<br>
        <span class='highlight'>Notificações</span> - Não lidas<br>
        <span class='highlight'>Horas/Data</span> - Informação atual<br>
        <span class='highlight'>Abrir [app]</span> - Abrir programa"""
        return jsonify(result)

    result["spoken"] = f"Não entendi o comando. Fale 'Ajuda' para ver os comandos disponíveis."
    return jsonify(result)

# ─── Static files ──────────────────────────

@app.route("/")
def serve_index():
    return send_from_directory(BASE_DIR, "index.html")

@app.route("/<path:filename>")
def serve_static(filename):
    file_path = BASE_DIR / filename
    if file_path.exists() and file_path.is_file():
        return send_from_directory(BASE_DIR, filename)
    return jsonify({"error": "Not found"}), 404

def monitor_connectivity():
    while True:
        time.sleep(60)
        try:
            urllib.request.urlopen("https://clients3.google.com/generate_204", timeout=5)
            print("[connectivity] OK")
        except:
            print("[connectivity] Sem internet")

def monitor_security():
    db = Database()
    while True:
        time.sleep(300)
        try:
            rows = db.execute("SELECT * FROM activity_log WHERE action='login' AND created_at > datetime('now','-5 minutes')").fetchall()
            if len(rows) > 20:
                print(f"[security] {len(rows)} logins nos ultimos 5 min - possivel ataque")
        except:
            pass

# ─── Notes (standalone) ───────────────────

@app.route("/api/notes", methods=["GET","POST"])
@require_auth
def api_notes():
    db = get_db()
    if request.method == "POST":
        data = request.get_json() or {}
        db.execute("INSERT INTO notes (title,content,color) VALUES (?,?,?)",
            (data.get("title","Sem titulo"), data.get("content",""), data.get("color","#FFF8DC")))
        db.commit()
        nid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
        return jsonify({"ok":True, "id":nid})
    rows = db.execute("SELECT * FROM notes ORDER BY updated_at DESC").fetchall()
    return jsonify(rows_to_list(rows))

@app.route("/api/notes/<int:nid>", methods=["GET","PUT","DELETE"])
@require_auth
def api_note(nid):
    db = get_db()
    if request.method == "GET":
        row = db.execute("SELECT * FROM notes WHERE id=?", (nid,)).fetchone()
        return jsonify(row_to_dict(row) or {})
    if request.method == "DELETE":
        db.execute("DELETE FROM notes WHERE id=?", (nid,))
        db.commit()
        return jsonify({"ok":True})
    data = request.get_json() or {}
    db.execute("UPDATE notes SET title=?,content=?,color=?,updated_at=datetime('now','localtime') WHERE id=?",
        (data.get("title","Sem titulo"), data.get("content",""), data.get("color","#FFF8DC"), nid))
    db.commit()
    return jsonify({"ok":True})

@app.route("/api/notes/<int:nid>/pdf")
@require_auth
def api_note_pdf(nid):
    db = get_db()
    row = db.execute("SELECT * FROM notes WHERE id=?", (nid,)).fetchone()
    if not row:
        return jsonify({"error":"Nota nao encontrada"}), 404
    note = dict(row)
    pdf = FPDF()
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 16)
    pdf.cell(0, 10, note["title"], new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 11)
    lines = (note["content"] or "").split("\n")
    for line in lines:
        pdf.multi_cell(0, 6, line)
    resp = Response(pdf.output(), mimetype="application/pdf",
        headers={"Content-Disposition": f"attachment;filename=nota_{note['id']}.pdf"})
    return resp

# ─── Design Notes ──────────────────────────

@app.route("/api/design-projects/<int:pid>/notes", methods=["GET","POST"])
@require_auth
def api_design_notes(pid):
    db = get_db()
    if request.method == "POST":
        data = request.get_json() or {}
        db.execute("INSERT INTO design_notes (project_id,title,content) VALUES (?,?,?)",
            (pid, data.get("title","Sem titulo"), data.get("content","")))
        db.commit()
        nid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
        return jsonify({"ok":True, "id":nid})
    rows = db.execute("SELECT * FROM design_notes WHERE project_id=? ORDER BY updated_at DESC", (pid,)).fetchall()
    return jsonify(rows_to_list(rows))

@app.route("/api/design-notes/<int:nid>", methods=["GET","PUT","DELETE"])
@require_auth
def api_design_note(nid):
    db = get_db()
    if request.method == "GET":
        row = db.execute("SELECT * FROM design_notes WHERE id=?", (nid,)).fetchone()
        return jsonify(row_to_dict(row) or {})
    if request.method == "DELETE":
        db.execute("DELETE FROM design_notes WHERE id=?", (nid,))
        db.commit()
        return jsonify({"ok":True})
    data = request.get_json() or {}
    db.execute("UPDATE design_notes SET title=?,content=?,updated_at=datetime('now','localtime') WHERE id=?",
        (data.get("title","Sem titulo"), data.get("content",""), nid))
    db.commit()
    return jsonify({"ok":True})

@app.route("/api/design-notes/<int:nid>/pdf")
@require_auth
def api_design_note_pdf(nid):
    db = get_db()
    row = db.execute("SELECT * FROM design_notes WHERE id=?", (nid,)).fetchone()
    if not row:
        return jsonify({"error":"Nota nao encontrada"}), 404
    note = dict(row)
    pdf = FPDF()
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 16)
    pdf.cell(0, 10, note["title"], new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 11)
    pdf.multi_cell(0, 6, note["content"] or "")
    return Response(pdf.output(), mimetype="application/pdf",
        headers={"Content-Disposition": f"attachment;filename=nota_{note['id']}.pdf"})

@app.route("/api/youtube/search", methods=["POST"])
@require_auth
def api_youtube_search():
    data = request.get_json() or {}
    query = data.get("query", "").strip()
    if not query:
        return jsonify({"error": "Query required"}), 400
    try:
        search_url = f"https://www.youtube.com/results?search_query={urllib.parse.quote(query)}"
        req = urllib.request.Request(search_url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
        })
        with urllib.request.urlopen(req, timeout=15) as resp:
            html = resp.read().decode("utf-8", errors="replace")
        match = re.search(r'var ytInitialData\s*=\s*({.*?});\s*</script>', html, re.DOTALL)
        if not match:
            return jsonify({"error": "Nao foi possivel extrair resultados"}), 500
        raw = json.loads(match.group(1))
        sections = (raw.get("contents", {})
                       .get("twoColumnSearchResultsRenderer", {})
                       .get("primaryContents", {})
                       .get("sectionListRenderer", {})
                       .get("contents", []))
        results = []
        for section in sections:
            items = section.get("itemSectionRenderer", {}).get("contents", [])
            for item in items:
                vr = item.get("videoRenderer")
                if not vr:
                    continue
                vid = vr.get("videoId", "")
                if not vid:
                    continue
                title_runs = vr.get("title", {}).get("runs", [])
                title = "".join(r.get("text", "") for r in title_runs) if title_runs else vr.get("title", {}).get("simpleText", "")
                ch = vr.get("ownerText", {}).get("runs", [{}])[0].get("text", "") if vr.get("ownerText", {}).get("runs") else ""
                dur = vr.get("lengthText", {}).get("simpleText", "")
                thumb = f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
                results.append({"id": vid, "title": title, "thumbnail": thumb, "channel": ch, "duration": dur})
        return jsonify(results)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/youtube/playlist", methods=["GET"])
@require_auth
def api_youtube_playlist_list():
    db = get_db()
    rows = db.execute("SELECT * FROM youtube_playlist ORDER BY added_at DESC").fetchall()
    return jsonify([dict(r) for r in rows])

@app.route("/api/youtube/playlist", methods=["POST"])
@require_auth
def api_youtube_playlist_add():
    data = request.get_json(silent=True) or {}
    video_id = (data.get("video_id") or "").strip()
    if not video_id:
        return jsonify({"error": "video_id required"}), 400
    title = (data.get("title") or "").strip()
    channel = (data.get("channel") or "").strip()
    duration = (data.get("duration") or "").strip()
    thumbnail = (data.get("thumbnail") or "").strip()
    db = get_db()
    exists = db.execute("SELECT id FROM youtube_playlist WHERE video_id = ?", (video_id,)).fetchone()
    if exists:
        return jsonify({"error": "Video ja esta na playlist"}), 409
    db.execute(
        "INSERT INTO youtube_playlist (video_id, title, channel, duration, thumbnail) VALUES (?,?,?,?,?)",
        (video_id, title, channel, duration, thumbnail)
    )
    db.commit()
    row = db.execute("SELECT * FROM youtube_playlist WHERE video_id = ?", (video_id,)).fetchone()
    return jsonify(dict(row)), 201

@app.route("/api/youtube/playlist/<int:pid>", methods=["DELETE"])
@require_auth
def api_youtube_playlist_remove(pid):
    db = get_db()
    db.execute("DELETE FROM youtube_playlist WHERE id = ?", (pid,))
    db.commit()
    return jsonify({"ok": True})

# ─── Spotify ──────────────────────────────────

SPOTIFY_CONFIG_PATH = BASE_DIR / "backend" / "spotify_config.json"

SPOTIFY_ORIGIN = os.environ.get("SPOTIFY_ORIGIN", "https://promake-cybercontrol.onrender.com")

def _load_spotify_config():
    if SPOTIFY_CONFIG_PATH.exists():
        try:
            return json.loads(SPOTIFY_CONFIG_PATH.read_text())
        except:
            pass
    return {}

def _save_spotify_config(data):
    SPOTIFY_CONFIG_PATH.write_text(json.dumps(data, indent=2))

@app.route("/api/spotify/config", methods=["GET"])
@require_auth
def api_spotify_config_get():
    cfg = _load_spotify_config()
    return jsonify({
        "client_id": cfg.get("client_id", ""),
        "redirect_uri": cfg.get("redirect_uri", "http://127.0.0.1:8081/api/spotify/callback"),
    })

@app.route("/api/spotify/config", methods=["PUT"])
@require_auth
def api_spotify_config_put():
    data = request.get_json() or {}
    client_id = (data.get("client_id") or "").strip()
    client_secret = (data.get("client_secret") or "").strip()
    redirect_uri = (data.get("redirect_uri") or "").strip()
    if not client_id or not client_secret:
        return jsonify({"error": "Client ID e Client Secret obrigatorios"}), 400
    if not redirect_uri:
        redirect_uri = "http://127.0.0.1:8081/api/spotify/callback"
    _save_spotify_config({
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": redirect_uri
    })
    log_activity("editou", "config", 0, "Spotify config atualizada")
    return jsonify({"ok": True})

@app.route("/api/smtp/config", methods=["GET"])
@require_auth
def api_smtp_config_get():
    cfg = load_config().get("smtp", {})
    return jsonify({
        "host": cfg.get("host", ""),
        "port": cfg.get("port", 587),
        "from_email": cfg.get("from_email", ""),
        "user": cfg.get("user", ""),
        "has_password": bool(cfg.get("password", "")),
    })

@app.route("/api/smtp/config", methods=["PUT"])
@require_auth
def api_smtp_config_put():
    data = request.get_json() or {}
    smtp = {
        "host": (data.get("host") or "").strip(),
        "port": int(data.get("port", 587)),
        "from_email": (data.get("from_email") or "").strip(),
        "user": (data.get("user") or "").strip(),
        "password": (data.get("password") or "").strip(),
    }
    if not smtp["host"] or not smtp["user"] or not smtp["password"]:
        return jsonify({"error": "Host, usuario e senha obrigatorios"}), 400
    cfg = load_config()
    cfg["smtp"] = smtp
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
    log_activity("editou", "config", 0, "SMTP config atualizada")
    return jsonify({"ok": True})

@app.route("/api/smtp/test", methods=["POST"])
@require_auth
def api_smtp_test():
    data = request.get_json() or {}
    to_email = (data.get("to_email") or "").strip()
    if not to_email:
        return jsonify({"error": "Email de teste obrigatorio"}), 400
    subject = "Teste de Configuracao SMTP - Promake"
    body_html = "<h2>Teste SMTP</h2><p>Se voce recebeu este email, a configuracao SMTP esta funcionando corretamente!</p>"
    sent = send_email(to_email, subject, body_html)
    if sent:
        return jsonify({"ok": True, "message": "Email de teste enviado para " + to_email})
    return jsonify({"error": "Falha ao enviar email de teste. Verifique as configuracoes."}), 500

@app.route("/api/spotify/auth-url")
@require_auth
def api_spotify_auth_url():
    cfg = _load_spotify_config()
    cid = cfg.get("client_id", "")
    redir = cfg.get("redirect_uri", "http://127.0.0.1:8081/api/spotify/callback")
    if not cid:
        return jsonify({"error": "Spotify nao configurado. Va em Configuracoes > Spotify."}), 400
    scopes = "user-read-private user-read-email playlist-read-private playlist-read-collaborative"
    params = urllib.parse.urlencode({
        "client_id": cid,
        "response_type": "code",
        "redirect_uri": redir,
        "scope": scopes,
    })
    return jsonify({"url": f"https://accounts.spotify.com/authorize?{params}"})

@app.route("/api/spotify/callback")
def api_spotify_callback():
    code = request.args.get("code", "")
    error = request.args.get("error", "")
    if error:
        return f"<script>window.opener?.postMessage({{type:'spotify-auth',error:'{error}'}},'{SPOTIFY_ORIGIN}');window.close();</script><p>Erro: {error}</p>"
    if not code:
        return "<p>Codigo nao recebido.</p>"
    cfg = _load_spotify_config()
    cid = cfg.get("client_id", "")
    secret = cfg.get("client_secret", "")
    redir = cfg.get("redirect_uri", "http://127.0.0.1:8081/api/spotify/callback")
    try:
        token_data = urllib.parse.urlencode({
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redir,
            "client_id": cid,
            "client_secret": secret,
        }).encode()
        req = urllib.request.Request("https://accounts.spotify.com/api/token", data=token_data,
            headers={"Content-Type": "application/x-www-form-urlencoded"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            tokens = json.loads(resp.read())
        access_token = tokens.get("access_token")
        refresh_token = tokens.get("refresh_token", "")
        expires_in = tokens.get("expires_in", 3600)
        cfg["access_token"] = access_token
        cfg["refresh_token"] = refresh_token
        cfg["token_expires"] = time.time() + expires_in
        _save_spotify_config(cfg)
        return f"""<script>
            window.opener?.postMessage({{type:'spotify-auth',ok:true}},'{SPOTIFY_ORIGIN}');
            window.close();
        </script><p>Autenticado! Feche esta janela.</p>"""
    except Exception as e:
        return f"<p>Erro na autenticacao: {e}</p>"

def _spotify_headers():
    cfg = _load_spotify_config()
    token = cfg.get("access_token", "")
    if not token:
        return None
    if time.time() > cfg.get("token_expires", 0):
        # refresh
        cid = cfg.get("client_id", "")
        secret = cfg.get("client_secret", "")
        rt = cfg.get("refresh_token", "")
        if cid and secret and rt:
            try:
                data = urllib.parse.urlencode({
                    "grant_type": "refresh_token",
                    "refresh_token": rt,
                    "client_id": cid,
                    "client_secret": secret,
                }).encode()
                req = urllib.request.Request("https://accounts.spotify.com/api/token", data=data,
                    headers={"Content-Type": "application/x-www-form-urlencoded"})
                with urllib.request.urlopen(req, timeout=10) as resp:
                    tokens = json.loads(resp.read())
                cfg["access_token"] = tokens.get("access_token", token)
                cfg["token_expires"] = time.time() + tokens.get("expires_in", 3600)
                _save_spotify_config(cfg)
                token = cfg["access_token"]
            except:
                return None
    return {"Authorization": f"Bearer {token}"}

def _spotify_get(path):
    headers = _spotify_headers()
    if not headers:
        return jsonify({"error": "Nao autenticado", "not_authenticated": True})
    try:
        req = urllib.request.Request(f"https://api.spotify.com/v1{path}", headers=headers)
        with urllib.request.urlopen(req, timeout=10) as resp:
            return jsonify(json.loads(resp.read()))
    except urllib.error.HTTPError as e:
        return jsonify({"error": f"Spotify API error: {e.code}", "not_authenticated": e.code == 401})
    except Exception as e:
        return jsonify({"error": str(e)})

@app.route("/api/spotify/me")
@require_auth
def api_spotify_me():
    return _spotify_get("/me")

@app.route("/api/spotify/playlists")
@require_auth
def api_spotify_playlists():
    limit = request.args.get("limit", 20)
    offset = request.args.get("offset", 0)
    return _spotify_get(f"/me/playlists?limit={limit}&offset={offset}")

@app.route("/api/spotify/playlists/<pid>/tracks")
@require_auth
def api_spotify_playlist_tracks(pid):
    limit = request.args.get("limit", 50)
    offset = request.args.get("offset", 0)
    return _spotify_get(f"/playlists/{pid}/tracks?limit={limit}&offset={offset}")

@app.route("/api/spotify/search")
@require_auth
def api_spotify_search():
    q = request.args.get("q", "")
    if not q:
        return jsonify({"error": "Query required"}), 400
    stype = request.args.get("type", "track")
    limit = request.args.get("limit", 20)
    return _spotify_get(f"/search?q={urllib.parse.quote(q)}&type={stype}&limit={limit}")

# ─── Backup ────────────────────────────────

from backup_manager import create_backup, list_backups, get_backup_path, backup_worker

@app.route("/api/admin/backup", methods=["POST"])
@require_auth
@require_role("super_admin", "admin")
def api_trigger_backup():
    result = create_backup()
    if not result:
        return jsonify({"error": "Falha ao criar backup"}), 500
    if "error" in result:
        return jsonify({"error": result["error"]}), 500
    return jsonify({"message": "Backup criado", "backup": result})

@app.route("/api/admin/backups", methods=["GET"])
@require_auth
@require_role("super_admin", "admin")
def api_list_backups():
    return jsonify({"rows": list_backups()})

@app.route("/api/admin/backup/<filename>", methods=["GET"])
@require_auth
@require_role("super_admin", "admin")
def api_download_backup(filename):
    path = get_backup_path(filename)
    if not path:
        return jsonify({"error": "Arquivo nao encontrado"}), 404
    return send_from_directory(path.parent, path.name, as_attachment=True)

# ─── Seed Design (PG) ──────────────────────

@app.route("/api/admin/seed-design", methods=["POST"])
@require_auth
@require_role("super_admin", "admin")
def api_seed_design():
    db = get_db()
    try:
        cur = db.execute("SELECT id FROM users WHERE email='admin@promake.com'")
        admin = cur.fetchone()
        if not admin:
            return jsonify({"error": "Admin nao encontrado"}), 500
        admin_id = admin["id"]
        cur = db.execute("SELECT id FROM users WHERE email='joao@promake.com'")
        designer = cur.fetchone()
        designer_id = designer["id"] if designer else admin_id

        if db.execute("SELECT id FROM design_projects").fetchone():
            return jsonify({"message": "Projetos ja existem"})

        db.execute("INSERT INTO design_projects (name,description,client_name,deadline,created_by) VALUES (?,?,?,?,?)",
            ("Campanha Redes Sociais - Tech Solutions","Criacao de artes para campanha de midia social - 15 pecas","Tech Solutions","2026-07-15",admin_id))
        dp1 = db.last_insert_rowid
        db.execute("INSERT INTO design_projects (name,description,client_name,deadline,created_by) VALUES (?,?,?,?,?)",
            ("Identidade Visual Corp Ltda","Identidade visual completa: logo, tipografia, paleta de cores e aplicacoes","Corp Ltda","2026-08-01",designer_id))
        dp2 = db.last_insert_rowid
        db.execute("INSERT INTO design_projects (name,description,client_name,deadline,created_by) VALUES (?,?,?,?,?)",
            ("Material Grafico - Negocios SA","Folder institucional, catalogo de produtos e apresentacao comercial","Negocios SA","2026-07-30",designer_id))
        dp3 = db.last_insert_rowid
        db.commit()

        for pid in [dp1, dp2, dp3]:
            for i, nm in enumerate(["Briefing","Criacao","Revisao","Aprovacao","Finalizado"]):
                db.execute("INSERT INTO design_stages (project_id,title,description,color,order_idx,created_by) VALUES (?,?,?,?,?,?)",
                    (pid,nm,"",["#6C5CE7","#00B0FF","#FFD600","#FF9800","#00C853"][i],i,admin_id))
        db.commit()

        cards = [
            (dp1,"Posts Instagram - Semana 1","5 posts feed lancamento","criacao","#E91E63","2026-06-25","Joao Designer",0,designer_id),
            (dp1,"Stories diarios","15 stories semana lancamento","criacao","#9C27B0","2026-06-26","Joao Designer",1,designer_id),
            (dp1,"Revisar artes com cliente","Apresentar para aprovacao","revisao","#FF9800","2026-06-28","Maria Silva",0,admin_id),
            (dp1,"Ajustes finais","Corrigir feedback do cliente","aprovacao","#F44336","2026-06-30","Joao Designer",0,designer_id),
            (dp1,"Briefing inicial","Reuniao com cliente","briefing","#4CAF50","2026-06-20","Maria Silva",0,admin_id),
        ]
        for c in cards:
            db.execute("INSERT INTO design_cards (project_id,title,description,stage,color_tag,deadline,assigned_to,order_idx,created_by) VALUES (?,?,?,?,?,?,?,?,?)", c)
        db.commit()
        return jsonify({"ok": True, "message": "Seed de design criado com 3 projetos"})
    except Exception as e:
        db.rollback()
        return jsonify({"error": str(e)}), 500

# ─── Cleanup duplicates ──────────────────────

@app.route("/api/admin/cleanup-duplicates", methods=["POST"])
@require_auth
@require_role("admin")
def api_cleanup_duplicates():
    db = get_db()
    results = {}
    # Dedup strategy: group by unique key (email or name), keep lowest id, delete rest
    rules = [
        ("clients", "email", "name", 5),
        ("leads", "email", "name", 4),
        ("contracts", "title", "client_id", 2),
        ("projects", "name", "client_id", 5),
        ("service_orders", "title", "project_id", 3),
        ("calendar_events", "title", "date", 3),
        ("transactions", "description", "value", 6),
        ("tasks", "title", "service_order_id", 3),
        ("plans", "name", "price", 3),
        ("client_plans", "client_id", "plan_id", 3),
        ("design_projects", "name", "client_name", 3),
        ("design_cards", "title", "project_id", 5),
    ]
    try:
        for table, key1, key2, expected in rules:
            try:
                rows = db.execute(f"SELECT id, {key1}, {key2} FROM {table} ORDER BY id").fetchall()
                seen = {}
                delete_ids = []
                for r in rows:
                    k = (r[key1], r[key2])
                    if k in seen:
                        delete_ids.append(r["id"])
                    else:
                        seen[k] = r["id"]
                if delete_ids:
                    for did in delete_ids:
                        db.execute(f"DELETE FROM {table} WHERE id=?", (did,))
                    db.commit()
                results[table] = {"kept": len(seen), "deleted": len(delete_ids)}
            except Exception as et:
                results[table] = {"error": str(et)[:80]}
        # Linnear landing_config dedup (composite PK already prevents)
        return jsonify({"ok": True, "results": results})
    except Exception as e:
        db.rollback()
        return jsonify({"error": str(e)}), 500

# ─── Restore data from local backup ──────────

@app.route("/api/admin/restore-data", methods=["POST"])
@require_auth
@require_role("admin")
def api_restore_data():
    data = request.get_json() or {}
    db = get_db()
    results = {"restored": {}, "errors": []}
    no_id_tables = {"landing_config", "user_backup_codes", "password_resets", "email_verifications"}
    try:
        order = ["plans","clients","projects","users","leads","contracts","service_orders","tasks","calendar_events","transactions","client_plans","landing_config","visit_counter","design_projects","design_stages","design_cards"]
        for table in order:
            rows = data.get(table, [])
            if not rows:
                continue
            has_id = table not in no_id_tables
            count = 0
            for row in rows:
                try:
                    id_val = row.pop("id", None) if has_id else None
                    cols = [k for k in row.keys() if row.get(k) is not None or k in ("avatar","phone","notes","tags","description")]
                    if not cols:
                        continue
                    placeholders = ",".join("?" for _ in cols)
                    colnames = ",".join(cols)
                    values = [row.get(c) for c in cols]
                    # Check if row exists
                    existing = False
                    if table == "landing_config":
                        existing = bool(db.execute("SELECT 1 FROM landing_config WHERE section=? AND key=?", (row.get("section",""), row.get("key",""))).fetchone())
                    elif has_id and id_val is not None:
                        try:
                            existing = bool(db.execute(f"SELECT 1 FROM {table} WHERE id=?", (id_val,)).fetchone())
                        except:
                            pass
                    if not existing:
                        if table in no_id_tables and db.is_postgres:
                            raw_conn = db.get_connection()
                            raw_cur = raw_conn.cursor()
                            pg_sql = f"INSERT INTO {table} ({colnames}) VALUES ({','.join('%s' for _ in cols)})"
                            raw_cur.execute(pg_sql, values)
                        else:
                            db.execute(f"INSERT INTO {table} ({colnames}) VALUES ({placeholders})", values)
                        count += 1
                except Exception as erow:
                    err_msg = str(erow)[:120]
                    results["errors"].append(f"{table}: {err_msg}")
            if count:
                db.commit()
                results["restored"][table] = count
        return jsonify(results)
    except Exception as e:
        db.rollback()
        return jsonify({"error": str(e)}), 500

# ─── Init ────────────────────────────────────

init_db()
t_conn = threading.Thread(target=monitor_connectivity, daemon=True)
t_conn.start()
t_sec = threading.Thread(target=monitor_security, daemon=True)
t_sec.start()
t_bkp = threading.Thread(target=backup_worker, daemon=True)
t_bkp.start()

SERVER_START = datetime.now()

if __name__ == "__main__":
    is_prod = bool(os.environ.get("DATABASE_URL"))

    port = int(os.environ.get("PORT", 8081))
    print(f"\n  PROMAKE DASH v2.0")
    print(f"  ====================")
    print(f"  Dashboard: http://localhost:{port}")
    print(f"  API:       http://localhost:{port}/api/dashboard\n")

    app.run(host="0.0.0.0", port=port, debug=not is_prod, use_reloader=not is_prod, threaded=True)


