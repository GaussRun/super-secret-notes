// Winston logger. Everything goes to stderr so stdout stays clean for `super-secret-notes get`.
import winston from 'winston'

export const logger = winston.createLogger({
  level: process.env.OVERKILL_LOG ?? 'info',
  format: winston.format.combine(
    ...(process.stderr.isTTY && !process.env.NO_COLOR ? [winston.format.colorize({ level: true })] : []),
    winston.format.printf(({ level, message }) => `${level}: ${message}`)
  ),
  transports: [new winston.transports.Console({ stderrLevels: Object.keys(winston.config.npm.levels) })]
})
