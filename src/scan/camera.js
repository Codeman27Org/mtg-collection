// Rear camera access for the scanner.

export class CameraError extends Error {}

function explain(err) {
  if (!window.isSecureContext) return 'The camera only works over HTTPS.';
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera permission was denied. Allow it in your browser’s site settings, or use a photo instead.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found on this device.';
    case 'NotReadableError':
      return 'The camera is busy in another app.';
    default:
      return `Couldn’t start the camera${err?.message ? `: ${err.message}` : ''}.`;
  }
}

const CAMERA_KEY = 'codys-mtg:scan-camera';

const getStream = (deviceId) =>
  navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }),
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      advanced: [{ focusMode: 'continuous' }],
    },
  });

const stopStream = (stream) => stream?.getTracks().forEach((t) => t.stop());

const canAutofocus = (track) => {
  const modes = track.getCapabilities?.().focusMode ?? [];
  return modes.includes('continuous') || modes.includes('single-shot');
};

/** Rear cameras, main first ("camera2 0, facing back" before "camera2 2, …"). Labels need camera permission. */
async function rearCameras() {
  const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  const rear = all.filter((d) => /back|rear|environment/i.test(d.label));
  const num = (d) => Number(d.label.match(/(\d+)(?!.*\d)/)?.[1] ?? 99);
  return (rear.length ? rear : all).map((d) => ({ deviceId: d.deviceId, label: d.label })).sort((a, b) => num(a) - num(b));
}

/**
 * Starts a rear camera in a <video>. deviceId picks one explicitly (and is remembered); otherwise the remembered
 * one, else the browser's choice, switching to another rear camera if that one can't autofocus.
 */
export async function openCamera(video, { deviceId } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) throw new CameraError(explain());
  const saved = deviceId ?? localStorage.getItem(CAMERA_KEY);
  let stream;
  try {
    stream = await getStream(saved).catch((err) => {
      if (!saved || deviceId) throw err;
      localStorage.removeItem(CAMERA_KEY);
      return getStream(null);
    });
  } catch (err) {
    throw new CameraError(explain(err));
  }
  let track = stream.getVideoTracks()[0];
  const cameras = await rearCameras().catch(() => []);

  // Some phones hand out a fixed-focus ultra-wide as "the" rear camera.
  if (!saved && !canAutofocus(track) && cameras.length > 1) {
    const first = track.getSettings().deviceId;
    for (const cam of cameras) {
      if (cam.deviceId === first) continue;
      // Phones often can't open two cameras at once.
      stopStream(stream);
      stream = await getStream(cam.deviceId).catch(() => null);
      track = stream?.getVideoTracks()[0];
      if (track && canAutofocus(track)) {
        localStorage.setItem(CAMERA_KEY, cam.deviceId);
        break;
      }
    }
    if (!track || !canAutofocus(track)) {
      stopStream(stream);
      stream = await getStream(first).catch((err) => {
        throw new CameraError(explain(err));
      });
      track = stream.getVideoTracks()[0];
    }
  }
  if (deviceId) localStorage.setItem(CAMERA_KEY, deviceId);

  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play().catch(() => {});

  const caps = track.getCapabilities?.() ?? {};
  const settings = track.getSettings?.() ?? {};
  // Each setting is its own advanced set, so one the device rejects doesn't cancel the others.
  const state = {};
  if (caps.focusMode?.includes('continuous')) state.focusMode = 'continuous';
  const apply = (c) => {
    Object.assign(state, c);
    return track.applyConstraints({ advanced: Object.entries(state).map(([k, v]) => ({ [k]: v })) }).catch(() => {});
  };
  if (state.focusMode) apply({});
  const range = (c, value) => (c && c.max > c.min ? { min: c.min, max: c.max, step: c.step || 0.1, value: value ?? c.min } : null);
  let refocus = null;

  return {
    deviceId: settings.deviceId,
    cameras,
    autofocus: canAutofocus(track),
    torch: !!caps.torch,
    zoom: range(caps.zoom, settings.zoom),
    exposure: range(caps.exposureCompensation, settings.exposureCompensation ?? 0),
    setTorch: (on) => apply({ torch: on }),
    setZoom: (value) => apply({ zoom: value }),
    setExposure: (value) => apply({ exposureCompensation: value }),
    /** Focus and meter on a point of the frame (0–1 each way), then go back to continuous focus. */
    focusAt(x, y) {
      const modes = caps.focusMode ?? [];
      apply({ pointsOfInterest: [{ x, y }], ...(modes.includes('single-shot') ? { focusMode: 'single-shot' } : {}) });
      clearTimeout(refocus);
      if (modes.includes('single-shot') && modes.includes('continuous')) refocus = setTimeout(() => apply({ focusMode: 'continuous' }), 2500);
    },
    stop() {
      clearTimeout(refocus);
      stopStream(stream);
      video.srcObject = null;
    },
  };
}

/** The current video frame as a canvas. */
export function grabFrame(video) {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  return canvas;
}

/** A photo file as a canvas (EXIF rotation applied). */
export async function photoCanvas(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const max = 2400;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas;
}
