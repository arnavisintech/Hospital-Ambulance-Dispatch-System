"""Shared fixtures/helpers for the ops/analytics tests (kept out of conftest.py on purpose)."""
import os

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models  # noqa: F401
from app.db import Base, get_db
from app.models import User
from app.routers import admin, analytics, audit, billing, dashboard, rebalance
from app.security import create_token
from app.seed import seed_if_empty
from app.services import analytics as analytics_svc


class Env:
    def __init__(self, seed: bool = True):
        url = os.environ.get("HADS_TEST_OPS_DATABASE_URL")  # a second database: conftest resets the first per test
        if url:
            self.engine = create_engine(url)
            Base.metadata.drop_all(self.engine)
        else:
            self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine, autoflush=False, expire_on_commit=False)
        analytics_svc.clear_cache()
        if seed:
            with self.Session() as db:
                seed_if_empty(db)
        app = FastAPI()
        for m in (analytics, rebalance, billing, dashboard, admin, audit):
            app.include_router(m.router)

        def _db():
            db = self.Session()
            try:
                yield db
            finally:
                db.close()
        app.dependency_overrides[get_db] = _db
        self.client = TestClient(app)

    def db(self):
        return self.Session()

    def headers(self, email: str) -> dict:
        with self.Session() as db:
            u = db.execute(select(User).where(User.email == email)).scalar_one()
            return {"Authorization": f"Bearer {create_token(u.id, u.role.value)}"}

    def as_(self, email: str) -> dict:
        return self.headers(email)
