# Attention Tracker

A FastAPI-based application for tracking user attention during meetings using computer vision.

## Features

- Real-time attention detection using OpenCV
- Face and eye tracking
- Meeting data storage
- Attention score calculation
- RESTful API endpoints

## Setup

1. Install dependencies:
```bash
pip install -r requirements.txt
```

2. Create a `.env` file with the following variables:
```
DB_PATH=attention_scores.db
IMAGES_DIR=images
MEETING_DATA_DIR=meeting_data
PORT=3000
HOST=0.0.0.0
ALLOWED_ORIGINS=chrome-extension://*
```

3. Run the application:
```bash
uvicorn server.main:app --host 0.0.0.0 --port 3000
```

## API Endpoints

- `POST /api/images`: Receive and process images
- `GET /api/health`: Health check endpoint
- `GET /api/attention`: Get current attention scores
- `GET /api/db-attention`: HTML page for attention scores lookup
- `GET /api/db-attention-data`: Get attention data for a specific meeting

## Deployment

The application can be deployed on Render.com using the provided `render.yaml` configuration.

## License

MIT 