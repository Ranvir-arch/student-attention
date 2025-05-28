from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from datetime import datetime
import base64
import os
import json
from typing import Optional
import cv2
import numpy as np
from collections import defaultdict, deque
import sqlite3
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi import Request, Query
import csv
from io import StringIO
from dotenv import load_dotenv
from fastapi.staticfiles import StaticFiles

# Load environment variables
load_dotenv()

# Configuration from environment variables
DB_PATH = os.getenv('DB_PATH', 'attention_scores.db')
IMAGES_DIR = os.getenv('IMAGES_DIR', 'images')
MEETING_DATA_DIR = os.getenv('MEETING_DATA_DIR', 'meeting_data')
PORT = int(os.getenv('PORT', 3000))
HOST = os.getenv('HOST', '0.0.0.0')
ALLOWED_ORIGINS = os.getenv('ALLOWED_ORIGINS', 'chrome-extension://*').split(',')

app = FastAPI()

# Mount the actual images directory to serve static files
# Use os.path.join with the current file's directory for a more reliable path
STATIC_IMAGES_DIR = os.path.join(os.path.dirname(__file__), "images")

# Ensure the static directory exists (useful for local testing, might not be needed on Render build)
# os.makedirs(STATIC_IMAGES_DIR, exist_ok=True)

app.mount("/images", StaticFiles(directory=STATIC_IMAGES_DIR), name="images")

# Enable CORS for the Chrome extension
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins
    allow_credentials=True,
    allow_methods=["*"],  # Allow all methods
    allow_headers=["*"],  # Allow all headers
    expose_headers=["*"]  # Expose all headers
)

# Create directories for storing images and meeting data
# These are used by the application for data, not for serving static files
os.makedirs(IMAGES_DIR, exist_ok=True)
os.makedirs(MEETING_DATA_DIR, exist_ok=True)

# In-memory attention tracking: { (meetingId, userId): deque([0/1,...]) }
ATTENTION_HISTORY = defaultdict(lambda: deque(maxlen=30))  # last 30 frames
# Short-term buffer for robust detection
SHORT_TERM_HISTORY = defaultdict(lambda: deque(maxlen=5))  # last 5 frames

# Load Haar cascades for face and eyes (use a more robust frontal face model)
face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_alt2.xml')
eye_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_eye.xml')
profile_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_profileface.xml')

# --- SQLite setup ---
def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute('''
        CREATE TABLE IF NOT EXISTS attention_scores (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            meeting_id TEXT NOT NULL,
            user_email TEXT NOT NULL,
            date TEXT NOT NULL,
            attention REAL,
            updated_at TEXT,
            attention_sum REAL DEFAULT 0,
            attention_count INTEGER DEFAULT 0,
            UNIQUE(meeting_id, user_email, date)
        )
    ''')
    # New table for attention history (per image)
    c.execute('''
        CREATE TABLE IF NOT EXISTS attention_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            meeting_id TEXT NOT NULL,
            user_email TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            attention REAL NOT NULL
        )
    ''')
    conn.commit()
    conn.close()
init_db()

class ImageData(BaseModel):
    imageData: str
    meetingId: str
    timestamp: str
    userId: Optional[str] = None  # Using userId for email now
    userName: Optional[str] = None  # Using userName for email as fallback

def detect_attention(image_bytes):
    nparr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        return 0
    
    # Convert to grayscale and enhance contrast
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.equalizeHist(gray)

    # Try to detect frontal face first
    faces = face_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=3)
    face_score = 0
    
    # If no frontal face, try profile face
    if len(faces) == 0:
        faces = profile_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=3)
        if len(faces) > 0:
            face_score = 0.5  # Profile face detected, partial score
    
    if len(faces) == 0:
        return 0  # No face detected

    # Calculate face position score
    img_height, img_width = gray.shape
    face_scores = []
    
    for (x, y, w, h) in faces:
        # Calculate how centered the face is
        face_center_x = x + w/2
        face_center_y = y + h/2
        center_dist_x = abs(face_center_x - img_width/2) / (img_width/2)
        center_dist_y = abs(face_center_y - img_height/2) / (img_height/2)
        
        # Face position score (1 if perfectly centered, 0 if at edge)
        position_score = 1 - (center_dist_x + center_dist_y)/2
        
        # Face size score (prefer faces that are not too small or too large)
        face_size_ratio = (w * h) / (img_width * img_height)
        size_score = 1 - abs(face_size_ratio - 0.1) * 5  # Optimal size around 10% of frame
        
        face_scores.append((position_score + size_score) / 2)

    # Get the best face score
    face_score = max(face_scores) if face_scores else 0

    # Eye detection and scoring
    eye_scores = []
    for (x, y, w, h) in faces:
        roi_gray = gray[y:y+h, x:x+w]
        eyes = eye_cascade.detectMultiScale(roi_gray, scaleFactor=1.1, minNeighbors=3)
        
        if len(eyes) == 0:
            continue
            
        for (ex, ey, ew, eh) in eyes:
            eye_img = roi_gray[ey:ey+eh, ex:ex+ew]
            
            # Calculate eye region intensity
            mean_intensity = np.mean(eye_img)
            threshold = int(mean_intensity * 0.7)
            _, thresh = cv2.threshold(eye_img, threshold, 255, cv2.THRESH_BINARY_INV)
            
            # Find pupil position
            ys, xs = np.where(thresh == 255)
            if len(xs) > 0:
                cx = np.mean(xs)
                cy = np.mean(ys)
                
                # Calculate how centered the pupil is
                center_x = ew / 2
                center_y = eh / 2
                norm_dist_x = abs(cx - center_x) / (ew / 2)
                norm_dist_y = abs(cy - center_y) / (eh / 2)
                
                # Combined eye score (1 if perfectly centered, 0 if at edge)
                eye_score = 1 - (norm_dist_x + norm_dist_y)/2
                eye_scores.append(eye_score)

    # Calculate final attention score
    if eye_scores:
        eye_score = np.mean(eye_scores)
        # Combine face and eye scores with weights
        attention_score = (face_score * 0.4 + eye_score * 0.6)
        return float(attention_score)
    else:
        # If no eyes detected but face is present, return partial score
        return float(face_score * 0.4)

@app.post("/api/images")
async def receive_image(data: ImageData):
    try:
        image_data = data.imageData.split(',')[1]
        image_bytes = base64.b64decode(image_data)
        timestamp = datetime.fromisoformat(data.timestamp.replace('Z', '+00:00'))
        
        # Get user email - prioritize userId, fallback to userName
        user_email = data.userId or data.userName or "unknown"
        
        meeting_data = {
            "meetingId": data.meetingId,
            "userEmail": user_email,
            "timestamp": data.timestamp,
        }
        meeting_data_path = os.path.join(MEETING_DATA_DIR, f"{data.meetingId}.json")
        with open(meeting_data_path, 'w') as f:
            json.dump(meeting_data, f, indent=2)
        
        # --- Attention detection ---
        key = (data.meetingId, user_email)
        raw_attention = detect_attention(image_bytes)
        
        # Store the continuous attention score directly
        attention = raw_attention
        
        # Store userEmail in a parallel dict for display
        if not hasattr(receive_image, 'user_emails'):
            receive_image.user_emails = {}
        
        receive_image.user_emails[key] = user_email
        ATTENTION_HISTORY[key].append(attention)
        
        # --- Store attention history for graph ---
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute(
            "INSERT INTO attention_history (meeting_id, user_email, timestamp, attention) VALUES (?, ?, ?, ?)",
            (data.meetingId, user_email, data.timestamp, float(attention))
        )
        conn.commit()
        conn.close()
        
        # --- SQLite upsert for running average ---
        if user_email and user_email != "unknown":
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            today = timestamp.strftime('%Y-%m-%d')
            now_iso = datetime.now().isoformat()
            
            # Try to update first
            c.execute('''
                SELECT attention_sum, attention_count FROM attention_scores
                WHERE meeting_id=? AND user_email=? AND date=?
            ''', (data.meetingId, user_email, today))
            
            row = c.fetchone()
            if row:
                new_sum = row[0] + float(attention)
                new_count = row[1] + 1
                avg = new_sum / new_count
                c.execute('''
                    UPDATE attention_scores
                    SET attention=?, attention_sum=?, attention_count=?, updated_at=?
                    WHERE meeting_id=? AND user_email=? AND date=?
                ''', (avg, new_sum, new_count, now_iso, data.meetingId, user_email, today))
            else:
                c.execute('''
                    INSERT INTO attention_scores (meeting_id, user_email, date, attention, updated_at, attention_sum, attention_count)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                ''', (data.meetingId, user_email, today, float(attention), now_iso, float(attention), 1))
            
            conn.commit()
            conn.close()
        
        return {
            "status": "success",
            "message": "Image processed and not stored",
            "attention": attention
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/health")
async def health_check():
    return {"status": "healthy"}

@app.get("/api/attention")
async def get_attention_scores():
    result = []
    user_emails = getattr(receive_image, 'user_emails', {})
    
    for (meetingId, userEmail), history in ATTENTION_HISTORY.items():
        if history:
            avg_attention = sum(history) / len(history)
        else:
            avg_attention = 0.0
        
        result.append({
            "meetingId": meetingId,
            "userEmail": userEmail,
            "attention_score": round(avg_attention, 2)
        })
    
    return result

@app.get("/api/db-attention", response_class=HTMLResponse)
async def db_attention_page():
    return """
    <html>
    <head>
        <title>Attention Scores Lookup</title>
        <script src='https://cdn.jsdelivr.net/npm/chart.js'></script>
        <style>
            /* Modern CSS Reset */
            *, *::before, *::after {
                box-sizing: border-box;
                margin: 0;
                padding: 0;
            }

            body {
                font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background: linear-gradient(135deg, #2c3e50 0%, #3498db 100%);
                min-height: 100vh;
                display: flex;
                justify-content: center;
                align-items: center;
                padding: 2rem;
                color: #2c3e50;
            }

            .container {
                background: rgba(255, 255, 255, 0.95);
                border-radius: 20px;
                padding: 2.5rem;
                width: 100%;
                max-width: 900px;
                box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
                backdrop-filter: blur(10px);
            }

            h2 {
                text-align: center;
                font-size: 2.5rem;
                color: #2c3e50;
                margin-bottom: 1.5rem;
                font-weight: 700;
            }

            .logo-container {
                text-align: center;
                margin-bottom: 2rem;
            }

            .logo-container img {
                max-width: 150px;
                height: auto;
                border-radius: 10px;
                box-shadow: 0 4px 10px rgba(0, 0, 0, 0.1);
            }

            form {
                margin-bottom: 2rem;
                text-align: center;
            }

            form label {
                display: block;
                margin-bottom: 0.5rem;
                font-weight: 600;
                color: #2c3e50;
            }

            form input[type='text'] {
                width: 100%;
                max-width: 400px;
                padding: 1rem 1.5rem;
                border: 2px solid #e0e0e0;
                border-radius: 12px;
                font-size: 1rem;
                transition: all 0.3s ease;
                background: white;
                margin-bottom: 1rem;
            }

            form input[type='text']:focus {
                outline: none;
                border-color: #3498db;
                box-shadow: 0 0 0 3px rgba(52, 152, 219, 0.2);
            }

            form button {
                padding: 1rem 2rem;
                background: linear-gradient(135deg, #3498db, #2980b9);
                color: white;
                border: none;
                border-radius: 12px;
                font-size: 1rem;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.3s ease;
            }

            form button:hover {
                transform: translateY(-2px);
                box-shadow: 0 5px 15px rgba(52, 152, 219, 0.3);
            }

            table {
                width: 100%;
                border-collapse: separate;
                border-spacing: 0;
                margin-top: 1.5rem;
                background: white;
                border-radius: 12px;
                overflow: hidden;
                box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            }

            th, td {
                padding: 1rem;
                text-align: left;
                border-bottom: 1px solid #e0e0e0;
            }

            th {
                background: #f8f9fa;
                font-weight: 600;
                color: #2c3e50;
            }

            td {
                color: #2c3e50;
            }

            tr:last-child td {
                border-bottom: none;
            }

            tr:hover td {
                background: #f8f9fa;
            }

            #results {
                margin-top: 1.5rem;
            }

            #results p {
                text-align: center;
                color: #666;
                font-style: italic;
            }

            /* Modal styles */
            .modal {
                display: none;
                position: fixed;
                z-index: 1000;
                left: 0;
                top: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.5);
                backdrop-filter: blur(5px);
                overflow: hidden;
            }

            .modal-content {
                background: white;
                margin: 5% auto;
                padding: 2rem;
                width: 90%;
                max-width: 800px;
                max-height: 80vh;
                border-radius: 20px;
                position: relative;
                box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
                display: flex;
                flex-direction: column;
            }

            .modal-content h3 {
                margin-bottom: 1rem;
            }

            .chart-container {
                position: relative;
                height: 400px;
                width: 100%;
                margin-top: 1rem;
            }

            .close {
                position: absolute;
                top: 1rem;
                right: 1.5rem;
                font-size: 1.5rem;
                color: #666;
                cursor: pointer;
                transition: color 0.3s ease;
            }

            .close:hover {
                color: #2c3e50;
            }

            /* Graph button styles */
            button.view-graph {
                padding: 0.5rem 1rem;
                background: linear-gradient(135deg, #3498db, #2980b9);
                color: white;
                border: none;
                border-radius: 8px;
                cursor: pointer;
                transition: all 0.3s ease;
                font-size: 0.9rem;
            }

            button.view-graph:hover {
                transform: translateY(-2px);
                box-shadow: 0 4px 10px rgba(52, 152, 219, 0.3);
            }

            @media (max-width: 768px) {
                .container {
                    padding: 1.5rem;
                }

                form input[type='text'] {
                    max-width: 100%;
                }

                table {
                    display: block;
                    overflow-x: auto;
                }

                .modal-content {
                    margin: 10% auto;
                    padding: 1.5rem;
                }
            }
        </style>
    </head>
    <body>
        <div class='container'>
            <div class='logo-container'>
                <img src='/images/logo_p.png' alt='Logo'>
            </div>
            <h2>Attention Scores Lookup</h2>
            <form id='meet-form'>
                <label for='meeting-id'>Meeting ID:</label>
                <input type='text' id='meeting-id' name='meeting-id' placeholder="Enter meeting ID..." required>
                <button type='submit'>Search</button>
            </form>
            <div id='results'></div>
        </div>
        <!-- Modal for graph -->
        <div id="graphModal" class="modal">
            <div class="modal-content">
                <span class="close" id="closeModal">&times;</span>
                <h3>Attention Graph</h3>
                <div class="chart-container">
                    <canvas id="attentionChart"></canvas>
                </div>
            </div>
        </div>
        <script>
        let chartInstance = null;
        document.getElementById('meet-form').onsubmit = async function(e) {
            e.preventDefault();
            const meetId = document.getElementById('meeting-id').value.trim();
            if (!meetId) return;
            document.getElementById('results').innerHTML = 'Loading...';
            const dataUrl = `${window.location.origin}/api/db-attention-data?meeting_id=${encodeURIComponent(meetId)}`;
            try {
                const resp = await fetch(dataUrl);
                if (!resp.ok) {
                    throw new Error(`HTTP error! status: ${resp.status}`);
                }
                const data = await resp.json();
                if (!data.length) {
                    document.getElementById('results').innerHTML = '<p>No data found for this meeting ID.</p>';
                    return;
                }
                let html = `<table><tr><th>User Email</th><th>Attention (%)</th><th>View Graph</th></tr>`;
                for (const row of data) {
                    html += `<tr>
                        <td>${row.user_email || ''}</td>
                        <td>${(row.attention_percent).toFixed(2)}</td>
                        <td><button class="view-graph" onclick="showGraph('${meetId}','${row.user_email}')">View Graph</button></td>
                    </tr>`;
                }
                html += '</table>';
                document.getElementById('results').innerHTML = html;
            } catch (error) {
                console.error('Error fetching data:', error);
                document.getElementById('results').innerHTML = '<p>Error loading data. Please try again.</p>';
            }
        };

        // Modal logic
        const modal = document.getElementById('graphModal');
        const closeModal = document.getElementById('closeModal');
        closeModal.onclick = function() {
            modal.style.display = 'none';
            if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
        };
        window.onclick = function(event) {
            if (event.target == modal) {
                modal.style.display = 'none';
                if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
            }
        };

        // Show graph function
        async function showGraph(meetingId, userEmail) {
            modal.style.display = 'block';
            const chartCanvas = document.getElementById('attentionChart');
            if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
            
            const url = `/api/attention-history?meeting_id=${encodeURIComponent(meetingId)}&user_email=${encodeURIComponent(userEmail)}`;
            const resp = await fetch(url);
            const data = await resp.json();
            
            if (!data.length) {
                chartCanvas.getContext('2d').clearRect(0, 0, chartCanvas.width, chartCanvas.height);
                chartCanvas.getContext('2d').fillText('No data available', 10, 50);
                return;
            }

            const labels = data.map(d => new Date(d.timestamp).toLocaleTimeString());
            const scores = data.map(d => d.attention * 100);
            
            chartInstance = new Chart(chartCanvas, {
                type: 'line',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'Attention (%)',
                        data: scores,
                        borderColor: '#3498db',
                        backgroundColor: 'rgba(52, 152, 219, 0.1)',
                        fill: true,
                        tension: 0.4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: {
                        duration: 1000,
                        easing: 'easeInOutQuart'
                    },
                    plugins: {
                        legend: {
                            position: 'top',
                        },
                        title: {
                            display: true,
                            text: 'Attention Score Over Time'
                        }
                    },
                    scales: {
                        y: {
                            min: 0,
                            max: 100,
                            title: {
                                display: true,
                                text: 'Attention (%)'
                            }
                        },
                        x: {
                            title: {
                                display: true,
                                text: 'Time'
                            }
                        }
                    }
                }
            });
        }
        </script>
    </body>
    </html>
    """

@app.get("/api/db-attention-data", response_class=JSONResponse)
async def db_attention_data(meeting_id: str = Query(...)):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT user_email, attention_sum, attention_count FROM attention_scores WHERE meeting_id=?", (meeting_id,))
    rows = c.fetchall()
    conn.close()
    result = [
        {
            "user_email": row[0],
            "attention_percent": (row[1] / row[2] * 100) if row[2] else 0.0
        }
        for row in rows
    ]
    return result

@app.get("/api/db-attention-score", response_class=JSONResponse)
async def db_attention_score(meeting_id: str = Query(...), user_email: str = Query(...)):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute(
        "SELECT attention_sum, attention_count FROM attention_scores WHERE meeting_id=? AND user_email=?",
        (meeting_id, user_email)
    )
    row = c.fetchone()
    conn.close()
    if row and row[1]:
        attention_percent = (row[0] / row[1]) * 100
    else:
        attention_percent = 0.0
    return {"user_email": user_email, "attention_percent": attention_percent}

@app.get("/api/attention-history", response_class=JSONResponse)
async def attention_history(meeting_id: str = Query(...), user_email: str = Query(...)):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute(
        "SELECT timestamp, attention FROM attention_history WHERE meeting_id=? AND user_email=? ORDER BY timestamp ASC",
        (meeting_id, user_email)
    )
    rows = c.fetchall()
    conn.close()
    return [{"timestamp": ts, "attention": att} for ts, att in rows]

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 3000))
    uvicorn.run(app, host=HOST, port=port) 