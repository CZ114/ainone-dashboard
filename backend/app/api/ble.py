"""
BLE API routes
"""
from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import asyncio

router = APIRouter()


class BleScanRequest(BaseModel):
    """Optional device name override for the scan/connect call.

    When omitted, the bridge's existing device_name (initialised from
    config.BLE_DEVICE_NAME) is used. When supplied, the bridge is
    re-targeted at the new name for this and all subsequent scans
    until another override arrives.
    """
    device_name: Optional[str] = None


def get_connection_manager():
    from app.main import get_conn_manager
    return get_conn_manager()


@router.post("/scan")
async def start_ble_scan(request: BleScanRequest = BleScanRequest()):
    """Start BLE device scanning"""
    print(f"[API] BLE scan requested (device_name={request.device_name!r})")
    conn = get_connection_manager()
    conn.ble_start_scan(device_name=request.device_name)
    return {"scanning": True, "device_name": conn.ble_bridge.device_name}


@router.post("/connect")
async def connect_ble(request: BleScanRequest = BleScanRequest()):
    """Connect to BLE device (scan must be running)"""
    print(f"[API] BLE connect requested (device_name={request.device_name!r})")
    conn = get_connection_manager()
    conn.ble_start_scan(device_name=request.device_name)
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
    # Always return the bridge's current target device_name so the UI
    # can populate its input box even when nothing is connected yet.
    # `connected_to` exposes the live attachment separately.
    return {
        "connected": conn.ble_is_connected(),
        "device_name": conn.ble_bridge.device_name,
        "connected_to": conn.ble_bridge.device_name if conn.ble_is_connected() else None,
    }