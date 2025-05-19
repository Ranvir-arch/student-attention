document.addEventListener('DOMContentLoaded', function() {
  const statusDot = document.getElementById('status-dot');
  const statusLabel = document.getElementById('status-label');
  const imageGallery = document.getElementById('image-gallery');

  // Function to update status
  function updateStatus(isActive, message) {
    if (isActive) {
      statusDot.classList.add('active');
      statusDot.classList.remove('inactive');
    } else {
      statusDot.classList.add('inactive');
      statusDot.classList.remove('active');
    }
    statusLabel.textContent = message;
  }

  // Check if there's an active Google Meet tab
  chrome.tabs.query({}, function(tabs) {
    const meetTab = tabs.find(tab => 
      tab.url && tab.url.includes('meet.google.com') && tab.active
    );

    if (meetTab) {
      console.log('Found active Meet tab:', meetTab.id);
      
      // Execute script to check if user is in a meeting
      chrome.scripting.executeScript({
        target: { tabId: meetTab.id },
        function: checkMeetingStatus
      }, (results) => {
        if (results && results[0] && results[0].result) {
          console.log('User is in a meeting');
          updateStatus(true, 'Active - Sending images to server');
          imageGallery.innerHTML = '<p>Images are being sent to the server</p>';
        } else {
          console.log('User is not in a meeting');
          updateStatus(false, 'Inactive - Not in meeting');
          imageGallery.innerHTML = '<p>Join a meeting to start capturing</p>';
        }
      });
    } else {
      console.log('No active Meet tab found');
      updateStatus(false, 'Inactive - No Meet tab');
      imageGallery.innerHTML = '<p>Open Google Meet to start</p>';
    }
  });
});

// Function to check if user is in a meeting
function checkMeetingStatus() {
  const isInMeeting = 
    document.querySelector('[data-is-muted]') !== null ||
    document.querySelector('[data-allocation-index]') !== null ||
    document.querySelector('[data-participant-id]') !== null ||
    document.querySelector('[data-tooltip-id="tt-m0"]') !== null;

  return isInMeeting;
} 