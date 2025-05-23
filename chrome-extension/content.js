// content.js: Improved user identification for Google Meet, with focus on attention detection

const BACKEND_URL = 'https://student-attention.onrender.com/api/images';
let mediaStream = null;
let captureInterval = null;
let debugMode = true;

// Debug logging function
function debugLog(message, data) {
  if (debugMode) {
    const timestamp = new Date().toISOString();
    console.log(`[AttentionTracker ${timestamp}] ${message}`, data || '');
  }
}

// Log extension loading
debugLog('Extension loaded on: ' + window.location.href);

// Wait for page to be fully loaded before starting
window.addEventListener('load', () => {
  debugLog('Page fully loaded, starting camera with 2s delay');
  setTimeout(startCameraCapture, 2000); // Delay start to ensure DOM is ready
});

// Function to get user email from Chrome Identity API
async function getUserEmail() {
  return new Promise((resolve, reject) => {
    try {
      // We need to message the background script to get the email
      // since chrome.identity API is not directly available in content scripts
      chrome.runtime.sendMessage({action: "getEmail"}, function(response) {
        if (response && response.email) {
          debugLog('Got user email from Identity API', response.email);
          resolve(response.email);
        } else {
          debugLog('Failed to get email or email is empty', response);
          reject(new Error('Could not get user email'));
        }
      });
    } catch (error) {
      debugLog('Error getting user email', error);
      reject(error);
    }
  });
}

async function startCameraCapture() {
  debugLog('Starting camera capture');
  if (captureInterval) {
    clearInterval(captureInterval);
    debugLog('Cleared existing capture interval');
  }
  
  try {
    debugLog('Requesting camera access');
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        facingMode: "user" // Ensure front camera is used
      }
    });
    debugLog('Camera access granted', mediaStream.getVideoTracks().length + ' video tracks');
    
    // Create video element with explicit positioning
    const video = document.createElement('video');
    video.style.display = 'none'; // Hidden but active
    document.body.appendChild(video);
    video.srcObject = mediaStream;
    video.autoplay = true;
    video.playsInline = true;
    
    // Ensure video is centered in view for better face detection
    video.style.objectFit = 'cover';
    video.style.objectPosition = 'center';
    
    debugLog('Video element created, waiting for metadata');
    await new Promise((resolve) => {
      video.onloadedmetadata = () => {
        debugLog('Video metadata loaded, starting playback');
        video.play().then(() => {
          debugLog('Video playback started successfully');
          resolve();
        }).catch(err => {
          debugLog('Video playback failed', err);
          resolve(); // Continue anyway
        });
      };
    });
    
    // Wait a bit more for the video to fully initialize
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    debugLog('Setting up capture interval (every 3s)');
    captureInterval = setInterval(() => {
      captureAndSendImage(video);
    }, 3000); // Increase to 3 seconds for more stable detection
    
    // Do an immediate capture
    setTimeout(() => captureAndSendImage(video), 500);
  } catch (error) {
    debugLog('ERROR accessing camera:', error);
  }
}

function stopCameraCapture() {
  debugLog('Stopping camera capture');
  if (captureInterval) {
    clearInterval(captureInterval);
    captureInterval = null;
    debugLog('Cleared capture interval');
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
    debugLog('Stopped media tracks');
  }
}

// Clean up on page unload
window.addEventListener('unload', () => {
  debugLog('Page unloading, cleaning up');
  stopCameraCapture();
});

async function captureAndSendImage(video) {
  debugLog('Capture and send triggered');
  
  try {
    // First check if we're in a valid meeting
    if (!window.location.href.includes('meet.google.com')) {
      debugLog('Not on Google Meet, skipping capture');
      return;
    }
    
    // Ensure video has valid dimensions
    if (!video.videoWidth || !video.videoHeight) {
      debugLog('Video not ready yet, waiting for video dimensions');
      return;
    }
    
    // Create canvas and take snapshot
    debugLog('Creating canvas for capture');
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    
    const ctx = canvas.getContext('2d');
    try {
      // Proper drawing to canvas to ensure face is detected
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      
      // Enhancement: Add a visual indicator for face positioning
      // Draw a light face outline guide to help position the face
      const centerX = canvas.width / 2;
      const centerY = canvas.height / 2;
      const faceRadiusGuide = Math.min(canvas.width, canvas.height) * 0.25;
      
      // Draw a subtle face position guide (invisible in the sent image)
      ctx.strokeStyle = 'rgba(255,255,255,0.01)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(centerX, centerY, faceRadiusGuide, 0, Math.PI * 2);
      ctx.stroke();
      
      debugLog('Image captured to canvas successfully', {
        width: canvas.width,
        height: canvas.height
      });
    } catch (drawError) {
      debugLog('ERROR drawing to canvas:', drawError);
      return;
    }
    
    // Get user email using Chrome Identity API
    let userEmail = null;
    try {
      userEmail = await getUserEmail();
      if (!userEmail) {
        debugLog('Could not get user email, skipping data send to backend');
        return;
      }
    } catch (emailError) {
      debugLog('Error getting user email', emailError);
      return;
    }
    
    // Get meeting info
    const meetingId = window.location.pathname.split('/').pop() || 'default_meeting';
    const timestamp = new Date().toISOString();
    
    debugLog('Preparing to send data to server', {
      meetingId: meetingId,
      userEmail: userEmail
    });
    
    // Convert image to data URL - use high quality for better face detection
    let imageData;
    try {
      imageData = canvas.toDataURL('image/jpeg', 0.95); // Higher quality for better face detection
      debugLog('Image converted to data URL', { 
        length: imageData.length
      });
    } catch (imageError) {
      debugLog('ERROR converting image to data URL:', imageError);
      return;
    }
    
    // Prepare payload with all required fields
    const payload = {
      imageData: imageData,
      meetingId,
      timestamp,
      userName: userEmail, // Using email as the user name
      userId: userEmail    // Using email as the user ID
    };
    
    debugLog('Sending data to server');
    try {
      const response = await fetch(BACKEND_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      
      if (response.ok) {
        const result = await response.json();
        debugLog('Server response OK', result);
        
        // Check the attention value
        if (result.attention === 0) {
          debugLog('⚠️ ATTENTION SCORE IS ZERO - MAKE SURE YOUR FACE IS CLEARLY VISIBLE TO THE CAMERA');
        } else {
          debugLog('✅ ATTENTION DETECTED!');
        }
      } else {
        const errorText = await response.text();
        debugLog('Server response ERROR', {
          status: response.status,
          statusText: response.statusText,
          body: errorText
        });
      }
    } catch (fetchError) {
      debugLog('NETWORK ERROR sending to server:', fetchError);
    }
  } catch (error) {
    debugLog('ERROR in captureAndSendImage:', error);
  }
} 