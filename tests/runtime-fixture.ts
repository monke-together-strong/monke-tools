import { MonkeError } from "../src/errors.ts";
import { createRuntime } from "../src/runtime.ts";
import type { RuntimeOptions } from "../src/runtime.ts";
import type { MultiSelectPrompt, Runtime, SelectPrompt } from "../src/types.ts";

export interface TestRuntimeOptions extends RuntimeOptions {
  cancelSelect?: boolean;
  multiSelectValues?: string[][];
  onMultiSelect?: (prompt: MultiSelectPrompt) => void;
  onSelect?: (prompt: SelectPrompt) => void;
  onStderr?: (text: string) => void;
  onStdout?: (text: string) => void;
  selectValues?: string[];
  stdinText?: string;
}

/** Add scripted interaction to the real process adapter for command behavior tests. */
export function createTestRuntime(options: TestRuntimeOptions = {}): Runtime {
  const runtime = createRuntime({
    ...options,
    writeStderr: options.onStderr ?? options.writeStderr,
    writeStdout: options.onStdout ?? options.writeStdout
  });
  const input = options.stdinText?.split(/\r?\n/u);
  const selectValues = options.selectValues === undefined ? undefined : [...options.selectValues];
  const multiSelectValues =
    options.multiSelectValues === undefined ? undefined : [...options.multiSelectValues];

  return {
    ...runtime,
    async multiSelect(prompt) {
      options.onMultiSelect?.(prompt);
      if (multiSelectValues === undefined) {
        return await runtime.multiSelect(prompt);
      }
      const selected = multiSelectValues.shift();
      if (selected === undefined) {
        throw new MonkeError("No scripted multi-select values remain");
      }
      for (const value of selected) {
        if (!prompt.options.some((option) => option.value === value)) {
          throw new MonkeError(`Unknown selection: ${value}`);
        }
      }
      if (prompt.required === true && selected.length === 0) {
        throw new MonkeError(`Select at least one option for ${prompt.message}`);
      }
      return selected;
    },
    readLine(prompt) {
      if (input === undefined) {
        return runtime.readLine(prompt);
      }
      runtime.writeStdout(prompt);
      return input.shift() ?? "";
    },
    async select(prompt) {
      options.onSelect?.(prompt);
      if (options.cancelSelect === true) {
        throw new MonkeError(`${prompt.message} cancelled`);
      }
      if (selectValues === undefined) {
        return await runtime.select(prompt);
      }
      const selected = selectValues.shift();
      if (selected === undefined) {
        throw new MonkeError("No scripted select values remain");
      }
      if (!prompt.options.some((option) => option.value === selected)) {
        throw new MonkeError(`Unknown selection: ${selected}`);
      }
      return selected;
    }
  };
}
