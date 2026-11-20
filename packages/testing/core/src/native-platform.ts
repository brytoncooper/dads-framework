import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import process from "node:process";
import { resolve } from "node:path";

export type NativeLibc = "glibc" | "musl" | "unknown" | "not-applicable";

type NativePackageDefinition = {
  readonly packageName: string;
  readonly libc?: "glibc";
};

const nativePackages: Readonly<Record<string, NativePackageDefinition>> = {
  "darwin/arm64": {
    packageName: "@dads-framework/testing-native-darwin-arm64",
  },
  "darwin/x64": { packageName: "@dads-framework/testing-native-darwin-x64" },
  "linux/arm64/glibc": {
    packageName: "@dads-framework/testing-native-linux-arm64-gnu",
    libc: "glibc",
  },
  "linux/x64/glibc": {
    packageName: "@dads-framework/testing-native-linux-x64-gnu",
    libc: "glibc",
  },
  "win32/x64": { packageName: "@dads-framework/testing-native-win32-x64" },
};

const requireFromFacade = createRequire(import.meta.url);

export type NativePackageResolver = (packageName: string) => string;

/** Which input supplied the engine path, named the way a reader would name it. */
export type NativeBinarySource =
  "nativeBinary" | "DADS_TEST_NATIVE_BINARY" | "platform-package";

export type NativeBinaryResolution = {
  readonly binary: string;
  readonly source: NativeBinarySource;
};

export function nativePackageNameForPlatform(
  platform: string = process.platform,
  architecture: string = process.arch,
  libc: NativeLibc = detectNativeLibc(platform),
): string {
  return nativePackageDefinitionForPlatform(platform, architecture, libc)
    .packageName;
}

export function resolveNativeTestingBinary(
  options: {
    readonly explicitBinary?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly platform?: string;
    readonly architecture?: string;
    readonly libc?: NativeLibc;
    readonly packageResolver?: NativePackageResolver;
  } = {},
): NativeBinaryResolution {
  const developmentBinary = developmentBinaryFor(options);
  if (developmentBinary !== undefined) return developmentBinary;

  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const packageName = nativePackageNameForPlatform(
    platform,
    architecture,
    options.libc ?? detectNativeLibc(platform),
  );
  const binary = resolveNativePackageBinary(
    packageName,
    platform,
    architecture,
    options.packageResolver ?? resolveInstalledNativePackage,
  );
  if (!existsSync(binary)) {
    throw new Error(
      `Dads Testing native package ${packageName} resolved to a missing binary: ${binary}.`,
    );
  }
  return { binary, source: "platform-package" };
}

/**
 * An explicit path — from the option or from the environment — names a binary
 * a developer built, so it is used as given rather than looked up. Either one
 * replaces the platform package: it is read first, and no package lookup runs
 * behind it.
 */
function developmentBinaryFor(options: {
  readonly explicitBinary?: string;
  readonly environment?: NodeJS.ProcessEnv;
}): NativeBinaryResolution | undefined {
  const explicitBinary = options.explicitBinary;
  if (explicitBinary !== undefined) {
    return requireExistingDevelopmentBinary(explicitBinary, "nativeBinary");
  }

  const environment = options.environment ?? process.env;
  const environmentBinary = environment["DADS_TEST_NATIVE_BINARY"];
  if (environmentBinary === undefined) return undefined;
  return requireExistingDevelopmentBinary(
    environmentBinary,
    "DADS_TEST_NATIVE_BINARY",
  );
}

/** A resolution failure is reported against the platform, because that chose the package. */
function resolveNativePackageBinary(
  packageName: string,
  platform: string,
  architecture: string,
  resolvePackage: NativePackageResolver,
): string {
  try {
    return resolvePackage(packageName);
  } catch (error: unknown) {
    throw new Error(
      `Dads Testing native package ${packageName} is not installed for ${platform}/${architecture}. Install that optional package explicitly${resolutionDetail(error)}.`,
      { cause: error },
    );
  }
}

function resolutionDetail(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? ` (${error.message})`
    : "";
}

export function detectNativeLibc(
  platform: string = process.platform,
): NativeLibc {
  if (platform !== "linux") return "not-applicable";
  try {
    const report: unknown = process.report.getReport();
    const header = isKeyedObject(report) ? report["header"] : undefined;
    if (
      isKeyedObject(header) &&
      typeof header["glibcVersionRuntime"] === "string"
    ) {
      return "glibc";
    }
  } catch {
    // An unavailable diagnostic report is represented as unknown below.
  }
  return "unknown";
}

function nativePackageDefinitionForPlatform(
  platform: string,
  architecture: string,
  libc: NativeLibc,
): NativePackageDefinition {
  const key =
    platform === "linux"
      ? `${platform}/${architecture}/${libc}`
      : `${platform}/${architecture}`;
  const definition = nativePackages[key];
  if (definition !== undefined) return definition;

  if (platform === "linux" && libc !== "glibc") {
    throw new Error(
      `Dads Testing does not provide a native package for Linux ${architecture} with libc ${libc}; the supported Linux runtime is glibc.`,
    );
  }
  throw new Error(
    `Dads Testing does not provide a native package for platform ${platform} and architecture ${architecture}. Supported targets are darwin/arm64, darwin/x64, linux/arm64/glibc, linux/x64/glibc, and win32/x64.`,
  );
}

function requireExistingDevelopmentBinary(
  path: string,
  source: "nativeBinary" | "DADS_TEST_NATIVE_BINARY",
): NativeBinaryResolution {
  const binary = resolve(process.cwd(), path);
  if (!existsSync(binary)) {
    throw new Error(`The ${source} path does not exist: ${binary}.`);
  }
  return { binary, source };
}

function resolveInstalledNativePackage(packageName: string): string {
  return requireFromFacade.resolve(packageName);
}

/**
 * True for any non-null object, an array included. The diagnostic report this
 * reads is indexed by key rather than inspected for shape, so it does not need
 * the array-excluding `isRecord` in `parse-guards.ts`, and must not claim it.
 */
function isKeyedObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
