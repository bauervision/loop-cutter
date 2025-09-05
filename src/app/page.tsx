"use client";

import * as React from "react";

/* ---------- Minimal types ---------- */
type WaveSurferType = typeof import("wavesurfer.js")["default"];
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
    }>
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

  /* -------- loop freeze helpers -------- */
  const frozenScrollRef = React.useRef<number | null>(null);
  const prevAutoCenterRef = React.useRef<boolean | null>(null);

  function getWrapperAndRenderer() {
    const ws = wsRef.current as any;
    const renderer: any = ws?.renderer;
    const wrapper: HTMLElement | undefined =
      renderer?.getWrapper?.() || ws?.getWrapper?.();
    return { ws, renderer, wrapper };
  }
  function isRegionFullyVisible(padPx = 2): boolean {
    const { ws, renderer, wrapper } = getWrapperAndRenderer();
    const r = regionRef.current;
    if (!ws || !wrapper || !r) return false;
    const duration = ws.getDuration() || 0;
    if (!duration) return false;

    const totalPx =
      renderer?.getWidth?.() || wrapper.scrollWidth || wrapper.clientWidth;
    const pxPerSec = totalPx / duration;

    const visStart = (wrapper.scrollLeft + padPx) / pxPerSec;
    const visEnd =
      (wrapper.scrollLeft + wrapper.clientWidth - padPx) / pxPerSec;
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
    const { wrapper } = getWrapperAndRenderer();
    if (!wrapper) return;
    if (shouldFreeze) {
      frozenScrollRef.current = wrapper.scrollLeft;
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
        RegionsPlugin.create()
      ) as RegionsPluginInstance;
      regionsRef.current = regions;
      regions.enableDragSelection({ slop: 2, color: "rgba(76,143,247,0.18)" });

      ws.on("ready", () => {
        ws.zoom(zoomRef.current);
        drawGrid();
        regions.clearRegions();
        const dur = ws.getDuration() || 2;
        const r = regions.addRegion({
          start: 0,
          end: Math.min(2, dur),
          color: "rgba(76,143,247,0.18)",
          drag: true,
          resize: true,
          loop: false,
        });
        regionRef.current = r;
        setStart(r.start);
        setEnd(r.end);
      });

      ws.on("timeupdate", () => {
        const { wrapper } = getWrapperAndRenderer();
        if (!wrapper) return;
        if (loopModeRef.current && frozenScrollRef.current !== null) {
          wrapper.scrollLeft = frozenScrollRef.current!;
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
    if (!wsRef.current) return;

    try {
      await wsRef.current.loadBlob(file);
    } catch {
      await wsRef.current.load(URL.createObjectURL(file));
    }

    if (!audioCtxRef.current)
      audioCtxRef.current = new (window.AudioContext ||
        (window as any).webkitAudioContext)();
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
    const renderer: any = ws.renderer;
    const wrapper: HTMLElement | undefined =
      renderer?.getWrapper?.() || ws.getWrapper?.();
    const duration = ws.getDuration() || 0;
    if (!wrapper || !duration) return;
    const totalPx: number =
      (renderer?.getWidth && renderer.getWidth()) ||
      wrapper.scrollWidth ||
      wrapper.clientWidth;
    const pxPerSec = totalPx / duration;
    const t = ws.getCurrentTime() as number;
    const target = t * pxPerSec - wrapper.clientWidth / 2;
    wrapper.scrollLeft = Math.max(
      0,
      Math.min(target, totalPx - wrapper.clientWidth)
    );
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

  /* -------- Export (with Clean FX) -------- */
  const exportSelection = async () => {
    const r = regionRef.current,
      buf = bufferRef.current;
    if (!r || !buf) return;
    const sliced = sliceBuffer(buf, r.start, r.end, {
      zeroCross,
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
    a.download = `${base}_${fmt(r.start)}-${fmt(r.end)}_clean.wav`;
    a.click();
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

    const allOff = !fxHighpass && !fxHum && !fxLowpass && !fxGate && !fxLimiter;

    const id = setTimeout(async () => {
      if (cancelled || !bufferRef.current || !wsRef.current) return;

      setIsRenderingFX(true);
      try {
        if (allOff) {
          if (originalBlobRef.current)
            await ws.loadBlob(originalBlobRef.current);
        } else {
          const processed = await renderWithFX(bufferRef.current!, {
            hp: fxHighpass,
            hum: fxHum,
            humHz: fxHumFreq,
            lp: fxLowpass,
            gate: fxGate,
            limiter: fxLimiter,
          });
          const wav = encodeWAV(processed);
          const blob = new Blob([wav], { type: "audio/wav" });
          await ws.loadBlob(blob);
        }

        const resumeTime =
          wasLooping && r
            ? Math.min(
                Math.max(r.start, tNow),
                Math.max(r.start, r.end - 0.001)
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
  }, [fxHighpass, fxHum, fxHumFreq, fxLowpass, fxGate, fxLimiter]);

  /* -------- Grid overlay -------- */
  const clearGrid = () => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  };

  const drawGrid = React.useCallback(() => {
    if (!showGridRef.current) return;

    const ws = wsRef.current,
      canvas = overlayRef.current;
    if (!ws || !canvas) return;
    const renderer: any = (ws as any).renderer;
    const wrapper: HTMLElement | undefined =
      renderer?.getWrapper?.() || (ws as any).getWrapper?.();
    const duration = ws.getDuration() || 0;
    if (!wrapper || !duration) return;

    const w = wrapper.clientWidth,
      h = wrapper.clientHeight;
    canvas.width = Math.max(1, Math.floor(w * devicePixelRatio));
    canvas.height = Math.max(1, Math.floor(h * devicePixelRatio));
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const totalPx: number =
      (renderer?.getWidth && renderer.getWidth()) || wrapper.scrollWidth || w;
    const secToPx = (t: number) =>
      renderer?.secondsToPixels
        ? renderer.secondsToPixels(t)
        : (t * totalPx) / duration;
    const pxToSec = (x: number) =>
      renderer?.pixelsToSeconds
        ? renderer.pixelsToSeconds(x)
        : (x * duration) / totalPx;

    const scrollLeft = wrapper.scrollLeft || 0;
    const visStart = pxToSec(scrollLeft);
    const visEnd = pxToSec(scrollLeft + w);

    const r = regionRef.current;
    if (!r) return;

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

    const pxPerSec = totalPx / duration;
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
          (t - anchor) / barPeriod - Math.round((t - anchor) / barPeriod)
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
    if (!showGrid) clearGrid();
    else drawGrid();
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
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [togglePlayPause, toggleLoop, returnToStart]);

  /* -------- Mouse wheel zoom (cursor-anchored) -------- */
  const onWheelZoom = (e: React.WheelEvent) => {
    e.preventDefault(); // stop page scroll while hovering
    const ws = wsRef.current;
    if (!ws) return;
    const { renderer, wrapper } = getWrapperAndRenderer();
    if (!wrapper) return;
    const duration = ws.getDuration() || 0;
    if (!duration) return;

    const rect = wrapper.getBoundingClientRect();
    const x = e.clientX - rect.left;

    const totalPxBefore =
      renderer?.getWidth?.() || wrapper.scrollWidth || rect.width;
    const pxPerSecBefore = totalPxBefore / duration;
    const tUnderCursor = (wrapper.scrollLeft + x) / pxPerSecBefore;

    const factor = Math.pow(1.0015, -e.deltaY); // up→in, down→out
    const next = clamp(zoomRef.current * factor, 10, 2000);
    setZoom(next);

    requestAnimationFrame(() => {
      const totalPxAfter =
        renderer?.getWidth?.() || wrapper.scrollWidth || rect.width;
      const pxPerSecAfter = totalPxAfter / duration;
      const newScrollLeft = tUnderCursor * pxPerSecAfter - x;
      wrapper.scrollLeft = clamp(
        newScrollLeft,
        0,
        Math.max(0, totalPxAfter - wrapper.clientWidth)
      );
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
              gapless loop. Export clean, click-free WAVs.
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
        </div>

        <section style={styles.controls}>
          {/* Transport */}
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

              <button
                style={styles.green}
                onClick={exportSelection}
                disabled={!regionRef.current || !bufferRef.current}
              >
                Export WAV (Clean)
              </button>
            </div>
          </div>

          {/* BPM detect + controls */}
          <div style={{ ...styles.row, marginTop: 10 }}>
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
                  setBpm(clampNum(parseInt(e.target.value || "0", 10), 40, 300))
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

          {/* FX row */}
          <div style={{ ...styles.row, marginTop: 10 }}>
            <div style={{ ...styles.inline, gap: 10, flexWrap: "wrap" }}>
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

          {/* Nudges + Readout */}
          <div style={{ ...styles.row, marginTop: 10 }}>
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
            <div style={styles.meta}>
              Selection: <strong>{fmt(start)}</strong> –{" "}
              <strong>{fmt(end)}</strong> ({fmt(end - start)})
            </div>
          </div>

          {/* Export helpers */}
          <div style={{ ...styles.row, marginTop: 6 }}>
            <label style={styles.checkbox}>
              <input
                type="checkbox"
                checked={zeroCross}
                onChange={(e) => setZeroCross(e.target.checked)}
              />{" "}
              <span>Snap to zero-cross (export)</span>
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
  opts: { zeroCross: boolean; edgeFadeMs: number }
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
  dir: -1 | 1
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
  }
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
  opts: { minBPM: number; maxBPM: number }
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
    60 / Math.min(220, Math.max(40, opts.maxBPM)) / hopSec
  );
  const maxLag = Math.round(
    60 / Math.max(40, Math.min(220, opts.minBPM)) / hopSec
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
