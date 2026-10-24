from fastapi import Depends, Header, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from .db import get_db
from .models import ApiClient, Role, User
from .security import decode_token
from .services import interop

bearer = HTTPBearer(auto_error=False)


def user_from_token(db: Session, token: str) -> User:
    try:
        payload = decode_token(token)
        user = db.get(User, int(payload["sub"]))
    except Exception:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token")
    if not user or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Inactive or unknown user")
    if int(payload.get("tv", 0)) != (user.token_version or 0):  # password change / reset / deactivation
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session revoked; sign in again")
    return user


def current_user(cred: HTTPAuthorizationCredentials | None = Depends(bearer), db: Session = Depends(get_db)) -> User:
    if cred is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    return user_from_token(db, cred.credentials)


def require_api_client(x_api_key: str | None = Header(default=None), db: Session = Depends(get_db)) -> ApiClient:
    """Interop callers (external dispatch centres) authenticate with `X-API-Key`, never a user session."""
    client = interop.client_for_key(db, x_api_key)
    if client is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or inactive API key")
    return client


def require_roles(*roles: Role):
    """STRQ2: only credentialed roles may reach a given endpoint."""
    def dep(user: User = Depends(current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Role not permitted")
        return user
    return dep
