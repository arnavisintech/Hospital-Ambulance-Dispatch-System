"""Field-level encryption for patient PII at rest (NFR3, STRQ3).

Values are stored as ``enc:v1:<Fernet token>`` (AES-128-CBC + HMAC-SHA256). DATA_ENCRYPTION_KEY holds one or more
comma-separated Fernet keys: the first encrypts, all of them decrypt, so keys rotate by prepending a new one.
Rows written before encryption was enabled (no prefix) are returned as-is. A value that cannot be decrypted raises
``InvalidToken``: never silently return ciphertext or an empty string. Without a key (development only, the
production guard requires one) values pass through unencrypted.
"""
from functools import lru_cache

from cryptography.fernet import Fernet, MultiFernet
from sqlalchemy import Text
from sqlalchemy.types import TypeDecorator

from .config import get_settings

PREFIX = "enc:v1:"


@lru_cache(maxsize=1)
def _cipher(keys: str) -> MultiFernet | None:
    parts = [k.strip() for k in keys.split(",") if k.strip()]
    return MultiFernet([Fernet(k.encode()) for k in parts]) if parts else None


def cipher() -> MultiFernet | None:
    return _cipher(get_settings().data_encryption_key)


def reset_cache() -> None:
    _cipher.cache_clear()


def encrypt(value: str | None) -> str | None:
    c = cipher()
    if value is None or c is None or value.startswith(PREFIX):
        return value
    return PREFIX + c.encrypt(value.encode()).decode()


def decrypt(value: str | None) -> str | None:
    if value is None or not value.startswith(PREFIX):
        return value
    c = cipher()
    if c is None:
        raise RuntimeError("encrypted data found but DATA_ENCRYPTION_KEY is not set")
    return c.decrypt(value[len(PREFIX):].encode()).decode()


class EncryptedText(TypeDecorator):
    """Text column encrypted transparently on write and decrypted on read. Not searchable or sortable."""
    impl = Text
    cache_ok = True

    def process_bind_param(self, value, dialect):
        return encrypt(value)

    def process_result_value(self, value, dialect):
        return decrypt(value)
