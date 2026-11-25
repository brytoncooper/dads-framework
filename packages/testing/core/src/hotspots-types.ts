export type TestingHotspotsRequest = {
  readonly workspaceRoot: string;
  readonly manifestPath?: string;
  readonly limit?: number;
  readonly minProjects?: number;
  readonly barrelsOnly?: boolean;
  /** An explicit native binary is intended for local development and test harnesses. */
  readonly nativeBinary?: string;
};

export type TestingHotspotsSummary = {
  readonly totalFiles: number;
  readonly totalBarrels: number;
  readonly totalProjects: number;
  readonly limit: number;
  readonly minProjects: number;
  readonly barrelsOnly: boolean;
};

export type TestingHotspotFile = {
  readonly path: string;
  readonly project?: string;
  readonly affectedProjects: number;
  readonly affectedFiles: number;
  readonly directImporters: number;
  readonly isBarrel: boolean;
};

export type TestingHotspotProject = {
  readonly project: string;
  readonly affectedProjects: number;
  readonly affectedFiles: number;
  readonly directDependentProjects: number;
  readonly fileCount: number;
  readonly barrelCount: number;
};

export type TestingHotspotsResult = {
  readonly schemaVersion: 1;
  readonly summary: TestingHotspotsSummary;
  readonly files: readonly TestingHotspotFile[];
  readonly projects: readonly TestingHotspotProject[];
};

export type NativeHotspotsOptions = {
  readonly limit?: number;
  readonly minProjects?: number;
  readonly barrelsOnly?: boolean;
};

export function toNativeHotspotsOptions(request: TestingHotspotsRequest): NativeHotspotsOptions | undefined {
  const hasLimit = request.limit !== undefined;
  const hasMinProjects = request.minProjects !== undefined;
  const hasBarrelsOnly = request.barrelsOnly === true;
  if (!hasLimit && !hasMinProjects && !hasBarrelsOnly) {
    return undefined;
  }
  return {
    ...(hasLimit ? { limit: request.limit } : {}),
    ...(hasMinProjects ? { minProjects: request.minProjects } : {}),
    ...(hasBarrelsOnly ? { barrelsOnly: true } : {}),
  };
}
