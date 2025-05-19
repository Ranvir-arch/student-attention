# Google Meet Image Capture Server

This is a Python server that receives images and meeting data from the Google Meet Chrome extension.

## Features

- Receives and stores images captured from Google Meet
- Stores meeting metadata including meeting ID, user ID, and participant ID
- Provides a health check endpoint
- Supports CORS for Chrome extension requests

## Setup

1. Create a virtual environment (recommended):
```bash
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
```

2. Install dependencies:
```bash
pip install -r requirements.txt
```

## Running the Server

Start the server with:
```bash
python main.py
```

The server will run on `http://localhost:3000` by default.

## API Endpoints

- `POST /api/images`: Receives image data and meeting information
  - Required fields: imageData (base64), meetingId, timestamp
  - Optional fields: userId, participantId

- `GET /api/health`: Health check endpoint

## Data Storage

The server creates two directories:
- `images/`: Stores captured images
- `meeting_data/`: Stores meeting metadata in JSON format

## Security Note

This server is designed for local development and testing. For production use, please implement proper security measures such as:
- Authentication
- HTTPS
- Rate limiting
- Input validation
- Secure file storage 