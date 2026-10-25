"""Real-time layer (FR6): in-process WebSocket pub/sub hub. INotificationService realisation.

Topics:  request:{id}   -> requester tracking + crew + controller
         controller     -> all live-console updates (new requests, escalations, status changes)
         hospital:{id}  -> incoming-patient alerts
         crew:{ambulance_id} -> dispatch offers / route
Messages are JSON: {"type": str, "data": {...}, "ts": iso}
publish() is safe to call from sync (threadpool) code. For multi-instance AWS deployment swap the
internals for Redis/SNS pub-sub; the interface stays the same.
"""
import asyncio
import json
from collections import defaultdict
from datetime import datetime, timezone

from fastapi import WebSocket


class Hub:
    def __init__(self) -> None:
        self.topics: dict[str, set[WebSocket]] = defaultdict(set)
        self.loop: asyncio.AbstractEventLoop | None = None
        # per-socket payload filter (anonymous share subscribers); fn(type, data) -> data | None (drop)
        self.filters: dict[WebSocket, callable] = {}
        # signed-in sockets per user, with the loop serving each: revoking a user's sessions closes them (4401)
        self.users: dict[int, dict[WebSocket, asyncio.AbstractEventLoop]] = defaultdict(dict)

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop

    async def subscribe(self, topic: str, ws: WebSocket, payload_filter=None) -> None:
        if payload_filter is not None:
            self.filters[ws] = payload_filter
        self.topics[topic].add(ws)

    def unsubscribe_all(self, ws: WebSocket) -> None:
        for subs in self.topics.values():
            subs.discard(ws)
        self.filters.pop(ws, None)
        for socks in self.users.values():
            socks.pop(ws, None)

    def register_user(self, user_id: int, ws: WebSocket) -> None:
        """Call from the socket's own task, after accept."""
        self.users[user_id][ws] = asyncio.get_running_loop()

    def revoke_user(self, user_id: int) -> None:
        """Close every open socket of a user whose sessions were revoked (thread-safe)."""
        for ws, loop in list(self.users.pop(user_id, {}).items()):
            self.unsubscribe_all(ws)
            coro = _close_quietly(ws)
            try:
                running = asyncio.get_running_loop()
            except RuntimeError:
                running = None
            if running is loop:
                loop.create_task(coro)
            else:
                asyncio.run_coroutine_threadsafe(coro, loop)

    @staticmethod
    def render(type_: str, data: dict, ts: str) -> str:
        return json.dumps({"type": type_, "data": data, "ts": ts}, default=str)

    def message_for(self, ws: WebSocket, type_: str, data: dict, ts: str, full: str) -> str | None:
        """Text to send to one subscriber: the full message, or the filtered one (None = do not send)."""
        flt = self.filters.get(ws)
        if flt is None:
            return full
        try:
            safe = flt(type_, data)
        except Exception:  # noqa: BLE001 - a broken filter must fail closed
            return None
        return None if safe is None else self.render(type_, safe, ts)

    async def _broadcast(self, topic: str, type_: str, data: dict, ts: str, text: str) -> None:
        for ws in list(self.topics.get(topic, ())):
            msg = self.message_for(ws, type_, data, ts, text)
            if msg is None:
                continue
            try:
                await ws.send_text(msg)
            except Exception:
                self.topics[topic].discard(ws)

    def publish(self, topic: str, type_: str, data: dict) -> None:
        ts = datetime.now(timezone.utc).isoformat()
        text = self.render(type_, data, ts)
        if self.loop is None or not self.topics.get(topic):
            return
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        coro = self._broadcast(topic, type_, data, ts, text)
        if running is self.loop:
            self.loop.create_task(coro)
        else:
            asyncio.run_coroutine_threadsafe(coro, self.loop)


async def _close_quietly(ws: WebSocket) -> None:
    try:
        await ws.close(code=4401, reason="session revoked")
    except Exception:  # noqa: BLE001 - already closing
        pass


hub = Hub()


def publish(topic: str, type_: str, data: dict) -> None:
    hub.publish(topic, type_, data)
