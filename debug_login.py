import sys, os, json, hashlib, bcrypt, sqlite3
sys.path.insert(0, 'backend')
os.environ['PYTHONPATH'] = 'backend'
from app import app, check_password

sha_hash = '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9'
print('check_password SHA-256:', check_password('admin123', sha_hash))

bcrypt_hash = bcrypt.hashpw('admin123'.encode(), bcrypt.gensalt()).decode()
print('check_password bcrypt:', check_password('admin123', bcrypt_hash))

client = app.test_client()
resp = client.post('/api/auth/login', json={'email':'admin@promake.com','password':'admin123'})
print('Login status:', resp.status_code)
data = json.loads(resp.data)
if 'error' in data:
    print('Error:', data['error'])
    conn = sqlite3.connect('backend/promake.db')
    conn.row_factory = sqlite3.Row
    user = conn.execute('SELECT id, email, password_hash, mfa_enabled FROM users WHERE email=?', ('admin@promake.com',)).fetchone()
    if user:
        print('User found:', dict(user))
        h = user['password_hash']
        print('Hash starts with 2:', h.startswith('2'))
        print('Hash starts with $2:', h.startswith('$2'))
        print('Direct bcrypt check:', bcrypt.checkpw('admin123'.encode(), h.encode()))
        print('Direct SHA-256 check:', hashlib.sha256('admin123'.encode()).hexdigest() == h)
    else:
        print('User NOT FOUND in database!')
elif 'access_token' in data:
    print('SUCCESS! Token:', data['access_token'][:30]+'...')
    print('User:', data.get('user'))
