import { useEffect, useRef } from "react";
import {
  CELL_HEIGHT,
  CELL_WIDTH,
  frameCountByState,
  nextFrameDelay,
  rowByState
} from "./atlas";
import type { PetState } from "./types";

type PetCanvasProps = {
  imageUrl: string | null;
  state: PetState;
  scale: number;
};

export function PetCanvas({ imageUrl, state, scale }: PetCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const frameRef = useRef(0);
  const stateRef = useRef<PetState>(state);

  useEffect(() => {
    stateRef.current = state;
    frameRef.current = 0;
  }, [state]);

  useEffect(() => {
    if (!imageUrl) {
      imageRef.current = null;
      return;
    }
    const image = new Image();
    image.onload = () => {
      imageRef.current = image;
    };
    image.src = imageUrl;
    return () => {
      image.onload = null;
    };
  }, [imageUrl]);

  useEffect(() => {
    let raf = 0;
    let last = 0;

    const draw = (timestamp: number) => {
      const canvas = canvasRef.current;
      const image = imageRef.current;
      if (canvas && image) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          const currentState = stateRef.current;
          const delay = nextFrameDelay(currentState);
          if (timestamp - last > delay) {
            frameRef.current = (frameRef.current + 1) % frameCountByState[currentState];
            last = timestamp;
          }
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(
            image,
            frameRef.current * CELL_WIDTH,
            rowByState[currentState] * CELL_HEIGHT,
            CELL_WIDTH,
            CELL_HEIGHT,
            0,
            0,
            canvas.width,
            canvas.height
          );
        }
      }
      raf = window.requestAnimationFrame(draw);
    };

    raf = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(raf);
  }, [scale]);

  return (
    <canvas
      ref={canvasRef}
      className="pet-canvas"
      width={Math.round(CELL_WIDTH * scale)}
      height={Math.round(CELL_HEIGHT * scale)}
      aria-label={`Claude pet animation: ${state}`}
    />
  );
}
