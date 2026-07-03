import chalk from "chalk";

export interface Logger {
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
}

export function createLogger(verbose: boolean): Logger {
  return {
    debug: verbose ? (msg, ...args) => console.log(chalk.dim(msg), ...args) : () => {},
    info: (msg, ...args) => console.log(msg, ...args),
    warn: (msg, ...args) => console.warn(chalk.yellow(msg), ...args),
    error: (msg, ...args) => console.error(chalk.red(msg), ...args),
  };
}
