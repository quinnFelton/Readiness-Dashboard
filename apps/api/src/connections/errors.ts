/** Error with an HTTP status; message is safe to return to clients (never contains tokens/payloads). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
