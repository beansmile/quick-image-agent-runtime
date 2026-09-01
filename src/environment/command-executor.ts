import { spawnSync } from "node:child_process";

export interface CommandOutput {
  stdout: string;
  stderr: string;
}

export interface CommandExecutor {
  run(executable: string, args: string[]): CommandOutput;
}

export const systemCommandExecutor: CommandExecutor = {
  run(executable, args) {
    const result = spawnSync(executable, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (result.error) throw new Error(`无法运行 ${executable}：${result.error.message}`);
    if (result.status !== 0) {
      const details = (result.stderr || result.stdout).trim();
      throw new Error(`${executable} ${args.join(" ")} 执行失败${details ? `：${details}` : ""}`);
    }
    return { stdout: result.stdout, stderr: result.stderr };
  }
};
