The first public npm release is on hold. The release will distribute native
executables through these platform-specific optional packages:

- `@dads-framework/testing-native-darwin-arm64`
- `@dads-framework/testing-native-darwin-x64`
- `@dads-framework/testing-native-linux-arm64-gnu`
- `@dads-framework/testing-native-linux-x64-gnu`
- `@dads-framework/testing-native-win32-x64`

The facade resolves the matching optional package through Node package
resolution. This directory is a source-tree marker. For local development,
follow the [native build instructions](../README.md#native-packages) and set
`DADS_TEST_NATIVE_BINARY` to the executable you built.
