"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.djConfig = void 0;
exports.loadConfig = loadConfig;
exports.djConfig = {
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
};
function loadConfig() {
    return {
        ...exports.djConfig,
        apiPort: Number(process.env.HEIWA_DJ_API_PORT ?? exports.djConfig.apiPort),
        bridgePort: Number(process.env.HEIWA_DJ_BRIDGE_PORT ?? exports.djConfig.bridgePort),
        localStrudelPort: Number(process.env.HEIWA_DJ_LOCAL_PORT ?? exports.djConfig.localStrudelPort),
        phraseLength: Number(process.env.HEIWA_DJ_PHRASE_LENGTH ?? exports.djConfig.phraseLength),
        queueMax: Number(process.env.HEIWA_DJ_QUEUE_MAX ?? exports.djConfig.queueMax),
        sampleDir: process.env.HEIWA_DJ_SAMPLE_DIR ?? exports.djConfig.sampleDir,
        sampleMapPath: process.env.HEIWA_DJ_SAMPLE_MAP_PATH ?? exports.djConfig.sampleMapPath
    };
}
