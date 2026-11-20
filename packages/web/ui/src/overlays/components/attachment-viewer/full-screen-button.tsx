import { MaximizeIcon, MinimizeIcon } from "lucide-react";
import * as React from "react";

import { useOverlaysCopy } from "../../copy/overlays-copy.js";
import { ToolbarIconButton } from "./viewer-toolbar.js";

type FullScreenController = {
  /** False where the browser has no Fullscreen API (for example iPhone Safari). */
  readonly isAvailable: boolean;
  readonly isFullScreen: boolean;
  toggle: () => void;
};

/**
 * Puts the whole page into the browser's full screen and back. The viewer
 * already fills the window, so the page (not the dialog) goes full screen:
 * tooltips and menus portalled to `<body>` keep showing. Leaving the viewer
 * leaves full screen too, if the viewer entered it.
 */
function useFullScreen(): FullScreenController {
  // Read every render: jsdom and some browsers leave it undefined, which reads as false.
  const isAvailable = document.fullscreenEnabled;
  const [isFullScreen, setIsFullScreen] = React.useState(false);
  const enteredRef = React.useRef(false);

  React.useEffect(() => {
    if (!isAvailable) return;
    const onChange = () => {
      setIsFullScreen(document.fullscreenElement !== null);
    };
    onChange();
    document.addEventListener("fullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      if (enteredRef.current && document.fullscreenElement !== null) {
        void document.exitFullscreen().catch(() => undefined);
      }
    };
  }, [isAvailable]);

  const toggle = React.useCallback(() => {
    if (document.fullscreenElement !== null) {
      enteredRef.current = false;
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    enteredRef.current = true;
    void document.documentElement.requestFullscreen().catch(() => {
      enteredRef.current = false;
    });
  }, []);

  return { isAvailable, isFullScreen, toggle };
}

/** Full Screen / Exit Full Screen; absent where the browser cannot go full screen. */
export function FullScreenButton() {
  const t = useOverlaysCopy();
  const fullScreen = useFullScreen();
  if (!fullScreen.isAvailable) return null;
  return (
    <ToolbarIconButton
      label={
        fullScreen.isFullScreen
          ? t("overlays.attachmentViewer.fullScreen.exit")
          : t("overlays.attachmentViewer.fullScreen.enter")
      }
      pressed={fullScreen.isFullScreen}
      onClick={fullScreen.toggle}
    >
      {fullScreen.isFullScreen ? <MinimizeIcon /> : <MaximizeIcon />}
    </ToolbarIconButton>
  );
}
