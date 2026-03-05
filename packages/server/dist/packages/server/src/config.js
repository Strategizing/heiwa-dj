const baseConfig = {
    apiPort: 3001,
    bridgePort: 9999,
    localStrudelPort: 4321,
    defaultMode: 'strudelcc',
    phraseLength: 8,
    queueMax: 20,
    sampleDir: 'samples',
    sampleMapPath: 'samples/strudel.json',
    modelCandidates: ['qwen2.5-coder:7b'],
    excludedToolModels: []
};
export function loadConfig() {
    const envModels = process.env.HEIWA_DJ_MODEL_CANDIDATES
        ? process.env.HEIWA_DJ_MODEL_CANDIDATES.split(',').map((m) => m.trim()).filter(Boolean)
        : baseConfig.modelCandidates;
    return {
        ...baseConfig,
        apiPort: Number(process.env.HEIWA_DJ_API_PORT ?? baseConfig.apiPort),
        bridgePort: Number(process.env.HEIWA_DJ_BRIDGE_PORT ?? baseConfig.bridgePort),
        localStrudelPort: Number(process.env.HEIWA_DJ_LOCAL_PORT ?? baseConfig.localStrudelPort),
        phraseLength: Number(process.env.HEIWA_DJ_PHRASE_LENGTH ?? baseConfig.phraseLength),
        queueMax: Number(process.env.HEIWA_DJ_QUEUE_MAX ?? baseConfig.queueMax),
        sampleDir: process.env.HEIWA_DJ_SAMPLE_DIR ?? baseConfig.sampleDir,
        sampleMapPath: process.env.HEIWA_DJ_SAMPLE_MAP_PATH ?? baseConfig.sampleMapPath,
        modelCandidates: envModels
    };
}
