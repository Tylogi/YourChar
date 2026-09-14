export type YourCharErrorCode =
  | "SDK_ABORTED"
  | "SDK_TRANSPORT_ERROR"
  | "SDK_PROTOCOL_ERROR"
  | "API_AUTHENTICATION_ERROR"
  | "API_NOT_FOUND"
  | "API_CONFLICT"
  | "API_VALIDATION_ERROR"
  | "API_ERROR";

export class YourCharSdkError extends Error {
  constructor(
    message: string,
    readonly sdkCode: YourCharErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "YourCharSdkError";
  }
}

export class YourCharAbortError extends YourCharSdkError {
  constructor(options?: ErrorOptions) {
    super("YourChar request was aborted", "SDK_ABORTED", options);
    this.name = "YourCharAbortError";
  }
}

export class YourCharTransportError extends YourCharSdkError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "SDK_TRANSPORT_ERROR", options);
    this.name = "YourCharTransportError";
  }
}

export class YourCharProtocolError extends YourCharSdkError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "SDK_PROTOCOL_ERROR", options);
    this.name = "YourCharProtocolError";
  }
}

export class YourCharApiError extends YourCharSdkError {
  constructor(
    message: string,
    readonly status: number,
    readonly apiCode: string,
    readonly details?: Readonly<Record<string, unknown>>,
    sdkCode: YourCharErrorCode = "API_ERROR",
  ) {
    super(message, sdkCode);
    this.name = "YourCharApiError";
  }
}

export class YourCharAuthenticationError extends YourCharApiError {
  constructor(message: string, status: number, apiCode: string, details?: Readonly<Record<string, unknown>>) {
    super(message, status, apiCode, details, "API_AUTHENTICATION_ERROR");
    this.name = "YourCharAuthenticationError";
  }
}

export class YourCharNotFoundError extends YourCharApiError {
  constructor(message: string, status: number, apiCode: string, details?: Readonly<Record<string, unknown>>) {
    super(message, status, apiCode, details, "API_NOT_FOUND");
    this.name = "YourCharNotFoundError";
  }
}

export class YourCharConflictError extends YourCharApiError {
  constructor(message: string, status: number, apiCode: string, details?: Readonly<Record<string, unknown>>) {
    super(message, status, apiCode, details, "API_CONFLICT");
    this.name = "YourCharConflictError";
  }
}

export class YourCharValidationError extends YourCharApiError {
  constructor(message: string, status: number, apiCode: string, details?: Readonly<Record<string, unknown>>) {
    super(message, status, apiCode, details, "API_VALIDATION_ERROR");
    this.name = "YourCharValidationError";
  }
}
