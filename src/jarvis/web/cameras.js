// Which camera hand control opens (hands.js). The owner's pick is kept by name
// (features/hand-camera.js puts it in window.jarvisHandCamera): a device's id is made for
// the page's address, which changes with the backend's port, while its name stays. No pick,
// or a camera that isn't plugged in: null, and hands.js opens the Mac's default.

export const VIDEO = { width: 640, height: 480, frameRate: 30 };

// The device id of the camera called `wanted` among enumerateDevices()'s devices, or null.
export function pickCamera(devices, wanted) {
  if (!wanted || typeof wanted !== 'string' || !Array.isArray(devices)) return null;
  const found = devices.find((d) => d && d.kind === 'videoinput' && d.label === wanted && d.deviceId);
  return found ? found.deviceId : null;
}

// The cameras' names, each once, in the Mac's order (a name is empty until the camera is
// allowed: those are left out).
export function cameraNames(devices) {
  const names = [];
  for (const d of Array.isArray(devices) ? devices : []) {
    if (d && d.kind === 'videoinput' && d.label && !names.includes(d.label)) names.push(d.label);
  }
  return names;
}

// The stream for hand control: the picked camera if it's there and opens, else the default.
export async function openCamera(media = globalThis.navigator && globalThis.navigator.mediaDevices, wanted = globalThis.jarvisHandCamera) {
  let id = null;
  if (wanted) {
    try { id = pickCamera(await media.enumerateDevices(), wanted); } catch (_err) { /* no list: the default */ }
  }
  if (id) {
    try {
      return await media.getUserMedia({ video: { ...VIDEO, deviceId: { exact: id } }, audio: false });
    } catch (_err) { /* unplugged meanwhile, or in use: the default instead */ }
  }
  return media.getUserMedia({ video: VIDEO, audio: false });
}
