/** Dimensions in display pixels. Use an image served over HTTPS. */
export type EmailLogo = {
  readonly src: string;
  readonly alt: string;
  readonly width: number;
  readonly height: number;
};

/** The application's optional header and footer marks. */
export type EmailBranding = {
  readonly headerLogo?: EmailLogo;
  readonly footerLogo?: EmailLogo;
};
