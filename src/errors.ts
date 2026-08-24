interface PublicErrorDetails {
  field?: string;
  current_value?: string | number;
  limit_value?: string | number;
  retryable?: boolean;
  suggested_action?: string;
}

export class PluginError extends Error {
  readonly code: string;
  readonly details: PublicErrorDetails;

  constructor(code: string, message: string, details: PublicErrorDetails = {}) {
    super(message);
    this.name = "PluginError";
    this.code = code;
    this.details = details;
  }

  toPublicObject(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      ...this.details
    };
  }
}

export function toPluginError(error: unknown): PluginError {
  if (error instanceof PluginError) return error;
  return new PluginError("LOCAL_TOOL_ERROR", "Quick Image 本地工具处理失败。", {
    retryable: false,
    suggested_action: "运行 quick-image-doctor，并在脱敏后提供错误码。"
  });
}
