/**
 * The local model the app offers, pinned: exact source URLs (the Hugging Face
 * URLs name a commit, so they cannot change), sizes and SHA-256 checksums.
 * Chosen in the Slice 7 spike (see "Local model" in docs/ARCHITECTURE.md).
 */

export type ModelFileKind = 'runtime' | 'model' | 'projector'

export interface ModelFile {
  kind: ModelFileKind
  /** File name on disk, in the models folder. */
  name: string
  url: string
  size: number
  sha256: string
}

export interface ModelSpec {
  id: string
  name: string
  /** The model weights' license. */
  license: string
  /** The runtime's license (llama.cpp, plus the LLVM OpenMP library it ships). */
  runtimeLicense: string
  files: ModelFile[]
}

export const DEFAULT_MODEL: ModelSpec = {
  id: 'qwen3-vl-4b-instruct-q4km',
  name: 'Qwen3-VL 4B Instruct (Q4_K_M)',
  license: 'Apache-2.0',
  runtimeLicense: 'MIT (llama.cpp b11577); LLVM OpenMP: Apache-2.0 with LLVM Exceptions',
  files: [
    {
      kind: 'runtime',
      name: 'llama-b11577-bin-win-vulkan-x64.zip',
      url: 'https://github.com/ggml-org/llama.cpp/releases/download/b11577/llama-b11577-bin-win-vulkan-x64.zip',
      size: 32_112_073,
      sha256: '1d9a92d7bd92d41ace1ac21fb3ac2241a8175b932b9229b0d54e8bf625df8a81',
    },
    {
      kind: 'model',
      name: 'Qwen3VL-4B-Instruct-Q4_K_M.gguf',
      url: 'https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/1cd86afb9a95c410a6038ab3b40d8b578c892266/Qwen3VL-4B-Instruct-Q4_K_M.gguf',
      size: 2_497_281_664,
      sha256: '66358cb18bb6b3b1b6675aa412c7a88ef01d228f481184d13668e5201c730a0a',
    },
    {
      kind: 'projector',
      name: 'mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf',
      url: 'https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/1cd86afb9a95c410a6038ab3b40d8b578c892266/mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf',
      size: 453_974_304,
      sha256: '30ba2c7dd3127a4561b6cba9d13d0f711c91bdb38742e2f56d73c8cb596bd06d',
    },
  ],
}

export function totalBytes(spec: ModelSpec): number {
  return spec.files.reduce((sum, file) => sum + file.size, 0)
}

/** Checks a catalog read from elsewhere (tests point the app at a local one). */
export function parseModelSpec(raw: unknown): ModelSpec {
  const spec = raw as Partial<ModelSpec>
  const kinds: ModelFileKind[] = ['runtime', 'model', 'projector']
  if (
    typeof spec?.id !== 'string' ||
    typeof spec.name !== 'string' ||
    typeof spec.license !== 'string' ||
    typeof spec.runtimeLicense !== 'string' ||
    !Array.isArray(spec.files) ||
    !kinds.every((kind) => spec.files?.some((file) => file.kind === kind))
  ) {
    throw new Error('Not a model catalog')
  }
  for (const file of spec.files) {
    if (
      !kinds.includes(file.kind) ||
      typeof file.name !== 'string' ||
      !/^[\w.-]+$/.test(file.name) ||
      typeof file.url !== 'string' ||
      !/^https?:\/\//.test(file.url) ||
      !Number.isSafeInteger(file.size) ||
      !/^[0-9a-f]{64}$/.test(file.sha256)
    ) {
      throw new Error(`Bad catalog entry: ${String(file.name)}`)
    }
  }
  return spec as ModelSpec
}
