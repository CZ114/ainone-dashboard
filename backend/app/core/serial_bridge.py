r"""
Serial Bridge - Serial communication module for ESP32 sensor boards.
"""
import serial
import serial.tools.list_ports
import threading
import queue
from typing import Optional, Callable


class SerialBridge:
    """Serial port communication handler"""

    def __init__(self):
        self.serial_port: Optional[serial.Serial] = None
        self.is_connected = False
        self.running = False
        self.read_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self.data_queue: queue.Queue = queue.Queue()

        # Callbacks
        self.on_data: Optional[Callable] = None
        self.on_connection_change: Optional[Callable] = None

    def list_ports(self) -> list:
        """List available serial ports"""
        ports = serial.tools.list_ports.comports()
        return [{"port": p.device, "desc": p.description} for p in ports]

    def connect(self, port: str, baud_rate: int = 115200, timeout: float = 1.0) -> bool:
        """Connect to serial port"""
        print(f"[SerialBridge] connect called: {port} @ {baud_rate}")
        if self.is_connected:
            print("[SerialBridge] Already connected, disconnecting first")
            self.disconnect()

        try:
            print(f"[SerialBridge] Creating serial connection...")
            self.serial_port = serial.Serial(
                port=port,
                baudrate=baud_rate,
                timeout=timeout,
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE
            )
            print(f"[SerialBridge] Serial connected!")
            self.is_connected = True
            self.running = True
            self._stop_event.clear()

            # Start read thread
            self.read_thread = threading.Thread(target=self._read_loop, name="SerialRead", daemon=True)
            self.read_thread.start()
            print(f"[SerialBridge] Read thread started")

            if self.on_connection_change:
                self.on_connection_change(True, port, baud_rate)

            return True
        except Exception as e:
            print(f"Serial connection error: {e}")
            self.is_connected = False
            return False

    def disconnect(self):
        """Disconnect from serial port"""
        self.running = False
        self._stop_event.set()

        if self.read_thread and self.read_thread.is_alive():
            self.read_thread.join(timeout=2.0)

        if self.serial_port and self.serial_port.is_open:
            try:
                self.serial_port.close()
            except Exception:
                pass

        self.is_connected = False
        self.serial_port = None

        if self.on_connection_change:
            self.on_connection_change(False)

    def _read_loop(self):
        """Background thread for reading serial data"""
        buffer = ""
        print(f"[Serial] Read loop started, port: {self.serial_port}")

        while self.running and not self._stop_event.is_set():
            try:
                if self.serial_port and self.serial_port.is_open:
                    if self.serial_port.in_waiting > 0:
                        data = self.serial_port.read(self.serial_port.in_waiting)
                        try:
                            text = data.decode('utf-8', errors='ignore')
                            buffer += text

                            # Process complete lines
                            while '\n' in buffer:
                                line, buffer = buffer.split('\n', 1)
                                line = line.strip()
                                if line:
                                    print(f"[Serial] Received line: {line}")
                                    if self.on_data:
                                        self.on_data(line)
                                    self.data_queue.put(line)
                        except Exception as e:
                            print(f"Decode error: {e}")
                else:
                    break
            except Exception as e:
                print(f"Serial read error: {e}")
                break

        self.is_connected = False
        print("[Serial] Read loop ended")

    def get_queue(self) -> queue.Queue:
        return self.data_queue

    def clear_queue(self):
        """Clear the data queue"""
        while not self.data_queue.empty():
            try:
                self.data_queue.get_nowait()
            except queue.Empty:
                break