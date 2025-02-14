import { BlobReader, ZipReader } from 'jsr:@zip-js/zip-js'
import { dirname, normalize } from 'jsr:@std/path'
import { ensureDir } from 'jsr:@std/fs'
import ProgressBar from 'jsr:@deno-library/progress'
import { writeAll } from 'jsr:@std/io/write-all'
import 'jsr:@std/dotenv/load'
import { CHROMIUM_DATA_STORAGE_URL } from '../src/constants.ts'
import { getChromiumPaths } from '../src/utils.ts'

const getChromiumBuildUrl = async (
  platform: string,
  version: string,
  zipName: string,
): Promise<string> => {

  const isAppleSilicon = Deno.build.arch === 'aarch64' || 
    ((await Deno.permissions.query({ name: 'env', variable: 'PROCESSOR_ARCHITECTURE' }))
      .state === 'granted' && Deno.env.get('PROCESSOR_ARCHITECTURE')?.includes('arm'));

  console.log(`ℹ️ Detected architecture: ${isAppleSilicon ? 'ARM64 (Apple Silicon)' : 'x64 (Intel)'}`);

  // Use ARM64 build for Apple Silicon Macs
  if (platform === 'Mac' && isAppleSilicon) {
    const armUrl = `${CHROMIUM_DATA_STORAGE_URL}/Mac_Arm/${version}/chrome-mac.zip`;
    console.log(`ℹ️ Using ARM64 build from: ${armUrl}`);
    return armUrl;
  }
  
  const defaultUrl = `${CHROMIUM_DATA_STORAGE_URL}/${platform}/${version}/${zipName}`;
  console.log(`ℹ️ Using default build from: ${defaultUrl}`);
  return defaultUrl;
}

function parseArgs(): { force: boolean } {
  return {
    force: Deno.args.includes('--force'),
  }
}

async function verifyDownloadedFile(filePath: string, expectedHash: string) {
  try {
    // Calculate SHA-256 hash of the downloaded file
    const file = await Deno.open(filePath);
    const hash = new TextDecoder().decode(
      await new Deno.Command('shasum', {
        args: ['-a', '256', filePath],
      }).output().stdout
    ).split(' ')[0];
    file.close();

    if (hash !== expectedHash) {
      throw new Error(`Hash mismatch! Expected: ${expectedHash}, Got: ${hash}`);
    }
    console.log('✅ File hash verified successfully');
  } catch (error) {
    console.error('❌ File verification failed:', error);
    Deno.exit(1);
  }
}

try {
  const { force } = parseArgs()
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
    if (response.status === 404) {
      throw new Error(`Chromium version ${latestVersion} wasn't found at ${zipUrl}`)
    }
    throw new Error(`Failed to download Chromium: HTTP ${response.status}`)
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

  if (reader) {
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
  } else {
    throw new Error('Failed to read response body')
  }

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

async function getCurrentVersion(directory: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(`${directory}/.chromium-version`)
  } catch {
    return null
  }
}

async function getLatestVersion(platform: string): Promise<string> {
  // Check for environment variable first
  const staticVersion = Deno.env.get('CHROMIUM_STATIC_VERSION');
  if (staticVersion) {
    console.log(`ℹ️ Using static version from environment: ${staticVersion}`);
    return staticVersion;
  }

  // Check for Apple Silicon architecture
  const isAppleSilicon = Deno.build.arch === 'aarch64' || 
    ((await Deno.permissions.query({ name: 'env', variable: 'PROCESSOR_ARCHITECTURE' }))
      .state === 'granted' && Deno.env.get('PROCESSOR_ARCHITECTURE')?.includes('arm'));

  // Use ARM64 version path for Apple Silicon Macs
  const versionPath = platform === 'Mac' && isAppleSilicon 
    ? `${platform}_Arm/LAST_CHANGE` 
    : `${platform}/LAST_CHANGE`;

  const versionUrl = `${CHROMIUM_DATA_STORAGE_URL}/${versionPath}`;
  const response = await fetch(versionUrl);
  if (!response.ok) throw new Error('Failed to fetch version');
  return (await response.text()).trim();
}

async function extractArchive(filePath: string, targetDir: string) {
  const file = await Deno.readFile(filePath)
  const reader = new BlobReader(new Blob([file]))
  const zipReader = new ZipReader(reader)

  const entries = await zipReader.getEntries()
  
  // Create a progress bar for extraction
  const progressBar = new ProgressBar({
    title: 'Extracting...',
    total: entries.length,
    display: ':completed/:total :percent [:bar]',
    complete: '=',
    incomplete: '-',
  })

  for (const [index, entry] of entries.entries()) {
    const path = normalize(`${targetDir}/${entry.filename}`)
    
    // Create directory if it doesn't exist
    if (entry.directory) {
      await Deno.mkdir(path, { recursive: true })
    } else {
      await Deno.mkdir(dirname(path), { recursive: true })
      
      if (entry.getData) {
        const chunks: Uint8Array[] = []
        const writable = new WritableStream({
          write(chunk) {
            chunks.push(chunk)
          },
        })
        await entry.getData(writable)
        const combined = new Uint8Array(
          chunks.reduce((acc, chunk) => acc + chunk.length, 0),
        )
        let offset = 0
        for (const chunk of chunks) {
          combined.set(chunk, offset)
          offset += chunk.length
        }
        await Deno.writeFile(path, combined)

        // Set executable permissions for the main Chromium binary
        if (entry.filename.endsWith('Chromium') || entry.filename.endsWith('chrome')) {
          await Deno.chmod(path, 0o755) // rwxr-xr-x
          
          // Only remove quarantine attribute on macOS
          const { platform } = getChromiumPaths().osConfig
          if (platform === 'Mac') {
            try {
              const command = new Deno.Command('xattr', {
                args: ['-d', 'com.apple.quarantine', path],
              })
              await command.output()
            } catch (error) {
              console.warn(`⚠️ Could not remove quarantine attribute: ${error}`)
            }
          }
        }
      }
    }
    
    // Update progress bar
    await progressBar.render(index + 1)
  }

  progressBar.end()
  await zipReader.close()
}
