'use client';

import type { FC } from "react";

export interface NormalizedBBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface VisualRegion {
  id: string;
  bbox: NormalizedBBox;
  type?: string;
}

export interface CanvasSize {
  width: number;
  height: number;
}

export interface HighlightOverlayProps {
  regions: VisualRegion[];
  canvasSize: CanvasSize;
  activeRegionIds: string[];
}

function toCanvasBBox(bbox: NormalizedBBox, canvasSize: CanvasSize) {
  const { x0, y0, x1, y1 } = bbox;
  const width = (x1 - x0) * canvasSize.width;
  const height = (y1 - y0) * canvasSize.height;
  return {
    x: x0 * canvasSize.width,
    y: y0 * canvasSize.height,
    width,
    height,
  };
}

export const HighlightOverlay: FC<HighlightOverlayProps> = ({
  regions,
  canvasSize,
  activeRegionIds,
}) => {
  const hasActive = activeRegionIds.length > 0;
  const activeSet = new Set(activeRegionIds);
  const visibleRegions = hasActive
    ? regions.filter((region) => activeSet.has(region.id))
    : [];
  return (
    <div className="pointer-events-none absolute inset-0">
      {visibleRegions.map((region) => {
        const box = toCanvasBBox(region.bbox, canvasSize);
        const baseClass =
          "absolute rounded-md border-2 transition-all duration-200 ease-out";
        let activeClass = "border-cyan-400 bg-cyan-400/20";
        if (region.type === "table") {
          activeClass = "border-amber-400 bg-amber-400/20";
        } else if (region.type === "figure") {
          activeClass = "border-cyan-400 bg-cyan-400/20";
        }

        return (
          <div
            key={region.id}
            className={`${baseClass} ${activeClass}`}
            style={{
              left: box.x,
              top: box.y,
              width: box.width,
              height: box.height,
            }}
          />
        );
      })}
    </div>
  );
};
