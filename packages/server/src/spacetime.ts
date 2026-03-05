export class DJSpacetimeClient {
  private personas: Map<string, string> = new Map([
    ['The Architect', 'Focus on clean, mathematical techno patterns with complex percussion.'],
    ['Liquid Weaver', 'Generate ethereal, ambient soundscapes with long decays and soft transients.']
  ]);
  private static instance: DJSpacetimeClient | null = null;

  private constructor() { }

  public static getInstance(): DJSpacetimeClient {
    if (!DJSpacetimeClient.instance) {
      DJSpacetimeClient.instance = new DJSpacetimeClient();
    }
    return DJSpacetimeClient.instance;
  }

  public async connect(): Promise<void> {
    console.log('[Heiwa] Local persona engine initialized.');
    return Promise.resolve();
  }

  public getPersonaPrompt(name: string): string | null {
    return this.personas.get(name) || null;
  }

  public updatePattern(code: string, vibe: string): void {
    console.log('[Heiwa] Pattern Update (Local):', vibe);
  }

  public setPersona(personaName: string): void {
    console.log('[Heiwa] Persona Switched (Local):', personaName);
  }

  public submitRequest(text: string, priority: string): void {
    console.log('[Heiwa] Request Submitted (Local):', text);
  }

  public submitLog(level: string, source: string, message: string): void {
    // This will be wired to reducers.submit_log once SDK is fixed
    // For now, it's a stable local stub to prevent boot crashes
  }

  public setPlayback(active: boolean): void {
    console.log('[Heiwa] Playback State (Local):', active);
  }

  public onDjSetUpdate(callback: (set: any) => void): void {
    // No-op stub
  }
}
