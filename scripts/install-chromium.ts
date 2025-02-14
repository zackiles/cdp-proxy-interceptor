import 'jsr:@std/dotenv/load'
import { BlobReader, ZipReader } from 'jsr:@zip-js/zip-js'
import { dirname, normalize } from 'jsr:@std/path'
import { ensureDir } from 'jsr:@std/fs'
import ProgressBar from 'jsr:@deno-library/progress'
import { writeAll } from 'jsr:@std/io/write-all'
import { CHROMIUM_DATA_STORAGE_URL } from '../src/constants.ts'
import { getChromiumPaths } from '../src/utils.ts'

/**
 * Gets the appropriate Chromium build URL based on platform and architecture
 * @param platform The target platform (e.g., 'Mac', 'Linux')
 * @param version The Chromium version to download
 * @param zipName The name of the zip file
 * @returns The URL to download Chromium from
 */
const getChromiumBuildUrl = async (
  platform: string,
  version: string,
  zipName: string,
): Promise<string> => {
  const isAppleSilicon = Deno.build.arch === 'aarch64' || 
    ((await Deno.permissions.query({ name: 'env', variable: 'PROCESSOR_ARCHITECTURE' }))
      .state === 'granted' && Deno.env.get('PROCESSOR_ARCHITECTURE')?.includes('arm'))

  console.log(`ℹ️ Detected architecture: ${isAppleSilicon ? 'ARM64 (Apple Silicon)' : 'x64 (Intel)'}`);

  if (platform === 'Mac' && isAppleSilicon) {
    const armUrl = `${CHROMIUM_DATA_STORAGE_URL}/Mac_Arm/${version}/chrome-mac.zip`
    console.log(`ℹ️ Using ARM64 build from: ${armUrl}`)
    return armUrl
  }
  
  const defaultUrl = `${CHROMIUM_DATA_STORAGE_URL}/${platform}/${version}/${zipName}`
  console.log(`ℹ️ Using default build from: ${defaultUrl}`)
  return defaultUrl
}

/**
 * Parses command line arguments
 * @returns Object containing parsed arguments
 */
const parseArgs = (): { force: boolean } => ({
  force: Deno.args.includes('--force'),
})

/**
 * Gets the currently installed Chromium version
 * @param directory Directory where Chromium is installed
 * @returns The installed version or null if not installed
 */
const getCurrentVersion = async (directory: string): Promise<string | null> => {
  try {
    return await Deno.readTextFile(`${directory}/.chromium-version`)
  } catch {
    return null
  }
}

/**
 * Gets the latest Chromium version to use
 * @param platform The target platform
 * @returns The version to use
 * @throws Error if CHROMIUM_STATIC_VERSION is not set
 */
const getLatestVersion = async (platform: string): Promise<string> => {
  const staticVersion = Deno.env.get('CHROMIUM_STATIC_VERSION')
  if (!staticVersion) {
    throw new Error('CHROMIUM_STATIC_VERSION must be set')
  }
  console.log(`ℹ️ Using static version from environment: ${staticVersion}`)
  return staticVersion
}

/**
 * Extracts a zip archive
 * @param filePath Path to the zip file
 * @param targetDir Directory to extract to
 */
const extractArchive = async (filePath: string, targetDir: string): Promise<void> => {
  const file = await Deno.readFile(filePath)
  const reader = new BlobReader(new Blob([file]))
  const zipReader = new ZipReader(reader)
  const entries = await zipReader.getEntries()
  
  const progressBar = new ProgressBar({
    title: 'Extracting...',
    total: entries.length,
    display: ':completed/:total :percent [:bar]',
    complete: '=',
    incomplete: '-',
  })

  for (const [index, entry] of entries.entries()) {
    const path = normalize(`${targetDir}/${entry.filename}`)
    
    if (entry.directory) {
      await Deno.mkdir(path, { recursive: true })
      continue
    }

    await Deno.mkdir(dirname(path), { recursive: true })
    
    if (entry.getData) {
      const chunks: Uint8Array[] = []
      const writable = new WritableStream({
        write(chunk) {
          chunks.push(chunk)
          return Promise.resolve()
        },
      })
      await entry.getData(writable)
      
      const combined = new Uint8Array(
        chunks.reduce((acc, chunk) => acc + chunk.length, 0)
      )
      let offset = 0
      for (const chunk of chunks) {
        combined.set(chunk, offset)
        offset += chunk.length
      }
      await Deno.writeFile(path, combined)

      if (entry.filename.endsWith('Chromium') || entry.filename.endsWith('chrome')) {
        await Deno.chmod(path, 0o755)
        
        const { platform } = getChromiumPaths().osConfig
        if (platform === 'Mac') {
          try {
            await new Deno.Command('xattr', {
              args: ['-d', 'com.apple.quarantine', path],
            }).output()
          } catch (error) {
            console.warn(`⚠️ Could not remove quarantine attribute: ${error}`)
          }
        }
      }
    }
    
    await progressBar.render(index + 1)
  }

  progressBar.end()
  await zipReader.close()
}

try {
  const { force } = parseArgs()

  const executablePath = Deno.env.get('CHROMIUM_EXECUTABLE_PATH')
  if (executablePath) {
    console.log('❌ Error: CHROMIUM_EXECUTABLE_PATH is set. This script is only for managing downloaded Chromium instances.')
    console.log('If you want to use your own Chromium/Chrome instance, remove CHROMIUM_EXECUTABLE_PATH from your environment.')
    Deno.exit(1)
  }

  const { directory, osConfig } = getChromiumPaths()

  console.log('🔍 Checking for latest Chromium version...')
  const [latestVersion, currentVersion] = await Promise.all([
    getLatestVersion(osConfig.platform),
    getCurrentVersion(directory),
  ])

  console.log(`ℹ️ Current version: ${currentVersion || 'none'}`)
  console.log(`ℹ️ Latest version: ${latestVersion}`)

  if (currentVersion === latestVersion && !force) {
    console.log('✅ Already up to date')
    Deno.exit(0)
  }

  if (force && currentVersion) {
    console.log('⚠️ Force flag detected, removing existing installation...')
    try {
      await Deno.remove(directory, { recursive: true })
      console.log('✅ Removed existing installation')
    } catch (error) {
      console.warn(`⚠️ Could not remove existing installation: ${error}`)
    }
  }

  const zipUrl = await getChromiumBuildUrl(
    osConfig.platform,
    latestVersion,
    osConfig.zipName,
  )

  console.log(`⬇️ Downloading Chromium from ${zipUrl}...`)
  const tempFile = await Deno.makeTempFile({ suffix: '.zip' })

  const response = await fetch(zipUrl)
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? `Chromium version ${latestVersion} wasn't found at ${zipUrl}`
        : `Failed to download Chromium: HTTP ${response.status}`
    )
  }

  const contentLength = Number(response.headers.get('content-length'))
  const progressBar = new ProgressBar({
    title: 'Downloading...',
    total: contentLength,
    display: ':completed/:total :percent [:bar] :bytesPerSecond',
    complete: '=',
    incomplete: '-',
  })

  const file = await Deno.open(tempFile, { write: true, create: true })
  const reader = response.body?.getReader()

  if (!reader) throw new Error('Failed to read response body')

  let downloaded = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    await writeAll(file, value)
    downloaded += value.length
    await progressBar.render(downloaded)
  }
  progressBar.end()
  file.close()

  console.log('📦 Extracting archive...')
  await ensureDir(directory)
  await extractArchive(tempFile, directory)

  console.log('🔧 Cleaning up...')
  await Deno.remove(tempFile)
  await Deno.writeTextFile(`${directory}/.chromium-version`, latestVersion)

  console.log(`✅ Successfully updated to version ${latestVersion}`)
  console.log(`🔧 Executable path: ${getChromiumPaths().executablePath}`)
} catch (error: unknown) {
  console.error(
    '❌ Error:',
    error instanceof Error ? error.message : String(error),
  )
  Deno.exit(1)
}
