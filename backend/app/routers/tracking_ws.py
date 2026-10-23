"""Real-time channel: GET ws://host/api/ws?token=<jwt>&topics=request:12,controller,crew:3,hospital:2

Anonymous family view (v2 section 4): GET ws://host/api/ws?share=<share token> subscribes to that request's topic
only (topics may be omitted or must equal request:{id})."""
import json
from datetime import datetime, timezone

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .. import db as dbmod
from ..deps import user_from_token
from ..events import hub
from ..models import EmergencyRequest, Role, User
from ..services import sharing, trips

router = APIRouter(tags=["realtime"])


def _allowed(db, user: User, topic: str) -> bool:
    """STRQ2: topic-level authorisation per role."""
    kind, _, ident = topic.partition(":")
    if user.role in (Role.controller, Role.admin):
        return kind in ("request", "controller", "crew", "hospital")
    if kind == "request" and ident.isdigit():
        req = db.get(EmergencyRequest, int(ident))
        return req is not None and trips.can_view(db, user, req) and user.role != Role.authority
    if kind == "crew" and ident.isdigit() and user.role == Role.crew:
        return trips.user_ambulance_id(db, user) == int(ident)
    if kind == "hospital" and ident.isdigit() and user.role == Role.hospital_staff:
        return trips.user_hospital_id(db, user) == int(ident)
    return False


def _msg(type_: str, data: dict) -> str:
    return json.dumps({"type": type_, "data": data, "ts": datetime.now(timezone.utc).isoformat()})


@router.websocket("/api/ws")
async def ws_endpoint(ws: WebSocket, token: str = "", topics: str = "", share: str = ""):
    wanted = [t.strip() for t in topics.split(",") if t.strip()]
    payload_filter = None
    with dbmod.SessionLocal() as db:
        if share and not token:
            req = sharing.resolve(db, share)
            if req is None:
                await ws.close(code=4404, reason="share link not found or expired")
                return
            topic = f"request:{req.id}"
            payload_filter = sharing.share_filter((req.lat, req.lng))  # no names/phones/exact patient location
            denied = [t for t in wanted if t != topic]
            wanted = [topic]
        else:
            try:
                user = user_from_token(db, token)
            except Exception:
                await ws.close(code=4401, reason="invalid token")
                return
            denied = [t for t in wanted if not _allowed(db, user, t)]
    if denied:
        await ws.close(code=4403, reason=f"not permitted: {','.join(denied)}")
        return
    await ws.accept()
    for t in wanted:
        await hub.subscribe(t, ws, payload_filter)
    await ws.send_text(_msg("subscribed", {"topics": wanted}))
    try:
        while True:
            text = await ws.receive_text()
            if text.strip().lower() == "ping":
                await ws.send_text(_msg("pong", {}))
    except WebSocketDisconnect:
        pass
    finally:
        hub.unsubscribe_all(ws)
