import * as React from "react";

export type PdfPageCanvasProps = {
  readonly bytes: Uint8Array;
  /** CSS pixels per PDF point. */
  readonly scale: number;
  readonly className?: string;
  readonly onError?: () => void;
};

export function PdfPageCanvas(props: PdfPageCanvasProps) {
  const [loaded, setLoaded] = React.useState<{
    View: React.ComponentType<PdfPageCanvasProps>;
  } | null>(null);
  const onErrorRef = React.useRef(props.onError);
  onErrorRef.current = props.onError;

  React.useEffect(() => {
    let cancelled = false;
    import("./pdf/pdf-page-canvas-content.js")
      .then(({ PdfPageCanvasContent }) => {
        if (!cancelled) setLoaded({ View: PdfPageCanvasContent });
      })
      .catch(() => {
        if (!cancelled) onErrorRef.current?.();
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loaded === null) return <div className={props.className} />;
  return <loaded.View {...props} />;
}
