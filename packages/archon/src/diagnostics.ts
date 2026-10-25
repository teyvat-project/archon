export type Diagnostic = {
  level: 'info' | 'warn' | 'error';
  code: string;
  message: string;
  pointer?: string;
};

export class ArchonError extends Error {
  readonly code: string;
  readonly pointer?: string;

  constructor(code: string, message: string, pointer?: string) {
    super(message);
    this.name = 'ArchonError';
    this.code = code;
    if (pointer !== undefined) this.pointer = pointer;
  }
}

export class Diagnostics {
  readonly entries: Diagnostic[] = [];
  private readonly verbose: boolean;
  private readonly sink: ((d: Diagnostic) => void) | undefined;

  constructor(opts: { verbose?: boolean; sink?: (d: Diagnostic) => void } = {}) {
    this.verbose = opts.verbose ?? false;
    this.sink = opts.sink;
  }

  /** 常に entries に記録し、verbose のときだけ sink に流す。 */
  info(code: string, message: string, pointer?: string): void {
    const d = this.record('info', code, message, pointer);
    if (this.verbose) this.sink?.(d);
  }

  warn(code: string, message: string, pointer?: string): void {
    const d = this.record('warn', code, message, pointer);
    this.sink?.(d);
  }

  error(code: string, message: string, pointer?: string): never {
    const d = this.record('error', code, message, pointer);
    this.sink?.(d);
    throw new ArchonError(code, message, pointer);
  }

  hasWarnings(): boolean {
    return this.entries.some((e) => e.level === 'warn');
  }

  private record(level: Diagnostic['level'], code: string, message: string, pointer?: string): Diagnostic {
    const d: Diagnostic = pointer === undefined ? { level, code, message } : { level, code, message, pointer };
    this.entries.push(d);
    return d;
  }
}
