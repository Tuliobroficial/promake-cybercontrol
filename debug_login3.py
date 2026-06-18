import sys, os
sys.path.insert(0, 'backend')
os.environ.pop('DATABASE_URL', None)

db_path = os.path.join('backend', 'promake.db')
if os.path.exists(db_path):
    os.remove(db_path)
print('Removed old database')

from app import app, init_db, hash_password, check_password, create_access_token
import json

# Test hash/check
h = hash_password('admin123')
print(f'hash_password OK: {h[:20]}...')
print(f'check_password OK: {check_password("admin123", h)}')

# Test init_db
init_db()

# Test login
client = app.test_client()
resp = client.post('/api/auth/login', json={'email':'admin@promake.com','password':'admin123'})
print(f'Login status: {resp.status_code}')
data = json.loads(resp.data)
if 'error' in data:
    print(f'Error: {data["error"]}')
else:
    print(f'SUCCESS! Token: {data.get("access_token","")[:40]}...')
    print(f'User role: {data.get("user",{}).get("role")}')
