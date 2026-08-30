export interface ViewTransform {
  zoom: number;
  x: number;
  y: number;
}

export const MIN_PREVIEW_ZOOM = 0.05;
export const MAX_PREVIEW_ZOOM = 8;

export function clampPreviewZoom(value: number): number {
  return Math.max(MIN_PREVIEW_ZOOM, Math.min(MAX_PREVIEW_ZOOM, value));
}

export function calculateFitZoom(
  viewportWidth: number,
  viewportHeight: number,
  imageWidth: number,
  imageHeight: number,
  padding = 32,
): number {
  if (viewportWidth <= padding || viewportHeight <= padding || imageWidth <= 0 || imageHeight <= 0) return 1;
  return clampPreviewZoom(Math.min(1, (viewportWidth - padding) / imageWidth, (viewportHeight - padding) / imageHeight));
}

export function zoomAroundPoint(
  current: ViewTransform,
  nextZoomValue: number,
  point: { x: number; y: number },
  viewport: { width: number; height: number },
): ViewTransform {
  const nextZoom = clampPreviewZoom(nextZoomValue);
  const offsetX = point.x - viewport.width / 2;
  const offsetY = point.y - viewport.height / 2;
  const imageX = (offsetX - current.x) / current.zoom;
  const imageY = (offsetY - current.y) / current.zoom;
  return {
    zoom: nextZoom,
    x: offsetX - imageX * nextZoom,
    y: offsetY - imageY * nextZoom,
  };
}
