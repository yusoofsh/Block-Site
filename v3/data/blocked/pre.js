'use strict';

// theme: follow the system unless the toggle on this page picked one
{
  const dark = localStorage.getItem('dark');
  if (dark === 'true' || dark === 'false') {
    document.documentElement.classList.add(dark === 'true' ? 'dark' : 'light');
  }
}

if (window === window.top) {
  document.documentElement.classList.add(localStorage.getItem('mode-top') || 'complete');
}
else {
  document.documentElement.classList.add(localStorage.getItem('mode-frame') || 'simple');
}
