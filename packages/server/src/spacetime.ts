type DjSetRow = {
  current_persona?: string
  currentPersona?: string
}

type HubConnection = {
  reducers: {
    initSet: () => void
    updatePattern: (code: string, vibe: string) => void
    setPersona: (personaName: string) => void
    submitRequest: (text: string, priority: string) => void
    setPlayback: (active: boolean) => void
  }
  db: {
    dj_persona: {
      onInsert: (cb: (_ctx: unknown, row: { name: string; prompt_override: string }) => void) => void
      onUpdate: (cb: (_ctx: unknown, _oldRow: unknown, newRow: { name: string; prompt_override: string }) => void) => void
    }
    dj_set: {
      onUpdate: (cb: (_ctx: unknown, _oldRow: unknown, newRow: DjSetRow) => void) => void
    }
  }
  onConnect: (cb: (ctx: { identity: { toHexString: () => string }; subscriptionBuilder: () => { subscribe: (queries: string[]) => void }; reducers: { initSet: () => void } }) => void) => void
  onConnectError: (cb: (_ctx: unknown, err: unknown) => void) => void
  connect: () => void
}

const FALLBACK_PERSONAS = new Map<string, string>([
  ['The Architect', 'Focus on clean, mathematical techno patterns with complex percussion.'],
  ['Liquid Weaver', 'Generate ethereal, ambient soundscapes with long decays and soft transients.']
])

export class DJSpacetimeClient {
  private conn: HubConnection | null = null
  private personas = new Map(FALLBACK_PERSONAS)
  private static instance: DJSpacetimeClient | null = null

  private constructor() {}

  public static getInstance(): DJSpacetimeClient {
    if (!DJSpacetimeClient.instance) {
      DJSpacetimeClient.instance = new DJSpacetimeClient()
    }
    return DJSpacetimeClient.instance
  }

  public async connect(): Promise<void> {
    const moduleUrl = new URL('../../hub/sdk/typescript/index.js', import.meta.url)
    const { DbConnection } = await import(moduleUrl.href) as { DbConnection: { builder: () => { withUri: (uri: string) => any } } }

    const hubUri = process.env.HEIWA_DJ_HUB_URI ?? 'ws://127.0.0.1:3000'
    const hubModule = process.env.HEIWA_DJ_HUB_MODULE ?? 'heiwa-dj-hub'

    await new Promise<void>((resolve, reject) => {
      this.conn = DbConnection.builder()
        .withUri(hubUri)
        .withModuleName(hubModule)
        .build() as HubConnection

      this.conn.onConnect((ctx) => {
        console.log(`[Spacetime] Connected as ${ctx.identity.toHexString()}`)
        ctx.subscriptionBuilder().subscribe([
          'SELECT * FROM dj_set',
          'SELECT * FROM dj_persona',
          'SELECT * FROM music_request'
        ])
        ctx.reducers.initSet()
        resolve()
      })

      this.conn.onConnectError((_ctx, err) => {
        reject(err)
      })

      this.conn.db.dj_persona.onInsert((_ctx, row) => {
        this.personas.set(row.name, row.prompt_override)
      })
      this.conn.db.dj_persona.onUpdate((_ctx, _oldRow, newRow) => {
        this.personas.set(newRow.name, newRow.prompt_override)
      })

      this.conn.connect()
    })
  }

  public getPersonaPrompt(name: string): string | null {
    return this.personas.get(name) || null
  }

  public updatePattern(code: string, vibe: string): void {
    this.conn?.reducers.updatePattern(code, vibe)
  }

  public setPersona(personaName: string): void {
    this.conn?.reducers.setPersona(personaName)
  }

  public submitRequest(text: string, priority: string): void {
    this.conn?.reducers.submitRequest(text, priority)
  }

  public submitLog(_level: string, _source: string, _message: string): void {
    // The generated SDK in this repo does not expose submit_log yet.
  }

  public setPlayback(active: boolean): void {
    this.conn?.reducers.setPlayback(active)
  }

  public onDjSetUpdate(callback: (set: DjSetRow) => void): void {
    this.conn?.db.dj_set.onUpdate((_ctx, _oldRow, newRow) => {
      callback(newRow)
    })
  }
}
