/**
 * Frame sources: the live webcam, or an image / video file for testing.
 * All camera failures are mapped to a `CameraError` with a user-facing message and hint.
 */
import { CAMERA_CONFIG } from '../config';

export type CameraErrorKind =
  | 'permission'
  | 'notfound'
  | 'inuse'
  | 'insecure'
  | 'unsupported'
  | 'overconstrained'
  | 'ended'
  | 'unknown';

export class CameraError extends Error {
  constructor(
    public kind: CameraErrorKind,
    message: string,
    public hint = '',
  ) {
    super(message);
    this.name = 'CameraError';
  }
}

export interface FrameSource {
  readonly kind: 'camera' | 'video' | 'image';
  readonly element: HTMLVideoElement | HTMLImageElement;
  readonly label: string;
  readonly width: number;
  readonly height: number;
  /** Called if the source dies on its own (camera unplugged, permission revoked…). */
  onEnded?: (err: CameraError) => void;
  stop(): void;
}

function mapCameraError(err: unknown): CameraError {
  const e = err as DOMException;
  switch (e?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return new CameraError(
        'permission',
        'Camera access was blocked.',
        'Click the camera icon in the address bar (or your browser’s site settings), allow camera access for this page, then press Start camera again.',
      );
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return new CameraError('notfound', 'No camera was found.', 'Connect a webcam, then press Start camera. You can also test with an image or video file.');
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return new CameraError(
        'inuse',
        'The camera could not be started.',
        'It is probably in use by another application (Teams, Zoom, OBS, another tab…). Close it and try again.',
      );
    case 'OverconstrainedError':
      return new CameraError('overconstrained', 'The selected camera does not support the requested settings.', 'Try another camera from the list.');
    case 'SecurityError':
      return new CameraError('insecure', 'Camera access is not allowed on this page.', 'Open the app via http://localhost (npm run dev) or HTTPS.');
    default:
      return new CameraError('unknown', `Camera error: ${e?.message || String(err)}`, 'Try reloading the page or selecting another camera.');
  }
}

export async function listCameras(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  } catch {
    return [];
  }
}

async function waitForVideo(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 2 && video.videoWidth > 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CameraError('unknown', 'The camera did not deliver any frames.', 'Try another camera or reload the page.')), 10000);
    video.addEventListener('loadeddata', () => { clearTimeout(timer); resolve(); }, { once: true });
    video.addEventListener('error', () => { clearTimeout(timer); reject(new CameraError('unknown', 'Video element error.')); }, { once: true });
  });
}

export async function openCamera(video: HTMLVideoElement, deviceId?: string): Promise<FrameSource> {
  if (!window.isSecureContext)
    throw new CameraError('insecure', 'Camera access requires a secure context.', 'Open the app via http://localhost (npm run dev) or HTTPS, not via file:// or a LAN IP.');
  if (!navigator.mediaDevices?.getUserMedia)
    throw new CameraError('unsupported', 'This browser does not support camera access.', 'Use a recent Chrome, Edge or Firefox.');

  const video_: MediaTrackConstraints = {
    width: { ideal: CAMERA_CONFIG.idealWidth },
    height: { ideal: CAMERA_CONFIG.idealHeight },
    frameRate: { ideal: CAMERA_CONFIG.idealFrameRate },
    ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: CAMERA_CONFIG.facingMode }),
  };

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: video_, audio: false });
  } catch (err) {
    const mapped = mapCameraError(err);
    if (mapped.kind !== 'overconstrained') throw mapped;
    // Retry with no constraints at all.
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: deviceId ? { deviceId } : true, audio: false });
    } catch (err2) {
      throw mapCameraError(err2);
    }
  }

  const track = stream.getVideoTracks()[0];
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  try {
    await video.play();
    await waitForVideo(video);
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
    throw err instanceof CameraError ? err : mapCameraError(err);
  }

  const source: FrameSource = {
    kind: 'camera',
    element: video,
    label: track?.label || 'Camera',
    get width() { return video.videoWidth; },
    get height() { return video.videoHeight; },
    stop() {
      stream.getTracks().forEach((t) => t.stop());
      video.pause();
      video.srcObject = null;
    },
  };
  track?.addEventListener('ended', () =>
    source.onEnded?.(new CameraError('ended', 'The camera stopped unexpectedly.', 'It may have been unplugged or taken by another app. Press Start camera to reconnect.')),
  );
  return source;
}

/** Load an image or video (File or URL) as a frame source — handy for testing without a webcam. */
export async function openMedia(
  input: File | string,
  video: HTMLVideoElement,
  image: HTMLImageElement,
): Promise<FrameSource> {
  const url = typeof input === 'string' ? input : URL.createObjectURL(input);
  const name = typeof input === 'string' ? input.split('/').pop() || input : input.name;
  const type = typeof input === 'string' ? '' : input.type;
  const isVideo = type.startsWith('video/') || /\.(mp4|webm|mov|ogv|m4v)(\?|$)/i.test(name);
  const revoke = () => { if (typeof input !== 'string') URL.revokeObjectURL(url); };

  if (isVideo) {
    video.srcObject = null;
    video.src = url;
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    await waitForVideo(video);
    return {
      kind: 'video', element: video, label: name,
      get width() { return video.videoWidth; },
      get height() { return video.videoHeight; },
      stop() { video.pause(); video.removeAttribute('src'); video.load(); revoke(); },
    };
  }

  image.crossOrigin = 'anonymous';
  image.src = url;
  try {
    await image.decode();
  } catch {
    revoke();
    throw new Error(`Could not load image "${name}".`);
  }
  return {
    kind: 'image', element: image, label: name,
    get width() { return image.naturalWidth; },
    get height() { return image.naturalHeight; },
    stop() { image.removeAttribute('src'); revoke(); },
  };
}
