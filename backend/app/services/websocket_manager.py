"""
WebSocket Manager - Manages WebSocket connections and broadcasting
"""
from fastapi import WebSocket
from typing import List, Dict, Any
import asyncio
import json
import threading
import queue


class WebSocketManager:
    """Manages WebSocket connections and broadcasts messages to all clients.

    Design: pure polling from the main event loop.
    - Background threads call schedule_broadcast() → queue.put_nowait() (instant return)
    - A single asyncio Task polls the queue every 50ms and broadcasts.
    No threads, no run_in_executor, no call_soon_threadsafe — no cross-thread hazards.
    """

    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self._lock = threading.Lock()
        self._msg_queue: queue.Queue = queue.Queue()

    def set_loop(self, loop: asyncio.AbstractEventLoop):
        loop.create_task(self._queue_drain_task())
        print("[WS] Queue drain task started")

    async def _queue_drain_task(self):
        """Poll queue every 50ms; dispatch broadcasts to all WS clients."""
        print("[WS] Queue drain task running")
        while True:
            await asyncio.sleep(0.05)  # 50ms poll interval — max 50ms latency
            try:
                while not self._msg_queue.empty():
                    message = self._msg_queue.get_nowait()
                    await self._do_broadcast(message)
            except Exception as e:
                print(f"[WS] Drain error: {e}")

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        with self._lock:
            self.active_connections.append(websocket)
        print(f"[WS] Client connected. Total: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket):
        with self._lock:
            if websocket in self.active_connections:
                self.active_connections.remove(websocket)
        print(f"[WS] Client disconnected. Total: {len(self.active_connections)}")

    async def _do_broadcast(self, message: Dict[str, Any]):
        with self._lock:
            if not self.active_connections:
                return
            connections = list(self.active_connections)

        message_str = json.dumps(message)
        disconnected = []

        for connection in connections:
            try:
                await asyncio.wait_for(
                    connection.send_text(message_str),
                    timeout=1.0
                )
            except asyncio.TimeoutError:
                print("[WS] Broadcast timeout for one connection")
                disconnected.append(connection)
            except Exception:
                disconnected.append(connection)

        for conn in disconnected:
            self.disconnect(conn)

    async def broadcast(self, message: Dict[str, Any]):
        await self._do_broadcast(message)

    def schedule_broadcast(self, message: Dict[str, Any]):
        """Thread-safe, instant — just enqueues the message."""
        try:
            self._msg_queue.put_nowait(message)
        except queue.Full:
            print("[WS] Message queue full, dropping broadcast")

    async def send_personal(self, websocket: WebSocket, message: Dict[str, Any]):
        try:
            await websocket.send_text(json.dumps(message))
        except Exception as e:
            print(f"[WS] Send error: {e}")
            self.disconnect(websocket)

    def get_connection_count(self) -> int:
        with self._lock:
            return len(self.active_connections)
