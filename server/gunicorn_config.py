import multiprocessing

# Server socket
bind = "0.0.0.0:3000"
backlog = 2048

# Worker processes
workers = multiprocessing.cpu_count() * 2 + 1
worker_class = "uvicorn.workers.UvicornWorker"
worker_connections = 1000
timeout = 30
keepalive = 2

# Logging
accesslog = "access.log"
errorlog = "error.log"
loglevel = "info"

# Process naming
proc_name = "attention-tracker"

# SSL (uncomment and configure if using SSL)
# keyfile = "path/to/keyfile"
# certfile = "path/to/certfile" 