import os
import sys
import threading
import time
import webbrowser

# Ensure the workspace directory is in sys.path
workspace_dir = os.path.dirname(os.path.abspath(__file__))
if workspace_dir not in sys.path:
    sys.path.insert(0, workspace_dir)

from cody.app import app

def open_browser():
    time.sleep(1.5)
    print("\n[OK] Automatically opening Cody Web UI in your browser...")
    webbrowser.open("http://127.0.0.1:5000")

if __name__ == "__main__":
    print("======================================================================")
    print("                      CODY: CODEBASE EXPLORER                         ")
    print("======================================================================")
    print("Preparing server stack...")
    
    # Start thread to trigger browser loading once server is online
    threading.Thread(target=open_browser, daemon=True).start()
    
    # Run the Flask app on localhost
    app.run(host="127.0.0.1", port=5000, debug=False)
