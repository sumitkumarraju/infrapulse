import type { ContentfulStatusCode } from 'hono/utils/http-status'

/**
 * One error shape for the whole API, so the client never has to guess:
 * `{ error: { code, message } }`.
 *
 * `message` is written for a person to read — it ends up in a toast — and
 * never contains a stack trace, a SQL fragment or a file path.
 */
export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }

  static badRequest(message: string) {
    return new ApiError(400, 'bad_request', message)
  }

  static notFound(message: string) {
    return new ApiError(404, 'not_found', message)
  }

  static conflict(message: string) {
    return new ApiError(409, 'conflict', message)
  }

  static tooLarge(message: string) {
    return new ApiError(413, 'payload_too_large', message)
  }

  toResponse() {
    return { error: { code: this.code, message: this.message } }
  }
}
