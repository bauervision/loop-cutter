"use client";

import * as React from "react";

/* ---------- Minimal types ---------- */
type WaveSurferType = (typeof import("wavesurfer.js"))["default"];
type WaveSurferInstance = InstanceType<WaveSurferType>;
interface RegionInstance {
  id: string;
  start: number;
  end: number;
  play: () => void;
  setOptions: (
    opts: Partial<{
      start: number;
      end: number;
      color: string;
      drag: boolean;
      resize: boolean;
      loop: boolean;
    }>,
  ) => void;
  remove?: () => void;
}
interface RegionsPluginInstance {
  addRegion: (opts: {
    start: number;
    end: number;
    color?: string;
    drag?: boolean;
    resize?: boolean;
    loop?: boolean;
  }) => RegionInstance;
  clearRegions: () => void;
  getRegions: () => RegionInstance[];
  enableDragSelection: (opts?: { slop?: number; color?: string }) => void;
  on: (event: string, cb: (...args: any[]) => void) => void;
}

type Subdiv = "bar" | "beat" | "eighth" | "sixteenth";

// Keeps the fade-handle hit target fully inside the overflow:hidden wave area
const HANDLE_EDGE_PAD = 10;

export default function Page() {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const overlayRef = React.useRef<HTMLCanvasElement | null>(null);

  const wsRef = React.useRef<WaveSurferInstance | null>(null);
  const regionsRef = React.useRef<RegionsPluginInstance | null>(null);
  const regionRef = React.useRef<RegionInstance | null>(null);

  const audioCtxRef = React.useRef<AudioContext | null>(null);
  const bufferRef = React.useRef<AudioBuffer | null>(null);
  const originalBlobRef = React.useRef<File | Blob | null>(null);

  // Transport
  const [loadedName, setLoadedName] = React.useState("");
  const [isPlaying, setIsPlaying] = React.useState(false);
  const [isLooping, setIsLooping] = React.useState(false);

  // Selection
  const [start, setStart] = React.useState(0);
  const [end, setEnd] = React.useState(2);

  // Cut / Undo history (stores the buffer + region prior to a destructive edit)
  const historyRef = React.useRef<
    { buffer: AudioBuffer; start: number; end: number }[]
  >([]);
  const [canUndo, setCanUndo] = React.useState(false);
  const [isEditing, setIsEditing] = React.useState(false);
  // When set, the next 'ready' event restores this region instead of the default
  const preserveRegionRef = React.useRef<{ start: number; end: number } | null>(
    null,
  );

  // Fade in/out (seconds, measured from the clip start and end)
  const [fadeInSec, setFadeInSec] = React.useState(0);
  const [fadeOutSec, setFadeOutSec] = React.useState(0);
  const fadeInSecRef = React.useRef(fadeInSec);
  const fadeOutSecRef = React.useRef(fadeOutSec);
  const fadeInHandleRef = React.useRef<HTMLDivElement | null>(null);
  const fadeOutHandleRef = React.useRef<HTMLDivElement | null>(null);

  // Grid + snap
  const [showGrid, setShowGrid] = React.useState(false); // default OFF
  const [bpm, setBpm] = React.useState<number>(120);
  const [subdiv, setSubdiv] = React.useState<Subdiv>("beat");
  const [snapEnabled, setSnapEnabled] = React.useState(true);

  // BPM detection
  const [detectedBpm, setDetectedBpm] = React.useState<number | null>(null);
  const [detectedPhase, setDetectedPhase] = React.useState<number | null>(null);
  const [isDetecting, setIsDetecting] = React.useState(false);

  // Zoom (px/sec)
  const [zoom, setZoom] = React.useState(80);
  const zoomRef = React.useRef(zoom);
  React.useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  // Export helpers
  const [zeroCross, setZeroCross] = React.useState(true);
  const [edgeFade, setEdgeFade] = React.useState(true);

  // Bottom panel tabs (BPM / FADE / FILTER / TRIM)
  const [activeTab, setActiveTab] = React.useState<
    "bpm" | "fade" | "filter" | "trim"
  >("bpm");

  // Clean FX (all OFF by default)
  const [fxHighpass, setFxHighpass] = React.useState(false);
  const [fxHum, setFxHum] = React.useState(false);
  const [fxHumFreq, setFxHumFreq] = React.useState<50 | 60>(60);
  const [fxLowpass, setFxLowpass] = React.useState(false);
  const [fxGate, setFxGate] = React.useState(false);
  const [fxLimiter, setFxLimiter] = React.useState(false);
  const [isRenderingFX, setIsRenderingFX] = React.useState(false);

  // Derived grid seconds
  const gridSec = React.useMemo(() => {
    const beat = 60 / Math.max(1, bpm);
    switch (subdiv) {
      case "bar":
        return beat * 4;
      case "beat":
        return beat;
      case "eighth":
        return beat / 2;
      case "sixteenth":
        return beat / 4;
    }
  }, [bpm, subdiv]);

  // Refs for handlers
  const gridSecRef = React.useRef(gridSec);
  const snapRef = React.useRef(snapEnabled);
  const loopModeRef = React.useRef(isLooping);
  const showGridRef = React.useRef(showGrid);
  React.useEffect(() => {
    gridSecRef.current = gridSec;
  }, [gridSec]);
  React.useEffect(() => {
    snapRef.current = snapEnabled;
  }, [snapEnabled]);
  React.useEffect(() => {
    loopModeRef.current = isLooping;
  }, [isLooping]);
  React.useEffect(() => {
    showGridRef.current = showGrid;
  }, [showGrid]);
  React.useEffect(() => {
    fadeInSecRef.current = fadeInSec;
    drawGrid();
  }, [fadeInSec]);
  React.useEffect(() => {
    fadeOutSecRef.current = fadeOutSec;
    drawGrid();
  }, [fadeOutSec]);

  /* -------- loop freeze helpers -------- */
  const frozenScrollRef = React.useRef<number | null>(null);
  const prevAutoCenterRef = React.useRef<boolean | null>(null);

  function isRegionFullyVisible(padPx = 2): boolean {
    const layout = computeLayout();
    const r = regionRef.current;
    if (!layout || !r) return false;

    const pxPerSec = layout.totalPx / layout.duration;
    const visStart = (layout.scrollLeft + padPx) / pxPerSec;
    const visEnd = (layout.scrollLeft + layout.w - padPx) / pxPerSec;
    return r.start >= visStart && r.end <= visEnd;
  }
  function setAutoCenter(enabled: boolean) {
    const ws = wsRef.current as any;
    if (!ws) return;
    if (prevAutoCenterRef.current === null) prevAutoCenterRef.current = true;
    ws.setOptions?.({ autoCenter: enabled });
  }
  function updateLoopFreeze() {
    const shouldFreeze = loopModeRef.current && isRegionFullyVisible();
    const layout = computeLayout();
    if (!layout) return;
    if (shouldFreeze) {
      frozenScrollRef.current = layout.scrollLeft;
      setAutoCenter(false);
    } else {
      frozenScrollRef.current = null;
      setAutoCenter(true);
    }
  }

  /* -------- gapless region loop -------- */
  const loopRAF = React.useRef<number | null>(null);
  const restartRegionLoop = React.useCallback(() => {
    const ws = wsRef.current,
      r = regionRef.current;
    if (!ws || !r) return;
    if (loopRAF.current !== null) {
      cancelAnimationFrame(loopRAF.current);
      loopRAF.current = null;
    }
    const s = r.start,
      e = r.end;
    ws.setTime(s);
    ws.play();

    updateLoopFreeze();

    const tick = () => {
      const t = ws.getCurrentTime();
      if (t >= e - 0.001) ws.setTime(s + 0.0001);
      loopRAF.current = requestAnimationFrame(tick);
    };
    loopRAF.current = requestAnimationFrame(tick);
    setIsPlaying(true);
  }, []);

  /* -------- WaveSurfer + Regions (v7) -------- */
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const WaveSurfer = (await import("wavesurfer.js")).default;
      const RegionsPlugin = (
        await import("wavesurfer.js/dist/plugins/regions.esm.js")
      ).default;
      if (cancelled || !containerRef.current) return;

      const ws = WaveSurfer.create({
        container: containerRef.current,
        waveColor: "#89b6ff",
        progressColor: "#4c8ff7",
        cursorColor: "#fff",
        height: 148,
        minPxPerSec: 80, // tie to zoom state
        autoCenter: true,
      });
      wsRef.current = ws;

      const regions = ws.registerPlugin(
        RegionsPlugin.create(),
      ) as RegionsPluginInstance;
      regionsRef.current = regions;
      regions.enableDragSelection({ slop: 2, color: "rgba(76,143,247,0.18)" });

      ws.on("ready", () => {
        ws.zoom(zoomRef.current);
        regions.clearRegions();
        const dur = ws.getDuration() || 2;
        const preserved = preserveRegionRef.current;
        preserveRegionRef.current = null;
        let rs = 0;
        let re = Math.min(2, dur);
        if (preserved) {
          rs = clamp(preserved.start, 0, dur);
          re = clamp(preserved.end, rs + 0.0005, dur);
        }
        const r = regions.addRegion({
          start: rs,
          end: re,
          color: "rgba(76,143,247,0.18)",
          drag: true,
          resize: true,
          loop: false,
        });
        regionRef.current = r;
        setStart(r.start);
        setEnd(r.end);
        drawGrid();
      });

      ws.on("timeupdate", () => {
        const renderer: any = (ws as any).renderer;
        if (!renderer) return;
        if (loopModeRef.current && frozenScrollRef.current !== null) {
          renderer.setScroll?.(frozenScrollRef.current!);
        }
      });

      ws.on("scroll", () => {
        drawGrid();
        updateLoopFreeze();
      });
      ws.on("redraw", drawGrid);
      const onResize = () => {
        drawGrid();
        updateLoopFreeze();
      };
      window.addEventListener("resize", onResize);

      regions.on("region-created", (r: RegionInstance) => {
        regions.getRegions().forEach((o) => {
          if (o.id !== r.id) o.remove?.();
        });
        if (snapRef.current && gridSecRef.current > 1e-6) {
          const qS = quantize(r.start, gridSecRef.current),
            qE = quantize(r.end, gridSecRef.current);
          if (qE > qS) r.setOptions({ start: qS, end: qE });
        }
        regionRef.current = r;
        setStart(r.start);
        setEnd(r.end);
        if (loopModeRef.current) updateLoopFreeze();
        if (loopModeRef.current) restartRegionLoop();
      });

      regions.on("region-updated", (r: RegionInstance) => {
        if (snapRef.current && gridSecRef.current > 1e-6) {
          const qS = quantize(r.start, gridSecRef.current),
            qE = quantize(r.end, gridSecRef.current);
          if (
            qE > qS &&
            (Math.abs(qS - r.start) > 1e-4 || Math.abs(qE - r.end) > 1e-4)
          )
            r.setOptions({ start: qS, end: qE });
        }
        regionRef.current = r;
        setStart(r.start);
        setEnd(r.end);
        if (loopModeRef.current) updateLoopFreeze();
        if (loopModeRef.current) restartRegionLoop();
      });

      ws.on("destroy", () => {
        wsRef.current = null;
        regionsRef.current = null;
        regionRef.current = null;
        window.removeEventListener("resize", onResize);
      });
    })();

    return () => {
      cancelled = true;
      if (loopRAF.current !== null) cancelAnimationFrame(loopRAF.current);
      wsRef.current?.destroy?.();
      window.removeEventListener("resize", () => {
        drawGrid();
        updateLoopFreeze();
      });
    };
  }, [restartRegionLoop]);

  // Apply zoom to WS when it changes
  React.useEffect(() => {
    wsRef.current?.zoom(zoom);
    // freeze baseline may change with zoom
    updateLoopFreeze();
    drawGrid();
  }, [zoom]);

  /* -------- File load -------- */
  const onFile = async (file: File) => {
    setLoadedName(file.name);
    originalBlobRef.current = file;
    historyRef.current = [];
    setCanUndo(false);
    setFadeInSec(0);
    setFadeOutSec(0);
    preserveRegionRef.current = null;
    if (!wsRef.current) return;

    try {
      await wsRef.current.loadBlob(file);
    } catch {
      await wsRef.current.load(URL.createObjectURL(file));
    }

    if (!audioCtxRef.current)
      audioCtxRef.current = new (
        window.AudioContext || (window as any).webkitAudioContext
      )();
    const buf = await file.arrayBuffer();
    bufferRef.current = await audioCtxRef.current.decodeAudioData(buf.slice(0));
  };

  /* -------- Transport -------- */
  const returnToStart = () => {
    const ws = wsRef.current;
    if (!ws) return;
    ws.pause();
    ws.setTime(0);
    setIsPlaying(false);
    setIsLooping(false);
    frozenScrollRef.current = null;
    setAutoCenter(true);
    if (loopRAF.current !== null) {
      cancelAnimationFrame(loopRAF.current);
      loopRAF.current = null;
    }
  };

  const togglePlayPause = () => {
    const ws = wsRef.current;
    if (!ws) return;
    if (isLooping) {
      if (loopRAF.current !== null) {
        cancelAnimationFrame(loopRAF.current);
        loopRAF.current = null;
      }
      setIsLooping(false);
      frozenScrollRef.current = null;
      setAutoCenter(true);
    }
    if (isPlaying) {
      ws.pause();
      setIsPlaying(false);
    } else {
      ws.play();
      setIsPlaying(true);
    }
  };

  const toggleLoop = () => {
    if (isLooping) {
      if (loopRAF.current !== null) {
        cancelAnimationFrame(loopRAF.current);
        loopRAF.current = null;
      }
      wsRef.current?.pause();
      setIsPlaying(false);
      setIsLooping(false);
      frozenScrollRef.current = null;
      setAutoCenter(true);
    } else {
      setIsLooping(true);
      restartRegionLoop();
      requestAnimationFrame(() => updateLoopFreeze());
    }
  };

  const centerOnPlayhead = () => {
    const ws = wsRef.current as any;
    if (!ws) return;
    const layout = computeLayout();
    if (!layout) return;
    const t = ws.getCurrentTime() as number;
    const target = layout.secToPx(t) - layout.w / 2;
    const clamped = Math.max(0, Math.min(target, layout.totalPx - layout.w));
    (ws.renderer as any)?.setScroll?.(clamped);
    drawGrid();
  };

  const goToLoopStart = () => {
    const ws = wsRef.current,
      r = regionRef.current;
    if (!ws || !r) return;
    ws.pause();
    ws.setTime(r.start);
    setIsPlaying(false);
  };

  /* -------- Nudge -------- */
  const nudgeStart = (ms: number) => {
    const r = regionRef.current,
      ws = wsRef.current;
    if (!r || !ws) return;
    r.setOptions({
      start: clamp(r.start + ms / 1000, 0, Math.max(0, r.end - 0.001)),
    });
  };
  const nudgeEnd = (ms: number) => {
    const r = regionRef.current,
      ws = wsRef.current;
    if (!r || !ws) return;
    const dur = ws.getDuration();
    r.setOptions({
      end: clamp(r.end + ms / 1000, Math.min(r.start + 0.001, dur), dur),
    });
  };

  /* -------- Cut / Undo -------- */
  const loadBufferIntoWaveSurfer = async (buf: AudioBuffer) => {
    const ws = wsRef.current;
    if (!ws) return;
    const wav = encodeWAV(buf);
    const blob = new Blob([wav], { type: "audio/wav" });
    originalBlobRef.current = blob;
    await ws.loadBlob(blob);
  };

  const cutSelection = async () => {
    const r = regionRef.current,
      buf = bufferRef.current,
      ws = wsRef.current;
    if (!r || !buf || !ws || isEditing) return;
    const sr = buf.sampleRate;
    const sStart = Math.max(0, Math.min(buf.length, Math.round(r.start * sr)));
    const sEnd = Math.max(sStart, Math.min(buf.length, Math.round(r.end * sr)));
    if (sEnd - sStart < 1) return;

    setIsEditing(true);
    try {
      historyRef.current.push({ buffer: buf, start: r.start, end: r.end });
      setCanUndo(true);

      const newLength = Math.max(1, buf.length - (sEnd - sStart));
      const newBuf = new AudioBuffer({
        length: newLength,
        numberOfChannels: buf.numberOfChannels,
        sampleRate: sr,
      });
      for (let ch = 0; ch < buf.numberOfChannels; ch++) {
        const src = buf.getChannelData(ch),
          dst = newBuf.getChannelData(ch);
        dst.set(src.subarray(0, sStart), 0);
        dst.set(src.subarray(sEnd), sStart);
      }
      bufferRef.current = newBuf;

      const newDur = newBuf.duration;
      let rs = Math.min(r.start, newDur);
      let re = Math.min(newDur, rs + 0.05);
      if (re <= rs) {
        rs = Math.max(0, newDur - 0.05);
        re = newDur;
      }
      preserveRegionRef.current = { start: rs, end: re };

      await loadBufferIntoWaveSurfer(newBuf);
    } finally {
      setIsEditing(false);
    }
  };

  const undoLastEdit = async () => {
    const ws = wsRef.current;
    if (!ws || isEditing) return;
    const entry = historyRef.current.pop();
    if (!entry) return;

    setIsEditing(true);
    try {
      bufferRef.current = entry.buffer;
      preserveRegionRef.current = { start: entry.start, end: entry.end };
      await loadBufferIntoWaveSurfer(entry.buffer);
    } finally {
      setIsEditing(false);
      setCanUndo(historyRef.current.length > 0);
    }
  };

  /* -------- Fade in/out -------- */
  const nudgeFadeIn = (ms: number) => {
    const dur =
      wsRef.current?.getDuration() ?? bufferRef.current?.duration ?? 0;
    setFadeInSec((prev) =>
      clamp(prev + ms / 1000, 0, Math.max(0, dur - fadeOutSecRef.current)),
    );
  };
  const nudgeFadeOut = (ms: number) => {
    const dur =
      wsRef.current?.getDuration() ?? bufferRef.current?.duration ?? 0;
    setFadeOutSec((prev) =>
      clamp(prev + ms / 1000, 0, Math.max(0, dur - fadeInSecRef.current)),
    );
  };
  const clearFades = () => {
    setFadeInSec(0);
    setFadeOutSec(0);
  };

  const startFadeDrag =
    (which: "in" | "out") => (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const pointerId = e.pointerId;

      // Listen on window (not the handle element) and self-heal if the
      // button is released without us seeing pointerup, so a drag can never
      // get "stuck" and keep reacting to mouse moves elsewhere on the page.
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        if (ev.buttons === 0) {
          stop();
          return;
        }
        const layout = computeLayout();
        if (!layout) return;
        const rect = layout.wrapper.getBoundingClientRect();
        const x = ev.clientX - rect.left;
        const t = clamp(layout.pxToSec(x), 0, layout.duration);
        if (which === "in") {
          const maxIn = Math.max(0, layout.duration - fadeOutSecRef.current);
          setFadeInSec(clamp(t, 0, maxIn));
        } else {
          const maxOut = Math.max(0, layout.duration - fadeInSecRef.current);
          setFadeOutSec(clamp(layout.duration - t, 0, maxOut));
        }
      };
      const stop = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
        window.removeEventListener("blur", stop);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
      window.addEventListener("blur", stop);
    };

  /* -------- Export (with Clean FX) -------- */
  const exportRange = async (
    startSec: number,
    endSec: number,
    useZeroCross: boolean,
    label: string,
  ) => {
    const buf = bufferRef.current;
    if (!buf) return;
    const faded =
      fadeInSec > 0 || fadeOutSec > 0
        ? applyFades(buf, fadeInSec, fadeOutSec)
        : buf;
    const sliced = sliceBuffer(faded, startSec, endSec, {
      zeroCross: useZeroCross,
      edgeFadeMs: edgeFade ? 8 : 0,
    });
    const cleaned = await renderWithFX(sliced, {
      hp: fxHighpass,
      hum: fxHum,
      humHz: fxHumFreq,
      lp: fxLowpass,
      gate: fxGate,
      limiter: fxLimiter,
    });
    const wav = encodeWAV(cleaned);
    const blob = new Blob([wav], { type: "audio/wav" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const base = (loadedName || "loop").replace(/\.[^.]+$/, "");
    a.download = `${base}_${label}_clean.wav`;
    a.click();
  };

  const exportSelection = async () => {
    const r = regionRef.current;
    if (!r || !bufferRef.current) return;
    await exportRange(
      r.start,
      r.end,
      zeroCross,
      `${fmt(r.start)}-${fmt(r.end)}`,
    );
  };

  const exportAll = async () => {
    const buf = bufferRef.current;
    if (!buf) return;
    await exportRange(0, buf.duration, false, "full");
  };

  /* -------- Auto-preview filters during playback/loop -------- */
  React.useEffect(() => {
    if (!bufferRef.current || !wsRef.current) return;

    let cancelled = false;
    const ws = wsRef.current;
    const wasPlaying = isPlaying;
    const wasLooping = isLooping;
    const tNow = ws.getCurrentTime();
    const r = regionRef.current;

    const anyFxOn = fxHighpass || fxHum || fxLowpass || fxGate || fxLimiter;
    const anyFadeOn = fadeInSec > 0 || fadeOutSec > 0;
    const allOff = !anyFxOn && !anyFadeOn;

    const id = setTimeout(async () => {
      if (cancelled || !bufferRef.current || !wsRef.current) return;

      setIsRenderingFX(true);
      try {
        if (r) preserveRegionRef.current = { start: r.start, end: r.end };
        if (allOff) {
          if (originalBlobRef.current)
            await ws.loadBlob(originalBlobRef.current);
        } else {
          let working = bufferRef.current!;
          if (anyFadeOn) working = applyFades(working, fadeInSec, fadeOutSec);
          const processed = anyFxOn
            ? await renderWithFX(working, {
                hp: fxHighpass,
                hum: fxHum,
                humHz: fxHumFreq,
                lp: fxLowpass,
                gate: fxGate,
                limiter: fxLimiter,
              })
            : working;
          const wav = encodeWAV(processed);
          const blob = new Blob([wav], { type: "audio/wav" });
          await ws.loadBlob(blob);
        }

        const resumeTime =
          wasLooping && r
            ? Math.min(
                Math.max(r.start, tNow),
                Math.max(r.start, r.end - 0.001),
              )
            : tNow;
        ws.setTime(resumeTime);
        if (wasLooping && r) setTimeout(() => restartRegionLoop(), 0);
        else if (wasPlaying) ws.play();
      } finally {
        setIsRenderingFX(false);
      }
    }, 150);

    return () => {
      cancelled = true;
      clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    fxHighpass,
    fxHum,
    fxHumFreq,
    fxLowpass,
    fxGate,
    fxLimiter,
    fadeInSec,
    fadeOutSec,
  ]);

  /* -------- Grid + fade overlay -------- */
  function computeLayout() {
    const ws = wsRef.current,
      canvas = overlayRef.current;
    if (!ws || !canvas) return null;
    const renderer: any = (ws as any).renderer;
    // `wrapper` is WaveSurfer's full (unclipped) content element — its own
    // clientWidth is the TOTAL zoomed width, not the visible viewport width.
    const wrapper: HTMLElement | undefined =
      renderer?.getWrapper?.() || (ws as any).getWrapper?.();
    const duration = ws.getDuration() || 0;
    if (!wrapper || !duration) return null;
    // Visible viewport width/scroll come from the renderer's scroll APIs,
    // not from `wrapper` (which has no scrollbox of its own).
    const w: number =
      (renderer?.getWidth && renderer.getWidth()) || wrapper.clientWidth;
    const h = wrapper.clientHeight;
    const totalPx: number = wrapper.scrollWidth || wrapper.clientWidth || w;
    const secToPx = (t: number) => (t * totalPx) / duration;
    const pxToSec = (x: number) => (x * duration) / totalPx;
    const scrollLeft: number =
      (renderer?.getScroll && renderer.getScroll()) || 0;
    return {
      ws,
      wrapper,
      duration,
      w,
      h,
      totalPx,
      secToPx,
      pxToSec,
      scrollLeft,
    };
  }

  const drawGrid = React.useCallback(() => {
    const layout = computeLayout();
    const canvas = overlayRef.current;
    if (!layout || !canvas) return;
    const { duration, w, h, secToPx, pxToSec, scrollLeft } = layout;

    canvas.width = Math.max(1, Math.floor(w * devicePixelRatio));
    canvas.height = Math.max(1, Math.floor(h * devicePixelRatio));
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Fade-in / fade-out shading — always visible, independent of the grid
    const fadeIn = fadeInSecRef.current;
    const fadeOut = fadeOutSecRef.current;
    if (fadeIn > 1e-4) {
      const x0 = -scrollLeft;
      const x1 = secToPx(fadeIn) - scrollLeft;
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.beginPath();
      ctx.moveTo(x0, 0);
      ctx.lineTo(x1, 0);
      ctx.lineTo(x0, h);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "#ffd166";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x0, h);
      ctx.lineTo(x1, 0);
      ctx.stroke();
    }
    if (fadeOut > 1e-4) {
      const xEnd = secToPx(duration) - scrollLeft;
      const xStart = secToPx(duration - fadeOut) - scrollLeft;
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.beginPath();
      ctx.moveTo(xEnd, 0);
      ctx.lineTo(xStart, 0);
      ctx.lineTo(xEnd, h);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "#ffd166";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(xStart, 0);
      ctx.lineTo(xEnd, h);
      ctx.stroke();
    }

    if (fadeInHandleRef.current) {
      const fiX = secToPx(fadeIn) - scrollLeft;
      const visible = fiX >= -HANDLE_EDGE_PAD && fiX <= w + HANDLE_EDGE_PAD;
      fadeInHandleRef.current.style.display = visible ? "block" : "none";
      if (visible) {
        fadeInHandleRef.current.style.left = `${clamp(
          fiX,
          HANDLE_EDGE_PAD,
          w - HANDLE_EDGE_PAD,
        )}px`;
      }
    }
    if (fadeOutHandleRef.current) {
      const foX = secToPx(duration - fadeOut) - scrollLeft;
      const visible = foX >= -HANDLE_EDGE_PAD && foX <= w + HANDLE_EDGE_PAD;
      fadeOutHandleRef.current.style.display = visible ? "block" : "none";
      if (visible) {
        fadeOutHandleRef.current.style.left = `${clamp(
          foX,
          HANDLE_EDGE_PAD,
          w - HANDLE_EDGE_PAD,
        )}px`;
      }
    }

    if (!showGridRef.current) return;

    const r = regionRef.current;
    if (!r) return;

    const visStart = pxToSec(scrollLeft);
    const visEnd = pxToSec(scrollLeft + w);
    const tStart = Math.max(visStart, r.start);
    const tEnd = Math.min(visEnd, r.end);
    if (tEnd - tStart <= 1e-4) return;

    const beat = 60 / Math.max(1, bpm);
    const baseStep =
      subdiv === "bar"
        ? beat * 4
        : subdiv === "beat"
          ? beat
          : subdiv === "eighth"
            ? beat / 2
            : beat / 4;

    const pxPerSec = layout.totalPx / duration;
    const targetPx = 40;
    let step = baseStep;
    while (pxPerSec * step < targetPx * 0.7) step *= 2;
    while (pxPerSec * step > targetPx * 2 && step > baseStep / 8) step /= 2;

    const anchor = r.start;
    const firstTick = anchor + Math.ceil((tStart - anchor) / step) * step;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();

    const barPeriod = beat * 4;
    for (let t = firstTick; t <= tEnd + 1e-6; t += step) {
      const x = Math.round(secToPx(t) - scrollLeft) + 0.5;
      const isBar =
        Math.abs(
          (t - anchor) / barPeriod - Math.round((t - anchor) / barPeriod),
        ) < 1e-6;

      ctx.strokeStyle = isBar
        ? "rgba(255,255,255,0.30)"
        : "rgba(255,255,255,0.16)";
      ctx.lineWidth = isBar ? 1.25 : 1;

      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    ctx.restore();
  }, [bpm, subdiv]);

  React.useEffect(() => {
    drawGrid();
  }, [showGrid, drawGrid]);
  React.useEffect(() => {
    drawGrid();
  }, [drawGrid, bpm, subdiv]);

  /* -------- Keyboard shortcuts -------- */
  React.useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        (e.target as HTMLElement)?.isContentEditable
      )
        return;
      if (e.code === "Space") {
        e.preventDefault();
        togglePlayPause();
      } else if (e.key.toLowerCase() === "l") {
        e.preventDefault();
        toggleLoop();
      } else if (e.key.toLowerCase() === "r") {
        e.preventDefault();
        returnToStart();
      } else if (e.key === "[") {
        e.preventDefault();
        nudgeStart(-1);
      } else if (e.key === "]") {
        e.preventDefault();
        nudgeStart(+1);
      } else if (e.key === "{") {
        e.preventDefault();
        nudgeEnd(-1);
      } else if (e.key === "}") {
        e.preventDefault();
        nudgeEnd(+1);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        cutSelection();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undoLastEdit();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [togglePlayPause, toggleLoop, returnToStart, cutSelection, undoLastEdit]);

  /* -------- Mouse wheel zoom (cursor-anchored) -------- */
  const onWheelZoom = (e: React.WheelEvent) => {
    e.preventDefault(); // stop page scroll while hovering
    const ws = wsRef.current as any;
    if (!ws) return;
    const before = computeLayout();
    if (!before) return;

    const rect = before.wrapper.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const tUnderCursor = before.pxToSec(x);

    const factor = Math.pow(1.0015, -e.deltaY); // up→in, down→out
    const next = clamp(zoomRef.current * factor, 10, 2000);
    setZoom(next);

    requestAnimationFrame(() => {
      const after = computeLayout();
      if (!after) return;
      const newScrollLeft = after.secToPx(tUnderCursor) - x;
      const clamped = clamp(
        newScrollLeft,
        0,
        Math.max(0, after.totalPx - after.w),
      );
      (ws.renderer as any)?.setScroll?.(clamped);
      updateLoopFreeze();
      drawGrid();
    });
  };

  /* ---------- UI ---------- */
  const resetFilters = () => {
    setFxHighpass(false);
    setFxHum(false);
    setFxLowpass(false);
    setFxGate(false);
    setFxLimiter(false);
  };

  return (
    <main style={styles.page}>
      <div style={styles.card}>
        <header style={styles.header}>
          <div>
            <h1 style={styles.title}>Loop Cutter</h1>
            <p style={styles.subtitle}>
              Draw a region by dragging. Play to audition, Play Loop for a
              gapless loop. Press Delete to cut the selection (Ctrl+Z to undo).
              Drag the amber handles on the waveform edges to shape fade in/out.
              Export clean, click-free WAVs.
              {isRenderingFX && (
                <em style={{ marginLeft: 8, opacity: 0.7, fontSize: 12 }}>
                  (rendering preview…)
                </em>
              )}
            </p>
          </div>
          <div>
            <label style={styles.fileLabel}>
              <input
                type="file"
                accept="audio/*"
                onChange={(e) =>
                  e.target.files?.[0] && onFile(e.target.files[0])
                }
              />
              Load audio
            </label>
            <div style={styles.fileName}>{loadedName || "No file loaded"}</div>
          </div>
        </header>

        {/* Waveform + overlay grid */}
        <div
          style={{ position: "relative", overflow: "hidden" }}
          onWheel={onWheelZoom}
        >
          <div ref={containerRef} style={styles.wave} />
          <canvas
            ref={overlayRef}
            style={{
              position: "absolute",
              inset: 0,
              pointerEvents: "none",
              display: "block",
            }}
          />
          <div ref={fadeInHandleRef} style={styles.fadeHandle}>
            <div
              style={styles.fadeHandleGripZone}
              onPointerDown={startFadeDrag("in")}
              title="Drag to set fade-in length"
            >
              <div style={styles.fadeHandleGrip} />
            </div>
          </div>
          <div ref={fadeOutHandleRef} style={styles.fadeHandle}>
            <div
              style={styles.fadeHandleGripZone}
              onPointerDown={startFadeDrag("out")}
              title="Drag to set fade-out length"
            >
              <div style={styles.fadeHandleGrip} />
            </div>
          </div>
        </div>

        <section style={styles.controls}>
          {/* Transport — always visible */}
          <div style={styles.row}>
            <div style={styles.group}>
              <button
                style={styles.ghost}
                onClick={returnToStart}
                disabled={!wsRef.current}
              >
                ⏮ Return
              </button>

              <button
                style={styles.primary}
                onClick={togglePlayPause}
                disabled={!wsRef.current}
              >
                {isPlaying && !isLooping ? "⏸ Pause" : "▶ Play"}
              </button>

              <button
                style={styles.blue}
                onClick={toggleLoop}
                disabled={!regionRef.current}
              >
                {isLooping ? "⏸ Pause Loop" : "🔁 Play Loop"}
              </button>

              <button
                style={styles.ghost}
                onClick={centerOnPlayhead}
                disabled={!wsRef.current}
              >
                ⌖ Center on Playhead
              </button>
              <button
                style={styles.ghost}
                onClick={goToLoopStart}
                disabled={!regionRef.current}
              >
                ↦ To Loop Start
              </button>
            </div>
          </div>

          <div style={{ ...styles.row, marginTop: 8 }}>
            <div style={styles.group}>
              <button
                style={styles.green}
                onClick={exportSelection}
                disabled={!regionRef.current || !bufferRef.current}
              >
                Export Selection
              </button>

              <button
                style={styles.green}
                onClick={exportAll}
                disabled={!bufferRef.current}
              >
                Export All
              </button>

              <button
                style={styles.ghost}
                onClick={cutSelection}
                disabled={!regionRef.current || !bufferRef.current || isEditing}
              >
                ✂ Cut Selection (Del)
              </button>

              <button
                style={styles.ghost}
                onClick={undoLastEdit}
                disabled={!canUndo || isEditing}
              >
                ↩ Undo (Ctrl+Z)
              </button>
            </div>

            <div style={styles.meta}>
              Selection: <strong>{fmt(start)}</strong> –{" "}
              <strong>{fmt(end)}</strong> ({fmt(end - start)})
            </div>
          </div>

          {/* Tabbed panel — everything else lives here to keep the UI minimal */}
          <div style={styles.tabBar}>
            <button
              style={activeTab === "bpm" ? styles.tabActive : styles.tab}
              onClick={() => setActiveTab("bpm")}
            >
              BPM
            </button>
            <button
              style={activeTab === "fade" ? styles.tabActive : styles.tab}
              onClick={() => setActiveTab("fade")}
            >
              FADE
            </button>
            <button
              style={activeTab === "filter" ? styles.tabActive : styles.tab}
              onClick={() => setActiveTab("filter")}
            >
              FILTER
            </button>
            <button
              style={activeTab === "trim" ? styles.tabActive : styles.tab}
              onClick={() => setActiveTab("trim")}
            >
              TRIM
            </button>
          </div>

          {activeTab === "bpm" && (
            <div style={styles.tabPanel}>
              {/* BPM detect + controls */}
              <div style={styles.row}>
                <div className="detect" style={styles.inline}>
                  <button
                    style={styles.ghost}
                    onClick={async () => {
                      if (!bufferRef.current) return;
                      setIsDetecting(true);
                      try {
                        const res = await detectBPM(bufferRef.current, {
                          minBPM: 60,
                          maxBPM: 220,
                        });
                        setDetectedBpm(res.bpm);
                        setDetectedPhase(res.phaseSec);
                      } finally {
                        setIsDetecting(false);
                      }
                    }}
                    disabled={!bufferRef.current || isDetecting}
                  >
                    {isDetecting ? "Detecting…" : "Detect BPM"}
                  </button>
                  <button
                    style={styles.ghost}
                    onClick={() => {
                      if (detectedBpm) setBpm(Math.round(detectedBpm));
                    }}
                    disabled={!detectedBpm}
                    title={
                      detectedPhase != null
                        ? `Phase ~${detectedPhase.toFixed(2)}s`
                        : undefined
                    }
                  >
                    Use detected BPM
                    {detectedBpm ? ` (${Math.round(detectedBpm)})` : ""}
                  </button>
                </div>

                <div style={styles.inline}>
                  <label style={styles.label}>BPM</label>
                  <input
                    type="number"
                    min={40}
                    max={300}
                    step={1}
                    value={bpm}
                    onChange={(e) =>
                      setBpm(
                        clampNum(parseInt(e.target.value || "0", 10), 40, 300),
                      )
                    }
                    style={styles.input}
                  />
                </div>
                <div style={styles.inline}>
                  <label style={styles.label}>Snap</label>
                  <select
                    value={subdiv}
                    onChange={(e) => setSubdiv(e.target.value as Subdiv)}
                    style={styles.select}
                  >
                    <option value="bar">Bar</option>
                    <option value="beat">Beat</option>
                    <option value="eighth">1/8</option>
                    <option value="sixteenth">1/16</option>
                  </select>
                  <label style={styles.checkbox}>
                    <input
                      type="checkbox"
                      checked={snapEnabled}
                      onChange={(e) => setSnapEnabled(e.target.checked)}
                    />
                    <span>Enabled</span>
                  </label>
                  <label style={{ ...styles.checkbox, marginLeft: 12 }}>
                    <input
                      type="checkbox"
                      checked={showGrid}
                      onChange={(e) => setShowGrid(e.target.checked)}
                    />
                    <span>Show grid</span>
                  </label>
                </div>
              </div>
            </div>
          )}

          {activeTab === "fade" && (
            <div style={styles.tabPanel}>
              {/* Fade in/out */}
              <div style={styles.row}>
                <div style={styles.nudgeCol}>
                  <div style={styles.nudgeLabel}>Fade In</div>
                  <div style={styles.nudges}>
                    <button
                      style={styles.chip}
                      onClick={() => nudgeFadeIn(-100)}
                    >
                      −100 ms
                    </button>
                    <button
                      style={styles.chip}
                      onClick={() => nudgeFadeIn(-10)}
                    >
                      −10 ms
                    </button>
                    <button
                      style={styles.chip}
                      onClick={() => nudgeFadeIn(+10)}
                    >
                      +10 ms
                    </button>
                    <button
                      style={styles.chip}
                      onClick={() => nudgeFadeIn(+100)}
                    >
                      +100 ms
                    </button>
                  </div>
                </div>
                <div style={styles.nudgeCol}>
                  <div style={styles.nudgeLabel}>Fade Out</div>
                  <div style={styles.nudges}>
                    <button
                      style={styles.chip}
                      onClick={() => nudgeFadeOut(-100)}
                    >
                      −100 ms
                    </button>
                    <button
                      style={styles.chip}
                      onClick={() => nudgeFadeOut(-10)}
                    >
                      −10 ms
                    </button>
                    <button
                      style={styles.chip}
                      onClick={() => nudgeFadeOut(+10)}
                    >
                      +10 ms
                    </button>
                    <button
                      style={styles.chip}
                      onClick={() => nudgeFadeOut(+100)}
                    >
                      +100 ms
                    </button>
                  </div>
                </div>
                <button
                  style={styles.ghost}
                  onClick={clearFades}
                  disabled={fadeInSec === 0 && fadeOutSec === 0}
                >
                  Clear fades
                </button>
                <div style={styles.meta}>
                  Fade in <strong>{fmt(fadeInSec)}</strong> · Fade out{" "}
                  <strong>{fmt(fadeOutSec)}</strong>
                </div>
              </div>
            </div>
          )}

          {activeTab === "filter" && (
            <div style={styles.tabPanel}>
              {/* FX row */}
              <div style={{ ...styles.row, ...styles.inline, gap: 10 }}>
                <label style={styles.checkbox}>
                  <input
                    type="checkbox"
                    checked={fxHighpass}
                    onChange={(e) => setFxHighpass(e.target.checked)}
                  />{" "}
                  <span>HPF 40 Hz</span>
                </label>
                <div style={styles.inline}>
                  <label style={styles.checkbox}>
                    <input
                      type="checkbox"
                      checked={fxHum}
                      onChange={(e) => setFxHum(e.target.checked)}
                    />
                    <span>Hum notch</span>
                  </label>
                  <select
                    disabled={!fxHum}
                    value={fxHumFreq}
                    onChange={(e) =>
                      setFxHumFreq(Number(e.target.value) as 50 | 60)
                    }
                    style={styles.select}
                  >
                    <option value={60}>60 Hz</option>
                    <option value={50}>50 Hz</option>
                  </select>
                </div>
                <label style={styles.checkbox}>
                  <input
                    type="checkbox"
                    checked={fxLowpass}
                    onChange={(e) => setFxLowpass(e.target.checked)}
                  />{" "}
                  <span>LPF 16 kHz</span>
                </label>
                <label style={styles.checkbox}>
                  <input
                    type="checkbox"
                    checked={fxGate}
                    onChange={(e) => setFxGate(e.target.checked)}
                  />{" "}
                  <span>Light Gate</span>
                </label>
                <label style={styles.checkbox}>
                  <input
                    type="checkbox"
                    checked={fxLimiter}
                    onChange={(e) => setFxLimiter(e.target.checked)}
                  />{" "}
                  <span>Limiter</span>
                </label>
                <button style={styles.ghost} onClick={resetFilters}>
                  Reset filters
                </button>
              </div>
            </div>
          )}

          {activeTab === "trim" && (
            <div style={styles.tabPanel}>
              {/* Nudges */}
              <div style={styles.row}>
                <div style={styles.nudgeCol}>
                  <div style={styles.nudgeLabel}>Start</div>
                  <div style={styles.nudges}>
                    <button style={styles.chip} onClick={() => nudgeStart(-10)}>
                      −10 ms
                    </button>
                    <button style={styles.chip} onClick={() => nudgeStart(-1)}>
                      −1 ms
                    </button>
                    <button style={styles.chip} onClick={() => nudgeStart(+1)}>
                      +1 ms
                    </button>
                    <button style={styles.chip} onClick={() => nudgeStart(+10)}>
                      +10 ms
                    </button>
                  </div>
                </div>
                <div style={styles.nudgeCol}>
                  <div style={styles.nudgeLabel}>End</div>
                  <div style={styles.nudges}>
                    <button style={styles.chip} onClick={() => nudgeEnd(-10)}>
                      −10 ms
                    </button>
                    <button style={styles.chip} onClick={() => nudgeEnd(-1)}>
                      −1 ms
                    </button>
                    <button style={styles.chip} onClick={() => nudgeEnd(+1)}>
                      +1 ms
                    </button>
                    <button style={styles.chip} onClick={() => nudgeEnd(+10)}>
                      +10 ms
                    </button>
                  </div>
                </div>
              </div>

              {/* Export helpers */}
              <div style={{ ...styles.row, marginTop: 10 }}>
                <label style={styles.checkbox}>
                  <input
                    type="checkbox"
                    checked={zeroCross}
                    onChange={(e) => setZeroCross(e.target.checked)}
                  />{" "}
                  <span>Snap to zero-cross (export selection)</span>
                </label>
                <label style={styles.checkbox}>
                  <input
                    type="checkbox"
                    checked={edgeFade}
                    onChange={(e) => setEdgeFade(e.target.checked)}
                  />{" "}
                  <span>Edge fades (export)</span>
                </label>
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

/* ---------- Styles ---------- */
const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background:
      "radial-gradient(1200px 600px at 20% -10%, #1b3162 0%, #0b1220 60%)",
    color: "#fff",
    display: "grid",
    placeItems: "center",
    padding: 24,
  },
  card: {
    width: 1024,
    maxWidth: "100%",
    borderRadius: 18,
    background: "rgba(255,255,255,0.05)",
    border: "1px solid rgba(255,255,255,0.12)",
    boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
    padding: 18,
  },
  header: {
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: 16,
    marginBottom: 12,
  },
  title: { margin: 0, fontSize: 22, fontWeight: 700 },
  subtitle: { margin: "6px 0 0", opacity: 0.75, fontSize: 13 },
  fileLabel: {
    display: "inline-block",
    padding: "8px 12px",
    borderRadius: 10,
    background: "#fff",
    color: "#000",
    cursor: "pointer",
    fontWeight: 700,
    userSelect: "none",
  },
  fileName: {
    marginTop: 8,
    fontSize: 12,
    opacity: 0.8,
    textAlign: "right",
    maxWidth: 420,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  wave: {
    marginTop: 8,
    borderRadius: 12,
    overflow: "hidden",
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.12)",
  },
  controls: { marginTop: 12 },
  row: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" },
  group: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  inline: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  label: { fontSize: 12, opacity: 0.8 },
  input: {
    width: 84,
    padding: "6px 8px",
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.25)",
    background: "rgba(255,255,255,0.06)",
    color: "#fff",
  },
  select: {
    padding: "6px 8px",
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.25)",
    background: "rgba(255,255,255,0.06)",
    color: "#fff",
  },
  checkbox: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 12,
    opacity: 0.85,
  },
  primary: {
    padding: "8px 12px",
    borderRadius: 10,
    background: "#fff",
    color: "#000",
    fontWeight: 700,
    border: "none",
    cursor: "pointer",
  },
  ghost: {
    padding: "8px 12px",
    borderRadius: 10,
    background: "transparent",
    color: "#fff",
    fontWeight: 700,
    border: "1px solid rgba(255,255,255,0.35)",
    cursor: "pointer",
  },
  blue: {
    padding: "8px 12px",
    borderRadius: 10,
    background: "#4c8ff7",
    color: "#fff",
    fontWeight: 700,
    border: "none",
    cursor: "pointer",
  },
  green: {
    padding: "8px 12px",
    borderRadius: 10,
    background: "#22c55e",
    color: "#0b1220",
    fontWeight: 700,
    border: "none",
    cursor: "pointer",
  },
  nudgeCol: { display: "grid", gap: 6 },
  nudgeLabel: { fontSize: 12, opacity: 0.75 },
  nudges: { display: "flex", gap: 6, flexWrap: "wrap" },
  chip: {
    padding: "6px 10px",
    borderRadius: 999,
    background: "rgba(255,255,255,0.1)",
    border: "1px solid rgba(255,255,255,0.2)",
    color: "#fff",
    fontWeight: 600,
    cursor: "pointer",
  },
  meta: { marginLeft: "auto", fontSize: 12, opacity: 0.85 },
  tabBar: {
    display: "flex",
    gap: 4,
    marginTop: 14,
    borderBottom: "1px solid rgba(255,255,255,0.12)",
    paddingBottom: 0,
  },
  tab: {
    padding: "8px 16px",
    borderRadius: "8px 8px 0 0",
    background: "transparent",
    color: "rgba(255,255,255,0.6)",
    fontWeight: 700,
    fontSize: 12,
    letterSpacing: 0.5,
    border: "none",
    borderBottom: "2px solid transparent",
    cursor: "pointer",
  },
  tabActive: {
    padding: "8px 16px",
    borderRadius: "8px 8px 0 0",
    background: "rgba(255,255,255,0.08)",
    color: "#fff",
    fontWeight: 700,
    fontSize: 12,
    letterSpacing: 0.5,
    border: "none",
    borderBottom: "2px solid #4c8ff7",
    cursor: "pointer",
  },
  tabPanel: {
    background: "rgba(255,255,255,0.03)",
    border: "1px solid rgba(255,255,255,0.1)",
    borderTop: "none",
    borderRadius: "0 0 12px 12px",
    padding: 14,
  },
  fadeHandle: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 0,
    borderLeft: "2px dashed #ffd166",
    // Purely a visual guide line — the small grip zone below is what's draggable,
    // so clicks anywhere else on the waveform still reach the region/selection.
    pointerEvents: "none",
    zIndex: 15,
  },
  fadeHandleGripZone: {
    position: "absolute",
    top: -2,
    left: -10,
    width: 20,
    height: 22,
    cursor: "ew-resize",
    pointerEvents: "auto",
    zIndex: 20,
    touchAction: "none",
  },
  fadeHandleGrip: {
    position: "absolute",
    top: 0,
    left: 2,
    width: 16,
    height: 16,
    borderRadius: "50%",
    background: "#ffd166",
    border: "2px solid #0b1220",
    pointerEvents: "none",
  },
};

/* ---------- Utils ---------- */
function clamp(x: number, a: number, b: number) {
  return Math.max(a, Math.min(b, x));
}
function clampNum(n: number, a: number, b: number) {
  return Number.isFinite(n) ? clamp(n, a, b) : a;
}
function fmt(t: number) {
  return `${t.toFixed(3)}s`;
}
function quantize(t: number, step: number) {
  return Math.round(t / step) * step;
}

/* Slice + zero-cross + micro-fades for clickless export */
function sliceBuffer(
  buffer: AudioBuffer,
  startSec: number,
  endSec: number,
  opts: { zeroCross: boolean; edgeFadeMs: number },
): AudioBuffer {
  const { zeroCross, edgeFadeMs } = opts;
  const sr = buffer.sampleRate;
  let start = Math.max(0, Math.min(startSec, buffer.duration));
  let end = Math.max(start, Math.min(endSec, buffer.duration));
  let sFrame = Math.floor(start * sr),
    eFrame = Math.floor(end * sr);
  const search = Math.floor(sr * 0.01);
  if (zeroCross) {
    sFrame = snapToZeroCross(buffer, sFrame, search, -1);
    eFrame = snapToZeroCross(buffer, eFrame, search, +1);
    if (eFrame <= sFrame) eFrame = sFrame + 1;
  }
  const length = eFrame - sFrame;
  const out = new AudioBuffer({
    length,
    numberOfChannels: buffer.numberOfChannels,
    sampleRate: sr,
  });
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch),
      dst = out.getChannelData(ch);
    dst.set(src.subarray(sFrame, eFrame));
    if (edgeFadeMs > 0) {
      const fade = Math.floor((edgeFadeMs / 1000) * sr);
      for (let i = 0; i < Math.min(fade, dst.length); i++) {
        const k = i / fade;
        dst[i] *= k;
        const j = dst.length - 1 - i;
        if (j >= 0) dst[j] *= (i / fade) * -1 + 1;
      }
    }
  }
  return out;
}
function snapToZeroCross(
  buffer: AudioBuffer,
  frame: number,
  search: number,
  dir: -1 | 1,
): number {
  const ch0 = buffer.getChannelData(0);
  const start = Math.max(1, frame - (dir < 0 ? search : 0));
  const end = Math.min(ch0.length - 1, frame + (dir > 0 ? search : 0));
  let best = frame,
    bestMag = Infinity;
  for (let i = start; i <= end; i++) {
    const a = ch0[i - 1],
      b = ch0[i];
    if ((a <= 0 && b >= 0) || (a >= 0 && b <= 0)) return i;
    const mag = Math.abs(b);
    if (mag < bestMag) {
      bestMag = mag;
      best = i;
    }
  }
  return best;
}

/* Apply linear fade-in/out ramps (seconds) across the whole buffer */
function applyFades(
  buffer: AudioBuffer,
  fadeInSec: number,
  fadeOutSec: number,
): AudioBuffer {
  if (fadeInSec <= 0 && fadeOutSec <= 0) return buffer;
  const sr = buffer.sampleRate;
  const len = buffer.length;
  const fadeInFrames = Math.min(len, Math.round(fadeInSec * sr));
  const fadeOutFrames = Math.min(len, Math.round(fadeOutSec * sr));
  const out = new AudioBuffer({
    length: len,
    numberOfChannels: buffer.numberOfChannels,
    sampleRate: sr,
  });
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch),
      dst = out.getChannelData(ch);
    dst.set(src);
    for (let i = 0; i < fadeInFrames; i++) {
      dst[i] *= i / fadeInFrames;
    }
    for (let i = 0; i < fadeOutFrames; i++) {
      const idx = len - 1 - i;
      dst[idx] *= i / fadeOutFrames;
    }
  }
  return out;
}

/* Offline render with Clean FX (HPF, hum notch, LPF, gate, limiter) */
async function renderWithFX(
  buffer: AudioBuffer,
  opts: {
    hp: boolean;
    hum: boolean;
    humHz: 50 | 60;
    lp: boolean;
    gate: boolean;
    limiter: boolean;
  },
): Promise<AudioBuffer> {
  const numCh = buffer.numberOfChannels;
  const sr = buffer.sampleRate;
  const ctx = new OfflineAudioContext(numCh, buffer.length, sr);

  const src = new AudioBufferSourceNode(ctx, { buffer });
  let node: AudioNode = src;

  if (opts.hp) {
    const hpf = new BiquadFilterNode(ctx, {
      type: "highpass",
      frequency: 40,
      Q: 0.707,
    });
    node.connect(hpf);
    node = hpf;
  }
  if (opts.hum) {
    const f1 = opts.humHz;
    const f2 = f1 * 2;
    const n1 = new BiquadFilterNode(ctx, {
      type: "notch",
      frequency: f1,
      Q: 30,
    });
    const n2 = new BiquadFilterNode(ctx, {
      type: "notch",
      frequency: f2,
      Q: 30,
    });
    node.connect(n1);
    n1.connect(n2);
    node = n2;
  }
  if (opts.lp) {
    const lpf = new BiquadFilterNode(ctx, {
      type: "lowpass",
      frequency: 16000,
      Q: 0.707,
    });
    node.connect(lpf);
    node = lpf;
  }
  if (opts.gate) {
    const comp = new DynamicsCompressorNode(ctx, {
      threshold: -50,
      knee: 6,
      ratio: 12,
      attack: 0.003,
      release: 0.25,
    });
    node.connect(comp);
    node = comp;
  }
  if (opts.limiter) {
    const lim = new DynamicsCompressorNode(ctx, {
      threshold: -1,
      knee: 0,
      ratio: 20,
      attack: 0.001,
      release: 0.1,
    });
    node.connect(lim);
    node = lim;
  }

  node.connect(ctx.destination);
  src.start();
  return await ctx.startRendering();
}

/* 16-bit PCM WAV encoder — fixed */
function encodeWAV(buffer: AudioBuffer): ArrayBuffer {
  const numCh = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;

  const bytesPerSample = 2;
  const blockAlign = numCh * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numFrames * blockAlign;

  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);

  // RIFF
  writeStr(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(view, 8, "WAVE");

  // fmt
  writeStr(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);

  // data
  writeStr(view, 36, "data");
  view.setUint32(40, dataSize, true);

  // samples (interleaved)
  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      let s = buffer.getChannelData(ch)[i];
      s = Math.max(-1, Math.min(1, s));
      const v = s < 0 ? s * 0x8000 : s * 0x7fff;
      view.setInt16(offset, v, true);
      offset += 2;
    }
  }
  return ab;
}
function writeStr(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++)
    view.setUint8(offset + i, str.charCodeAt(i));
}

/* ---------- BPM detector (envelope autocorrelation) ---------- */
async function detectBPM(
  buffer: AudioBuffer,
  opts: { minBPM: number; maxBPM: number },
): Promise<{ bpm: number; phaseSec: number; confidence: number }> {
  const sr = buffer.sampleRate;
  const nCh = buffer.numberOfChannels;

  const mono = new Float32Array(buffer.length);
  for (let ch = 0; ch < nCh; ch++) {
    const d = buffer.getChannelData(ch);
    for (let i = 0; i < d.length; i++) mono[i] += d[i] / nCh;
  }

  const frame = 2048;
  const hop = 512;
  const hopSec = hop / sr;

  const nFrames = Math.floor((mono.length - frame) / hop);
  const env = new Float32Array(nFrames);
  let idx = 0;
  for (let i = 0; i < nFrames; i++) {
    let sum = 0;
    for (let j = 0; j < frame; j++) {
      const s = mono[idx + j];
      sum += s * s;
    }
    env[i] = Math.sqrt(sum / frame);
    idx += hop;
  }

  for (let i = env.length - 1; i > 0; i--) {
    const diff = env[i] - env[i - 1];
    env[i] = diff > 0 ? diff : 0;
  }
  env[0] = 0;

  const mx = Math.max(1e-9, Math.max(...env));
  for (let i = 0; i < env.length; i++) env[i] /= mx;

  const minLag = Math.round(
    60 / Math.min(220, Math.max(40, opts.maxBPM)) / hopSec,
  );
  const maxLag = Math.round(
    60 / Math.max(40, Math.min(220, opts.minBPM)) / hopSec,
  );

  let bestLag = -1,
    bestVal = -Infinity;
  const ac = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0,
      c = 0;
    for (let i = lag; i < env.length; i++) {
      s += env[i] * env[i - lag];
      c++;
    }
    const v = c ? s / c : 0;
    ac[lag] = v;
    if (v > bestVal) {
      bestVal = v;
      bestLag = lag;
    }
  }

  let bpm = 60 / (bestLag * hopSec);
  while (bpm > opts.maxBPM) bpm /= 2;
  while (bpm < opts.minBPM) bpm *= 2;

  const lag = bestLag;
  let bestPhase = 0,
    bestPhaseVal = -Infinity;
  for (let phase = 0; phase < lag; phase++) {
    let s = 0,
      c = 0;
    for (let i = phase; i < env.length; i += lag) {
      s += env[i];
      c++;
    }
    const v = c ? s / c : 0;
    if (v > bestPhaseVal) {
      bestPhaseVal = v;
      bestPhase = phase;
    }
  }
  const phaseSec = bestPhase * hopSec;

  const neighborhood = 4;
  let neighMax = 0;
  for (let d = -neighborhood; d <= neighborhood; d++) {
    if (!d) continue;
    const l = bestLag + d;
    if (l >= minLag && l <= maxLag) neighMax = Math.max(neighMax, ac[l]);
  }
  const confidence =
    bestVal > 0
      ? Math.max(0, Math.min(1, (bestVal - neighMax) / (bestVal + 1e-6)))
      : 0;

  return { bpm, phaseSec, confidence };
}
