let captureInterval = null;
const BACKEND_URL = 'https://student-attention.onrender.com/api/images';

// Listen for tab updates
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  console.log('Tab updated:', { 
    tabId, 
    url: tab.url, 
    status: changeInfo.status,
    isMeet: tab.url?.includes('meet.google.com')
  });

  if (changeInfo.status === 'complete' && tab.url && tab.url.includes('meet.google.com')) {
    console.log('Google Meet tab detected:', tabId);
    
    // Check if user is actually in a meeting
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      function: checkMeetingStatus
    }, (results) => {
      console.log('Meeting status check results:', results);
      if (results && results[0] && results[0].result) {
        console.log('User is in a meeting, starting capture');
        chrome.action.setBadgeText({ text: 'ON' });
        chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
        startCameraCapture(tabId);
      } else {
        console.log('User is not in a meeting');
        chrome.action.setBadgeText({ text: '' });
        stopCameraCapture();
      }
    });
  }
});

// Listen for tab removal
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  console.log('Tab closed, stopping capture');
  chrome.action.setBadgeText({ text: '' });
  stopCameraCapture();
});

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'IMAGE_CAPTURED') {
    console.log('Received image from content script for meeting:', message.meetingId);
    getDeviceId(function(deviceId) {
      sendImageToBackend(
        message.imageData,
        message.meetingId,
        message.userId,
        message.participantId,
        message.userName,
        deviceId
      )
      .then(result => {
        console.log('Image sent successfully from background:', result);
        sendResponse({ success: true });
      })
      .catch(error => {
        console.error('Failed to send image from background:', error);
        sendResponse({ success: false, error: error.message });
      });
    });
    // Return true to indicate async response
    return true;
  }
});

// Listen for tab activation (user switches to a tab)
chrome.tabs.onActivated.addListener(activeInfo => {
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (tab.url && tab.url.includes('meet.google.com')) {
      // Re-run the meeting status check and start capture if needed
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        function: checkMeetingStatus
      }, (results) => {
        if (results && results[0] && results[0].result) {
          chrome.action.setBadgeText({ text: 'ON' });
          chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
          startCameraCapture(tab.id);
        } else {
          chrome.action.setBadgeText({ text: '' });
          stopCameraCapture();
        }
      });
    }
  });
});

// Function to check if user is in a meeting
function checkMeetingStatus() {
  console.log('Checking meeting status...');
  
  // Log all video elements first
  const allVideos = document.querySelectorAll('video');
  console.log('All video elements found:', allVideos.length);
  allVideos.forEach((video, index) => {
    console.log(`Video ${index}:`, {
      width: video.videoWidth,
      height: video.videoHeight,
      readyState: video.readyState,
      hasStream: !!video.srcObject,
      classes: video.className,
      parentClasses: video.parentElement?.className,
      isPlaying: !video.paused,
      currentTime: video.currentTime
    });
  });

  // Check for various indicators that we're in a meeting
  const indicators = {
    mutedButton: document.querySelector('[data-is-muted]'),
    allocationIndex: document.querySelector('[data-allocation-index]'),
    participantId: document.querySelector('[data-participant-id]'),
    tooltip: document.querySelector('[data-tooltip-id="tt-m0"]'),
    meetingArea: document.querySelector('[data-meeting-area]'),
    meetingContainer: document.querySelector('[data-meeting-container]'),
    video: document.querySelector('video'),
    meetingTitle: document.querySelector('[data-meeting-title]'),
    meetingStatus: document.querySelector('[data-meeting-status]')
  };

  console.log('Meeting indicators found:', indicators);
  
  const isInMeeting = Object.values(indicators).some(indicator => indicator !== null);
  
  console.log('Meeting status check result:', isInMeeting);
  return isInMeeting;
}

// Function to start camera capture
function startCameraCapture(tabId) {
  console.log('Starting camera capture for tab:', tabId);
  if (captureInterval) {
    console.log('Clearing existing interval');
    clearInterval(captureInterval);
  }

  // Add a 1-second delay before the first capture
  setTimeout(() => {
    captureInterval = setInterval(() => {
      console.log('Attempting to capture image...');
      chrome.scripting.executeScript({
        target: { tabId: tabId },
        function: captureCameraImage
      }, (results) => {
        if (chrome.runtime.lastError) {
          console.error('Error executing script:', chrome.runtime.lastError);
        } else {
          console.log('Capture script execution results:', results);
        }
      });
    }, 2000); // Capture every 2 seconds
  }, 1000); // Initial delay
}

// Function to stop camera capture
function stopCameraCapture() {
  console.log('Stopping camera capture');
  if (captureInterval) {
    clearInterval(captureInterval);
    captureInterval = null;
  }
}

// Generate or retrieve a persistent deviceId
function getDeviceId(callback) {
  chrome.storage.local.get(['deviceId'], function(result) {
    if (result.deviceId) {
      callback(result.deviceId);
    } else {
      const newId = crypto.randomUUID();
      chrome.storage.local.set({ deviceId: newId }, function() {
        callback(newId);
      });
    }
  });
}

// Function to capture image from camera (runs in content script context)
function captureCameraImage(retryCount = 0) {
  console.log('Starting image capture process');
  const videoElements = Array.from(document.querySelectorAll('video'));
  console.log('Found video elements:', videoElements.length);

  let mainVideo = videoElements.find(video =>
    video.offsetWidth > 100 &&
    video.offsetHeight > 100 &&
    video.srcObject &&
    video.readyState === 4
  );

  if (!mainVideo) {
    if (retryCount < 10) {
      console.log('No suitable video element found, retrying...');
      setTimeout(() => captureCameraImage(retryCount + 1), 1000);
    } else {
      console.log('No suitable video element found after retries.');
    }
    return;
  }

  console.log('Found video element:', {
    width: mainVideo.videoWidth,
    height: mainVideo.videoHeight,
    readyState: mainVideo.readyState,
    hasStream: !!mainVideo.srcObject,
    classes: mainVideo.className,
    parentClasses: mainVideo.parentElement?.className,
    isPlaying: !mainVideo.paused,
    currentTime: mainVideo.currentTime
  });

  try {
    const canvas = document.createElement('canvas');
    canvas.width = mainVideo.videoWidth || 640;
    canvas.height = mainVideo.videoHeight || 480;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(mainVideo, 0, 0, canvas.width, canvas.height);

    const imageData = canvas.toDataURL('image/jpeg', 0.8);
    const meetingId = window.location.pathname.split('/').pop();
    // Try to extract userId, participantId, and userName from the page
    let userId = null;
    let participantId = null;
    let userName = null;
    // Extract userName from <span class="notranslate">
    const nameElem = document.querySelector('span.notranslate');
    if (nameElem) {
      userName = nameElem.textContent.trim();
    }
    const userElem = document.querySelector('[data-self-name]');
    if (userElem) {
      userId = userElem.getAttribute('data-self-name');
    }
    const participantElem = document.querySelector('[data-participant-id]');
    if (participantElem) {
      participantId = participantElem.getAttribute('data-participant-id');
    }
    // Send image data to background script (no deviceId here)
    chrome.runtime.sendMessage({
      type: 'IMAGE_CAPTURED',
      imageData,
      meetingId,
      userId,
      userName,
      participantId
    });
  } catch (error) {
    console.error('Error capturing image:', error);
  }
}

// Function to send image to backend
async function sendImageToBackend(imageData, meetingId, userId, participantId, userName, deviceId) {
  console.log('Sending image to backend for meeting:', meetingId);
  try {
    const response = await fetch(BACKEND_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Origin': chrome.runtime.getURL(''),
        'Access-Control-Allow-Origin': '*'
      },
      mode: 'cors',
      credentials: 'omit',
      body: JSON.stringify({
        imageData,
        meetingId,
        timestamp: new Date().toISOString(),
        userId,
        participantId,
        userName,
        deviceId
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json();
    console.log('Image sent successfully:', result);
    return result;
  } catch (error) {
    console.error('Error sending image to backend:', error);
    throw error;
  }
} 