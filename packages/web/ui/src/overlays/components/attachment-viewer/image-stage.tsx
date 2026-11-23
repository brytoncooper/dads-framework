import { Maximize2Icon, Minimize2Icon, RotateCcwIcon, RotateCwIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react";
import * as React from "react";

import { useLocaleFormatting } from "../../../copy/index.js";

import { useOverlaysCopy } from "../../copy/overlays-copy.js";
import { FullScreenButton } from "./full-screen-button.js";
import { fitImageScale, rotatedBox, type BoxSize } from "./logic/image-fit.js";
import { INITIAL_ROTATION, nextRotation, type RotateDirection, type ViewRotation } from "./logic/view-rotation.js";
import { hasZoomStep, nextZoomScale, type ZoomDirection } from "./logic/view-zoom.js";
import { ToolbarDivider, ToolbarIconButton, ToolbarReadout, ViewerToolbar } from "./viewer-toolbar.js";

/** The stage's inner padding, in px: p-4 on three sides and pb-20 under the toolbar. */
const STAGE_PADDING_X = 32;
const STAGE_PADDING_Y = 16 + 80;

const UNMEASURED: BoxSize = { width: 0, height: 0 };

/** "fit" follows the window; a number is a fixed scale the reader zoomed to. */
type ImageZoom = "fit" | number;

/** The room the photo has inside the stage, kept current as the window resizes. */
function useStageRoom(stageRef: React.RefObject<HTMLDivElement | null>): BoxSize {
  const [room, setRoom] = React.useState<BoxSize>(UNMEASURED);

  React.useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;
    const measure = () => {
      setRoom({
        width: Math.max(0, stage.clientWidth - STAGE_PADDING_X),
        height: Math.max(0, stage.clientHeight - STAGE_PADDING_Y),
      });
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => {
        window.removeEventListener("resize", measure);
      };
    }
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => {
      observer.disconnect();
    };
  }, [stageRef]);

  return room;
}

/**
 * A photo on the grey stage, with the same floating toolbar as PDFs: zoom,
 * Fit to Window or Actual Size, full screen, and rotate. It opens fitted to
 * the window, never enlarged past its own size.
 */
export function ImageStage({ src, fileName, onFailed }: { src: string; fileName: string; onFailed: () => void }) {
  const stageRef = React.useRef<HTMLDivElement | null>(null);
  const room = useStageRoom(stageRef);
  const [natural, setNatural] = React.useState<BoxSize>(UNMEASURED);
  const [zoom, setZoom] = React.useState<ImageZoom>("fit");
  const [rotation, setRotation] = React.useState<ViewRotation>(INITIAL_ROTATION);

  const isMeasured = natural.width > 0 && natural.height > 0;
  const scale = zoom === "fit" ? fitImageScale(natural, room, rotation) : zoom;
  const box = rotatedBox(natural, scale, rotation);

  return (
    <div className="relative min-h-0 flex-1 bg-muted dark:bg-scrim">
      <div
        ref={stageRef}
        tabIndex={0}
        className="absolute inset-0 flex overflow-auto p-4 pb-20 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
      >
        <div className="relative m-auto shrink-0" style={isMeasured ? { width: box.width, height: box.height } : {}}>
          <img
            src={src}
            alt={fileName}
            onError={onFailed}
            onLoad={(event) => {
              const image = event.currentTarget;
              setNatural({
                width: image.naturalWidth,
                height: image.naturalHeight,
              });
            }}
            className={
              isMeasured
                ? "absolute top-1/2 left-1/2 max-w-none rounded-sm bg-background shadow-sm"
                : "max-h-full max-w-full rounded-sm bg-background object-contain shadow-sm"
            }
            style={
              isMeasured
                ? {
                    width: natural.width * scale,
                    height: natural.height * scale,
                    transform: `translate(-50%, -50%) rotate(${String(rotation)}deg)`,
                  }
                : {}
            }
          />
        </div>
      </div>
      <ImageToolbar
        scale={scale}
        isFitted={zoom === "fit"}
        onZoom={(direction) => {
          setZoom(nextZoomScale(scale, direction));
        }}
        onToggleFit={() => {
          setZoom((current) => (current === "fit" ? 1 : "fit"));
        }}
        onRotate={(direction) => {
          setRotation((current) => nextRotation(current, direction));
        }}
      />
    </div>
  );
}

function ImageToolbar({
  scale,
  isFitted,
  onZoom,
  onToggleFit,
  onRotate,
}: {
  scale: number;
  isFitted: boolean;
  onZoom: (direction: ZoomDirection) => void;
  onToggleFit: () => void;
  onRotate: (direction: RotateDirection) => void;
}) {
  const t = useOverlaysCopy();
  const { formatNumber } = useLocaleFormatting();

  return (
    <ViewerToolbar label={t("overlays.attachmentViewer.image.toolbar")}>
      <ToolbarIconButton
        label={t("overlays.attachmentViewer.zoomOut")}
        disabled={!hasZoomStep(scale, "out")}
        onClick={() => {
          onZoom("out");
        }}
      >
        <ZoomOutIcon />
      </ToolbarIconButton>
      <ToolbarReadout>{formatNumber(scale, { style: "percent", maximumFractionDigits: 0 })}</ToolbarReadout>
      <ToolbarIconButton
        label={t("overlays.attachmentViewer.zoomIn")}
        disabled={!hasZoomStep(scale, "in")}
        onClick={() => {
          onZoom("in");
        }}
      >
        <ZoomInIcon />
      </ToolbarIconButton>
      <ToolbarIconButton
        label={isFitted ? t("overlays.attachmentViewer.image.actualSize") : t("overlays.attachmentViewer.image.fit")}
        onClick={onToggleFit}
      >
        {isFitted ? <Maximize2Icon /> : <Minimize2Icon />}
      </ToolbarIconButton>
      <FullScreenButton />

      <ToolbarDivider />

      <ToolbarIconButton
        label={t("overlays.attachmentViewer.rotateCounterclockwise")}
        onClick={() => {
          onRotate("counterclockwise");
        }}
      >
        <RotateCcwIcon />
      </ToolbarIconButton>
      <ToolbarIconButton
        label={t("overlays.attachmentViewer.rotateClockwise")}
        onClick={() => {
          onRotate("clockwise");
        }}
      >
        <RotateCwIcon />
      </ToolbarIconButton>
    </ViewerToolbar>
  );
}
