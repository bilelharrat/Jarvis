// Seeing for the owner (features/camera_look.py): on camera_cmd, open the camera, let it settle (and give the owner the
// seconds asked for to hold something up), take one frame, close the camera and send the frame back. Nothing is kept.
(function (root) {
  'use strict';
  const F = root.jarvisFeatures;
  if (!F || !root.document) return;
  const doc = root.document;
  const sleep = (ms) => new Promise((r) => root.setTimeout(r, ms));
  const LONG_SIDE = 1600; // enough to read a page; the image model reads about this much
  let busy = false;

  function say(text) {
    const a11y = root.jarvisAccessibility;
    if (a11y && a11y.announce) a11y.announce(text);
  }

  async function snap(wait) {
    const media = root.navigator && root.navigator.mediaDevices;
    if (!media || !media.getUserMedia) throw new Error('This computer has no camera the app can use.');
    let stream;
    try {
      stream = await media.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    } catch (err) {
      const name = err && err.name;
      if (name === 'NotAllowedError') throw new Error('The camera is turned off for apps. In Windows Settings, choose Privacy and security, then Camera, and let desktop apps use it.');
      if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new Error('No camera was found on this computer.');
      if (name === 'NotReadableError') throw new Error('Another program is using the camera.');
      throw new Error(`The camera didn't open (${name || err}).`);
    }
    try {
      const video = doc.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      await sleep(1200 + Math.max(0, Math.min(10, Number(wait) || 0)) * 1000); // exposure and focus settle
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) throw new Error('The camera gave no picture.');
      const scale = Math.min(1, LONG_SIDE / Math.max(w, h));
      const canvas = doc.createElement('canvas');
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.88);
    } finally {
      stream.getTracks().forEach((t) => t.stop());
    }
  }

  F.on('camera_cmd', async (ev) => {
    if (!ev || !ev.id || busy) return;
    if (doc.body && doc.body.dataset.app === 'eden-code') return; // (J.A.R.V.I.S.'s window answers)
    busy = true;
    const wait = Number(ev.wait) || 0;
    say(wait > 1.5 ? `Looking through the camera in ${Math.round(wait)} seconds. Hold it in front of the camera.` : 'Looking through the camera.');
    try {
      const image = await snap(wait);
      F.send({ type: 'camera_result', id: ev.id, image });
    } catch (err) {
      F.send({ type: 'camera_result', id: ev.id, error: String((err && err.message) || err) });
    } finally {
      busy = false;
    }
  });

  root.jarvisCamera = { snap };
})(typeof window !== 'undefined' ? window : globalThis);
