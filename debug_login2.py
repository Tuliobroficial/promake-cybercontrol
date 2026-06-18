import sys, os
sys.path.insert(0, 'backend')
os.environ['PYTHONPATH'] = 'backend'
os.environ.pop('DATABASE_URL', None)  # Force SQLite for local test
import json
import bcrypt
import sqlite3
from app import app, check_password, hash_password

# Test hash_password and check_password round trip
pw = "admin123"
h = hash_password(pw)
print(f"Hash: {h}")
print(f"check_password: {check_password(pw, h)}")
print(f"Hash starts with $2: {h.startswith('$2')}")

# Reset database
db_path = os.path.join('backend', 'promake.db')
if os.path.exists(db_path):
    os.remove(db_path)
    print(f"\nRemoved old database")

# Start fresh
from app import init_db
init_db()

# Now test login
client = app.test_client()
resp = client.post('/api/auth/login', json={'email':'admin@promake.com','password':'admin123'})
print(f"\nLogin status: {resp.status_code}")
data = json.loads(resp.data)
if 'error' in data:
    print(f"Error: {data['error']}")
    # Check database directly
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    user = conn.execute('SELECT * FROM users WHERE email=?', ('admin@promake.com',)).fetchone()
    if user:
        print(f"User: {dict(user)}")
        pw_hash = user['password_hash']
        print(f"Hash check: {check_password('admin123', pw_hash)}")
        print(f"Direct bcrypt: {bcrypt.checkpw('admin123'.encode(), pw_hash.encode())}")
    else:
        print("User NOT FOUND!")
        # Check all users
        all_users = conn.execute('SELECT id, email, role FROM users').fetchall()
        for u in all_users:
            print(f"  User: {dict(u)}")
else:
    print(f"SUCCESS! Token received: {data.get('access_token', 'N/A')[:40]}...")
