"""
AinOne Dashboard - FastAPI Backend
Main application entry point
"""
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import asyncio

from app.services.websocket_manager import WebSocketManager
from app.services.connection_manager import ConnectionManager
from app.api import serial, ble, audio, recording, recordings, extensions, system
from app.api.websocket import router as ws_router
from app.extensions.manager import get_manager

# Global instances
_ws_manager: WebSocketManager = None
_conn_manager: ConnectionManager = None


def get_ws_manager() -> WebSocketManager:
    return _ws_manager


def get_conn_manager() -> ConnectionManager:
    return _conn_manager


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup - run synchronously before yielding
    global _ws_manager, _conn_manager

    print("[Lifespan] Starting...")
    _ws_manager = WebSocketManager()
    _ws_manager.set_loop(asyncio.get_running_loop())
    _conn_manager = ConnectionManager(_ws_manager)
    _conn_manager.start()
    print("[Lifespan] ConnectionManager started")

    # Bring up extensions that were previously enabled. Done after the
    # connection manager so extensions have access to AudioBridge etc.
    try:
        await get_manager().init_from_state(app)
    except Exception as e:
        print(f"[Lifespan] Extension init failed (continuing anyway): {e}")

    print("[Main] Backend started successfully")
    print("[Main] WebSocket available at: ws://localhost:8080/ws")

    yield

    # Shutdown
    print("[Lifespan] Shutting down...")
    try:
        await get_manager().shutdown()
    except Exception as e:
        print(f"[Lifespan] Extension shutdown error: {e}")
    if _conn_manager:
        _conn_manager.stop()
    print("[Lifespan] Shutdown complete")


# Create FastAPI app
app = FastAPI(
    title="AinOne Dashboard",
    description="Real-time sensor data visualization API",
    version="1.0.0",
    lifespan=lifespan
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(serial.router, prefix="/api/serial", tags=["Serial"])
app.include_router(ble.router, prefix="/api/ble", tags=["BLE"])
app.include_router(audio.router, prefix="/api/audio", tags=["Audio"])
app.include_router(recording.router, prefix="/api/recording", tags=["Recording"])
app.include_router(recordings.router, prefix="/api/recordings", tags=["Recordings Library"])
app.include_router(extensions.router, prefix="/api/extensions", tags=["Extensions"])
app.include_router(system.router, prefix="/api/system", tags=["System"])
app.include_router(ws_router, tags=["WebSocket"])


@app.get("/")
async def root():
    return {
        "name": "AinOne Dashboard API",
        "version": "1.0.0",
        "docs": "/docs",
        "websocket": "ws://localhost:8080/ws"
    }


@app.get("/api/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "connections": {
            "serial": _conn_manager.serial_is_connected() if _conn_manager else False,
            "ble": _conn_manager.ble_is_connected() if _conn_manager else False,
            "audio": _conn_manager.audio_is_connected() if _conn_manager else False,
        },
        "websocket_clients": _ws_manager.get_connection_count() if _ws_manager else 0
    }