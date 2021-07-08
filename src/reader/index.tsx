import React, {
  MutableRefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { getDeviceId } from "./getDeviceId";
// Require adapter to support older browser implementations
import "webrtc-adapter";

import QrWorker from "./qr.worker";

export interface QrReaderProps {
  onScan: (res: string) => void;
  onError: (err: string) => void;
  onLoad?: (args: any) => void;
  delay?: number | boolean;
  facingMode?: "user" | "environment";
  resolution?: number;
  showViewFinder?: boolean;
  style?: any;
  className?: string;
  constraints?: object | null;
  urls: string[]
}

const Reader: React.FC<QrReaderProps> = ({
  onScan,
  onError,
  onLoad,
  delay = 500,
  facingMode = "environment",
  resolution = 600,
  showViewFinder = true,
  style,
  className,
  constraints = null,
  urls
}) => {
  const els = useRef({}) as any;
  const stopTimeout = useRef() as MutableRefObject<number | undefined | null>;
  const worker = useRef() as MutableRefObject<any>;
  const stopCamera = useRef() as MutableRefObject<Function>;
  const stopped = useRef(false) as MutableRefObject<boolean>;

  const [mirrorVideo, setMirrorVideo] = useState(false);

  const createWorker = useCallback(() => {
    worker.current = new QrWorker();
  }, []);

  const drawToCanvas: any = useCallback(() => {
    const { canvas, preview } = els.current;

    if(!preview) return null;

    // Get image/video dimensions
    let width = Math.floor(preview.videoWidth);
    let height = Math.floor(preview.videoHeight);

    // Canvas draw offsets
    let hozOffset = 0;
    let vertOffset = 0;

    // Scale image to correct resolution

    // Crop image to fit 1:1 aspect ratio
    const smallestSize = width < height ? width : height;
    const ratio = resolution / smallestSize;

    height = ratio * height;
    width = ratio * width;

    vertOffset = ((height - resolution) / 2) * -1;
    hozOffset = ((width - resolution) / 2) * -1;

    canvas.width = resolution;
    canvas.height = resolution;

    const context = canvas.getContext("2d");
    //context.imageSmoothingEnabled = false; // gives less blurry images
    context.drawImage(preview, hozOffset, vertOffset, width, height);
    return context;
  }, [resolution]);

  const scanFrameAsync = useCallback(() => {
    const { canvas } = els.current;
    let promise = Promise.all([worker.current || createWorker()]).then(() => {
      const canvasContext = drawToCanvas();
      if(!canvasContext) return;

      return new Promise((resolve, reject) => {
        let timeout: number, onMessage: any, onError: any;
        const qrEngine = worker.current;
        onMessage = (event: any) => {
          if (event.data.type !== "qrResult") {
            return;
          }
          qrEngine.removeEventListener("message", onMessage);
          qrEngine.removeEventListener("error", onError);
          clearTimeout(timeout);
          if (typeof event.data.data === "string" && urls.indexOf(event.data.data) > -1) {
            resolve(event.data.data);
          } else {
            reject("No Code Found");
          }
        };
        onError = (e: any) => {
          qrEngine.removeEventListener("message", onMessage);
          qrEngine.removeEventListener("error", onError);
          clearTimeout(timeout);
          const errorMessage = !e ? "Unknown Error" : e.message || e;
          reject("Scanner error: " + errorMessage);
        };
        qrEngine.addEventListener("message", onMessage);
        qrEngine.addEventListener("error", onError);
        timeout = window.setTimeout(() => onError("timeout"), 10000);


        const imageData = canvasContext.getImageData(
          0,
          0,
          canvas.width,
          canvas.height
        );
        qrEngine.postMessage({ type: "decode", data: imageData });
      });
    });

    promise = promise.finally(() => {
      return;
    });

    return promise;
  }, [createWorker, drawToCanvas, urls]);

  const onDecode = useCallback((value: any) => {
    if (typeof value === "string") onScan(value); return ""
  }, [onScan]);

  const onDecodeError = useCallback((error: string) => {
    if (error === "No Code Found") return error;
  }, []);

  const scanFrame = useCallback(() => {
    const { preview } = els.current;
    if (stopped.current || !preview || preview.paused || preview.ended)
      return false;
    // using requestAnimationFrame to avoid scanning if tab is in background
    requestAnimationFrame(() => {
      if (preview.readyState <= 1) {
        // Skip scans until the video is ready as drawImage() only works correctly on a video with readyState
        // > 1, see https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/drawImage#Notes.
        // This also avoids false positives for videos paused after a successful scan which remains visible on
        // the canvas until the video is started again and ready.
        scanFrame();
        return;
      }

      scanFrameAsync()
        .then(onDecode, (error) => {
          const errorMessage = error.message || error;
          onDecodeError(errorMessage);
          return errorMessage;
        })
        .then((error:string) => {
          if(error && error.length > 0) {
            scanFrame();
          }
        });
    });
  }, [onDecode, onDecodeError, scanFrameAsync]);

  const onPlay = useCallback(() => {
    scanFrame();
  }, [scanFrame]);

  const handleLoadStart = useCallback(() => {
    const preview = els.current.preview;
    preview.addEventListener("play", onPlay);
    preview.play();

    // Some browsers call loadstart continuously
    preview.removeEventListener("loadstart", handleLoadStart);
  }, [onPlay]);

  const handleStream = useCallback(
    (stream: { getTracks: () => any[] }) => {
      const { preview } = els.current;
      // Preview element hasn't been rendered so wait for it.
      if (!preview) {
        window.setTimeout(handleStream, 1000, stream);
      }

      // Handle different browser implementations of MediaStreams as src
      if ((preview || {}).srcObject !== undefined) {
        preview.srcObject = stream;
      } else if (preview.mozSrcObject !== undefined) {
        preview.mozSrcObject = stream;
      } else if (window.URL.createObjectURL) {
        preview.src = window.URL.createObjectURL(stream);
      } else if (window.webkitURL) {
        preview.src = window.webkitURL.createObjectURL(stream);
      } else {
        preview.src = stream;
      }

      // IOS play in fullscreen
      preview.playsInline = true;

      const streamTrack = stream.getTracks()[0];
      // Assign `stopCamera` so the track can be stopped once component is cleared
      stopCamera.current = () => streamTrack.stop();
      preview.addEventListener("loadstart", handleLoadStart);
      setMirrorVideo(facingMode === "user");
    },
    [facingMode, handleLoadStart]
  );

  const initiate = useCallback(() => {
    worker.current = new QrWorker();

    if (stopTimeout.current) {
      clearTimeout(stopTimeout.current);
      stopTimeout.current = null;
    }

    stopped.current = false;

    // Check browser facingMode constraint support
    // Firefox ignores facingMode or deviceId constraints
    const isFirefox = /firefox/i.test(navigator.userAgent);
    let supported = {} as any;
    if (
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getSupportedConstraints === "function"
    ) {
      supported = navigator.mediaDevices.getSupportedConstraints();
    }
    const constraints = {} as any;

    if (supported.facingMode) {
      constraints.facingMode = { ideal: facingMode };
    }
    if (supported.frameRate) {
      constraints.frameRate = { ideal: 25, min: 10 };
    }

    const vConstraintsPromise =
      supported.facingMode || isFirefox
        ? Promise.resolve(constraints || constraints)
        : getDeviceId(facingMode).then((deviceId: any) =>
            Object.assign({}, { deviceId }, constraints)
          );

    vConstraintsPromise
      .then((video: any) => navigator.mediaDevices.getUserMedia({ video }))
      .then(handleStream)
      .catch(onError);
  }, [handleStream, onError, facingMode]);

  useEffect(() => {
    const stopFeed = () => {
      if (stopTimeout.current) {
        return;
      }

      stopTimeout.current = window.setTimeout(() => {
        if (stopCamera.current) stopCamera.current();
        stopTimeout.current = null;
      }, 300);
    };

    const clearComponent = () => {
      stopped.current = true;
      const { preview } = els.current;

      if (preview) {
        preview.removeEventListener("loadstart", onloadstart);
        preview.pause();
      }

      stopFeed();

      worker.current.postMessage({ type: "close" });
    };

    initiate();

    return () => {
      clearComponent();
    };
  }, [delay, initiate, onScan]);

  const setRefFactory = (key: string) => {
    return (element: any) => {
      els.current[key] = element;
    };
  };

  const containerStyle = {
    overflow: "hidden",
    position: "relative",
    width: "100%",
    paddingTop: "100%",
  } as React.CSSProperties;

  const hiddenStyle = { display: "none" } as React.CSSProperties;

  const previewStyle = {
    top: 0,
    left: 0,
    display: "block",
    position: "absolute",
    overflow: "hidden",
    width: "100%",
    height: "100%",
  } as React.CSSProperties;

  const videoPreviewStyle = {
    ...previewStyle,
    objectFit: "cover",
    transform: mirrorVideo ? "scaleX(-1)" : undefined,
  } as React.CSSProperties;

  const viewFinderStyle = {
    top: 0,
    left: 0,
    zIndex: 1,
    boxSizing: "border-box",
    border: "50px solid rgba(0, 0, 0, 0.3)",
    boxShadow: "inset 0 0 0 5px rgba(255, 0, 0, 0.5)",
    position: "absolute",
    width: "100%",
    height: "100%",
  } as React.CSSProperties;

  return (
    <section className={className} style={style}>
      <section style={containerStyle}>
        {showViewFinder && <div style={viewFinderStyle} />}
        <video style={videoPreviewStyle} ref={setRefFactory("preview")} />
        <canvas style={hiddenStyle} ref={setRefFactory("canvas")} />
      </section>
    </section>
  );
};

export default Reader;
