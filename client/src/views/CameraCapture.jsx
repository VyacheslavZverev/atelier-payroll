import React, { useEffect, useRef, useState } from 'react';

// Full-screen in-app camera: snap several invoices in a row, then hand the
// whole batch back at once. Captures at the camera's native resolution
// (ImageCapture when available, else a video frame); the upload pipeline
// downscales to 1600px afterwards, so quality matches the old single-shot flow.
export default function CameraCapture({ onDone, onCancel, onError }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const imageCaptureRef = useRef(null);
  const [shots, setShots] = useState([]); // { url, blob }
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 2560 },
            height: { ideal: 1440 }
          },
          audio: false
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const track = stream.getVideoTracks()[0];
        if (window.ImageCapture) {
          try {
            imageCaptureRef.current = new window.ImageCapture(track);
          } catch {
            imageCaptureRef.current = null;
          }
        }
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setReady(true);
      } catch {
        onError?.(
          new Error('Не удалось открыть камеру. Разрешите доступ к камере в браузере или используйте «Выбрать из галереи».')
        );
        onCancel();
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function capture() {
    if (busy || !ready) return;
    setBusy(true);
    try {
      let blob = null;
      if (imageCaptureRef.current) {
        try {
          blob = await imageCaptureRef.current.takePhoto();
        } catch {
          blob = null; // some devices reject takePhoto — fall back below
        }
      }
      if (!blob) {
        const video = videoRef.current;
        const w = video.videoWidth;
        const h = video.videoHeight;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(video, 0, 0, w, h);
        blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.92));
      }
      const url = URL.createObjectURL(blob);
      setShots((s) => [...s, { url, blob }]);
    } catch (e) {
      onError?.(e);
    } finally {
      setBusy(false);
    }
  }

  function removeShot(i) {
    setShots((s) => {
      URL.revokeObjectURL(s[i].url);
      return s.filter((_, idx) => idx !== i);
    });
  }

  function finish() {
    const blobs = shots.map((s) => s.blob);
    shots.forEach((s) => URL.revokeObjectURL(s.url));
    onDone(blobs);
  }

  function cancel() {
    shots.forEach((s) => URL.revokeObjectURL(s.url));
    onCancel();
  }

  return (
    <div className="camera-overlay">
      <video ref={videoRef} className="camera-video" autoPlay playsInline muted />

      <button className="camera-close" onClick={cancel} title="Закрыть">
        ✕
      </button>

      {shots.length > 0 && (
        <div className="camera-thumbs">
          {shots.map((s, i) => (
            <button key={i} className="camera-thumb" onClick={() => removeShot(i)} title="Удалить кадр">
              <img src={s.url} alt={`Кадр ${i + 1}`} />
              <span className="camera-thumb-x">✕</span>
            </button>
          ))}
        </div>
      )}

      <div className="camera-controls">
        <div className="camera-count">{shots.length > 0 ? `Кадров: ${shots.length}` : 'Снимайте накладные'}</div>
        <button className="camera-shutter" onClick={capture} disabled={!ready || busy} title="Снять" />
        <button className="btn btn-primary camera-done" onClick={finish} disabled={shots.length === 0}>
          Готово{shots.length > 0 ? ` (${shots.length})` : ''}
        </button>
      </div>
    </div>
  );
}
