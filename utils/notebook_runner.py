from utils.notebook_status import update_status
from nbconvert.preprocessors import ExecutePreprocessor
import nbformat
from datetime import datetime, timezone
from pathlib import Path
import os
import time
import threading
import papermill as pm


def run_notebook(input_path, output_path, parameters=None):
    try:
        input_path = Path(input_path).resolve()
        output_path = Path(output_path).resolve()

        update_status({
            "notebook": input_path.name,
            "state": "running",
            "done": False,
            "progress": 0,
            "message": "🚀 Starting full AVU engine...",
            "updated_at": datetime.now(timezone.utc).isoformat()
        })

        # --- Simulated progress updater ---
        def progress_updater():
            try:
                for i in range(1, 6):
                    time.sleep(10)
                    update_status({
                        "notebook": input_path.name,
                        "state": "running",
                        "done": False,
                        "progress": i * 15,
                        "message": f"🚧 Processing... {i * 15}%",
                        "updated_at": datetime.now(timezone.utc).isoformat()
                    })
            except Exception as e:
                print(f"⚠️ Progress thread failed: {e}")

        thread = threading.Thread(target=progress_updater)
        thread.daemon = True
        thread.start()

        # --- Inject parameters and run the notebook ---
        pm.execute_notebook(
            input_path=str(input_path),
            output_path=str(output_path),
            parameters=parameters or {}
        )

        update_status({
            "notebook": input_path.name,
            "state": "completed",
            "done": True,
            "progress": 100,
            "message": "✅ Notebook executed successfully.",
            "updated_at": datetime.now(timezone.utc).isoformat()
        })

    except Exception as e:
        update_status({
            "notebook": input_path.name if 'input_path' in locals() else "Unknown",
            "state": "error",
            "done": True,
            "progress": 0,
            "message": f"❌ Error: {e}",
            "updated_at": datetime.now(timezone.utc).isoformat()
        })
        print(f"❌ Notebook execution failed: {e}")