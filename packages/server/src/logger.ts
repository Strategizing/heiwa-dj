import fs from 'node:fs'
import path from 'node:path'
import { DJSpacetimeClient } from './spacetime.js'

export enum LogLevel {
  INFO = 'INFO',
  WARN = 'WARN',
  CRITICAL = 'CRITICAL',
  HEIWA = 'HEIWA'
}

export interface LogEntry {
  level: LogLevel
  source: string
  message: string
  timestamp: number
}

class HeiwaLogger {
  private static instance: HeiwaLogger
  private logs: LogEntry[] = []
  private logFilePath: string = ''

  private constructor() {}

  public static getInstance(): HeiwaLogger {
    if (!HeiwaLogger.instance) {
      HeiwaLogger.instance = new HeiwaLogger()
    }
    return HeiwaLogger.instance
  }

  public init(logsDir: string) {
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true })
    }
    this.logFilePath = path.join(logsDir, `session-${Date.now()}.log`)
    
    // Intercept console
    const originalLog = console.log
    const originalWarn = console.warn
    const originalError = console.error

    console.log = (...args: any[]) => {
      this.log(LogLevel.INFO, 'server', args.join(' '))
      originalLog.apply(console, args)
    }

    console.warn = (...args: any[]) => {
      this.log(LogLevel.WARN, 'server', args.join(' '))
      originalWarn.apply(console, args)
    }

    console.error = (...args: any[]) => {
      this.log(LogLevel.CRITICAL, 'server', args.join(' '))
      originalError.apply(console, args)
    }
  }

  public log(level: LogLevel, source: string, message: string) {
    const entry: LogEntry = {
      level,
      source,
      message,
      timestamp: Date.now()
    }

    // Auto-parse levels if they are in the message string
    if (message.includes('[CRITICAL]')) entry.level = LogLevel.CRITICAL
    else if (message.includes('[WARN]')) entry.level = LogLevel.WARN
    else if (message.includes('Heiwa:')) entry.level = LogLevel.HEIWA

    this.logs.push(entry)
    
    // Stream to SpacetimeDB
    try {
      DJSpacetimeClient.getInstance().submitLog(entry.level, entry.source, entry.message)
    } catch (err) {
      // Ignore DB errors during logging to avoid recursion
    }

    // Write to file immediately for safety
    fs.appendFileSync(this.logFilePath, `${new Date(entry.timestamp).toISOString()} [${entry.level}] [${entry.source}] ${entry.message}\n`)
  }

  public save() {
    if (this.logFilePath) {
      console.log(`[Heiwa] Session logs saved to ${this.logFilePath}`)
    }
  }

  public getLogPath(): string {
    return this.logFilePath
  }
}

export const logger = HeiwaLogger.getInstance()
