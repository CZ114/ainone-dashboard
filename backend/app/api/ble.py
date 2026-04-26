"""
BLE API routes
"""
from fastapi import APIRouter, HTTPException
import asyncio

router = APIRouter()


def get_connection_manager():
    from app.main import get_conn_manager
    return get_conn_manager()


@router.post("/scan")
async def start_ble_scan():
    """Start BLE device scanning"""
    print("[API] BLE scan requested")
    conn = get_connection_manager()
    conn.ble_start_scan()
    return {"scanning": True, "device_name": conn.ble_bridge.device_name}


@router.post("/connect")
async def connect_ble():
    """Connect to BLE device (scan must be running)"""
    print("[API] BLE connect requested")
    conn = get_connection_manager()
    conn.ble_start_scan()
    return {"connected": True, "device_name": conn.ble_bridge.device_name}


@router.post("/disconnect")
async def disconnect_ble():
    """Disconnect from BLE device"""
    print("[API] BLE disconnect requested")
    conn = get_connection_manager()
    conn.ble_stop()
    return {"connected": False}


@router.get("/status")
async def get_ble_status():
    """Get BLE connection status"""
    conn = get_connection_manager()
    return {
        "connected": conn.ble_is_connected(),
        "device_name": conn.ble_bridge.device_name if conn.ble_is_connected() else None
    }