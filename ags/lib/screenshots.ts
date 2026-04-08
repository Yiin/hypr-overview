import { execAsync } from "ags/process"
import GLib from "gi://GLib"

const SCREENSHOT_DIR = "/tmp/hypr-overview"
const SCREENSHOT_EXT = "ppm"

function ensureDir() {
  if (!GLib.file_test(SCREENSHOT_DIR, GLib.FileTest.IS_DIR)) {
    GLib.mkdir_with_parents(SCREENSHOT_DIR, 0o755)
  }
}

export function getScreenshotPath(address: string): string {
  return `${SCREENSHOT_DIR}/${address}.${SCREENSHOT_EXT}`
}

export function screenshotExists(address: string): boolean {
  return GLib.file_test(getScreenshotPath(address), GLib.FileTest.EXISTS)
}

// Capture a single window using grim toplevel export (captures the actual window, not a screen crop)
export async function captureWindow(stableId: number, address: string): Promise<void> {
  ensureDir()
  const path = getScreenshotPath(address)
  try {
    await execAsync(["grim", "-T", String(stableId), "-s", "1", "-t", SCREENSHOT_EXT, path])
  } catch (e) {
    console.error(`Screenshot failed for ${address} (stableId ${stableId}): ${e}`)
  }
}

// Capture all windows in a list
export async function captureWorkspaceWindows(
  clients: Array<{ address: string; stableId: number }>,
): Promise<void> {
  ensureDir()
  await Promise.all(
    clients.map((c) => captureWindow(c.stableId, c.address)),
  )
}

export function cleanupScreenshots() {
  try {
    const dir = GLib.Dir.open(SCREENSHOT_DIR, 0)
    let name: string | null
    while ((name = dir.read_name()) !== null) {
      GLib.unlink(`${SCREENSHOT_DIR}/${name}`)
    }
    dir.close()
  } catch {
    // dir might not exist
  }
}
