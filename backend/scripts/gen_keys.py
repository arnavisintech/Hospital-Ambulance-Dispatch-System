"""Print fresh secrets for a production .env:

    python scripts/gen_keys.py >> ../.env
"""
import secrets

from cryptography.fernet import Fernet

print(f"JWT_SECRET={secrets.token_urlsafe(36)}")
print(f"DATA_ENCRYPTION_KEY={Fernet.generate_key().decode()}")
