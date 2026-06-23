import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { log, logLevels, currentLogLevel, filterKeywords, blockKeywords } from '../logging'

describe('log', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    currentLogLevel.value = logLevels.debug
    filterKeywords.length = 0
    blockKeywords.length = 0
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
    warnSpy.mockRestore()
    logSpy.mockRestore()
    currentLogLevel.value = logLevels.debug
    filterKeywords.length = 0
    blockKeywords.length = 0
  })

  describe('level filtering', () => {
    it('logs all three levels when currentLogLevel is debug', () => {
      log(logLevels.error, 'e')
      log(logLevels.warning, 'w')
      log(logLevels.debug, 'd')
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(logSpy).toHaveBeenCalledTimes(1)
    })

    it('suppresses debug when currentLogLevel is warning', () => {
      currentLogLevel.value = logLevels.warning
      log(logLevels.debug, 'debug message')
      expect(logSpy).not.toHaveBeenCalled()
    })

    it('allows warning when currentLogLevel is warning', () => {
      currentLogLevel.value = logLevels.warning
      log(logLevels.warning, 'warning message')
      expect(warnSpy).toHaveBeenCalled()
    })

    it('allows error when currentLogLevel is warning', () => {
      currentLogLevel.value = logLevels.warning
      log(logLevels.error, 'error message')
      expect(errorSpy).toHaveBeenCalled()
    })

    it('suppresses warning when currentLogLevel is error', () => {
      currentLogLevel.value = logLevels.error
      log(logLevels.warning, 'warning message')
      expect(warnSpy).not.toHaveBeenCalled()
    })

    it('logs nothing when currentLogLevel is off', () => {
      currentLogLevel.value = logLevels.off
      log(logLevels.error, 'e')
      log(logLevels.warning, 'w')
      log(logLevels.debug, 'd')
      expect(errorSpy).not.toHaveBeenCalled()
      expect(warnSpy).not.toHaveBeenCalled()
      expect(logSpy).not.toHaveBeenCalled()
    })
  })

  describe('console method selection', () => {
    it('uses console.error for error level', () => {
      log(logLevels.error, 'msg')
      expect(errorSpy).toHaveBeenCalled()
      expect(warnSpy).not.toHaveBeenCalled()
      expect(logSpy).not.toHaveBeenCalled()
    })

    it('uses console.warn for warning level', () => {
      log(logLevels.warning, 'msg')
      expect(warnSpy).toHaveBeenCalled()
      expect(errorSpy).not.toHaveBeenCalled()
      expect(logSpy).not.toHaveBeenCalled()
    })

    it('uses console.log for debug level', () => {
      log(logLevels.debug, 'msg')
      expect(logSpy).toHaveBeenCalled()
      expect(errorSpy).not.toHaveBeenCalled()
      expect(warnSpy).not.toHaveBeenCalled()
    })
  })

  describe('blockKeywords', () => {
    it('suppresses messages whose keywords overlap with blockKeywords', () => {
      blockKeywords.push('secret')
      log(logLevels.debug, 'message', ['secret'])
      expect(logSpy).not.toHaveBeenCalled()
    })

    it('allows messages whose keywords do not match any blockKeyword', () => {
      blockKeywords.push('secret')
      log(logLevels.debug, 'message', ['public'])
      expect(logSpy).toHaveBeenCalled()
    })

    it('allows messages with no keywords even when blockKeywords is set', () => {
      blockKeywords.push('secret')
      log(logLevels.debug, 'message')
      expect(logSpy).toHaveBeenCalled()
    })
  })

  describe('filterKeywords', () => {
    it('allows all messages when filterKeywords is empty', () => {
      log(logLevels.debug, 'message', ['anything'])
      expect(logSpy).toHaveBeenCalled()
    })

    it('allows messages whose keywords include a filterKeyword', () => {
      filterKeywords.push('allowed')
      log(logLevels.debug, 'message', ['allowed'])
      expect(logSpy).toHaveBeenCalled()
    })

    it('suppresses messages not matching any filterKeyword', () => {
      filterKeywords.push('allowed')
      log(logLevels.debug, 'message', ['other'])
      expect(logSpy).not.toHaveBeenCalled()
    })

    it('suppresses messages with no keywords when filterKeywords is non-empty', () => {
      filterKeywords.push('allowed')
      log(logLevels.debug, 'message')
      expect(logSpy).not.toHaveBeenCalled()
    })
  })
})
