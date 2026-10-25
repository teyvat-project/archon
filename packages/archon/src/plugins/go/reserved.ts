/** Go keywords (identifiers that would be one get a trailing `_`). */
export const GO_KEYWORDS: Set<string> = new Set([
  'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for', 'func', 'go', 'goto', 'if',
  'import', 'interface', 'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var',
]);

/** Exported package-level names the generated code declares itself (models must not take them). */
export const PACKAGE_NAMES: string[] = ['Client', 'ClientOptions', 'NewClient', 'Auth', 'DefaultBaseURL'];

/** Methods generated on models; a struct field may not have the same name. */
export const MODEL_METHODS: string[] = ['MarshalJSON', 'UnmarshalJSON', 'IsKnown'];

/**
 * GOOS / GOARCH values and `test`: a file name ending in `_<one of these>.go` is a test file or only built for that
 * platform.
 */
export const FILE_SUFFIXES: Set<string> = new Set([
  'test', 'aix', 'android', 'darwin', 'dragonfly', 'freebsd', 'hurd', 'illumos', 'ios', 'js', 'linux', 'nacl', 'netbsd',
  'openbsd', 'plan9', 'solaris', 'wasip1', 'windows', 'zos', '386', 'amd64', 'amd64p32', 'arm', 'armbe', 'arm64', 'arm64be',
  'loong64', 'mips', 'mipsle', 'mips64', 'mips64le', 'mips64p32', 'mips64p32le', 'ppc', 'ppc64', 'ppc64le', 'riscv',
  'riscv64', 's390', 's390x', 'sparc', 'sparc64', 'wasm',
]);
