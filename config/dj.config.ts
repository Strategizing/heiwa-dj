export type Mode = 'strudelcc' | 'local'

export interface DJConfig {
  apiPort: number
  bridgePort: number
  localStrudelPort: number
  defaultMode: Mode
  phraseLength: number
  queueMax: number
  sampleDir: string
  sampleMapPath: string
  modelCandidates: string[]
  excludedToolModels: string[]
}

export const djConfig: DJConfig = {
  apiPort: 3001,
  bridgePort: 9999,
  localStrudelPort: 4321,
  defaultMode: 'strudelcc',
  phraseLength: 8,
  queueMax: 20,
  sampleDir: 'samples',
  sampleMapPath: 'samples/strudel.json',
  modelCandidates: [
    'qwen2.5-coder:14b-instruct-q4_K_M',
    'qwen2.5-coder:7b-instruct-q4_K_M',
    'qwen2.5-coder:7b'
  ],
  excludedToolModels: ['deepseek-coder-v2:16b']
}

export function loadConfig(): DJConfig {
  return {
    ...djConfig,
    apiPort: Number(process.env.HEIWA_DJ_API_PORT ?? djConfig.apiPort),
    bridgePort: Number(process.env.HEIWA_DJ_BRIDGE_PORT ?? djConfig.bridgePort),
    localStrudelPort: Number(process.env.HEIWA_DJ_LOCAL_PORT ?? djConfig.localStrudelPort),
    phraseLength: Number(process.env.HEIWA_DJ_PHRASE_LENGTH ?? djConfig.phraseLength),
    queueMax: Number(process.env.HEIWA_DJ_QUEUE_MAX ?? djConfig.queueMax),
    sampleDir: process.env.HEIWA_DJ_SAMPLE_DIR ?? djConfig.sampleDir,
    sampleMapPath: process.env.HEIWA_DJ_SAMPLE_MAP_PATH ?? djConfig.sampleMapPath
  }
}
