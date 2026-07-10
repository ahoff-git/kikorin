export const logLevels = {
    off: 0,
    error: 1,
    warning: 2,
    debug: 3,
};

// Mutable object so any module can update the level at runtime.
// Off by default so production builds are quiet; set to logLevels.debug to enable.
export const currentLogLevel = { value: logLevels.off };

// filterKeywords: when non-empty, only messages tagged with one of these pass through.
// blockKeywords: messages tagged with any of these are always suppressed.
export const filterKeywords: string[] = [];
export const blockKeywords: string[] = [];

export function log(
    level: number = logLevels.debug,
    message: string,
    keywords: string[] = [],
    ...data: unknown[]
  ): void {
      if (!Object.values(logLevels).includes(level)) {
          console.error(`[LOG ERROR] Invalid log level: ${level}`);
          return;
      }

      if (currentLogLevel.value < level) return;

      if (blockKeywords.some(keyword => keywords.includes(keyword))) return;

      if (filterKeywords.length > 0 && !filterKeywords.some(keyword => keywords.includes(keyword))) return;

      // Deep copy prevents logged objects from mutating after the call.
      const copiedData = data.map(item => {
          try {
              return JSON.parse(JSON.stringify(item));
          } catch {
              return item;
          }
      });

      const method = level === logLevels.error ? "error"
                   : level === logLevels.warning ? "warn"
                   : "log";

      const timestamp = new Date().toISOString();
      const keywordInfo = keywords.length > 0 ? ` [Keywords: ${keywords.join(", ")}]` : "";

      console[method](`[${timestamp}] ${message}\n${keywordInfo}\n`, ...copiedData);
  }
