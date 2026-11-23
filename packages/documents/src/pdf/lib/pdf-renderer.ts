export type PdfMargins = number | readonly [number, number] | readonly [number, number, number, number];

export type PdfPageSize =
  | string
  | {
      readonly width: number;
      readonly height: number | "auto";
    };

export type PdfPageOrientation = "portrait" | "landscape";

export type PdfPageSizeDimensions = {
  readonly width: number;
  readonly height: number;
  readonly orientation: PdfPageOrientation;
};

export type PdfStyle = {
  readonly font?: string | undefined;
  readonly fontSize?: number | undefined;
  readonly fontFeatures?: readonly string[] | undefined;
  readonly lineHeight?: number | undefined;
  readonly bold?: boolean | undefined;
  readonly italics?: boolean | undefined;
  readonly alignment?: "left" | "right" | "justify" | "center" | undefined;
  readonly color?: string | undefined;
  readonly background?: string | readonly [string, string] | undefined;
  readonly markerColor?: string | undefined;
  readonly decoration?: string | readonly string[] | undefined;
  readonly decorationStyle?: string | undefined;
  readonly decorationColor?: string | undefined;
  readonly decorationThickness?: number | undefined;
  readonly margin?: PdfMargins | undefined;
  readonly marginTop?: number | undefined;
  readonly marginRight?: number | undefined;
  readonly marginBottom?: number | undefined;
  readonly marginLeft?: number | undefined;
  readonly preserveLeadingSpaces?: boolean | undefined;
  readonly preserveTrailingSpaces?: boolean | undefined;
  readonly opacity?: number | undefined;
  readonly characterSpacing?: number | undefined;
  readonly leadingIndent?: number | undefined;
  readonly sup?: boolean | undefined;
  readonly sub?: boolean | undefined;
  readonly fillColor?: string | readonly [string, string] | undefined;
  readonly fillOpacity?: number | undefined;
  readonly noWrap?: boolean | undefined;
  readonly wordBreak?: "normal" | "break-all" | undefined;
  readonly columnGap?: number | undefined;
};

export type PdfNamedStyle = PdfStyle & {
  readonly extends?: string | readonly string[] | undefined;
};

export type PdfContentNode = string | number | boolean | readonly PdfContentNode[] | object;

export type PdfDynamicContent = (
  currentPage: number,
  pageCount: number,
  pageSize: PdfPageSizeDimensions,
) => PdfContentNode | null | undefined;

export type PdfDynamicBackground = (
  currentPage: number,
  pageSize: PdfPageSizeDimensions,
) => PdfContentNode | null | undefined;

/** Self-contained structural pdfmake document definition that does not require `@types/pdfmake`. */
export type PdfmakeDefinition = {
  readonly content: PdfContentNode;
  readonly background?: PdfContentNode | PdfDynamicBackground | undefined;
  readonly compress?: boolean | undefined;
  readonly defaultStyle?: PdfStyle | undefined;
  readonly footer?: PdfContentNode | PdfDynamicContent | undefined;
  readonly header?: PdfContentNode | PdfDynamicContent | undefined;
  readonly images?: Readonly<Record<string, string | object>> | undefined;
  readonly info?: object | undefined;
  readonly pageBreakBefore?: ((...args: readonly never[]) => boolean) | undefined;
  readonly pageMargins?: PdfMargins | undefined;
  readonly pageOrientation?: PdfPageOrientation | undefined;
  readonly pageSize?: PdfPageSize | undefined;
  readonly styles?: Readonly<Record<string, PdfNamedStyle>> | undefined;
  readonly userPassword?: string | undefined;
  readonly ownerPassword?: string | undefined;
  readonly permissions?: object | undefined;
  readonly version?: string | undefined;
  readonly subset?: string | undefined;
  readonly tagged?: boolean | undefined;
  readonly displayTitle?: boolean | undefined;
  readonly watermark?: string | object | undefined;
  readonly patterns?: Readonly<Record<string, object>> | undefined;
  readonly language?: string | undefined;
  readonly attachments?: Readonly<Record<string, object>> | undefined;
  readonly files?: Readonly<Record<string, object>> | undefined;
};

export type PdfDefinition = PdfmakeDefinition;

export type PdfTextMetrics = {
  /** Helvetica's width, or Helvetica Bold's when `bold` (Oblique matches upright). */
  width(text: string, fontSizePt: number, bold?: boolean): number;
  lineHeight(fontSizePt: number): number;
};

/** Renders pdfmake's document format to bytes and measures its built-in font. */
export abstract class PdfRenderer {
  abstract render(definition: PdfmakeDefinition): Promise<Uint8Array>;
  abstract textMetrics(): Promise<PdfTextMetrics>;
}
