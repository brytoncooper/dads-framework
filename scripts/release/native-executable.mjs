import { readFileSync } from "node:fs";
import { join } from "node:path";

const releaseTargets = {
  "darwin-arm64": {
    rustTarget: "aarch64-apple-darwin",
    architecture: 0x0100000c,
    magic: 0xfeedfacf,
  },
  "darwin-x64": {
    rustTarget: "x86_64-apple-darwin",
    architecture: 0x01000007,
    magic: 0xfeedfacf,
  },
  "linux-arm64-gnu": {
    rustTarget: "aarch64-unknown-linux-gnu",
    architecture: 0xb7,
    magic: 0x464c457f,
  },
  "linux-x64-gnu": {
    rustTarget: "x86_64-unknown-linux-gnu",
    architecture: 0x3e,
    magic: 0x464c457f,
  },
  "win32-x64": {
    rustTarget: "x86_64-pc-windows-msvc",
    architecture: 0x8664,
    magic: 0x00004550,
  },
};

export function nativeArchiveTarget(filename, version) {
  return Object.keys(releaseTargets).find(
    (platform) =>
      filename === `dads-framework-testing-native-${platform}-${version}.tgz`,
  );
}

export function nativeArchiveRustTarget(filename, version) {
  const platform = nativeArchiveTarget(filename, version);
  return releaseTargets[platform]?.rustTarget;
}

export function verifyNativeExecutable(root, nativeArchive, version) {
  const platform = nativeArchiveTarget(nativeArchive, version);
  if (!platform) throw new Error("Unknown native release archive target.");
  const target = releaseTargets[platform];

  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const binary = platform.startsWith("win32")
    ? "bin/dad-test.exe"
    : "bin/dad-test";
  if (
    manifest.name !== `@dads-framework/testing-native-${platform}` ||
    manifest.version !== version ||
    manifest.bin?.["dad-test"] !== `./${binary}`
  )
    throw new Error(
      "Native tarball manifest does not match its release target.",
    );
  const bytes = readFileSync(join(root, binary));
  if (!matchesHeader(bytes, platform, target)) {
    throw new Error(
      "Native executable format or architecture does not match its release target.",
    );
  }
  return binary;
}

function matchesHeader(bytes, platform, { architecture, magic }) {
  if (bytes.length < 64) return false;
  if (platform.startsWith("linux")) {
    return (
      bytes.readUInt32LE(0) === magic &&
      bytes[4] === 2 &&
      bytes[5] === 1 &&
      bytes.readUInt16LE(18) === architecture
    );
  }
  if (platform.startsWith("darwin")) {
    return (
      bytes.readUInt32LE(0) === magic && bytes.readUInt32LE(4) === architecture
    );
  }
  const peOffset = bytes.readUInt32LE(60);
  return (
    bytes.readUInt16LE(0) === 0x5a4d &&
    peOffset >= 64 &&
    peOffset <= bytes.length - 6 &&
    bytes.readUInt32LE(peOffset) === magic &&
    bytes.readUInt16LE(peOffset + 4) === architecture
  );
}
