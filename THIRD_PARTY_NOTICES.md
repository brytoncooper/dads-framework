# Third-party notices

The [MIT license](./LICENSE.md) covers Dads-authored material. The following
third-party material retains its upstream notices and license terms.

## Source redistributed with Dads

| Distributor                        | Material                                                                           | Notices                                                                                                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@dads-framework/ui`               | Adapted Dice UI and shadcn/ui components, and Radix Primitives and Mantine helpers | [UI sources and MIT notices](./packages/web/ui/THIRD_PARTY_NOTICES.md)                                                                                   |
| `@dads-framework/testing-native-*` | Compiled `dad-test` with statically linked Rust libraries                          | [Cargo crate sources and notices](./third-party/dad-test/THIRD_PARTY_NOTICES.txt) and the Rust standard-library notice supplied with each native package |

The native notice includes the pinned Cargo versions across supported platforms,
including target-specific and build-time dependencies. A given executable
uses a subset of that inventory. The native package build copies the official
`COPYRIGHT-library.html` from the Rust toolchain used to compile it, including
notices for components of the standard library. [Rust upstream source and copyright](https://github.com/rust-lang/rust/blob/1.96.0/COPYRIGHT)

## Separately installed dependencies

The [npm lockfile](./package-lock.json) records the version, source archive,
integrity digest and available license metadata for each resolved dependency.
The TypeScript packages ship their own compiled modules and declared assets.
npm fetches dependencies such as Fastify, Zod, React, Lucide, PDF.js and
Fontsource as separate packages. Retain the upstream notices if you bundle or
redistribute those dependencies.

The font CSS imports separately installed IBM Plex Sans and IBM Plex Mono
subsets from [Fontsource](https://fontsource.org/). IBM Plex is distributed
under SIL Open Font License 1.1 with the reserved font name “Plex”.
[IBM Plex upstream license](https://github.com/IBM/plex/blob/master/LICENSE.txt)

The npm lockfile omits SPDX metadata for some packages. The table below
record the release archive license evidence reviewed for those entries.

| Locked dependency                                                          | License evidence                                                                                                                                                  |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [buildcheck 0.0.7](https://www.npmjs.com/package/buildcheck/v/0.0.7)       | MIT notice shipped in the package                                                                                                                                 |
| [cpu-features 0.0.10](https://www.npmjs.com/package/cpu-features/v/0.0.10) | MIT wrapper notice and upstream Google `cpu_features` terms shipped in the package                                                                                |
| [png-js 2.0.0](https://www.npmjs.com/package/png-js/v/2.0.0)               | MIT notice shipped in the package                                                                                                                                 |
| [ssh2 1.17.0](https://www.npmjs.com/package/ssh2/v/1.17.0)                 | MIT notice shipped in the package                                                                                                                                 |
| [buffers 0.1.1](https://www.npmjs.com/package/buffers/v/0.1.1)             | No license notice or declaration found in the archive. This transitive dependency of ExcelJS is installed separately. Its redistribution terms remain unverified. |

The [Cargo lockfile](./Cargo.lock) pins the Rust dependency source registry
and checksums. The native notice records license metadata from those exact
crate versions and preserves their license files. When a crate archive omits
its license file, the notice gives the license source at the upstream revision
recorded by the archive.

Update the native notice and Cargo lock digest together whenever the Cargo
dependency set changes. Review any new dependency license and preserve the
notice from the exact licensed crate version.
