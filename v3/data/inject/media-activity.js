// auto-lock counts a playing video as activity (see idle.js). The worker asks
// every frame whether a video or audio element plays, and hears when one stops.
// A tab's "audible" flag is not enough: a muted video, or one in
// picture-in-picture, makes no sound the browser reports, but it is still playing

{
  // a muted loop is an autoplay clip on the page, not something being watched
  const ambient = e => e.muted && e.loop;
  const watched = e => !e.paused && !e.ended && !ambient(e);

  // players inside open shadow roots count too
  const playing = (root = document) => [...root.querySelectorAll('video, audio')].some(watched) ||
    [...root.querySelectorAll('*')].some(e => e.shadowRoot && playing(e.shadowRoot));

  chrome.runtime.onMessage.addListener((request, sender, response) => {
    // answer only when something plays: the worker takes the first answer of all frames
    if (request.method === 'media-playing' && playing()) {
      response(true);
    }
  });

  // playback stopping restarts the idle clock. Media events do not bubble, so capture them
  addEventListener('pause', e => {
    if (e.target instanceof HTMLMediaElement && ambient(e.target) === false) {
      chrome.runtime.sendMessage({method: 'media-stopped'}).catch(() => {});
    }
  }, true);
}
