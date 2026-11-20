import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const cargoNotice = "third-party/dad-test/THIRD_PARTY_NOTICES.txt";
const rustNotice = "RUST_STANDARD_LIBRARY_NOTICES.html";
export const nativeNoticeFiles = [
  "LICENSE.md",
  "THIRD_PARTY_NOTICES.txt",
  rustNotice,
];

export function assertNativeNoticeLock(root) {
  const expected = readFileSync(
    join(root, "third-party/dad-test/Cargo.lock.sha256"),
    "utf8",
  ).trim();
  const actual = createHash("sha256")
    .update(
      readFileSync(join(root, "Cargo.lock"), "utf8").replace(/\r\n/g, "\n"),
    )
    .digest("hex");
  if (actual !== expected) {
    throw new Error(
      "Review and update the dad-test crate notices for the current Cargo.lock.",
    );
  }
}

export function stageNativePackageNotices(root, packageRoot) {
  for (const [name, source] of nativeNoticeSources(root))
    copyFileSync(source, join(packageRoot, name));
}

export function verifyNativePackageNotices(root, packageRoot) {
  for (const [name, source] of nativeNoticeSources(root)) {
    if (!readFileSync(join(packageRoot, name)).equals(readFileSync(source)))
      throw new Error(`Native package notice differs from its source: ${name}`);
  }
}

function nativeNoticeSources(root) {
  const rustSysroot = execFileSync("rustc", ["--print", "sysroot"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const rustSource = join(
    rustSysroot,
    "share",
    "doc",
    "rust",
    "COPYRIGHT-library.html",
  );
  try {
    readFileSync(rustSource);
  } catch (error) {
    throw new Error(
      "Install the rust-docs component of the pinned toolchain before preparing a native package.",
      { cause: error },
    );
  }
  return [
    ["LICENSE.md", join(root, "LICENSE.md")],
    ["THIRD_PARTY_NOTICES.txt", join(root, cargoNotice)],
    [rustNotice, rustSource],
  ];
}
