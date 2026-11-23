/**
 * One column of a generated workbook.
 */
export type WorkbookColumn = {
  /** Text written into the header row (row 1). */
  readonly header: string;
  /** Key that `exampleRows` values are looked up by. */
  readonly key: string;
  /** Column width in characters; defaults to 24. */
  readonly widthChars?: number;
  /**
   * When present, the column's data cells get an Excel dropdown restricted to
   * these values (backed by a hidden lookup sheet, never an inline list).
   */
  readonly dropdown?: { readonly values: readonly string[] };
  /** Marks the header as required with an accessible note and distinct fill. */
  readonly required?: boolean;
  /**
   * `date` writes a real Excel date (yyyy-mm-dd, date validation).
   * `time` writes an Excel time from HH:mm:ss.
   * `number` writes a real Excel number so fill-down can increment a series.
   * `text` forces Excel text storage so leading zeros and long identifiers stay
   * exact.
   */
  readonly cellKind?: "date" | "time" | "number" | "text";
};

/** One table or reference sheet of a generated workbook. */
export type WorkbookTableSheetSpec = {
  readonly sheetName: string;
  readonly kind?: "table" | "reference";
  readonly columns: readonly WorkbookColumn[];
  readonly exampleRows?: readonly Readonly<Record<string, string>>[];
  /** Number of blank data rows that receive validation and cell formats. */
  readonly validatedDataRowCount?: number;
  /** Number of leading columns frozen beside the header row. */
  readonly frozenColumnCount?: number;
  /** Adds an Excel filter to the header row. */
  readonly showFilter?: boolean;
};

export type WorkbookInstruction = {
  readonly heading: string;
  readonly text: string;
};

/** A visible human-readable instruction sheet with no table contract. */
export type WorkbookInstructionSheetSpec = {
  readonly sheetName: string;
  readonly kind: "instructions";
  readonly title: string;
  readonly introduction?: string;
  readonly instructions: readonly WorkbookInstruction[];
};

export type WorkbookSheetSpec = WorkbookTableSheetSpec | WorkbookInstructionSheetSpec;

/** Version and context hints stored on the workbook's very-hidden metadata sheet. */
export type WorkbookMetadata = {
  readonly formatId: string;
  readonly formatVersion: number;
  readonly values?: Readonly<Record<string, string>>;
};

export const WORKBOOK_METADATA_SHEET_NAME = "_Workbook Metadata";

/**
 * Everything `buildWorkbook` needs to produce a template: one or more visible
 * sheets, their columns, and optional example rows keyed by column `key`.
 */
export type WorkbookSpec = {
  readonly sheets: readonly WorkbookSheetSpec[];
  readonly metadata?: WorkbookMetadata;
};

/** A workbook known by its caller to contain only table/reference sheets. */
export type WorkbookTableSpec = {
  readonly sheets: readonly WorkbookTableSheetSpec[];
  readonly metadata?: WorkbookMetadata;
};
