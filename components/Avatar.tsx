import React, { useEffect, useId, useMemo, useRef, useState } from "react";

export type AvatarState = "idle" | "listening" | "responding" | "finished";

type AvatarProps = {
  /** Diamètre en pixels */
  size?: number;
  /** État UX (peut servir plus tard pour ajuster couleurs/rythme) */
  state?: AvatarState;
  /** Active la réaction au micro (simple : micro uniquement) */
  reactToMic?: boolean;
  /** Désactive toute animation (accessibilité / perf / debug) */
  reducedMotion?: boolean;
  /** Classe optionnelle (layout) */
  className?: string;
};

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

/**
 * Avatar "nuage irisé" (SVG) :
 * - Contour doux type "boule de coton" via turbulence + displacement
 * - Dégradés internes irisés (bleuté / nacré / léger rose)
 * - Animation lente (stable)
 * - Option : "pulse" basé sur le niveau RMS micro (implémentation la plus simple)
 */
export default function Avatar({
  size = 150,
  state = "idle",
  reactToMic = false,
  reducedMotion = false,
  className,
}: AvatarProps) {
  const uid = useId();

  // Niveau audio [0..1] lissé
  const [micLevel, setMicLevel] = useState(0);

  const rafRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Petites variations selon état (sans complexité)
  const motionSpeed = useMemo(() => {
    if (reducedMotion) return 0;
    if (state === "responding") return 1.15;
    if (state === "listening") return 1.0;
    return 0.9;
  }, [state, reducedMotion]);

  // Pulse : amplitude très modérée pour rester “premium”
  const scale = useMemo(() => {
    if (!reactToMic) return 1;
    // 0.00 → 0.08 max (8%)
    const s = 1 + clamp01(micLevel) * 0.08;
    return s;
  }, [micLevel, reactToMic]);

  useEffect(() => {
    if (reducedMotion) return;
    if (!reactToMic) return;

    // SSR-safety
    if (typeof window === "undefined") return;

    let isCancelled = false;

    async function startMic() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        if (isCancelled) return;

        streamRef.current = stream;

        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        const ctx = new AudioCtx();
        audioCtxRef.current = ctx;

        const source = ctx.createMediaStreamSource(stream);

        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.85;
        analyserRef.current = analyser;

        source.connect(analyser);

        const data = new Uint8Array(analyser.fftSize);

        const tick = () => {
          if (isCancelled) return;

          analyser.getByteTimeDomainData(data);

          // RMS sur signal centré (128)
          let sumSq = 0;
          for (let i = 0; i < data.length; i++) {
            const v = (data[i] - 128) / 128;
            sumSq += v * v;
          }
          const rms = Math.sqrt(sumSq / data.length);

          // Mapping simple + clamp
          const target = clamp01(rms * 2.2);

          // Lissage côté state (évite tremblement)
          setMicLevel((prev) => prev * 0.78 + target * 0.22);

          rafRef.current = window.requestAnimationFrame(tick);
        };

        rafRef.current = window.requestAnimationFrame(tick);
      } catch (e) {
        // Si refus micro, on garde un avatar statique (pas d’erreur bloquante)
        setMicLevel(0);
      }
    }

    startMic();

    return () => {
      isCancelled = true;

      if (rafRef.current) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }

      // Stop stream tracks
      if (streamRef.current) {
        for (const t of streamRef.current.getTracks()) t.stop();
        streamRef.current = null;
      }

      // Close audio context
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
      }

      analyserRef.current = null;
      setMicLevel(0);
    };
  }, [reactToMic, reducedMotion]);

  // IDs SVG (évite collisions)
  const ids = useMemo(() => {
    return {
      clip: `clip-${uid}`,
      filt: `filt-${uid}`,
      glow: `glow-${uid}`,
      gradA: `gradA-${uid}`,
      gradB: `gradB-${uid}`,
      noise: `noise-${uid}`,
    };
  }, [uid]);

  return (
    <div
      className={className}
      style={{
        width: size,
        height: size,
        transform: `scale(${scale})`,
        transformOrigin: "center",
        transition: reducedMotion ? "none" : "transform 120ms ease-out",
      }}
      aria-label="Avatar AMAI"
      role="img"
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 200 200"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          {/* Dégradé “nacré/irisé” principal */}
          <radialGradient id={ids.gradA} cx="45%" cy="35%" r="70%">
            <stop offset="0%" stopColor="#F7FBFF" stopOpacity="0.95" />
            <stop offset="35%" stopColor="#BEEBFF" stopOpacity="0.90" />
            <stop offset="62%" stopColor="#7AB7FF" stopOpacity="0.80" />
            <stop offset="85%" stopColor="#9B7BFF" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#FFB7E6" stopOpacity="0.38" />
          </radialGradient>

          {/* Second dégradé léger pour “reflet” */}
          <radialGradient id={ids.gradB} cx="62%" cy="58%" r="65%">
            <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.55" />
            <stop offset="40%" stopColor="#D7F2FF" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
          </radialGradient>

          {/* Contour nuageux : turbulence + displacement */}
          <filter id={ids.filt} x="-20%" y="-20%" width="140%" height="140%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.018"
              numOctaves="2"
              seed="3"
              result={ids.noise}
            >
              {!reducedMotion && (
                <animate
                  attributeName="baseFrequency"
                  dur={`${12 / motionSpeed}s`}
                  values="0.017;0.020;0.017"
                  repeatCount="indefinite"
                />
              )}
            </feTurbulence>
            <feDisplacementMap
              in="SourceGraphic"
              in2={ids.noise}
              scale="22"
              xChannelSelector="R"
              yChannelSelector="G"
            />
            {/* Adoucit le bord */}
            <feGaussianBlur stdDeviation="0.6" />
          </filter>

          {/* Glow/ombre douce */}
          <filter id={ids.glow} x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="6" result="blur" />
            <feColorMatrix
              in="blur"
              type="matrix"
              values="
                1 0 0 0 0
                0 1 0 0 0
                0 0 1 0 0
                0 0 0 0.32 0"
            />
            <feMerge>
              <feMergeNode />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* Clip “bulle” de base (pour garder une silhouette ronde globale),
              le filtre displacement fait le bord nuageux */}
          <clipPath id={ids.clip}>
            <circle cx="100" cy="100" r="78" />
          </clipPath>
        </defs>

        {/* Ombre externe douce */}
        <circle
          cx="100"
          cy="104"
          r="78"
          fill="#000"
          opacity="0.10"
          filter={`url(#${ids.glow})`}
        />

        {/* Corps principal */}
        <g clipPath={`url(#${ids.clip})`} filter={`url(#${ids.filt})`}>
          {/* Fond irisé */}
          <circle cx="100" cy="100" r="78" fill={`url(#${ids.gradA})`} />

          {/* Reflet nacré */}
          <circle cx="112" cy="110" r="76" fill={`url(#${ids.gradB})`} />

          {/* Brillance “perlée” en haut à gauche */}
          <ellipse cx="78" cy="70" rx="40" ry="28" fill="#FFFFFF" opacity="0.25" />

          {/* Animation lente : légère rotation interne (illusion de mouvement) */}
          {!reducedMotion && (
            <g opacity="0.55">
              <g>
                <ellipse cx="130" cy="78" rx="52" ry="38" fill="#BEEBFF" opacity="0.18" />
                <ellipse cx="82" cy="120" rx="60" ry="44" fill="#FFB7E6" opacity="0.14" />
                <animateTransform
                  attributeName="transform"
                  type="rotate"
                  from="0 100 100"
                  to="360 100 100"
                  dur={`${34 / motionSpeed}s`}
                  repeatCount="indefinite"
                />
              </g>
            </g>
          )}
        </g>

        {/* Anneau externe discret (nacré) */}
        <circle
          cx="100"
          cy="100"
          r="80"
          fill="none"
          stroke="#FFFFFF"
          strokeOpacity="0.55"
          strokeWidth="5"
        />
      </svg>
    </div>
  );
}