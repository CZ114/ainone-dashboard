"""
Serial API routes
"""
from fastapi import APIRouter, HTTPException
from app.models.schemas import SerialConnectRequest

router = APIRouter()


def get_connection_manager():
    """Get connection manager from app state"""
    from app.main import get_conn_manager
    return get_conn_manager()


@router.get("/ports")
async def list_ports():
    """List available serial ports"""
    print("[API] Serial ports requested")
    conn = get_connection_manager()
    ports = conn.serial_list_ports()
    print(f"[API] Found {len(ports)} ports: {[p['port'] for p in ports]}")
    return {"ports": ports}


@router.post("/connect")
async def connect_serial(request: SerialConnectRequest):
    """Connect to serial port"""
    print(f"[API] Serial connect requested: {request.port} @ {request.baud_rate}")
    conn = get_connection_manager()

    if conn.serial_is_connected():
        print("[API] Already connected, disconnecting first")
        conn.serial_disconnect()

    print("[API] Calling serial_connect...")
    success = conn.serial_connect(request.port, request.baud_rate)
    print(f"[API] serial_connect returned: {success}")

    if not success:
        raise HTTPException(status_code=400, detail="Failed to connect to serial port")

    return {"connected": True, "port": request.port, "baud_rate": request.baud_rate}


@router.post("/disconnect")
async def disconnect_serial():
    """Disconnect from serial port"""
    print("[API] Serial disconnect requested")
    conn = get_connection_manager()
    conn.serial_disconnect()
    return {"connected": False}


@router.get("/status")
async def get_status():
    """Get serial connection status"""
    conn = get_connection_manager()
    return {
        "connected": conn.serial_is_connected(),
        "port": conn.serial_bridge.serial_port.port if conn.serial_bridge.serial_port else None,
        "baud_rate": conn.serial_bridge.serial_port.baudrate if conn.serial_bridge.serial_port else None
    }