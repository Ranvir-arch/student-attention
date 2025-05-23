let captureInterval = null;
const BACKEND_URL = 'https://student-attention.onrender.com/api/images';
let mediaStream = null;

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
      } else {
        console.log('User is not in a meeting');
        chrome.action.setBadgeText({ text: '' });
      }
    });
  }
});

// Listen for tab removal
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  console.log('Tab closed, stopping capture');
  chrome.action.setBadgeText({ text: '' });
});

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'IMAGE_CAPTURED') {
    console.log('Received image from content script for meeting:', message.meetingId);
    sendImageToBackend(
      message.imageData,
      message.meetingId,
      message.userId,
      message.userName
    )
    .then(result => {
      console.log('Image sent successfully from background:', result);
      sendResponse({ success: true });
    })
    .catch(error => {
      console.error('Failed to send image from background:', error);
      sendResponse({ success: false, error: error.message });
    });
    // Return true to indicate async response
    return true;
  }
  
  // Handle email request from content script
  if (message.action === "getEmail") {
    console.log('Content script requested user email');
    chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, (userInfo) => {
      console.log('Got user info from Chrome Identity API:', userInfo);
      if (userInfo && userInfo.email) {
        console.log('Sending email to content script:', userInfo.email);
        sendResponse({ email: userInfo.email });
      } else {
        console.error('No email found in user profile');
        sendResponse({ email: null, error: 'No email found' });
      }
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
        } else {
          chrome.action.setBadgeText({ text: '' });
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

// Function to send image to backend
async function sendImageToBackend(imageData, meetingId, userId, userName) {
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
        userName
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