import { BROWSER_OS_CONFIGS } from './constants.ts'
import type { ChromiumPaths } from './types.ts'

/**
 * Gets the Chromium paths and configuration for the current OS
 * @throws Error if neither CHROMIUM_EXECUTABLE_PATH is set nor both CHROMIUM_DIRECTORY and CHROMIUM_STATIC_VERSION are set
 */
export function getChromiumPaths(): ChromiumPaths {
  const executablePath = Deno.env.get('CHROMIUM_EXECUTABLE_PATH')
  const directory = Deno.env.get('CHROMIUM_DIRECTORY')
  const staticVersion = Deno.env.get('CHROMIUM_STATIC_VERSION')

  // If executable path is provided, use it directly
  if (executablePath) {
    if (directory || staticVersion) {
      throw new Error('When CHROMIUM_EXECUTABLE_PATH is set, CHROMIUM_DIRECTORY and CHROMIUM_STATIC_VERSION must not be set')
    }
    return {
      directory: '',
      executablePath,
      osConfig: BROWSER_OS_CONFIGS[Deno.build.os] || {
        platform: Deno.build.os,
        executablePath,
        zipName: ''
      }
    }
  }

  // Otherwise, both CHROMIUM_DIRECTORY and CHROMIUM_STATIC_VERSION must be set
  if (!directory || !staticVersion) {
    throw new Error('Either CHROMIUM_EXECUTABLE_PATH must be set to use your own Chrome/Chromium instance, or both CHROMIUM_DIRECTORY and CHROMIUM_STATIC_VERSION must be set to use a managed instance')
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

/**
 * Determines the browser name based on the executable path
 * @param executablePath Path to the browser executable
 * @returns The detected browser name or a generic CDP Browser name
 */
export function getBrowserNameFromPath(executablePath: string): string {
  const lowercasePath = executablePath.toLowerCase()
  if (lowercasePath.includes('chromium')) return 'Chromium'
  if (lowercasePath.includes('chrome')) return 'Chrome'
  return 'CDP Browser' // fallback for other CDP-compatible browsers
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