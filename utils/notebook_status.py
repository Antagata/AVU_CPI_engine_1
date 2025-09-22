# utils/notebook_status.py
from pathlib import Path
from datetime import datetime, timezone
import json, threading, time

_STATUS_PATH = Path("notebooks") / "status.json"
_LOCK = threading.Lock()

def _now_iso():
    return datetime.now(timezone.utc).isoformat()

def update_status(data: dict):
    """Merge update into status.json and always refresh updated_at."""
    with _LOCK:
        prev = {}
        if _STATUS_PATH.exists():
            try:
                prev = json.loads(_STATUS_PATH.read_text(encoding="utf-8") or "{}")
            except Exception:
                prev = {}
        prev.update(data or {})
        prev["updated_at"] = _now_iso()
        _STATUS_PATH.write_text(json.dumps(prev, indent=2), encoding="utf-8")

def get_status():
    if not _STATUS_PATH.exists():
        return {}
    try:
        return json.loads(_STATUS_PATH.read_text(encoding="utf-8") or "{}")
    except Exception:
        return {}

class Heartbeat:
    """Background heartbeat to prevent UI 'stuck at 75%'—refreshes updated_at."""
    def __init__(self, interval=5, notebook="(unknown)", base_message=None):
        self.interval = interval
        self.notebook = notebook
        self.base_message = base_message or "Processing…"
        self._stop = threading.Event()
        self._th = None

    def start(self):
        if self._th and self._th.is_alive(): return
        def _run():
            while not self._stop.is_set():
                update_status({
                    "notebook": self.notebook,
                    "state": "running",
                    "message": self.base_message,
                })
                self._stop.wait(self.interval)
        self._th = threading.Thread(target=_run, daemon=True)
        self._th.start()

    def stop(self):
        self._stop.set()
