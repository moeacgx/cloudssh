import type { IDisposable } from "@xterm/xterm";

export interface TerminalInputSource {
  onData(listener: (data: string) => void): IDisposable;
}

export function replaceTerminalInputListener(
  current: IDisposable | null,
  source: TerminalInputSource,
  listener: (data: string) => void,
): IDisposable {
  current?.dispose();
  return source.onData(listener);
}
