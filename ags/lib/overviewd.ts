import GLib from "gi://GLib"

export interface FrameMetadata {
  width: number
  height: number
  stride: number
  slot: number
  seq: number
  format: string
}

const RUNTIME_DIR = `${GLib.getenv("XDG_RUNTIME_DIR") ?? "/run/user/1000"}/hypr-overviewd`
const TARGETS_PATH = `${RUNTIME_DIR}/targets.json`
const META_DIR = `${RUNTIME_DIR}/meta`
const FRAMES_DIR = `${RUNTIME_DIR}/frames`

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

export function getFramePath(stableId: string, slot: number): string {
  return `${FRAMES_DIR}/${stableId}.${slot}.raw`
}

export function readFrameMetadata(stableId: string): FrameMetadata | null {
  const path = `${META_DIR}/${stableId}.json`
  try {
    const [ok, contents] = GLib.file_get_contents(path)
    if (!ok) return null
    return JSON.parse(decode(contents)) as FrameMetadata
  } catch {
    return null
  }
}

export async function setCaptureTargets(stableIds: string[]): Promise<void> {
  GLib.mkdir_with_parents(RUNTIME_DIR, 0o755)
  GLib.file_set_contents(TARGETS_PATH, `${JSON.stringify(stableIds)}\n`)
}

export async function clearCaptureTargets(): Promise<void> {
  GLib.mkdir_with_parents(RUNTIME_DIR, 0o755)
  GLib.file_set_contents(TARGETS_PATH, "[]\n")
}
