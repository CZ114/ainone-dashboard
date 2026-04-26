r"""
BLE Bridge - BLE communication module using bleak.
"""
import asyncio
import sys
import threading
from typing import Optional, Callable

# BLE UUIDs
BLE_SERVICE_UUID = "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
BLE_CHAR_TX_UUID = "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"
BLE_DEVICE_NAME = "ESP32-S3-MultiSensor"


class BLEBridge:
    """BLE data receiver using bleak library"""

    def __init__(self):
        self.device_name = BLE_DEVICE_NAME
        self.service_uuid = BLE_SERVICE_UUID
        self.char_tx_uuid = BLE_CHAR_TX_UUID

        self.client = None
        self.running = False
        self.receive_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()

        # State
        self.is_connected = False
        self.is_enabled = True

        # Callbacks
        self.on_data_update: Optional[Callable] = None
        self.on_connection_change: Optional[Callable] = None

    def start_scan(self):
        """Start BLE scanning (runs in background thread)"""
        self.running = True
        self._stop_event.clear()

        self.receive_thread = threading.Thread(target=self._run, name="BLEReceive", daemon=True)
        self.receive_thread.start()
        print(f"[BLE] Starting BLE scan for {self.device_name}...")

    def _run(self):
        """BLE receive loop running in thread"""
        # Set Windows asyncio policy for this thread
        if sys.platform == 'win32':
            asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(self._ble_loop())
        finally:
            loop.close()

    async def _ble_loop(self):
        """BLE async receive loop"""
        from bleak import BleakClient, BleakScanner

        while self.running and not self._stop_event.is_set():
            try:
                # Scan for device
                device = await BleakScanner.find_device_by_name(self.device_name, timeout=5.0)

                if device is None:
                    print(f"[BLE] Device '{self.device_name}' not found, retrying...")
                    await asyncio.sleep(2)
                    continue

                print(f"[BLE] Found device: {device.name} ({device.address})")

                async with BleakClient(device, timeout=30.0) as client:
                    self.client = client
                    self.is_connected = True
                    if self.on_connection_change:
                        self.on_connection_change(True, self.device_name)

                    print(f"[BLE] Connected to {device.name}")

                    # Get NUS TX Characteristic
                    service = client.services.get_service(self.service_uuid)
                    if service:
                        tx_char = service.get_characteristic(self.char_tx_uuid)
                        if tx_char:
                            print(f"[BLE] Subscribing to {self.char_tx_uuid}")
                            await client.start_notify(tx_char, self._on_ble_notify)

                            # Keep connection until disconnect
                            while self.running and client.is_connected:
                                await asyncio.sleep(0.5)

                            await client.stop_notify(tx_char)

            except Exception as e:
                print(f"[BLE] Error: {e}")
                self.is_connected = False
                if self.on_connection_change:
                    self.on_connection_change(False)

            # Retry interval
            if self.running and not self._stop_event.is_set():
                await asyncio.sleep(2)

    def _on_ble_notify(self, sender, data):
        """BLE notification callback"""
        if not data or len(data) < 2:
            return

        try:
            # Try to parse as CSV text
            try:
                text = data.decode('utf-8').strip()
                print(f"[BLE] Received text: {text}")
                if text and self.on_data_update:
                    parts = text.split(',')
                    print(f"[BLE] Parts: {parts}")
                    if len(parts) >= 2:
                        values = []
                        for p in parts:
                            try:
                                values.append(float(p))
                            except ValueError:
                                pass
                        print(f"[BLE] Values: {values}")
                        if values:
                            self.on_data_update(values, text)
            except UnicodeDecodeError:
                pass

        except Exception as e:
            print(f"[BLE] Parse error: {e}")

    def stop(self):
        """Stop BLE receiver"""
        self.running = False
        self._stop_event.set()

        if self.receive_thread:
            self.receive_thread.join(timeout=2.0)

        self.is_connected = False
        if self.on_connection_change:
            self.on_connection_change(False)

        print("[BLE] Stopped")

    def is_connected(self) -> bool:
        return self.is_connected