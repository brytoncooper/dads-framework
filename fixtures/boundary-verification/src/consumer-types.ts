export type DocumentReader = {
  readonly userId: string;
  readonly documentId: string;
};

export type DocumentReadIdentity = {
  readonly userId: string;
  readonly documentId: string;
};

export type DocumentReadRequest = DocumentReadIdentity & {
  readonly policyJson: string;
  readonly readers: readonly DocumentReader[];
};

export type CanReadDocument = (request: DocumentReadIdentity) => Promise<boolean>;
