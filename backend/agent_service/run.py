"""启动入口: 在 backend/ 目录下执行
    .venv\\Scripts\\python.exe -m agent_service.run
"""

import uvicorn

if __name__ == "__main__":
    uvicorn.run("agent_service.main:app", host="127.0.0.1", port=8100, log_level="info")
