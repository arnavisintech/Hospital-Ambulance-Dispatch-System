from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import get_settings

_url = get_settings().database_url
if _url.startswith("sqlite"):
    from . import db_sqlite
    db_sqlite.ensure_parent_dir(_url)
    engine = create_engine(_url, connect_args={"check_same_thread": False, "timeout": 30})
    db_sqlite.configure(engine)
else:
    engine = create_engine(_url, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
