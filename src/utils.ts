import { BROWSER_OS_CONFIGS } from './constants.ts'
import type { ChromiumPaths } from './types.ts'

/**
 * Gets the Chromium paths and configuration for the current OS
 * @throws Error if CHROMIUM_DIRECTORY is not set or OS is not supported
 */
export function getChromiumPaths(): ChromiumPaths {
  const directory = Deno.env.get('CHROMIUM_DIRECTORY')
  if (!directory) {
    throw new Error('CHROMIUM_DIRECTORY environment variable is not set')
  }

  const osConfig = BROWSER_OS_CONFIGS[Deno.build.os]
  if (!osConfig) {
    throw new Error(`Unsupported operating system: ${Deno.build.os}`)
  }

  return {
    directory,
    executablePath: `${directory}/${osConfig.executablePath}`,
    osConfig,
  }
}


export async function doesProcessWithPortExist(port: number): Promise<boolean> {
  try {
    const cmd = Deno.build.os === "windows"
      ? new Deno.Command("netstat", { args: ["-ano", "|", "findstr", `:${port}`] })
      : new Deno.Command("lsof", { args: ["-i", `:${port}`] });

    const output = await cmd.output();
    return output.success;
  } catch {
    return false;
  }
}