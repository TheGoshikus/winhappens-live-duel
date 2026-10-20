export class AppError extends Error {
  override name = 'AppError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string = code,
  ) {
    super(message);
  }
}

export const unauthorized = (msg = 'authentication required') =>
  new AppError(401, 'unauthorized', msg);
export const forbidden = (code: string, msg = code) => new AppError(403, code, msg);
